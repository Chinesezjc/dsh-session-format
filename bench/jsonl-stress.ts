/**
 * JSONL-side stress, mirroring the session-format stress at bench/stress.ts:
 * the rare operations of a plaintext JSONL log are whole-file recovery
 * parsing (the readStoredLog scan), crash-tail truncation recovery, and
 * continued appends. There is no physical fork/compaction on this side —
 * that absence is the format difference — so this measures the recovery
 * surface instead: repeated full parses, torn-tail truncation at random
 * offsets, and growth. Failures, timing outliers, and byte-level corruption
 * are reported.
 *
 * Usage: npx vite-node bench/jsonl-stress.ts [events] [recoveries]
 */
import { closeSync, fsyncSync, mkdtempSync, openSync, statSync, truncateSync, writeSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EVENTS = Number(process.argv[2] ?? 700000)
const RECOVERIES = Number(process.argv[3] ?? 30)
const SID = 'stress'
const mk = (n: number): string => JSON.stringify({
  type: 'user/message', time: 1787736463867 + n,
  data: { id: `m${n}`, role: 'user', content: [{ type: 'text', text: `message ${n} with some body` }], source: { kind: 'user' } },
  surfaceOp: 'append',
})

const dir = mkdtempSync(join(tmpdir(), 'sf-jl-stress-'))
const path = join(dir, 'session.jsonl')
const fd = openSync(path, 'w', 0o600)
writeSync(fd, new TextEncoder().encode(JSON.stringify({ type: 'session', version: 0, id: SID, createdAt: 1 }) + '\n'))
const t0 = performance.now()
const BATCH = 10000
let lines: string[] = []
for (let i = 0; i < EVENTS; i++) {
  lines.push(mk(i))
  if (lines.length >= BATCH) {
    writeSync(fd, new TextEncoder().encode(lines.join('\n') + '\n'))
    lines = []
  }
}
if (lines.length > 0) writeSync(fd, new TextEncoder().encode(lines.join('\n') + '\n'))
fsyncSync(fd)
const size = statSync(path).size
console.log(`构造 ${EVENTS} 行: ${(size / 1024 / 1024).toFixed(0)}MB 明文（含 header）`)

let failures = 0
const parses: number[] = []
const parseAll = (data: Buffer): number => {
  const text = data.toString('utf8')
  let count = 0
  for (const line of text.split('\n')) {
    if (line !== '') { JSON.parse(line); count += 1 }
  }
  return count - 1 // minus header
}

// 1) repeated whole-file recovery parses (the readStoredLog scan path)
console.log('\n=== 全量恢复解析 ×10 ===')
const { copyFileSync, readFileSync } = await import('node:fs')
const fullPath = join(dir, 'session.full.jsonl')
copyFileSync(path, fullPath)
for (let r = 0; r < 10; r++) {
  const tp = performance.now()
  const raw = readFileSync(path)
  const events = parseAll(raw)
  const ms = performance.now() - tp
  parses.push(ms)
  if (events !== EVENTS) { failures += 1; console.log(`  parse#${r}: 事件数 ${events} != ${EVENTS}`) }
}
parses.sort((a, b) => a - b)
const med = parses[5]!
console.log(`  全量 parse 10 次: min ${parses[0]!.toFixed(0)}ms  med ${med.toFixed(0)}ms  max ${parses[9]!.toFixed(0)}ms  | 失败 ${failures}`)

// 2) torn-tail truncation recovery at random offsets
console.log(`\n=== 崩溃尾部截断恢复 ×${RECOVERIES}（随机偏移）===`)
const recoverFile = (p: string): number => {
  // Recovery: scan back from the torn tail for the last complete JSON line;
  // everything through it is the committed prefix. Rebuild the file in place
  // with a fresh descriptor (an fd truncated in place does not reset its
  // write position).
  const raw = readFileSync(p)
  const allLines = raw.toString('utf8').split('\n')
  let lastComplete = -1
  for (let i = allLines.length - 1; i >= 0; i--) {
    const line = allLines[i]
    if (line === '') continue
    try {
      JSON.parse(line)
      lastComplete = i
      break
    } catch {
      // torn line: keep scanning back
    }
  }
  const repaired = (lastComplete >= 0 ? allLines.slice(0, lastComplete + 1).join('\n') : '') + '\n'
  const repairFd = openSync(p, 'w', 0o600)
  writeSync(repairFd, new TextEncoder().encode(repaired))
  fsyncSync(repairFd)
  closeSync(repairFd)
  return parseAll(readFileSync(p))
}
const recovered: number[] = []
for (let r = 0; r < RECOVERIES; r++) {
  // Deterministic pseudo-random offsets across the file (skip header region).
  const cut = 200 + ((r * 2654435761) % (size - 200))
  try {
    // Each recovery truncates a fresh copy of the full log at an independent
    // offset (chained truncation would extend the shrunken file with holes).
    const probe = join(dir, `probe-${r}.jsonl`)
    copyFileSync(fullPath, probe)
    truncateSync(probe, cut)
    const events = recoverFile(probe)
    recovered.push(events)
    if (events > EVENTS) { failures += 1; console.log(`  recovery#${r}: 事件数 ${events} 超上限`) }
  } catch (error) {
    failures += 1
    console.log(`  recovery#${r}: 坏死 ${(error as Error).message}`)
  }
}
recovered.sort((a, b) => a - b)
const rMed = recovered[Math.floor(recovered.length / 2)]!
console.log(`  恢复后事件数: min ${recovered[0]}  med ${rMed}  max ${recovered[recovered.length - 1]}（原 ${EVENTS}，截断后减少为正常）`)

// 3) the crash cycle end to end: truncate, recover in place, then keep
// appending to the same repaired file — appends must resume at its tail.
console.log('\n=== 崩溃循环: 截断 → 恢复 → 同一文件继续追加 10000 ===')
const cycle = join(dir, 'cycle.jsonl')
copyFileSync(fullPath, cycle)
const cycleCut = Math.floor(size * 0.6)
truncateSync(cycle, cycleCut)
const afterRecovery = recoverFile(cycle)
const t0a = performance.now()
const extra: string[] = []
for (let i = 0; i < 10000; i++) extra.push(mk(EVENTS + i))
const appendFd = openSync(cycle, 'a', 0o600)
writeSync(appendFd, new TextEncoder().encode(extra.join('\n') + '\n'))
fsyncSync(appendFd)
closeSync(appendFd)
const finalEvents = parseAll(readFileSync(cycle))
console.log(`  恢复得 ${afterRecovery} 事件 → 追加 10000（${((performance.now() - t0a) / 1000).toFixed(1)}s）| 最终 ${finalEvents}（应为 ${afterRecovery + 10000}）`)
if (finalEvents !== afterRecovery + 10000) {
  failures += 1
  console.log(`  cycle: 最终事件数 ${finalEvents} != 恢复 ${afterRecovery} + 10000`)
}
closeSync(fd)
rmSync(dir, { recursive: true, force: true })
console.log(`\n总坏死: ${failures} 次异常`)
