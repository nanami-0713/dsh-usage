/**
 * 计价核心测试：模型目录命中（精确/别名/前缀）、时代 × 峰谷解析、
 * 多币种折算、逐模型小时桶聚合（含未收录模型与时代边界跨越）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_EXCHANGE_RATE,
  MODEL_RULES,
  beijingHourOf,
  costOf,
  isPeakHour,
  matchRuleKey,
  priceSessionUsage,
  resolvePrice,
} from '../lib/core/pricing.js'

const T_PEAK = Date.parse('2026-08-18T10:00:00+08:00') // 北京周二 10 点 → 高峰
const T_OFFPEAK = Date.parse('2026-08-18T20:00:00+08:00') // 北京 20 点 → 空闲
const T_PRE_ERA = Date.parse('2026-08-16T10:00:00+08:00') // 涨价前（统一价）

test('beijingHourOf / isPeakHour 按北京时区判定', () => {
  assert.equal(beijingHourOf(T_PEAK), 10)
  assert.equal(beijingHourOf(T_OFFPEAK), 20)
  assert.equal(isPeakHour(new Date(T_PEAK)), true)
  assert.equal(isPeakHour(new Date(T_OFFPEAK)), false)
})

test('matchRuleKey：精确 → 别名 → 前缀', () => {
  assert.equal(matchRuleKey('deepseek-v4-flash'), 'deepseek-v4-flash')
  assert.equal(matchRuleKey(' DeepSeek-V4-Pro '), 'deepseek-v4-pro')
  assert.equal(matchRuleKey('k3'), 'kimi-k3')
  assert.equal(matchRuleKey('k3-256k'), 'kimi-k3')
  assert.equal(matchRuleKey('kimi-k3'), 'kimi-k3')
  assert.equal(matchRuleKey('glm-5.3'), 'glm-5.3')
  assert.equal(matchRuleKey('deepseek-v4-pro-0813'), 'deepseek-v4-pro')
  assert.equal(matchRuleKey('totally-unknown'), null)
  assert.equal(matchRuleKey(undefined), null)
  assert.equal(matchRuleKey(''), null)
})

test('resolvePrice：DeepSeek 分时 × 时代', () => {
  const peak = resolvePrice('deepseek-v4-flash', T_PEAK)
  assert.deepEqual(
    { label: peak?.label, currency: peak?.entry.currency, input: peak?.entry.inputPerMillion, cacheRead: peak?.entry.cacheReadPerMillion, output: peak?.entry.outputPerMillion, peakFlag: peak?.entry.peak, estimated: peak?.entry.estimated },
    { label: 'DeepSeek V4 Flash', currency: 'CNY', input: 3.0, cacheRead: 0.1, output: 9.0, peakFlag: true, estimated: false },
  )

  const offpeak = resolvePrice('deepseek-v4-flash', T_OFFPEAK)
  assert.equal(offpeak?.entry.inputPerMillion, 1.5)
  assert.equal(offpeak?.entry.cacheReadPerMillion, 0.05)
  assert.equal(offpeak?.entry.outputPerMillion, 4.5)
  assert.equal(offpeak?.entry.peak, false)

  // 涨价前（2026-08-17 之前）：不分时统一价。
  const preEra = resolvePrice('deepseek-v4-flash', T_PRE_ERA)
  assert.equal(preEra?.entry.inputPerMillion, 1.0)
  assert.equal(preEra?.entry.cacheReadPerMillion, 0.02)
  assert.equal(preEra?.entry.outputPerMillion, 2.0)
  assert.equal(preEra?.entry.peak, null)

  const proPeak = resolvePrice('deepseek-v4-pro', T_PEAK)
  assert.equal(proPeak?.entry.inputPerMillion, 9.0)
  assert.equal(proPeak?.entry.outputPerMillion, 27.0)
})

test('resolvePrice：Kimi 美元刊例与 GLM 估算价', () => {
  const kimi = resolvePrice('k3', T_PEAK)
  assert.equal(kimi?.entry.currency, 'USD')
  assert.equal(kimi?.entry.inputPerMillion, 3.0)
  assert.equal(kimi?.entry.cacheReadPerMillion, 0.3)
  assert.equal(kimi?.entry.outputPerMillion, 15.0)
  assert.equal(kimi?.entry.peak, null)

  const glm = resolvePrice('glm-5.3', T_PEAK)
  assert.equal(glm?.entry.currency, 'CNY')
  assert.equal(glm?.entry.inputPerMillion, 8)
  assert.equal(glm?.entry.outputPerMillion, 28)
  assert.equal(glm?.entry.estimated, true)

  assert.equal(resolvePrice('no-such-model', T_PEAK), null)
})

test('costOf：缓存写入按输入单价、美元按汇率折算', () => {
  const flashPeak = resolvePrice('deepseek-v4-flash', T_PEAK)
  assert.ok(flashPeak)
  // input 1M + cacheWrite 0.5M 按输入 3.0；cacheRead 1M × 0.1；output 1M × 9 → 13.6 ¥
  const cny = costOf({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 500_000, output: 1_000_000 }, flashPeak)
  assert.equal(Math.round(cny.cny * 1000) / 1000, 13.6)
  assert.equal(Math.round(cny.usd * 10000) / 10000, Math.round((13.6 / DEFAULT_EXCHANGE_RATE) * 10000) / 10000)

  const kimi = resolvePrice('kimi-k3', T_PEAK)
  assert.ok(kimi)
  // (1M+0.5M)×3 + 1M×0.3 + 1M×15 = 19.8 USD → ×7.2 = 142.56 ¥
  const usdNative = costOf({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 500_000, output: 1_000_000 }, kimi)
  assert.equal(Math.round(usdNative.usd * 100) / 100, 19.8)
  assert.equal(Math.round(usdNative.cny * 100) / 100, 142.56)
})

test('priceSessionUsage：多模型分段计费 + 未收录模型只计量不计费', () => {
  const M = 1_000_000
  const summary = priceSessionUsage([
    {
      model: 'deepseek-v4-flash',
      provider: 'deepseek-official',
      hours: [
        { ts: T_PEAK, input: M, cacheRead: 0, cacheWrite: 0, output: M, requests: 1 }, // 高峰 3+9 = 12 ¥
        { ts: T_OFFPEAK, input: M, cacheRead: 0, cacheWrite: 0, output: M, requests: 1 }, // 空闲 1.5+4.5 = 6 ¥
      ],
    },
    {
      model: 'glm-5.3',
      provider: 'zai-coding-cn',
      hours: [{ ts: T_PEAK, input: M, cacheRead: M, cacheWrite: 0, output: M, requests: 1 }], // 8+2+28 = 38 ¥
    },
    {
      model: 'mystery-model',
      provider: null,
      hours: [{ ts: T_PEAK, input: 100, cacheRead: 0, cacheWrite: 0, output: 100, requests: 1 }], // 未收录
    },
  ])

  assert.equal(summary.lines.length, 3)
  assert.equal(Math.round(summary.totalCny * 100) / 100, 56) // 12 + 6 + 38
  assert.equal(summary.unmatchedTokens, 200)
  assert.equal(summary.hasEstimated, true)

  const flash = summary.lines.find((l) => l.model === 'deepseek-v4-flash')
  assert.ok(flash)
  assert.equal(flash.label, 'DeepSeek V4 Flash')
  assert.equal(flash.requests, 2)
  assert.equal(Math.round(flash.costCny * 100) / 100, 18)

  const mystery = summary.lines.find((l) => l.model === 'mystery-model')
  assert.ok(mystery)
  assert.equal(mystery.label, null)
  assert.equal(mystery.costCny, 0)
})

test('priceSessionUsage：同一模型跨时代分桶计价', () => {
  const M = 1_000_000
  const summary = priceSessionUsage([
    {
      model: 'deepseek-v4-pro',
      provider: 'deepseek-official',
      hours: [
        { ts: T_PRE_ERA, input: M, cacheRead: 0, cacheWrite: 0, output: M, requests: 1 }, // 统一价 3+6 = 9
        { ts: T_PEAK, input: M, cacheRead: 0, cacheWrite: 0, output: M, requests: 1 }, // 高峰 9+27 = 36
      ],
    },
  ])
  assert.equal(summary.lines.length, 1)
  assert.equal(Math.round(summary.totalCny * 100) / 100, 45)
})

test('MODEL_RULES：eras 按 sinceMs 升序、DeepSeek 挂峰谷双条目', () => {
  for (const rule of MODEL_RULES) {
    const sinces = rule.eras.map((e) => e.sinceMs ?? -1)
    for (let i = 1; i < sinces.length; i += 1) assert.ok(sinces[i - 1] <= sinces[i], `${rule.key} eras 未按 sinceMs 升序`)
  }
  for (const key of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    const rule = MODEL_RULES.find((r) => r.key === key)
    assert.ok(rule)
    const eraSince = rule.eras.find((e) => e.sinceMs !== null)?.sinceMs ?? null
    const peaks = rule.eras.filter((e) => e.sinceMs === eraSince && e.sinceMs !== null).map((e) => e.peak)
    assert.ok(peaks.includes(true) && peaks.includes(false), `${key} 涨价后应同时挂高峰/空闲两条`)
  }
})
