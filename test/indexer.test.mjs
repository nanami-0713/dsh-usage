/**
 * 索引器单元测试：usage 去重（chunk vs message）、模型归属、
 * 目录扫描与指纹增量缓存。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { emptyCache, parseSessionLog, scanSessions } from '../lib/board/indexer.js'

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

/** parseSessionLog 输入是解压后的日志文本（解压在 indexSessionFile 层）。 */
function plain(text) {
  return Buffer.from(text, 'utf8')
}

/** scanSessions 输入是 zstd 压缩的日志文件。 */
function compress(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

const T = Date.parse('2026-08-18T10:00:00+08:00')

test('parseSessionLog：chunk/message 同 (turn,step) 只计最终 usage', () => {
  const records = [
    { type: 'session', seq: 1, time: T, data: { id: 's1', cwd: '/work/one', createdAt: T, origin: 'user' } },
    { type: 'request/header', seq: 2, time: T, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } },
    { type: 'assistant/chunk', seq: 3, time: T, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 } } } },
    { type: 'assistant/message', seq: 4, time: T, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 1100, outputTokens: 220, cacheReadTokens: 500, reasoningTokens: 50 } } },
  ]
  const data = parseSessionLog(plain(jsonl(records)), 'F1')
  assert.equal(data.id, 's1')
  assert.equal(data.cwd, '/work/one')
  assert.deepEqual(data.modelProviders, { 'deepseek-v4-flash': ['deepseek-official'] })
  const bucket = data.buckets['2026-08-18T10']['deepseek-v4-flash']
  // 1100/500/220（message 的最终值），不是 1000/500/200（chunk 早值）。
  assert.deepEqual(bucket, { i: 1100, c: 500, w: 0, o: 220, n: 1 })
})

test('parseSessionLog：流式中断（只有 usage chunk 没有 message）也计费', () => {
  const records = [
    { type: 'session', seq: 1, time: T, data: { id: 's2' } },
    { type: 'request/header', seq: 2, time: T, data: { header: { config: { provider: 'deepseek-modlens', model: 'deepseek-v4-pro' } } } },
    { type: 'assistant/chunk', seq: 3, time: T + 60_000, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 900, outputTokens: 100 } } } },
    // 请求失败：没有 assistant/message。
  ]
  const data = parseSessionLog(plain(jsonl(records)), 'F1')
  const bucket = data.buckets['2026-08-18T10']['deepseek-v4-pro']
  assert.deepEqual(bucket, { i: 900, c: 0, w: 0, o: 100, n: 1 })
})

test('parseSessionLog：同一会话切换模型，usage 归属各自 header 的模型', () => {
  const records = [
    { type: 'session', seq: 1, time: T, data: { id: 's3', cwd: '/work/two' } },
    { type: 'request/header', seq: 2, time: T, data: { header: { config: { provider: 'deepseek-modlens', model: 'deepseek-v4-flash' } } } },
    { type: 'assistant/message', seq: 3, time: T, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20 } } },
    { type: 'request/header', seq: 4, time: T, data: { header: { config: { provider: 'zai-coding-cn', model: 'glm-5.3' } } } },
    { type: 'assistant/message', seq: 5, time: T, data: { turn: 2, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 400, outputTokens: 40, cacheReadTokens: 60 } } },
    // header 之间没有模型切换线索时（无 header 的 usage）仍归最近的 header。
    { type: 'assistant/message', seq: 6, time: T, data: { turn: 2, step: 2, message: { role: 'assistant', content: [] }, usage: { inputTokens: 5, outputTokens: 5 } } },
  ]
  const data = parseSessionLog(plain(jsonl(records)), 'F1')
  const flash = data.buckets['2026-08-18T10']['deepseek-v4-flash']
  const glm = data.buckets['2026-08-18T10']['glm-5.3']
  assert.deepEqual(flash, { i: 100, c: 20, w: 0, o: 10, n: 1 })
  assert.deepEqual(glm, { i: 405, c: 60, w: 0, o: 45, n: 2 })
  assert.deepEqual(data.modelProviders['glm-5.3'], ['zai-coding-cn'])
})

test('parseSessionLog：坏行 / 空 usage / cacheWrite 字段', () => {
  const records = [
    { type: 'session', seq: 1, time: T, data: { id: 's4' } },
    { type: 'request/header', seq: 2, time: T, data: { header: { config: { provider: 'moonshotai-cn', model: 'kimi-k3' } } } },
    { type: 'assistant/message', seq: 3, time: T, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 70 } } },
  ]
  const text = 'not-json\n' + jsonl(records) + '\n{broken'
  const data = parseSessionLog(plain(text), 'F2')
  assert.deepEqual(data.buckets['2026-08-18T10']['kimi-k3'], { i: 300, c: 0, w: 70, o: 30, n: 1 })
})

test('scanSessions：目录扫描 + 指纹增量 + 变更重扫', async () => {
  const home = join(tmpdir(), `dsh-usage-board-test-${Date.now()}`)
  const folderA = join(home, 'sessions', '--work-one--')
  const folderB = join(home, 'sessions', '--work-two--')
  mkdirSync(join(folderA, 'session-a1'), { recursive: true })
  mkdirSync(join(folderA, 'session-a2'), { recursive: true })
  mkdirSync(join(folderB, 'session-b1'), { recursive: true })
  mkdirSync(join(folderB, 'empty-dir'), { recursive: true })

  const mkRecords = (id, model) => [
    { type: 'session', seq: 1, time: T, data: { id, cwd: '/work/one', createdAt: T } },
    { type: 'request/header', seq: 2, time: T, data: { header: { config: { provider: 'deepseek-official', model } } } },
    { type: 'assistant/message', seq: 3, time: T, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, outputTokens: 1 } } },
  ]

  writeFileSync(join(folderA, 'session-a1', 'session.jsonl.zstd'), compress(jsonl(mkRecords('a1', 'deepseek-v4-flash'))))
  writeFileSync(join(folderA, 'session-a2', 'session.jsonl.zstd'), compress(jsonl(mkRecords('a2', 'deepseek-v4-pro'))))
  writeFileSync(join(folderB, 'session-b1', 'session.jsonl.zstd'), compress(jsonl(mkRecords('b1', 'kimi-k3'))))

  const first = await scanSessions(home, emptyCache())
  assert.equal(first.stats.folders, 2)
  assert.equal(first.stats.sessions, 3)
  assert.equal(first.stats.reindexed, 3)
  assert.equal(Object.keys(first.cache.sessions).length, 3)
  assert.equal(first.cache.sessions['--work-one--/session-a1'].id, 'a1')

  // 二次扫描：指纹未变 → 全部复用。
  const second = await scanSessions(home, first.cache)
  assert.equal(second.stats.reindexed, 0)
  assert.equal(Object.keys(second.cache.sessions).length, 3)
  assert.deepEqual(second.cache.sessions['--work-one--/session-a1'].buckets, first.cache.sessions['--work-one--/session-a1'].buckets)

  // a1 追加记录（mtime + size 变化）→ 只重扫 a1。
  const grown = jsonl(mkRecords('a1', 'deepseek-v4-flash')) + jsonl([
    { type: 'request/header', seq: 4, time: T + 3_600_000, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } },
    { type: 'assistant/message', seq: 5, time: T + 3_600_000, data: { turn: 2, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 99, outputTokens: 9 } } },
  ])
  const file = join(folderA, 'session-a1', 'session.jsonl.zstd')
  writeFileSync(file, compress(grown))
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)
  const third = await scanSessions(home, second.cache)
  assert.equal(third.stats.reindexed, 1)
  const buckets = third.cache.sessions['--work-one--/session-a1'].buckets
  assert.ok(buckets['2026-08-18T11'] !== undefined, '追加的小时桶已入库')

  rmSync(home, { recursive: true, force: true })
})
