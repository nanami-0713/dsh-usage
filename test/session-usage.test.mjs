/**
 * 会话日志归集测试：多帧 zstd 解码、usage 归属到「发出请求时的模型」、
 * 同 (turn, step) last-wins 不双计、按模型 × 小时分桶、指纹缓存复用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { decompressAll, scanZstdFrames } from '../lib/core/zstd.js'
import { indexSessionUsage, resetSessionCaches as resetCaches } from '../lib/session/index.js'
import { aggregateSessionModels, parseSessionLogText } from '../lib/core/session-log.js'

const parseSessionUsage = (text) => aggregateSessionModels(parseSessionLogText(text).samples)

const HOUR_A = Date.parse('2026-08-18T10:05:00+08:00')
const HOUR_A_LATER = Date.parse('2026-08-18T10:40:00+08:00')
const HOUR_B = Date.parse('2026-08-18T12:10:00+08:00')

function header(seq, time, provider, model) {
  return { type: 'request/header', seq, time, data: { header: { config: { provider, model } } } }
}

function chunkUsage(seq, time, turn, step, usage) {
  return { type: 'assistant/chunk', seq, time, data: { turn, step, chunk: { type: 'usage', usage } } }
}

function messageUsage(seq, time, turn, step, usage) {
  return { type: 'assistant/message', seq, time, data: { turn, step, usage } }
}

test('scanZstdFrames / decompressAll：多帧拼接日志逐帧解码', () => {
  const frame1 = zstdCompressSync(Buffer.from('{"type":"a"}\n'))
  const frame2 = zstdCompressSync(Buffer.from('{"type":"b"}\n'))
  const joined = Buffer.concat([frame1, frame2])
  const frames = scanZstdFrames(joined)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].start, 0)
  assert.equal(frames[0].end, frame1.length)
  assert.equal(decompressAll(joined).toString(), '{"type":"a"}\n{"type":"b"}\n')
  // 末尾撕裂帧：只解出完整帧。
  const torn = Buffer.concat([joined, joined.subarray(0, 3)])
  assert.equal(decompressAll(torn).toString(), '{"type":"a"}\n{"type":"b"}\n')
})

test('parseSessionUsage：usage 归属到发出请求时的模型，切模型后跟随', () => {
  const log = [
    { type: 'session', id: 'session-x', createdAt: HOUR_A, cwd: '/tmp' },
    header(1, HOUR_A, 'deepseek-official', 'deepseek-v4-flash'),
    chunkUsage(2, HOUR_A, 1, 1, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 }),
    messageUsage(3, HOUR_A_LATER, 1, 1, { inputTokens: 120, outputTokens: 60, cacheReadTokens: 10 }), // 覆盖同 (1,1)
    header(4, HOUR_B, 'zai-coding-cn', 'glm-5.3'),
    messageUsage(5, HOUR_B, 2, 1, { inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 5 }),
    messageUsage(6, HOUR_B, 2, 2, { inputTokens: 1, outputTokens: 1 }),
  ]
    .map((r) => JSON.stringify(r))
    .join('\n')

  const models = parseSessionUsage(log)
  assert.equal(models.length, 2)

  const flash = models.find((m) => m.model === 'deepseek-v4-flash')
  assert.ok(flash)
  assert.equal(flash.provider, 'deepseek-official')
  assert.equal(flash.hours.length, 1)
  assert.deepEqual(
    { ...flash.hours[0], ts: 0 },
    { ts: 0, input: 120, cacheRead: 10, cacheWrite: 0, output: 60, requests: 1 },
  )

  const glm = models.find((m) => m.model === 'glm-5.3')
  assert.ok(glm)
  assert.equal(glm.provider, 'zai-coding-cn')
  assert.equal(glm.hours.length, 1) // 同一小时合桶
  assert.deepEqual(
    { ...glm.hours[0], ts: 0 },
    { ts: 0, input: 201, cacheRead: 20, cacheWrite: 5, output: 81, requests: 2 },
  )
})

test('parseSessionUsage：header 之前的 usage 归为 (unknown)', () => {
  const log = [messageUsage(1, HOUR_A, 1, 1, { inputTokens: 10, outputTokens: 5 })].map((r) => JSON.stringify(r)).join('\n')
  const models = parseSessionUsage(log)
  assert.equal(models.length, 1)
  assert.equal(models[0].model, '(unknown)')
  assert.equal(models[0].hours[0].input, 10)
})

test('parseSessionUsage：跨小时分桶、坏行跳过', () => {
  const log = [
    header(1, HOUR_A, 'deepseek-official', 'deepseek-v4-pro'),
    messageUsage(2, HOUR_A, 1, 1, { inputTokens: 10, outputTokens: 1 }),
    messageUsage(3, HOUR_B, 1, 2, { inputTokens: 20, outputTokens: 2 }),
  ]
    .map((r) => JSON.stringify(r))
    .concat(['{ this is not json', ''])
    .join('\n')
  const models = parseSessionUsage(log)
  assert.equal(models.length, 1)
  assert.equal(models[0].hours.length, 2)
  assert.equal(models[0].hours[0].input, 10)
  assert.equal(models[0].hours[1].input, 20)
})

test('indexSessionUsage：落盘日志 → 归集（含指纹缓存与找不到会话）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-token-cost-'))
  try {
    resetCaches()
    // 找不到：found=false 而不是抛错。
    const missing = await indexSessionUsage('session-not-exist', home)
    assert.equal(missing.found, false)
    assert.deepEqual(missing.models, [])

    const sessionId = 'session-abc123'
    const log = [
      header(1, HOUR_A, 'deepseek-official', 'deepseek-v4-flash'),
      messageUsage(2, HOUR_A, 1, 1, { inputTokens: 1000, outputTokens: 100 }),
      header(3, HOUR_B, 'kimi-code', 'k3'),
      messageUsage(4, HOUR_B, 2, 1, { inputTokens: 2000, outputTokens: 200 }),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n')
    const dir = join(home, 'sessions', '--tmp--', sessionId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(log)))

    resetCaches()
    const first = await indexSessionUsage(sessionId, home)
    assert.equal(first.found, true)
    assert.equal(first.models.length, 2)
    assert.ok(first.models.some((m) => m.model === 'deepseek-v4-flash'))
    assert.ok(first.models.some((m) => m.model === 'k3' && m.provider === 'kimi-code'))

    // 指纹未变：直接命中缓存（结果一致）。
    const second = await indexSessionUsage(sessionId, home)
    assert.deepEqual(second, first)

    // 非法 sessionId（路径穿越）：拒绝。
    const evil = await indexSessionUsage('../../etc', home)
    assert.equal(evil.found, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
