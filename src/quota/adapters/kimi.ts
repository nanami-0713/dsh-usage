/**
 * Kimi Coding Plan（月之暗面 api.kimi.com/coding）适配器。
 *
 * 端点（逆向工程所得；API key 与 kimi CLI 的 OAuth token 均可直接访问）：
 *   GET {baseURL}/usages          （baseURL 默认 https://api.kimi.com/coding/v1）
 *   Headers: authorization: Bearer <api key>, accept: application/json
 *
 * 响应结构（实测 2026-08）：
 *   { user: { membership: { level: 'LEVEL_ADVANCED' } },
 *     usage:  { limit: '100', used: '6', remaining: '94',
 *               resetTime: '2026-08-24T01:55:32Z' },          // 订阅周期配额
 *     limits: [ { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
 *                 detail: { limit: '100', remaining: '100',
 *                           resetTime: '2026-08-18T15:55:32Z' } } ],  // 5 小时窗口
 *     parallel: { limit: '30' },
 *     boosterWallet: { balance: { amount: '10000000000',
 *                                 amountLeft: '3823342900' } } }
 *
 * 计量单位为「请求数」。5 小时窗口取 limits 中 duration*unit == 300 分钟的那条；
 * usage 为订阅周期总配额（resetTime 即重置点）；加速包按内部点数折算百分比展示。
 */
import type { QuotaSnapshot, QuotaWindow } from '../shared.js'

const KIMI_DEFAULT_BASE = 'https://api.kimi.com/coding/v1'

interface KimiDetail {
  limit?: string | number
  used?: string | number
  remaining?: string | number
  resetTime?: string
}

interface KimiLimit {
  window?: { duration?: number | string; timeUnit?: string }
  detail?: KimiDetail
}

interface KimiUsagesBody {
  user?: { membership?: { level?: string } }
  usage?: KimiDetail
  limits?: KimiLimit[]
  parallel?: { limit?: string | number }
  boosterWallet?: { balance?: { amount?: string | number; amountLeft?: string | number } }
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function toEpochMs(iso: unknown): number | undefined {
  if (typeof iso !== 'string' || iso === '') return undefined
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : undefined
}

/** window.duration * 单位换算成分钟；识别不了的返回 NaN。 */
function windowMinutes(limit: KimiLimit): number {
  const duration = toNumber(limit.window?.duration)
  if (Number.isNaN(duration)) return Number.NaN
  const unit = (limit.window?.timeUnit ?? '').toUpperCase()
  if (unit === 'TIME_UNIT_MINUTE' || unit === 'MINUTE') return duration
  if (unit === 'TIME_UNIT_HOUR' || unit === 'HOUR') return duration * 60
  if (unit === 'TIME_UNIT_SECOND' || unit === 'SECOND') return duration / 60
  return Number.NaN
}

const MEMBERSHIP_LABELS: Record<string, string> = {
  LEVEL_BEGINNER: '入门档',
  LEVEL_INTERMEDIATE: '中档',
  LEVEL_ADVANCED: '高档',
}

export async function fetchKimiQuota(apiKey: string, baseURL?: string, fetchImpl: typeof fetch = fetch): Promise<QuotaSnapshot> {
  const base = (typeof baseURL === 'string' && baseURL !== '' ? baseURL : KIMI_DEFAULT_BASE).replace(/\/+$/, '')
  let body: KimiUsagesBody
  try {
    const response = await fetchImpl(`${base}/usages`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
    body = JSON.parse(text) as KimiUsagesBody
  } catch (error) {
    throw error instanceof Error ? error : new Error('Kimi 额度接口请求失败')
  }

  const windows: QuotaWindow[] = []
  const notes: string[] = []

  // 5 小时窗口：limits 里时长为 300 分钟的那条（或首条无法识别时长的）
  let fiveHour: QuotaWindow | undefined
  const limits = Array.isArray(body.limits) ? body.limits : []
  for (const limit of limits) {
    const detail = limit.detail
    if (detail === undefined) continue
    const limitValue = toNumber(detail.limit)
    const remaining = toNumber(detail.remaining)
    const usedValue = toNumber(detail.used)
    if (!Number.isFinite(limitValue)) continue
    const used = Number.isFinite(usedValue) ? usedValue : limitValue - (Number.isFinite(remaining) ? remaining : 0)
    const minutes = windowMinutes(limit)
    const isFiveHour = Math.abs(minutes - 300) < 1
    const window: QuotaWindow = {
      id: isFiveHour ? '5h' : `w-${Math.round(minutes)}`,
      label: isFiveHour ? '5 小时额度' : Number.isFinite(minutes) ? `${Math.round(minutes)} 分钟窗口额度` : '限额窗口额度',
      used: Math.max(0, used),
      limit: Math.max(0, limitValue),
      unit: 'requests',
    }
    const resetsAt = toEpochMs(detail.resetTime)
    if (resetsAt !== undefined) window.resetsAt = resetsAt
    if (isFiveHour) fiveHour = window
    else windows.push(window)
  }

  // 订阅周期配额（usage）
  const usage = body.usage
  if (usage !== undefined) {
    const limitValue = toNumber(usage.limit)
    if (Number.isFinite(limitValue) && limitValue > 0) {
      const remaining = toNumber(usage.remaining)
      const usedValue = toNumber(usage.used)
      const used = Number.isFinite(usedValue) ? usedValue : limitValue - (Number.isFinite(remaining) ? remaining : 0)
      const window: QuotaWindow = {
        id: 'subscription',
        label: '订阅周期额度',
        used: Math.max(0, used),
        limit: Math.max(0, limitValue),
        unit: 'requests',
      }
      const resetsAt = toEpochMs(usage.resetTime)
      if (resetsAt !== undefined) window.resetsAt = resetsAt
      windows.unshift(window)
    }
  }

  if (fiveHour === undefined) {
    if (windows.length === 0) throw new Error('Kimi 额度响应无法解析出任何窗口')
    notes.push('响应中未找到 5 小时窗口，暂以首个窗口代替')
  } else {
    windows.unshift(fiveHour)
  }

  // 附加信息：并发上限与加速包余额（点数比例展示，不做金额折算）
  const parallel = toNumber(body.parallel?.limit)
  if (Number.isFinite(parallel) && parallel > 0) notes.push(`并发请求上限 ${Math.round(parallel)}`)
  const boosterAmount = toNumber(body.boosterWallet?.balance?.amount)
  const boosterLeft = toNumber(body.boosterWallet?.balance?.amountLeft)
  if (Number.isFinite(boosterAmount) && boosterAmount > 0 && Number.isFinite(boosterLeft)) {
    const percent = Math.round((Math.min(boosterLeft, boosterAmount) / boosterAmount) * 100)
    notes.push(`加速包余额 ${percent}%`)
  }

  const snapshot: QuotaSnapshot = {
    adapter: 'kimi',
    adapterLabel: 'Kimi Coding Plan',
    primaryId: (fiveHour ?? windows[0]).id,
    windows,
    fetchedAt: Date.now(),
  }
  const level = body.user?.membership?.level
  if (typeof level === 'string' && level !== '') snapshot.planLabel = MEMBERSHIP_LABELS[level] ?? level.replace(/^LEVEL_/, '')
  if (notes.length > 0) snapshot.notes = notes
  return snapshot
}
