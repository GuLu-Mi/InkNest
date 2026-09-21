import { extname } from 'node:path'
import sharp from 'sharp'
import { ResourceFailure } from './path-grants'

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_PIXELS = 40_000_000
const extensions: Record<string, string> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.gif': 'gif' }
export interface ImageMetadata {
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  width: number
  height: number
  orientation: number
  frames: number
}
// Container completeness checks do not decode pixels or replace the library's metadata
// parser. APNG is rejected because this provider cannot establish its frame budget.
function checkContainer(bytes: Buffer, format: string): void {
  if (format === 'png') {
    let offset = 8
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset)
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      if (offset + 12 + length > bytes.length || type === 'acTL') throw new ResourceFailure('format')
      if (type === 'IEND' && length === 0) return
      offset += 12 + length
    }
    throw new ResourceFailure('format')
  }
  if (format === 'jpeg' && bytes.lastIndexOf(Buffer.from([0xff, 0xd9])) < 2) throw new ResourceFailure('format')
  if (format === 'webp' && (bytes.length < 12 || bytes.readUInt32LE(4) + 8 > bytes.length)) throw new ResourceFailure('format')
}
export async function validateImageMetadata(bytes: Buffer, path: string): Promise<ImageMetadata> {
  if (bytes.length > MAX_IMAGE_BYTES) throw new ResourceFailure('size')
  const expected = extensions[extname(path).toLowerCase()]
  if (!expected) throw new ResourceFailure('format')
  const signature = bytes.subarray(0, 12)
  const recognized = signature.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    || signature.subarray(0, 3).toString('hex') === 'ffd8ff'
    || /^GIF8[79]a/u.test(signature.toString('ascii', 0, 6))
    || (signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP')
  if (!recognized) throw new ResourceFailure('format')
  try {
    // Metadata reads compressed headers only. Animated mode exposes all frame dimensions;
    // libvips checks its pixel limit before any pixel decode is requested (none is here).
    const info = await sharp(bytes, { animated: true, limitInputPixels: MAX_PIXELS, failOn: 'warning' }).metadata()
    if (info.format !== expected) throw new ResourceFailure('format')
    checkContainer(bytes, expected)
    const frames = info.pages ?? 1
    // libnsgif can report frame extents smaller than GIF's logical canvas.
    // Chromium still allocates the canvas; count both dimensions conservatively.
    const width = expected === 'gif' && bytes.length >= 10 ? Math.max(info.width, bytes.readUInt16LE(6)) : info.width
    const pageHeight = frames > 1 ? info.pageHeight : info.height
    const height = expected === 'gif' && bytes.length >= 10 && pageHeight ? Math.max(pageHeight, bytes.readUInt16LE(8)) : pageHeight
    if (!Number.isSafeInteger(width) || !height || !Number.isSafeInteger(height) || !Number.isSafeInteger(frames) || width <= 0 || height <= 0 || frames <= 0) throw new ResourceFailure('format')
    if (width * height * frames > MAX_PIXELS) throw new ResourceFailure('size')
    // GIF must have a complete frame count. WebP exposes pages when animated.
    if (expected === 'gif' && info.pages === undefined) throw new ResourceFailure('format')
    const orientation = info.orientation ?? 1
    if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) throw new ResourceFailure('format')
    const rotated = orientation >= 5
    return { mime: `image/${expected}` as ImageMetadata['mime'], width: rotated ? height : width, height: rotated ? width : height, orientation, frames }
  } catch (error) {
    if (error instanceof ResourceFailure) throw error
    if (error instanceof Error && /pixel limit/iu.test(error.message)) throw new ResourceFailure('size')
    throw new ResourceFailure('format')
  }
}
