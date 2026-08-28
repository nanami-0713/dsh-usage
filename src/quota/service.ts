/**
 * @hsinsekai-nanami/dsh-usage — quota 模块的额度查询服务（host 侧）。
 *
 * 职责：
 *   1. 解析 DSH provider 配置：~/.dsh/settings.yaml 的 llm-pi-ai.providers.<id>
 *      （displayName / apiKeyEnv / baseURL）；
 *   2. 识别 Coding Plan：matchAdapter 三级匹配（config 映射 → 内置 id → baseURL 特征）；
 *   3. 解析凭据：进程 env[apiKeyEnv] → ~/.dsh/.credentials.yaml[apiKeyEnv]；
 *   4. 调用对应适配器拉取额度（90s TTL 缓存），翻译为统一 QuotaSnapshot；
 *   5. queryAllQuotas：枚举 settings.yaml ∪ config.providers 的全部 provider，
 *      返回所有被识别为 Coding Plan 的额度（看板「订阅额度」区块消费）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from '../core/config.js'
import { dshHomeDir } from '../core/home.js'
import {
  matchAdapter,
  type ProviderRouteInfo,
  type QuotaAllEntry,
  type QuotaAllResponse,
  type QuotaResponse,
  type QuotaSnapshot,
} from './shared.js'
import { fetchZaiQuota } from './adapters/zai.js'
import { fetchKimiQuota } from './adapters/kimi.js'

/** 同一 provider 的额度快照缓存时长；模型切换引发的 provider 变化不走缓存。 */
const QUOTA_TTL_MS = 90_000

/** settings.yaml 的解析缓存时长（provider 配置极少变化）。 */
const SETTINGS_TTL_MS = 30_000

type QuotaFetcher = (apiKey: string, baseURL?: string) => Promise<QuotaSnapshot>

/** 适配器注册表：新增厂商时在此登记（或经 registerQuotaAdapter 外部扩展）。 */
const ADAPTERS: Record<string, QuotaFetcher> = {
  zai: fetchZaiQuota,
  kimi: fetchKimiQuota,
}

/**
 * 注册/替换一个额度适配器（公开扩展点：第三方 Coding Plan 无需改源码即可接入；
 * 测试也用它注入 fake fetcher，避免真实网络请求）。
 */
export function registerQuotaAdapter(id: string, fetcher: QuotaFetcher): void {
  ADAPTERS[id] = fetcher
}

interface Cached<T> {
  value: T
  at: number
}

/* ─────────────────── YAML 读取（yaml 可选依赖，缺失时降级） ─────────────────── */

async function parseYaml(text: string): Promise<Record<string, unknown> | null> {
  try {
    const mod = (await import('yaml')) as { parse: (input: string) => unknown }
    const parsed = mod.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

interface Settings {
  providers: Record<string, ProviderRouteInfo>
}

let settingsCache: Cached<Settings> | null = null

async function loadSettings(home: string): Promise<Settings> {
  if (settingsCache !== null && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value
  let providers: Record<string, ProviderRouteInfo> = {}
  try {
    const text = await readFile(join(home, 'settings.yaml'), 'utf8')
    const parsed = await parseYaml(text)
    const llm = parsed?.['llm-pi-ai'] as Record<string, unknown> | undefined
    const rawProviders = llm?.providers
    if (rawProviders !== null && typeof rawProviders === 'object' && !Array.isArray(rawProviders)) {
      for (const [providerId, value] of Object.entries(rawProviders as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object') continue
        const entry = value as Record<string, unknown>
        const route: ProviderRouteInfo = { provider: providerId }
        if (typeof entry.displayName === 'string') route.displayName = entry.displayName
        if (typeof entry.apiKeyEnv === 'string') route.apiKeyEnv = entry.apiKeyEnv
        if (typeof entry.baseURL === 'string') route.baseURL = entry.baseURL
        providers[providerId] = route
      }
    }
  } catch {
    providers = {}
  }
  settingsCache = { value: { providers }, at: Date.now() }
  return settingsCache.value
}

let credentialsCache: Cached<Record<string, string>> | null = null

async function loadCredentials(home: string): Promise<Record<string, string>> {
  if (credentialsCache !== null && Date.now() - credentialsCache.at < SETTINGS_TTL_MS) return credentialsCache.value
  let credentials: Record<string, string> = {}
  try {
    const text = await readFile(join(home, '.credentials.yaml'), 'utf8')
    const parsed = await parseYaml(text)
    if (parsed !== null) {
      // 新版格式：顶层为 { version, refs: { KEY: value } }，凭据全在 refs 映射下；
      // 旧版扁平格式：凭据直接挂在顶层。两种都认，refs 存在时以 refs 为准。
      const refs = parsed['refs']
      const source = refs !== null && typeof refs === 'object' && !Array.isArray(refs)
        ? (refs as Record<string, unknown>)
        : parsed
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'string' && value !== '') credentials[key] = value
      }
    }
  } catch {
    credentials = {}
  }
  credentialsCache = { value: credentials, at: Date.now() }
  return credentialsCache.value
}

/* ─────────────────── 额度查询主流程 ─────────────────── */

const quotaCache = new Map<string, Cached<QuotaResponse>>()

/** 配置变更后清空额度缓存（PUT /config 时调用）。 */
export function clearQuotaCache(): void {
  quotaCache.clear()
}

function fail(provider: string, code: NonNullable<QuotaResponse['error']>, message: string): QuotaResponse {
  return { ok: false, provider, error: code, message }
}

export async function queryQuota(providerId: string, forceRefresh: boolean, home = dshHomeDir()): Promise<QuotaResponse> {
  if (!forceRefresh) {
    const cached = quotaCache.get(providerId)
    if (cached !== undefined && Date.now() - cached.at < QUOTA_TTL_MS) return cached.value
  }

  const config = await loadConfig(home)
  const settings = await loadSettings(home)
  const route: ProviderRouteInfo | null = settings.providers[providerId] ?? null

  const match = matchAdapter(providerId, route, config)
  if (match === null) {
    const response = { ...fail(providerId, 'NOT_CODING_PLAN', '未识别为 Coding Plan 订阅（可于 config.json providers 中显式映射）'), matched: { adapter: 'none', reason: 'none' as const } }
    quotaCache.set(providerId, { value: response, at: Date.now() })
    return response
  }

  const fetcher = ADAPTERS[match.adapter]
  if (fetcher === undefined) {
    const response = fail(providerId, 'NOT_CODING_PLAN', `适配器 ${match.adapter} 尚未实现`)
    quotaCache.set(providerId, { value: response, at: Date.now() })
    return response
  }

  const apiKeyEnv = route?.apiKeyEnv
  let apiKey = ''
  if (typeof apiKeyEnv === 'string' && apiKeyEnv !== '') {
    const fromEnv = process.env[apiKeyEnv]
    if (typeof fromEnv === 'string' && fromEnv !== '') {
      apiKey = fromEnv
    } else {
      const credentials = await loadCredentials(home)
      const fromStore = credentials[apiKeyEnv]
      if (typeof fromStore === 'string' && fromStore !== '') {
        apiKey = fromStore
      }
    }
  }
  if (apiKey === '') {
    const response = fail(
      providerId,
      'NO_KEY',
      `未找到 API key：settings.yaml 中 ${providerId} 声明的 apiKeyEnv${apiKeyEnv === undefined ? ' 缺失' : `（${apiKeyEnv}）`} 在进程环境变量与 ~/.dsh/.credentials.yaml 中均不存在`,
    )
    quotaCache.set(providerId, { value: response, at: Date.now() })
    return response
  }

  const configuredBaseURL = config.providers[providerId]?.baseURL ?? route?.baseURL
  try {
    const snapshot = await fetcher(apiKey, configuredBaseURL)
    const response: QuotaResponse = {
      ok: true,
      provider: providerId,
      matched: { adapter: match.adapter, reason: match.reason },
      snapshot,
    }
    quotaCache.set(providerId, { value: response, at: Date.now() })
    return response
  } catch (error) {
    const response = fail(providerId, 'REQUEST_FAILED', error instanceof Error ? error.message : String(error))
    quotaCache.set(providerId, { value: response, at: Date.now() })
    return response
  }
}

/**
 * 枚举当前 DSH 配置里的全部 provider，返回所有被识别为 Coding Plan 的额度。
 * 未识别的计入 skipped（不回显 id，避免把无关配置面暴露给浏览器）。
 */
export async function queryAllQuotas(forceRefresh: boolean, home = dshHomeDir()): Promise<QuotaAllResponse> {
  const config = await loadConfig(home)
  const settings = await loadSettings(home)
  const ids = new Set<string>([...Object.keys(settings.providers), ...Object.keys(config.providers)])

  const recognized: string[] = []
  let skipped = 0
  for (const providerId of ids) {
    const route = settings.providers[providerId] ?? null
    if (matchAdapter(providerId, route, config) !== null) recognized.push(providerId)
    else skipped += 1
  }

  const entries: QuotaAllEntry[] = await Promise.all(
    recognized.sort().map(async (providerId) => ({
      provider: providerId,
      displayName: settings.providers[providerId]?.displayName,
      response: await queryQuota(providerId, forceRefresh, home),
    })),
  )

  return { ok: true, generatedAt: Date.now(), providers: entries, skipped }
}

/** 供测试重置内部缓存。 */
export function resetQuotaServiceCaches(): void {
  settingsCache = null
  credentialsCache = null
  quotaCache.clear()
}
