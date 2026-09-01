import { describe, expect, it } from 'vitest'
import {
  loadBlobChain,
  loadBlobMap,
  loadCompactionSummaries,
  loadReferences,
  saveBlobAppends,
  saveBlobMap,
  saveCompactionSummaries,
  saveReferences,
} from '../src/metadata.ts'
import { encodePage } from '../src/pages.ts'
import { PageStore } from '../src/page-store.ts'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BlobId, CompactionId, CompactionSummary, EventId, PageId, ReferenceRecord } from '../src/index.ts'

describe('metadata pages', () => {
  it('persists and loads blob maps', () => {
    const store = new PageStore()
    const blobs = new Map<BlobId, Uint8Array>([
      ['blob_1' as BlobId, new TextEncoder().encode('one')],
      ['blob_2' as BlobId, new TextEncoder().encode('two')],
    ])
    const page = saveBlobMap(store, blobs)
    const loaded = loadBlobMap(store, page)
    expect(Array.from(loaded.get('blob_1' as BlobId)!)).toEqual(Array.from(new TextEncoder().encode('one')))
    expect(loaded.size).toBe(2)
  })

  it('keeps a __proto__ blob id as a plain key', () => {
    const store = new PageStore()
    const blobs = new Map<BlobId, Uint8Array>([
      ['__proto__' as BlobId, new TextEncoder().encode('proto-blob')],
    ])
    const page = saveBlobMap(store, blobs)
    const loaded = loadBlobMap(store, page)
    expect(Array.from(loaded.get('__proto__' as BlobId)!)).toEqual(Array.from(new TextEncoder().encode('proto-blob')))
  })

  it('persists and loads reference tables', () => {
    const store = new PageStore()
    const references: ReferenceRecord[] = [
      { fromEventId: 'evt_1' as EventId, refName: 'sourceEventIds', toEventIds: ['evt_0' as EventId] },
    ]
    const page = saveReferences(store, references)
    const loaded = loadReferences(store, page)
    expect(loaded).toEqual(references)
  })

  it('persists and loads compaction summaries', () => {
    const store = new PageStore()
    const summaries: CompactionSummary[] = [
      {
        compactionId: 'compact_1' as CompactionId,
        checkpointEventId: 'evt_100' as EventId,
        markerEventIds: {
          startEventId: 'evt_10' as EventId,
          summaryEventId: 'evt_11' as EventId,
          endEventId: 'evt_12' as EventId,
        },
        shadowedRange: { startId: 'evt_1' as EventId, endId: 'evt_3' as EventId },
        shadowedIds: ['evt_1' as EventId, 'evt_2' as EventId],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      },
    ]
    const page = saveCompactionSummaries(store, summaries)
    const loaded = loadCompactionSummaries(store, page)
    expect(loaded).toEqual(summaries)
  })

  it('round-trips non-monotonic shadowedSeqs in surface order', () => {
    const store = new PageStore()
    // shadowedSeqs are surface-POSITION spans, not numerically increasing
    // order: a later compaction can shadow [4,5,2] and the read-back side
    // must preserve the exact array (compaction.spec.ts:1020 pins the same
    // fact on the write side). A monotonicity check here would reject a file
    // the write side emits.
    const summaries: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: 'evt_100' as EventId,
      markerEventIds: {
        startEventId: 'evt_10' as EventId,
        summaryEventId: 'evt_11' as EventId,
        endEventId: 'evt_12' as EventId,
      },
      shadowedRange: { startId: 'evt_1' as EventId, endId: 'evt_3' as EventId },
      shadowedIds: ['evt_1' as EventId, 'evt_2' as EventId, 'evt_3' as EventId],
      shadowedSeqRange: { start: 4, end: 2 },
      shadowedSeqs: [4, 5, 2],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'test',
      model: 'test',
    }]
    const page = saveCompactionSummaries(store, summaries)
    const loaded = loadCompactionSummaries(store, page)
    expect(loaded).toEqual(summaries)
  })

  it('rejects a compaction summary with an empty compactionId or sourceCommandId', () => {
    const store = new PageStore()
    const emptyCompactionId = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{
        compactionId: '',
        checkpointEventId: 'evt_100',
        markerEventIds: {
          startEventId: 'evt_10',
          summaryEventId: 'evt_11',
          endEventId: 'evt_12',
        },
        shadowedRange: { startId: 'evt_1', endId: 'evt_3' },
        shadowedIds: ['evt_1', 'evt_2'],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    })))
    expect(() => loadCompactionSummaries(store, emptyCompactionId)).toThrow(/must carry the full summary shape/)
    const emptySourceCommandId = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{
        compactionId: 'compact_1',
        checkpointEventId: 'evt_100',
        markerEventIds: {
          startEventId: 'evt_10',
          summaryEventId: 'evt_11',
          endEventId: 'evt_12',
        },
        shadowedRange: { startId: 'evt_1', endId: 'evt_3' },
        shadowedIds: ['evt_1', 'evt_2'],
        shadowedSeqRange: { start: 1, end: 2 },
        shadowedSeqs: [1, 2],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        sourceCommandId: '',
      }],
    })))
    expect(() => loadCompactionSummaries(store, emptySourceCommandId)).toThrow(/must carry the full summary shape/)
  })

  it('rejects pages with invalid UTF-8 payloads', () => {
    const store = new PageStore()
    const page = store.writePage(new TextEncoder().encode(JSON.stringify({ blobs: {} })))
    // Rewrite the page with a checksum-correct container whose payload ends
    // in an invalid UTF-8 sequence, so the failure comes from decoding.
    const malformed = new Uint8Array([0x22, 0x7d, 0xff, 0xff])
    ;(store as unknown as { pages: Map<string, Uint8Array> }).pages.set(page, encodePage(page, malformed))
    expect(() => loadBlobMap(store, page)).toThrow()
  })

  it('rejects malformed metadata pages', () => {
    const store = new PageStore()
    const badBlobMap = store.writePage(new TextEncoder().encode(JSON.stringify({
      blobs: { blob_1: { base64: 42 } },
    })))
    expect(() => loadBlobMap(store, badBlobMap)).toThrow(/must carry a valid base64 string/)
    const invalidBase64 = store.writePage(new TextEncoder().encode(JSON.stringify({
      blobs: { blob_1: { base64: 'not base64!' } },
    })))
    expect(() => loadBlobMap(store, invalidBase64)).toThrow(/must carry a valid base64 string/)
    const overPadded = store.writePage(new TextEncoder().encode(JSON.stringify({
      blobs: { blob_1: { base64: 'Zg===' } },
    })))
    expect(() => loadBlobMap(store, overPadded)).toThrow(/must carry a valid base64 string/)
    const badReferences = store.writePage(new TextEncoder().encode(JSON.stringify({
      references: [{ fromEventId: 42, refName: 'x', toEventIds: [] }],
    })))
    expect(() => loadReferences(store, badReferences)).toThrow(/must carry string event ids/)
    const badSummaries = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{ compactionId: 'c', checkpointEventId: 42 }],
    })))
    expect(() => loadCompactionSummaries(store, badSummaries)).toThrow(/must carry the full summary shape/)
    const badSummaryBlocks = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{
        compactionId: 'c',
        checkpointEventId: 'evt_1',
        shadowedRange: { startId: 'evt_0', endId: 'evt_1' },
        shadowedIds: ['evt_0'],
        summary: [42],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    })))
    expect(() => loadCompactionSummaries(store, badSummaryBlocks)).toThrow(/must carry the full summary shape/)
    const badRawOutput = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{
        compactionId: 'c',
        checkpointEventId: 'evt_1',
        shadowedRange: { startId: 'evt_0', endId: 'evt_1' },
        shadowedIds: ['evt_0'],
        shadowedSeqRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        rawOutput: 'x',
      }],
    })))
    expect(() => loadCompactionSummaries(store, badRawOutput)).toThrow(/must carry the full summary shape/)
    const notAnArray = store.writePage(new TextEncoder().encode(JSON.stringify({ references: 'x' })))
    expect(() => loadReferences(store, notAnArray)).toThrow(/must contain a references array/)
    const missingBlobs = store.writePage(new TextEncoder().encode(JSON.stringify({})))
    expect(() => loadBlobMap(store, missingBlobs)).toThrow(/must contain a blobs object/)
    const missingSummaries = store.writePage(new TextEncoder().encode(JSON.stringify({ summaries: 'x' })))
    expect(() => loadCompactionSummaries(store, missingSummaries)).toThrow(/must contain a summaries array/)
  })

  it('accepts an empty base64 blob value', () => {
    const store = new PageStore()
    const page = store.writePage(new TextEncoder().encode(JSON.stringify({
      blobs: { blob_empty: { base64: '' } },
    })))
    expect(loadBlobMap(store, page).get('blob_empty' as BlobId)?.length ?? 0).toBe(0)
  })

  it('rejects a reference page with duplicate keys or duplicate targets', () => {
    const store = new PageStore()
    const dupKey = store.writePage(new TextEncoder().encode(JSON.stringify({
      references: [
        { fromEventId: 'evt_1', refName: 'x', toEventIds: ['evt_2'] },
        { fromEventId: 'evt_1', refName: 'x', toEventIds: ['evt_3'] },
      ],
    })))
    expect(() => loadReferences(store, dupKey)).toThrow(/duplicates the/)
    const dupTarget = store.writePage(new TextEncoder().encode(JSON.stringify({
      references: [{ fromEventId: 'evt_1', refName: 'x', toEventIds: ['evt_2', 'evt_2'] }],
    })))
    expect(() => loadReferences(store, dupTarget)).toThrow(/targets an event more than once/)
  })

  it('accepts unpadded base64 blob values', () => {
    const store = new PageStore()
    const page = store.writePage(new TextEncoder().encode(JSON.stringify({
      blobs: { blob_1: { base64: 'Zm8' } },
    })))
    expect(Array.from(loadBlobMap(store, page).get('blob_1' as BlobId)!)).toEqual([102, 111])
  })

  it('round-trips a summary carrying raw output blocks', () => {
    const store = new PageStore()
    const summaries: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: 'evt_100' as EventId,
      markerEventIds: {
        startEventId: 'evt_10' as EventId,
        summaryEventId: 'evt_11' as EventId,
        endEventId: 'evt_12' as EventId,
      },
      shadowedRange: { startId: 'evt_1' as EventId, endId: 'evt_3' as EventId },
      shadowedIds: ['evt_1' as EventId],
      shadowedSeqRange: { start: 1, end: 1 },
      shadowedSeqs: [1],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'test',
      model: 'test',
      rawOutput: [{ type: 'text', text: 'raw' }],
    }]
    const page = saveCompactionSummaries(store, summaries)
    expect(loadCompactionSummaries(store, page)).toEqual(summaries)
  })

  it('round-trips a summary carrying optional command and usage fields', () => {
    const store = new PageStore()
    const summaries: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: 'evt_100' as EventId,
      markerEventIds: {
        startEventId: 'evt_10' as EventId,
        summaryEventId: 'evt_11' as EventId,
        endEventId: 'evt_12' as EventId,
      },
      shadowedRange: { startId: 'evt_1' as EventId, endId: 'evt_3' as EventId },
      shadowedIds: ['evt_1' as EventId],
      shadowedSeqRange: { start: 1, end: 1 },
      shadowedSeqs: [1],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'test',
      model: 'test',
      sourceCommandId: 'cmd_1' as CommandId,
      maxTokens: 100,
      usage: { inputTokens: 1, outputTokens: 2 },
      rawOutput: [{ type: 'text', text: 'raw' }],
    }]
    const page = saveCompactionSummaries(store, summaries)
    expect(loadCompactionSummaries(store, page)).toEqual(summaries)
  })

  it('rejects summaries with unsafe counters or inconsistent seq facts', () => {
    const store = new PageStore()
    const base = {
      compactionId: 'c',
      checkpointEventId: 'evt_1',
      markerEventIds: { startEventId: 'evt_10', summaryEventId: 'evt_11', endEventId: 'evt_12' },
      shadowedRange: { startId: 'evt_0', endId: 'evt_1' },
      shadowedIds: ['evt_0'],
      shadowedSeqRange: { start: 1, end: 1 },
      shadowedSeqs: [1],
      summary: [],
      provider: 'test',
      model: 'test',
    }
    const negativeTokens = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{ ...base, shadowedTokenCount: -1 }],
    })))
    expect(() => loadCompactionSummaries(store, negativeTokens)).toThrow(/must carry the full summary shape/)
    const emptyShadowed = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{ ...base, shadowedIds: [], shadowedTokenCount: 0 }],
    })))
    expect(() => loadCompactionSummaries(store, emptyShadowed)).toThrow(/must carry the full summary shape/)
    const seqMismatch = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{ ...base, shadowedSeqs: [2], shadowedTokenCount: 0 }],
    })))
    expect(() => loadCompactionSummaries(store, seqMismatch)).toThrow(/must carry the full summary shape/)
    const partialUsage = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{ ...base, shadowedTokenCount: 0, usage: { inputTokens: 1 } }],
    })))
    expect(() => loadCompactionSummaries(store, partialUsage)).toThrow(/must carry the full summary shape/)
    const badUsageField = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{ ...base, shadowedTokenCount: 0, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 'x' } }],
    })))
    expect(() => loadCompactionSummaries(store, badUsageField)).toThrow(/must carry the full summary shape/)
    const badCacheRead = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{ ...base, shadowedTokenCount: 0, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 'x' } }],
    })))
    expect(() => loadCompactionSummaries(store, badCacheRead)).toThrow(/must carry the full summary shape/)
    const badCacheCreation = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{ ...base, shadowedTokenCount: 0, usage: { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 'x' } }],
    })))
    expect(() => loadCompactionSummaries(store, badCacheCreation)).toThrow(/must carry the full summary shape/)
    const badReasoning = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{ ...base, shadowedTokenCount: 0, usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 'x' } }],
    })))
    expect(() => loadCompactionSummaries(store, badReasoning)).toThrow(/must carry the full summary shape/)
    const emptySeqs = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{ ...base, shadowedSeqs: [], shadowedTokenCount: 0 }],
    })))
    expect(() => loadCompactionSummaries(store, emptySeqs)).toThrow(/must carry the full summary shape/)
    const badBlockType = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{ ...base, summary: [{ text: 'no type' }], shadowedTokenCount: 0 }],
    })))
    expect(() => loadCompactionSummaries(store, badBlockType)).toThrow(/must carry the full summary shape/)
    const badRawType = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{ ...base, shadowedTokenCount: 0, rawOutput: [{ text: 'no type' }] }],
    })))
    expect(() => loadCompactionSummaries(store, badRawType)).toThrow(/must carry the full summary shape/)
  })

  it('rejects a summary with a malformed optional field', () => {
    const store = new PageStore()
    const badCommand = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{
        compactionId: 'c',
        checkpointEventId: 'evt_1',
        markerEventIds: { startEventId: 'evt_10', summaryEventId: 'evt_11', endEventId: 'evt_12' },
        shadowedRange: { startId: 'evt_0', endId: 'evt_1' },
        shadowedIds: ['evt_0'],
        shadowedSeqRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        sourceCommandId: 42,
      }],
    })))
    expect(() => loadCompactionSummaries(store, badCommand)).toThrow(/must carry the full summary shape/)
    const badMaxTokens = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{
        compactionId: 'c',
        checkpointEventId: 'evt_1',
        markerEventIds: { startEventId: 'evt_10', summaryEventId: 'evt_11', endEventId: 'evt_12' },
        shadowedRange: { startId: 'evt_0', endId: 'evt_1' },
        shadowedIds: ['evt_0'],
        shadowedSeqRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        maxTokens: 'x',
      }],
    })))
    expect(() => loadCompactionSummaries(store, badMaxTokens)).toThrow(/must carry the full summary shape/)
  })

  it('round-trips a summary with an unknown block type', () => {
    const store = new PageStore()
    const summaries: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: 'evt_100' as EventId,
      markerEventIds: {
        startEventId: 'evt_10' as EventId,
        summaryEventId: 'evt_11' as EventId,
        endEventId: 'evt_12' as EventId,
      },
      shadowedRange: { startId: 'evt_1' as EventId, endId: 'evt_3' as EventId },
      shadowedIds: ['evt_1' as EventId],
      shadowedSeqRange: { start: 1, end: 1 },
      shadowedSeqs: [1],
      summary: [{ type: 'custom', anything: 1 } as unknown as ContentBlock],
      shadowedTokenCount: 0,
      provider: 'test',
      model: 'test',
    }]
    const page = saveCompactionSummaries(store, summaries)
    expect(loadCompactionSummaries(store, page)).toEqual(summaries)
  })

  it('rejects a summary whose tool-call block lacks required fields', () => {
    const store = new PageStore()
    const bad = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{
        compactionId: 'c',
        checkpointEventId: 'evt_1',
        markerEventIds: { startEventId: 'evt_10', summaryEventId: 'evt_11', endEventId: 'evt_12' },
        shadowedRange: { startId: 'evt_0', endId: 'evt_1' },
        shadowedIds: ['evt_0'],
        shadowedSeqRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        summary: [{ type: 'tool-call', id: 't1' }],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    })))
    expect(() => loadCompactionSummaries(store, bad)).toThrow(/must carry the full summary shape/)
  })

  it('round-trips a summary carrying a valid tool-call block', () => {
    const store = new PageStore()
    const summaries: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: 'evt_100' as EventId,
      markerEventIds: {
        startEventId: 'evt_10' as EventId,
        summaryEventId: 'evt_11' as EventId,
        endEventId: 'evt_12' as EventId,
      },
      shadowedRange: { startId: 'evt_1' as EventId, endId: 'evt_3' as EventId },
      shadowedIds: ['evt_1' as EventId],
      shadowedSeqRange: { start: 1, end: 1 },
      shadowedSeqs: [1],
      summary: [{ type: 'tool-call', id: 't1', name: 'read', arguments: '{}' } as unknown as ContentBlock],
      shadowedTokenCount: 0,
      provider: 'test',
      model: 'test',
    }]
    const page = saveCompactionSummaries(store, summaries)
    expect(loadCompactionSummaries(store, page)).toEqual(summaries)
  })

  it('round-trips a summary with a non-text content block', () => {
    const store = new PageStore()
    const summaries: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: 'evt_100' as EventId,
      markerEventIds: {
        startEventId: 'evt_10' as EventId,
        summaryEventId: 'evt_11' as EventId,
        endEventId: 'evt_12' as EventId,
      },
      shadowedRange: { startId: 'evt_1' as EventId, endId: 'evt_3' as EventId },
      shadowedIds: ['evt_1' as EventId],
      shadowedSeqRange: { start: 1, end: 1 },
      shadowedSeqs: [1],
      summary: [{ type: 'reasoning', text: 'thinking' } as unknown as ContentBlock],
      shadowedTokenCount: 0,
      provider: 'test',
      model: 'test',
    }]
    const page = saveCompactionSummaries(store, summaries)
    expect(loadCompactionSummaries(store, page)).toEqual(summaries)
  })

  it('round-trips a summary carrying the llmStreamCall discriminant', () => {
    const store = new PageStore()
    const summaries: CompactionSummary[] = [{
      compactionId: 'compact_1' as CompactionId,
      checkpointEventId: 'evt_100' as EventId,
      markerEventIds: {
        startEventId: 'evt_10' as EventId,
        summaryEventId: 'evt_11' as EventId,
        endEventId: 'evt_12' as EventId,
      },
      shadowedRange: { startId: 'evt_1' as EventId, endId: 'evt_3' as EventId },
      shadowedIds: ['evt_1' as EventId],
      shadowedSeqRange: { start: 1, end: 1 },
      shadowedSeqs: [1],
      summary: [],
      shadowedTokenCount: 0,
      provider: 'test',
      model: 'test',
      llmStreamCall: true,
      rawOutput: [{ type: 'text', text: 'raw' }],
    }]
    const page = saveCompactionSummaries(store, summaries)
    const loaded = loadCompactionSummaries(store, page)
    expect(loaded[0]?.llmStreamCall).toBe(true)
    expect(loaded[0]?.rawOutput).toEqual([{ type: 'text', text: 'raw' }])
  })

  it('rejects a summary whose text content block lacks the text field', () => {
    const store = new PageStore()
    const bad = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{
        compactionId: 'c',
        checkpointEventId: 'evt_1',
        markerEventIds: { startEventId: 'evt_10', summaryEventId: 'evt_11', endEventId: 'evt_12' },
        shadowedRange: { startId: 'evt_0', endId: 'evt_1' },
        shadowedIds: ['evt_0'],
        shadowedSeqRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        summary: [{ type: 'text' }],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
      }],
    })))
    expect(() => loadCompactionSummaries(store, bad)).toThrow(/must carry the full summary shape/)
  })

  it('rejects a summary with llmStreamCall true but no raw output', () => {
    const store = new PageStore()
    const bad = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{
        compactionId: 'c',
        checkpointEventId: 'evt_1',
        markerEventIds: { startEventId: 'evt_10', summaryEventId: 'evt_11', endEventId: 'evt_12' },
        shadowedRange: { startId: 'evt_0', endId: 'evt_1' },
        shadowedIds: ['evt_0'],
        shadowedSeqRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        llmStreamCall: true,
      }],
    })))
    expect(() => loadCompactionSummaries(store, bad)).toThrow(/must carry the full summary shape/)
    const badFlag = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{
        compactionId: 'c',
        checkpointEventId: 'evt_1',
        markerEventIds: { startEventId: 'evt_10', summaryEventId: 'evt_11', endEventId: 'evt_12' },
        shadowedRange: { startId: 'evt_0', endId: 'evt_1' },
        shadowedIds: ['evt_0'],
        shadowedSeqRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        llmStreamCall: 'x',
      }],
    })))
    expect(() => loadCompactionSummaries(store, badFlag)).toThrow(/must carry the full summary shape/)
    const falseFlag = store.writePage(new TextEncoder().encode(JSON.stringify({
      summaries: [{
        compactionId: 'c',
        checkpointEventId: 'evt_1',
        markerEventIds: { startEventId: 'evt_10', summaryEventId: 'evt_11', endEventId: 'evt_12' },
        shadowedRange: { startId: 'evt_0', endId: 'evt_1' },
        shadowedIds: ['evt_0'],
        shadowedSeqRange: { start: 1, end: 1 },
        shadowedSeqs: [1],
        summary: [],
        shadowedTokenCount: 0,
        provider: 'test',
        model: 'test',
        llmStreamCall: false,
      }],
    })))
    expect(() => loadCompactionSummaries(store, falseFlag)).toThrow(/must carry the full summary shape/)
  })

  it('round-trips an empty compaction summary log', () => {
    const store = new PageStore()
    const page = saveCompactionSummaries(store, [])
    expect(loadCompactionSummaries(store, page)).toEqual([])
  })
})

function chainEncode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('blob map chain', () => {
  it('appends blobs incrementally and loads the merged map', () => {
    const store = new PageStore()
    let head: PageId | undefined
    head = saveBlobAppends(store, head, new Map([['blob_1' as BlobId, chainEncode('one')]]))
    head = saveBlobAppends(store, head, new Map([['blob_2' as BlobId, chainEncode('two')]]))
    const loaded = loadBlobChain(store, head)
    expect(loaded.size).toBe(2)
    expect(new TextDecoder().decode(loaded.get('blob_1' as BlobId))).toBe('one')
    expect(new TextDecoder().decode(loaded.get('blob_2' as BlobId))).toBe('two')
  })

  it('loads a standalone pre-chain map page', () => {
    const store = new PageStore()
    const page = saveBlobMap(store, new Map([['blob_1' as BlobId, chainEncode('one')]]))
    const loaded = loadBlobChain(store, page)
    expect(loaded.size).toBe(1)
  })

  it('rejects the same blob id with different bytes across chain pages', () => {
    const store = new PageStore()
    let head: PageId | undefined
    head = saveBlobAppends(store, head, new Map([['blob_1' as BlobId, chainEncode('one')]]))
    head = saveBlobAppends(store, head, new Map([['blob_1' as BlobId, chainEncode('two')]]))
    expect(() => loadBlobChain(store, head)).toThrow(/different bytes/)
  })

  it('rejects a chain page cycle', () => {
    // Two pages pointing at each other, hand-built in an injectable backing
    // map (the immutable store cannot produce a cycle itself).
    const backing = new Map<PageId, Uint8Array>()
    const store = new PageStore(backing)
    const chainPage = (pageId: PageId, prev: PageId | undefined): void => {
      backing.set(pageId, encodePage(pageId, new TextEncoder().encode(JSON.stringify({
        kind: 'blob-appends',
        ...(prev === undefined ? {} : { prev }),
        blobs: {},
      }))))
    }
    chainPage('page_0' as PageId, 'page_1' as PageId)
    chainPage('page_1' as PageId, 'page_0' as PageId)
    expect(() => loadBlobChain(store, 'page_0' as PageId)).toThrow(/cycle/)
  })
})
