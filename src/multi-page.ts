/**
 * Multi-page B+Tree persistence: each node is serialized into its own
 * checksummed page. Internal nodes reference child pages by PageId.
 * @module @deepseek-ai/dsh-session-format/multi-page
 */

import { toArray, fromEntries, type LeafEntry, type TreeNode } from './btree.ts'
import type { BlobId, EventId, PageId } from './index.ts'
import type { PageStore } from './page-store.ts'

// Fanout caps mirror btree.ts; 64 entries stand in for the 4 KB physical page
// the durable format commits (see btree.ts).
export const MAX_ENTRIES = 64
export const MAX_KEYS = 64

/** Flattened entries must be strictly increasing and carry unique EventIds.
 * Mirrors btree.ts's cross-leaf invariant check for pages rebuilt by hand.
 * @param entries - leaf entries to validate.
 */
function assertOrderedUnique(entries: readonly LeafEntry[]): void {
  let previous = -Infinity
  const seen = new Set<EventId>()
  for (const entry of entries) {
    if (seen.has(entry.eventId)) throw new Error(`duplicate EventId ${entry.eventId}`)
    seen.add(entry.eventId)
    if (!Number.isFinite(entry.order) || entry.order <= previous) {
      throw new Error('page entries must be strictly increasing order')
    }
    previous = entry.order
  }
}

/** The smallest order present in a subtree: an internal node's leftmost leaf.
 * @param node - tree node.
 * @returns the first leaf entry's order.
 */
function must<T>(value: T | undefined, message: string): T {
  /* v8 ignore next -- every caller passes a value guaranteed present by tree invariants. */
  if (value === undefined) throw new Error(message)
  return value
}

function firstOrder(node: TreeNode): number {
  if (node.kind === 'leaf') return must(node.entries[0], 'empty leaf').order
  return firstOrder(must(node.children[0], 'empty internal'))
}

/** Whether a loaded node is a leaf.
 * @param node - tree node.
 * @returns true for a leaf node.
 */
function isLeafNode(node: TreeNode): node is Extract<TreeNode, { readonly kind: 'leaf' }> {
  return node.kind === 'leaf'
}

/** Depth of a loaded subtree, for height-consistency checks.
 * @param node - tree node.
 * @returns the node depth.
 */
function depthOf(node: TreeNode): number {
  /* v8 ignore start -- fromInternal rejects an empty children array before any depth walk. */
  if (isLeafNode(node)) return 0
  const first = node.children[0]
  if (first === undefined) throw new Error('internal page must not be empty')
  return 1 + depthOf(first)
  /* v8 ignore stop */
}

/** Save a B+Tree as one page per node and return the root PageId.
 * @param store - page store to write into.
 * @param root - tree root node, or undefined for an empty tree.
 * @returns the page id of the serialized root node.
 */
export function saveMultiPageTree(store: PageStore, root: TreeNode | undefined): PageId {
  if (root === undefined) {
    return store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'leaf', entries: [] })))
  }
  return saveNode(store, root)
}

function saveNode(store: PageStore, node: TreeNode): PageId {
  if (isLeafNode(node)) {
    const serialized = { kind: 'leaf' as const, entries: [...node.entries] }
    return store.writePage(new TextEncoder().encode(JSON.stringify(serialized)))
  }
  const childPages = node.children.map(child => saveNode(store, child))
  const serialized = {
    kind: 'internal' as const,
    keys: [...node.keys],
    children: childPages,
  }
  return store.writePage(new TextEncoder().encode(JSON.stringify(serialized)))
}

/** Load a B+Tree from a root page.
 * @param store - page store to read from.
 * @param rootPage - page id of the serialized root node.
 * @returns the reconstructed tree root, or undefined for an empty tree.
 */
export function loadMultiPageTree(store: PageStore, rootPage: PageId): TreeNode | undefined {
  const loaded = loadNode(store, rootPage, new Set())
  if (loaded !== undefined) {
    // Cross-leaf invariants: the flattened tree must be strictly increasing
    // and carry no duplicated EventId across sibling leaves.
    assertOrderedUnique(toArray(loaded))
  }
  return loaded
}

function loadNode(store: PageStore, pageId: PageId, visited: Set<PageId>): TreeNode | undefined {
  if (visited.has(pageId)) {
    throw new Error(`page ${pageId} referenced more than once or in a cycle`)
  }
  visited.add(pageId)
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(store.readPage(pageId)))
  if (!isRecord(parsed) || parsed.kind !== 'leaf' && parsed.kind !== 'internal') {
    throw new Error(`page ${pageId} must be a leaf or internal tree node`)
  }
  if (parsed.kind === 'leaf') {
    const entries = parseLeafEntries(parsed, pageId)
    return fromEntries(entries)
  }
  return fromInternal(store, parsed, pageId, visited)
}

function parseLeafEntries(node: Record<string, unknown>, pageId: PageId): LeafEntry[] {
  if (!Array.isArray(node.entries)) throw new Error(`leaf page ${pageId} must carry an entries array`)
  const entries = node.entries.map((item, index) => {
    if (!isRecord(item)
      || typeof item.order !== 'number' || !Number.isFinite(item.order)
      || typeof item.eventId !== 'string'
      || typeof item.blobId !== 'string') {
      throw new Error(`leaf page ${pageId} entry ${index} must carry order, eventId, and blobId`)
    }
    return { order: item.order, eventId: item.eventId as EventId, blobId: item.blobId as BlobId }
  })
  assertOrderedUnique(entries)
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`leaf page ${pageId} holds ${entries.length} entries, above the per-node cap ${MAX_ENTRIES}`)
  }
  return entries
}

function fromInternal(store: PageStore, node: Record<string, unknown>, pageId: PageId, visiting: Set<PageId>): TreeNode {
  if (!Array.isArray(node.children)
    || !node.children.every((child): child is PageId => typeof child === 'string')
    || !Array.isArray(node.keys)
    || !node.keys.every((key): key is number => typeof key === 'number' && Number.isFinite(key))) {
    throw new Error(`internal page ${pageId} must carry a keys number array and a children page-id array`)
  }
  // The writer (btree.ts) only produces internal nodes with at least two
  // children; a single-child internal node is a corrupt or hand-built page
  // and must be rejected before any child page is read. The fanout caps are
  // also checked here, ahead of the recursive traversal, so a damaged page
  // declaring an oversized children array cannot make the loader read a
  // large set of child pages before the rejection.
  if (node.children.length < 2
    || node.children.length > MAX_KEYS + 1
    || node.keys.length > MAX_KEYS
    || node.keys.length !== node.children.length - 1) {
    throw new Error(`invalid internal page: ${node.keys.length} keys for ${node.children.length} children`)
  }
  const children: TreeNode[] = []
  for (const childPage of node.children) {
    const child = loadNode(store, childPage, visiting)
    // An empty tree exists only as an empty root leaf; a child that loads to
    // nothing is a corrupt page and must be rejected, not silently dropped.
    if (child === undefined) throw new Error(`internal page references empty child page ${childPage}`)
    children.push(child)
  }
  const childDepths = new Set<number>()
  for (const child of children) childDepths.add(depthOf(child))
  if (childDepths.size > 1) throw new Error('internal page children must share one depth')
  for (let index = 1; index < node.keys.length; index += 1) {
    const previous = node.keys[index - 1]
    const current = node.keys[index]
    if (previous === undefined || current === undefined || current <= previous) {
      throw new Error('internal page keys must be strictly increasing')
    }
  }
  for (let index = 0; index < node.keys.length; index += 1) {
    const key = node.keys[index]
    const child = children[index + 1]
    if (key === undefined || child === undefined || firstOrder(child) !== key) {
      throw new Error('internal page keys must match the first order of each child')
    }
  }
  const lastChild = children[children.length - 1]
  return {
    kind: 'internal',
    size: children.reduce((sum, child) => sum + child.size, 0),
    maxOrder: lastChild === undefined ? -Infinity : lastChild.maxOrder,
    keys: [...node.keys],
    children,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One page-level tree node: a leaf or internal node parsed from one page
 * without loading its subtree.
 */
type TreeNodePage =
  | { readonly kind: 'leaf'; readonly entries: readonly LeafEntry[] }
  | { readonly kind: 'internal'; readonly keys: readonly number[]; readonly children: readonly PageId[] }

/** Parse one tree-node page at page level, validating its structure without
 * loading the subtree. Mirrors {@link loadNode}'s per-page checks.
 * @param store - page store holding the tree.
 * @param pageId - node page to parse.
 * @returns the parsed node page.
 */
function readTreeNode(store: PageStore, pageId: PageId): TreeNodePage {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(store.readPage(pageId)))
  if (!isRecord(parsed) || parsed.kind !== 'leaf' && parsed.kind !== 'internal') {
    throw new Error(`page ${pageId} must be a leaf or internal tree node`)
  }
  if (parsed.kind === 'leaf') {
    return { kind: 'leaf', entries: parseLeafEntries(parsed, pageId) }
  }
  if (!Array.isArray(parsed.children)
    || !parsed.children.every((child): child is PageId => typeof child === 'string')
    || !Array.isArray(parsed.keys)
    || !parsed.keys.every((key): key is number => typeof key === 'number' && Number.isFinite(key))) {
    throw new Error(`internal page ${pageId} must carry a keys number array and a children page-id array`)
  }
  if (parsed.children.length < 2
    || parsed.children.length > MAX_KEYS + 1
    || parsed.keys.length > MAX_KEYS
    || parsed.keys.length !== parsed.children.length - 1) {
    throw new Error(`invalid internal page ${pageId}: ${parsed.keys.length} keys for ${parsed.children.length} children`)
  }
  for (let index = 1; index < parsed.keys.length; index += 1) {
    if (parsed.keys[index]! <= parsed.keys[index - 1]!) {
      throw new Error(`internal page ${pageId} keys must be strictly increasing`)
    }
  }
  return { kind: 'internal', keys: [...parsed.keys], children: [...parsed.children] }
}

/** The smallest order present in a subtree root page.
 * @param store - page store holding the tree.
 * @param pageId - subtree root page.
 * @returns the first entry's order.
 */
function firstOrderOf(store: PageStore, pageId: PageId): number {
  let current = pageId
  for (;;) {
    const node = readTreeNode(store, current)
    if (node.kind === 'leaf') {
      const first = node.entries[0]
      if (first === undefined) throw new Error(`leaf page ${current} is empty`)
      return first.order
    }
    const firstChild = node.children[0]
    if (firstChild === undefined) throw new Error(`internal page ${current} must not be empty`)
    current = firstChild
  }
}

function writeLeafPage(store: PageStore, entries: readonly LeafEntry[]): PageId {
  return store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'leaf', entries: [...entries] })))
}

function writeInternalPage(store: PageStore, keys: readonly number[], children: readonly PageId[]): PageId {
  return store.writePage(new TextEncoder().encode(JSON.stringify({ kind: 'internal', keys: [...keys], children: [...children] })))
}

/** Result of appending into one subtree: the subtree's new root page and,
 * when the root split, the new right sibling page.
 */
interface AppendResult {
  readonly rootPage: PageId
  readonly split?: PageId
}

/** Append one entry to the rightmost leaf of a subtree, copying the rightmost
 * path. Each level writes at most two new pages (the copied node and, on a
 * split, its right sibling), so the whole append writes O(depth) pages and
 * reads O(depth) pages. Throws when the entry order cannot advance (the
 * rightmost order is at the number ceiling); callers fall back to a full
 * renumber in that case.
 * @param store - page store holding the tree.
 * @param pageId - subtree root page.
 * @param eventId - identity of the appended event.
 * @param blobId - blob holding the event payload.
 * @returns the new subtree root page and any split sibling.
 */
function appendInto(store: PageStore, pageId: PageId, eventId: EventId, blobId: BlobId): AppendResult {
  const node = readTreeNode(store, pageId)
  if (node.kind === 'leaf') {
    const last = node.entries[node.entries.length - 1]
    const maxOrder = last === undefined ? -1 : last.order
    const nextOrder = maxOrder + 1
    if (nextOrder <= maxOrder) {
      throw new Error('tree order cannot advance within the safe number range; full renumber required')
    }
    const entries = [...node.entries, { order: nextOrder, eventId, blobId }]
    if (entries.length <= MAX_ENTRIES) return { rootPage: writeLeafPage(store, entries) }
    const mid = Math.ceil(entries.length / 2)
    return {
      rootPage: writeLeafPage(store, entries.slice(0, mid)),
      split: writeLeafPage(store, entries.slice(mid)),
    }
  }
  const lastChild = node.children[node.children.length - 1]
  if (lastChild === undefined) throw new Error(`internal page ${pageId} must not be empty`)
  const result = appendInto(store, lastChild, eventId, blobId)
  const children = [...node.children]
  children[children.length - 1] = result.rootPage
  const keys = [...node.keys]
  if (result.split !== undefined) {
    children.push(result.split)
    keys.push(firstOrderOf(store, result.split))
  }
  if (keys.length <= MAX_KEYS) return { rootPage: writeInternalPage(store, keys, children) }
  const mid = Math.ceil(keys.length / 2)
  return {
    rootPage: writeInternalPage(store, keys.slice(0, mid), children.slice(0, mid + 1)),
    split: writeInternalPage(store, keys.slice(mid + 1), children.slice(mid + 1)),
  }
}

/** Append one event to the rightmost leaf of a persisted B+Tree by copying
 * the rightmost path, and return the new root page. Writes O(depth) pages
 * instead of rewriting every node, so append stays O(log n) in the tree size;
 * a root split mints a new internal root. Throws when the entry order cannot
 * advance (see {@link appendInto}); callers fall back to a full renumber.
 * @param store - page store holding the tree.
 * @param rootPage - current root page; may be an empty leaf page.
 * @param eventId - identity of the appended event.
 * @param blobId - blob holding the event payload.
 * @returns the new root page.
 */
export function appendEntryToTree(store: PageStore, rootPage: PageId, eventId: EventId, blobId: BlobId): PageId {
  const result = appendInto(store, rootPage, eventId, blobId)
  if (result.split === undefined) return result.rootPage
  const keys = [firstOrderOf(store, result.split)]
  return writeInternalPage(store, keys, [result.rootPage, result.split])
}
