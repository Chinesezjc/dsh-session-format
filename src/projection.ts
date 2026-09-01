/**
 * Projection watermark helpers for the EventId-based session format.
 * A projection folds a session's events into derived state and records the
 * EventId it has folded through; compaction can invalidate it when that
 * EventId is shadowed.
 * @module @deepseek-ai/dsh-session-format/projection
 */

import type { CompactionSummary, EventId } from './index.ts'

/** One projection state: the derived value plus the EventId it has folded through. */
export interface ProjectionState<T> {
  readonly value: T
  readonly watermarkEventId: EventId
}

/**
 * Fold one event into a projection and advance its watermark.
 * The fold runs on the previous value and the watermark moves to the folded
 * event in the same step, so the value and the watermark advance together.
 * The fold must be pure: it must not mutate the `previous` value it receives,
 * because the previous state keeps that value until the caller replaces it.
 * Callers fold events in stream order from the session's first event, so the
 * resulting projection covers the complete prefix through its watermark; the
 * helper does not verify ordering because EventId carries no rank.
 * @param state - projection before this event, or undefined for the first event.
 * @param eventId - identity of the event being folded in.
 * @param fold - computes the next value from the previous value; must not mutate it.
 * @returns the advanced projection state.
 */
export function advanceProjection<T>(
  state: ProjectionState<T> | undefined,
  eventId: EventId,
  fold: (previous: T | undefined) => T,
): ProjectionState<T> {
  return { value: fold(state?.value), watermarkEventId: eventId }
}

/**
 * Whether a projection's watermark is exactly one of the ids a compaction
 * shadowed. This is the narrow shadow check; {@link projectionNeedsRebuild}
 * additionally covers a watermark folded past the shadowed range.
 * @param state - projection state, or undefined when nothing has been folded yet.
 * @param shadowedIds - EventIds removed by the latest compaction.
 * @returns true when the projection's watermark is among the shadowed ids.
 */
export function projectionWatermarkShadowed<T>(
  state: ProjectionState<T> | undefined,
  shadowedIds: Iterable<EventId>,
): boolean {
  if (state === undefined) return false
  for (const id of shadowedIds) {
    if (id === state.watermarkEventId) return true
  }
  return false
}

/**
 * Whether a projection must be rebuilt after a compaction. A projection is
 * stale when it folded through the shadowed range: its watermark is one of
 * the shadowed ids, or the watermark ranks at or after the compaction's
 * checkpoint event in the session tree. Ranks come from the caller, because
 * only the tree knows the actual stream order — the EventId counter is
 * allocation order, and compaction inserts replacement ids at old positions,
 * so counters cannot rank events.
 * The projection must cover the complete prefix of the session from its
 * first event through the watermark: the wide check assumes the projection
 * folded every event up to the watermark. A projection folded from a suffix
 * (one whose first fold was not the session's first event) can be reported
 * stale even though it never folded the shadowed events; this only causes an
 * unnecessary rebuild, never dirty data, and callers keep the prefix by
 * folding in stream order from the first event.
 * This is a one-shot check: `state` must be the projection as it was folded
 * before this compaction. A projection rebuilt after the compaction (one that
 * already folded the checkpoint) also ranks at or after the checkpoint and is
 * reported stale; the caller checks once per compaction and rebuilds from the
 * result, it does not re-check a rebuilt projection against the same summary.
 * When the watermark or the checkpoint is absent from the current tree, a
 * later compaction already reordered the stream and the ranks cannot be
 * resolved; the check reports stale rather than risk reusing stale state.
 * @param state - projection state, or undefined when nothing has been folded yet.
 * @param summary - the compaction summary whose shadowed range is checked.
 * @param rank - dense stream rank of an EventId in the post-compaction tree, or undefined when the id is absent.
 * @returns true when the projection folded through the shadowed range.
 */
export function projectionNeedsRebuild<T>(
  state: ProjectionState<T> | undefined,
  summary: CompactionSummary,
  rank: (eventId: EventId) => number | undefined,
): boolean {
  if (projectionWatermarkShadowed(state, summary.shadowedIds)) return true
  if (state === undefined) return false
  const watermarkRank = rank(state.watermarkEventId)
  const checkpointRank = rank(summary.checkpointEventId)
  // Either id absent from the current tree means a later compaction already
  // reordered the stream, so the summary's ranks cannot be resolved against
  // this tree: report stale (an unnecessary rebuild, never stale reuse) rather
  // than silently passing an out-of-date summary.
  if (watermarkRank === undefined || checkpointRank === undefined) return true
  return watermarkRank >= checkpointRank
}
