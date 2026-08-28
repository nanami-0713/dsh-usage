/**
 * @hsinsekai-nanami/dsh-usage — 统一配置（host 侧，core 内核）。
 *
 * 配置文件：~/.dsh/plugins/dsh-usage/config.json（version 2），计价与额度共用：
 *   { version: 2, rateUsdCny, models: {…覆盖价…}, providers: {…适配器映射…}, refreshMs }
 *
 * 首次启动自动迁移两个前身插件的配置与缓存（单向、幂等、可回退）：
 *   - ~/.dsh/plugins/dsh-usage-board/config.json  → models / rateUsdCny
 *   - ~/.dsh/plugins/dsh-quota-visor/config.json  → providers / refreshMs
 *   合并写入 v2 后，旧文件重命名为 config.migrated.json 保留备查（不删除）；
 *   - ~/.dsh/plugins/dsh-usage-board/cache.json（全量索引缓存）【复制】到新目录，
 *     旧插件在过渡期仍可原样工作，新插件免全量重扫。
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_CONFIG,
  DEFAULT_RATE_USD_CNY,
  type Currency,
  type ModelOverride,
  type ProviderMapping,
  type UsageConfig,
} from './pricing.js'
import { dshHomeDir, legacyDataDirs, pluginDataDir } from './home.js'

/** 额度轮询间隔的默认与边界（ms）。 */
export const DEFAULT_REFRESH_MS = 60_000

function configPath(home = dshHomeDir()): string {
  return join(pluginDataDir(home), 'config.json')
}

/* ───────────────────────── 归一化 ───────────────────────── */

function normalizeOverride(value: unknown): ModelOverride | null {
  if (value === null || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  const currency: Currency = entry.currency === 'USD' ? 'USD' : 'CNY'
  const positive = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
  const inputPerMillion = positive(entry.inputPerMillion)
  const cacheReadPerMillion = positive(entry.cacheReadPerMillion)
  const outputPerMillion = positive(entry.outputPerMillion)
  if (inputPerMillion === null || cacheReadPerMillion === null || outputPerMillion === null) return null
  const override: ModelOverride = { currency, inputPerMillion, cacheReadPerMillion, outputPerMillion }
  if (typeof entry.label === 'string' && entry.label !== '') override.label = entry.label
  if (typeof entry.source === 'string' && entry.source !== '') override.source = entry.source
  if (typeof entry.estimated === 'boolean') override.estimated = entry.estimated
  return override
}

function normalizeProviderMapping(value: unknown): ProviderMapping | null {
  if (value === null || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  const adapter = typeof entry.adapter === 'string' ? entry.adapter.trim() : ''
  if (adapter === '') return null
  const mapped: ProviderMapping = { adapter }
  if (typeof entry.baseURL === 'string' && entry.baseURL.trim() !== '') mapped.baseURL = entry.baseURL.trim()
  return mapped
}

function clampRefreshMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(3_600_000, Math.max(10_000, Math.round(value)))
}

/** 任意 JSON → v2 配置（容忍缺失/非法字段，全部落回默认值）。 */
export function normalizeUsageConfig(raw: unknown): UsageConfig {
  const config: UsageConfig = { ...DEFAULT_CONFIG, models: {}, providers: {} }
  if (raw === null || typeof raw !== 'object') return config
  const record = raw as Record<string, unknown>
  if (typeof record.rateUsdCny === 'number' && Number.isFinite(record.rateUsdCny) && record.rateUsdCny > 0) {
    config.rateUsdCny = record.rateUsdCny
  }
  if (record.models !== null && typeof record.models === 'object' && !Array.isArray(record.models)) {
    for (const [model, entry] of Object.entries(record.models as Record<string, unknown>)) {
      const key = model.trim().toLowerCase()
      if (key === '') continue
      const override = normalizeOverride(entry)
      if (override !== null) config.models[key] = override
    }
  }
  if (record.providers !== null && typeof record.providers === 'object' && !Array.isArray(record.providers)) {
    for (const [providerId, entry] of Object.entries(record.providers as Record<string, unknown>)) {
      const mapped = normalizeProviderMapping(entry)
      if (mapped !== null) config.providers[providerId] = mapped
    }
  }
  const refreshMs = clampRefreshMs(record.refreshMs)
  if (refreshMs !== undefined) config.refreshMs = refreshMs
  return config
}

/* ───────────────────────── 读写（10s 缓存 + 原子写） ───────────────────────── */

let configCache: { value: UsageConfig; at: number } | null = null

export async function loadConfig(home = dshHomeDir()): Promise<UsageConfig> {
  if (configCache !== null && Date.now() - configCache.at < 10_000) return configCache.value
  let config: UsageConfig
  try {
    config = normalizeUsageConfig(JSON.parse(await readFile(configPath(home), 'utf8')))
  } catch {
    config = normalizeUsageConfig(null)
  }
  configCache = { value: config, at: Date.now() }
  return config
}

export async function saveConfig(config: UsageConfig, home = dshHomeDir()): Promise<void> {
  const file = configPath(home)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  configCache = { value: config, at: Date.now() }
}

/** 供测试重置内部缓存。 */
export function resetConfigCache(): void {
  configCache = null
}

/* ───────────────────────── 旧配置迁移 ───────────────────────── */

export interface MigrationReport {
  /** 是否执行了迁移（false = 已是 v2 或没有任何旧文件）。 */
  migrated: boolean
  boardConfig: boolean
  visorConfig: boolean
  boardCacheCopied: boolean
  notes: string[]
}

async function readJsonIfExists(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function renameIfExists(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to)
    return true
  } catch {
    return false
  }
}

/**
 * 把两个前身插件的配置合并进 v2（幂等：新 config 已是 v2 时直接返回）。
 * 旧文件改名 config.migrated.json 保留；board 的索引缓存【复制】不移动。
 */
export async function migrateLegacyConfigs(home = dshHomeDir(), log?: (msg: string) => void): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: false, boardConfig: false, visorConfig: false, boardCacheCopied: false, notes: [] }

  // 已是 v2：什么都不做（幂等）。
  const existing = await readJsonIfExists(configPath(home))
  if (existing !== null && typeof existing === 'object' && (existing as Record<string, unknown>).version === 2) {
    return report
  }

  const legacy = legacyDataDirs(home)
  const boardRaw = await readJsonIfExists(join(legacy.board, 'config.json'))
  const visorRaw = await readJsonIfExists(join(legacy.visor, 'config.json'))
  const merged = normalizeUsageConfig(existing) // 新目录里可能已有非 v2 残留，保住其中合法字段

  if (boardRaw !== null) {
    const board = normalizeUsageConfig({ models: (boardRaw as Record<string, unknown>)?.models, rateUsdCny: (boardRaw as Record<string, unknown>)?.rateUsdCny })
    merged.models = { ...board.models, ...merged.models }
    if (Object.keys(board.models).length > 0 || board.rateUsdCny !== DEFAULT_RATE_USD_CNY) {
      merged.rateUsdCny = board.rateUsdCny
    }
    report.boardConfig = true
  }
  if (visorRaw !== null) {
    const visor = normalizeUsageConfig({ providers: (visorRaw as Record<string, unknown>)?.providers, refreshMs: (visorRaw as Record<string, unknown>)?.refreshMs })
    merged.providers = { ...visor.providers, ...merged.providers }
    if (visor.refreshMs !== undefined) merged.refreshMs = visor.refreshMs
    report.visorConfig = true
  }

  if (!report.boardConfig && !report.visorConfig && existing === null) return report

  await saveConfig(merged, home)
  report.migrated = true
  report.notes.push(`配置已合并写入 ${configPath(home)}（version 2）`)

  if (report.boardConfig) {
    if (await renameIfExists(join(legacy.board, 'config.json'), join(legacy.board, 'config.migrated.json'))) {
      report.notes.push('dsh-usage-board/config.json → config.migrated.json（保留备查）')
    }
  }
  if (report.visorConfig) {
    if (await renameIfExists(join(legacy.visor, 'config.json'), join(legacy.visor, 'config.migrated.json'))) {
      report.notes.push('dsh-quota-visor/config.json → config.migrated.json（保留备查）')
    }
  }

  // 索引缓存：复制（不移动），旧看板插件在过渡期仍可原样工作。
  try {
    await mkdir(pluginDataDir(home), { recursive: true })
    await copyFile(join(legacy.board, 'cache.json'), join(pluginDataDir(home), 'cache.json'))
    report.boardCacheCopied = true
    report.notes.push('dsh-usage-board/cache.json 已复制（旧插件缓存保留）')
  } catch {
    // 无旧缓存：新插件会全量扫描一次，属正常路径。
  }

  for (const note of report.notes) log?.(note)
  return report
}

/* ───────────────────────── 旧版配置视图（兼容 API 用） ───────────────────────── */

/** 旧 dsh-usage-board GET /config 的响应形状。 */
export function boardConfigView(config: UsageConfig): { version: 1; rateUsdCny: number; models: Record<string, ModelOverride> } {
  return { version: 1, rateUsdCny: config.rateUsdCny, models: config.models }
}

/** 旧 dsh-quota-visor GET /config 的响应形状。 */
export function visorConfigView(config: UsageConfig): { version: 1; providers: Record<string, ProviderMapping>; refreshMs: number } {
  return { version: 1, providers: config.providers, refreshMs: config.refreshMs ?? DEFAULT_REFRESH_MS }
}

/** 旧 board PUT /config：把 v1 视图合并回 v2（不动 providers/refreshMs）。 */
export function mergeBoardConfig(config: UsageConfig, raw: unknown): UsageConfig {
  const incoming = normalizeUsageConfig(raw)
  return { ...config, rateUsdCny: incoming.rateUsdCny, models: incoming.models }
}

/** 旧 visor PUT /config：把 v1 视图合并回 v2（不动 models/rateUsdCny）。 */
export function mergeVisorConfig(config: UsageConfig, raw: unknown): UsageConfig {
  const incoming = normalizeUsageConfig(raw)
  const next = { ...config, providers: incoming.providers }
  if (incoming.refreshMs !== undefined) next.refreshMs = incoming.refreshMs
  else delete next.refreshMs
  return next
}
