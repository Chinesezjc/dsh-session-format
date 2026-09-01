/**
 * Prototype persistence for blob maps, reference tables, and compaction
 * summaries as checksummed pages.
 * @module @deepseek-ai/dsh-session-format/metadata
 */

import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { BlobId, CompactionId, CompactionSummary, EventId, PageId, ReferenceRecord } from './index.ts'
import { isContentBlock } from './file.ts'
import type { PageStore } from './page-store.ts'

interface SerializedBlobMap {
  readonly blobs: Record<string, { readonly base64: string }>
}

interface SerializedReferences {
  readonly references: readonly ReferenceRecord[]
}

interface SerializedCompactionSummaries {
  readonly summaries: readonly CompactionSummary[]
}

/** Persist a blob map as one page and return its PageId.
 * @param store - page store to write into.
 * @param blobs - blob map to persist.
 * @returns the page id holding the serialized blob map.
 */
export function saveBlobMap(store: PageStore, blobs: ReadonlyMap<BlobId, Uint8Array>): PageId {
  // Object.fromEntries keeps a blob id such as "__proto__" as a plain key
  // instead of mutating the object prototype.
  const record = Object.fromEntries(
    [...blobs].map(([blobId, bytes]) => [blobId, { base64: Buffer.from(bytes).toString('base64') }]),
  ) as SerializedBlobMap['blobs']
  return store.writePage(new TextEncoder().encode(JSON.stringify({ blobs: record } satisfies SerializedBlobMap)))
}

/** Load a blob map from one page.
 * @param store - page store to read from.
 * @param pageId - page holding a serialized blob map.
 * @returns the decoded blob map.
 */
export function loadBlobMap(store: PageStore, pageId: PageId): Map<BlobId, Uint8Array> {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(store.readPage(pageId)))
  if (!isRecord(parsed) || !isRecord(parsed.blobs)) {
    throw new Error('blob map page must contain a blobs object')
  }
  const blobs = new Map<BlobId, Uint8Array>()
  for (const [blobId, encoded] of Object.entries(parsed.blobs)) {
    if (!isRecord(encoded) || typeof encoded.base64 !== 'string'
      || !isValidBase64(encoded.base64)) {
      throw new Error(`blob map entry ${blobId} must carry a valid base64 string`)
    }
    blobs.set(blobId as BlobId, Buffer.from(encoded.base64, 'base64'))
  }
  return blobs
}

function isValidBase64(value: string): boolean {
  if (value.length === 0) return true
  // Padding may only appear at the end with at most two characters, so
  // over-padded strings such as "=====" or "Zg===" are rejected outright.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  const reencoded = Buffer.from(value, 'base64').toString('base64')
  // Buffer.from accepts garbage silently, so require a canonical round trip;
  // unpadded encodings are accepted by comparing the canonical padded form.
  return reencoded === value || reencoded.replace(/=+$/, '') === value
}

/** Persist a reference table as one page and return its PageId.
 * @param store - page store to write into.
 * @param references - reference records to persist.
 * @returns the page id holding the serialized reference table.
 */
export function saveReferences(store: PageStore, references: readonly ReferenceRecord[]): PageId {
  const payload: SerializedReferences = { references }
  return store.writePage(new TextEncoder().encode(JSON.stringify(payload)))
}

/** Load a reference table from one page.
 * @param store - page store to read from.
 * @param pageId - page holding a serialized reference table.
 * @returns the decoded reference records.
 */
export function loadReferences(store: PageStore, pageId: PageId): ReferenceRecord[] {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(store.readPage(pageId)))
  if (!isRecord(parsed) || !Array.isArray(parsed.references)) {
    throw new Error('reference table page must contain a references array')
  }
  const seenKeys = new Set<string>()
  return parsed.references.map((reference: unknown) => {
    if (!isRecord(reference)
      || typeof reference.fromEventId !== 'string'
      || typeof reference.refName !== 'string'
      || !Array.isArray(reference.toEventIds)
      || !reference.toEventIds.every((id: unknown) => typeof id === 'string')) {
      throw new Error('reference table entries must carry string event ids')
    }
    const key = `${reference.fromEventId}\u0000${reference.refName}`
    if (seenKeys.has(key)) {
      throw new Error(`reference page ${pageId} duplicates the ${reference.fromEventId}/${reference.refName} key`)
    }
    if (new Set(reference.toEventIds).size !== reference.toEventIds.length) {
      throw new Error(`reference page ${pageId} targets an event more than once`)
    }
    seenKeys.add(key)
    return {
      fromEventId: reference.fromEventId as EventId,
      refName: reference.refName,
      toEventIds: [...reference.toEventIds] as EventId[],
    }
  })
}

/** Persist the compaction summary log as one page and return its PageId.
 * @param store - page store to write into.
 * @param summaries - compaction summaries to persist.
 * @returns the page id holding the serialized summary log.
 */
export function saveCompactionSummaries(store: PageStore, summaries: readonly CompactionSummary[]): PageId {
  const payload: SerializedCompactionSummaries = { summaries }
  return store.writePage(new TextEncoder().encode(JSON.stringify(payload)))
}

/** Load the compaction summary log from one page.
 * @param store - page store to read from.
 * @param pageId - page holding a serialized summary log.
 * @returns the decoded compaction summaries.
 */
export function loadCompactionSummaries(store: PageStore, pageId: PageId): CompactionSummary[] {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(store.readPage(pageId)))
  if (!isRecord(parsed) || !Array.isArray(parsed.summaries)) {
    throw new Error('compaction summary page must contain a summaries array')
  }
  return parsed.summaries.map((summary: unknown) => {
    if (!isRecord(summary)
      || typeof summary.compactionId !== 'string' || summary.compactionId.length === 0
      || typeof summary.checkpointEventId !== 'string'
      || !isRecord(summary.markerEventIds)
      || typeof summary.markerEventIds.startEventId !== 'string'
      || typeof summary.markerEventIds.summaryEventId !== 'string'
      || typeof summary.markerEventIds.endEventId !== 'string'
      || !isRecord(summary.shadowedRange)
      || typeof summary.shadowedRange.startId !== 'string'
      || typeof summary.shadowedRange.endId !== 'string'
      || !Array.isArray(summary.shadowedIds)
      || summary.shadowedIds.length === 0
      || !summary.shadowedIds.every((id: unknown) => typeof id === 'string')
      || !isRecord(summary.shadowedSeqRange)
      || typeof summary.shadowedSeqRange.start !== 'number'
      || typeof summary.shadowedSeqRange.end !== 'number'
      || !Array.isArray(summary.shadowedSeqs)
      || summary.shadowedSeqs.length === 0
      || !(summary.shadowedSeqs as unknown[]).every(seq => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0)
      || (
        summary.shadowedSeqs[0] !== summary.shadowedSeqRange.start
        || summary.shadowedSeqs[summary.shadowedSeqs.length - 1] !== summary.shadowedSeqRange.end)
      || !Array.isArray(summary.summary)
      || !summary.summary.every(isContentBlock)
      || typeof summary.shadowedTokenCount !== 'number'
      || !Number.isSafeInteger(summary.shadowedTokenCount)
      || summary.shadowedTokenCount < 0
      || typeof summary.provider !== 'string'
      || typeof summary.model !== 'string'
      || summary.rawOutput !== undefined && (!Array.isArray(summary.rawOutput) || !summary.rawOutput.every(isContentBlock))
      || summary.sourceCommandId !== undefined
        && (typeof summary.sourceCommandId !== 'string' || summary.sourceCommandId.length === 0)
      || summary.maxTokens !== undefined && typeof summary.maxTokens !== 'number'
      || summary.usage !== undefined && (
        !isRecord(summary.usage)
        || typeof summary.usage.inputTokens !== 'number'
        || typeof summary.usage.outputTokens !== 'number'
        || summary.usage.totalTokens !== undefined && typeof summary.usage.totalTokens !== 'number'
        || summary.usage.cacheReadTokens !== undefined && typeof summary.usage.cacheReadTokens !== 'number'
        || summary.usage.cacheWriteTokens !== undefined && typeof summary.usage.cacheWriteTokens !== 'number'
        || summary.usage.reasoningTokens !== undefined && typeof summary.usage.reasoningTokens !== 'number')
      || summary.llmStreamCall !== undefined && summary.llmStreamCall !== true
      || summary.llmStreamCall === true && summary.rawOutput === undefined) {
      throw new Error('compaction summary entries must carry the full summary shape')
    }
    const entry = {
      compactionId: summary.compactionId as CompactionId,
      checkpointEventId: summary.checkpointEventId as EventId,
      markerEventIds: {
        startEventId: summary.markerEventIds.startEventId as EventId,
        summaryEventId: summary.markerEventIds.summaryEventId as EventId,
        endEventId: summary.markerEventIds.endEventId as EventId,
      },
      shadowedRange: {
        startId: summary.shadowedRange.startId as EventId,
        endId: summary.shadowedRange.endId as EventId,
      },
      shadowedIds: summary.shadowedIds as EventId[],
      shadowedSeqRange: {
        start: summary.shadowedSeqRange.start,
        end: summary.shadowedSeqRange.end,
      },
      shadowedSeqs: summary.shadowedSeqs as number[],
      summary: summary.summary,
      shadowedTokenCount: summary.shadowedTokenCount,
      provider: summary.provider,
      model: summary.model,
      ...(summary.sourceCommandId === undefined ? {} : { sourceCommandId: summary.sourceCommandId as CommandId }),
      ...(summary.maxTokens === undefined ? {} : { maxTokens: summary.maxTokens }),
      ...(summary.usage === undefined ? {} : { usage: summary.usage as unknown as TokenUsage }),
      ...(summary.rawOutput === undefined ? {} : { rawOutput: summary.rawOutput }),
      ...(summary.llmStreamCall === undefined ? {} : { llmStreamCall: summary.llmStreamCall as true }),
    } as unknown as CompactionSummary
    return entry
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
