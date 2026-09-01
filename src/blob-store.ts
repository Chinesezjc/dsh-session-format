/**
 * Prototype blob store with 2MB logical segments and physical BlobLocations.
 * @module @deepseek-ai/dsh-session-format/blob-store
 */

import type { BlobId, BlobLocation } from './index.ts'

/** Size of one blob segment in bytes. */
export const BLOB_SEGMENT_SIZE = 2 * 1024 * 1024

/**
 * Prefix for BlobIds minted by this store. It is distinct from the
 * `blob_<seq>` ids minted by migration and compaction, so both id families
 * can coexist in one blob mapping without collision.
 */
const BLOB_ID_PREFIX = 'blob_seg_'

/**
 * In-memory blob store segmented into fixed-size allocation units.
 * Blob payloads are immutable: writes copy the input bytes and reads return
 * independent copies. Deleted blobs leave their physical space in place until
 * a future GC pass reclaims it; writes always append at the segment high-water
 * mark and never reuse released space, so each write allocates in O(1) without
 * scanning the live mapping.
 */
export class BlobStore {
  private readonly segments: Uint8Array[] = []
  private readonly highWaterMarks: number[] = []
  private readonly mapping = new Map<BlobId, BlobLocation>()
  private nextBlobId = 0

  /**
   * Write a blob and return its logical BlobId.
   * @param bytes - immutable payload bytes; must fit in one segment.
   * @returns the logical id of the stored blob.
   */
  writeBlob(bytes: Uint8Array): BlobId {
    if (bytes.byteLength > BLOB_SEGMENT_SIZE) {
      throw new Error(`blob exceeds segment size (${bytes.byteLength} > ${BLOB_SEGMENT_SIZE})`)
    }
    const segmentIndex = this.targetSegmentIndex(bytes.byteLength)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- targetSegmentIndex returned an in-bounds slot
    const offset = this.highWaterMarks[segmentIndex]!
    // oxlint-disable-next-line typescript/no-non-null-assertion -- segments and highWaterMarks are appended together
    this.segments[segmentIndex]!.set(bytes, offset)
    this.highWaterMarks[segmentIndex] = offset + bytes.byteLength
    const blobId = `${BLOB_ID_PREFIX}${this.nextBlobId++}` as BlobId
    this.mapping.set(blobId, { segment: segmentIndex, offset, length: bytes.byteLength })
    return blobId
  }

  /** Segment index that can hold a blob of the given length. */
  private targetSegmentIndex(byteLength: number): number {
    const lastIndex = this.segments.length - 1
    if (lastIndex < 0) {
      this.segments.push(new Uint8Array(BLOB_SEGMENT_SIZE))
      this.highWaterMarks.push(0)
      return 0
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- lastIndex is in-bounds when a segment exists
    if (this.highWaterMarks[lastIndex]! + byteLength > BLOB_SEGMENT_SIZE) {
      this.segments.push(new Uint8Array(BLOB_SEGMENT_SIZE))
      this.highWaterMarks.push(0)
      return lastIndex + 1
    }
    return lastIndex
  }

  /**
   * Read a blob payload by logical BlobId.
   * @param blobId - logical id returned by a previous writeBlob call.
   * @returns an independent copy of the stored payload.
   */
  readBlob(blobId: BlobId): Uint8Array {
    const location = this.mapping.get(blobId)
    if (location === undefined) throw new Error(`missing blob ${blobId}`)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- every recorded location points at an allocated segment
    return this.segments[location.segment]!.slice(location.offset, location.offset + location.length)
  }

  /**
   * Logically delete a blob. The physical space stays allocated until a
   * future GC pass reclaims it.
   * @param blobId - logical id to delete.
   */
  deleteBlob(blobId: BlobId): void {
    this.mapping.delete(blobId)
  }

  /** Number of logical blobs currently stored. */
  get size(): number {
    return this.mapping.size
  }

  /** Number of allocated segments. */
  get segmentCount(): number {
    return this.segments.length
  }
}
