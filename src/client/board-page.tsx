/**
 * @dsh-external/dsh-usage — client：设置页「用量看板」。
 *
 * 全局账单（历史）：时间筛选 / 汇总卡片 / 各模型花费折线图 / 模型与文件夹明细；
 * 订阅额度（余量）：当前 DSH 中配置的全部 Coding Plan 额度窗口进度条
 * （GET /api/dsh-usage/quota/all，数据与头部右徽标同源）。
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
// settings.section 槽位契约（含 SettingsSectionOwnerProps），type-only。
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { API_BASE } from '../core/pricing'
import { QuotaWindowRow } from './quota-badge'
import {
  formatPercent,
  usageLevel,
  windowFraction,
  type QuotaAllResponse,
} from '../quota/shared'
import {
  RANGE_KEYS,
  RANGE_LABELS,
  formatMoney,
  formatSeriesKey,
  formatTokens,
  type ModelRow,
  type RangeKey,
  type SummaryResponse,
} from '../board/shared'

export const BOARD_CSS = `
.dub-root{--dub-fg:var(--dsw-alias-label-primary);--dub-fg2:var(--dsw-alias-label-secondary);--dub-fg3:var(--dsw-alias-label-tertiary);--dub-border:var(--dsw-alias-border-l2);--dub-bg:var(--dsw-alias-bg-layer-1,transparent);max-width:920px;color:var(--dub-fg);font-size:13px;line-height:1.55;padding:4px 2px 24px}
.dub-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;margin:2px 0 14px}
.dub-title{font-size:16px;font-weight:700}
.dub-sub{font-size:12px;color:var(--dub-fg3)}
.dub-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 14px}
.dub-seg{display:inline-flex;border:1px solid var(--dub-border);border-radius:9px;overflow:hidden}
.dub-seg button{border:none;background:transparent;color:var(--dub-fg2);font-size:12px;padding:5px 12px;cursor:pointer;white-space:nowrap}
.dub-seg button+button{border-left:1px solid var(--dub-border)}
.dub-seg button[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-selected,rgba(79,110,247,.14));color:var(--dub-fg);font-weight:600}
.dub-btn{border:1px solid var(--dub-border);background:transparent;color:var(--dub-fg2);border-radius:9px;font-size:12px;padding:5px 12px;cursor:pointer}
.dub-btn:hover:not(:disabled){color:var(--dub-fg);background:var(--dsw-alias-interactive-bg-hover)}
.dub-btn:disabled{opacity:.5;cursor:default}
.dub-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.dub-card{border:1px solid var(--dub-border);border-radius:12px;padding:10px 12px;background:var(--dub-bg)}
.dub-card-label{font-size:11px;color:var(--dub-fg3);margin-bottom:4px}
.dub-card-value{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
.dub-card-sub{font-size:11px;color:var(--dub-fg2);margin-top:2px;font-variant-numeric:tabular-nums}
.dub-section{border:1px solid var(--dub-border);border-radius:12px;padding:12px 14px;background:var(--dub-bg);margin-bottom:16px}
.dub-section-title{font-size:13px;font-weight:650;margin-bottom:10px;display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.dub-section-note{font-size:11px;color:var(--dub-fg3);font-weight:400}
.dub-chart-wrap{position:relative;width:100%}
.dub-chart-wrap svg{display:block;width:100%;height:auto}
.dub-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px}
.dub-legend-item{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dub-fg2);cursor:pointer;user-select:none;border:none;background:none;padding:2px 4px;border-radius:6px}
.dub-legend-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dub-legend-item .dub-dot{width:9px;height:9px;border-radius:3px;flex:none}
.dub-legend-item[aria-pressed="false"]{opacity:.38}
.dub-tooltip{position:absolute;z-index:30;pointer-events:none;min-width:180px;max-width:280px;padding:8px 10px;border-radius:10px;border:1px solid var(--dub-border);background:var(--dsw-alias-bg-layer-2,var(--dub-bg));box-shadow:0 10px 26px rgba(0,0,0,.16);font-size:11.5px}
.dub-tooltip-title{font-weight:650;margin-bottom:4px}
.dub-tooltip-row{display:flex;justify-content:space-between;gap:12px;font-variant-numeric:tabular-nums}
.dub-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.dub-table th{font-size:11px;font-weight:600;color:var(--dub-fg3);text-align:right;padding:6px 8px;border-bottom:1px solid var(--dub-border);white-space:nowrap}
.dub-table th:first-child,.dub-table td:first-child{text-align:left}
.dub-table td{padding:7px 8px;text-align:right;border-bottom:1px solid var(--dsw-alias-border-l1,transparent);white-space:nowrap}
.dub-table tbody tr:last-child td{border-bottom:none}
.dub-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dub-model-name{font-weight:600;cursor:pointer}
.dub-model-name .dub-caret{display:inline-block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid var(--dub-fg3);margin:0 6px 1px 2px;vertical-align:middle;transition:transform .15s ease}
.dub-model-name[data-open="true"] .dub-caret{transform:rotate(180deg)}
.dub-muted{color:var(--dub-fg3)}
.dub-folder-cwd{display:block;font-size:11px;color:var(--dub-fg3);max-width:340px;overflow:hidden;text-overflow:ellipsis}
.dub-rules{grid-column:1/-1}
.dub-rules-inner{padding:8px 10px 10px;border:1px dashed var(--dub-border);border-radius:10px;background:var(--dsw-alias-bg-mask-1,rgba(127,127,127,.04))}
.dub-rule{padding:6px 0}
.dub-rule+.dub-rule{border-top:1px solid var(--dsw-alias-border-l1,transparent)}
.dub-rule-head{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}
.dub-rule-name{font-weight:600;font-size:12.5px}
.dub-rule-req{font-size:11px;color:var(--dub-fg3)}
.dub-rule-prices{font-size:12px;color:var(--dub-fg2);font-variant-numeric:tabular-nums}
.dub-rule-source{font-size:11px;color:var(--dub-fg3);margin-top:2px}
.dub-badge{display:inline-block;font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--dub-border);color:var(--dub-fg2);vertical-align:1px}
.dub-badge-warn{color:#b07800;border-color:rgba(176,120,0,.45)}
.dub-notes{font-size:11.5px;color:var(--dub-fg3);line-height:1.7}
.dub-notes ul{margin:4px 0 0;padding-left:16px}
.dub-warn{color:#b07800}
.dub-error{border:1px solid rgba(224,75,58,.5);border-radius:12px;padding:12px 14px;color:#e04b3a;font-size:12.5px;margin-bottom:14px}
.dub-loading{color:var(--dub-fg3);font-size:12.5px;padding:24px 0;text-align:center}
.dub-empty{color:var(--dub-fg3);font-size:12.5px;padding:24px 0;text-align:center}
.dub-quota-card{border:1px solid var(--dub-border);border-radius:10px;padding:10px 12px;margin-bottom:10px}
.dub-quota-card:last-of-type{margin-bottom:2px}
.dub-quota-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:8px}
.dub-quota-name{font-weight:650;font-size:12.5px}
.dub-quota-foot{margin-top:6px;font-size:11px;color:var(--dub-fg3)}
.dub-quota-err{color:#e04b3a;font-size:12px;margin:2px 0}
`


const SERIES_COLORS = ['#4f6ef7', '#e8590c', '#0f9d58', '#9c27b0', '#00838f', '#c2185b', '#8d6e63', '#5c6bc0']

/* ───────────────────────── 主页面 ───────────────────────── */

type Currency = 'CNY' | 'USD'

export function UsageBoardSection(_props: SettingsSectionOwnerProps): JSX.Element {
  const [range, setRange] = useState<RangeKey>('7d')
  const [currency, setCurrency] = useState<Currency>('CNY')
  const [data, setData] = useState<SummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async (nextRange: RangeKey, refresh: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const url = `${API_BASE}/summary?range=${nextRange}${refresh ? '&refresh=1' : ''}`
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) {
        const detail = await response.json().catch(() => null)
        throw new Error(detail?.message || `HTTP ${response.status}`)
      }
      const payload = (await response.json()) as SummaryResponse
      if (!payload.ok) throw new Error('接口返回异常')
      setData(payload)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchData(range, false)
  }, [range, fetchData])

  const money = useCallback(
    (cny: number, usd: number) => formatMoney(currency === 'CNY' ? cny : usd, currency),
    [currency],
  )

  return (
    <div className="dub-root">
      <div className="dub-head">
        <span className="dub-title">用量看板</span>
        <span className="dub-sub">
          全部会话文件夹 · 按模型计价规则逐桶折算
          {data ? ` · 覆盖 ${data.scanned.folders} 个文件夹 / ${data.scanned.sessions} 个会话` : ''}
        </span>
      </div>

      <div className="dub-toolbar">
        <div className="dub-seg" role="group" aria-label="时间范围">
          {RANGE_KEYS.map((key) => (
            <button key={key} type="button" aria-pressed={range === key} onClick={() => setRange(key)}>
              {RANGE_LABELS[key]}
            </button>
          ))}
        </div>
        <div className="dub-seg" role="group" aria-label="币种">
          <button type="button" aria-pressed={currency === 'CNY'} onClick={() => setCurrency('CNY')}>¥ 人民币</button>
          <button type="button" aria-pressed={currency === 'USD'} onClick={() => setCurrency('USD')}>$ 美元</button>
        </div>
        <button type="button" className="dub-btn" disabled={loading} onClick={() => void fetchData(range, true)}>
          {loading ? '统计中…' : '↻ 刷新'}
        </button>
      </div>

      {error !== null ? <div className="dub-error">加载失败：{error}</div> : null}
      {data === null && error === null ? <div className="dub-loading">正在扫描会话日志并按计价规则折算…</div> : null}

      {data !== null ? (
        <BoardBody data={data} currency={currency} money={money} />
      ) : null}
    </div>
  )
}

function BoardBody(props: {
  data: SummaryResponse
  currency: Currency
  money: (cny: number, usd: number) => string
}): JSX.Element {
  const { data, currency, money } = props
  const totals = data.totals
  const isEmpty = totals.totalTokens === 0 && totals.requests === 0

  return (
    <>
      <div className="dub-cards">
        <div className="dub-card">
          <div className="dub-card-label">总花费（{RANGE_LABELS[data.range.key]}）</div>
          <div className="dub-card-value">{money(totals.costCny, totals.costUsd)}</div>
          <div className="dub-card-sub">≈ {currency === 'CNY' ? formatMoney(totals.costUsd, 'USD') : formatMoney(totals.costCny, 'CNY')}</div>
        </div>
        <div className="dub-card">
          <div className="dub-card-label">总 Tokens（计费口径）</div>
          <div className="dub-card-value">{formatTokens(totals.totalTokens)}</div>
          <div className="dub-card-sub">
            输入 {formatTokens(totals.inputTokens + totals.cacheWriteTokens)} · 缓存读 {formatTokens(totals.cacheReadTokens)} · 输出 {formatTokens(totals.outputTokens)}
          </div>
        </div>
        <div className="dub-card">
          <div className="dub-card-label">计费调用</div>
          <div className="dub-card-value">{totals.requests.toLocaleString()}</div>
          <div className="dub-card-sub">{totals.models} 个模型</div>
        </div>
        <div className="dub-card">
          <div className="dub-card-label">会话 / 文件夹</div>
          <div className="dub-card-value">{totals.sessions} / {totals.folders}</div>
          <div className="dub-card-sub">范围内有用量：{totals.sessions} 个会话</div>
        </div>
      </div>

      {isEmpty ? (
        <div className="dub-section">
          <div className="dub-empty">该时间范围内没有会话用量。换个时间范围，或点「刷新」重新扫描。</div>
        </div>
      ) : (
        <>
          <CostChart data={data} currency={currency} money={money} />

          <ModelTable data={data} money={money} />

          {data.folders.length > 0 ? <FolderTable data={data} money={money} /> : null}

          <QuotaAllSection />

          <div className="dub-section">
            <div className="dub-section-title">计价口径说明</div>
            <div className="dub-notes">
              <ul>
                {data.pricing.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
                {data.warnings.map((warning) => (
                  <li key={warning} className="dub-warn">{warning}</li>
                ))}
                <li>
                  数据来源：~/.dsh/sessions 下全部文件夹的会话日志（zstd jsonl），每个 LLM 步骤按 provider 上报的 usage 计一次；
                  索引时间 {new Date(data.generatedAt).toLocaleString()}，构建耗时 {data.tookMs} ms。
                </li>
              </ul>
            </div>
          </div>
        </>
      )}
    </>
  )
}

/* ───────────────────────── 折线图 ───────────────────────── */

function niceCeil(value: number): number {
  if (value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  const scaled = value / base
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
  return step * base
}

function CostChart(props: {
  data: SummaryResponse
  currency: Currency
  money: (cny: number, usd: number) => string
}): JSX.Element {
  const { data, currency, money } = props
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(680)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const element = wrapRef.current
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      if (next !== undefined && next > 320) setWidth(Math.floor(next))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const { keys, models } = data.series
  const visible = useMemo(
    () => models.filter((row) => !hidden.has(row.model)),
    [models, hidden],
  )
  const height = 280
  const padLeft = 68
  const padRight = 18
  const padTop = 16
  const padBottom = 38
  const plotW = Math.max(40, width - padLeft - padRight)
  const plotH = height - padTop - padBottom

  const pick = useCallback(
    (value: { cny: number; usd: number }) => (currency === 'CNY' ? value.cny : value.usd),
    [currency],
  )

  const yMax = useMemo(() => {
    let max = 0
    for (const row of visible) {
      for (const point of row.values) {
        const value = pick(point)
        if (value > max) max = value
      }
    }
    return niceCeil(max * 1.08)
  }, [visible, pick])

  const xOf = (index: number): number => padLeft + (keys.length <= 1 ? plotW / 2 : (plotW * index) / (keys.length - 1))
  const yOf = (value: number): number => padTop + plotH - (plotH * value) / yMax

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => yMax * t)
  const labelStep = Math.max(1, Math.ceil(keys.length / 7))

  const toggle = (model: string) => {
    setHidden((previous) => {
      const next = new Set(previous)
      if (next.has(model)) next.delete(model)
      else next.add(model)
      return next
    })
  }

  const onLeave = () => setHover(null)
  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * width
    if (keys.length === 0) return
    const ratio = (x - padLeft) / plotW
    const index = Math.round(ratio * (keys.length - 1))
    setHover(Math.max(0, Math.min(keys.length - 1, index)))
  }

  const hoverRows =
    hover === null
      ? []
      : visible
          .map((row) => ({ model: row.model, value: pick(row.values[hover]) }))
          .filter((row) => row.value > 0)
          .sort((a, b) => b.value - a.value)

  const tooltipLeft =
    hover === null || keys.length === 0
      ? 0
      : Math.min(Math.max(xOf(hover) - 90, 4), Math.max(4, width - 200))

  const money0 = (value: number) => formatMoney(value, currency)

  return (
    <div className="dub-section">
      <div className="dub-section-title">
        <span>各模型花费折线图</span>
        <span className="dub-section-note">
          {data.range.key === '1d' ? '按小时' : '按天'} · {currency === 'CNY' ? '人民币' : '美元'}
        </span>
      </div>

      <div className="dub-chart-wrap" ref={wrapRef} onMouseLeave={onLeave}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label="各模型花费折线图"
          onMouseMove={onMove}
        >
          {ticks.map((tick, i) => (
            <g key={i}>
              <line x1={padLeft} x2={width - padRight} y1={yOf(tick)} y2={yOf(tick)} stroke="var(--dsw-alias-border-l1,rgba(127,127,127,.18))" strokeWidth="1" />
              <text x={padLeft - 8} y={yOf(tick) + 3.5} textAnchor="end" fontSize="10.5" fill="var(--dub-fg3,inherit)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {tick === 0 ? '0' : money0(tick)}
              </text>
            </g>
          ))}

          {keys.map((key, index) =>
            index % labelStep === 0 || index === keys.length - 1 ? (
              <text key={key} x={xOf(index)} y={height - 14} textAnchor="middle" fontSize="10.5" fill="var(--dub-fg3,inherit)">
                {formatSeriesKey(key, data.series.unit)}
              </text>
            ) : null,
          )}

          {hover !== null ? (
            <line x1={xOf(hover)} x2={xOf(hover)} y1={padTop} y2={padTop + plotH} stroke="var(--dub-fg3,rgba(127,127,127,.5))" strokeWidth="1" strokeDasharray="3 3" />
          ) : null}

          {visible.map((row, seriesIndex) => {
            const color = SERIES_COLORS[models.findIndex((m) => m.model === row.model) % SERIES_COLORS.length]
            const points = row.values.map((point, index) => `${xOf(index)},${yOf(pick(point))}`).join(' ')
            return (
              <g key={row.model}>
                <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                {hover !== null ? (
                  <circle cx={xOf(hover)} cy={yOf(pick(row.values[hover]))} r="3.4" fill={color} stroke="var(--dub-bg,#fff)" strokeWidth="1.4" />
                ) : null}
              </g>
            )
          })}

        </svg>

        {hover !== null && hoverRows.length > 0 ? (
          <div className="dub-tooltip" style={{ left: tooltipLeft, top: 6 }}>
            <div className="dub-tooltip-title">{formatSeriesKey(keys[hover], data.series.unit)}</div>
            {hoverRows.map((row) => (
              <div key={row.model} className="dub-tooltip-row">
                <span>{row.model}</span>
                <span>{money0(row.value)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="dub-legend">
        {models.map((row, index) => {
          const color = SERIES_COLORS[index % SERIES_COLORS.length]
          const active = !hidden.has(row.model)
          const total = row.values.reduce((acc, point) => acc + pick(point), 0)
          return (
            <button
              key={row.model}
              type="button"
              className="dub-legend-item"
              aria-pressed={active}
              onClick={() => toggle(row.model)}
              title={active ? '点击隐藏' : '点击显示'}
            >
              <span className="dub-dot" style={{ background: color }} />
              <span>{row.model}</span>
              <span className="dub-muted">{money0(total)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ───────────────────────── 模型明细表 ───────────────────────── */

function ModelTable(props: {
  data: SummaryResponse
  money: (cny: number, usd: number) => string
}): JSX.Element {
  const { data, money } = props
  const [openModel, setOpenModel] = useState<string | null>(null)

  return (
    <div className="dub-section">
      <div className="dub-section-title">
        <span>按模型明细</span>
        <span className="dub-section-note">点击模型名展开实际命中的计价规则</span>
      </div>
      <table className="dub-table">
        <thead>
          <tr>
            <th>模型</th>
            <th>计费调用</th>
            <th>输入</th>
            <th>缓存读</th>
            <th>输出</th>
            <th>总 Tokens</th>
            <th>费用</th>
            <th>计价</th>
          </tr>
        </thead>
        <tbody>
          {data.models.map((row: ModelRow) => {
            const open = openModel === row.model
            return (
              <Fragment key={row.model}>
                <tr>
                  <td>
                    <span
                      className="dub-model-name"
                      data-open={open}
                      onClick={() => setOpenModel(open ? null : row.model)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') setOpenModel(open ? null : row.model)
                      }}
                    >
                      <span className="dub-caret" />
                      {row.model}
                    </span>
                  </td>
                  <td>{row.requests.toLocaleString()}</td>
                  <td>{formatTokens(row.inputTokens + row.cacheWriteTokens)}</td>
                  <td className="dub-muted">{formatTokens(row.cacheReadTokens)}</td>
                  <td>{formatTokens(row.outputTokens)}</td>
                  <td>{formatTokens(row.totalTokens)}</td>
                  <td>{money(row.costCny, row.costUsd)}</td>
                  <td>
                    {row.priced ? (
                      row.priceRules.some((rule) => rule.estimated) ? (
                        <span className="dub-badge dub-badge-warn">估算</span>
                      ) : (
                        <span className="dub-badge">官方刊例</span>
                      )
                    ) : (
                      <span className="dub-badge dub-badge-warn">未计价</span>
                    )}
                  </td>
                </tr>
                {open ? (
                  <tr className="dub-rules-row">
                    <td colSpan={8} className="dub-rules">
                      <div className="dub-rules-inner">
                        {row.priceRules.length === 0 ? (
                          <div className="dub-rule-source">无计价规则：token 已统计，费用按 0 计。可在 ~/.dsh/plugins/dsh-usage/config.json 的 models.{row.model} 补充官方单价。</div>
                        ) : (
                          row.priceRules.map((rule, index) => (
                            <div className="dub-rule" key={index}>
                              <div className="dub-rule-head">
                                <span className="dub-rule-name">{rule.label}</span>
                                {rule.estimated ? <span className="dub-badge dub-badge-warn">估算价</span> : null}
                                <span className="dub-rule-req">{rule.requests.toLocaleString()} 次调用命中</span>
                              </div>
                              <div className="dub-rule-prices">
                                输入 {rule.currency === 'CNY' ? '¥' : '$'}{rule.inputPerMillion}/M · 缓存读 {rule.currency === 'CNY' ? '¥' : '$'}{rule.cacheReadPerMillion}/M · 输出 {rule.currency === 'CNY' ? '¥' : '$'}{rule.outputPerMillion}/M
                                {rule.since !== null ? ` · 生效于 ${new Date(rule.since).toLocaleString()}` : ''}
                              </div>
                              <div className="dub-rule-source">{rule.source}</div>
                            </div>
                          ))
                        )}
                        {row.providers.length > 0 ? (
                          <div className="dub-rule-source">provider 路由：{row.providers.join('、')}</div>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ───────────────────────── 文件夹明细表 ───────────────────────── */

function FolderTable(props: {
  data: SummaryResponse
  money: (cny: number, usd: number) => string
}): JSX.Element {
  const { data, money } = props
  return (
    <div className="dub-section">
      <div className="dub-section-title">
        <span>按文件夹明细</span>
        <span className="dub-section-note">~/.dsh/sessions 下的工作目录文件夹</span>
      </div>
      <table className="dub-table">
        <thead>
          <tr>
            <th>文件夹</th>
            <th>会话</th>
            <th>计费调用</th>
            <th>总 Tokens</th>
            <th>费用</th>
          </tr>
        </thead>
        <tbody>
          {data.folders.map((row) => (
            <tr key={row.folder}>
              <td>
                {row.folder}
                {row.cwd !== null ? <span className="dub-folder-cwd" title={row.cwd}>{row.cwd}</span> : null}
              </td>
              <td>{row.sessions.toLocaleString()}</td>
              <td>{row.requests.toLocaleString()}</td>
              <td>{formatTokens(row.totalTokens)}</td>
              <td>{money(row.costCny, row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ───────────────────────── 订阅额度区块（quota/all） ───────────────────────── */

interface QuotaAllState {
  data: QuotaAllResponse | null
  loading: boolean
  error: string | null
}

/**
 * 「订阅额度」板块：列出当前 DSH 中配置的、被识别为 Coding Plan 的全部
 * provider 的额度窗口进度条（GLM / Kimi，随适配器扩展）。数据与对话头部
 * 右徽标同源（host 90s 缓存，手动刷新强制回源）。
 */
function QuotaAllSection(): JSX.Element {
  const [state, setState] = useState<QuotaAllState>({ data: null, loading: true, error: null })

  const fetchAll = useCallback(async (refresh: boolean) => {
    setState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      const response = await fetch(`${API_BASE}/quota/all${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as QuotaAllResponse
      if (payload.ok !== true || !Array.isArray(payload.providers)) throw new Error('接口返回异常')
      setState({ data: payload, loading: false, error: null })
    } catch (cause) {
      setState({ data: null, loading: false, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [])

  useEffect(() => {
    void fetchAll(false)
  }, [fetchAll])

  const entries = state.data?.providers ?? []

  return (
    <div className="dub-section">
      <div className="dub-section-title">
        <span>订阅额度</span>
        <span className="dub-section-note">
          当前 DSH 配置的 Coding Plan 额度（{entries.length} 个
          {state.data !== null && state.data.skipped > 0 ? `，另 ${state.data.skipped} 个非订阅 provider 未列出` : ''}）
          <button type="button" className="dub-btn" style={{ marginLeft: 10 }} disabled={state.loading} onClick={() => void fetchAll(true)}>
            {state.loading ? '刷新中…' : '↻ 刷新'}
          </button>
        </span>
      </div>

      {state.error !== null ? <div className="dub-error">额度加载失败：{state.error}</div> : null}
      {state.data === null && state.error === null ? <div className="dub-loading">正在查询各家订阅端点…</div> : null}

      {state.data !== null && entries.length === 0 ? (
        <div className="dub-empty">
          未识别到 Coding Plan provider。使用 GLM / Kimi Coding Plan 时，在
          ~/.dsh/plugins/dsh-usage/config.json 的 providers 中加一行映射即可（如
          {`"my-glm": { "adapter": "zai" }`}）。
        </div>
      ) : null}

      {entries.map((entry) => {
        const snapshot = entry.response.snapshot
        return (
          <div key={entry.provider} className="dub-quota-card">
            <div className="dub-quota-head">
              <span className="dub-quota-name">
                {snapshot?.adapterLabel ?? entry.provider}
                {snapshot?.planLabel !== undefined ? <span className="dub-badge" style={{ marginLeft: 8 }}>{snapshot.planLabel}</span> : null}
              </span>
              <span className="dub-muted">
                {entry.displayName !== undefined && entry.displayName !== entry.provider ? `${entry.displayName} · ` : ''}
                {entry.provider}
              </span>
            </div>
            {entry.response.ok && snapshot !== undefined ? (
              <>
                {snapshot.windows.map((window) => (
                  <QuotaWindowRow key={window.id} window={window} now={Date.now()} />
                ))}
                {snapshot.notes !== undefined && snapshot.notes.length > 0 ? (
                  <ul className="dqv-notes">
                    {snapshot.notes.map((note) => (
                      <li key={note}>· {note}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="dub-quota-foot">更新于 {new Date(snapshot.fetchedAt).toLocaleTimeString()}</div>
              </>
            ) : (
              <div className="dub-quota-err">{entry.response.message ?? '额度查询失败'}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
