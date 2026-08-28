/**
 * @dsh-external/dsh-usage — 看板汇总构建（board 模块，host 侧，纯函数）。
 *
 * 输入：索引缓存（小时桶）+ 计价配置 + 时间范围；输出 SummaryResponse。
 * 费用逐「小时 × 模型」桶解析单价（时代 × 峰谷），再累加，保证每条 token
 * 都落在它自己的计价规则上，而不是把所有 token 塞进同一口价。
 */
import {
  CODING_PLAN_PROVIDER_HINTS,
  DEFAULT_RATE_USD_CNY,
  beijingParts,
  costOf,
  resolvePrice,
  type UsageConfig,
} from '../core/pricing.js'
import type { IndexCacheFile, SessionCacheEntry } from './indexer.js'
import type {
  FolderRow,
  ModelRow,
  PriceRuleView,
  RangeKey,
  SeriesModelRow,
  SeriesPoint,
  SummaryResponse,
} from './shared.js'

/** PriceRuleView 的聚合 key（label+单价完全一致视为同一条）。 */
function ruleViewKey(view: Omit<PriceRuleView, 'requests'>): string {
  return [
    view.label, view.currency, view.inputPerMillion, view.cacheReadPerMillion, view.outputPerMillion,
    view.source, view.estimated, view.since, view.peak,
  ].join('|')
}

const RANGE_MS: Record<Exclude<RangeKey, 'all'>, number> = {
  '1d': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
  '30d': 30 * 24 * 3_600_000,
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** 北京时区 key → 该桶起点 epoch ms（"2026-08-18T14" / "2026-08-18"）。 */
export function keyToStartMs(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?$/.exec(key)
  if (m === null) return 0
  const [, y, mo, d, h] = m
  // 北京时间 = UTC+8，无夏令时。
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), 0, 0) - 8 * HOUR_MS
}

function dayKeyToHourKeys(dayKey: string): string[] {
  const keys: string[] = []
  for (let hour = 0; hour < 24; hour += 1) keys.push(`${dayKey}T${String(hour).padStart(2, '0')}`)
  return keys
}

function hourKey(tsMs: number): string {
  const p = beijingParts(tsMs)
  return `${p.year}-${p.month}-${p.day}T${p.hour}`
}

/** 北京时区滚动窗口内的连续小时 key（当前小时为末桶）。 */
function hourKeysBetween(fromMs: number, toMs: number): string[] {
  const keys: string[] = []
  for (let ts = Math.floor(fromMs / HOUR_MS) * HOUR_MS; ts <= toMs; ts += HOUR_MS) keys.push(hourKey(ts))
  return keys
}

function dayKeysBetween(fromMs: number, toMs: number): string[] {
  const keys: string[] = []
  for (let ts = keyToStartMs(`${hourKey(fromMs).slice(0, 10)}T00`); ts <= toMs; ts += DAY_MS) {
    const p = beijingParts(ts)
    keys.push(`${p.year}-${p.month}-${p.day}`)
  }
  return keys
}

interface Accumulator {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
  costCny: number
  costUsd: number
}

function emptyAcc(): Accumulator {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, costCny: 0, costUsd: 0 }
}

function addTokens(acc: Accumulator, counts: { i: number; c: number; w: number; o: number; n: number }): void {
  acc.inputTokens += counts.i
  acc.cacheReadTokens += counts.c
  acc.cacheWriteTokens += counts.w
  acc.outputTokens += counts.o
  acc.requests += counts.n
  acc.totalTokens += counts.i + counts.c + counts.w + counts.o
}

export interface BuildSummaryOptions {
  range: RangeKey
  nowMs?: number
  config?: UsageConfig
}

export function buildSummary(cache: IndexCacheFile, options: BuildSummaryOptions): SummaryResponse {
  const startedAt = Date.now()
  const nowMs = options.nowMs ?? startedAt
  const config = options.config ?? { version: 2, rateUsdCny: DEFAULT_RATE_USD_CNY, models: {}, providers: {} }
  const rate = config.rateUsdCny > 0 ? config.rateUsdCny : DEFAULT_RATE_USD_CNY
  const range = options.range
  const fromMs = range === 'all' ? null : nowMs - RANGE_MS[range]
  const granularity: 'hour' | 'day' = range === '1d' ? 'hour' : 'day'

  interface ModelAgg extends Accumulator {
    providers: Set<string>
    rules: Map<string, PriceRuleView>
  }

  interface FolderAgg extends Accumulator {
    folder: string
    cwds: Map<string, number>
    sessions: Set<string>
    models: Set<string>
  }

  const modelAgg = new Map<string, ModelAgg>()
  const folderAgg = new Map<string, FolderAgg>()
  /** hourKey → model → 已计费用（仅含可计价桶）。 */
  const bucketCost = new Map<string, Map<string, { cny: number; usd: number }>>()
  /** 范围内出现过用量的全部小时 key（含未计价模型，用于 all 序列补齐）。 */
  const bucketHours = new Set<string>()
  const codingPlanLabels = new Set<string>()
  let sessionsInRange = 0

  for (const entry of Object.values(cache.sessions) as SessionCacheEntry[]) {
    let sessionInRange = false

    for (const [hourKey, byModel] of Object.entries(entry.buckets)) {
      const bucketStart = keyToStartMs(hourKey)
      if (bucketStart <= 0) continue
      if (fromMs !== null && bucketStart + HOUR_MS <= fromMs) continue
      if (bucketStart > nowMs) continue

      for (const [model, counts] of Object.entries(byModel)) {
        if (counts.n <= 0 && counts.i + counts.c + counts.w + counts.o <= 0) continue
        sessionInRange = true
        bucketHours.add(hourKey)

        let mAgg = modelAgg.get(model)
        if (mAgg === undefined) {
          mAgg = { ...emptyAcc(), providers: new Set<string>(), rules: new Map<string, PriceRuleView>() }
          modelAgg.set(model, mAgg)
        }
        addTokens(mAgg, counts)
        for (const provider of entry.modelProviders[model] ?? []) mAgg.providers.add(provider)

        let fAgg = folderAgg.get(entry.folder)
        if (fAgg === undefined) {
          fAgg = { ...emptyAcc(), folder: entry.folder, cwds: new Map<string, number>(), sessions: new Set<string>(), models: new Set<string>() }
          folderAgg.set(entry.folder, fAgg)
        }
        addTokens(fAgg, counts)
        fAgg.models.add(model)
        fAgg.sessions.add(entry.id || `${entry.folder}/${hourKey}`)
        if (entry.cwd !== null) fAgg.cwds.set(entry.cwd, (fAgg.cwds.get(entry.cwd) ?? 0) + 1)

        // 逐桶计价：模型 × 该小时（涨价时代 + 峰谷都在 resolvePrice 内判定）。
        const price = resolvePrice(model, bucketStart, config)
        if (price === null) continue
        const cost = costOf({ input: counts.i, cacheRead: counts.c, cacheWrite: counts.w, output: counts.o }, price, rate)
        mAgg.costCny += cost.cny
        mAgg.costUsd += cost.usd
        fAgg.costCny += cost.cny
        fAgg.costUsd += cost.usd

        let costs = bucketCost.get(hourKey)
        if (costs === undefined) {
          costs = new Map<string, { cny: number; usd: number }>()
          bucketCost.set(hourKey, costs)
        }
        const slot = costs.get(model) ?? { cny: 0, usd: 0 }
        slot.cny += cost.cny
        slot.usd += cost.usd
        costs.set(model, slot)

        const view: PriceRuleView = {
          label: `${price.label}${price.entry.peak === null ? '' : price.entry.peak ? '（高峰）' : '（空闲）'}`,
          currency: price.entry.currency,
          inputPerMillion: price.entry.inputPerMillion,
          cacheReadPerMillion: price.entry.cacheReadPerMillion,
          outputPerMillion: price.entry.outputPerMillion,
          source: price.entry.source,
          estimated: price.entry.estimated,
          since: price.entry.sinceMs === null ? null : new Date(price.entry.sinceMs).toISOString(),
          peak: price.entry.peak,
          requests: 0,
        }
        const key = ruleViewKey(view)
        const existing = mAgg.rules.get(key)
        if (existing === undefined) mAgg.rules.set(key, { ...view, requests: counts.n })
        else existing.requests += counts.n

        // Coding Plan 订阅通道提示（provider 特征匹配）。
        for (const provider of mAgg.providers) {
          for (const hint of CODING_PLAN_PROVIDER_HINTS) {
            if (hint.match(provider)) codingPlanLabels.add(hint.label)
          }
        }
      }
    }
    if (sessionInRange) sessionsInRange += 1
  }

  // 模型行（费用降序，其次 token 量）。
  const models: ModelRow[] = [...modelAgg.entries()]
    .map(([model, agg]) => ({
      model,
      providers: [...agg.providers].sort(),
      inputTokens: agg.inputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      cacheWriteTokens: agg.cacheWriteTokens,
      outputTokens: agg.outputTokens,
      totalTokens: agg.totalTokens,
      requests: agg.requests,
      costCny: agg.costCny,
      costUsd: agg.costUsd,
      priced: agg.rules.size > 0,
      priceRules: [...agg.rules.values()].sort((a, b) => b.requests - a.requests),
    }))
    .sort((a, b) => b.costCny - a.costCny || b.totalTokens - a.totalTokens)

  // 文件夹行（费用降序）。
  const folders: FolderRow[] = [...folderAgg.values()]
    .map((agg) => ({
      folder: agg.folder,
      cwd: [...agg.cwds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      sessions: agg.sessions.size,
      requests: agg.requests,
      totalTokens: agg.totalTokens,
      costCny: agg.costCny,
      costUsd: agg.costUsd,
      models: agg.models.size,
    }))
    .sort((a, b) => b.costCny - a.costCny || b.totalTokens - a.totalTokens)

  // 折线图序列：范围内连续桶 key（缺数据补 0，保证曲线连续）。
  let seriesKeys: string[]
  if (range === 'all') {
    const allHourKeys = [...bucketHours].sort()
    seriesKeys = allHourKeys.length === 0 ? [] : dayKeysBetween(keyToStartMs(`${allHourKeys[0].slice(0, 10)}T00`), nowMs)
  } else if (granularity === 'hour') {
    seriesKeys = hourKeysBetween(fromMs as number, nowMs)
  } else {
    seriesKeys = dayKeysBetween(fromMs as number, nowMs)
  }

  const chartModels = models.slice(0, 8)
  const seriesModels: SeriesModelRow[] = chartModels.map((row) => ({
    model: row.model,
    values: seriesKeys.map((key) => {
      let cny = 0
      let usd = 0
      for (const hk of granularity === 'hour' ? [key] : dayKeyToHourKeys(key)) {
        const slot = bucketCost.get(hk)?.get(row.model)
        if (slot !== undefined) {
          cny += slot.cny
          usd += slot.usd
        }
      }
      return { cny, usd } satisfies SeriesPoint
    }),
  }))

  // 总计。
  const totals = models.reduce(
    (acc, row) => {
      acc.costCny += row.costCny
      acc.costUsd += row.costUsd
      acc.inputTokens += row.inputTokens
      acc.cacheReadTokens += row.cacheReadTokens
      acc.cacheWriteTokens += row.cacheWriteTokens
      acc.outputTokens += row.outputTokens
      acc.totalTokens += row.totalTokens
      acc.requests += row.requests
      return acc
    },
    {
      costCny: 0, costUsd: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: 0, totalTokens: 0, requests: 0,
      sessions: sessionsInRange, folders: folderAgg.size, models: models.length,
    },
  )

  // 提示与备注。
  const warnings: string[] = []
  for (const row of models) {
    if (!row.priced && row.totalTokens > 0) {
      warnings.push(
        `模型 ${row.model} 没有内置计价规则（${formatTokensShort(row.totalTokens)} tokens 未计费）；可在 ~/.dsh/plugins/dsh-usage/config.json 的 models 中补充官方单价。`,
      )
    }
    if (row.priceRules.some((r) => r.estimated)) {
      warnings.push(`模型 ${row.model} 使用估算价（官方刊例未公布），计价规则已标注来源。`)
    }
  }
  const notes: string[] = [
    '费用 = Σ（每模型逐小时桶 × 该时刻单价）：DeepSeek V4 以 2026-08-17 涨价为分界，并按北京时间 9-12 / 14-18 高峰时段逐桶计价。',
    `美元 ⇆ 人民币按 ${rate} 折算（config.json 可改）。`,
  ]
  if (codingPlanLabels.size > 0) {
    notes.push(`${[...codingPlanLabels].sort().join('；')}：这些通道实际按订阅计费，看板金额为按量刊例价折算，仅供参考。`)
  }

  return {
    ok: true,
    version: 1,
    generatedAt: nowMs,
    tookMs: Date.now() - startedAt,
    scanned: {
      sessions: Object.keys(cache.sessions).length,
      folders: new Set(Object.values(cache.sessions).map((s: SessionCacheEntry) => s.folder)).size,
      reindexed: 0,
      indexedAt: cache.indexedAt,
    },
    range: { key: range, fromMs, toMs: nowMs, granularity },
    pricing: { rateUsdCny: rate, notes },
    totals,
    models,
    folders,
    series: { unit: granularity, keys: seriesKeys, models: seriesModels },
    warnings,
  }
}

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}
