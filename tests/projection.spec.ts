import { describe, expect, it } from 'vitest'
import { advanceProjection, projectionNeedsRebuild, projectionWatermarkShadowed } from '../src/projection.ts'
import type { CompactionSummary, EventId } from '../src/index.ts'

const SESSION = 'sess'

function evt(counter: number): EventId {
  return `evt_${SESSION}_${counter}` as EventId
}

function summary(
  shadowedRange: { startId: EventId; endId: EventId },
  shadowedIds: EventId[],
  checkpointEventId: EventId = evt(100),
): CompactionSummary {
  return {
    compactionId: 'compact_1' as CompactionSummary['compactionId'],
    checkpointEventId,
    markerEventIds: {
      startEventId: evt(101),
      summaryEventId: evt(102),
      endEventId: evt(103),
    },
    shadowedRange,
    shadowedIds,
    shadowedSeqRange: { start: 0, end: 1 },
    shadowedSeqs: [0, 1],
    summary: [],
    shadowedTokenCount: 0,
    provider: 'test',
    model: 'test',
  }
}

/** Dense rank over a stream; the counter is not the rank (compaction can
 * insert high counters at old positions), so tests pass ranks explicitly. */
function rankOf(stream: EventId[]): (eventId: EventId) => number | undefined {
  return (eventId) => {
    const index = stream.indexOf(eventId)
    return index === -1 ? undefined : index
  }
}

describe('projection watermarks', () => {
  it('folds events into the value and advances the watermark with each fold', () => {
    const first = advanceProjection(undefined, evt(1), () => 1)
    expect(first.value).toBe(1)
    expect(first.watermarkEventId).toBe(evt(1))

    const second = advanceProjection(first, evt(2), previous => (previous ?? 0) + 1)
    expect(second.value).toBe(2)
    expect(second.watermarkEventId).toBe(evt(2))
  })

  it('passes the previous value to the fold without mutating it', () => {
    const previous = { n: 1 }
    const state = { value: previous, watermarkEventId: evt(1) }
    const next = advanceProjection(state, evt(2), value => ({ n: (value?.n ?? 0) + 1 }))
    expect(previous.n).toBe(1)
    expect(next.value).toEqual({ n: 2 })
    expect(next.watermarkEventId).toBe(evt(2))
  })

  it('requires a rebuild when the watermark is shadowed', () => {
    const state = advanceProjection(undefined, evt(3), () => 'x')
    expect(projectionWatermarkShadowed(state, [evt(3)])).toBe(true)
    // The watermark was removed from the tree; the shadowed-ids check decides.
    expect(projectionNeedsRebuild(state, summary({ startId: evt(3), endId: evt(4) }, [evt(3)]), rankOf([evt(100), evt(4)]))).toBe(true)
  })

  it('keeps the projection when the watermark is before the shadowed range', () => {
    const state = advanceProjection(undefined, evt(3), () => 'x')
    // e3 ranks before the checkpoint inserted at the range; nothing shadowed was folded.
    const range = summary({ startId: evt(4), endId: evt(5) }, [evt(4), evt(5)])
    expect(projectionNeedsRebuild(state, range, rankOf([evt(3), evt(100)]))).toBe(false)
  })

  it('requires a rebuild when the watermark ranks at or after the checkpoint', () => {
    // The projection folded e1,e2; a compaction shadows e1 and inserts a
    // checkpoint at that position, and e2 still ranks after it.
    const state = advanceProjection(undefined, evt(2), () => 'x')
    expect(projectionNeedsRebuild(state, summary({ startId: evt(1), endId: evt(1) }, [evt(1)]), rankOf([evt(100), evt(2)]))).toBe(true)
  })

  it('requires a rebuild when the watermark is past the shadowed range even with a higher counter', () => {
    // Counters are not ranks: a projection folded through e100..e103 and its
    // watermark e2 has a LOWER counter than the shadowed e100..e101 range.
    // Only stream rank decides.
    const state = advanceProjection(undefined, evt(2), () => 'x')
    const summaryWithHighRange = summary({ startId: evt(100), endId: evt(101) }, [evt(100), evt(101)], evt(200))
    expect(projectionNeedsRebuild(state, summaryWithHighRange, rankOf([evt(200), evt(102), evt(103), evt(2)]))).toBe(true)
  })

  it('never requires a rebuild without a projection state', () => {
    expect(projectionNeedsRebuild(undefined, summary({ startId: evt(1), endId: evt(2) }, [evt(1)]), rankOf([evt(100)]))).toBe(false)
  })

  it('requires a rebuild when the watermark is absent from the tree', () => {
    // A watermark missing from the current tree means a later compaction
    // reordered the stream; the ranks cannot resolve, so the check conservatively
    // reports stale rather than risk reusing stale projection state.
    const state = advanceProjection(undefined, evt(9), () => 'x')
    expect(projectionNeedsRebuild(state, summary({ startId: evt(1), endId: evt(2) }, [evt(1), evt(2)]), rankOf([evt(100)]))).toBe(true)
  })

  it('requires a rebuild when the summary checkpoint is absent from the tree', () => {
    const state = advanceProjection(undefined, evt(9), () => 'x')
    // A later compaction removed this summary's checkpoint while the watermark
    // survives, so only the checkpoint branch of the missing-rank fallback fires.
    expect(projectionNeedsRebuild(
      state, summary({ startId: evt(1), endId: evt(2) }, [evt(1), evt(2)]), rankOf([evt(9)]),
    )).toBe(true)
  })

  it('never requires a rebuild when nothing was shadowed', () => {
    const state = advanceProjection(undefined, evt(3), () => 'x')
    expect(projectionWatermarkShadowed(state, [])).toBe(false)
  })
})
