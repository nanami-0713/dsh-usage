/**
 * @dsh-external/dsh-usage — 会话模块（host 侧）。
 *
 * 归集单个会话的逐模型用量：定位并解压 session.jsonl.zstd，经 core/session-log
 * 统一解析后按「模型 × 小时」聚合，供实时费用徽标按「模型 × 时代 × 峰谷」计价。
 *
 * 路由（由 src/index.ts 统一挂载时传入 web 注册器）：
 *   GET /api/dsh-usage/session?sessionId=<session-xxx>
 *     → { ok, sessionId, found, indexedAt, models: [{ model, provider, hours: [...] }] }
 *
 * 兼容别名：GET /api/dsh-token-cost/usage（同 handler，一个版本后移除）。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { decompressAll } from '../core/zstd.js'
import { dshHomeDir, sessionsDir } from '../core/home.js'
import { aggregateSessionModels, parseSessionLogText, type ModelUsageEntry } from '../core/session-log.js'

const LOG_FILE = 'session.jsonl.zstd'
const SESSION_ID_RE = /^[\w][\w.-]*$/

export interface SessionUsageIndex {
  sessionId: string
  found: boolean
  indexedAt: number
  models: ModelUsageEntry[]
}

export interface Fingerprint {
  mtimeMs: number
  size: number
}

/** 会话目录定位缓存：sessionId → folder（负结果也缓存，带 TTL 失效）。 */
const folderHints = new Map<string, { folder: string | null; at: number }>()
const FOLDER_HINT_TTL_MS = 60_000

/** 解析结果缓存：sessionId → { fp, index }（指纹相同直接复用）。 */
const parseCache = new Map<string, { fp: Fingerprint; index: SessionUsageIndex }>()

async function statSessionFile(sessionId: string, home: string): Promise<{ file: string; fp: Fingerprint } | null> {
  const root = sessionsDir(home)
  const hinted = folderHints.get(sessionId)
  const folders: string[] = []
  if (hinted !== undefined && Date.now() - hinted.at < FOLDER_HINT_TTL_MS && hinted.folder !== null) {
    folders.push(hinted.folder)
  } else {
    try {
      const entries = await readdir(root, { withFileTypes: true })
      folders.push(...entries.filter((e) => e.isDirectory()).map((e) => e.name))
    } catch {
      return null
    }
  }

  for (const folder of folders) {
    const file = join(root, folder, sessionId, LOG_FILE)
    try {
      const info = await stat(file)
      if (!info.isFile()) continue
      folderHints.set(sessionId, { folder, at: Date.now() })
      return { file, fp: { mtimeMs: Math.floor(info.mtimeMs), size: info.size } }
    } catch {
      continue
    }
  }
  if (hinted === undefined || Date.now() - hinted.at >= FOLDER_HINT_TTL_MS) {
    folderHints.set(sessionId, { folder: null, at: Date.now() })
  }
  return null
}

/** 供测试重置内部缓存。 */
export function resetSessionCaches(): void {
  folderHints.clear()
  parseCache.clear()
}

/**
 * 归集一个会话的逐模型用量。找不到日志返回 found:false（新会话尚未落盘）。
 */
export async function indexSessionUsage(sessionId: string, home = dshHomeDir()): Promise<SessionUsageIndex> {
  const id = sessionId.trim()
  if (!SESSION_ID_RE.test(id)) return { sessionId: id, found: false, indexedAt: Date.now(), models: [] }

  const located = await statSessionFile(id, home)
  if (located === null) return { sessionId: id, found: false, indexedAt: Date.now(), models: [] }

  const cached = parseCache.get(id)
  if (cached !== undefined && cached.fp.mtimeMs === located.fp.mtimeMs && cached.fp.size === located.fp.size) {
    return cached.index
  }

  let models: ModelUsageEntry[]
  try {
    const compressed = await readFile(located.file)
    const { samples } = parseSessionLogText(decompressAll(compressed).toString('utf8'))
    models = aggregateSessionModels(samples)
  } catch {
    // 半写 / 损坏：保留旧缓存条目，避免瞬时读失败把已有数据冲掉。
    if (cached !== undefined) return cached.index
    return { sessionId: id, found: true, indexedAt: Date.now(), models: [] }
  }

  const index: SessionUsageIndex = { sessionId: id, found: true, indexedAt: Date.now(), models }
  parseCache.set(id, { fp: located.fp, index })
  return index
}
