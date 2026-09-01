import { describe, expect, it } from 'vitest'
import { checksum, decodePage, encodePage } from '../src/pages.ts'
import type { PageId } from '../src/index.ts'

describe('binary pages', () => {
  it('round-trips a page and verifies checksum', () => {
    const pageId = 'page_1' as PageId
    const payload = new TextEncoder().encode('hello')
    const encoded = encodePage(pageId, payload)
    const decoded = decodePage(encoded)
    expect(decoded.pageId).toBe(pageId)
    expect(new TextDecoder().decode(decoded.payload)).toBe('hello')
  })

  it('detects payload corruption', () => {
    const pageId = 'page_2' as PageId
    const encoded = encodePage(pageId, new TextEncoder().encode('data'))
    const index = encoded.length - 1
    encoded[index] = encoded[index]! ^ 0xff
    expect(() => decodePage(encoded)).toThrow(/checksum mismatch/)
  })

  it('detects page id corruption', () => {
    const pageId = 'page_3' as PageId
    const encoded = encodePage(pageId, new TextEncoder().encode('data'))
    encoded[10] = 120
    expect(() => decodePage(encoded)).toThrow(/checksum mismatch|bad page/)
  })

  it('rejects an over-long page id', () => {
    expect(() => encodePage(('x'.repeat(70000)) as PageId, new Uint8Array([1]))).toThrow(/too long/)
  })

  it('rejects a container shorter than the fixed header', () => {
    expect(() => decodePage(new Uint8Array([1, 2, 3]))).toThrow(/page too short/)
  })

  it('rejects a truncated container whose declared id length exceeds the bytes', () => {
    const pageId = 'page_with_a_very_long_id_1234567890' as PageId
    const encoded = encodePage(pageId, new TextEncoder().encode('data'))
    const truncated = encoded.subarray(0, 30)
    expect(() => decodePage(truncated)).toThrow(/page too short/)
  })

  it('rejects a bad magic', () => {
    const encoded = encodePage('page_4' as PageId, new TextEncoder().encode('data'))
    encoded[0] = 0
    expect(() => decodePage(encoded)).toThrow(/bad page magic/)
  })

  it('rejects an unsupported version', () => {
    const encoded = encodePage('page_5' as PageId, new TextEncoder().encode('data'))
    encoded[4] = encoded[4]! ^ 0xff
    expect(() => decodePage(encoded)).toThrow(/unsupported page version/)
  })

  it('rejects a truncated payload', () => {
    const encoded = encodePage('page_6' as PageId, new TextEncoder().encode('data'))
    expect(() => decodePage(encoded.subarray(0, encoded.length - 1))).toThrow(/page length mismatch/)
  })

  it('rejects trailing bytes after the payload', () => {
    const encoded = encodePage('page_7' as PageId, new TextEncoder().encode('data'))
    const padded = new Uint8Array(encoded.length + 1)
    padded.set(encoded, 0)
    expect(() => decodePage(padded)).toThrow(/page length mismatch/)
  })

  it('rejects a payload length that overruns the container', () => {
    const pageId = 'page_8' as PageId
    const encoded = encodePage(pageId, new TextEncoder().encode('data'))
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    const payloadLengthOffset = 8 + pageId.length // fixed header + page id
    const overrun = view.getUint32(payloadLengthOffset, false) + 1
    view.setUint32(payloadLengthOffset, overrun, false)
    expect(() => decodePage(encoded)).toThrow(/page length mismatch/)
  })

  it('checksum is deterministic', () => {
    const bytes = new TextEncoder().encode('abc')
    expect(checksum(bytes)).toBe(checksum(bytes))
  })
})
