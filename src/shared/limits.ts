const MEBIBYTE = 1024 * 1024

export const EDITABLE_DOCUMENT_MAX_BYTES = 2 * MEBIBYTE
export const LOADABLE_DOCUMENT_MAX_BYTES = 10 * MEBIBYTE

export type DocumentSizeClassification = 'editable' | 'readonly' | 'reject'

export function classifyDocumentSize(byteLength: number): DocumentSizeClassification {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError('byteLength must be a non-negative safe integer')
  }
  if (byteLength <= EDITABLE_DOCUMENT_MAX_BYTES) return 'editable'
  if (byteLength <= LOADABLE_DOCUMENT_MAX_BYTES) return 'readonly'
  return 'reject'
}
