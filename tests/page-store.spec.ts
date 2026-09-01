import { describe, expect, it } from 'vitest'
import type { PageId } from '../src/index.ts'
import { encodePage } from '../src/pages.ts'
import { PageStore } from '../src/page-store.ts'

describe('PageStore', () => {
  it('round-trips a page payload', () => {
    const store = new PageStore()
    const pageId = store.writePage(new TextEncoder().encode('hello'))
    expect(new TextDecoder().decode(store.readPage(pageId))).toBe('hello')
  })

  it('throws when reading a missing page', () => {
    const store = new PageStore()
    expect(() => store.readPage('page_missing' as PageId)).toThrow(/missing page/)
  })

  it('reports size, presence, page ids, and deletion', () => {
    const store = new PageStore()
    const first = store.writePage(new TextEncoder().encode('a'))
    const second = store.writePage(new TextEncoder().encode('b'))
    expect(store.size).toBe(2)
    expect(store.has(first)).toBe(true)
    expect(store.has('page_none' as PageId)).toBe(false)
    expect(store.pageIds()).toEqual([first, second])
    store.deletePage(first)
    expect(store.size).toBe(1)
    expect(store.has(first)).toBe(false)
    expect(store.pageIds()).toEqual([second])
  })

  it('rejects a container whose stored id differs from the requested id', () => {
    const storage = new Map<PageId, Uint8Array>()
    const store = new PageStore(storage)
    const requested = 'page_requested' as PageId
    storage.set(requested, encodePage('page_other' as PageId, new TextEncoder().encode('payload')))
    expect(() => store.readPage(requested)).toThrow(/page id mismatch/)
  })

  it('returns an independent copy so callers cannot corrupt stored pages', () => {
    const store = new PageStore()
    const pageId = store.writePage(new TextEncoder().encode('data'))
    const first = store.readPage(pageId)
    first[0] = first[0]! ^ 0xff
    expect(new TextDecoder().decode(store.readPage(pageId))).toBe('data')
  })

  it('serves pages written through an injected storage map', () => {
    const storage = new Map<PageId, Uint8Array>()
    const store = new PageStore(storage)
    const pageId = store.writePage(new TextEncoder().encode('payload'))
    expect(storage.has(pageId)).toBe(true)
    expect(new TextDecoder().decode(store.readPage(pageId))).toBe('payload')
  })

  it('resumes the id counter past pages already in an injected storage map', () => {
    const storage = new Map<PageId, Uint8Array>([
      ['page_5' as PageId, encodePage('page_5' as PageId, new TextEncoder().encode('existing'))],
      // A non-numeric id must not perturb the counter.
      ['page_other' as PageId, encodePage('page_other' as PageId, new TextEncoder().encode('other'))],
    ])
    const store = new PageStore(storage)
    const pageId = store.writePage(new TextEncoder().encode('new'))
    expect(pageId).not.toBe('page_5')
    expect(pageId).not.toBe('page_other')
    expect(new TextDecoder().decode(store.readPage('page_5' as PageId))).toBe('existing')
    expect(new TextDecoder().decode(store.readPage('page_other' as PageId))).toBe('other')
    expect(new TextDecoder().decode(store.readPage(pageId))).toBe('new')
  })

  it('returns an independent copy for Buffer-backed storage', () => {
    const storage = new Map<PageId, Uint8Array>()
    const store = new PageStore(storage)
    const page = store.writePage(new TextEncoder().encode('data'))
    // Replace the stored bytes with a Buffer view; readPage must not alias it.
    storage.set(page, Buffer.from(storage.get(page)!))
    const first = store.readPage(page)
    first[0] = 0
    expect(store.readPage(page)[0]).not.toBe(0)
  })

  it('rejects non-safe-integer page ids in the backing map', () => {
    const storage = new Map<PageId, Uint8Array>([
      ['page_9007199254740992' as PageId, new Uint8Array([1, 2, 3])],
    ])
    expect(() => new PageStore(storage)).toThrow(/not a safe integer/)
  })

  it('never reuses a page id freed by deletion', () => {
    const storage = new Map<PageId, Uint8Array>()
    const store = new PageStore(storage)
    const first = store.writePage(new TextEncoder().encode('a'))
    const second = store.writePage(new TextEncoder().encode('b'))
    store.deletePage(first)
    const rebuilt = new PageStore(storage)
    const third = rebuilt.writePage(new TextEncoder().encode('c'))
    expect(third).not.toBe(first)
    expect(third).not.toBe(second)
    expect(() => rebuilt.readPage(first)).toThrow(/missing page/)
    expect(new TextDecoder().decode(rebuilt.readPage(third))).toBe('c')
  })
  it('rejects a counter that would overflow the safe-integer range', () => {
    const storage = new Map<PageId, Uint8Array>([
      ['page_9007199254740990' as PageId, new Uint8Array([1])],
    ])
    const store = new PageStore(storage)
    expect(() => store.writePage(new Uint8Array([2]))).toThrow(/safe-integer range/)
  })

  it('rejects a backing map whose highest id would overflow when resumed', () => {
    const storage = new Map<PageId, Uint8Array>([
      ['page_9007199254740991' as PageId, new Uint8Array([1])],
    ])
    expect(() => new PageStore(storage)).toThrow(/safe-integer range/)
  })
})
