import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiskSessionStore } from '../src/disk-session-store.ts'
import type { BlobId, EventId, PageId, SessionId, SessionRevision, StoredSessionRecord } from '../src/index.ts'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-disk-session-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function record(revision: SessionRevision, sessionId = 'sess_1' as SessionId): StoredSessionRecord {
  return {
    sessionId,
    formatVersion: 1,
    rootPage: 'page_1' as PageId,
    revision,
    nextEventCounter: 0,
    backups: [],
  }
}

describe('DiskSessionStore', () => {
  it('commits a new root when revision matches and backs up the full generation', () => {
    const store = new DiskSessionStore(tempDir())
    store.putSession(record('rev-1' as SessionRevision))
    const ok = store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), rootPage: 'page_2' as PageId },
      'rev-1' as SessionRevision,
    )
    expect(ok).toBe(true)
    const next = store.getSession('sess_1' as SessionId)!
    expect(next.rootPage).toBe('page_2')
    expect(next.revision).toBe('rev-2')
    expect(next.backups).toHaveLength(1)
    expect(next.backups[0]?.rootPage).toBe('page_1')
  })

  it('rebuilds every session record and used revision from disk', () => {
    const dir = tempDir()
    const store = new DiskSessionStore(dir)
    store.putSession(record('rev-1' as SessionRevision, 'sess_a' as SessionId))
    store.putSession(record('rev-1' as SessionRevision, 'sess_b' as SessionId))
    store.commit(
      'sess_a' as SessionId,
      { ...record('rev-2' as SessionRevision, 'sess_a' as SessionId), rootPage: 'page_2' as PageId },
      'rev-1' as SessionRevision,
    )
    const rebuilt = new DiskSessionStore(dir)
    expect(rebuilt.sessions().map(s => s.sessionId).sort()).toEqual(['sess_a', 'sess_b'])
    const sessA = rebuilt.getSession('sess_a' as SessionId)!
    expect(sessA.revision).toBe('rev-2')
    expect(sessA.rootPage).toBe('page_2')
    expect(sessA.backups.map(b => b.rootPage)).toEqual(['page_1'])
  })

  it('keeps the ABA guard across a rebuild', () => {
    // The used-revision set is persisted with the record, so a revision
    // retired by an earlier generation is never reissued after a restart.
    const dir = tempDir()
    const store = new DiskSessionStore(dir)
    store.putSession(record('rev-A' as SessionRevision))
    expect(store.commit(
      'sess_1' as SessionId,
      { ...record('rev-B' as SessionRevision), rootPage: 'page_2' as PageId },
      'rev-A' as SessionRevision,
    )).toBe(true)
    const rebuilt = new DiskSessionStore(dir)
    // A -> B -> A reuse attempt must lose even though rev-A is long gone.
    expect(rebuilt.commit(
      'sess_1' as SessionId,
      { ...record('rev-A' as SessionRevision), rootPage: 'page_3' as PageId },
      'rev-B' as SessionRevision,
    )).toBe(false)
  })

  it('rejects a stale commit', () => {
    const store = new DiskSessionStore(tempDir())
    store.putSession(record('rev-2' as SessionRevision))
    const ok = store.commit(
      'sess_1' as SessionId,
      { ...record('rev-3' as SessionRevision), rootPage: 'page_3' as PageId },
      'rev-1' as SessionRevision,
    )
    expect(ok).toBe(false)
    expect(store.getSession('sess_1' as SessionId)!.rootPage).toBe('page_1')
  })

  it('rejects a commit that does not advance the revision', () => {
    const store = new DiskSessionStore(tempDir())
    store.putSession(record('rev-1' as SessionRevision))
    expect(store.commit(
      'sess_1' as SessionId,
      { ...record('rev-1' as SessionRevision), rootPage: 'page_2' as PageId },
      'rev-1' as SessionRevision,
    )).toBe(false)
  })

  it('trims over-cap backups imported via putSession', () => {
    const dir = tempDir()
    const store = new DiskSessionStore(dir, 2)
    store.putSession({
      ...record('rev-1' as SessionRevision),
      backups: [
        { rootPage: 'page_a' as PageId },
        { rootPage: 'page_b' as PageId },
        { rootPage: 'page_c' as PageId },
      ],
    })
    expect(store.getSession('sess_1' as SessionId)!.backups.map(b => b.rootPage)).toEqual(['page_b', 'page_c'])
    // The trimmed list is what lands on disk.
    const rebuilt = new DiskSessionStore(dir, 2)
    expect(rebuilt.getSession('sess_1' as SessionId)!.backups.map(b => b.rootPage)).toEqual(['page_b', 'page_c'])
  })

  it('rejects a putSession with an unsafe initial event counter', () => {
    const store = new DiskSessionStore(tempDir())
    expect(() => { store.putSession({ ...record('rev-1' as SessionRevision), nextEventCounter: Number.NaN }) })
      .toThrow(/nextEventCounter must be a non-negative safe integer/)
    expect(() => { store.putSession({ ...record('rev-1' as SessionRevision), nextEventCounter: -1 }) })
      .toThrow(/nextEventCounter must be a non-negative safe integer/)
  })

  it('rejects a commit carrying a NaN event counter', () => {
    const store = new DiskSessionStore(tempDir())
    store.putSession(record('rev-1' as SessionRevision))
    expect(store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), rootPage: 'page_2' as PageId, nextEventCounter: Number.NaN },
      'rev-1' as SessionRevision,
    )).toBe(false)
  })

  it('rejects overwriting an existing session via putSession', () => {
    const store = new DiskSessionStore(tempDir())
    store.putSession(record('rev-1' as SessionRevision))
    expect(() => { store.putSession(record('rev-2' as SessionRevision)) })
      .toThrow(/already registered/)
  })

  it('rejects a commit that lowers the event counter', () => {
    const store = new DiskSessionStore(tempDir())
    store.putSession({ ...record('rev-1' as SessionRevision), nextEventCounter: 10 })
    expect(store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), rootPage: 'page_2' as PageId, nextEventCounter: 1 },
      'rev-1' as SessionRevision,
    )).toBe(false)
    expect(store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), rootPage: 'page_2' as PageId, nextEventCounter: 11 },
      'rev-1' as SessionRevision,
    )).toBe(true)
  })

  it('rejects a commit for an unknown session', () => {
    const store = new DiskSessionStore(tempDir())
    expect(store.commit(
      'sess_1' as SessionId,
      record('rev-2' as SessionRevision),
      'rev-1' as SessionRevision,
    )).toBe(false)
  })

  it('rejects a commit whose record carries a different session id', () => {
    const store = new DiskSessionStore(tempDir())
    store.putSession(record('rev-1' as SessionRevision))
    expect(store.commit(
      'sess_1' as SessionId,
      record('rev-2' as SessionRevision, 'sess_other' as SessionId),
      'rev-1' as SessionRevision,
    )).toBe(false)
  })

  it('rejects a commit that rebinds a used EventId', () => {
    const store = new DiskSessionStore(tempDir())
    const bindings = new Map<EventId, BlobId>([['evt_1' as EventId, 'blob_a' as BlobId]])
    store.putSession({ ...record('rev-1' as SessionRevision), usedEventBindings: bindings })
    const conflicting = new Map<EventId, BlobId>([['evt_1' as EventId, 'blob_b' as BlobId]])
    expect(store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), usedEventBindings: conflicting },
      'rev-1' as SessionRevision,
    )).toBe(false)
    // A superset that keeps the binding is accepted.
    const superset = new Map<EventId, BlobId>([
      ['evt_1' as EventId, 'blob_a' as BlobId],
      ['evt_2' as EventId, 'blob_b' as BlobId],
    ])
    expect(store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), usedEventBindings: superset },
      'rev-1' as SessionRevision,
    )).toBe(true)
  })

  it('round-trips usedEventBindings through disk', () => {
    const dir = tempDir()
    const store = new DiskSessionStore(dir)
    const bindings = new Map<EventId, BlobId>([
      ['evt_1' as EventId, 'blob_a' as BlobId],
      ['evt_2' as EventId, 'blob_b' as BlobId],
    ])
    store.putSession({ ...record('rev-1' as SessionRevision), usedEventBindings: bindings })
    const rebuilt = new DiskSessionStore(dir)
    expect([...rebuilt.getSession('sess_1' as SessionId)!.usedEventBindings!]).toEqual([...bindings])
  })

  it('stores a defensive copy on putSession', () => {
    const store = new DiskSessionStore(tempDir())
    const original = record('rev-1' as SessionRevision)
    store.putSession(original)
    original.rootPage = 'page_hacked' as PageId
    expect(store.getSession('sess_1' as SessionId)!.rootPage).toBe('page_1')
  })

  it('returns undefined for an unknown session and lists registered sessions', () => {
    const store = new DiskSessionStore(tempDir())
    expect(store.getSession('sess_none' as SessionId)).toBeUndefined()
    store.putSession(record('rev-1' as SessionRevision, 'sess_x' as SessionId))
    expect(store.sessions().map(s => s.sessionId)).toEqual(['sess_x'])
  })

  it('rejects a corrupt record file on rebuild', () => {
    const dir = tempDir()
    const store = new DiskSessionStore(dir)
    store.putSession(record('rev-1' as SessionRevision))
    writeFileSync(join(dir, 'records', 'sess_1.json'), 'not json')
    expect(() => new DiskSessionStore(dir)).toThrow(/corrupt session record file/)
  })

  it('rejects a record file missing a record object on rebuild', () => {
    const dir = tempDir()
    const store = new DiskSessionStore(dir)
    store.putSession(record('rev-1' as SessionRevision))
    writeFileSync(join(dir, 'records', 'sess_1.json'), JSON.stringify({ usedRevisions: ['rev-1'] }))
    expect(() => new DiskSessionStore(dir)).toThrow(/must carry a record object/)
  })

  it('rejects a record file with a non-string sessionId on rebuild', () => {
    const dir = tempDir()
    const store = new DiskSessionStore(dir)
    store.putSession(record('rev-1' as SessionRevision))
    const raw = JSON.parse(readFileSync(join(dir, 'records', 'sess_1.json'), 'utf8')) as Record<string, unknown>
    const recordRaw = raw.record as Record<string, unknown>
    recordRaw.sessionId = 42
    writeFileSync(join(dir, 'records', 'sess_1.json'), JSON.stringify(raw))
    expect(() => new DiskSessionStore(dir)).toThrow(/must carry a string sessionId/)
  })

  it('rejects a record file with a missing usedRevisions array on rebuild', () => {
    const dir = tempDir()
    const store = new DiskSessionStore(dir)
    store.putSession(record('rev-1' as SessionRevision))
    const raw = JSON.parse(readFileSync(join(dir, 'records', 'sess_1.json'), 'utf8')) as Record<string, unknown>
    delete raw.usedRevisions
    writeFileSync(join(dir, 'records', 'sess_1.json'), JSON.stringify(raw))
    expect(() => new DiskSessionStore(dir)).toThrow(/must carry a usedRevisions string array/)
  })

  it('rejects a record file with malformed bindings on rebuild', () => {
    const dir = tempDir()
    const store = new DiskSessionStore(dir)
    store.putSession(record('rev-1' as SessionRevision))
    const raw = JSON.parse(readFileSync(join(dir, 'records', 'sess_1.json'), 'utf8')) as Record<string, unknown>
    const recordRaw = raw.record as Record<string, unknown>
    recordRaw.usedEventBindings = [[1, 2]]
    writeFileSync(join(dir, 'records', 'sess_1.json'), JSON.stringify(raw))
    expect(() => new DiskSessionStore(dir)).toThrow(/must carry a binding pair array/)
  })

  it('rejects a record directory containing a non-record file', () => {
    const dir = tempDir()
    const store = new DiskSessionStore(dir)
    store.putSession(record('rev-1' as SessionRevision))
    writeFileSync(join(dir, 'records', 'notes.txt'), 'not a record')
    expect(() => new DiskSessionStore(dir)).toThrow(/unexpected file in session record directory/)
  })

  it('rejects a duplicate session record across files on rebuild', () => {
    const dir = tempDir()
    const store = new DiskSessionStore(dir)
    store.putSession(record('rev-1' as SessionRevision))
    // A second file carrying the same session id must be rejected, not merged.
    writeFileSync(join(dir, 'records', 'sess_dup.json'), readFileSync(join(dir, 'records', 'sess_1.json')))
    expect(() => new DiskSessionStore(dir)).toThrow(/duplicate session record/)
  })

  it('exposes its root directory', () => {
    const dir = tempDir()
    const store = new DiskSessionStore(dir)
    expect(store.directory).toBe(dir)
  })

  it('leaves no temp file behind after a commit', () => {
    const dir = tempDir()
    const store = new DiskSessionStore(dir)
    store.putSession(record('rev-1' as SessionRevision))
    store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), rootPage: 'page_2' as PageId },
      'rev-1' as SessionRevision,
    )
    const names = readdirSync(join(dir, 'records'))
    expect(names.some(name => name.endsWith('.tmp'))).toBe(false)
  })
})
