import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decodeSnapshot,
  encodeSnapshot,
  readSnapshotFile,
  writeFileAtomic,
  writeSnapshotFile,
} from '../src/file-store.ts'
import { decodePage, encodePage } from '../src/pages.ts'
import type { PageId } from '../src/index.ts'

let dir: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-file-store-'))
})

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

const snapshotPath = (): string => join(dir!, 'session.dsh')

describe('durable file store', () => {
  it('writes and reads a snapshot atomically', async () => {
    const path = snapshotPath()
    await writeSnapshotFile(path, new TextEncoder().encode('hello'))
    expect(new TextDecoder().decode(await readSnapshotFile(path))).toBe('hello')
    // The write must leave no temp sibling behind.
    expect(await readdir(dir!)).toEqual(['session.dsh'])
  })

  it('stores the snapshot as a page container with a fixed id', async () => {
    const path = snapshotPath()
    await writeSnapshotFile(path, new TextEncoder().encode('data'))
    const page = decodePage(new Uint8Array(await readFile(path)))
    expect(page.pageId).toBe('snapshot')
    expect(new TextDecoder().decode(page.payload)).toBe('data')
  })

  it('detects corruption in a snapshot', async () => {
    const path = snapshotPath()
    await writeSnapshotFile(path, new TextEncoder().encode('data'))
    const bytes = new Uint8Array(await readFile(path))
    const last = bytes.length - 1
    bytes[last] = bytes[last]! ^ 0xff
    await writeFile(path, bytes)
    await expect(readSnapshotFile(path)).rejects.toThrow(/checksum mismatch/)
  })

  it('round-trips a snapshot through the codec', () => {
    const payload = new TextEncoder().encode('hello')
    expect(new TextDecoder().decode(decodeSnapshot(encodeSnapshot(payload)))).toBe('hello')
  })

  it('rejects a snapshot that is too short', () => {
    // A valid header (magic/version) whose declared id length leaves the
    // container below the minimum size.
    const header = new Uint8Array(8)
    new DataView(header.buffer).setUint32(0, 0x44534850, false)
    new DataView(header.buffer).setUint16(4, 1, false)
    expect(() => decodeSnapshot(header)).toThrow(/too short/)
  })

  it('rejects a snapshot with a bad magic', () => {
    expect(() => decodeSnapshot(new Uint8Array(20))).toThrow(/bad page magic/)
  })

  it('rejects an unsupported snapshot version', () => {
    const encoded = encodeSnapshot(new TextEncoder().encode('data'))
    new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).setUint16(4, 2, false)
    expect(() => decodeSnapshot(encoded)).toThrow(/unsupported page version/)
  })

  it('rejects a page container whose id is not the snapshot id', () => {
    const encoded = encodePage('page_0' as PageId, new TextEncoder().encode('data'))
    expect(() => decodeSnapshot(encoded)).toThrow(/not a snapshot page/)
  })

  it('rejects a snapshot whose declared length does not match', () => {
    const encoded = encodeSnapshot(new TextEncoder().encode('data'))
    const padded = new Uint8Array(encoded.length + 1)
    padded.set(encoded)
    expect(() => decodeSnapshot(padded)).toThrow(/length mismatch/)
  })

  it('writes files with owner-only permissions', async () => {
    const path = snapshotPath()
    await writeFileAtomic(path, new TextEncoder().encode('secret'))
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  it('leaves no temp sibling and rethrows when the rename fails', async () => {
    const path = snapshotPath()
    await mkdir(path)
    await expect(writeFileAtomic(path, new TextEncoder().encode('data'))).rejects.toThrow()
    expect((await readdir(dir!)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  // Two overlapping renames onto one target are atomic on POSIX; Windows
  // MoveFileEx(REPLACE_EXISTING) can intermittently fail under contention, so
  // the concurrency assertion stays POSIX-only.
  it.skipIf(process.platform === 'win32')('keeps concurrent writers from corrupting each other', async () => {
    const path = snapshotPath()
    const first = 'first-writer'
    const second = 'second-writer'
    await Promise.all([
      writeSnapshotFile(path, new TextEncoder().encode(first)),
      writeSnapshotFile(path, new TextEncoder().encode(second)),
    ])
    const loaded = new TextDecoder().decode(await readSnapshotFile(path))
    expect([first, second]).toContain(loaded)
    expect((await readdir(dir!)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })
})
