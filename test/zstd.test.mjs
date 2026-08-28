/**
 * 多帧 zstd 解码测试：DSH 会话日志是逐批追加的 zstd 帧拼接，
 * node:zlib 的一次性 zstdDecompressSync 只解第一帧，必须先扫描帧边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { decompressAll, scanZstdFrames } from '../lib/core/zstd.js'

test('scanZstdFrames：单帧 / 多帧 / 撕裂尾帧', () => {
  const frame1 = zstdCompressSync(Buffer.from('hello '))
  const frame2 = zstdCompressSync(Buffer.from('world'))
  const single = scanZstdFrames(frame1)
  assert.equal(single.length, 1)
  assert.equal(single[0].start, 0)
  assert.equal(single[0].end, frame1.byteLength)

  const joined = Buffer.concat([frame1, frame2])
  const frames = scanZstdFrames(joined)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].end, frame1.byteLength)
  assert.equal(frames[1].start, frame1.byteLength)
  assert.equal(frames[1].end, joined.byteLength)

  // 撕裂的尾部（并发写入中）：只返回完整帧。
  const torn = Buffer.concat([frame1, frame2.subarray(0, 5)])
  assert.equal(scanZstdFrames(torn).length, 1)
})

test('decompressAll：跨帧内容拼接完整', () => {
  const parts = [
    '{"type":"session","id":"s1"}\n',
    '{"type":"request/header","data":{"header":{"config":{"model":"m"}}}}\n',
    '{"type":"assistant/message","data":{"turn":1,"step":1,"usage":{"inputTokens":1,"outputTokens":2}}}\n',
  ]
  const compressed = Buffer.concat(parts.map((p) => zstdCompressSync(Buffer.from(p))))
  const text = decompressAll(compressed).toString('utf8')
  assert.equal(text, parts.join(''))
})

test('decompressAll：空输入 / 坏 magic 抛错 / 半截头算撕裂', () => {
  assert.equal(decompressAll(Buffer.alloc(0)).byteLength, 0)
  // 真正的坏 magic（首字节不是 0x28）。
  assert.throws(() => scanZstdFrames(Buffer.from([0x99, 0xb5, 0x2f, 0xfd, 0x00])))
  // 合法 magic 但帧头没写完 → 视为撕裂尾帧，返回 0 个完整帧而非抛错。
  assert.equal(scanZstdFrames(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])).length, 0)
})
