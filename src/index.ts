/**
 * @hsinsekai-nanami/dsh-usage — host half（统一入口）。
 *
 * Token 消耗体系插件：一个 inject 挂载全部子模块路由（前缀 /api/dsh-usage/）：
 *   GET     /session?sessionId=<id>                      单会话逐模型归集（实时费用徽标）
 *   GET     /summary?range=1d|7d|30d|all[&refresh=1]     全局用量汇总（设置页看板）
 *   GET     /pricing                                     计价目录（含用户覆盖）
 *   GET     /quota?provider=<id>[&refresh=1]             单 provider 订阅额度（右徽标）
 *   GET     /quota/all[?refresh=1]                       全部 Coding Plan 额度（看板「订阅额度」区块）
 *   GET/PUT /config                                      统一配置 v2（计价覆盖 + provider 映射 + 轮询间隔）
 *
 * 兼容别名（过渡一个版本后移除）：
 *   /api/dsh-token-cost/usage          → /session
 *   /api/dsh-usage-board/summary|pricing|config
 *   /api/dsh-quota-visor/quota|config  （config 自动做 v1 ↔ v2 视图转换）
 *
 * 启动时自动执行旧配置迁移（core/config.migrateLegacyConfigs）：合并
 * dsh-usage-board 与 dsh-quota-visor 的 config.json 进 v2，复制索引缓存。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { API_BASE, emptyPricingResponse, PLUGIN_ID } from './core/pricing.js'
import { dshHomeDir } from './core/home.js'
import {
  boardConfigView,
  loadConfig,
  mergeBoardConfig,
  mergeVisorConfig,
  migrateLegacyConfigs,
  normalizeUsageConfig,
  saveConfig,
  visorConfigView,
} from './core/config.js'
import { indexSessionUsage } from './session/index.js'
import { createBoardIndexState, ensureBoardIndex, warmupBoardIndex } from './board/index.js'
import { buildSummary } from './board/summary.js'
import type { RangeKey } from './board/shared.js'
import { clearQuotaCache, queryAllQuotas, queryQuota } from './quota/service.js'

export const name = PLUGIN_ID
export const inject: string[] = []

/** PUT body 上限。 */
const MAX_BODY_BYTES = 256 * 1024

const RANGE_SET = new Set<string>(['1d', '7d', '30d', 'all'])

/* ───────────────────────── HTTP plumbing ───────────────────────── */

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体超过上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('allow', allow)
  sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED', message: 'method not allowed' })
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>

interface WebLike {
  register(options: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void
}

/* ───────────────────────── 路由处理 ───────────────────────── */

const handleSession: Handler = async (req, res, url) => {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return
  }
  const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
  if (sessionId === '') {
    sendJson(res, 400, { ok: false, error: 'MISSING_SESSION', message: 'sessionId 必填' })
    return
  }
  const index = await indexSessionUsage(sessionId)
  sendJson(res, 200, {
    ok: true,
    sessionId: index.sessionId,
    found: index.found,
    indexedAt: index.indexedAt,
    models: index.models,
  })
}

export function apply(ctx: Context): void {
  const home = dshHomeDir()
  const boardState = createBoardIndexState()

  const handleSummary: Handler = async (req, res, url) => {
    if (req.method !== 'GET') {
      methodNotAllowed(res, 'GET')
      return
    }
    const range = url.searchParams.get('range') ?? '7d'
    if (!RANGE_SET.has(range)) {
      sendJson(res, 400, { ok: false, error: 'BAD_RANGE', message: 'range 必须是 1d / 7d / 30d / all 之一' })
      return
    }
    const refresh = url.searchParams.get('refresh') === '1'
    const config = await loadConfig(home)
    const started = Date.now()
    await ensureBoardIndex(boardState, refresh, home)
    const summary = buildSummary(boardState.cache, { range: range as RangeKey, config })
    summary.tookMs = Date.now() - started
    summary.scanned.reindexed = boardState.stats.reindexed
    sendJson(res, 200, summary)
  }

  const handlePricing: Handler = async (req, res) => {
    if (req.method !== 'GET') {
      methodNotAllowed(res, 'GET')
      return
    }
    sendJson(res, 200, emptyPricingResponse(await loadConfig(home)))
  }

  const handleQuota: Handler = async (req, res, url) => {
    const provider = url.searchParams.get('provider') ?? ''
    const refresh = url.searchParams.get('refresh') === '1'
    if (req.method !== 'GET' || provider === '') {
      sendJson(res, req.method !== 'GET' ? 405 : 400, { ok: false, error: 'BAD_REQUEST', message: '需要 GET 且携带 provider 查询参数' })
      if (req.method !== 'GET') res.setHeader('allow', 'GET')
      return
    }
    sendJson(res, 200, await queryQuota(provider, refresh, home))
  }

  const handleQuotaAll: Handler = async (req, res, url) => {
    if (req.method !== 'GET') {
      methodNotAllowed(res, 'GET')
      return
    }
    const refresh = url.searchParams.get('refresh') === '1'
    sendJson(res, 200, await queryAllQuotas(refresh, home))
  }

  const handleConfig: Handler = async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, await loadConfig(home))
      return
    }
    if (req.method === 'PUT') {
      let parsed: unknown
      try {
        parsed = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8'))
      } catch (error) {
        sendJson(res, 400, { ok: false, error: 'INVALID_JSON', message: error instanceof Error ? error.message : '请求体不是合法 JSON' })
        return
      }
      const config = normalizeUsageConfig(parsed)
      await saveConfig(config, home)
      clearQuotaCache()
      sendJson(res, 200, config)
      return
    }
    methodNotAllowed(res, 'GET, PUT')
  }

  /** 旧 dsh-usage-board /config：v1 视图双向转换（models/rateUsdCny 子集）。 */
  const handleLegacyBoardConfig: Handler = async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, boardConfigView(await loadConfig(home)))
      return
    }
    if (req.method === 'PUT') {
      let parsed: unknown
      try {
        parsed = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8'))
      } catch (error) {
        sendJson(res, 400, { error: 'INVALID_JSON', message: error instanceof Error ? error.message : '请求体不是合法 JSON' })
        return
      }
      const next = mergeBoardConfig(await loadConfig(home), parsed)
      await saveConfig(next, home)
      sendJson(res, 200, boardConfigView(next))
      return
    }
    methodNotAllowed(res, 'GET, PUT')
  }

  /** 旧 dsh-quota-visor /config：v1 视图双向转换（providers/refreshMs 子集）。 */
  const handleLegacyVisorConfig: Handler = async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, visorConfigView(await loadConfig(home)))
      return
    }
    if (req.method === 'PUT') {
      let parsed: unknown
      try {
        parsed = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8'))
      } catch (error) {
        sendJson(res, 400, { error: 'INVALID_JSON', message: error instanceof Error ? error.message : '请求体不是合法 JSON' })
        return
      }
      const next = mergeVisorConfig(await loadConfig(home), parsed)
      await saveConfig(next, home)
      clearQuotaCache()
      sendJson(res, 200, visorConfigView(next))
      return
    }
    methodNotAllowed(res, 'GET, PUT')
  }

  ctx.inject(['webServer'], (httpCtx) => {
    const web = httpCtx.webServer as WebLike
    httpCtx.effect(() => {
      // 启动：迁移旧配置（幂等），再预热全局索引。
      void migrateLegacyConfigs(home, (msg) => ctx.logger?.info?.(`[${name}] migrate: ${msg}`))
        .catch((error) => ctx.logger?.warn?.(`[${name}] migrate failed: ${error instanceof Error ? error.message : String(error)}`))
      warmupBoardIndex(boardState, home)

      const routes: Array<[string, Handler]> = [
        // 新统一前缀
        [`${API_BASE}/session`, handleSession],
        [`${API_BASE}/summary`, handleSummary],
        [`${API_BASE}/pricing`, handlePricing],
        [`${API_BASE}/quota`, handleQuota],
        [`${API_BASE}/quota/all`, handleQuotaAll],
        [`${API_BASE}/config`, handleConfig],
        // 兼容别名（一个版本后移除）
        ['/api/dsh-token-cost/usage', handleSession],
        ['/api/dsh-usage-board/summary', handleSummary],
        ['/api/dsh-usage-board/pricing', handlePricing],
        ['/api/dsh-usage-board/config', handleLegacyBoardConfig],
        ['/api/dsh-quota-visor/quota', handleQuota],
        ['/api/dsh-quota-visor/config', handleLegacyVisorConfig],
      ]

      const disposers = routes.map(([path, handler]) =>
        web.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            try {
              const url = new URL(req.url ?? '/', 'http://dsh-usage.local')
              await handler(req, res, url)
            } catch (error) {
              // 不回显内部异常消息（可能含本机绝对路径），细节只进 host 日志。
              ctx.logger?.warn?.(`[${name}] ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
              if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'INTERNAL', message: 'internal error' })
            }
          },
        }),
      )

      ctx.logger?.info?.(`[${name}] API ready: ${API_BASE}/session | /summary | /pricing | /quota | /quota/all | /config（含 6 条兼容别名）`)
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, `${name}: unified usage api`)
  })
}
