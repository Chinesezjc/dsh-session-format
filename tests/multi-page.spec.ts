import { describe, expect, it } from 'vitest'
import { fromEntries, SessionTree, toArray } from '../src/btree.ts'
import { MAX_ENTRIES, MAX_KEYS, appendEntryToTree, loadMultiPageTree, saveMultiPageTree } from '../src/multi-page.ts'
import { encodePage } from '../src/pages.ts'
import { PageStore } from '../src/page-store.ts'
import type { BlobId, EventId, PageId } from '../src/index.ts'

function eventId(n: number): EventId {
  return `evt_sess_test_${n}` as EventId
}

function blobId(n: number): BlobId {
  return `blob_${n}` as BlobId
}

describe('multi-page B+Tree', () => {
  it('saves and loads a tree across multiple pages', () => {
    const store = new PageStore()
    let tree = SessionTree.empty()
    for (let i = 0; i < MAX_ENTRIES + 20; i++) tree = tree.append(eventId(i), blobId(i))
    const root = saveMultiPageTree(store, fromEntries(tree.entries()))
    expect(store.size).toBeGreaterThan(1)
    const loaded = loadMultiPageTree(store, root)
    expect(loaded).toBeDefined()
    expect(toArray(loaded).map(entry => entry.eventId)).toEqual(
      toArray(fromEntries(tree.entries())).map(entry => entry.eventId),
    )
  })

  it('handles an empty tree', () => {
    const store = new PageStore()
    const root = saveMultiPageTree(store, undefined)
    const loaded = loadMultiPageTree(store, root)
    expect(loaded).toBeUndefined()
  })

  it('preserves the internal node structure instead of flattening', () => {
    const store = new PageStore()
    let tree = SessionTree.empty()
    for (let i = 0; i < MAX_ENTRIES + 20; i++) tree = tree.append(eventId(i), blobId(i))
    const root = saveMultiPageTree(store, fromEntries(tree.entries()))
    // An internal root keeps its children as separate pages; loading through
    // the root yields an internal node whose keys survive the round trip.
    const rootPayload = JSON.parse(new TextDecoder().decode(store.readPage(root))) as { kind: string; keys?: number[] }
    expect(rootPayload.kind).toBe('internal')
    expect(rootPayload.keys).toBeDefined()
    const loaded = loadMultiPageTree(store, root)
    expect(loaded!.kind).toBe('internal')
    expect(JSON.parse(new TextDecoder().decode(store.readPage(root)))).toMatchObject(
      { kind: 'internal', keys: rootPayload.keys },
    )
    expect(toArray(loaded).map(entry => entry.eventId)).toEqual(
      toArray(fromEntries(tree.entries())).map(entry => entry.eventId),
    )
  })

  it('round-trips a deeper multi-level tree', () => {
    // 80 entries force a multi-level internal tree (leaves, internal level,
    // root), so loading exercises firstOrder recursion over internal children
    // in the key-match loop.
    const store = new PageStore()
    let tree = SessionTree.empty()
    for (let i = 0; i < 80; i++) tree = tree.append(eventId(i), blobId(i))
    const root = saveMultiPageTree(store, fromEntries(tree.entries()))
    const loaded = loadMultiPageTree(store, root)
    expect(loaded!.kind).toBe('internal')
    expect(toArray(loaded).map(entry => entry.eventId)).toEqual(
      toArray(fromEntries(tree.entries())).map(entry => entry.eventId),
    )
  })

  it('rejects an internal page that references an empty child page', () => {
    const store = new PageStore()
    const emptyLeaf = store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'leaf', entries: [] })))
    const root = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [10],
      children: [emptyLeaf, emptyLeaf],
    })))
    expect(() => loadMultiPageTree(store, root)).toThrow(/references empty child page/)
  })

  it('rejects an internal page whose key count does not match its children', () => {
    const store = new PageStore()
    const leaf = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'leaf',
      entries: [{ order: 1, eventId: 'evt_1', blobId: 'blob_1' }],
    })))
    const root = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [1, 2],
      children: [leaf, leaf],
    })))
    expect(() => loadMultiPageTree(store, root)).toThrow(/invalid internal page/)
  })

  it('rejects a single-child internal page before reading its child', () => {
    // The writer only produces internal nodes with at least two children; a
    // single-child internal page is corrupt and must be rejected up front so
    // the loader does not read the child page at all.
    const store = new PageStore()
    const child = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'leaf',
      entries: [{ order: 1, eventId: 'evt_1', blobId: 'blob_1' }],
    })))
    const root = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [1],
      children: [child],
    })))
    expect(() => loadMultiPageTree(store, root)).toThrow(/invalid internal page/)
    expect(store.has(child)).toBe(true)
  })

  it('rejects an internal page with malformed keys or children types', () => {
    const store = new PageStore()
    const badKeys = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: 'x',
      children: ['page_0'],
    })))
    expect(() => loadMultiPageTree(store, badKeys)).toThrow(/must carry a keys number array/)
    const badChild = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [],
      children: [42],
    })))
    expect(() => loadMultiPageTree(store, badChild)).toThrow(/must carry a keys number array/)
  })

  it('rejects a leaf page with unsorted or duplicate entries', () => {
    const store = new PageStore()
    const unsorted = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'leaf',
      entries: [
        { order: 2, eventId: 'evt_2', blobId: 'blob_2' },
        { order: 1, eventId: 'evt_1', blobId: 'blob_1' },
      ],
    })))
    expect(() => loadMultiPageTree(store, unsorted)).toThrow(/strictly increasing order/)
    const duplicated = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'leaf',
      entries: [
        { order: 1, eventId: 'evt_1', blobId: 'blob_1' },
        { order: 2, eventId: 'evt_1', blobId: 'blob_2' },
      ],
    })))
    expect(() => loadMultiPageTree(store, duplicated)).toThrow(/duplicate EventId/)
  })

  it('rejects an internal page with inconsistent keys', () => {
    const store = new PageStore()
    const leaf = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'leaf',
      entries: [{ order: 1, eventId: 'evt_1', blobId: 'blob_1' }],
    })))
    const leaf2 = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'leaf',
      entries: [{ order: 2, eventId: 'evt_2', blobId: 'blob_2' }],
    })))
    const badKey = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [5],
      children: [leaf, leaf2],
    })))
    expect(() => loadMultiPageTree(store, badKey)).toThrow(/keys must match the first order/)
    const third = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'leaf',
      entries: [{ order: 3, eventId: 'evt_3', blobId: 'blob_3' }],
    })))
    const nonIncreasing = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [3, 2],
      children: [leaf, leaf2, third],
    })))
    expect(() => loadMultiPageTree(store, nonIncreasing)).toThrow(/keys must be strictly increasing/)
  })

  it('rejects a page referenced by two siblings and a page cycle', () => {
    const store = new PageStore()
    const leaf = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'leaf',
      entries: [{ order: 1, eventId: 'evt_1', blobId: 'blob_1' }],
    })))
    const shared = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [1],
      children: [leaf, leaf],
    })))
    expect(() => loadMultiPageTree(store, shared)).toThrow(/referenced more than once or in a cycle/)
  })

  it('rejects duplicated EventIds across sibling leaves', () => {
    const store = new PageStore()
    const first = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'leaf',
      entries: [{ order: 1, eventId: 'evt_1', blobId: 'blob_1' }],
    })))
    const second = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'leaf',
      entries: [{ order: 2, eventId: 'evt_1', blobId: 'blob_2' }],
    })))
    const root = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [2],
      children: [first, second],
    })))
    expect(() => loadMultiPageTree(store, root)).toThrow(/duplicate EventId/)
  })

  it('rejects an over-capacity leaf page', () => {
    const store = new PageStore()
    const page = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'leaf',
      entries: Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => ({ order: index + 1, eventId: `evt_${index + 1}`, blobId: `blob_${index + 1}` })),
    })))
    expect(() => loadMultiPageTree(store, page)).toThrow(/above the per-node cap/)
  })

  it('rejects an over-fanout internal page and mixed-depth children', () => {
    const store = new PageStore()
    const leaves: PageId[] = []
    for (let i = 0; i < MAX_KEYS + 2; i++) {
      leaves.push(store.writePage(new TextEncoder().encode(JSON.stringify({
        kind: 'leaf',
        entries: [{ order: i + 1, eventId: `evt_${i + 1}`, blobId: `blob_${i + 1}` }],
      }))))
    }
    const overFanout = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [2, 3, 4, 5, 6],
      children: leaves,
    })))
    expect(() => loadMultiPageTree(store, overFanout)).toThrow(/invalid internal page/)
    const deep = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [3],
      children: [leaves[1]!, leaves[2]!],
    })))
    const mixed = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [2, 4],
      children: [leaves[0]!, deep, leaves[3]!],
    })))
    expect(() => loadMultiPageTree(store, mixed)).toThrow(/must share one depth/)
  })

  it('rejects a page cycle', () => {
    const storage = new Map<PageId, Uint8Array>()
    const store = new PageStore(storage)
    const root = store.writePage(new TextEncoder().encode('placeholder'))
    // Rewrite the root container so one of its children references itself:
    // the first visit marks the root, and the second reference is rejected
    // as a cycle. Two children keep the internal node valid (>= 2) so the
    // cycle check is what fires.
    storage.set(root, encodePage(root, new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [0],
      children: [root, root],
    }))))
    expect(() => loadMultiPageTree(store, root)).toThrow(/referenced more than once or in a cycle/)
  })

  it('rejects a malformed leaf page', () => {
    const store = new PageStore()
    const badLeaf = store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'leaf', entries: 'evt_1' })))
    expect(() => loadMultiPageTree(store, badLeaf)).toThrow(/must carry an entries array/)
    const badEntry = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'leaf',
      entries: [{ order: 'x', eventId: 'evt_1', blobId: 'blob_1' }],
    })))
    expect(() => loadMultiPageTree(store, badEntry)).toThrow(/must carry order, eventId, and blobId/)
    const wrongKind = store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'branch' })))
    expect(() => loadMultiPageTree(store, wrongKind)).toThrow(/leaf or internal tree node/)
  })

  it('rejects an internal page with no children', () => {
    const store = new PageStore()
    const root = store.writePage(new TextEncoder().encode(JSON.stringify({
      kind: 'internal',
      keys: [],
      children: [],
    })))
    expect(() => loadMultiPageTree(store, root)).toThrow(/invalid internal page/)
  })
})

describe('appendEntryToTree', () => {
  it('appends into the rightmost leaf and matches the in-memory tree', () => {
    const store = new PageStore()
    let root = saveMultiPageTree(store, undefined)
    for (let i = 0; i < 7; i++) root = appendEntryToTree(store, root, eventId(i), blobId(i))
    const loaded = toArray(loadMultiPageTree(store, root))
    expect(loaded.map(entry => entry.eventId)).toEqual([0, 1, 2, 3, 4, 5, 6].map(eventId))
    expect(loaded.map(entry => entry.order)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('splits a full leaf into two sibling leaves', () => {
    const store = new PageStore()
    let root = saveMultiPageTree(store, undefined)
    // The append past MAX_ENTRIES splits the leaf; the empty seed leaf is
    // unreachable from the new root.
    for (let i = 0; i < MAX_ENTRIES + 1; i++) root = appendEntryToTree(store, root, eventId(i), blobId(i))
    expect(toArray(loadMultiPageTree(store, root))).toHaveLength(MAX_ENTRIES + 1)
    // The split produced an internal root over two leaves (copy-on-write
    // pages accumulate, so the store holds the seed leaf plus the path
    // copies).
    const rootNode = loadMultiPageTree(store, root)
    expect(rootNode?.kind).toBe('internal')
    expect(store.size).toBeGreaterThanOrEqual(4)
  })

  it('splits internal nodes and the root, staying loadable', () => {
    const store = new PageStore()
    let root = saveMultiPageTree(store, undefined)
    let tree = SessionTree.empty()
    // (MAX_ENTRIES + 1) leaves overflow a single-level internal root only past
    // MAX_KEYS leaves; push through both levels.
    const total = (MAX_KEYS + 2) * (MAX_ENTRIES + 1)
    for (let i = 0; i < total; i++) {
      root = appendEntryToTree(store, root, eventId(i), blobId(i))
      tree = tree.append(eventId(i), blobId(i))
    }
    const loaded = toArray(loadMultiPageTree(store, root))
    expect(loaded).toHaveLength(total)
    expect(loaded.map(entry => entry.eventId)).toEqual(tree.entries().map(entry => entry.eventId))
    expect(loaded.map(entry => entry.order)).toEqual(Array.from({ length: total }, (_, i) => i))
  })

  it('rejects an order that cannot advance past the number ceiling', () => {
    const store = new PageStore()
    // 2^53 is the first order whose successor equals itself in IEEE-754.
    const ceiling = 2 ** 53
    const leaf = { kind: 'leaf' as const, entries: [{ order: ceiling, eventId: eventId(0), blobId: blobId(0) }] }
    const root = store.writePage(new TextEncoder().encode(JSON.stringify(leaf)))
    expect(() => appendEntryToTree(store, root, eventId(1), blobId(1))).toThrow(/full renumber/)
  })
})
