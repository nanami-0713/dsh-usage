/**
 * @dsh-external/dsh-usage — client：Coding Plan 订阅额度徽标（对话头部右侧）。
 *
 * 当前 provider 未识别为 Coding Plan 时不渲染；常态：适配器名 + 5 小时额度
 * 迷你进度条 + 百分比 + 距重置倒计时；悬停展开全部额度窗口。
 *
 * 数据通路：当前 provider/model 经 connection API `session.models` 读取；
 * 额度快照经 host API GET /api/dsh-usage/quota 拉取（key 留在 host）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  DEFAULT_REFRESH_MS,
  SELECTION_POLL_MS,
  formatCount,
  formatDuration,
  formatPercent,
  usageLevel,
  windowFraction,
  type QuotaResponse,
  type QuotaWindow,
} from '../quota/shared'
import { API_BASE } from '../core/pricing'

export const QUOTA_BADGE_CSS = `
.dqv-root{position:relative;display:inline-flex;align-items:center;gap:6px;padding:1px 9px;border-radius:999px;font-size:11px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-mask-2,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-l2);cursor:default;user-select:none;white-space:nowrap}
.dqv-root:hover,.dqv-root:focus-within{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dqv-name{font-weight:550}
.dqv-track{width:64px;height:5px;border-radius:999px;background:var(--dsw-alias-bg-mask-3,rgba(127,127,127,.22));overflow:hidden;flex:none}
.dqv-fill{height:100%;border-radius:999px;transition:width .4s ease}
.dqv-fill-ok{background:#34a853}
.dqv-fill-warn{background:#e8a718}
.dqv-fill-danger{background:#e04b3a}
.dqv-pct{min-width:30px;text-align:right}
.dqv-pct-ok{color:var(--dsw-alias-label-secondary)}
.dqv-pct-warn{color:#b07800}
.dqv-pct-danger{color:#e04b3a;font-weight:600}
.dqv-reset{color:var(--dsw-alias-label-tertiary)}
.dqv-loading{color:var(--dsw-alias-label-tertiary)}
.dqv-error-dot{width:6px;height:6px;border-radius:50%;background:#e04b3a;flex:none}
.dqv-popover{display:none;position:absolute;top:calc(100% + 6px);right:0;z-index:2147483001;min-width:320px;max-width:420px;padding:12px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.18);backdrop-filter:blur(10px);color:var(--dsw-alias-label-primary);text-align:left;white-space:normal;font-size:12px;line-height:1.6}
.dqv-root:hover .dqv-popover,.dqv-root:focus-within .dqv-popover{display:block}
.dqv-pop-title{font-size:12px;font-weight:650;margin-bottom:8px;display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dqv-pop-plan{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.dqv-win{margin-bottom:9px}
.dqv-win:last-of-type{margin-bottom:2px}
.dqv-win-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:3px}
.dqv-win-label{font-weight:550}
.dqv-win-nums{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dqv-win-track{width:100%;height:6px;border-radius:999px;background:var(--dsw-alias-bg-mask-3,rgba(127,127,127,.22));overflow:hidden}
.dqv-win-fill{height:100%;border-radius:999px}
.dqv-win-reset{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-tertiary);display:flex;justify-content:space-between;gap:8px}
.dqv-notes{margin:2px 0 0;padding:0;list-style:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dqv-divider{height:1px;background:var(--dsw-alias-border-l2);margin:9px 0}
.dqv-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dqv-refresh{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 8px;border-radius:6px;cursor:pointer}
.dqv-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dqv-errmsg{color:#e04b3a;font-size:11px;margin:2px 0 0;word-break:break-all}
`

export interface ModelSelectionInfo {
  provider: string
  model: string
}

export interface QuotaBadgeProps {
  sessionId: string
  useSession: <S>(selector: (snapshot: ConversationSnapshot) => S) => S
  getSelection: (sessionId: string) => Promise<ModelSelectionInfo | undefined>
  fetchQuota: (provider: string, force: boolean) => Promise<QuotaResponse | undefined>
  refreshMs: number
}

/** 构造 fetchQuota（API 路径集中在此，便于兼容期切换）。 */
export function createFetchQuota(): QuotaBadgeProps['fetchQuota'] {
  return async (provider, force) => {
    try {
      const response = await fetch(`${API_BASE}/quota?provider=${encodeURIComponent(provider)}${force ? '&refresh=1' : ''}`, { cache: 'no-store' })
      if (!response.ok) return undefined
      return (await response.json()) as QuotaResponse
    } catch {
      return undefined
    }
  }
}

/** 快照回退：最近一条 assistant 消息记录的 provider/model。 */
function latestSelection(snapshot: ConversationSnapshot): ModelSelectionInfo | undefined {
  const nodes = snapshot.chat.legacy.nodes
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]
    if (node.kind !== 'assistant') continue
    const model = node.requestConfig?.model ?? node.provenance?.model
    if (model) {
      const provider = node.requestConfig?.provider ?? node.provenance?.provider
      if (provider) return { provider, model }
      return { provider: '', model }
    }
  }
  return undefined
}

/** 单个额度窗口行（头部徽标弹层与设置页「订阅额度」区块共用）。 */
export function QuotaWindowRow(props: { window: QuotaWindow; now: number }): JSX.Element {
  const fraction = windowFraction(props.window)
  const level = usageLevel(fraction)
  const resetLeft = props.window.resetsAt !== undefined ? formatDuration(props.window.resetsAt - props.now) : undefined
  const resetAt = props.window.resetsAt !== undefined ? new Date(props.window.resetsAt).toLocaleString() : undefined
  return (
    <div className="dqv-win">
      <div className="dqv-win-head">
        <span className="dqv-win-label">{props.window.label}</span>
        <span className="dqv-win-nums">
          {formatCount(props.window.used, props.window.unit)} / {formatCount(props.window.limit, props.window.unit)} · {formatPercent(fraction)}
        </span>
      </div>
      <div className="dqv-win-track">
        <div className={`dqv-win-fill dqv-fill-${level}`} style={{ width: `${Math.max(fraction * 100, fraction > 0 ? 2 : 0)}%` }} />
      </div>
      <div className="dqv-win-reset">
        <span>{resetLeft !== undefined ? `重置 ${resetAt}` : '无明确重置点'}</span>
        <span>{resetLeft !== undefined ? `剩 ${resetLeft}` : ''}</span>
      </div>
    </div>
  )
}

export function QuotaBadge(props: QuotaBadgeProps): JSX.Element | null {
  const [selection, setSelection] = useState<ModelSelectionInfo | undefined>(undefined)
  const [quota, setQuota] = useState<QuotaResponse | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const requestSeq = useRef(0)
  const fallbackSelection = props.useSession((snapshot) => latestSelection(snapshot))

  const current = selection ?? (fallbackSelection !== undefined && fallbackSelection.provider !== '' ? fallbackSelection : undefined)
  const provider = current?.provider

  // 感知模型切换：sessionId 变化立即查询 + 周期轮询
  useEffect(() => {
    let cancelled = false
    const pull = async (): Promise<void> => {
      const info = await props.getSelection(props.sessionId).catch(() => undefined)
      if (!cancelled && info !== undefined) setSelection(info)
    }
    void pull()
    const timer = window.setInterval(() => void pull(), SELECTION_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [props.sessionId, props.getSelection])

  // provider 变化 → 拉额度
  useEffect(() => {
    if (provider === undefined || provider === '') {
      setQuota(undefined)
      return
    }
    let cancelled = false
    const seq = ++requestSeq.current
    setLoading(true)
    props
      .fetchQuota(provider, false)
      .then((response) => {
        if (!cancelled && requestSeq.current === seq) setQuota(response)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled && requestSeq.current === seq) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [provider, props.fetchQuota])

  // 周期刷新当前 provider 的额度
  useEffect(() => {
    if (provider === undefined || provider === '') return
    const timer = window.setInterval(() => {
      const seq = ++requestSeq.current
      props
        .fetchQuota(provider, false)
        .then((response) => {
          if (requestSeq.current === seq && response !== undefined) setQuota(response)
        })
        .catch(() => undefined)
    }, props.refreshMs)
    return () => window.clearInterval(timer)
  }, [provider, props.fetchQuota, props.refreshMs])

  // 倒计时每 30s 重绘
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  void tick

  const manualRefresh = useCallback(async (): Promise<void> => {
    if (provider === undefined || provider === '') return
    setLoading(true)
    const response = await props.fetchQuota(provider, true).catch(() => undefined)
    if (response !== undefined) setQuota(response)
    setLoading(false)
  }, [provider, props.fetchQuota])

  // 非 Coding Plan：不渲染（保持 utilities 区干净）
  if (provider === undefined || provider === '') return null
  if (quota !== undefined && !quota.ok && quota.error === 'NOT_CODING_PLAN') return null

  const snapshot = quota?.snapshot
  const primary = snapshot?.windows.find((window) => window.id === snapshot.primaryId)

  if (snapshot !== undefined && primary !== undefined) {
    const fraction = windowFraction(primary)
    const level = usageLevel(fraction)
    const resetLeft = primary.resetsAt !== undefined ? formatDuration(primary.resetsAt - Date.now()) : undefined
    return (
      <div
        className="dqv-root"
        tabIndex={0}
        aria-label={`${snapshot.adapterLabel}${snapshot.planLabel !== undefined ? ` ${snapshot.planLabel}` : ''}：${primary.label}已用 ${formatPercent(fraction)}`}
      >
        <span className="dqv-name">{snapshot.adapterLabel.replace(' Coding Plan', '')}</span>
        <span className="dqv-track">
          <span className={`dqv-fill dqv-fill-${level}`} style={{ display: 'block', width: `${Math.max(fraction * 100, fraction > 0 ? 3 : 0)}%` }} />
        </span>
        <span className={`dqv-pct dqv-pct-${level}`}>{formatPercent(fraction)}</span>
        {resetLeft !== undefined && <span className="dqv-reset">↻{resetLeft}</span>}
        <div className="dqv-popover" role="tooltip">
          <div className="dqv-pop-title">
            <span>{snapshot.adapterLabel}</span>
            <span className="dqv-pop-plan">
              {snapshot.planLabel !== undefined ? `${snapshot.planLabel} · ` : ''}
              {current?.model ?? ''}
            </span>
          </div>
          {snapshot.windows.map((window) => (
            <QuotaWindowRow key={window.id} window={window} now={Date.now()} />
          ))}
          {snapshot.notes !== undefined && snapshot.notes.length > 0 && (
            <div>
              <div className="dqv-divider" />
              <ul className="dqv-notes">
                {snapshot.notes.map((note) => (
                  <li key={note}>· {note}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="dqv-divider" />
          <div className="dqv-foot">
            <span>更新于 {new Date(snapshot.fetchedAt).toLocaleTimeString()}</span>
            <button type="button" className="dqv-refresh" onClick={() => void manualRefresh()} disabled={loading}>
              {loading ? '刷新中…' : '刷新'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 错误 / 加载中态：保留一个可悬停的小徽标，避免额度查询失败时 UI 闪烁消失
  return (
    <div className="dqv-root" tabIndex={0} aria-label="Coding Plan 额度暂不可用">
      {loading ? <span className="dqv-loading">额度查询中…</span> : <span className="dqv-error-dot" />}
      {!loading && <span>额度</span>}
      <div className="dqv-popover" role="tooltip">
        {quota?.message !== undefined ? (
          <p className="dqv-errmsg">{quota.message}</p>
        ) : (
          <p className="dqv-notes">正在从 {provider} 的订阅端点拉取额度…</p>
        )}
        <div className="dqv-divider" />
        <div className="dqv-foot">
          <span>{current?.model ?? provider}</span>
          <button type="button" className="dqv-refresh" onClick={() => void manualRefresh()} disabled={loading}>
            {loading ? '刷新中…' : '重试'}
          </button>
        </div>
      </div>
    </div>
  )
}
