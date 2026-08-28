/**
 * @dsh-external/dsh-usage — 统一计价内核（core，纯函数，host 与 client 共用）。
 *
 * 费用不是「所有 token 一口价」，而是把每一条 usage 记录归到
 * 「模型 × 时代 × 峰谷」的具体单价上逐条计费：
 *
 * - DeepSeek V4 系列（官方公告，2026-08-17 0 点北京时间起分时计价）：
 *     高峰时段 = 北京时间每日 9:00-12:00、14:00-18:00
 * - Kimi K3（Moonshot 官方刊例，美元，不分时）：
 *     Coding Plan 渠道（kimi-code / kimi-coding）在日志里记裸名 "k3"，
 *     官方 API 渠道记 "kimi-k3"，均通过别名/前缀命中同一条规则。
 * - GLM-5.3（官方 API 刊例未公布）：按同基座 GLM-5.2 的 bigmodel.cn 刊例价
 *     估算，UI 标注「估算」，可在 config.json 用官方价覆盖。
 *
 * 缓存写入 tokens 没有独立刊例价（DeepSeek/智谱均按未缓存输入计费），按输入单价计费。
 * USD ⇄ CNY 按可配置汇率（默认 7.2）折算，不联网请求实时汇率。
 *
 * 本文件是 dsh-token-cost/src/shared.ts 与 dsh-usage-board/src/pricing.ts
 * 两份同源计价代码的合并超集：用户覆盖 + 目录视图（前者）∪ 会话级聚合与
 * 展示格式化（后者）。
 */

/* ───────────────────────── 统一配置（v2） ───────────────────────── */

export const PLUGIN_ID = '@dsh-external/dsh-usage'

/** host 挂在 DSH webserver 上的同源 API 前缀。 */
export const API_BASE = '/api/dsh-usage'

/** config.json 中用户对某模型的覆盖规则。 */
export interface ModelOverride {
  currency: Currency
  inputPerMillion: number
  cacheReadPerMillion: number
  outputPerMillion: number
  label?: string
  source?: string
  estimated?: boolean
}

/** config.json 中用户对某 provider 的显式适配器映射（quota 模块）。 */
export interface ProviderMapping {
  adapter: string
  baseURL?: string
}

/**
 * 统一配置（~/.dsh/plugins/dsh-usage/config.json，version 2）。
 * 计价（models/rateUsdCny）与额度（providers/refreshMs）共用一个文件。
 */
export interface UsageConfig {
  version: 2
  rateUsdCny: number
  models: Record<string, ModelOverride>
  providers: Record<string, ProviderMapping>
  /** 额度轮询间隔（ms），默认 60_000。 */
  refreshMs?: number
}

export const DEFAULT_RATE_USD_CNY = 7.2
/** 兼容别名（前 dsh-token-cost 的命名）。 */
export const DEFAULT_EXCHANGE_RATE = DEFAULT_RATE_USD_CNY

export const DEFAULT_CONFIG: UsageConfig = { version: 2, rateUsdCny: DEFAULT_RATE_USD_CNY, models: {}, providers: {} }

/* ───────────────────────── 计价目录 ───────────────────────── */

export type Currency = 'CNY' | 'USD'

/** 一条可命中的单价条目（元或美元 / 百万 tokens）。 */
export interface PriceEntry {
  currency: Currency
  inputPerMillion: number
  cacheReadPerMillion: number
  outputPerMillion: number
  source: string
  estimated: boolean
  /** 生效起点（epoch ms）；null = 有史以来。 */
  sinceMs: number | null
  /** null = 不分时；true = 高峰单价；false = 空闲单价。 */
  peak: boolean | null
}

/** 一个模型的完整计价规则。 */
export interface ModelRule {
  key: string
  label: string
  /**
   * 日志中出现的其他模型名（小写），同样命中本规则。
   * 与 key 一样支持「精确」与「别名-前缀」两种匹配。
   */
  aliases?: string[]
  /** 非空 = 分时模型（按北京时区小时命中 peak/非 peak 条目）。 */
  peakHours: [number, number][] | null
  /** 按 sinceMs 升序；解析时取「sinceMs ≤ ts 的最后一条」，再按峰谷二选一。 */
  eras: PriceEntry[]
  note: string | null
}

/** DeepSeek 分时计价生效时刻（北京时间 2026-08-17 00:00 = UTC 2026-08-16 16:00）。 */
export const DEEPSEEK_TIME_OF_USE_SINCE_MS = Date.parse('2026-08-17T00:00:00+08:00')

/** DeepSeek 官方高峰时段（北京时区小时，[起,止)）。 */
export const DEEPSEEK_PEAK_HOURS: [number, number][] = [
  [9, 12],
  [14, 18],
]

function deepseekEras(
  cheap: Omit<PriceEntry, 'sinceMs' | 'peak'>,
  offPeak: Omit<PriceEntry, 'sinceMs' | 'peak'>,
  peak: Omit<PriceEntry, 'sinceMs' | 'peak'>,
): PriceEntry[] {
  return [
    { ...cheap, sinceMs: null, peak: null },
    { ...offPeak, sinceMs: DEEPSEEK_TIME_OF_USE_SINCE_MS, peak: false },
    { ...peak, sinceMs: DEEPSEEK_TIME_OF_USE_SINCE_MS, peak: true },
  ]
}

/** 内置计价目录（截至 2026-08 官方公开刊例；取两个前身插件目录的并集）。 */
export const MODEL_RULES: ModelRule[] = [
  {
    key: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    peakHours: DEEPSEEK_PEAK_HOURS,
    eras: deepseekEras(
      { currency: 'CNY', inputPerMillion: 1.0, cacheReadPerMillion: 0.02, outputPerMillion: 2.0, source: 'DeepSeek 官方（2026-08-17 涨价前统一价）', estimated: false },
      { currency: 'CNY', inputPerMillion: 1.5, cacheReadPerMillion: 0.05, outputPerMillion: 4.5, source: 'DeepSeek 官方（2026-08-17 起空闲时段）', estimated: false },
      { currency: 'CNY', inputPerMillion: 3.0, cacheReadPerMillion: 0.1, outputPerMillion: 9.0, source: 'DeepSeek 官方（2026-08-17 起高峰时段）', estimated: false },
    ),
    note: '高峰 = 北京时间 9-12 点、14-18 点；涨价前为不分时统一价',
  },
  {
    key: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    peakHours: DEEPSEEK_PEAK_HOURS,
    eras: deepseekEras(
      { currency: 'CNY', inputPerMillion: 3.0, cacheReadPerMillion: 0.025, outputPerMillion: 6.0, source: 'DeepSeek 官方（2026-08-17 涨价前统一价）', estimated: false },
      { currency: 'CNY', inputPerMillion: 4.5, cacheReadPerMillion: 0.15, outputPerMillion: 13.5, source: 'DeepSeek 官方（2026-08-17 起空闲时段）', estimated: false },
      { currency: 'CNY', inputPerMillion: 9.0, cacheReadPerMillion: 0.3, outputPerMillion: 27.0, source: 'DeepSeek 官方（2026-08-17 起高峰时段）', estimated: false },
    ),
    note: '高峰 = 北京时间 9-12 点、14-18 点；涨价前为不分时统一价',
  },
  {
    key: 'kimi-k3',
    label: 'Kimi K3',
    aliases: ['k3', 'k3-256k', 'kimi-k3', 'moonshot-k3'],
    peakHours: null,
    eras: [
      {
        currency: 'USD', inputPerMillion: 3.0, cacheReadPerMillion: 0.3, outputPerMillion: 15.0, sinceMs: null, peak: null,
        source: 'Moonshot AI 官方刊例（$3 / $0.30 缓存 / $15 每百万 tokens）',
        estimated: false,
      },
    ],
    note: '按官方美元刊例计费，人民币金额按汇率折算',
  },
  {
    key: 'glm-5.3',
    label: 'GLM-5.3',
    peakHours: null,
    eras: [
      {
        currency: 'CNY', inputPerMillion: 8, cacheReadPerMillion: 2, outputPerMillion: 28, sinceMs: null, peak: null,
        source: '按同基座 GLM-5.2 的 bigmodel.cn 刊例价估算（GLM-5.3 官方 API 刊例未公布）',
        estimated: true,
      },
    ],
    note: '估算价：GLM-5.3 与 GLM-5.2 同为 743B 基座；官方公布后可在 config.json 覆盖',
  },
  {
    key: 'glm-5.2',
    label: 'GLM-5.2',
    peakHours: null,
    eras: [
      {
        currency: 'CNY', inputPerMillion: 8, cacheReadPerMillion: 2, outputPerMillion: 28, sinceMs: null, peak: null,
        source: 'bigmodel.cn 官方刊例（GLM-5.2）',
        estimated: false,
      },
    ],
    note: null,
  },
]

/** 走 Coding Plan 订阅（费用为刊例价折算，仅供参考）的 provider 特征。 */
export const CODING_PLAN_PROVIDER_HINTS: { match: (provider: string) => boolean; label: string }[] = [
  { match: (p) => p === 'zai-coding-cn' || p.includes('zai-coding') || p === 'zai', label: 'GLM Coding Plan' },
  { match: (p) => p === 'moonshotai-cn' || p.includes('kimi-coding') || p.includes('moonshot-coding'), label: 'Kimi Coding Plan' },
]

/* ───────────────────────── 北京时区工具 ───────────────────────── */

const beijingHour = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
})

const beijingPartsCache = new Map<number, { year: string; month: string; day: string; hour: string }>()

/** 把 epoch ms 对齐到整点后格式化为北京时区字段（按小时缓存）。 */
export function beijingParts(tsMs: number): { year: string; month: string; day: string; hour: string } {
  const hourBucket = Math.floor(tsMs / 3_600_000)
  const cached = beijingPartsCache.get(hourBucket)
  if (cached !== undefined) return cached
  const parts = { year: '', month: '', day: '', hour: '' }
  for (const part of beijingHour.formatToParts(new Date(hourBucket * 3_600_000))) {
    if (part.type === 'year') parts.year = part.value
    else if (part.type === 'month') parts.month = part.value
    else if (part.type === 'day') parts.day = part.value
    else if (part.type === 'hour') parts.hour = part.value
  }
  if (beijingPartsCache.size > 100_000) beijingPartsCache.clear()
  beijingPartsCache.set(hourBucket, parts)
  return parts
}

/** 北京时区小时 key："2026-08-18T14"。 */
export function hourKeyOf(tsMs: number): string {
  const p = beijingParts(tsMs)
  return `${p.year}-${p.month}-${p.day}T${p.hour}`
}

/** 北京时区天 key："2026-08-18"。 */
export function dayKeyOf(tsMs: number): string {
  const p = beijingParts(tsMs)
  return `${p.year}-${p.month}-${p.day}`
}

/** 北京时区的小时数（0-23）。 */
export function beijingHourOf(tsMs: number): number {
  return Number(beijingParts(tsMs).hour)
}

/** 官方高峰时段：每日 9:00-12:00、14:00-18:00（Asia/Shanghai）。 */
export function isPeakHour(date = new Date()): boolean {
  const hour = beijingHourOf(date.getTime())
  return DEEPSEEK_PEAK_HOURS.some(([from, to]) => hour >= from && hour < to)
}

/* ───────────────────────── 规则解析 ───────────────────────── */

export function normalizeModelId(model: string | undefined | null): string {
  return (model ?? '').trim().toLowerCase()
}

/** 精确匹配（key 或别名）→ key/别名 前缀匹配（如 deepseek-v4-pro-0813 → deepseek-v4-pro、k3-0905 → kimi-k3）。 */
export function matchRuleKey(model: string | undefined | null): string | null {
  const normalized = normalizeModelId(model)
  if (normalized === '') return null
  for (const rule of MODEL_RULES) {
    if (normalized === rule.key || rule.aliases?.includes(normalized)) return rule.key
  }
  for (const rule of MODEL_RULES) {
    const names = [rule.key, ...(rule.aliases ?? [])]
    if (names.some((name) => normalized.startsWith(`${name}-`))) return rule.key
  }
  return null
}

export interface ResolvedPrice {
  /** 命中的规则 key（内置目录或用户覆盖的模型 id）。 */
  ruleKey: string
  label: string
  entry: PriceEntry
  /** 用户覆盖标记。 */
  overridden: boolean
}

/** 解析「模型 × 时刻」的单价；未知模型返回 null（tokens 照计、费用不计）。 */
export function resolvePrice(
  model: string | undefined | null,
  tsMs: number = Date.now(),
  config: UsageConfig = DEFAULT_CONFIG,
): ResolvedPrice | null {
  const normalized = normalizeModelId(model)
  if (normalized === '') return null

  const override = config.models[normalized]
  if (override !== undefined) {
    return {
      ruleKey: normalized,
      label: override.label ?? normalized,
      overridden: true,
      entry: {
        currency: override.currency,
        inputPerMillion: override.inputPerMillion,
        cacheReadPerMillion: override.cacheReadPerMillion,
        outputPerMillion: override.outputPerMillion,
        source: override.source ?? '用户覆盖（config.json）',
        estimated: override.estimated ?? false,
        sinceMs: null,
        peak: null,
      },
    }
  }

  const ruleKey = matchRuleKey(normalized)
  if (ruleKey === null) return null
  const rule = MODEL_RULES.find((r) => r.key === ruleKey)
  if (rule === undefined) return null

  // 时代：取 sinceMs ≤ ts 的最后一条（数组按 sinceMs 升序）。
  let era: PriceEntry | null = null
  for (const candidate of rule.eras) {
    if (candidate.sinceMs === null || tsMs >= candidate.sinceMs) era = candidate
  }
  if (era === null) return null

  // 峰谷：仅当命中时代属于分时计价（同一 sinceMs 同时挂着 peak=true/false 两条）。
  let entry = era
  const hasTimeOfUse = rule.eras.some((e) => e.sinceMs === era?.sinceMs && e.peak === true)
  if (hasTimeOfUse && rule.peakHours !== null) {
    const hour = beijingHourOf(tsMs)
    const peak = rule.peakHours.some(([from, to]) => hour >= from && hour < to)
    const matched = rule.eras.find((e) => e.sinceMs === era?.sinceMs && e.peak === peak)
    if (matched !== undefined) entry = matched
  }

  return { ruleKey: rule.key, label: rule.label, overridden: false, entry }
}

/** 一桶用量（input/cacheRead/cacheWrite/output，单位 tokens）按单价折算成双边金额。 */
export function costOf(
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number },
  price: ResolvedPrice,
  rateUsdCny: number = DEFAULT_RATE_USD_CNY,
): { cny: number; usd: number } {
  const native =
    ((usage.input + usage.cacheWrite) * price.entry.inputPerMillion +
      usage.cacheRead * price.entry.cacheReadPerMillion +
      usage.output * price.entry.outputPerMillion) /
    1_000_000
  return price.entry.currency === 'CNY'
    ? { cny: native, usd: native / rateUsdCny }
    : { cny: native * rateUsdCny, usd: native }
}

/* ───────────────────────── 目录视图（/pricing API 用） ───────────────────────── */

export interface PricingCatalogEraView {
  since: string | null
  peak: boolean | null
  currency: Currency
  inputPerMillion: number
  cacheReadPerMillion: number
  outputPerMillion: number
  source: string
  estimated: boolean
}

export interface PricingCatalogEntry {
  model: string
  label: string
  /** 分时模型的高峰时段（北京时区小时区间，[起,止)）。 */
  peakHours: [number, number][] | null
  eras: PricingCatalogEraView[]
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

/** 给 API 用的目录视图（含用户覆盖标记）。 */
export function pricingCatalog(config: UsageConfig): PricingCatalogEntry[] {
  const overriddenKeys = new Set(Object.keys(config.models))
  const entries: PricingCatalogEntry[] = MODEL_RULES.map((rule) => ({
    model: rule.key,
    label: rule.label,
    peakHours: rule.peakHours,
    note: rule.note,
    overridden: overriddenKeys.has(rule.key),
    eras: rule.eras.map((e) => ({
      since: e.sinceMs === null ? null : new Date(e.sinceMs).toISOString(),
      peak: e.peak,
      currency: e.currency,
      inputPerMillion: e.inputPerMillion,
      cacheReadPerMillion: e.cacheReadPerMillion,
      outputPerMillion: e.outputPerMillion,
      source: e.source,
      estimated: e.estimated,
    })),
  }))
  for (const [model, o] of Object.entries(config.models)) {
    if (MODEL_RULES.some((r) => r.key === model)) continue
    entries.push({
      model,
      label: o.label ?? model,
      peakHours: null,
      note: null,
      overridden: true,
      eras: [{
        since: null, peak: null, currency: o.currency,
        inputPerMillion: o.inputPerMillion,
        cacheReadPerMillion: o.cacheReadPerMillion,
        outputPerMillion: o.outputPerMillion,
        source: o.source ?? '用户覆盖（config.json）',
        estimated: o.estimated ?? false,
      }],
    })
  }
  return entries
}

export function emptyPricingResponse(config: UsageConfig): PricingResponse {
  return { ok: true, rateUsdCny: config.rateUsdCny, catalog: pricingCatalog(config), codingPlanProviders: CODING_PLAN_PROVIDER_HINTS.map((h) => h.label) }
}

/* ───────────────────────── 会话级聚合计价（实时徽标用） ───────────────────────── */

import type { ModelUsageEntry } from './session-log.js'

/** token-meter 的持久累计用量投影（host 的 dsh-token-meter 提供）。 */
export interface TokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** token-meter 的启发式上下文组成投影。 */
export interface ContextBreakdown {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/** 一桶用量（input / cacheRead / cacheWrite / output，单位 tokens）。 */
export interface UsageBuckets {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export function emptyBuckets(): UsageBuckets {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

export function bucketsTotal(buckets: UsageBuckets | undefined): number {
  if (!buckets) return 0
  return buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output
}

export function totalTokens(usage: TokenUsage | undefined): number {
  if (!usage) return 0
  return usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** GET /api/dsh-usage/session 的响应体。 */
export interface SessionUsageResponse {
  ok: true
  sessionId: string
  found: boolean
  /** 归集时刻（epoch ms）。 */
  indexedAt: number
  models: ModelUsageEntry[]
}

/** 一个模型的折算结果行（未命中目录时 label 为 null、费用为 0）。 */
export interface ModelCostLine {
  model: string
  provider: string | null
  label: string | null
  estimated: boolean
  usage: UsageBuckets
  requests: number
  costCny: number
  costUsd: number
}

export interface SessionCostSummary {
  lines: ModelCostLine[]
  totalCny: number
  totalUsd: number
  /** 全部模型合计 tokens（含未命中目录的）。 */
  totalTokens: number
  /** 未命中计价目录的 tokens（已计入 totalTokens、未计入费用）。 */
  unmatchedTokens: number
  hasEstimated: boolean
}

/** 把 host 归集的逐模型小时桶按「模型 × 时代 × 峰谷」逐桶折算并汇总。 */
export function priceSessionUsage(
  models: readonly ModelUsageEntry[],
  exchangeRate = DEFAULT_RATE_USD_CNY,
): SessionCostSummary {
  const lines: ModelCostLine[] = []
  let totalCny = 0
  let totalUsd = 0
  let allTokens = 0
  let unmatchedTokens = 0
  let hasEstimated = false

  for (const entry of models) {
    const usage = emptyBuckets()
    let requests = 0
    let costCny = 0
    let costUsd = 0
    let label: string | null = null
    let estimated = false
    for (const bucket of entry.hours) {
      requests += bucket.requests
      usage.input += bucket.input
      usage.cacheRead += bucket.cacheRead
      usage.cacheWrite += bucket.cacheWrite
      usage.output += bucket.output
      const price = resolvePrice(entry.model, bucket.ts)
      if (price === null) continue
      label = price.label
      if (price.entry.estimated) estimated = true
      const cost = costOf(bucket, price, exchangeRate)
      costCny += cost.cny
      costUsd += cost.usd
    }
    allTokens += bucketsTotal(usage)
    if (label === null) unmatchedTokens += bucketsTotal(usage)
    else hasEstimated = hasEstimated || estimated
    totalCny += costCny
    totalUsd += costUsd
    lines.push({ model: entry.model, provider: entry.provider, label, estimated, usage, requests, costCny, costUsd })
  }

  lines.sort((a, b) => b.costCny - a.costCny || bucketsTotal(b.usage) - bucketsTotal(a.usage))
  return { lines, totalCny, totalUsd, totalTokens: allTokens, unmatchedTokens, hasEstimated }
}

/**
 * 按当前/指定时段单价估算整段会话费用（元）。仅在拿不到逐请求归集数据时
 * （host API 不可达的降级路径）使用：把累计用量按单一模型整段折算。
 */
export function estimateCostCny(usage: TokenUsage | undefined, price: ResolvedPrice): number {
  if (!usage) return 0
  return costOf(
    {
      input: usage.uncachedInputTokens,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
      output: usage.outputTokens,
    },
    price,
  ).cny
}

/* ───────────────────────── 展示格式化 ───────────────────────── */

export function formatMoney(cny: number, exchangeRate = DEFAULT_RATE_USD_CNY): string {
  const usd = cny / exchangeRate
  const digits = cny === 0 ? 2 : cny < 0.01 ? 4 : cny < 1 ? 3 : 2
  return `¥${cny.toFixed(digits)} / $${usd.toFixed(digits)}`
}

export function formatPriceLine(price: ResolvedPrice, exchangeRate = DEFAULT_RATE_USD_CNY): string {
  const entry = price.entry
  const toCny = (v: number) => (entry.currency === 'CNY' ? v : v * exchangeRate)
  const fmt = (v: number) => toCny(v).toFixed(toCny(v) < 1 ? 2 : 1)
  const native = (v: number) => `${entry.currency === 'CNY' ? '¥' : '$'}${v.toFixed(v < 1 ? 2 : 1)}`
  return `未缓存输入 ${native(entry.inputPerMillion)} ≈¥${fmt(entry.inputPerMillion)}/M · 缓存读取 ≈¥${fmt(entry.cacheReadPerMillion)}/M · 输出 ≈¥${fmt(entry.outputPerMillion)}/M`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}
