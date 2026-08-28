/**
 * @dsh-external/dsh-usage — 全局会话日志索引器（board 模块，host 侧）。
 *
 * 扫描 ~/.dsh/sessions/<folder>/<session>/session.jsonl.zstd 的全部记录，
 * 经 core/session-log 统一解析后按「北京时区小时 × 模型」聚合成紧凑桶。
 *
 * 增量缓存：每个会话文件记录 mtime+size 指纹，未变化的直接复用缓存条目，
 * 缓存持久化在 ~/.dsh/plugins/dsh-usage/cache.json（原子写入）。
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decompressAll } from '../core/zstd.js'
import { dshHomeDir, pluginDataDir, sessionsDir } from '../core/home.js'
import { aggregateBoardBuckets, parseSessionLogText, type BucketCounts } from '../core/session-log.js'

export type { BucketCounts }

export interface SessionIndexData {
  id: string
  folder: string
  cwd: string | null
  createdAt: number | null
  origin: string | null
  /** hourKey → model → counts。 */
  buckets: Record<string, Record<string, BucketCounts>>
  /** model → provider 路由集合（来自 request/header）。 */
  modelProviders: Record<string, string[]>
}

export interface SessionCacheEntry extends SessionIndexData {
  fp: { mtimeMs: number; size: number }
}

export interface IndexCacheFile {
  version: 1
  /** key = `<folder>/<sessionDirName>`（相对 sessions 根的稳定路径）。 */
  sessions: Record<string, SessionCacheEntry>
  indexedAt: number
}

export interface ScanStats {
  sessions: number
  folders: number
  reindexed: number
  failed: number
  bytes: number
}

export interface ScanResult {
  cache: IndexCacheFile
  stats: ScanStats
}

const LOG_FILE = 'session.jsonl.zstd'

export function cachePath(home = dshHomeDir()): string {
  return join(pluginDataDir(home), 'cache.json')
}

export function emptyCache(): IndexCacheFile {
  return { version: 1, sessions: {}, indexedAt: 0 }
}

export async function loadCache(home?: string): Promise<IndexCacheFile> {
  try {
    const raw = JSON.parse(await readFile(cachePath(home), 'utf8')) as IndexCacheFile
    if (raw !== null && typeof raw === 'object' && raw.version === 1 && raw.sessions !== null && typeof raw.sessions === 'object') {
      return raw
    }
  } catch {
    // 首次运行 / 缓存损坏：全量重建。
  }
  return emptyCache()
}

export async function saveCache(cache: IndexCacheFile, home?: string): Promise<void> {
  const file = cachePath(home)
  await mkdir(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(cache), 'utf8')
  await rename(tmp, file)
}

interface ParsedSession {
  data: SessionIndexData
  bytes: number
}

/** 解压并折叠一份会话日志（纯函数，供测试直接调用）。 */
export function parseSessionLog(buffer: Buffer, folder: string): SessionIndexData {
  const { meta, samples } = parseSessionLogText(buffer.toString('utf8'))
  const { buckets, modelProviders } = aggregateBoardBuckets(samples)
  return { id: meta.id, folder, cwd: meta.cwd, createdAt: meta.createdAt, origin: meta.origin, buckets, modelProviders }
}

/** 读取并解析一个会话日志文件。 */
async function indexSessionFile(file: string, folder: string): Promise<ParsedSession | null> {
  let buffer: Buffer
  try {
    const compressed = await readFile(file)
    buffer = decompressAll(compressed)
  } catch {
    return null
  }
  return { data: parseSessionLog(buffer, folder), bytes: buffer.byteLength }
}

/**
 * 扫描 sessions 根下所有文件夹的全部会话；未变化的复用缓存。
 * 单个文件解析失败（正在写入 / 损坏）跳过并计入 failed，不中断整体。
 */
export async function scanSessions(home: string, previous: IndexCacheFile, forceSessionKey?: string): Promise<ScanResult> {
  const sessions: Record<string, SessionCacheEntry> = {}
  const stats: ScanStats = { sessions: 0, folders: 0, reindexed: 0, failed: 0, bytes: 0 }
  const root = sessionsDir(home)

  let folderNames: string[] = []
  try {
    folderNames = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return { cache: { ...previous, indexedAt: Date.now() }, stats }
  }

  for (const folder of folderNames) {
    let sessionDirNames: string[] = []
    try {
      sessionDirNames = (await readdir(join(root, folder), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      continue
    }
    stats.folders += 1

    for (const sessionDirName of sessionDirNames) {
      const file = join(root, folder, sessionDirName, LOG_FILE)
      const key = `${folder}/${sessionDirName}`
      let fp: { mtimeMs: number; size: number }
      try {
        const info = await stat(file)
        fp = { mtimeMs: Math.floor(info.mtimeMs), size: info.size }
      } catch {
        continue // 无日志文件的目录（如仅剩元数据）。
      }
      stats.sessions += 1

      const cached = previous.sessions[key]
      if (
        cached !== undefined && forceSessionKey !== key &&
        cached.fp.mtimeMs === fp.mtimeMs && cached.fp.size === fp.size &&
        cached.folder === folder
      ) {
        sessions[key] = cached
        continue
      }

      const parsed = await indexSessionFile(file, folder)
      if (parsed === null) {
        stats.failed += 1
        // 保留旧缓存条目，避免半写文件把已有数据冲掉。
        if (cached !== undefined) sessions[key] = cached
        continue
      }
      stats.reindexed += 1
      stats.bytes += parsed.bytes
      sessions[key] = { ...parsed.data, fp }
    }
  }

  return { cache: { version: 1, sessions, indexedAt: Date.now() }, stats }
}
