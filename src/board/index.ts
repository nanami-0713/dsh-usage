/**
 * @hsinsekai-nanami/dsh-usage — board 模块的索引状态管理（host 侧）。
 *
 * 把 loadCache / scanSessions 包成一个带 TTL 与单飞（single-flight）语义的
 * 状态机：路由处理函数只调 ensureIndex(force)，并发与节流都在这里消化。
 */
import { dshHomeDir } from '../core/home.js'
import { loadCache, saveCache, scanSessions, type IndexCacheFile, type ScanStats } from './indexer.js'

/** 索引缓存的复用 TTL：超过后对变更文件重扫（指纹比对，代价很小）。 */
const RESCAN_TTL_MS = 30_000

export interface BoardIndexState {
  cache: IndexCacheFile
  scannedAt: number
  stats: ScanStats
  scanning: Promise<void> | null
}

export function createBoardIndexState(): BoardIndexState {
  return {
    cache: { version: 1, sessions: {}, indexedAt: 0 },
    scannedAt: 0,
    stats: { sessions: 0, folders: 0, reindexed: 0, failed: 0, bytes: 0 },
    scanning: null,
  }
}

async function rescan(state: BoardIndexState, home: string): Promise<void> {
  const result = await scanSessions(home, state.cache)
  state.cache = result.cache
  state.stats = result.stats
  state.scannedAt = Date.now()
  await saveCache(result.cache, home).catch(() => undefined)
}

export async function ensureBoardIndex(state: BoardIndexState, force: boolean, home = dshHomeDir()): Promise<void> {
  if (state.scanning !== null) {
    // 已有扫描在跑：等它完成即可（它用的是最新指纹）。
    await state.scanning
    return
  }
  if (!force && Date.now() - state.scannedAt < RESCAN_TTL_MS) return
  const job = rescan(state, home).finally(() => {
    state.scanning = null
  })
  state.scanning = job
  await job
}

/** 启动预热：先读持久化缓存，再后台增量重扫（失败不阻塞服务）。 */
export function warmupBoardIndex(state: BoardIndexState, home = dshHomeDir()): void {
  void loadCache(home).then((cached) => {
    state.cache = cached
    void ensureBoardIndex(state, false, home).catch(() => undefined)
  })
}
