/**
 * Fork prototype for the per-session file format.
 * A child session inherits the parent prefix up to and including `atEventId`,
 * keeps parent EventIds for inherited events, and gets a fresh session record
 * that carries over the parent's cwd, origin, delegationDepth, and agentPreset.
 * Inherited blobs, references, and compaction summaries are restricted to the
 * inherited prefix: a reference is kept only when its source and every target
 * are inherited, and a compaction summary only when its checkpoint event is
 * inherited.
 * @module @deepseek-ai/dsh-session-format/fork
 */

import { SessionTree } from './btree.ts'
import type { SessionFile } from './file.ts'
import type { BlobId, EventId, PageId, SessionId, SessionRevision } from './index.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fork a session file at an EventId boundary and return the child file.
 * Every inherited entry is the child's seed, so the child's seedBoundaryId is
 * always the fork boundary `atEventId` — replay and projection must not treat
 * inherited parent events as child-produced events. Page pointers are not
 * inherited: the child uses the caller-supplied root page identity and drops
 * the parent's blobMapPage/referencesPage, which address the parent's full
 * maps rather than the filtered child content. The root page identity and
 * initial revision belong to the storage layer, so the caller supplies them.
 * @param file - the parent session file.
 * @param atEventId - the inclusive boundary EventId.
 * @param childSessionId - the new child session identity.
 * @param record - the root page identity and initial revision for the child record.
 * The caller (or persistence layer) owns the child's `createdAt`: the child
 * is a new identity, so this function leaves `createdAt` unset for the caller
 * to fill, mirroring how `migrateLegacySession` carries the source's value.
 * @returns the child session file.
 */
export function forkSessionFile(
  file: SessionFile,
  atEventId: EventId,
  childSessionId: SessionId,
  record: {
    readonly rootPage: PageId
    readonly revision: SessionRevision
    /** The child's next EventId counter; the caller owns counter continuity. */
    readonly nextEventCounter: number
  },
): SessionFile {
  if (childSessionId === file.session.sessionId) {
    throw new Error('child session id must differ from the parent session id')
  }
  // The child counter is per-session: EventIds carry the child's own prefix
  // (evt_<sessionId>_<counter>), so it starts from the caller's value
  // independent of the parent's counter.
  if (typeof record.nextEventCounter !== 'number'
    || !Number.isSafeInteger(record.nextEventCounter)
    || record.nextEventCounter < 0) {
    throw new Error('fork record nextEventCounter must be a non-negative safe integer')
  }
  const tree = SessionTree.fromEntries(file.entries)
  // The fork boundary must not cut a compaction bracket in half: a prefix
  // ending inside a bracket would inherit markers without the checkpoint,
  // silently dropping the shadowed model history. The side table covers
  // claimed brackets; the entry stream is scanned too so an unclaimed
  // transaction a migrated file carries (whose markers are JSON blobs but not
  // side-table records) cannot be cut either.
  const boundaryRank = tree.rank(atEventId)
  if (boundaryRank === undefined) throw new Error('cannot fork at an unknown EventId')
  // One rank map serves every bracket check; SessionTree.rank scans the whole
  // tree, so resolving markers through this map keeps forking linear in the
  // number of compactions.
  const entryRankById = new Map(file.entries.map((entry, index) => [entry.eventId, index]))
  for (const summary of file.compacted) {
    const bracket = [
      summary.markerEventIds.startEventId,
      summary.markerEventIds.summaryEventId,
      summary.checkpointEventId,
      summary.markerEventIds.endEventId,
    ]
    const bracketRanks = bracket.map(id => entryRankById.get(id))
    const inheritedCount = bracketRanks.filter(rank => rank !== undefined && rank <= boundaryRank).length
    if (inheritedCount > 0 && inheritedCount < bracket.length) {
      throw new Error('fork boundary must not cut a compaction bracket in half')
    }
  }
  {
    let openBracketStart: number | undefined
    const pendingBrackets: Array<{ readonly start: number; readonly end: number }> = []
    for (let rank = 0; rank < file.entries.length; rank += 1) {
      const entry = file.entries[rank] as { readonly blobId: BlobId }
      let envelope: unknown
      try {
        envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.blobs.get(entry.blobId)))
      } catch {
        continue
      }
      const eventType = isRecord(envelope) ? envelope.type : undefined
      if (eventType === 'compaction/start') {
        openBracketStart = rank
      } else if (eventType === 'compaction/end' || eventType === 'session/end-seed') {
        if (openBracketStart !== undefined) {
          pendingBrackets.push({ start: openBracketStart, end: rank })
          openBracketStart = undefined
        }
      }
    }
    // A trailing open bracket is an orphan the import boundary tolerates (it
    // has no end anywhere to be cut), so only brackets with a recorded end
    // are checked.
    for (const bracket of pendingBrackets) {
      if (bracket.start <= boundaryRank && boundaryRank < bracket.end) {
        throw new Error('fork boundary must not cut a compaction bracket in half')
      }
    }
  }
  // The fork boundary must not end inside an open turn: a prefix ending with
  // an unmatched `turn/start` would resume the half-open turn in the child,
  // violating the turn lifecycle invariant the store enforces on live forks.
  // A depth stack (not the last boundary's type) decides, so nested turns
  // whose inner turn already closed but whose outer turn is still open are
  // rejected too. An orphaned `turn/end` (no matching start in the prefix)
  // pops an empty stack as a no-op — a depth counter would instead go
  // negative and mask a later open turn.
  const inheritedPrefix = file.entries.slice(0, boundaryRank + 1)
  // The boundary must not end inside an open turn, and a turn/end that does
  // not name the open turn never closes it (core's invariant rejects the
  // mismatch), so ends pop only when their turn matches the top of the stack.
  const openTurns: Array<number> = []
  for (const entry of inheritedPrefix) {
    let envelope: unknown
    try {
      envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.blobs.get(entry.blobId)))
    } catch {
      envelope = undefined
    }
    if (isRecord(envelope) && typeof envelope.type === 'string') {
      const eventData = isRecord(envelope.data) ? envelope.data : undefined
      const turn = eventData?.turn as number | null | undefined
      if (envelope.type === 'turn/start' && typeof turn === 'number') {
        openTurns.push(turn)
      }
      if (envelope.type === 'turn/end' && typeof turn === 'number'
        && openTurns.length > 0 && openTurns.at(-1) === turn) {
        openTurns.pop()
      }
    }
  }
  if (openTurns.length > 0) {
    throw new Error('fork boundary must not end inside an open turn')
  }
  const [left] = tree.split(atEventId)
  const inheritedEntries = left.entries()
  const inheritedEventIds = new Set<EventId>(inheritedEntries.map(entry => entry.eventId))
  const inheritedBlobIds = new Set(inheritedEntries.map(entry => entry.blobId))

  const blobs = new Map([...file.blobs].filter(([blobId]) => inheritedBlobIds.has(blobId)))
  const references = file.references
    .filter(reference => inheritedEventIds.has(reference.fromEventId)
      && reference.toEventIds.every(id => inheritedEventIds.has(id)))
    .map(reference => ({ ...reference, toEventIds: [...reference.toEventIds] }))

  const childSession = {
    sessionId: childSessionId,
    formatVersion: file.session.formatVersion,
    nextEventCounter: record.nextEventCounter,
    ...(file.session.cwd === undefined ? {} : { cwd: file.session.cwd }),
    ...(file.session.origin === undefined ? {} : { origin: file.session.origin }),
    ...(file.session.delegationDepth === undefined ? {} : { delegationDepth: file.session.delegationDepth }),
    ...(file.session.agentPreset === undefined ? {} : { agentPreset: file.session.agentPreset }),
    parentSession: file.session.sessionId,
    rootPage: record.rootPage,
    revision: record.revision,
    seedBoundaryId: atEventId,
    backups: [],
  }

  return {
    session: childSession,
    entries: inheritedEntries,
    blobs,
    references,
    compacted: file.compacted.filter(summary =>
      inheritedEventIds.has(summary.checkpointEventId)
      && inheritedEventIds.has(summary.markerEventIds.startEventId)
      && inheritedEventIds.has(summary.markerEventIds.summaryEventId)
      && inheritedEventIds.has(summary.markerEventIds.endEventId)),
  }
}
