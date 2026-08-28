/**
 * @hsinsekai-nanami/dsh-usage — client：实时费用徽标（对话头部左侧）。
 *
 * 常态只显示一行 `¥0.0123 / $0.0017`；悬停展开明细：当前选择模型及其单价、
 * 逐模型分段计费、总 Token、输入/缓存/输出拆分、上下文近似组成。
 *
 * 数据通路：
 *   - 「当前选择模型」读 ui-model-selection 的共享目录 store（与 composer 选择器同一份状态）；
 *   - 「逐模型分段计费」读 host API GET /api/dsh-usage/session?sessionId=…（5s 轮询 + 投影变化即拉）；
 *   - tokenUsage / contextBreakdown 投影（host 的 dsh-token-meter 提供）用于组成展示与降级估算。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ConversationSnapshot, UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  API_BASE,
  DEFAULT_EXCHANGE_RATE,
  estimateCostCny,
  formatMoney,
  formatPriceLine,
  formatTokens,
  isPeakHour,
  priceSessionUsage,
  resolvePrice,
  totalTokens,
  type ContextBreakdown,
  type SessionUsageResponse,
  type TokenUsage,
} from '../core/pricing'

const POLL_INTERVAL_MS = 5_000

export const SESSION_BADGE_CSS = `
.dtc-root{position:relative;display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-mask-2,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-l2);cursor:default;user-select:none;white-space:nowrap}
.dtc-root:hover,.dtc-root:focus-within{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dtc-popover{display:none;position:absolute;top:calc(100% + 6px);left:0;z-index:2147483001;min-width:320px;max-width:420px;padding:10px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.18);backdrop-filter:blur(10px);color:var(--dsw-alias-label-primary);text-align:left;white-space:normal;font-size:12px;line-height:1.6}
.dtc-root:hover .dtc-popover,.dtc-root:focus-within .dtc-popover{display:block}
.dtc-pop-title{font-size:12px;font-weight:650;margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.dtc-model{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.dtc-row{display:flex;justify-content:space-between;gap:12px}
.dtc-row+.dtc-row{margin-top:3px}
.dtc-muted{color:var(--dsw-alias-label-tertiary)}
.dtc-num{font-variant-numeric:tabular-nums}
.dtc-divider{height:1px;background:var(--dsw-alias-border-l2);margin:8px 0}
.dtc-note{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:8px;line-height:1.5}
.dtc-badge{opacity:.75}
.dtc-root:hover .dtc-badge{opacity:1}
.dtc-est{font-size:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 3px;color:var(--dsw-alias-label-tertiary);margin-left:4px}
.dtc-sec{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:2px 0}
.dtc-board-link{display:inline-block;margin-top:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
`

/* ───────────────────────── 注入面（client/index 提供） ───────────────────────── */

/** 官方 ModelSelection 的结构子集（provider / model / reasoningEffort）。 */
interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface DirectoryStore {
  subscribe(fn: () => void): () => void
  getSnapshot(): { current: ModelSelection | null }
}

export interface SessionBadgeInject {
  /** host half 的逐模型归集 API；不可达/失败返回 null（降级路径）。 */
  fetchUsage(sessionId: string): Promise<SessionUsageResponse | null>
  /** 会话共享模型目录 store（与 composer 选择器同一份状态）；不可用返回 null。 */
  getDirectoryStore(sessionId: string): DirectoryStore | null
  /** 触发一次目录加载，填充 store.current（fire-and-forget）。 */
  primeDirectory(sessionId: string): void
}

export interface SessionBadgeProps extends SessionBadgeInject {
  sessionId: string
  useSession: <S>(selector: (snapshot: ConversationSnapshot) => S) => S
  useProjection: UseProjection
}

const noopSubscribe = (): (() => void) => () => undefined
const nullSnapshot = (): null => null

/** 金额小数位数：与 formatMoney 同一套自适应规则。 */
const cnyDigits = (cny: number): number => (cny === 0 ? 2 : cny < 0.01 ? 4 : cny < 1 ? 3 : 2)

/** 构造 fetchUsage（API 路径集中在此，便于兼容期切换）。 */
export function createFetchUsage(): SessionBadgeInject['fetchUsage'] {
  return async (sessionId) => {
    try {
      const response = await fetch(`${API_BASE}/session?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      if (!response.ok) return null
      const body = (await response.json()) as Partial<SessionUsageResponse> | null
      if (body === null || typeof body !== 'object' || body.ok !== true) return null
      if (typeof body.sessionId !== 'string' || !Array.isArray(body.models)) return null
      return body as SessionUsageResponse
    } catch {
      return null
    }
  }
}

/* ───────────────────────── 组件 ───────────────────────── */

export function SessionBadge(props: SessionBadgeProps): JSX.Element {
  const usage = props.useProjection('tokenUsage' as never) as TokenUsage | undefined
  const breakdown = props.useProjection('contextBreakdown' as never) as ContextBreakdown | undefined

  /* 当前选择模型：ui-model-selection 的共享目录 store，切换即时反映。 */
  const directoryStore = useMemo(
    () => props.getDirectoryStore(props.sessionId),
    [props.getDirectoryStore, props.sessionId],
  )
  useEffect(() => {
    props.primeDirectory(props.sessionId)
  }, [props.primeDirectory, props.sessionId])
  const subscribeDirectory = useCallback(
    (fn: () => void) => (directoryStore !== null ? directoryStore.subscribe(fn) : noopSubscribe()),
    [directoryStore],
  )
  const readDirectory = useCallback(
    () => (directoryStore !== null ? directoryStore.getSnapshot().current : null),
    [directoryStore],
  )
  const currentSelection = useSyncExternalStore(subscribeDirectory, readDirectory, nullSnapshot)

  /* 逐模型归集：5s 轮询 + 用量投影变化即拉。 */
  const [report, setReport] = useState<SessionUsageResponse | null>(null)
  const refreshRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      if (document.visibilityState === 'hidden') return
      void props
        .fetchUsage(props.sessionId)
        .then((next) => {
          if (!cancelled && next !== null) setReport(next)
        })
        .catch(() => undefined)
    }
    refreshRef.current = refresh
    refresh()
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS)
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [props.fetchUsage, props.sessionId])
  useEffect(() => {
    // tokenUsage 投影有新样本（新请求落账）时立即拉一次，别等轮询。
    refreshRef.current()
  }, [usage])

  /* 折算：优先逐模型分段计费；host 不可达时按当前模型整段估算（降级）。 */
  const summary = useMemo(
    () => (report !== null && report.found && report.models.length > 0 ? priceSessionUsage(report.models) : null),
    [report],
  )
  const currentPrice = useMemo(() => resolvePrice(currentSelection?.model), [currentSelection])
  const fallbackCny = currentPrice !== null ? estimateCostCny(usage, currentPrice) : 0
  const hostMode = summary !== null
  const cny = hostMode ? summary.totalCny : fallbackCny
  const usd = cny / DEFAULT_EXCHANGE_RATE

  const projectionTotal = totalTokens(usage)
  const displayTotal = hostMode ? summary.totalTokens : projectionTotal
  const peakLabel = isPeakHour() ? '高峰时段' : '空闲时段'
  const currentModelLabel = currentSelection?.model ?? '—'

  return (
    <div className="dtc-root" tabIndex={0} aria-label={`Token 消耗约 ${formatTokens(displayTotal)}，费用约 ${formatMoney(cny)}`}>
      <span className="dtc-badge">{hostMode ? '' : '≈'}{formatMoney(cny)}</span>
      <div className="dtc-popover" role="tooltip">
        <div className="dtc-pop-title">
          <span>Token 消耗 / 费用</span>
          <span className="dtc-model">{hostMode ? '按请求实际模型分段计费' : '降级：按当前模型整段估算'}</span>
        </div>

        <div className="dtc-row">
          <span>当前选择模型</span>
          <span className="dtc-num">
            {currentModelLabel}
            {currentSelection?.provider ? <span className="dtc-muted"> · {currentSelection.provider}</span> : undefined}
          </span>
        </div>
        {currentSelection !== null && (
          <div className="dtc-note" style={{ marginTop: 2 }}>
            {currentPrice !== null
              ? `${currentPrice.label}${currentPrice.entry.estimated ? '（估算价）' : ''} · ${peakLabel} · ${formatPriceLine(currentPrice)}`
              : '价格未收录：该模型 tokens 照常计量，费用暂不计入'}
          </div>
        )}

        {summary !== null && (
          <>
            <div className="dtc-divider" />
            <div className="dtc-sec">按模型计费明细</div>
            {summary.lines.map((line) => (
              <div className="dtc-row" key={line.model}>
                <span>
                  {line.label ?? line.model}
                  {line.label === null ? <span className="dtc-est">未收录</span> : line.estimated ? <span className="dtc-est">估算</span> : undefined}
                  <span className="dtc-muted" style={{ marginLeft: 6 }}>{formatTokens(line.usage.input + line.usage.cacheRead + line.usage.cacheWrite + line.usage.output)}</span>
                </span>
                <span className="dtc-num">{line.label === null ? '—' : `¥${line.costCny.toFixed(cnyDigits(line.costCny))}`}</span>
              </div>
            ))}
            {summary.unmatchedTokens > 0 && (
              <div className="dtc-note">另有 {formatTokens(summary.unmatchedTokens)} tokens 的模型价格未收录，已计量、未计费。</div>
            )}
          </>
        )}

        <div className="dtc-divider" />

        <div className="dtc-row">
          <span>累计 Token（计费口径）</span>
          <span className="dtc-num">{formatTokens(displayTotal)}</span>
        </div>
        <div className="dtc-row">
          <span className="dtc-muted">未缓存输入</span>
          <span className="dtc-num">{formatTokens(hostMode ? summary.lines.reduce((s, l) => s + l.usage.input, 0) : usage?.uncachedInputTokens ?? 0)}</span>
        </div>
        <div className="dtc-row">
          <span className="dtc-muted">缓存读取</span>
          <span className="dtc-num">{formatTokens(hostMode ? summary.lines.reduce((s, l) => s + l.usage.cacheRead, 0) : usage?.cacheReadTokens ?? 0)}</span>
        </div>
        <div className="dtc-row">
          <span className="dtc-muted">缓存写入</span>
          <span className="dtc-num">{formatTokens(hostMode ? summary.lines.reduce((s, l) => s + l.usage.cacheWrite, 0) : usage?.cacheWriteTokens ?? 0)}</span>
        </div>
        <div className="dtc-row">
          <span className="dtc-muted">输出</span>
          <span className="dtc-num">{formatTokens(hostMode ? summary.lines.reduce((s, l) => s + l.usage.output, 0) : usage?.outputTokens ?? 0)}</span>
        </div>

        <div className="dtc-divider" />

        <div className="dtc-row">
          <span>估算费用</span>
          <span className="dtc-num">{formatMoney(cny)}</span>
        </div>
        <div className="dtc-row">
          <span className="dtc-muted">美元（汇率 {DEFAULT_EXCHANGE_RATE}）</span>
          <span className="dtc-num">${usd.toFixed(cny < 0.01 ? 4 : cny < 1 ? 3 : 2)}</span>
        </div>

        <div className="dtc-divider" />

        <div className="dtc-row">
          <span>System Prompt / Skill（近似）</span>
          <span className="dtc-num">{formatTokens(breakdown?.systemTokens ?? 0)}</span>
        </div>
        <div className="dtc-row">
          <span className="dtc-muted">工具 / Skill Schema（近似）</span>
          <span className="dtc-num">{formatTokens(breakdown?.toolsTokens ?? 0)}</span>
        </div>
        <div className="dtc-row">
          <span className="dtc-muted">对话消息（近似）</span>
          <span className="dtc-num">{formatTokens(breakdown?.messageTokens ?? 0)}</span>
        </div>

        <div className="dtc-note">
          {hostMode
            ? `费用按每条请求实际使用的模型分段计价（${peakLabel}；DeepSeek 分时刊例、Kimi/GLM 官方或估算刊例），随会话内切换模型自动跟随。`
            : 'host 归集 API 暂不可达：当前展示为累计用量 × 当前模型单价的整段估算。'}
          System Prompt / Skill 为启发式近似，不与计费总和严格相等。
        </div>
        <span className="dtc-board-link">全局账单与订阅额度 → 设置 · 用量看板</span>
      </div>
    </div>
  )
}
