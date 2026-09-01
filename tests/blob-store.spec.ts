import { describe, expect, it } from 'vitest'
import { BLOB_SEGMENT_SIZE, BlobStore } from '../src/blob-store.ts'

describe('BlobStore', () => {
  it('writes and reads blobs within a segment', () => {
    const store = new BlobStore()
    const a = store.writeBlob(new TextEncoder().encode('hello'))
    const b = store.writeBlob(new TextEncoder().encode('world'))
    expect(new TextDecoder().decode(store.readBlob(a))).toBe('hello')
    expect(new TextDecoder().decode(store.readBlob(b))).toBe('world')
    expect(store.segmentCount).toBe(1)
  })

  it('allocates a new segment when the current one is full', () => {
    const store = new BlobStore()
    const big = new Uint8Array(BLOB_SEGMENT_SIZE - 1)
    store.writeBlob(big)
    const small = store.writeBlob(new TextEncoder().encode('tail'))
    expect(store.segmentCount).toBe(2)
    expect(new TextDecoder().decode(store.readBlob(small))).toBe('tail')
  })

  it('accepts a blob that exactly fills one segment', () => {
    const store = new BlobStore()
    const id = store.writeBlob(new Uint8Array(BLOB_SEGMENT_SIZE))
    expect(store.segmentCount).toBe(1)
    expect(store.readBlob(id).byteLength).toBe(BLOB_SEGMENT_SIZE)
    store.writeBlob(new TextEncoder().encode('next'))
    expect(store.segmentCount).toBe(2)
  })

  it('rejects blobs larger than one segment', () => {
    const store = new BlobStore()
    expect(() => store.writeBlob(new Uint8Array(BLOB_SEGMENT_SIZE + 1))).toThrow(/exceeds segment size/)
  })

  it('tracks the number of logical blobs', () => {
    const store = new BlobStore()
    expect(store.size).toBe(0)
    const a = store.writeBlob(new TextEncoder().encode('a'))
    const b = store.writeBlob(new TextEncoder().encode('b'))
    expect(store.size).toBe(2)
    store.deleteBlob(a)
    expect(store.size).toBe(1)
    store.deleteBlob(b)
    expect(store.size).toBe(0)
  })

  it('supports logical deletion', () => {
    const store = new BlobStore()
    const blob = store.writeBlob(new TextEncoder().encode('x'))
    store.deleteBlob(blob)
    expect(() => store.readBlob(blob)).toThrow(/missing blob/)
  })

  it('returns independent copies on read', () => {
    const store = new BlobStore()
    const blob = store.writeBlob(new TextEncoder().encode('payload'))
    const first = store.readBlob(blob)
    first[0] = 0
    expect(new TextDecoder().decode(store.readBlob(blob))).toBe('payload')
  })

  it('copies payload bytes on write', () => {
    const store = new BlobStore()
    const payload = new Uint8Array([1, 2, 3])
    const blob = store.writeBlob(payload)
    payload[0] = 9
    expect(store.readBlob(blob)).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('does not reuse a deleted region for the next write', () => {
    const store = new BlobStore()
    const first = store.writeBlob(new Uint8Array(4).fill(1))
    const copy = store.readBlob(first)
    store.deleteBlob(first)
    // Fill the rest of the segment: appending at the high-water mark leaves
    // no room, so the third write proves whether the deleted offset 0 was
    // reused (still fits, one segment) or retained for GC (new segment).
    store.writeBlob(new Uint8Array(BLOB_SEGMENT_SIZE - 4).fill(2))
    store.writeBlob(new Uint8Array(4).fill(3))
    expect(store.segmentCount).toBe(2)
    expect(copy).toEqual(new Uint8Array(4).fill(1))
  })
})
