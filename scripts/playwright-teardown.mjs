import { dirname, resolve } from 'node:path'
import { unregisterMacBuild } from './macos-app-registration.mjs'

export default async function teardown() {
  const executable = process.env.INKNEST_PACKAGED_EXECUTABLE
  if (!executable || process.platform !== 'darwin') return
  // Packaged executable: InkNest.app/Contents/MacOS/InkNest.
  // The helper validates ownership before touching Launch Services.
  const result = await unregisterMacBuild(resolve(dirname(executable), '../..'))
  if (result.status === 'unregistered') console.log('Unregistered the packaged E2E build from Open With')
}
