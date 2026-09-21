import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const BUNDLE_NAME = 'InkNest-0.0.15-smoke-fixtures'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAABACAYAAADS1n9/AAAAxElEQVR42u3SMQEAIAgAMJpwGMsmBiKfDbCEHzvWYJFn92S31mghgAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCDADw97W7RXmKBVvgAAAABJRU5ErkJggg==',
  'base64'
)

function exactTextFile(prefix, byteLength) {
  const prefixBytes = Buffer.from(prefix, 'utf8')
  if (prefixBytes.length > byteLength) throw new RangeError('Fixture prefix exceeds requested size')
  const pattern = Buffer.from('- fixed seed 0123456789 abcdefghijklmnopqrstuvwxyz\n', 'ascii')
  const result = Buffer.alloc(byteLength)
  prefixBytes.copy(result)
  for (let offset = prefixBytes.length; offset < result.length;) {
    const copied = pattern.copy(result, offset, 0, Math.min(pattern.length, result.length - offset))
    offset += copied
  }
  return result
}

async function listFiles(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  await visit(root)
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right), 'en'))
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

const CRC_TABLE = Array.from({ length: 256 }, (_value, index) => {
  let crc = index
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

async function createDeterministicZip(archive, output, inputs) {
  const localParts = []
  const centralParts = []
  let localOffset = 0
  const dosDate = ((2026 - 1980) << 9) | (9 << 5) | 16

  for (const path of inputs) {
    const name = Buffer.from(relative(output, path).split('\\').join('/'), 'utf8')
    const contents = await readFile(path)
    const compressed = deflateRawSync(contents, { level: 9 })
    const checksum = crc32(contents)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(contents.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(contents.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0x81a40000, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.length + name.length + compressed.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(inputs.length, 8)
  end.writeUInt16LE(inputs.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(localOffset, 16)
  await writeFile(archive, Buffer.concat([...localParts, ...centralParts, end]))
}

export async function createSmokeBundle(outputDirectory) {
  const output = resolve(outputDirectory)
  const root = join(output, BUNDLE_NAME)
  const archive = join(output, `${BUNDLE_NAME}.zip`)
  for (const path of [root, archive]) {
    try { await stat(path) } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    throw new Error(`Fixture output already exists: ${path}`)
  }
  await Promise.all([
    mkdir(join(root, 'docs'), { recursive: true }),
    mkdir(join(root, 'encoding'), { recursive: true }),
    mkdir(join(root, 'performance'), { recursive: true }),
    mkdir(join(root, 'limits'), { recursive: true }),
    mkdir(join(root, 'tabs', '甲'), { recursive: true }),
    mkdir(join(root, 'tabs', '乙'), { recursive: true })
  ])

  const guide = `# InkNest 0.0.15 本机验收样本

仅使用本目录副本测试，不要放入真实写作资料。
1. 用“打开文档”选择 docs/中文 说明.md；本目录PNG可见，父目录与远程图片受限。
2. 打开 tabs/甲/同名.md 与 tabs/乙/同名.md，切换并再次打开同文件，核对独立标签与完整路径提示。
3. 编辑并用系统输入法输入“中文候选词”：候选未提交不应保存，提交并空闲约1秒后自动保存；关闭后重开核对。
4. Ctrl+W（Mac Cmd+W）关闭当前标签，Alt+F4（Mac Cmd+Q）退出并保存全部；故障时正文与标签保留。
5. docs/reader-layout.md 检查宽表、长代码、200%缩放。encoding 与 limits 检查只读和格式边界。
6. docs/搜索与替换.md：按Cmd+F/Ctrl+F开关搜索；恢复关键词时正文不跳动。阅读无替换，编辑显示替换；替换当前、全部、空文本删除后用Cmd+Z/Ctrl+Z一次撤销整次操作。
7. 仅复制样本进行外部修改/删除/占用故障、恢复与历史测试；检查失败后内容保留、历史预览只读，以及还原后可撤销。
`
  const markdown = `# 中文本机冒烟

这是可以安全修改的临时样本。

> 原始 Markdown 文本是正式内容。

- 列表项 A
- 列表项 B

| 项目 | 结果 |
| --- | --- |
| 中文文件名 | 可读 |

\`\`\`ts
const message = '中文候选词'
\`\`\`

![同目录 PNG](<图像%20%23100%25.png>)

![越界 PNG](<../外部-不应加载.png>)

![远程图片](https://example.invalid/blocked.png)

<script>window.fixtureMustNotRun = true</script>
`
  const files = new Map([
    ['README.txt', Buffer.from(guide, 'utf8')],
    ['docs/reader-layout.md', await readFile(new URL('../tests/fixtures/reader-layout.md', import.meta.url))],
    ['tabs/甲/同名.md', Buffer.from('# 甲目录的独立文档\n\nA2 Apple\n')],
    ['tabs/乙/同名.md', Buffer.from('# 乙目录的独立文档\n\nB2 Banana\n')],
    ['tabs/很长的中文 文档名称用于标签截断与路径提示检查.md', Buffer.from('# 长名称标签\n')],
    ['docs/搜索与替换.md', Buffer.from('# 搜索与替换\n\nAlpha alpha ALPHA 中文 中文 😀é 😀e\u0301\n\n' + '这是滚动位置测试。\n\n'.repeat(100) + '末尾 Alpha\n')],
    ['docs/中文 说明.md', Buffer.from(markdown, 'utf8')],
    ['docs/图像 #100%.png', PNG],
    ['外部-不应加载.png', PNG],
    ['encoding/utf8-bom-crlf-no-final.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# BOM\r\n\r\n无末尾换行', 'utf8')])],
    ['encoding/mixed-eol.md', Buffer.from('# mixed\r\nfirst\nsecond\r\n', 'utf8')],
    ['encoding/invalid-utf8.md', Buffer.from([0x23, 0x20, 0x62, 0x61, 0x64, 0x0a, 0xff])],
    ['performance/standard-100KiB.md', exactTextFile('# InkNest fixed 100KiB performance sample\n\n', 100 * 1024)],
    ['limits/readonly-2MiB-plus-1.md', exactTextFile('# InkNest readonly boundary sample\n\n', 2 * 1024 * 1024 + 1)]
  ])

  for (const [relativePath, bytes] of files) await writeFile(join(root, relativePath), bytes)

  const payloadFiles = await listFiles(root)
  const manifestEntries = await Promise.all(payloadFiles.map(async (path) => ({
    path: relative(root, path).split('\\').join('/'),
    bytes: (await stat(path)).size,
    sha256: await sha256(path)
  })))
  const manifest = join(root, 'fixture-manifest.json')
  await writeFile(manifest, `${JSON.stringify({ schemaVersion: 1, files: manifestEntries }, null, 2)}\n`, 'utf8')

  const archiveInputs = await listFiles(root)
  await createDeterministicZip(archive, output, archiveInputs)

  return { root, archive, manifest, archiveSha256: await sha256(archive) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await createSmokeBundle(process.argv[2] ?? join(process.cwd(), 'release'))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
