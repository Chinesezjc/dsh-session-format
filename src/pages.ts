/**
 * Binary page container with checksums for the session format.
 * A page is encoded as `[magic u32][version u16][pageId length u16][pageId utf8][payload length u32][checksum u32][payload]`.
 * The checksum covers pageId + payload, so corruption is detected before a page
 * is used.
 * @module @deepseek-ai/dsh-session-format/pages
 */

import type { PageId } from './index.ts'

const MAGIC = 0x44534850 // 'DSHP'
const VERSION = 1
const FIXED_HEADER_SIZE = 4 + 2 + 2 // magic, version, id length
const TAIL_HEADER_SIZE = 4 + 4 // payload length, checksum

/** Compute a FNV-1a 32-bit checksum over the supplied bytes.
 * @param bytes - bytes to checksum.
 * @returns the 32-bit FNV-1a hash as an unsigned integer.
 */
export function checksum(bytes: Uint8Array): number {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Encode one page with a checksummed binary header.
 * @param pageId - page identity stored in the header and covered by the checksum.
 * @param payload - page payload bytes.
 * @returns the encoded page container.
 */
export function encodePage(pageId: PageId, payload: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(pageId)
  if (id.length > 0xffff) throw new Error(`page id ${pageId} is too long to encode`)
  const out = new Uint8Array(FIXED_HEADER_SIZE + id.length + TAIL_HEADER_SIZE + payload.length)
  const view = new DataView(out.buffer)
  let offset = 0
  view.setUint32(offset, MAGIC, false)
  offset += 4
  view.setUint16(offset, VERSION, false)
  offset += 2
  view.setUint16(offset, id.length, false)
  offset += 2
  out.set(id, offset)
  offset += id.length
  view.setUint32(offset, payload.length, false)
  offset += 4
  const covered = new Uint8Array(id.length + payload.length)
  covered.set(id, 0)
  covered.set(payload, id.length)
  view.setUint32(offset, checksum(covered), false)
  offset += 4
  out.set(payload, offset)
  return out
}

/** Decode and verify one page.
 * @param bytes - encoded page container bytes.
 * @returns the decoded page id and a view over the payload bytes.
 */
export function decodePage(bytes: Uint8Array): { readonly pageId: PageId; readonly payload: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < FIXED_HEADER_SIZE) throw new Error('page too short')
  if (view.getUint32(0, false) !== MAGIC) throw new Error('bad page magic')
  if (view.getUint16(4, false) !== VERSION) throw new Error('unsupported page version')
  const idLength = view.getUint16(6, false)
  const expectedLength = FIXED_HEADER_SIZE + idLength + TAIL_HEADER_SIZE
  if (bytes.byteLength < expectedLength) throw new Error('page too short')
  const idStart = FIXED_HEADER_SIZE
  const id = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(idStart, idStart + idLength))
  const payloadLengthOffset = idStart + idLength
  const payloadLength = view.getUint32(payloadLengthOffset, false)
  const totalLength = expectedLength + payloadLength
  if (bytes.byteLength !== totalLength) throw new Error('page length mismatch')
  const checksumOffset = payloadLengthOffset + 4
  const storedSum = view.getUint32(checksumOffset, false)
  const payload = bytes.subarray(checksumOffset + 4)
  const covered = new Uint8Array(idLength + payloadLength)
  covered.set(bytes.subarray(idStart, idStart + idLength), 0)
  covered.set(payload, idLength)
  const actualSum = checksum(covered)
  if (actualSum !== storedSum) throw new Error(`page checksum mismatch for ${id}`)
  return { pageId: id as PageId, payload }
}
