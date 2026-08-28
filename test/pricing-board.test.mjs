/**
 * 计价规则单元测试：时代分界、峰谷时段、多币种、覆盖配置、费用公式。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEEPSEEK_TIME_OF_USE_SINCE_MS,
  DEFAULT_RATE_USD_CNY,
  beijingHourOf,
  costOf,
  dayKeyOf,
  hourKeyOf,
  matchRuleKey,
  resolvePrice,
  pricingCatalog,
  DEFAULT_CONFIG,
} from '../lib/core/pricing.js'

const at = (iso) => Date.parse(iso)

test('DeepSeek 涨价时代分界：2026-08-17 00:00 北京时间', () => {
  assert.equal(DEEPSEEK_TIME_OF_USE_SINCE_MS, at('2026-08-17T00:00:00+08:00'))
  // 涨价前：高峰小时也用统一价。
  const before = resolvePrice('deepseek-v4-flash', at('2026-08-16T23:59:59+08:00'))
  assert.equal(before.entry.inputPerMillion, 1.0)
  assert.equal(before.entry.cacheReadPerMillion, 0.02)
  assert.equal(before.entry.outputPerMillion, 2.0)
  assert.equal(before.entry.peak, null)
  // 涨价后第一时间桶：凌晨 = 空闲价。
  const after = resolvePrice('deepseek-v4-flash', at('2026-08-17T00:00:00+08:00'))
  assert.equal(after.entry.inputPerMillion, 1.5)
  assert.equal(after.entry.peak, false)
})

test('DeepSeek 峰谷时段（北京 9-12、14-18 为高峰）', () => {
  const flash = (iso) => resolvePrice('deepseek-v4-flash', at(iso))
  assert.equal(flash('2026-08-18T08:59:59+08:00').entry.peak, false)
  assert.equal(flash('2026-08-18T09:00:00+08:00').entry.peak, true)
  assert.equal(flash('2026-08-18T11:59:59+08:00').entry.peak, true)
  assert.equal(flash('2026-08-18T12:00:00+08:00').entry.peak, false)
  assert.equal(flash('2026-08-18T14:00:00+08:00').entry.peak, true)
  assert.equal(flash('2026-08-18T17:59:59+08:00').entry.peak, true)
  assert.equal(flash('2026-08-18T18:00:00+08:00').entry.peak, false)
  assert.equal(flash('2026-08-18T10:00:00+08:00').entry.inputPerMillion, 3.0)
  assert.equal(flash('2026-08-18T13:00:00+08:00').entry.inputPerMillion, 1.5)

  const pro = resolvePrice('deepseek-v4-pro', at('2026-08-18T15:30:00+08:00'))
  assert.equal(pro.entry.inputPerMillion, 9.0)
  assert.equal(pro.entry.cacheReadPerMillion, 0.30)
  assert.equal(pro.entry.outputPerMillion, 27.0)
  const proOff = resolvePrice('deepseek-v4-pro', at('2026-08-18T19:30:00+08:00'))
  assert.equal(proOff.entry.inputPerMillion, 4.5)
  assert.equal(proOff.entry.outputPerMillion, 13.5)
})

test('Kimi K3 官方美元刊例 / GLM-5.3 同基座估算', () => {
  const kimi = resolvePrice('kimi-k3', at('2026-08-18T10:00:00+08:00'))
  assert.equal(kimi.entry.currency, 'USD')
  assert.equal(kimi.entry.inputPerMillion, 3.0)
  assert.equal(kimi.entry.cacheReadPerMillion, 0.3)
  assert.equal(kimi.entry.outputPerMillion, 15.0)
  assert.equal(kimi.entry.estimated, false)

  const glm = resolvePrice('glm-5.3', at('2026-08-18T10:00:00+08:00'))
  assert.equal(glm.entry.currency, 'CNY')
  assert.equal(glm.entry.inputPerMillion, 8)
  assert.equal(glm.entry.cacheReadPerMillion, 2)
  assert.equal(glm.entry.outputPerMillion, 28)
  assert.equal(glm.entry.estimated, true)
})

test('Kimi K3 裸名别名 k3（Coding Plan 渠道日志名）命中同一规则', () => {
  assert.equal(matchRuleKey('k3'), 'kimi-k3')
  assert.equal(matchRuleKey('K3'), 'kimi-k3')
  assert.equal(matchRuleKey('k3-0905'), 'kimi-k3')
  const bare = resolvePrice('k3', at('2026-08-18T10:00:00+08:00'))
  assert.equal(bare.ruleKey, 'kimi-k3')
  assert.equal(bare.label, 'Kimi K3')
  assert.equal(bare.entry.currency, 'USD')
  assert.equal(bare.entry.inputPerMillion, 3.0)
  assert.equal(bare.entry.outputPerMillion, 15.0)
  // 别名不应误伤无关模型。
  assert.equal(matchRuleKey('k30'), null)
  assert.equal(matchRuleKey('gpt-5'), null)
})

test('未知模型返回 null；带日期后缀的模型按前缀匹配', () => {
  assert.equal(resolvePrice('gpt-99', at('2026-08-18T10:00:00+08:00')), null)
  assert.equal(resolvePrice('', at('2026-08-18T10:00:00+08:00')), null)
  assert.equal(matchRuleKey('deepseek-v4-pro-0813'), 'deepseek-v4-pro')
  assert.equal(matchRuleKey('DeepSeek-V4-Flash'), 'deepseek-v4-flash')
  const suffixed = resolvePrice('deepseek-v4-pro-0813', at('2026-08-18T15:00:00+08:00'))
  assert.equal(suffixed.entry.inputPerMillion, 9.0)
})

test('用户覆盖优先于内置目录', () => {
  const config = {
    version: 1,
    rateUsdCny: DEFAULT_RATE_USD_CNY,
    models: {
      'glm-5.3': { currency: 'CNY', inputPerMillion: 9, cacheReadPerMillion: 2.5, outputPerMillion: 30, source: '官方公布后覆盖' },
      'my-private-model': { currency: 'USD', inputPerMillion: 1, cacheReadPerMillion: 0.1, outputPerMillion: 2 },
    },
  }
  const glm = resolvePrice('glm-5.3', at('2026-08-18T10:00:00+08:00'), config)
  assert.equal(glm.overridden, true)
  assert.equal(glm.entry.inputPerMillion, 9)
  assert.equal(glm.entry.estimated, false)
  assert.equal(glm.entry.source, '官方公布后覆盖')
  const priv = resolvePrice('my-private-model', at('2026-08-18T10:00:00+08:00'), config)
  assert.equal(priv.entry.currency, 'USD')
  const catalog = pricingCatalog(config)
  const glmEntry = catalog.find((e) => e.model === 'glm-5.3')
  assert.equal(glmEntry.overridden, true)
  const privEntry = catalog.find((e) => e.model === 'my-private-model')
  assert.ok(privEntry !== undefined)
})

test('费用公式：输入/缓存读/输出分开计价，缓存写按输入价', () => {
  const price = resolvePrice('deepseek-v4-flash', at('2026-08-18T10:00:00+08:00')) // 高峰
  const cost = costOf({ input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 0, output: 500_000 }, price, 7.2)
  // 1M×3.0 + 2M×0.10 + 0.5M×9.0 = 3 + 0.2 + 4.5 = 7.7 元
  assert.ok(Math.abs(cost.cny - 7.7) < 1e-9)
  assert.ok(Math.abs(cost.usd - 7.7 / 7.2) < 1e-9)

  const withWrite = costOf({ input: 1_000_000, cacheRead: 0, cacheWrite: 1_000_000, output: 0 }, price, 7.2)
  assert.ok(Math.abs(withWrite.cny - 6.0) < 1e-9) // 写缓存 2M tokens 均按 3.0/M

  const era1 = resolvePrice('deepseek-v4-flash', at('2026-08-15T10:00:00+08:00'))
  const oldCost = costOf({ input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 0, output: 500_000 }, era1, 7.2)
  assert.ok(Math.abs(oldCost.cny - 2.04) < 1e-9) // 1 + 0.04 + 1.0

  const kimi = resolvePrice('kimi-k3', at('2026-08-18T10:00:00+08:00'))
  const kimiCost = costOf({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 }, kimi, 7.2)
  assert.ok(Math.abs(kimiCost.usd - 18.3) < 1e-9)
  assert.ok(Math.abs(kimiCost.cny - 18.3 * 7.2) < 1e-9)
})

test('北京时区 key 格式化', () => {
  // UTC 2026-08-18 06:30 = 北京 14:30。
  assert.equal(hourKeyOf(Date.UTC(2026, 7, 18, 6, 30)), '2026-08-18T14')
  assert.equal(dayKeyOf(Date.UTC(2026, 7, 18, 6, 30)), '2026-08-18')
  assert.equal(beijingHourOf(Date.UTC(2026, 7, 18, 15, 0)), 23) // UTC 15 = 北京 23
  assert.equal(hourKeyOf(Date.UTC(2026, 7, 18, 15, 0)), '2026-08-18T23')
  assert.equal(hourKeyOf(Date.UTC(2026, 7, 18, 16, 0)), '2026-08-19T00') // UTC 16 = 北京次日 0 点
  assert.equal(DEFAULT_CONFIG.rateUsdCny, 7.2)
})
