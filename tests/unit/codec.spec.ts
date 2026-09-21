import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { decodeUtf8, encodeUtf8 } from '../../src/main/documents/codec'
import {
  EDITABLE_DOCUMENT_MAX_BYTES,
  LOADABLE_DOCUMENT_MAX_BYTES,
  classifyDocumentSize
} from '../../src/shared/limits'

const fixtureDirectory = resolve(import.meta.dirname, '../fixtures/encoding')

function readHexFixture(name: string): Uint8Array {
  const hex = readFileSync(resolve(fixtureDirectory, name), 'utf8').trim()
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('UTF-8 codec', () => {
  it('preserves BOM, CRLF and the missing final newline', () => {
    const bytes = readHexFixture('utf8-bom-crlf-no-final.hex')

    expect(sha256(bytes)).toBe('06710d933d937133ffa4d8b24e2daf5a1cb29a2c1a0d5f2cd860b39e82c3e472')
    const decoded = decodeUtf8(bytes)

    expect(decoded.kind).toBe('editable')
    if (decoded.kind !== 'editable') throw new Error('expected editable')
    expect(decoded.text).toBe('# 中文\n正文')
    expect(decoded.format).toEqual({ encoding: 'utf-8', bom: true, eol: 'crlf' })
    expect(encodeUtf8(decoded.text, decoded.format)).toEqual(bytes)
  })

  it('keeps LF text and its final newline byte-for-byte', () => {
    const bytes = new TextEncoder().encode('# 标题\n正文\n')
    const decoded = decodeUtf8(bytes)

    expect(decoded).toEqual({
      kind: 'editable',
      text: '# 标题\n正文\n',
      format: { encoding: 'utf-8', bom: false, eol: 'lf' }
    })
    if (decoded.kind !== 'editable') throw new Error('expected editable')
    expect(encodeUtf8(decoded.text, decoded.format)).toEqual(bytes)
  })

  it('returns replacement text as read-only for malformed UTF-8', () => {
    const bytes = readHexFixture('invalid-utf8.hex')

    expect(sha256(bytes)).toBe('ffdc5be177507b2084d1882a620bcb7d7428c085a5e5794f22163d7d5f1dc47b')
    expect(decodeUtf8(bytes)).toEqual({ kind: 'readonly', text: '# bad\n�(', reason: 'encoding' })
  })

  it('rejects a UTF-16 BOM even when the remaining bytes are valid UTF-8', () => {
    const bytes = readHexFixture('utf16le-bom.hex')

    expect(sha256(bytes)).toBe('a652a9145f8ed84f1e5a3397566f406b915097610df5c379e64df93dccf8c741')
    expect(decodeUtf8(bytes)).toMatchObject({ kind: 'readonly', reason: 'encoding' })
  })

  it('keeps mixed LF and CRLF text read-only without normalization', () => {
    const bytes = readHexFixture('mixed-eol.hex')

    expect(sha256(bytes)).toBe('5aecdf775ccf109670b2a18c5b43105ca48df3fedc2a6e707aa90cdfefe74843')
    expect(decodeUtf8(bytes)).toEqual({ kind: 'readonly', text: 'a\r\nb\nc', reason: 'mixed-eol' })
  })

  it('keeps text containing a lone CR read-only without normalization', () => {
    const bytes = readHexFixture('lone-cr.hex')

    expect(sha256(bytes)).toBe('af9081672dd5ef3247a30c2db5b0dafcc9bcf981a26aefb3c55d210d43fcc14e')
    expect(decodeUtf8(bytes)).toEqual({ kind: 'readonly', text: 'a\rb', reason: 'mixed-eol' })
  })
})

describe('document size policy', () => {
  it.each([
    [0, 'editable'],
    [EDITABLE_DOCUMENT_MAX_BYTES, 'editable'],
    [EDITABLE_DOCUMENT_MAX_BYTES + 1, 'readonly'],
    [LOADABLE_DOCUMENT_MAX_BYTES, 'readonly'],
    [LOADABLE_DOCUMENT_MAX_BYTES + 1, 'reject']
  ] as const)('classifies %i bytes as %s', (byteLength, expected) => {
    expect(classifyDocumentSize(byteLength)).toBe(expected)
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid byte length %s',
    (byteLength) => {
      expect(() => classifyDocumentSize(byteLength)).toThrow(RangeError)
    }
  )
})
