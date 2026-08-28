/**
 * @hsinsekai-nanami/dsh-usage — 多帧 zstd 解码（host 侧，core 内核）。
 *
 * DSH 会话日志是逐批追加的 zstd 帧拼接，node:zlib 的一次性解码只认第一帧，
 * 因此需要按帧结构（RFC 8878）扫描完整帧边界后逐帧解码再拼接。
 * 本实现合并自 dsh-token-cost 与 dsh-usage-board 中两份完全相同的代码。
 */
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 4247762216

export interface ZstdFrameRange {
  start: number
  end: number
}

/**
 * 扫描 zstd 帧结构定位完整帧边界（不解压块内容）。
 * 结构解析参照 zstd 格式规范（RFC 8878）：magic → 帧头描述符 →（窗口/字典/内容长度）
 * → 数据块链（3 字节块头：last/type/size）→ 可选 xxhash 校验。
 * 末尾不完整帧（正被并发写入）返回已扫描到的完整帧，等待下次扫描补齐。
 */
export function scanZstdFrames(buffer: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break // 撕裂的尾部帧：跳过。
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bits at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** 解码全部完整帧并拼接；单帧文件退化为一次 zstdDecompressSync。 */
export function decompressAll(compressed: Buffer): Buffer {
  const frames = scanZstdFrames(compressed)
  if (frames.length === 0) return Buffer.alloc(0)
  if (frames.length === 1) return zstdDecompressSync(compressed.subarray(frames[0].start, frames[0].end))
  const parts = frames.map((frame) => zstdDecompressSync(compressed.subarray(frame.start, frame.end)))
  return Buffer.concat(parts)
}
