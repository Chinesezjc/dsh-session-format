/**
 * Durable page store: all pages live in one append-only segment file,
 * addressed by (segment, offset, length) instead of one file per page, so a
 * small page occupies only its own bytes and one flush covers every page
 * written since the previous flush. The synchronous surface mirrors the
 * in-memory {@link PageStore} so the engine and repository can switch backends
 * without an async rewrite.
 *
 * Layout under the root directory: `pages.bin` holds the segment (a sequence
 * of `[containerLen u32][encodePage container]` entries) and `meta.json`
 * persists the next page id and the flushed byte watermark. `writePage`
 * appends to the segment without fsync; {@link DiskPageStore.flush} fsyncs the
 * segment and atomically advances the watermark, so one flush covers all pages
 * written since the last one. A rebuild scans the segment and decodes every
 * entry until the first failure: entries inside the watermark that fail decode
 * are corruption (fail loud), entries past it are unconfirmed bytes (a crash
 * window) and stop the scan silently, and the trailing residue is truncated.
 * @module @deepseek-ai/dsh-session-format/disk-page-store
 */

import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicDurableSync } from './atomic-write-sync.ts'
import type { PageId } from './index.ts'
import { decodePage, encodePage } from './pages.ts'

const PAGES_FILE = 'pages.bin'
const META_FILE = 'meta.json'
/** Size of the per-entry length header in the segment file. */
const ENTRY_HEADER = 4

/** Physical location of one page inside the segment file. */
interface PageLocation {
  readonly segment: number
  readonly offset: number
  readonly length: number
}

/** Persisted control fields of the store. */
interface PersistedMeta {
  readonly nextPageId: number
  readonly watermark: number
}

/** Read and validate the persisted meta file.
 * A missing file is a fresh store; a pre-segment meta file (which carries only
 * `nextPageId`) is accepted with watermark 0, matching the pre-release stance
 * that old on-disk layouts are not migrated.
 * @param path - meta file path.
 * @returns the persisted control fields, or zeros when no meta file exists.
 */
function readMeta(path: string): PersistedMeta {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { nextPageId: 0, watermark: 0 }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`corrupt page watermark file ${path}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`corrupt page watermark file ${path}`)
  }
  const next = (parsed as { readonly nextPageId?: unknown }).nextPageId
  if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 0) {
    throw new Error(`page watermark file ${path} must carry a non-negative safe-integer nextPageId`)
  }
  const watermark = (parsed as { readonly watermark?: unknown }).watermark
  if (watermark !== undefined && (typeof watermark !== 'number' || !Number.isSafeInteger(watermark) || watermark < 0)) {
    throw new Error(`page watermark file ${path} must carry a non-negative safe-integer watermark`)
  }
  return { nextPageId: next, watermark: watermark === undefined ? 0 : watermark }
}

/** Scan the segment file and rebuild the page index.
 * Entries are decoded in order; the scan stops at the first entry that cannot
 * be decoded or does not fit. A decode failure inside the persisted watermark
 * is corruption and fails loud; a failure at or past the watermark is
 * unconfirmed residue (a crash before flush) and stops the scan silently.
 * @param fd - segment file descriptor.
 * @param fileSize - current segment file size.
 * @param watermark - flushed byte offset; entries before it must decode.
 * @returns the rebuilt index and the offset of the last fully decoded entry.
 */
function scanPages(fd: number, fileSize: number, watermark: number): { index: Map<PageId, PageLocation>; scannedEnd: number } {
  const index = new Map<PageId, PageLocation>()
  const lengthHeader = new Uint8Array(ENTRY_HEADER)
  let pos = 0
  while (pos < fileSize) {
    if (fileSize - pos < ENTRY_HEADER) break
    const headerRead = readSync(fd, lengthHeader, 0, ENTRY_HEADER, pos)
    if (headerRead !== ENTRY_HEADER) break
    const containerLen = new DataView(lengthHeader.buffer).getUint32(0, false)
    if (containerLen === 0 || containerLen > fileSize - pos - ENTRY_HEADER) break
    const entry = new Uint8Array(ENTRY_HEADER + containerLen)
    entry.set(lengthHeader, 0)
    const bodyRead = readSync(fd, entry.subarray(ENTRY_HEADER), 0, containerLen, pos + ENTRY_HEADER)
    if (bodyRead !== containerLen) break
    let decoded: { readonly pageId: PageId; readonly payload: Uint8Array }
    try {
      decoded = decodePage(entry.subarray(ENTRY_HEADER))
    } catch (error) {
      if (pos < watermark) {
        throw new Error(`corrupt page container at offset ${pos}: ${(error as Error).message}`)
      }
      break
    }
    index.set(decoded.pageId, { segment: 0, offset: pos + ENTRY_HEADER, length: containerLen })
    pos += ENTRY_HEADER + containerLen
  }
  return { index, scannedEnd: pos }
}

/**
 * A page-addressed store persisted as one append-only segment file, with
 * checksum verification on every read and persisted next-id and byte
 * watermarks. Page ids never identify different bytes, so neither watermark is
 * ever lowered by deletion: a page id freed by GC stays retired even after the
 * store is rebuilt. Durability is two-phase: {@link DiskPageStore.writePage}
 * appends to the segment (visible to the same process immediately), and
 * {@link DiskPageStore.flush} fsyncs the segment and advances the byte
 * watermark, so a crash after a write but before its flush leaves the bytes
 * beyond the watermark as ignorable residue, never a page whose bytes differ
 * from what the writer produced.
 */
export class DiskPageStore {
  private readonly rootDir: string
  private readonly pagesPath: string
  private readonly metaPath: string
  private index = new Map<PageId, PageLocation>()
  private nextPageId: number
  private watermark: number
  private logicalEnd: number
  private fd: number

  /**
   * Open (or create) a page store rooted at `rootDir`. The segment file is
   * scanned and every decodable page is registered; the next-id watermark is
   * the greater of the persisted watermark and the scanned maximum plus one,
   * so a crash between a page write and its watermark update never reuses the
   * written page id. Undecodable residue past the persisted byte watermark is
   * truncated.
   * @param rootDir - directory owning `pages.bin` and `meta.json`.
   */
  constructor(rootDir: string) {
    this.rootDir = rootDir
    this.pagesPath = join(rootDir, PAGES_FILE)
    this.metaPath = join(rootDir, META_FILE)
    mkdirSync(rootDir, { recursive: true })
    const meta = readMeta(this.metaPath)
    this.fd = openSync(this.pagesPath, 'a+', 0o600)
    const fileSize = fstatSync(this.fd).size
    const { index, scannedEnd } = scanPages(this.fd, fileSize, meta.watermark)
    if (scannedEnd < meta.watermark) {
      closeSync(this.fd)
      throw new Error('page segment is shorter than the persisted watermark; page data is lost')
    }
    this.index = index
    this.watermark = meta.watermark
    // Residue past the scanned end is unconfirmed; truncate it so the segment
    // does not grow with crash-window garbage.
    if (scannedEnd < fileSize) {
      ftruncateSync(this.fd, scannedEnd)
    }
    this.logicalEnd = scannedEnd
    let maxScannedId = -1
    for (const id of index.keys()) {
      const match = /^page_(\d+)$/.exec(id)
      if (match === null) throw new Error(`page id ${id} is not a canonical page_<n> id`)
      const numeric = Number(match[1])
      if (!Number.isSafeInteger(numeric)) throw new Error(`page id ${id} is not a safe integer`)
      maxScannedId = Math.max(maxScannedId, numeric)
    }
    const resumed = Math.max(meta.nextPageId, maxScannedId + 1)
    if (!Number.isSafeInteger(resumed)) {
      throw new Error('page id counter would exceed the safe-integer range')
    }
    this.nextPageId = resumed
  }

  /** Write a payload as a new immutable page and return its PageId.
   * The page bytes are appended to the segment immediately (readable by this
   * process right away) and become crash-durable at the next flush.
   * @param payload - page payload bytes.
   * @returns the page id of the written page.
   */
  writePage(payload: Uint8Array): PageId {
    if (!Number.isSafeInteger(this.nextPageId + 1)) {
      throw new Error('page id counter would exceed the safe-integer range')
    }
    const pageId = `page_${this.nextPageId++}` as PageId
    const bytes = encodePage(pageId, payload)
    const entry = new Uint8Array(ENTRY_HEADER + bytes.length)
    new DataView(entry.buffer).setUint32(0, bytes.length, false)
    entry.set(bytes, ENTRY_HEADER)
    writeSync(this.fd, entry)
    this.index.set(pageId, { segment: 0, offset: this.logicalEnd + ENTRY_HEADER, length: bytes.length })
    this.logicalEnd += entry.length
    return pageId
  }

  /** Fsync the segment and persist the byte watermark, covering every page
   * written since the previous flush in one sync. A no-op when nothing was
   * written since the previous flush.
   */
  flush(): void {
    if (this.logicalEnd === this.watermark) return
    fsyncSync(this.fd)
    this.watermark = this.logicalEnd
    writeFileAtomicDurableSync(
      this.metaPath,
      new TextEncoder().encode(JSON.stringify({ nextPageId: this.nextPageId, watermark: this.watermark })),
      0o600,
    )
  }

  /** Read and verify a page payload.
   * @param pageId - page id to read.
   * @returns an independent copy of the page payload; mutating it cannot corrupt the store.
   */
  readPage(pageId: PageId): Uint8Array {
    const loc = this.index.get(pageId)
    if (loc === undefined) throw new Error(`missing page ${pageId}`)
    const encoded = new Uint8Array(loc.length)
    const read = readSync(this.fd, encoded, 0, loc.length, loc.offset)
    if (read !== loc.length) throw new Error(`missing page ${pageId}`)
    const decoded = decodePage(encoded)
    if (decoded.pageId !== pageId) throw new Error(`page id mismatch: expected ${pageId}, got ${decoded.pageId}`)
    // Uint8Array.from forces a copy even when the buffer aliases a Buffer.
    return Uint8Array.from(decoded.payload)
  }

  /** Number of pages currently registered.
   * @returns the registered page count.
   */
  get size(): number {
    return this.index.size
  }

  /** Whether a page id is registered.
   * @param pageId - page id to test.
   * @returns true when the page id is registered.
   */
  has(pageId: PageId): boolean {
    return this.index.has(pageId)
  }

  /** Retire a page id without reclaiming its bytes. The bytes stay in the
   * segment until {@link DiskPageStore.retain} rewrites the segment, and the
   * next-id watermark is not lowered, so a rebuilt store never reissues the
   * page id. Callers that want a rebuilt store to forget the page run retain
   * (garbage collection) before reopening.
   * @param pageId - page id to delete.
   */
  deletePage(pageId: PageId): void {
    this.index.delete(pageId)
  }

  /** Rewrite the segment to contain exactly the retained pages and return how
   * many pages were removed. This is the garbage-collection compaction point:
   * the retained pages' bytes are copied into a fresh segment file, the
   * replacement is fsynced and renamed over the old one, and both watermarks
   * reset, so the segment stops carrying deleted and orphaned bytes.
   * @param pageIds - page ids to retain; everything else is dropped.
   * @returns the number of pages removed.
   */
  retain(pageIds: Iterable<PageId>): number {
    const keep = new Set(pageIds)
    const removed = this.index.size - keep.size
    // Rewrite the segment whenever it carries bytes outside the retained
    // pages: pages deleted earlier (whose ids are already gone from the index)
    // and copy-on-write orphans still occupy segment bytes, so the count check
    // alone would leave them behind to be revived by a rebuild.
    let retainedBytes = 0
    for (const [id, loc] of this.index) {
      if (keep.has(id)) retainedBytes += loc.length + ENTRY_HEADER
    }
    if (removed === 0 && this.logicalEnd === retainedBytes) return 0
    const ids = [...this.index.keys()].sort((a, b) => {
      const na = Number(a.slice('page_'.length))
      const nb = Number(b.slice('page_'.length))
      return na - nb
    })
    const compactPath = join(this.rootDir, `${PAGES_FILE}.compact`)
    const newFd = openSync(compactPath, 'w', 0o600)
    const newIndex = new Map<PageId, PageLocation>()
    let offset = 0
    try {
      for (const id of ids) {
        if (!keep.has(id)) continue
        const loc = this.index.get(id)
        if (loc === undefined) continue
        const entry = new Uint8Array(ENTRY_HEADER + loc.length)
        new DataView(entry.buffer).setUint32(0, loc.length, false)
        const body = entry.subarray(ENTRY_HEADER)
        const read = readSync(this.fd, body, 0, loc.length, loc.offset)
        if (read !== loc.length) throw new Error(`missing page ${id} during compaction`)
        writeSync(newFd, entry)
        newIndex.set(id, { segment: 0, offset: offset + ENTRY_HEADER, length: loc.length })
        offset += entry.length
      }
      fsyncSync(newFd)
    } finally {
      closeSync(newFd)
    }
    closeSync(this.fd)
    renameSync(compactPath, this.pagesPath)
    this.fd = openSync(this.pagesPath, 'a+', 0o600)
    this.index = newIndex
    this.logicalEnd = offset
    this.watermark = offset
    writeFileAtomicDurableSync(
      this.metaPath,
      new TextEncoder().encode(JSON.stringify({ nextPageId: this.nextPageId, watermark: this.watermark })),
      0o600,
    )
    return removed
  }

  /** All page ids currently registered, in numeric id order.
   * @returns the registered page ids in ascending id order.
   */
  pageIds(): PageId[] {
    return [...this.index.keys()].sort((a, b) => {
      const na = Number(a.slice('page_'.length))
      const nb = Number(b.slice('page_'.length))
      return na - nb
    })
  }

  /** Root directory owning the store's `pages.bin` and `meta.json`.
   * @returns the constructor-provided root directory.
   */
  get directory(): string {
    return this.rootDir
  }
}
