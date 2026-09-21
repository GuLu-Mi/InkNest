import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, test } from 'vitest'
import { DocumentRegistry } from '../../src/main/documents/registry'
import { HistoryStore } from '../../src/main/documents/history-store'

test.each(['protected', 'written', 'published'])('SIGKILL after %s keeps complete disk and committed history', async phase => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inknest-history-crash-')))
  const path = join(root, 'doc.md'); await writeFile(path, 'A')
  const script = join(root, 'child.cjs')
  await build({ stdin: { contents: `
    import { randomUUID } from 'node:crypto';
    import { DocumentRegistry } from './src/main/documents/registry';
    import { SaveCoordinator } from './src/main/documents/save-coordinator';
    import { HistoryStore } from './src/main/documents/history-store';
    import { atomicWrite } from './src/main/documents/atomic-writer';
    let armed = false;
    const stop = async () => { process.send('boundary'); await new Promise(() => {}); };
    async function main() {
      const registry = new DocumentRegistry(); await registry.open(process.env.TARGET, 1); const session = registry.current;
      const history = new HistoryStore(process.env.HISTORY, {
        beforeManifest: async () => { if (armed && process.env.PHASE === 'written') await stop(); },
        changed: () => { if (armed && process.env.PHASE === 'published') { process.send('boundary'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); } }
      });
      const saves = new SaveCoordinator(registry, async (...args) => { if (armed && process.env.PHASE === 'protected') await stop(); return atomicWrite(...args); }, { history });
      const save = (revision, text) => saves.save({ requestId: randomUUID(), snapshot: { docId: session.document.docId, epoch: session.document.epoch, revision, text }, expectedDiskToken: session.document.diskToken, trigger: 'auto' }, 1);
      if ((await save(1, 'B')).status !== 'ok') throw Error('initial save failed'); armed = true;
      await save(2, 'C'); throw Error('boundary not reached');
    }
    setInterval(() => {}, 1000); main().catch(e => { console.error(e); process.exit(1); });
  `, resolveDir: process.cwd(), loader: 'ts' }, outfile: script, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const child = fork(script, { env: { ...process.env, TARGET: path, HISTORY: join(root, 'history'), PHASE: phase }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk })
  try {
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error(stderr || 'child exited early') })])
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    expect(await readFile(path, 'utf8')).toBe(phase === 'protected' ? 'B' : 'C')
    const [id] = await readdir(join(root, 'history'))
    const manifest = JSON.parse(await readFile(join(root, 'history', id!, 'manifest.json'), 'utf8'))
    if (phase === 'published') expect(manifest.retired).toHaveLength(1)
    const registry = new DocumentRegistry(); await registry.open(path, 1)
    const history = new HistoryStore(join(root, 'history')); const session = registry.current!
    const list = await history.list(session)
    expect(await Promise.all(list.entries.map(async e => (await history.read(session, e.id)).toString()))).toEqual([phase === 'published' ? 'C' : 'B', 'A'])
  } finally { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }) }
}, 15_000)
