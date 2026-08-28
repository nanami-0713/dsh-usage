/**
 * GLM Coding Plan（智谱 z.ai / bigmodel）适配器。
 *
 * 端点（逆向工程所得，订阅管理 UI 同款，API key 直接可用）：
 *   GET {host}/api/monitor/usage/quota/limit
 *   Headers: authorization: Bearer <api key>, accept: application/json
 *
 * 响应结构（实测 2026-08，Lite 套餐为 CREDIT_LIMIT、Pro/Max 为 TOKENS_LIMIT）：
 *   { code: 200, data: { limits: [
 *       { type: 'CREDIT_LIMIT'|'TOKENS_LIMIT'|'TIME_LIMIT',
 *         unit: 3, number: 5,          // unit 编码: 3=小时 5=月 6=周
 *         usage: 12000,                 // 总额（TIME_LIMIT 时为计数上限）
 *         currentValue: 50,             // 已用
 *         remaining: 11949,
 *         percentage: 1,                // 已用百分比（0-100）
 *         nextResetTime: 1787086062567  // epoch ms
 *       }, ... ],
 *       level: 'pro' | 'max' | 'lite' } }
 *
 * 窗口归类规则（按 unit/number 而非 type，同一 type 可出现多个窗口）：
 *   (unit=3, number=5) → 5 小时额度（primary）
 *   (unit=6, *)        → 周额度
 *   (unit=5, *)        → 月额度
 *   type=TIME_LIMIT    → 计数型窗口（Web 搜索等），按 unit 归入月/其他
 */
import type { QuotaSnapshot, QuotaUnit, QuotaWindow } from '../shared.js'

const ZAI_HOSTS = ['https://api.z.ai', 'https://open.bigmodel.cn']

const UNIT_NAMES: Record<number, string> = { 3: '小时', 5: '月', 6: '周' }

const PLAN_LABELS: Record<string, string> = {
  lite: 'Lite',
  pro: 'Pro',
  max: 'Max',
}

interface ZaiLimitEntry {
  type?: string
  name?: string
  unit?: number
  number?: number
  usage?: number
  currentValue?: number
  remaining?: number
  percentage?: number
  nextResetTime?: number
}

interface ZaiQuotaBody {
  code?: number
  success?: boolean
  data?: { limits?: ZaiLimitEntry[]; level?: string } | ZaiLimitEntry[]
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/** 把 (type, unit, number) 归类为窗口 id/label；未知组合落到通用命名。 */
function classify(entry: ZaiLimitEntry): { id: string; label: string } | null {
  const type = (entry.type ?? entry.name ?? '').toUpperCase()
  const unit = toNumber(entry.unit)
  const number = toNumber(entry.number)
  if (type === 'TIME_LIMIT') {
    if (unit === 5 || Number.isNaN(unit)) return { id: 'monthly-count', label: '月度计数额度' }
    return { id: `count-u${entry.unit ?? '?'}`, label: `${Number.isNaN(number) ? '' : number}${UNIT_NAMES[unit] ?? ''}计数额度`.trim() }
  }
  if (unit === 3) {
    if (number === 5) return { id: '5h', label: '5 小时额度' }
    return { id: `hours-${entry.number}`, label: `${Number.isNaN(number) ? '' : number} 小时额度` }
  }
  if (unit === 6) return { id: 'weekly', label: '周额度' }
  if (unit === 5) return { id: 'monthly', label: '月额度' }
  if (Number.isNaN(unit) && Number.isNaN(number)) return { id: 'other', label: '额度' }
  return { id: `u${entry.unit ?? '?'}-${entry.number ?? '?'}`, label: `${Number.isNaN(number) ? '' : number}${UNIT_NAMES[unit] ?? ''}窗口额度`.trim() }
}

function unitOf(entry: ZaiLimitEntry): QuotaUnit {
  const type = (entry.type ?? entry.name ?? '').toUpperCase()
  if (type === 'TIME_LIMIT') return 'requests'
  if (type === 'TOKENS_LIMIT') return 'tokens'
  return 'credits'
}

export async function fetchZaiQuota(apiKey: string, baseURL?: string, fetchImpl: typeof fetch = fetch): Promise<QuotaSnapshot> {
  const hosts = typeof baseURL === 'string' && baseURL !== '' ? [baseURL.replace(/\/+$/, '')] : ZAI_HOSTS
  let lastError: unknown = null
  let body: ZaiQuotaBody | null = null
  for (const host of hosts) {
    try {
      const response = await fetchImpl(`${host}/api/monitor/usage/quota/limit`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      const text = await response.text()
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
        if (response.status === 401 || response.status === 403) break
        continue
      }
      body = JSON.parse(text) as ZaiQuotaBody
      break
    } catch (error) {
      lastError = error
    }
  }
  if (body === null) {
    throw lastError instanceof Error ? lastError : new Error('GLM 额度接口不可达')
  }
  const container = Array.isArray(body.data) ? { limits: body.data } : body.data
  const entries = container?.limits
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('GLM 额度响应中没有 limits 数据')
  }

  const windows: QuotaWindow[] = []
  for (const entry of entries) {
    const classified = classify(entry)
    if (classified === null) continue
    const limit = toNumber(entry.usage)
    const usedRaw = toNumber(entry.currentValue)
    // 个别套餐只给 percentage/remaining：used 兜底 = limit - remaining
    const used = Number.isFinite(usedRaw)
      ? usedRaw
      : Number.isFinite(toNumber(entry.remaining))
        ? limit - toNumber(entry.remaining)
        : Number.isFinite(limit) && Number.isFinite(toNumber(entry.percentage))
          ? (limit * toNumber(entry.percentage)) / 100
          : Number.NaN
    if (!Number.isFinite(limit) || !Number.isFinite(used)) continue
    const window: QuotaWindow = {
      id: classified.id,
      label: classified.label,
      used: Math.max(0, used),
      limit: Math.max(0, limit),
      unit: unitOf(entry),
    }
    const resetsAt = toNumber(entry.nextResetTime)
    if (Number.isFinite(resetsAt) && resetsAt > 0) window.resetsAt = resetsAt
    windows.push(window)
  }
  if (windows.length === 0) throw new Error('GLM 额度响应无法解析出任何窗口')

  const order: Record<string, number> = { '5h': 0, weekly: 1, monthly: 2, 'monthly-count': 3 }
  windows.sort((a, b) => (order[a.id] ?? 9) - (order[b.id] ?? 9))
  const primary = windows.find((window) => window.id === '5h') ?? windows[0]

  const level = typeof container?.level === 'string' ? container.level.toLowerCase() : undefined
  const notes: string[] = []
  if (primary.id !== '5h') notes.push('响应中未找到 5 小时窗口，暂以首个窗口代替')

  const snapshot: QuotaSnapshot = {
    adapter: 'zai',
    adapterLabel: 'GLM Coding Plan',
    primaryId: primary.id,
    windows,
    notes: notes.length > 0 ? notes : undefined,
    fetchedAt: Date.now(),
  }
  if (level !== undefined && level !== '') snapshot.planLabel = PLAN_LABELS[level] ?? level.toUpperCase()
  return snapshot
}
