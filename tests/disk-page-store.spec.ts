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
import { DiskSessionStore } from '../src/disk-session-store.ts'
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
    store.flush()
    // Physical reclamation happens at the segment compaction (the GC entry
    // point): retain drops the unreachable page and rewrites the segment, so a
    // rebuild no longer revives it.
    expect(store.retain(new Set([second]))).toBe(1)
    const rebuilt = new DiskPageStore(dir)
    const third = rebuilt.writePage(new TextEncoder().encode('c'))
    expect(third).not.toBe(first)
    expect(third).not.toBe(second)
    expect(() => rebuilt.readPage(first)).toThrow(/missing page/)
    expect(new TextDecoder().decode(rebuilt.readPage(third))).toBe('c')
  })

  it('does not let a missing watermark file lower the next id below scanned pages', () => {
    // A crash between a flush and the segment's next write leaves the pages on
    // disk with no meta.json; the rebuild must resume past the scanned maximum
    // instead of reusing the orphaned page id.
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    const pageId = store.writePage(new TextEncoder().encode('a'))
    store.flush()
    // Simulate the crash window: page bytes present, watermark file absent.
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
    store.flush()
    // A page appended to the segment behind the store's back (watermark stale)
    // must not be overwritten: the rebuild decodes it and advances past it.
    const manual = encodePage('page_3' as PageId, new TextEncoder().encode('manual'))
    const entry = new Uint8Array(4 + manual.length)
    new DataView(entry.buffer).setUint32(0, manual.length, false)
    entry.set(manual, 4)
    writeFileSync(join(dir, 'pages.bin'), entry, { flag: 'a' })
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

  it('rejects a corrupt segment entry inside the watermark', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    store.writePage(new TextEncoder().encode('data'))
    store.flush()
    // Corrupt one byte of the flushed segment: the rebuild must fail loud
    // instead of silently dropping the page.
    const path = join(dir, 'pages.bin')
    const bytes = readFileSync(path)
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    writeFileSync(path, bytes)
    expect(() => new DiskPageStore(dir)).toThrow(/corrupt page container/)
  })

  it('returns an independent copy so callers cannot corrupt stored pages', () => {
    const store = new DiskPageStore(tempDir())
    const pageId = store.writePage(new TextEncoder().encode('data'))
    const first = store.readPage(pageId)
    first[0] = first[0]! ^ 0xff
    expect(new TextDecoder().decode(store.readPage(pageId))).toBe('data')
  })

  it('leaves no temp file behind after a write and flush', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    store.writePage(new TextEncoder().encode('data'))
    store.flush()
    const names = readdirSync(dir)
    expect(names.some(name => name.endsWith('.tmp'))).toBe(false)
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
    store.flush()
    store.deletePage(first)
    store.retain(new Set([second]))
    // The persisted next-id watermark alone must keep page_2 retired.
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

  it('restarts the full engine stack from disk with both durable stores', () => {
    // The complete durable restart path: pages and session records both live
    // on disk, so a fresh engine over the same directory restores the session
    // by id — the boundary the in-memory store pins above.
    const dir = tempDir()
    const engine = new SessionFormatEngine(new DiskPageStore(dir), new DiskSessionStore(dir))
    const file = makeSessionFile(5)
    engine.saveSession(file)
    const restarted = new SessionFormatEngine(new DiskPageStore(dir), new DiskSessionStore(dir))
    const reloaded = restarted.loadSession(file.session.sessionId)
    expect(reloaded.entries.map(entry => entry.eventId)).toEqual(file.entries.map(entry => entry.eventId))
    expect(reloaded.blobs.size).toBe(file.blobs.size)
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

describe('segment file layout', () => {
  it('recovers pages written but not flushed when rebuilding in-process', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    const a = store.writePage(new TextEncoder().encode('a'))
    const b = store.writePage(new TextEncoder().encode('b'))
    // Unflushed pages are already in the segment (kernel cache), so an
    // in-process rebuild over the same directory recovers them.
    const rebuilt = new DiskPageStore(dir)
    expect(new TextDecoder().decode(rebuilt.readPage(a))).toBe('a')
    expect(new TextDecoder().decode(rebuilt.readPage(b))).toBe('b')
  })

  it('covers every page written since the last flush in one flush', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    const a = store.writePage(new TextEncoder().encode('a'))
    const b = store.writePage(new TextEncoder().encode('b'))
    store.flush()
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { watermark: number }
    const size = readFileSync(join(dir, 'pages.bin')).length
    expect(size).toBe(meta.watermark)
    const rebuilt = new DiskPageStore(dir)
    expect(rebuilt.pageIds()).toEqual([a, b])
  })

  it('truncates undecodable residue past the watermark', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    store.writePage(new TextEncoder().encode('a'))
    store.flush()
    // Residue: a length header claiming 100 bytes with only 3 following.
    writeFileSync(join(dir, 'pages.bin'), Buffer.from([0, 0, 0, 100, 1, 2, 3]), { flag: 'a' })
    const rebuilt = new DiskPageStore(dir)
    expect(rebuilt.pageIds()).toEqual(['page_0' as PageId])
    const size = readFileSync(join(dir, 'pages.bin')).length
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { watermark: number }
    expect(size).toBe(meta.watermark)
  })

  it('compacts the segment to the retained pages', () => {
    const dir = tempDir()
    const store = new DiskPageStore(dir)
    const a = store.writePage(new TextEncoder().encode('a'))
    const b = store.writePage(new TextEncoder().encode('b'))
    const c = store.writePage(new TextEncoder().encode('c'))
    store.flush()
    const before = readFileSync(join(dir, 'pages.bin')).length
    expect(store.retain(new Set([a, c]))).toBe(1)
    const after = readFileSync(join(dir, 'pages.bin')).length
    expect(after).toBeLessThan(before)
    expect(store.pageIds()).toEqual([a, c])
    expect(() => store.readPage(b)).toThrow(/missing page/)
  })
})
