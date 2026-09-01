/**
 * Durable session store: one JSON record file per session under a directory,
 * written atomically with the revision compare-and-swap. The synchronous
 * surface mirrors the in-memory {@link SessionStore} so the engine and
 * repository can switch backends without an async rewrite.
 *
 * Each record file persists the {@link StoredSessionRecord} together with the
 * session's used-revision set: the ABA guard survives a rebuild, so a revision
 * retired by an earlier generation is never reissued after a restart (the
 * in-memory store loses that history — see the Known Limitations note).
 * @module @deepseek-ai/dsh-session-format/disk-session-store
 */

import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicDurableSync } from './atomic-write-sync.ts'
import type { BlobId, EventId, PageId, SessionId, SessionRevision, StoredSessionBackup, StoredSessionRecord } from './index.ts'

/** Default number of old roots retained as rolling backups. */
export const DEFAULT_MAX_BACKUP_GENERATIONS = 3

const RECORDS_DIR = 'records'
const RECORD_FILE_SUFFIX = '.json'
const BINDINGS_DIR = 'bindings'
const BINDINGS_FILE_SUFFIX = '.log'

/** One persisted per-session file: the record plus its used-revision ABA set.
 * `legacyBindings` carries a binding table embedded in a pre-binding-log
 * record file, merged into the binding log on load.
 */
interface PersistedSession {
  readonly record: StoredSessionRecord
  readonly usedRevisions: readonly SessionRevision[]
  readonly legacyBindings?: ReadonlyMap<EventId, BlobId>
}

/** Serialize a record into a JSON-safe shape, expanding the binding map. */
function serializeRecord(record: StoredSessionRecord): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    sessionId: record.sessionId,
    formatVersion: record.formatVersion,
    rootPage: record.rootPage,
    revision: record.revision,
    nextEventCounter: record.nextEventCounter,
    backups: record.backups.map(copyBackup),
    ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
    ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
    ...(record.parentSession === undefined ? {} : { parentSession: record.parentSession }),
    ...(record.origin === undefined ? {} : { origin: record.origin }),
    ...(record.delegationDepth === undefined ? {} : { delegationDepth: record.delegationDepth }),
    ...(record.agentPreset === undefined ? {} : { agentPreset: record.agentPreset }),
    ...(record.seedBoundaryId === undefined ? {} : { seedBoundaryId: record.seedBoundaryId }),
    ...(record.blobMapPage === undefined ? {} : { blobMapPage: record.blobMapPage }),
    ...(record.referencesPage === undefined ? {} : { referencesPage: record.referencesPage }),
    ...(record.compactedPage === undefined ? {} : { compactedPage: record.compactedPage }),
    ...(record.blobIdWatermark === undefined ? {} : { blobIdWatermark: record.blobIdWatermark }),
    // usedEventBindings is not embedded in the record file: the binding table
    // lives in the per-session binding log so record writes stay O(1) (an
    // append writes one log line instead of the whole table).
  }
  return serialized
}

/** Parse a persisted record file, validating every field the store depends on.
 * @param path - record file path (for error messages).
 * @param raw - file content.
 * @returns the parsed persisted session.
 */
function parsePersistedSession(path: string, raw: string): PersistedSession {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`corrupt session record file ${path}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`corrupt session record file ${path}`)
  }
  const record = (parsed as { readonly record?: unknown }).record
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new Error(`session record file ${path} must carry a record object`)
  }
  const recordFields = record as Record<string, unknown>
  if (typeof recordFields.sessionId !== 'string') {
    throw new Error(`session record file ${path} must carry a string sessionId`)
  }
  if (typeof recordFields.formatVersion !== 'number' || !Number.isSafeInteger(recordFields.formatVersion)) {
    throw new Error(`session record file ${path} must carry an integer formatVersion`)
  }
  if (typeof recordFields.rootPage !== 'string' || typeof recordFields.revision !== 'string') {
    throw new Error(`session record file ${path} must carry string rootPage and revision`)
  }
  const nextEventCounter = recordFields.nextEventCounter
  if (typeof nextEventCounter !== 'number' || !Number.isSafeInteger(nextEventCounter) || nextEventCounter < 0) {
    throw new Error(`session record file ${path} must carry a non-negative safe-integer nextEventCounter`)
  }
  const backups = recordFields.backups
  if (!Array.isArray(backups) || backups.some(backup => !isBackup(backup))) {
    throw new Error(`session record file ${path} must carry a backup array`)
  }
  const usedRevisions = (parsed as { readonly usedRevisions?: unknown }).usedRevisions
  if (!Array.isArray(usedRevisions) || usedRevisions.some(revision => typeof revision !== 'string')) {
    throw new Error(`session record file ${path} must carry a usedRevisions string array`)
  }
  const usedEventBindingsRaw = recordFields.usedEventBindings
  let legacyBindings: ReadonlyMap<EventId, BlobId> | undefined
  if (usedEventBindingsRaw !== undefined) {
    if (!Array.isArray(usedEventBindingsRaw)
      || usedEventBindingsRaw.some(pair => !Array.isArray(pair) || pair.length !== 2
        || typeof pair[0] !== 'string' || typeof pair[1] !== 'string')) {
      throw new Error(`session record file ${path} must carry a binding pair array`)
    }
    legacyBindings = new Map(usedEventBindingsRaw.map((pair: unknown[]) => [pair[0], pair[1]] as [EventId, BlobId]))
  }
  const parsedRecord: StoredSessionRecord = {
    sessionId: recordFields.sessionId as SessionId,
    formatVersion: recordFields.formatVersion as number,
    rootPage: recordFields.rootPage as PageId,
    revision: recordFields.revision as SessionRevision,
    nextEventCounter: nextEventCounter as number,
    backups: backups as StoredSessionBackup[],
    ...optionalStringField(recordFields, path, 'cwd'),
    ...optionalStringField(recordFields, path, 'parentSession'),
    ...optionalStringField(recordFields, path, 'origin'),
    ...optionalStringField(recordFields, path, 'agentPreset'),
    ...optionalStringField(recordFields, path, 'seedBoundaryId'),
    ...optionalStringField(recordFields, path, 'blobMapPage'),
    ...optionalStringField(recordFields, path, 'referencesPage'),
    ...optionalStringField(recordFields, path, 'compactedPage'),
    ...optionalNumberField(recordFields, path, 'createdAt'),
    ...optionalNumberField(recordFields, path, 'delegationDepth'),
    ...optionalNumberField(recordFields, path, 'blobIdWatermark'),
  }
  return {
    record: parsedRecord,
    usedRevisions: usedRevisions as SessionRevision[],
    ...(legacyBindings === undefined ? {} : { legacyBindings }),
  }
}

/** Read one optional string-valued record field, validating its type.
 * @param fields - parsed record fields.
 * @param path - record file path (for error messages).
 * @param name - field name.
 * @returns the field object, or an empty object when the field is absent.
 */
function optionalStringField(
  fields: Record<string, unknown>,
  path: string,
  name: string,
): Record<string, string> {
  const value = fields[name]
  if (value === undefined) return {}
  if (typeof value !== 'string') {
    throw new Error(`session record file ${path} must carry a string ${name}`)
  }
  return { [name]: value }
}

/** Read one optional number-valued record field, validating its type.
 * @param fields - parsed record fields.
 * @param path - record file path (for error messages).
 * @param name - field name.
 * @returns the field object, or an empty object when the field is absent.
 */
function optionalNumberField(
  fields: Record<string, unknown>,
  path: string,
  name: string,
): Record<string, number> {
  const value = fields[name]
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`session record file ${path} must carry a safe-integer ${name}`)
  }
  return { [name]: value }
}

function isBackup(value: unknown): value is StoredSessionBackup {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const backup = value as Record<string, unknown>
  return typeof backup.rootPage === 'string'
    && (backup.blobMapPage === undefined || typeof backup.blobMapPage === 'string')
    && (backup.referencesPage === undefined || typeof backup.referencesPage === 'string')
    && (backup.compactedPage === undefined || typeof backup.compactedPage === 'string')
    && (backup.seedBoundaryId === undefined || typeof backup.seedBoundaryId === 'string')
}

function copyBackup(backup: StoredSessionBackup): StoredSessionBackup {
  return { ...backup }
}

function copyRecord(record: StoredSessionRecord): StoredSessionRecord {
  return {
    ...record,
    ...(record.usedEventBindings === undefined ? {} : { usedEventBindings: new Map(record.usedEventBindings) }),
    backups: record.backups.map(copyBackup),
  }
}

/**
 * A session store persisted as one JSON file per session under a directory,
 * with revision compare-and-swap and rolling backups. Every mutation — the
 * create-only registration and the CAS commit — writes the record and its
 * used-revision set in one atomic fsynced file replacement, so a crash leaves
 * either the previous generation or the complete next one, never a partial
 * record. A rebuilt store scans the directory and restores every record and
 * the full used-revision history, which keeps the ABA guard effective across
 * restarts.
 */
export class DiskSessionStore {
  private readonly rootDir: string
  private readonly recordsDir: string
  private readonly bindingsDir: string
  private readonly records = new Map<SessionId, StoredSessionRecord>()
  private readonly usedRevisions = new Map<SessionId, Set<SessionRevision>>()
  /** The session's used-bindings table, rebuilt from the binding log at open
   * and extended incrementally on commit, so append stays O(log n) instead of
   * rewriting the table into the record file. */
  private readonly bindings = new Map<SessionId, Map<EventId, BlobId>>()

  /**
   * Open (or create) a session store rooted at `rootDir`. Existing record
   * files are scanned and every session's record and used-revision set is
   * restored.
   * @param rootDir - directory owning `records/`.
   * @param maxBackupGenerations - cap on rolling backups retained per commit.
   */
  constructor(
    rootDir: string,
    private readonly maxBackupGenerations = DEFAULT_MAX_BACKUP_GENERATIONS,
  ) {
    if (!Number.isSafeInteger(maxBackupGenerations) || maxBackupGenerations < 0) {
      throw new Error('maxBackupGenerations must be a non-negative safe integer')
    }
    this.rootDir = rootDir
    this.recordsDir = join(rootDir, RECORDS_DIR)
    this.bindingsDir = join(rootDir, BINDINGS_DIR)
    mkdirSync(this.recordsDir, { recursive: true })
    mkdirSync(this.bindingsDir, { recursive: true })
    for (const name of readdirSync(this.recordsDir)) {
      if (!name.endsWith(RECORD_FILE_SUFFIX)) {
        throw new Error(`unexpected file in session record directory: ${name}`)
      }
      const path = join(this.recordsDir, name)
      const persisted = parsePersistedSession(path, readFileSync(path, 'utf8'))
      const sessionId = persisted.record.sessionId
      if (this.records.has(sessionId)) {
        throw new Error(`duplicate session record for ${sessionId}`)
      }
      // The binding table is restored from the append-only binding log; a
      // pre-binding-log record file may still embed the table, which is merged
      // in and persisted to the log on the first write.
      const bindings = readBindings(this.bindingPath(sessionId))
      for (const [eventId, blobId] of persisted.legacyBindings ?? []) {
        if (!bindings.has(eventId)) bindings.set(eventId, blobId)
      }
      const { usedEventBindings: _legacy, ...rest } = persisted.record
      this.records.set(sessionId, copyRecord(rest))
      this.bindings.set(sessionId, bindings)
      this.usedRevisions.set(sessionId, new Set(persisted.usedRevisions))
    }
  }

  /** Register a session record. Create-only: it fails when a record already
   * exists for the session, so existing records can only change through the
   * compare-and-swap commit.
   * @param record - session record to store.
   */
  putSession(record: StoredSessionRecord): void {
    if (this.records.has(record.sessionId)) {
      throw new Error(`session ${record.sessionId} already registered`)
    }
    if (!Number.isSafeInteger(record.nextEventCounter) || record.nextEventCounter < 0) {
      throw new Error('session nextEventCounter must be a non-negative safe integer')
    }
    const stored = copyRecord(record)
    const trimmed = trimBackups(stored.backups, this.maxBackupGenerations)
    const next: StoredSessionRecord = { ...stored, backups: trimmed }
    const used = new Set<SessionRevision>([record.revision])
    writePersisted(this.recordPath(record.sessionId), next, used)
    // Registration writes the whole binding table to the log atomically.
    writeBindings(this.bindingPath(record.sessionId), record.usedEventBindings ?? new Map())
    const { usedEventBindings: table, ...rest } = next
    this.records.set(record.sessionId, copyRecord(rest))
    this.bindings.set(record.sessionId, new Map(record.usedEventBindings ?? []))
    this.usedRevisions.set(record.sessionId, used)
  }

  /** Read a session record, or undefined when absent.
   * @param sessionId - session id to read.
   * @returns a defensive copy of the record, or undefined when absent.
   */
  getSession(sessionId: SessionId): StoredSessionRecord | undefined {
    const record = this.records.get(sessionId)
    if (record === undefined) return undefined
    const table = this.bindings.get(sessionId)
    return copyRecord(table === undefined ? record : { ...record, usedEventBindings: new Map(table) })
  }

  /** Read a session record without assembling its used-bindings table.
   * Append paths need only the control fields (root, revision, counters,
   * page pointers), so this read stays O(1) in the binding count.
   * @param sessionId - session id to read.
   * @returns the stored record without its binding table, or undefined when absent.
   */
  getRecord(sessionId: SessionId): StoredSessionRecord | undefined {
    const record = this.records.get(sessionId)
    return record === undefined ? undefined : copyRecord(record)
  }

  /** All session records currently registered.
   * @returns defensive copies of every registered record.
   */
  sessions(): StoredSessionRecord[] {
    return [...this.records.values()].map(copyRecord)
  }

  /** Commit a replacement record only when the expected revision still matches.
   * The full previous generation (every page pointer) is appended to the
   * rolling backups on success; this store is the sole owner of backup
   * bookkeeping. The record and the used-revision set are written to disk in
   * one atomic replacement before the in-memory state advances, so a failed
   * write leaves the previous generation authoritative.
   * @param sessionId - session to commit.
   * @param next - replacement record.
   * @param expectedRevision - revision the commit is compared against.
   * @returns true when the commit landed, false when the expected revision was stale.
   */
  commit(
    sessionId: SessionId,
    next: StoredSessionRecord,
    expectedRevision: SessionRevision,
    additionalBindings?: ReadonlyMap<EventId, BlobId>,
  ): boolean {
    const current = this.records.get(sessionId)
    const used = this.usedRevisions.get(sessionId)
    if (next.sessionId !== sessionId
      || current === undefined
      || used === undefined
      || current.revision !== expectedRevision
      || next.revision === expectedRevision
      // Rejecting any previously used revision stops A -> B -> A ABA reuse,
      // which would let an old snapshot commit again over newer state. The
      // set is persisted with the record, so the guard survives a rebuild.
      || used.has(next.revision)
      // The EventId counter is a monotonic high watermark; a commit that
      // lowers it (or carries a non-finite value, which NaN comparisons
      // would let through) would reuse ids already allocated or compacted.
      || !Number.isSafeInteger(next.nextEventCounter)
      || next.nextEventCounter < current.nextEventCounter
      // The EventId binding table is monotonic: every binding in the current
      // record must survive into the next with the same blob, or a commit
      // could silently rewrite EventId history and let a later rebind pass. An
      // incremental commit (additionalBindings present) appends to the table
      // and the binding log instead and only rejects a conflicting append.
      || (additionalBindings !== undefined
        ? !bindingsAppendable(this.bindings.get(sessionId), additionalBindings)
        : !bindingMonotonic(this.bindings.get(sessionId), next.usedEventBindings))) {
      return false
    }
    const backup: StoredSessionBackup = {
      rootPage: current.rootPage,
      ...(current.blobMapPage === undefined ? {} : { blobMapPage: current.blobMapPage }),
      ...(current.referencesPage === undefined ? {} : { referencesPage: current.referencesPage }),
      ...(current.compactedPage === undefined ? {} : { compactedPage: current.compactedPage }),
      ...(current.seedBoundaryId === undefined ? {} : { seedBoundaryId: current.seedBoundaryId }),
    }
    const nextUsed = new Set(used)
    nextUsed.add(next.revision)
    // The binding table is extended in place: the monotonicity checks above
    // already rejected any conflicting rebind, so appending the added
    // bindings costs O(added) instead of copying the whole table.
    let nextBindings = this.bindings.get(sessionId)
    if (nextBindings === undefined) {
      nextBindings = new Map()
      this.bindings.set(sessionId, nextBindings)
    }
    for (const [eventId, blobId] of additionalBindings ?? next.usedEventBindings ?? []) {
      nextBindings.set(eventId, blobId)
    }
    const { usedEventBindings: _table, ...rest } = next
    const nextRecord: StoredSessionRecord = {
      ...rest,
      backups: trimBackups([...current.backups, backup], this.maxBackupGenerations),
    }
    writePersisted(this.recordPath(sessionId), nextRecord, nextUsed)
    // The record file is written first; the binding log then receives the
    // newly added bindings. A crash between the two leaves the table short of
    // the newest live bindings, which the tree carries anyway, so the ABA and
    // rebind guards stay intact. An incremental commit appends one line per
    // new binding; a whole-snapshot commit (no additionalBindings) rewrites
    // the log from the next table.
    if (additionalBindings !== undefined && additionalBindings.size > 0) {
      appendBindings(this.bindingPath(sessionId), additionalBindings)
    } else {
      writeBindings(this.bindingPath(sessionId), next.usedEventBindings ?? new Map())
    }
    this.records.set(sessionId, copyRecord(nextRecord))
    this.usedRevisions.set(sessionId, nextUsed)
    return true
  }

  /** Root directory owning the store's `records/`.
   * @returns the constructor-provided root directory.
   */
  get directory(): string {
    return this.rootDir
  }

  private recordPath(sessionId: SessionId): string {
    return join(this.recordsDir, `${sessionId}${RECORD_FILE_SUFFIX}`)
  }

  private bindingPath(sessionId: SessionId): string {
    return join(this.bindingsDir, `${sessionId}${BINDINGS_FILE_SUFFIX}`)
  }
}

/** Read every binding from an append-only binding log.
 * A missing log is an empty table (a session registered without bindings).
 * @param path - binding log file path.
 * @returns the reconstructed binding table.
 */
function readBindings(path: string): Map<EventId, BlobId> {
  const bindings = new Map<EventId, BlobId>()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return bindings
    throw error
  }
  for (const line of raw.split('\n')) {
    if (line === '') continue
    const tab = line.indexOf('\t')
    if (tab < 0) throw new Error(`corrupt binding log line: ${line}`)
    const eventId = JSON.parse(line.slice(0, tab)) as unknown
    const blobId = JSON.parse(line.slice(tab + 1)) as unknown
    if (typeof eventId !== 'string' || typeof blobId !== 'string') {
      throw new Error(`corrupt binding log line: ${line}`)
    }
    bindings.set(eventId as EventId, blobId as BlobId)
  }
  return bindings
}

/** Atomically replace a binding log with the complete table.
 * @param path - binding log file path.
 * @param bindings - complete binding table to persist.
 */
function writeBindings(path: string, bindings: ReadonlyMap<EventId, BlobId>): void {
  const lines = [...bindings].map(([eventId, blobId]) => `${JSON.stringify(eventId)}\t${JSON.stringify(blobId)}\n`).join('')
  writeFileAtomicDurableSync(path, new TextEncoder().encode(lines), 0o600)
}

/** Append bindings to a binding log with an fsync, so an incremental commit
 * persists the new lines before the in-memory state advances.
 * @param path - binding log file path.
 * @param bindings - bindings to append.
 */
function appendBindings(path: string, bindings: ReadonlyMap<EventId, BlobId>): void {
  const lines = [...bindings].map(([eventId, blobId]) => `${JSON.stringify(eventId)}\t${JSON.stringify(blobId)}\n`).join('')
  const fd = openSync(path, 'a', 0o600)
  try {
    appendFileSync(fd, lines)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writePersisted(
  path: string,
  record: StoredSessionRecord,
  usedRevisions: ReadonlySet<SessionRevision>,
): void {
  const payload = {
    record: serializeRecord(record),
    usedRevisions: [...usedRevisions],
  }
  writeFileAtomicDurableSync(path, new TextEncoder().encode(JSON.stringify(payload)), 0o600)
}

function trimBackups(backups: readonly StoredSessionBackup[], cap: number): StoredSessionBackup[] {
  if (cap <= 0) return []
  if (backups.length > cap) return backups.slice(backups.length - cap)
  return [...backups]
}

/** Whether every binding in the current table survives into the next table.
 * The binding table only grows; a next record that drops or rewrites an
 * existing binding would let a later update rebind a retired EventId.
 * @param current - the current binding table, or undefined when absent.
 * @param next - the replacement binding table, or undefined when absent.
 * @returns true when every current binding appears unchanged in next.
 */
function bindingMonotonic(
  current: ReadonlyMap<EventId, BlobId> | undefined,
  next: ReadonlyMap<EventId, BlobId> | undefined,
): boolean {
  if (current === undefined) return true
  for (const [eventId, blobId] of current) {
    if (next?.get(eventId) !== blobId) return false
  }
  return true
}

/** Whether appending bindings to the current table never rebinds an existing
 * EventId to a different blob. The incremental append path mints fresh ids,
 * so the check is O(added); a conflict marks a hand-built caller input.
 * @param current - the current binding table, or undefined when absent.
 * @param added - bindings this commit adds.
 * @returns true when every added binding is new or unchanged.
 */
function bindingsAppendable(
  current: ReadonlyMap<EventId, BlobId> | undefined,
  added: ReadonlyMap<EventId, BlobId>,
): boolean {
  for (const [eventId, blobId] of added) {
    const prior = current?.get(eventId)
    if (prior !== undefined && prior !== blobId) return false
  }
  return true
}
