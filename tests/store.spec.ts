import { describe, expect, it } from 'vitest'
import { SessionStore } from '../src/store.ts'
import type { BlobId, EventId, PageId, SessionId, SessionRevision, StoredSessionRecord } from '../src/index.ts'

function record(revision: SessionRevision): StoredSessionRecord {
  return {
    sessionId: 'sess_1' as SessionId,
    formatVersion: 1,
    rootPage: 'page_1' as PageId,
    revision,
    nextEventCounter: 0,

    backups: [],
  }
}

describe('SessionStore', () => {
  it('commits a new root when revision matches and backs up the full generation', () => {
    const store = new SessionStore()
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

  it('rejects a stale commit', () => {
    const store = new SessionStore()
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
    const store = new SessionStore()
    store.putSession(record('rev-1' as SessionRevision))
    expect(store.commit(
      'sess_1' as SessionId,
      { ...record('rev-1' as SessionRevision), rootPage: 'page_2' as PageId },
      'rev-1' as SessionRevision,
    )).toBe(false)
    expect(store.getSession('sess_1' as SessionId)!.rootPage).toBe('page_1')
  })

  it('trims over-cap backups imported via putSession', () => {
    const store = new SessionStore(2)
    store.putSession({
      ...record('rev-1' as SessionRevision),
      backups: [
        { rootPage: 'page_a' as PageId },
        { rootPage: 'page_b' as PageId },
        { rootPage: 'page_c' as PageId },
      ],
    })
    expect(store.getSession('sess_1' as SessionId)!.backups.map(b => b.rootPage)).toEqual(['page_b', 'page_c'])
  })

  it('rejects a putSession with an unsafe initial event counter', () => {
    const store = new SessionStore()
    expect(() => { store.putSession({ ...record('rev-1' as SessionRevision), nextEventCounter: Number.NaN }) })
      .toThrow(/nextEventCounter must be a non-negative safe integer/)
    expect(() => { store.putSession({ ...record('rev-1' as SessionRevision), nextEventCounter: -1 }) })
      .toThrow(/nextEventCounter must be a non-negative safe integer/)
  })

  it('rejects a commit carrying a NaN event counter', () => {
    const store = new SessionStore()
    store.putSession(record('rev-1' as SessionRevision))
    expect(store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), rootPage: 'page_2' as PageId, nextEventCounter: Number.NaN },
      'rev-1' as SessionRevision,
    )).toBe(false)
  })

  it('rejects overwriting an existing session via putSession', () => {
    const store = new SessionStore()
    store.putSession(record('rev-1' as SessionRevision))
    expect(() => { store.putSession(record('rev-2' as SessionRevision)) })
      .toThrow(/already registered/)
    expect(store.getSession('sess_1' as SessionId)!.revision).toBe('rev-1')
  })

  it('rejects a commit that lowers the event counter', () => {
    const store = new SessionStore()
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

  it('rejects ABA revision reuse', () => {
    const store = new SessionStore()
    store.putSession(record('rev-A' as SessionRevision))
    expect(store.commit(
      'sess_1' as SessionId,
      { ...record('rev-B' as SessionRevision), rootPage: 'page_2' as PageId },
      'rev-A' as SessionRevision,
    )).toBe(true)
    expect(store.commit(
      'sess_1' as SessionId,
      { ...record('rev-A' as SessionRevision), rootPage: 'page_3' as PageId },
      'rev-B' as SessionRevision,
    )).toBe(false)
    expect(store.getSession('sess_1' as SessionId)!.rootPage).toBe('page_2')
  })

  it('rejects a commit for an unknown session', () => {
    const store = new SessionStore()
    expect(store.commit(
      'sess_unknown' as SessionId,
      record('rev-1' as SessionRevision),
      'rev-0' as SessionRevision,
    )).toBe(false)
  })

  it('keeps a bounded rolling backup of full generations', () => {
    const store = new SessionStore(2)
    store.putSession(record('rev-0' as SessionRevision))
    for (let i = 1; i <= 4; i++) {
      store.commit(
        'sess_1' as SessionId,
        { ...record(`rev-${i}` as SessionRevision), rootPage: `page_${i + 1}` as PageId },
        `rev-${i - 1}` as SessionRevision,
      )
    }
    const next = store.getSession('sess_1' as SessionId)!
    expect(next.backups.map(backup => backup.rootPage)).toEqual(['page_3', 'page_4'])
  })

  it('returns undefined for an unknown session and lists registered sessions', () => {
    const store = new SessionStore()
    expect(store.getSession('sess_unknown' as SessionId)).toBeUndefined()
    store.putSession(record('rev-1' as SessionRevision))
    store.putSession({ ...record('rev-1' as SessionRevision), sessionId: 'sess_2' as SessionId })
    expect(store.sessions().map(session => session.sessionId)).toEqual(['sess_1', 'sess_2'])
  })

  it('stores a defensive copy on putSession', () => {
    const store = new SessionStore()
    const input = record('rev-1' as SessionRevision)
    store.putSession(input)
    ;(input as { rootPage: PageId }).rootPage = 'page_mutated' as PageId
    ;(input.backups as unknown as unknown[]).push({ rootPage: 'page_x' as PageId })
    expect(store.getSession('sess_1' as SessionId)!.rootPage).toBe('page_1')
    expect(store.getSession('sess_1' as SessionId)!.backups).toEqual([])
  })

  it('rejects a commit whose record carries a different session id', () => {
    const store = new SessionStore()
    store.putSession(record('rev-1' as SessionRevision))
    expect(store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), sessionId: 'sess_other' as SessionId, rootPage: 'page_2' as PageId },
      'rev-1' as SessionRevision,
    )).toBe(false)
  })

  it('backs up the compacted page of the previous generation', () => {
    const store = new SessionStore()
    store.putSession({ ...record('rev-1' as SessionRevision), compactedPage: 'page_compacted' as PageId })
    store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), rootPage: 'page_2' as PageId },
      'rev-1' as SessionRevision,
    )
    expect(store.getSession('sess_1' as SessionId)!.backups[0]?.compactedPage).toBe('page_compacted')
  })

  it('trims an over-cap backup list imported via putSession', () => {
    const store = new SessionStore(2)
    const overCap = {
      ...record('rev-1' as SessionRevision),
      nextEventCounter: 0,

      backups: [
        { rootPage: 'page_a' as PageId },
        { rootPage: 'page_b' as PageId },
        { rootPage: 'page_c' as PageId },
      ],
    }
    store.putSession(overCap)
    store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), rootPage: 'page_2' as PageId },
      'rev-1' as SessionRevision,
    )
    expect(store.getSession('sess_1' as SessionId)!.backups.map(backup => backup.rootPage)).toEqual(['page_c', 'page_1'])
  })

  it('keeps no backups when the cap is zero', () => {
    const store = new SessionStore(0)
    store.putSession(record('rev-1' as SessionRevision))
    store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), rootPage: 'page_2' as PageId },
      'rev-1' as SessionRevision,
    )
    expect(store.getSession('sess_1' as SessionId)!.backups).toEqual([])
  })

  it('backs up the previous generation seed boundary', () => {
    const store = new SessionStore()
    store.putSession({ ...record('rev-1' as SessionRevision), seedBoundaryId: 'evt_1' as EventId })
    store.commit(
      'sess_1' as SessionId,
      { ...record('rev-2' as SessionRevision), rootPage: 'page_2' as PageId },
      'rev-1' as SessionRevision,
    )
    expect(store.getSession('sess_1' as SessionId)!.backups[0]?.seedBoundaryId).toBe('evt_1')
  })

  it('returns defensive copies from reads', () => {
    const store = new SessionStore()
    store.putSession(record('rev-1' as SessionRevision))
    const first = store.getSession('sess_1' as SessionId)!
    ;(first.backups as unknown as unknown[]).push('page_x')
    expect(store.getSession('sess_1' as SessionId)!.backups).toEqual([])
  })

  it('rejects a non-integer backup generation cap', () => {
    // A fractional cap would truncate the splice count and silently retain
    // more generations than configured; NaN would skip both trim branches and
    // grow backups without bound. The cap must be rejected at construction.
    expect(() => new SessionStore(1.5)).toThrow(/maxBackupGenerations must be a non-negative safe integer/)
    expect(() => new SessionStore(Number.NaN)).toThrow(/maxBackupGenerations must be a non-negative safe integer/)
    expect(() => new SessionStore(-1)).toThrow(/maxBackupGenerations must be a non-negative safe integer/)
  })

  it('rejects a commit that drops or rewrites an existing EventId binding', () => {
    // The binding table is monotonic: a commit that shrinks it or rebinds an
    // EventId would let a later update rewrite EventId history, so it must
    // fail the CAS.
    const store = new SessionStore()
    store.putSession({
      ...record('rev-1' as SessionRevision),
      usedEventBindings: new Map([['evt_1' as EventId, 'blob_1' as BlobId], ['evt_2' as EventId, 'blob_2' as BlobId]]),
    })
    // Dropping evt_1's binding.
    expect(store.commit(
      'sess_1' as SessionId,
      {
        ...record('rev-2' as SessionRevision),
        usedEventBindings: new Map([['evt_2' as EventId, 'blob_2' as BlobId]]),
      },
      'rev-1' as SessionRevision,
    )).toBe(false)
    // Rebinding evt_1.
    expect(store.commit(
      'sess_1' as SessionId,
      {
        ...record('rev-2' as SessionRevision),
        usedEventBindings: new Map([['evt_1' as EventId, 'blob_9' as BlobId], ['evt_2' as EventId, 'blob_2' as BlobId]]),
      },
      'rev-1' as SessionRevision,
    )).toBe(false)
  })
})
