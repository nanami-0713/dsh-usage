/**
 * @hsinsekai-nanami/dsh-usage — 会话日志统一解析（core 内核，纯函数，host 与 client 共用类型）。
 *
 * 解析 `~/.dsh/sessions/<folder>/<sessionId>/session.jsonl.zstd` 解压后的文本：
 *   - `session`              → 会话元信息（id / cwd / createdAt / origin）
 *   - `request/header`       → 该请求的 provider / model（日志按序出现，
 *                              会话中途切换模型会追加新 header）
 *   - `assistant/chunk`(usage) → 流式 usage 采样（请求失败也保留）
 *   - `assistant/message`    → 最终 usage（同一 turn/step 覆盖前者，不双计）
 *
 * 每个 (turn, step) 只保留最后一次 usage（与 dsh-token-meter 的 last-wins 投影
 * 语义一致）。一次行解析产出样本列表，两个聚合器各取所需：
 *   - aggregateSessionModels：会话模块用，model → 逐小时桶（epoch ts）
 *   - aggregateBoardBuckets：看板模块用，北京时区 hourKey → model → 紧凑计数
 *
 * 本文件合并自 dsh-token-cost/src/session-usage.ts 与
 * dsh-usage-board/src/indexer.ts 中两份语义一致的解析逻辑。
 */
import { hourKeyOf } from './pricing.js'

/* ───────────────────────── 样本与行解析 ───────────────────────── */

export interface UsageSample {
  turn: number
  step: number
  time: number
  model: string | null
  provider: string | null
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export interface SessionMeta {
  id: string
  cwd: string | null
  createdAt: number | null
  origin: string | null
}

export interface ParsedSessionLog {
  meta: SessionMeta
  samples: UsageSample[]
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 解压后的会话日志文本 → 元信息 + last-wins usage 样本。纯函数，供测试直接调用。 */
export function parseSessionLogText(text: string): ParsedSessionLog {
  const meta: SessionMeta = { id: '', cwd: null, createdAt: null, origin: null }
  let model: string | null = null
  let provider: string | null = null
  /** `${turn}:${step}` → 最后一次 usage（last-wins，不双计）。 */
  const samples = new Map<string, UsageSample>()

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let record: any
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    const type: string = record.type
    const data = record.data
    if (type === 'session') {
      // 真实日志中 id/cwd/createdAt/origin 在记录顶层（data 为空），兼容两种位置。
      meta.id = str(record.id) ?? str(data?.id) ?? meta.id
      meta.cwd = str(record.cwd) ?? str(data?.cwd)
      const created = typeof record.createdAt === 'number' ? record.createdAt : data?.createdAt
      if (typeof created === 'number' && created > 0) meta.createdAt = created
      meta.origin = str(record.origin) ?? str(data?.origin)
    } else if (type === 'request/header') {
      const config = data?.header?.config
      model = str(config?.model) ?? model
      provider = str(config?.provider) ?? provider
    } else if (type === 'assistant/chunk') {
      const chunk = data?.chunk
      if (chunk?.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
        const usage = chunk.usage
        samples.set(`${data?.turn}:${data?.step}`, {
          turn: num(data?.turn),
          step: num(data?.step),
          time: typeof record.time === 'number' ? record.time : 0,
          model,
          provider,
          input: num(usage.inputTokens),
          cacheRead: num(usage.cacheReadTokens),
          cacheWrite: num(usage.cacheWriteTokens),
          output: num(usage.outputTokens),
        })
      }
    } else if (type === 'assistant/message') {
      const usage = data?.usage
      if (usage !== null && typeof usage === 'object') {
        // 最终 usage 覆盖同 (turn,step) 的流式采样，避免双计。
        samples.set(`${data?.turn}:${data?.step}`, {
          turn: num(data?.turn),
          step: num(data?.step),
          time: typeof record.time === 'number' ? record.time : 0,
          model,
          provider,
          input: num(usage.inputTokens),
          cacheRead: num(usage.cacheReadTokens),
          cacheWrite: num(usage.cacheWriteTokens),
          output: num(usage.outputTokens),
        })
      }
    }
  }

  return { meta, samples: [...samples.values()] }
}

function usable(sample: UsageSample): boolean {
  if (sample.time <= 0) return false
  return !(sample.model === null && sample.input + sample.cacheRead + sample.cacheWrite + sample.output === 0)
}

/* ───────────────────────── 聚合器 A：会话模块（逐模型小时桶） ───────────────────────── */

/** 一个「模型 × 小时」桶（ts 为该小时起点 epoch ms）。 */
export interface ModelHourBucket {
  ts: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** 计费调用次数。 */
  requests: number
}

/** 一份会话日志归集结果中的一个模型条目。 */
export interface ModelUsageEntry {
  /** 日志里的原始模型 id（request/header.config.model）。 */
  model: string
  /** 日志里的 provider 路由（request/header.config.provider）。 */
  provider: string | null
  hours: ModelHourBucket[]
}

/** 样本 → model → 逐小时桶（epoch 整点 ts，供按「模型 × 时代 × 峰谷」逐桶计价）。 */
export function aggregateSessionModels(samples: readonly UsageSample[]): ModelUsageEntry[] {
  const byModel = new Map<string, ModelUsageEntry>()
  const byHour = new Map<string, ModelHourBucket>()
  for (const sample of samples) {
    if (!usable(sample)) continue
    const modelName = sample.model ?? '(unknown)'
    let entry = byModel.get(modelName)
    if (entry === undefined) {
      entry = { model: modelName, provider: sample.provider, hours: [] }
      byModel.set(modelName, entry)
    }
    if (entry.provider === null && sample.provider !== null) entry.provider = sample.provider
    const hourTs = Math.floor(sample.time / 3_600_000) * 3_600_000
    const key = `${modelName}:${hourTs}`
    let bucket = byHour.get(key)
    if (bucket === undefined) {
      bucket = { ts: hourTs, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 }
      byHour.set(key, bucket)
      entry.hours.push(bucket)
    }
    bucket.input += sample.input
    bucket.cacheRead += sample.cacheRead
    bucket.cacheWrite += sample.cacheWrite
    bucket.output += sample.output
    bucket.requests += 1
  }

  for (const entry of byModel.values()) entry.hours.sort((a, b) => a.ts - b.ts)
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model))
}

/* ───────────────────────── 聚合器 B：看板模块（北京时区紧凑桶） ───────────────────────── */

/** 一「模型 × 小时」桶的 token 紧凑计数。 */
export interface BucketCounts {
  /** 未缓存输入 tokens。 */
  i: number
  /** 缓存读取 tokens。 */
  c: number
  /** 缓存写入 tokens。 */
  w: number
  /** 输出 tokens。 */
  o: number
  /** 计费调用次数。 */
  n: number
}

export interface BoardBuckets {
  /** 北京时区 hourKey（"2026-08-18T14"）→ model → counts。 */
  buckets: Record<string, Record<string, BucketCounts>>
  /** model → provider 路由集合（来自 request/header）。 */
  modelProviders: Record<string, string[]>
}

/** 样本 → 北京时区 hourKey × model 紧凑桶（看板索引缓存的存储格式）。 */
export function aggregateBoardBuckets(samples: readonly UsageSample[]): BoardBuckets {
  const buckets: Record<string, Record<string, BucketCounts>> = {}
  const modelProviders: Record<string, string[]> = {}
  for (const sample of samples) {
    if (!usable(sample)) continue
    const hourKey = hourKeyOf(sample.time)
    const modelName = sample.model ?? '(unknown)'
    if (sample.provider !== null && !((modelProviders[modelName] ??= []).includes(sample.provider))) {
      modelProviders[modelName].push(sample.provider)
    }
    const byModel = (buckets[hourKey] ??= {})
    const counts = (byModel[modelName] ??= { i: 0, c: 0, w: 0, o: 0, n: 0 })
    counts.i += sample.input
    counts.c += sample.cacheRead
    counts.w += sample.cacheWrite
    counts.o += sample.output
    counts.n += 1
  }
  return { buckets, modelProviders }
}
