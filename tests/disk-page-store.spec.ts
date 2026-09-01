import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fromEntries, SessionTree, toArray } from '../src/btree.ts'
import { SessionFormatEngine } from '../src/engine.ts'
import type { SessionFile } from '../src/file.ts'
import type { BlobId, EventId, PageId, SessionId, SessionRevision, StoredSessionRecord } from '../src/index.ts'
import { loadMultiPageTree, saveMultiPageTree } from '../src/multi-page.ts'
import { encodePage } from '../src/pages.ts'
import { DiskPageStore } from '../src/disk-page-store.ts'
import { SessionStore } from '../src/store.ts'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-disk-page-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('DiskPageStore', () => {
  it('round-trips a page payload through disk', () => {
    const store = new DiskPageStore(tempDir())
    const pageId = store.writePage(new TextEncoder().encode('hello'))
    expect(new TextDecoder().decode(store.readPage(pageId))).toBe('hello')
  })

  it('rebuilds every page from disk in a fresh store over the same directory', () => {
    const dir = tempDir()
    const first = new DiskPageStore(dir)
    const pageA = first.writePage(new TextEncoder().encode('a'))
    const pageB = first.writePage(new TextEncoder().encode('b'))
    const rebuilt = new DiskPageStore(dir)
    expect(new TextDecoder().decode(rebuilt.readPage(pageA))).toBe('a')
    expect(new TextDecoder().decode(rebuilt.readPage(pageB))).toBe('b')
    expect(rebuilt.size).toBe(2)
    expect(rebuilt.pageIds()).toEqual([pageA, pageB])
  })

  it('resumes the id counter past pages written before a rebuild', () => {
    const dir = tempDir()
    const first = new DiskPageStore(dir)
    first.writePage(new TextEncoder().encode('a'))
    first.writePage(new TextEncoder().encode('b'))
    const rebuilt = new DiskPageStore(dir)
    const next = rebuilt.writePage(new TextEncoder().encode('c'))
    expect(next).toBe('page_2' as PageId)
  })

  it('never reuses a page id freed by deletion, even across a rebuild', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    const first = store.writePage(new TextEncoder().encode('a'))
    const second = store.writePage(new TextEncoder().encode('b'))
    store.deletePage(first)
    const rebuilt = new DiskPageStore(dir)
    const third = rebuilt.writePage(new TextEncoder().encode('c'))
    expect(third).not.toBe(first)
    expect(third).not.toBe(second)
    expect(() => rebuilt.readPage(first)).toThrow(/missing page/)
    expect(new TextDecoder().decode(rebuilt.readPage(third))).toBe('c')
  })

  it('does not let a missing watermark file lower the next id below scanned pages', () => {
    // A crash between a page write and its watermark update leaves the page
    // file on disk with no meta.json; the rebuild must resume past the scanned
    // maximum instead of reusing the orphaned page id.
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    const pageId = store.writePage(new TextEncoder().encode('a'))
    // Simulate the crash window: page file present, watermark file absent.
    rmSync(join(dir, 'meta.json'))
    const rebuilt = new DiskPageStore(dir)
    expect(rebuilt.pageIds()).toEqual([pageId])
    const next = rebuilt.writePage(new TextEncoder().encode('b'))
    expect(next).not.toBe(pageId)
    expect(new TextDecoder().decode(rebuilt.readPage(pageId))).toBe('a')
  })

  it('does not let a stale watermark lower the next id below a manually written page', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    store.writePage(new TextEncoder().encode('a'))
    // A page written behind the store's back (watermark still 1) must not be
    // overwritten: the rebuild scans it and advances past it.
    writeFileSync(join(dir, 'pages', 'page_3.page'), encodePage('page_3' as PageId, new TextEncoder().encode('manual')))
    const rebuilt = new DiskPageStore(dir)
    expect(rebuilt.pageIds()).toContain('page_3' as PageId)
    expect(new TextDecoder().decode(rebuilt.readPage('page_3' as PageId))).toBe('manual')
    const next = rebuilt.writePage(new TextEncoder().encode('b'))
    expect(next).toBe('page_4' as PageId)
  })

  it('throws when reading a missing page', () => {
    const store = new DiskPageStore(tempDir())
    expect(() => store.readPage('page_missing' as PageId)).toThrow(/missing page/)
  })

  it('reports size, presence, page ids, and deletion', () => {
    const store = new DiskPageStore(tempDir())
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

  it('rejects a page file whose stored id differs from the requested id', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    const requested = 'page_requested' as PageId
    writeFileSync(join(dir, 'pages', `${requested}.page`), encodePage('page_other' as PageId, new TextEncoder().encode('payload')))
    expect(() => store.readPage(requested)).toThrow(/page id mismatch/)
  })

  it('rejects a page file with a corrupt checksum', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    const pageId = store.writePage(new TextEncoder().encode('data'))
    const path = join(dir, 'pages', `${pageId}.page`)
    const bytes = readFileSync(path)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    writeFileSync(path, bytes)
    expect(() => store.readPage(pageId)).toThrow(/checksum mismatch/)
  })

  it('returns an independent copy so callers cannot corrupt stored pages', () => {
    const store = new DiskPageStore(tempDir())
    const pageId = store.writePage(new TextEncoder().encode('data'))
    const first = store.readPage(pageId)
    first[0] = first[0]! ^ 0xff
    expect(new TextDecoder().decode(store.readPage(pageId))).toBe('data')
  })

  it('leaves no temp file behind after a write', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    store.writePage(new TextEncoder().encode('data'))
    const names = readdirSync(join(dir, 'pages'))
    expect(names.some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('rejects a page directory containing a non-page file', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    store.writePage(new TextEncoder().encode('a'))
    writeFileSync(join(dir, 'pages', 'notes.txt'), 'not a page')
    expect(() => new DiskPageStore(dir)).toThrow(/unexpected file in page directory/)
  })

  it('rejects a corrupt watermark file', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    store.writePage(new TextEncoder().encode('a'))
    writeFileSync(join(dir, 'meta.json'), 'not json')
    expect(() => new DiskPageStore(dir)).toThrow(/corrupt page watermark file/)
  })

  it('rejects a watermark file with a non-safe-integer nextPageId', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    store.writePage(new TextEncoder().encode('a'))
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ nextPageId: 1.5 }))
    expect(() => new DiskPageStore(dir)).toThrow(/non-negative safe-integer nextPageId/)
  })

  it('exposes its root directory', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    expect(store.directory).toBe(dir)
  })

  it('persists a fresh watermark after a write so ids stay retired', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    const first = store.writePage(new TextEncoder().encode('a'))
    const second = store.writePage(new TextEncoder().encode('b'))
    store.deletePage(first)
    // Fresh store without scanning the deleted file: the watermark alone must
    // keep page_2 retired.
    const rebuilt = new DiskPageStore(dir)
    expect(rebuilt.pageIds()).toEqual([second])
    const third = rebuilt.writePage(new TextEncoder().encode('c'))
    expect(third).toBe('page_2' as PageId)
  })

  it('persists a whole multi-page B+Tree across a rebuild', () => {
    // The engine's durable surface is exactly this: save the tree as one page
    // per node, reopen the store from disk, and load the same tree back.
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    let tree = SessionTree.empty()
    for (let n = 0; n < 20; n++) {
      tree = tree.append(`evt_${n}` as EventId, `blob_${n}` as BlobId)
    }
    const root = saveMultiPageTree(store, fromEntries(tree.entries()))
    const rebuilt = new DiskPageStore(dir)
    const loaded = loadMultiPageTree(rebuilt, root)
    expect(toArray(loaded).map(entry => entry.eventId)).toEqual(
      Array.from({ length: 20 }, (_, n) => `evt_${n}` as EventId),
    )
  })

  it('drives the engine end-to-end and keeps the tree after a store rebuild', () => {
    // The engine's `saveSession`/`loadSession` publish pages through the
    // injected store; a disk-backed store must survive the engine round-trip.
    // The session record (root page id, revision CAS) lives in the in-memory
    // SessionStore today, so a rebuild restores the pages but not the record;
    // the durable root pointer is the deferred part, and this test pins the
    // boundary: pages survive, the record does not.
    const dir = tempDir()
    const pages = new DiskPageStore(dir)
    const engine = new SessionFormatEngine(pages, new SessionStore())
    const file = makeSessionFile(3)
    const record = engine.saveSession(file)
    const loaded = engine.loadSession(file.session.sessionId)
    expect(loaded.entries.map(entry => entry.eventId)).toEqual(file.entries.map(entry => entry.eventId))
    // The root page id is the durable bridge: a rebuilt page store resolves it.
    const rebuiltPages = new DiskPageStore(dir)
    const tree = loadMultiPageTree(rebuiltPages, record.rootPage)
    expect(toArray(tree).map(entry => entry.eventId)).toEqual(file.entries.map(entry => entry.eventId))
    // The session record itself is not persisted yet: a fresh in-memory store
    // over the same directory cannot load the session by id.
    const rebuiltEngine = new SessionFormatEngine(rebuiltPages, new SessionStore())
    expect(() => rebuiltEngine.loadSession(file.session.sessionId)).toThrow(/session sess_disk not found/)
  })
})

function makeSessionFile(eventCount: number): SessionFile {
  let tree = SessionTree.empty()
  const blobs = new Map<BlobId, Uint8Array>()
  for (let n = 0; n < eventCount; n++) {
    const eventId = `evt_${n}` as EventId
    const blobId = `blob_${n}` as BlobId
    tree = tree.append(eventId, blobId)
    blobs.set(blobId, new TextEncoder().encode(JSON.stringify({ type: 'user/message', time: n, data: { marker: n }, surfaceOp: 'append' })))
  }
  const session: StoredSessionRecord = {
    sessionId: 'sess_disk' as SessionId,
    formatVersion: 1,
    rootPage: 'page_placeholder' as PageId,
    revision: 'rev-0' as SessionRevision,
    nextEventCounter: eventCount,
    backups: [],
  }
  return { session, entries: tree.entries(), blobs, references: [], compacted: [] }
}
