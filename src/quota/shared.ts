/**
 * @hsinsekai-nanami/dsh-usage — 订阅额度共享模型（quota 模块，纯函数，host 与 client 共用）。
 *
 * 不同厂商的 Coding Plan 订阅额度结构并不相同（这正是不能一套逻辑走天下的原因）：
 *   - GLM Coding Plan（z.ai / bigmodel）：5 小时 credits/tokens 窗口 + 周窗口，
 *     部分套餐另有月度 Web 搜索计数（TIME_LIMIT）；
 *   - Kimi Coding Plan（api.kimi.com/coding）：5 小时请求数窗口 + 订阅周期请求数配额，
 *     外加并发上限与加速包（booster）余额。
 * 因此统一抽象为 QuotaSnapshot：一个 primary 窗口（5 小时）+ 任意数量的附加窗口，
 * 适配器负责把各家响应翻译成这套模型，UI 只认模型不认厂商。
 *
 * provider 识别（自动对齐的核心）三级匹配，host 侧执行：
 *   1. 用户显式映射（config.json providers.<id>.adapter）——最高优先级；
 *   2. DSH 内置 Coding Plan provider id 表（zai-coding-cn / kimi-code 等）；
 *   3. settings.yaml 中该 provider 的 baseURL 特征（api.kimi.com/coding → kimi 等）。
 * 三级都未命中 → 不是 Coding Plan → 徽标不渲染。
 */
import type { UsageConfig } from '../core/pricing.js'

/** 额度数值的计量单位（决定 UI 格式化方式）。 */
export type QuotaUnit = 'credits' | 'tokens' | 'requests'

/** 一个额度窗口（5 小时 / 周 / 月 / 订阅周期 / 计数型附加额度）。 */
export interface QuotaWindow {
  /** 稳定 id：'5h' | 'weekly' | 'monthly' | 'subscription' | 适配器自定义。 */
  id: string
  /** 展示名，如「5 小时额度」「周额度」。 */
  label: string
  /** 已用。 */
  used: number
  /** 总额。 */
  limit: number
  /** 计量单位。 */
  unit: QuotaUnit
  /** 重置时间（epoch ms）；订阅周期等无明确重置点时可缺省。 */
  resetsAt?: number
}

/** 一家 Coding Plan 的完整额度快照。 */
export interface QuotaSnapshot {
  /** 适配器 id（'zai' | 'kimi' | ...）。 */
  adapter: string
  /** 适配器展示名（「GLM Coding Plan」）。 */
  adapterLabel: string
  /** 套餐标签（GLM: pro/max；Kimi: 会员等级），可缺省。 */
  planLabel?: string
  /** 常态徽标展示的窗口 id（始终为 5 小时窗口）。 */
  primaryId: string
  /** 全部额度窗口，按重要性排序（5h 在前）。 */
  windows: QuotaWindow[]
  /** 附加说明行（并发上限、加速包余额等）。 */
  notes?: string[]
  /** 拉取时间（epoch ms）。 */
  fetchedAt: number
}

/** provider 识别结果来源。 */
export type MatchReason = 'config' | 'builtin' | 'baseurl' | 'none'

/** GET /quota 的响应。 */
export interface QuotaResponse {
  ok: boolean
  /** 请求针对的 DSH provider id（原样回显）。 */
  provider: string
  /** 识别出的适配器与命中方式；ok=false 且 matched 为 none 时表示非 Coding Plan。 */
  matched?: { adapter: string; reason: MatchReason }
  snapshot?: QuotaSnapshot
  error?: QuotaErrorCode
  /** 人类可读错误说明（不含任何密钥）。 */
  message?: string
}

export type QuotaErrorCode =
  | 'UNKNOWN_PROVIDER'    // settings.yaml 里没有这个 provider（内置表也没命中）
  | 'NO_KEY'              // 找不到 API key（env 与 ~/.dsh/.credentials.yaml 都没有）
  | 'REQUEST_FAILED'      // 上游额度接口请求失败
  | 'PARSE_FAILED'        // 上游响应解析失败
  | 'NOT_CODING_PLAN'     // 识别为显式 none / 未识别出 Coding Plan 适配器

/** GET /quota/all 的单个 provider 条目。 */
export interface QuotaAllEntry {
  provider: string
  displayName?: string
  response: QuotaResponse
}

/** GET /quota/all 的响应。 */
export interface QuotaAllResponse {
  ok: true
  generatedAt: number
  /** 当前 DSH 中配置且被识别为 Coding Plan 的全部 provider 额度。 */
  providers: QuotaAllEntry[]
  /** 已配置但未识别为 Coding Plan 的 provider 数（不逐一返回，避免泄露配置面）。 */
  skipped: number
}

export const DEFAULT_REFRESH_MS = 60_000

/** 当前 provider/model 感知轮询间隔（本地 RPC，开销可忽略，取短以保证切换模型后快速对齐）。 */
export const SELECTION_POLL_MS = 10_000

/* ─────────────────── provider 识别（host 与测试共享的纯函数） ─────────────────── */

/** 已知适配器登记表：id → 展示名。新增厂商时在此登记并实现适配器。 */
export const ADAPTER_LABELS: Record<string, string> = {
  zai: 'GLM Coding Plan',
  kimi: 'Kimi Coding Plan',
}

/**
 * DSH 内置 Coding Plan provider id（大小写不敏感的子串匹配）。
 * 这些 id 由 DSH 官方 adapter 命名，settings.yaml 中可直接引用。
 */
const BUILTIN_PROVIDER_IDS: Array<{ adapter: string; pattern: RegExp }> = [
  // 智谱 GLM Coding Plan（CN / 国际 / 泛称）
  { adapter: 'zai', pattern: /^(zai-coding(-cn)?|zai|glm-coding|zhipu-coding)$/i },
  // Kimi Coding Plan（订阅制 coding 端点；moonshotai-cn 为按量付费 API，不匹配）
  { adapter: 'kimi', pattern: /^(kimi-code|kimi-coding)$/i },
]

/**
 * provider 的 baseURL 特征（用户自建 provider 常见形态：openai-compat 指向各家
 * coding 端点）。按声明顺序取首个命中。
 */
const BASEURL_PATTERNS: Array<{ adapter: string; pattern: RegExp }> = [
  { adapter: 'kimi', pattern: /^https?:\/\/([^/]*\.)?(api\.kimi\.com|api\.moonshot\.cn)\/coding/i },
  { adapter: 'zai', pattern: /^https?:\/\/([^/]*\.)?(api\.z\.ai|open\.bigmodel\.cn)(\/|$)/i },
  { adapter: 'zai', pattern: /^https?:\/\/[^/]+\/api\/coding/i },
]

/** settings.yaml 中一个 provider 的可识别面（host 读取后传入）。 */
export interface ProviderRouteInfo {
  provider: string
  displayName?: string
  apiKeyEnv?: string
  baseURL?: string
}

export interface AdapterMatch {
  adapter: string
  reason: MatchReason
}

/**
 * 三级识别：config 显式映射 → 内置 id 表 → baseURL 特征。
 * 返回 null 表示未识别为 Coding Plan（徽标不渲染）。
 */
export function matchAdapter(providerId: string, route: ProviderRouteInfo | null, config: UsageConfig): AdapterMatch | null {
  // 1) 用户显式映射（含 'none' 显式关闭）
  const configured = config.providers[providerId]
  if (configured !== undefined) {
    if (configured.adapter === 'none') return null
    if (ADAPTER_LABELS[configured.adapter] !== undefined) {
      return { adapter: configured.adapter, reason: 'config' }
    }
  }
  // 2) 内置 provider id
  for (const entry of BUILTIN_PROVIDER_IDS) {
    if (entry.pattern.test(providerId)) return { adapter: entry.adapter, reason: 'builtin' }
  }
  // 3) baseURL 特征（用户自建 provider 兜底）
  const baseURL = configured?.baseURL ?? route?.baseURL
  if (typeof baseURL === 'string' && baseURL !== '') {
    for (const entry of BASEURL_PATTERNS) {
      if (entry.pattern.test(baseURL)) return { adapter: entry.adapter, reason: 'baseurl' }
    }
  }
  return null
}

/* ─────────────────── 展示格式化（client 与 host 共享） ─────────────────── */

export function formatCount(value: number, unit: QuotaUnit): string {
  if (!Number.isFinite(value)) return '—'
  if (unit === 'tokens') {
    if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
    if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`
    return Math.round(value).toLocaleString('en-US')
  }
  return Math.round(value).toLocaleString('en-US')
}

export function formatPercent(fraction: number): string {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100)
  return `${percent}%`
}

/** 距重置点的剩余时间（紧凑格式：1h23m / 4d02h / 12m）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d${String(hours).padStart(2, '0')}h`
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  return `${minutes}m`
}

/** 窗口用量占比（0-1，钳制）。 */
export function windowFraction(window: QuotaWindow): number {
  if (!Number.isFinite(window.limit) || window.limit <= 0) return 0
  return Math.min(1, Math.max(0, window.used / window.limit))
}

/** 用量分级颜色（供进度条/文字着色）。 */
export function usageLevel(fraction: number): 'ok' | 'warn' | 'danger' {
  if (fraction >= 0.8) return 'danger'
  if (fraction >= 0.5) return 'warn'
  return 'ok'
}
