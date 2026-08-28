/**
 * 汇总构建单元测试：时间范围过滤、时代拆分计价、文件夹聚合、
 * 序列补零、未计价模型告警、Coding Plan 提示。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSummary, keyToStartMs } from '../lib/board/summary.js'

const at = (iso) => Date.parse(iso)

function makeCache() {
  const session = (folder, id, cwd, modelProviders, buckets) => ({
    id, folder, cwd, createdAt: null, origin: null, modelProviders, buckets,
    fp: { mtimeMs: 0, size: 0 },
  })
  return {
    version: 1,
    indexedAt: at('2026-08-19T12:00:00+08:00'),
    sessions: {
      '--w-one--/session-1': session('--w-one--', 'session-1', '/work/one', { 'deepseek-v4-flash': ['deepseek-official'] }, {
        // 涨价前统一价：1M×1.0 + 2M×0.02 + 0.5M×2.0 = ¥2.04
        '2026-08-15T10': { 'deepseek-v4-flash': { i: 1_000_000, c: 2_000_000, w: 0, o: 500_000, n: 1 } },
        // 涨价后高峰：1M×3.0 + 2M×0.10 + 0.5M×9.0 = ¥7.70
        '2026-08-18T10': { 'deepseek-v4-flash': { i: 1_000_000, c: 2_000_000, w: 0, o: 500_000, n: 1 } },
      }),
      '--w-one--/session-2': session('--w-one--', 'session-2', '/work/one', { 'deepseek-v4-pro': ['deepseek-modlens'] }, {
        // 涨价后空闲：1M×4.5 + 1M×0.15 + 1M×13.5 = ¥18.15
        '2026-08-18T13': { 'deepseek-v4-pro': { i: 1_000_000, c: 1_000_000, w: 0, o: 1_000_000, n: 2 } },
      }),
      '--w-two--/session-3': session('--w-two--', 'session-3', '/work/two', { 'kimi-k3': ['moonshotai-cn'], 'mystery-9b': ['other'] }, {
        // Kimi：$3+$0.3+$15 = $18.3 → ¥131.76（rate 7.2）
        '2026-08-18T20': { 'kimi-k3': { i: 1_000_000, c: 1_000_000, w: 0, o: 1_000_000, n: 1 } },
        '2026-08-18T21': { 'mystery-9b': { i: 100, c: 0, w: 0, o: 50, n: 1 } },
      }),
    },
  }
}

const NOW = at('2026-08-19T12:00:00+08:00')

test('keyToStartMs：北京时区小时/天 key → epoch ms', () => {
  assert.equal(keyToStartMs('2026-08-18T14'), at('2026-08-18T14:00:00+08:00'))
  assert.equal(keyToStartMs('2026-08-18'), at('2026-08-18T00:00:00+08:00'))
})

test('range=all：跨时代计价精确拆分', () => {
  const summary = buildSummary(makeCache(), { range: 'all', nowMs: NOW })
  assert.equal(summary.range.granularity, 'day')

  const flash = summary.models.find((m) => m.model === 'deepseek-v4-flash')
  assert.ok(Math.abs(flash.costCny - 9.74) < 1e-9) // 2.04 + 7.70
  assert.ok(Math.abs(flash.costUsd - 9.74 / 7.2) < 1e-9)
  // 两个时代两条规则，各命中 1 次。
  assert.equal(flash.priceRules.length, 2)
  assert.deepEqual(flash.priceRules.map((r) => r.requests).sort(), [1, 1])
  assert.ok(flash.priceRules.some((r) => r.peak === null && r.inputPerMillion === 1.0))
  assert.ok(flash.priceRules.some((r) => r.peak === true && r.inputPerMillion === 3.0))
  assert.deepEqual(flash.providers, ['deepseek-official'])

  const pro = summary.models.find((m) => m.model === 'deepseek-v4-pro')
  assert.ok(Math.abs(pro.costCny - 18.15) < 1e-9)

  const kimi = summary.models.find((m) => m.model === 'kimi-k3')
  assert.ok(Math.abs(kimi.costUsd - 18.3) < 1e-9)
  assert.ok(Math.abs(kimi.costCny - 131.76) < 1e-9)

  const mystery = summary.models.find((m) => m.model === 'mystery-9b')
  assert.equal(mystery.priced, false)
  assert.equal(mystery.costCny, 0)
  assert.equal(mystery.totalTokens, 150)
  assert.ok(summary.warnings.some((w) => w.includes('mystery-9b') && w.includes('未计费')))

  // 总计 = 9.74 + 18.15 + 131.76。
  assert.ok(Math.abs(summary.totals.costCny - 159.65) < 1e-9)
  assert.equal(summary.totals.requests, 6)
  assert.equal(summary.totals.models, 4)
  assert.equal(summary.totals.folders, 2)
  assert.equal(summary.totals.sessions, 3)

  // Coding Plan 提示（moonshotai-cn 命中 Kimi 订阅特征）。
  assert.ok(summary.pricing.notes.some((n) => n.includes('Kimi Coding Plan')))

  // 文件夹：--w-one-- = flash + pro = 27.89。
  const one = summary.folders.find((f) => f.folder === '--w-one--')
  assert.ok(Math.abs(one.costCny - 27.89) < 1e-9)
  assert.equal(one.cwd, '/work/one')
  assert.equal(one.sessions, 2)
  const two = summary.folders.find((f) => f.folder === '--w-two--')
  assert.ok(Math.abs(two.costCny - 131.76) < 1e-9)
})

test('range=all：序列按天补齐（15 → 19 共 5 天，缺数据为 0）', () => {
  const summary = buildSummary(makeCache(), { range: 'all', nowMs: NOW })
  assert.deepEqual(summary.series.keys, ['2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19'])
  const flash = summary.series.models.find((m) => m.model === 'deepseek-v4-flash')
  const byKey = Object.fromEntries(summary.series.keys.map((key, i) => [key, flash.values[i]]))
  assert.ok(Math.abs(byKey['2026-08-15'].cny - 2.04) < 1e-9)
  assert.ok(Math.abs(byKey['2026-08-18'].cny - 7.7) < 1e-9)
  assert.equal(byKey['2026-08-16'].cny, 0)
  assert.equal(byKey['2026-08-17'].cny, 0)
  const kimi = summary.series.models.find((m) => m.model === 'kimi-k3')
  assert.ok(Math.abs(kimi.values[3].usd - 18.3) < 1e-9)
})

test('range=1d：滚动 24 小时窗口 + 小时粒度序列', () => {
  const summary = buildSummary(makeCache(), { range: '1d', nowMs: NOW })
  // from = 08-18 12:00 北京。包含 18T13（pro）、18T20/21；排除 15T10 与 18T10。
  const models = new Set(summary.models.map((m) => m.model))
  assert.ok(models.has('deepseek-v4-pro'))
  assert.ok(models.has('kimi-k3'))
  assert.ok(models.has('mystery-9b'))
  assert.ok(!models.has('deepseek-v4-flash'), '18T10 桶不在窗口内')
  assert.ok(Math.abs(summary.totals.costCny - (18.15 + 131.76)) < 1e-9)

  assert.equal(summary.range.granularity, 'hour')
  assert.equal(summary.series.unit, 'hour')
  assert.equal(summary.series.keys[0], '2026-08-18T12')
  assert.equal(summary.series.keys.at(-1), '2026-08-19T12')
  assert.equal(summary.series.keys.length, 25) // 24 小时窗口 = 25 个整点桶
  const pro = summary.series.models.find((m) => m.model === 'deepseek-v4-pro')
  const proIndex = summary.series.keys.indexOf('2026-08-18T13')
  assert.ok(Math.abs(pro.values[proIndex].cny - 18.15) < 1e-9)
})

test('range=7d / 30d：天粒度，窗口内全量数据', () => {
  for (const range of ['7d', '30d']) {
    const summary = buildSummary(makeCache(), { range, nowMs: NOW })
    assert.equal(summary.range.granularity, 'day')
    assert.ok(Math.abs(summary.totals.costCny - 159.65) < 1e-9, `${range} 应包含全部四天数据`)
    const flash = summary.series.models.find((m) => m.model === 'deepseek-v4-flash')
    assert.equal(flash.values.reduce((acc, v) => acc + v.cny, 0) > 9, true)
  }
  const week = buildSummary(makeCache(), { range: '7d', nowMs: NOW })
  assert.equal(week.series.keys[0], '2026-08-12')
  assert.equal(week.series.keys.at(-1), '2026-08-19')
})

test('用户覆盖汇率与模型单价', () => {
  const config = {
    version: 1,
    rateUsdCny: 7,
    models: { 'mystery-9b': { currency: 'CNY', inputPerMillion: 1, cacheReadPerMillion: 0, outputPerMillion: 4 } },
  }
  const summary = buildSummary(makeCache(), { range: 'all', nowMs: NOW, config })
  const mystery = summary.models.find((m) => m.model === 'mystery-9b')
  assert.equal(mystery.priced, true)
  // 100×1/M + 50×4/M = ¥0.0001 + 0.0002 = 0.0003
  assert.ok(Math.abs(mystery.costCny - 0.0003) < 1e-12)
  const kimi = summary.models.find((m) => m.model === 'kimi-k3')
  assert.ok(Math.abs(kimi.costCny - 18.3 * 7) < 1e-9, '汇率 7 生效')
  assert.ok(summary.warnings.every((w) => !w.includes('mystery-9b')), '覆盖后不再提示未计价')
})

test('空缓存：不抛错、全零', () => {
  const summary = buildSummary({ version: 1, indexedAt: 0, sessions: {} }, { range: '7d', nowMs: NOW })
  assert.equal(summary.totals.totalTokens, 0)
  assert.equal(summary.models.length, 0)
  assert.equal(summary.series.keys.length > 0, true)
  assert.equal(summary.series.models.length, 0)
})

test('裸名 k3（Kimi Coding Plan 渠道日志名）按官方刊例计价', () => {
  const cache = {
    version: 1,
    indexedAt: NOW,
    sessions: {
      '--w-kimi--/session-k3': {
        id: 'session-k3', folder: '--w-kimi--', cwd: '/work/kimi', createdAt: null, origin: null,
        modelProviders: { k3: ['kimi-coding'] },
        // $3×2M 输入 + $15×1M 输出 = $21 → ¥151.2（rate 7.2）
        buckets: { '2026-08-18T22': { k3: { i: 2_000_000, c: 0, w: 0, o: 1_000_000, n: 3 } } },
        fp: { mtimeMs: 0, size: 0 },
      },
    },
  }
  const summary = buildSummary(cache, { range: 'all', nowMs: NOW })
  const k3 = summary.models.find((m) => m.model === 'k3')
  assert.equal(k3.priced, true)
  assert.ok(Math.abs(k3.costUsd - 21) < 1e-9)
  assert.ok(Math.abs(k3.costCny - 151.2) < 1e-9)
  assert.equal(k3.priceRules.length, 1)
  assert.equal(k3.priceRules[0].label, 'Kimi K3')
  assert.equal(k3.priceRules[0].requests, 3)
  // 不再出现"未计价"告警，且保留 Kimi 订阅提示。
  assert.ok(summary.warnings.every((w) => !w.includes('k3')))
  assert.ok(summary.pricing.notes.some((n) => n.includes('Kimi Coding Plan')))
  // 序列里 k3 也有曲线（而非因未计价被丢弃）。
  const seriesK3 = summary.series.models.find((m) => m.model === 'k3')
  assert.ok(Math.abs(seriesK3.values.reduce((acc, v) => acc + v.usd, 0) - 21) < 1e-9)
})
