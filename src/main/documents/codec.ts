import type { TextFormat } from '../../shared/contracts'

export type DecodedText =
  | { kind: 'editable'; text: string; format: TextFormat }
  | { kind: 'readonly'; text: string; reason: 'encoding' | 'mixed-eol' }

const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf)
const UTF16_LE_BOM = Uint8Array.of(0xff, 0xfe)
const UTF16_BE_BOM = Uint8Array.of(0xfe, 0xff)

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((byte, index) => bytes[index] === byte)
}

function replacementDecode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

export function decodeUtf8(bytes: Uint8Array): DecodedText {
  if (startsWith(bytes, UTF16_LE_BOM) || startsWith(bytes, UTF16_BE_BOM)) {
    return { kind: 'readonly', text: replacementDecode(bytes), reason: 'encoding' }
  }

  const bom = startsWith(bytes, UTF8_BOM)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { kind: 'readonly', text: replacementDecode(bytes), reason: 'encoding' }
  }

  const withoutCrlf = text.replaceAll('\r\n', '')
  if (withoutCrlf.includes('\r')) {
    return { kind: 'readonly', text, reason: 'mixed-eol' }
  }

  const hasCrlf = text.includes('\r\n')
  if (hasCrlf && withoutCrlf.includes('\n')) {
    return { kind: 'readonly', text, reason: 'mixed-eol' }
  }

  return {
    kind: 'editable',
    text: hasCrlf ? text.replaceAll('\r\n', '\n') : text,
    format: { encoding: 'utf-8', bom, eol: hasCrlf ? 'crlf' : 'lf' }
  }
}

export function encodeUtf8(text: string, format: TextFormat): Uint8Array {
  const serialized = format.eol === 'crlf' ? text.replaceAll('\n', '\r\n') : text
  const encoded = new TextEncoder().encode(serialized)
  if (!format.bom) return encoded

  const bytes = new Uint8Array(UTF8_BOM.byteLength + encoded.byteLength)
  bytes.set(UTF8_BOM)
  bytes.set(encoded, UTF8_BOM.byteLength)
  return bytes
}
