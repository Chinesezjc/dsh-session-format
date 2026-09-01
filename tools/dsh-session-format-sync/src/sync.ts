/**
 * Core sync logic for the standalone dsh-session-format repo: extract the
 * latest session-format content from the deepseek-harness source tree, re-apply
 * the standalone adaptation layer (EventId and writeFileAtomicDurable are
 * owned locally because the npm releases of dsh-session and dsh-atomic-write
 * do not carry the stack-added APIs), verify with tsc + vitest, and commit.
 * @module dsh-session-format-sync/sync
 */

import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Standalone adaptation markers: upstream imports replaced by local files. */
const INDEX_EVENTID_IMPORT_OLD = "import type { EventId, SessionId } from '@deepseek-ai/dsh-session'"
const INDEX_EVENTID_IMPORT_NEW = "import type { SessionId } from '@deepseek-ai/dsh-session'\nimport type { EventId } from './event-id.ts'"
const INDEX_EVENTID_EXPORT_OLD = "export type { EventId } from '@deepseek-ai/dsh-session'"
const INDEX_EVENTID_EXPORT_NEW = "export type { EventId } from './event-id.ts'"
const FILE_STORE_IMPORT_OLD = "import { writeFileAtomicDurable } from '@deepseek-ai/dsh-atomic-write'"
const FILE_STORE_IMPORT_NEW = "import { writeFileAtomicDurable } from './atomic-write.ts'"

/** Package directory of session-format inside the deepseek-harness tree. */
const SOURCE_PACKAGE_REL = join('packages', 'session', 'session-format')

/**
 * Files the standalone repo owns and a sync must not overwrite: local
 * optimizations and behavior changes that the deepseek-harness tree does not
 * carry yet (the O(1) append fast path and its commit/validation support).
 * Extract preserves these files across the recursive copy so a sync cannot
 * silently roll the standalone work back; drop a path from this list once the
 * source tree carries the same change.
 */
const EXTERNAL_OWNED = [
  'src/repository.ts',
  'src/engine.ts',
  'tests/repository.spec.ts',
  'tests/engine.spec.ts',
]

export interface SyncOptions {
  /** deepseek-harness checkout root (source of truth). */
  source: string
  /** standalone repo checkout root (target). */
  target: string
}

/** Copy the current session-format content from source into target.
 * Standalone-owned files are preserved across the copy and restored
 * afterwards, so the local fast path and its tests survive a sync.
 */
export async function extract({ source, target }: SyncOptions): Promise<string[]> {
  const from = resolve(source, SOURCE_PACKAGE_REL)
  const entries = ['src', 'tests', 'README.md', 'README.zh.md', 'README.i18n.yaml']
  const owned = new Map<string, string>()
  for (const rel of EXTERNAL_OWNED) {
    try {
      owned.set(rel, await readFile(join(target, rel), 'utf8'))
    } catch {
      // A missing owned file (first sync into a fresh checkout) is fine:
      // there is nothing to preserve yet.
    }
  }
  const copied: string[] = []
  for (const entry of entries) {
    await cp(join(from, entry), join(target, entry), { recursive: true, force: true })
    copied.push(entry)
  }
  for (const [rel, content] of owned) {
    await writeFile(join(target, rel), content)
  }
  return copied
}

/**
 * Re-apply the standalone adaptation: EventId and writeFileAtomicDurable
 * imports point at the local files instead of the npm packages that do not
 * carry the stack-added APIs. Returns the adapted file list.
 */
export async function adapt({ target }: SyncOptions): Promise<string[]> {
  const adapted: string[] = []
  const indexPath = join(target, 'src', 'index.ts')
  const fileStorePath = join(target, 'src', 'file-store.ts')
  const indexSource = await readFile(indexPath, 'utf8')
  let next = indexSource
  if (next.includes(INDEX_EVENTID_IMPORT_OLD)) {
    next = next.replace(INDEX_EVENTID_IMPORT_OLD, INDEX_EVENTID_IMPORT_NEW)
  }
  if (next.includes(INDEX_EVENTID_EXPORT_OLD)) {
    next = next.replace(INDEX_EVENTID_EXPORT_OLD, INDEX_EVENTID_EXPORT_NEW)
  }
  if (next !== indexSource) {
    await writeFile(indexPath, next)
    adapted.push('src/index.ts')
  }
  const fileStoreSource = await readFile(fileStorePath, 'utf8')
  if (fileStoreSource.includes(FILE_STORE_IMPORT_OLD)) {
    await writeFile(fileStorePath, fileStoreSource.replace(FILE_STORE_IMPORT_OLD, FILE_STORE_IMPORT_NEW))
    adapted.push('src/file-store.ts')
  }
  return adapted
}

/** Install dependencies if node_modules is missing, then run tsc + vitest. */
export async function verify({ target }: SyncOptions): Promise<string> {
  const hasModules = await import('node:fs').then(fs => fs.existsSync(join(target, 'node_modules')))
  if (!hasModules) {
    await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: target, shell: process.platform === 'win32' })
  }
  await run('npx', ['tsc', '-b'], { cwd: target, shell: process.platform === 'win32' })
  const result = await run('npx', ['vitest', 'run'], { cwd: target, shell: process.platform === 'win32' })
  return result.stdout.slice(-800)
}

/** Commit changed files in the target repo with the given message. */
export async function commit(
  { target }: SyncOptions,
  message: string,
  options: { push: boolean } = { push: true },
): Promise<string> {
  await run('git', ['add', '-A'], { cwd: target })
  const status = await run('git', ['status', '--porcelain'], { cwd: target })
  if (status.stdout.trim() === '') return 'no changes'
  await run('git', ['commit', '-m', message], { cwd: target })
  if (options.push) {
    await run('git', ['push'], { cwd: target })
  }
  return 'committed and pushed'
}

/** Complete sync: extract, adapt, verify, commit, push. */
export async function sync(options: SyncOptions, message: string): Promise<string> {
  const copied = await extract(options)
  const adapted = await adapt(options)
  const verification = await verify(options)
  const commitResult = await commit(options, message)
  return [
    `copied: ${copied.join(', ')}`,
    `adapted: ${adapted.join(', ') || 'none'}`,
    `verify tail: ${verification.slice(-200)}`,
    `commit: ${commitResult}`,
  ].join('\n')
}

/** Default target checkout path when not provided. */
export function defaultTarget(): string {
  return join(process.env.HOME ?? '/tmp', 'dsh-session-format')
}
