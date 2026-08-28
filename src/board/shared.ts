/**
 * @dsh-external/dsh-usage — host / client 共享的纯类型与展示格式化。
 *
 * 本文件不包含任何计价逻辑（计价在 host 侧 src/core/pricing.ts 完成），
 * client 只消费 host 序列化好的 SummaryResponse。
 */

export const PLUGIN_ID = '@dsh-external/dsh-usage'

/** 查询时间范围：近 1 天 / 近 7 天 / 近 30 天 / 全部。 */
export type RangeKey = '1d' | '7d' | '30d' | 'all'

export const RANGE_KEYS: readonly RangeKey[] = ['1d', '7d', '30d', 'all'] as const

export const RANGE_LABELS: Record<RangeKey, string> = {
  '1d': '近 1 天',
  '7d': '近 7 天',
  '30d': '近 30 天',
  all: '全部',
}

/** 计价条目：某模型在某一时段/时代的官方单价（每百万 tokens）。 */
export interface PriceRuleView {
  /** 展示名（含时代/峰谷说明）。 */
  label: string
  currency: 'CNY' | 'USD'
  inputPerMillion: number
  cacheReadPerMillion: number
  outputPerMillion: number
  /** 价格来源说明（官方公告 / 同基座估算 / 用户覆盖）。 */
  source: string
  /** 估算价（官方未公布，按同基座或用户口径）。 */
  estimated: boolean
  /** 该条目生效的起始时间（ISO，北京时区）；null = 有史以来。 */
  since: string | null
  /** 是否高峰时段单价（null = 不分时）。 */
  peak: boolean | null
  /** 命中该条目的计费调用次数。 */
  requests: number
}

export interface UsageTotalsView {
  /** 未缓存输入 tokens。 */
  inputTokens: number
  /** 缓存读取 tokens。 */
  cacheReadTokens: number
  /** 缓存写入 tokens（按未缓存输入价计费）。 */
  cacheWriteTokens: number
  /** 输出 tokens。 */
  outputTokens: number
  /** 计费口径总 tokens = 输入 + 缓存读 + 缓存写 + 输出。 */
  totalTokens: number
  /** 计费调用次数（每个产生 usage 的 LLM 请求步骤计 1）。 */
  requests: number
}

export interface ModelRow extends UsageTotalsView {
  /** 日志中的模型 id（原样）。 */
  model: string
  /** 出现过的 provider 路由。 */
  providers: string[]
  costCny: number
  costUsd: number
  /** 是否有内置或覆盖的计价规则。 */
  priced: boolean
  /** 实际命中的计价规则（可能跨时代/峰谷多条）。 */
  priceRules: PriceRuleView[]
}

export interface FolderRow {
  /** ~/.dsh/sessions 下的文件夹名（按工作目录编码）。 */
  folder: string
  /** 会话日志中记录的工作目录（尽量还原为真实路径）。 */
  cwd: string | null
  sessions: number
  requests: number
  totalTokens: number
  costCny: number
  costUsd: number
  /** 涉及模型数。 */
  models: number
}

export interface SeriesPoint {
  cny: number
  usd: number
}

export interface SeriesModelRow {
  model: string
  /** 与 series.keys 一一对应。 */
  values: SeriesPoint[]
}

export interface SummaryResponse {
  ok: true
  version: 1
  generatedAt: number
  /** 服务端构建本次汇总耗时（ms）。 */
  tookMs: number
  /** 扫描概况。 */
  scanned: {
    sessions: number
    folders: number
    /** 本次请求触发重扫（而非缓存命中）的会话数。 */
    reindexed: number
    /** 索引缓存最后写入时间。 */
    indexedAt: number
  }
  range: {
    key: RangeKey
    /** 滚动窗口起点；all = null。 */
    fromMs: number | null
    toMs: number
    granularity: 'hour' | 'day'
  }
  pricing: {
    rateUsdCny: number
    notes: string[]
  }
  totals: {
    costCny: number
    costUsd: number
    sessions: number
    folders: number
    models: number
  } & UsageTotalsView
  models: ModelRow[]
  folders: FolderRow[]
  series: {
    unit: 'hour' | 'day'
    /** 北京时区的桶 key：小时 "2026-08-18T14" / 天 "2026-08-18"。 */
    keys: string[]
    models: SeriesModelRow[]
  }
  /** 无计价规则 / 估算价等提示。 */
  warnings: string[]
}

export interface PricingCatalogEntry {
  model: string
  label: string
  /** 分时模型的高峰时段（北京时区小时区间，[起,止)）。 */
  peakHours: [number, number][] | null
  eras: {
    since: string | null
    peak: boolean | null
    currency: 'CNY' | 'USD'
    inputPerMillion: number
    cacheReadPerMillion: number
    outputPerMillion: number
    source: string
    estimated: boolean
  }[]
  note: string | null
  /** 是否被用户 config 覆盖。 */
  overridden: boolean
}

export interface PricingResponse {
  ok: true
  rateUsdCny: number
  catalog: PricingCatalogEntry[]
  codingPlanProviders: string[]
}

/* ───────────────────────── 展示格式化（client 用） ───────────────────────── */

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '-'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

export function formatMoney(value: number, currency: 'CNY' | 'USD'): string {
  if (!Number.isFinite(value)) return '-'
  const digits = value === 0 ? 2 : Math.abs(value) < 0.01 ? 4 : Math.abs(value) < 1 ? 3 : 2
  return currency === 'CNY' ? `¥${value.toFixed(digits)}` : `$${value.toFixed(digits)}`
}

export function formatSeriesKey(key: string, unit: 'hour' | 'day'): string {
  if (unit === 'hour') {
    // "2026-08-18T14" → "08-18 14时"
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(key)
    if (m) return `${m[2]}-${m[3]} ${m[4]}时`
    return key
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (m) return `${m[2]}-${m[3]}`
  return key
}
