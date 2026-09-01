/**
 * Multi-page B+Tree persistence: each node is serialized into its own
 * checksummed page. Internal nodes reference child pages by PageId.
 * @module @deepseek-ai/dsh-session-format/multi-page
 */

import { toArray, fromEntries, type LeafEntry, type TreeNode } from './btree.ts'
import type { BlobId, EventId, PageId } from './index.ts'
import type { PageStore } from './page-store.ts'

// Fanout caps mirror btree.ts; the durable page format proposed in the Agent
// Note fixes 4 KB pages, and these small prototype constants keep the split
// paths cheap to exercise without committing a page size.
const MAX_ENTRIES = 4
const MAX_KEYS = 4

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
  return { kind: 'internal', keys: [...node.keys], children }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
