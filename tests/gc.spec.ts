import { describe, expect, it } from 'vitest'
import { fromEntries, SessionTree, toArray } from '../src/btree.ts'
import { collectGarbage } from '../src/gc.ts'
import type { BlobId, EventId, SessionId, StoredSessionRecord, SessionRevision } from '../src/index.ts'
import { MAX_ENTRIES, loadMultiPageTree, saveMultiPageTree } from '../src/multi-page.ts'
import { PageStore } from '../src/page-store.ts'

function eventId(n: number): EventId {
  return `evt_sess_test_${n}` as EventId
}

function blobId(n: number): BlobId {
  return `blob_${n}` as BlobId
}

describe('collectGarbage', () => {
  it('removes orphan pages and keeps roots, backups, and metadata pages', () => {
    const store = new PageStore()
    const root = store.writePage(new TextEncoder().encode('{}'))
    const backupRoot = store.writePage(new TextEncoder().encode('{}'))
    const blobMapPage = store.writePage(new TextEncoder().encode('{}'))
    const referencesPage = store.writePage(new TextEncoder().encode('{}'))
    const compactedPage = store.writePage(new TextEncoder().encode('{}'))
    const orphan = store.writePage(new TextEncoder().encode('orphan'))
    const backup: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: backupRoot,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    const session: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: root,
      revision: 'rev-2' as SessionRevision,
      blobMapPage,
      referencesPage,
      compactedPage,
      nextEventCounter: 0,

      backups: [backup],
    }
    const removed = collectGarbage(store, [session])
    expect(removed).toBe(1)
    expect(store.has(root)).toBe(true)
    expect(store.has(backupRoot)).toBe(true)
    expect(store.has(blobMapPage)).toBe(true)
    expect(store.has(referencesPage)).toBe(true)
    expect(store.has(compactedPage)).toBe(true)
    expect(store.has(orphan)).toBe(false)
  })

  it('keeps child pages of a multi-page tree root', () => {
    const store = new PageStore()
    let tree = SessionTree.empty()
    for (let i = 0; i < MAX_ENTRIES + 20; i++) tree = tree.append(eventId(i), blobId(i))
    const root = saveMultiPageTree(store, fromEntries(tree.entries()))
    const orphan = store.writePage(new TextEncoder().encode('orphan'))
    const session: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: root,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    const removed = collectGarbage(store, [session])
    expect(removed).toBe(1)
    expect(store.has(orphan)).toBe(false)
    const loaded = loadMultiPageTree(store, root)
    expect(toArray(loaded).map(entry => entry.eventId)).toEqual(
      toArray(fromEntries(tree.entries())).map(entry => entry.eventId),
    )
    expect(store.size).toBeGreaterThan(1)
  })

  it('treats an empty multi-page root as a leaf with no children', () => {
    const store = new PageStore()
    const root = saveMultiPageTree(store, undefined)
    const session: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: root,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    expect(collectGarbage(store, [session])).toBe(0)
    expect(store.has(root)).toBe(true)
  })

  it('keeps pages of every backup generation', () => {
    const store = new PageStore()
    const current = saveMultiPageTree(store, fromEntries([{ order: 0, eventId: eventId(0), blobId: blobId(0) }]))
    const backupRoot = saveMultiPageTree(store, fromEntries([{ order: 0, eventId: eventId(1), blobId: blobId(1) }]))
    const backupBlobMapPage = store.writePage(new TextEncoder().encode('{}'))
    const backupRecord: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: backupRoot,
      revision: 'rev-2' as SessionRevision,
      blobMapPage: backupBlobMapPage,
      nextEventCounter: 0,

      backups: [],
    }
    const session: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: current,
      revision: 'rev-3' as SessionRevision,
      nextEventCounter: 0,

      backups: [backupRecord],
    }
    expect(collectGarbage(store, [session])).toBe(0)
    expect(store.has(current)).toBe(true)
    expect(store.has(backupRoot)).toBe(true)
    expect(store.has(backupBlobMapPage)).toBe(true)
  })

  it('retains nothing when no session records are supplied', () => {
    const store = new PageStore()
    const orphan = store.writePage(new TextEncoder().encode('orphan'))
    expect(collectGarbage(store, [])).toBe(1)
    expect(store.has(orphan)).toBe(false)
    expect(store.size).toBe(0)
  })

  it('aborts GC on a reachable page with a non-JSON payload', () => {
    // A checksum-valid but non-JSON root cannot be traversed safely: treating
    // it as childless would let the sweep delete pages it references. The
    // collection must stop instead of silently losing recoverable data.
    const store = new PageStore()
    const root = store.writePage(new Uint8Array([1, 2, 3]))
    const session: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: root,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    expect(() => collectGarbage(store, [session]))
      .toThrow(/cannot traverse a reachable page with a non-JSON payload/)
  })

  it('aborts GC on a reachable page that is not a JSON object', () => {
    const store = new PageStore()
    const root = store.writePage(new TextEncoder().encode('"plain-string"'))
    const session: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: root,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    expect(() => collectGarbage(store, [session]))
      .toThrow(/cannot traverse a reachable page with a non-JSON payload/)
  })

  it('aborts GC on a reachable page with invalid UTF-8', () => {
    // A checksum-valid page with a broken UTF-8 sequence must fail fatal
    // decoding and abort the collection, not decode to U+FFFD and read as a
    // childless page that lets the sweep delete its references.
    const store = new PageStore()
    const root = store.writePage(new Uint8Array([0x7b, 0xff, 0x7d])) // '{', invalid, '}'
    const session: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: root,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    expect(() => collectGarbage(store, [session]))
      .toThrow(/cannot traverse a reachable page with a non-JSON payload/)
  })

  it('visits a shared root page only once across sessions', () => {
    const store = new PageStore()
    const root = saveMultiPageTree(store, fromEntries([{ order: 0, eventId: eventId(0), blobId: blobId(0) }]))
    const first: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: root,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    const second: StoredSessionRecord = {
      sessionId: 'sess_2' as SessionId,
      formatVersion: 1,
      rootPage: root,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    expect(collectGarbage(store, [first, second])).toBe(0)
    expect(store.has(root)).toBe(true)
  })

  it('keeps a referenced child page id even when the payload is not a tree node', () => {
    const store = new PageStore()
    const child = store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'leaf', entries: [] })))
    const root = store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'internal', children: [child] })))
    const session: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: root,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    expect(collectGarbage(store, [session])).toBe(0)
    expect(store.has(root)).toBe(true)
    expect(store.has(child)).toBe(true)
  })

  it('aborts GC on an internal node without a children array', () => {
    // A reachable page declaring kind=internal without a string children
    // array is corrupted; treating it as childless would let the sweep delete
    // its subtrees, so the collection must stop.
    const store = new PageStore()
    const root = store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'internal' })))
    const session: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: root,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    expect(() => collectGarbage(store, [session]))
      .toThrow(/cannot traverse a reachable internal page without a string children array/)
  })

  it('aborts GC on a reachable page with an unknown kind', () => {
    // A checksum-valid page with an unknown kind (possibly carrying a
    // children array) is corrupted; treating it as childless would let the
    // sweep delete pages it references.
    const store = new PageStore()
    const child = store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'leaf', entries: [] })))
    const root = store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'branch', children: [child] })))
    const session: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: root,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    expect(() => collectGarbage(store, [session]))
      .toThrow(/cannot traverse a reachable page with unknown kind branch/)
    expect(store.has(child)).toBe(true)
    // A non-string kind reports through the JSON fallback in the message.
    const numericKind = store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 42, children: [child] })))
    const numericSession: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: numericKind,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    expect(() => collectGarbage(store, [numericSession]))
      .toThrow(/cannot traverse a reachable page with unknown kind/)
  })

  it('aborts GC on a leaf page carrying a children field', () => {
    // A leaf (or kind-less) page that unexpectedly carries children is a
    // corrupted page (for example an internal node whose kind was damaged);
    // treating it as childless would let the sweep delete its subtrees.
    const store = new PageStore()
    const child = store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'leaf', entries: [] })))
    const root = store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'leaf', entries: [], children: [child] })))
    const session: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: root,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    expect(() => collectGarbage(store, [session]))
      .toThrow(/cannot traverse a reachable leaf page carrying children/)
    expect(store.has(child)).toBe(true)
    // A kind-less (metadata) page carrying children is likewise corrupted.
    const kindless = store.writePage(new TextEncoder().encode(JSON.stringify({ blobs: {}, children: [child] })))
    const kindlessSession: StoredSessionRecord = {
      sessionId: 'sess_1' as SessionId,
      formatVersion: 1,
      rootPage: kindless,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: 0,

      backups: [],
    }
    expect(() => collectGarbage(store, [kindlessSession]))
      .toThrow(/cannot traverse a reachable metadata page carrying children/)
  })

  it('collects a long blob-map chain without overflowing the stack', () => {
    // The blob-map chain is linear in the number of appends; a recursive
    // traversal overflows the stack once the chain reaches tens of thousands
    // of pages, so the sweep must iterate.
    const store = new PageStore()
    let head: string | undefined
    const CHAIN = 40000
    for (let i = 0; i < CHAIN; i++) {
      head = store.writePage(new TextEncoder().encode(JSON.stringify({
        kind: 'blob-appends',
        ...(head === undefined ? {} : { prev: head }),
        blobs: {},
      })))
    }
    const leaf = store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'leaf', entries: [] })))
    const session: StoredSessionRecord = {
      sessionId: 'sess_chain' as SessionId,
      formatVersion: 1,
      rootPage: leaf,
      blobMapPage: head as never,
      revision: 'rev-1' as SessionRevision,
      nextEventCounter: CHAIN,
      backups: [],
    }
    expect(() => collectGarbage(store, [session])).not.toThrow()
    // Everything reachable is retained.
    expect(store.pageIds()).toHaveLength(CHAIN + 1)
  })
})
