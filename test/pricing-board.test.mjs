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

test('Kimi K3 官方美元刊例 / GLM-5.3 官方刊例与轻量档', () => {
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
  assert.equal(glm.entry.estimated, false)

  const flash = resolvePrice('glm-5.3-flash', at('2026-09-30T10:00:00+08:00'))
  assert.equal(flash.entry.currency, 'CNY')
  assert.equal(flash.entry.inputPerMillion, 0.8)
  assert.equal(flash.entry.cacheReadPerMillion, 0.23)
  assert.equal(flash.entry.outputPerMillion, 2.8)
  assert.equal(flash.entry.estimated, false)
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

test('OpenAI GPT-6 系官方刊例 + 缓存写独立价（1.25× 输入）', () => {
  const astra = resolvePrice('gpt-6-astra', at('2026-10-01T10:00:00+08:00'))
  assert.equal(astra.entry.currency, 'USD')
  assert.equal(astra.entry.inputPerMillion, 10)
  assert.equal(astra.entry.cacheReadPerMillion, 1)
  assert.equal(astra.entry.cacheWritePerMillion, 12.5)
  assert.equal(astra.entry.outputPerMillion, 50)
  // 1M in + 1M cacheWrite：10 + 12.5 = 22.5（若按输入价会低估为 20）。
  const cost = costOf({ input: 1_000_000, cacheRead: 0, cacheWrite: 1_000_000, output: 0 }, astra, 7.2)
  assert.ok(Math.abs(cost.usd - 22.5) < 1e-9)

  const sol = resolvePrice('gpt-6.1-sol', at('2026-10-01T10:00:00+08:00'))
  assert.equal(sol.entry.inputPerMillion, 2)
  assert.equal(sol.entry.cacheReadPerMillion, 0.1)
  assert.equal(sol.entry.cacheWritePerMillion, 2.5)
  assert.equal(sol.entry.outputPerMillion, 10)

  const luna = resolvePrice('gpt-6-luna', at('2026-10-01T10:00:00+08:00'))
  assert.equal(luna.entry.inputPerMillion, 0.1)
  assert.equal(luna.entry.cacheWritePerMillion, 0.125)
  assert.equal(luna.entry.outputPerMillion, 0.5)
})

test('OpenAI Codex / 上一代 gpt-5.2 / chat-latest', () => {
  assert.equal(matchRuleKey('gpt-5.3-codex'), 'gpt-5.3-codex')
  const codex = resolvePrice('gpt-5.3-codex', at('2026-10-01T10:00:00+08:00'))
  assert.equal(codex.entry.inputPerMillion, 1.75)
  assert.equal(codex.entry.cacheReadPerMillion, 0.175)
  assert.equal(codex.entry.outputPerMillion, 14)
  assert.equal(codex.entry.cacheWritePerMillion, undefined) // 无独立价 → 按输入价
  const codexCost = costOf({ input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 }, codex, 7.2)
  assert.ok(Math.abs(codexCost.usd - 1.75) < 1e-9)

  assert.equal(matchRuleKey('gpt-5.2'), 'gpt-5.2')
  assert.equal(matchRuleKey('gpt-5.2-codex'), 'gpt-5.2') // 别名
  assert.equal(matchRuleKey('gpt-5.2-codex-max'), 'gpt-5.2') // 别名前缀
  const old = resolvePrice('gpt-5.2', at('2026-06-01T10:00:00+08:00'))
  assert.equal(old.entry.inputPerMillion, 1.75)
  assert.equal(old.entry.outputPerMillion, 14)

  const latest = resolvePrice('chat-latest', at('2026-10-01T10:00:00+08:00'))
  assert.equal(latest.entry.inputPerMillion, 5)
  assert.equal(latest.entry.outputPerMillion, 30)
})

test('Anthropic Claude 系官方刊例 + 目录顺序（opus-5-5 先于 opus-5）', () => {
  const fable = resolvePrice('claude-fable-5', at('2026-10-01T10:00:00+08:00'))
  assert.equal(fable.entry.inputPerMillion, 10)
  assert.equal(fable.entry.cacheReadPerMillion, 1)
  assert.equal(fable.entry.cacheWritePerMillion, 12.5)
  assert.equal(fable.entry.outputPerMillion, 50)

  // Opus 5.5：缓存读 5%（$0.20），不能被 opus-5 前缀抢占。
  assert.equal(matchRuleKey('claude-opus-5-5'), 'claude-opus-5-5')
  assert.equal(matchRuleKey('claude-opus-5-5-20260210'), 'claude-opus-5-5')
  const opus55 = resolvePrice('claude-opus-5-5', at('2026-10-01T10:00:00+08:00'))
  assert.equal(opus55.entry.inputPerMillion, 4)
  assert.equal(opus55.entry.cacheReadPerMillion, 0.2)
  assert.equal(opus55.entry.cacheWritePerMillion, 5)
  assert.equal(opus55.entry.outputPerMillion, 20)

  // Opus 5 的日期快照 id：前缀命中 opus-5（而非 opus-5-5）。
  assert.equal(matchRuleKey('claude-opus-5-20251122'), 'claude-opus-5')
  const opus5 = resolvePrice('claude-opus-5', at('2026-10-01T10:00:00+08:00'))
  assert.equal(opus5.entry.inputPerMillion, 5)
  assert.equal(opus5.entry.cacheReadPerMillion, 0.5)
  assert.equal(opus5.entry.cacheWritePerMillion, 6.25)
  assert.equal(opus5.entry.outputPerMillion, 25)

  const sonnet = resolvePrice('claude-sonnet-5-20260210', at('2026-10-01T10:00:00+08:00'))
  assert.equal(sonnet.ruleKey, 'claude-sonnet-5')
  assert.equal(sonnet.entry.inputPerMillion, 2)
  assert.equal(sonnet.entry.cacheReadPerMillion, 0.2)
  assert.equal(sonnet.entry.cacheWritePerMillion, 2.5)
  assert.equal(sonnet.entry.outputPerMillion, 10)

  const haiku = resolvePrice('claude-haiku-4-5', at('2026-10-01T10:00:00+08:00'))
  assert.equal(haiku.entry.inputPerMillion, 1)
  assert.equal(haiku.entry.cacheReadPerMillion, 0.1)
  assert.equal(haiku.entry.cacheWritePerMillion, 1.25)
  assert.equal(haiku.entry.outputPerMillion, 5)

  // Anthropic 费用公式：sonnet 1M in + 1M write + 1M read + 1M out = 2 + 2.5 + 0.2 + 10。
  const cost = costOf({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 }, sonnet, 7.2)
  assert.ok(Math.abs(cost.usd - 14.7) < 1e-9)
})

test('小米 MiMo 官方刊例（国内人民币）+ v2.5 别名 + ultraspeed 顺序', () => {
  const pro = resolvePrice('mimo-v2.6-pro', at('2026-10-01T10:00:00+08:00'))
  assert.equal(pro.entry.currency, 'CNY')
  assert.equal(pro.entry.inputPerMillion, 3)
  assert.equal(pro.entry.cacheReadPerMillion, 0.025)
  assert.equal(pro.entry.outputPerMillion, 6)
  assert.equal(pro.entry.cacheWritePerMillion, undefined) // 限时免费 → 按输入价

  // v2.5 系（2026-10-21 下线）同价，经别名命中。
  assert.equal(matchRuleKey('mimo-v2.5-pro'), 'mimo-v2.6-pro')
  assert.equal(matchRuleKey('mimo-v2.5'), 'mimo-v2.6-flash')
  const legacy = resolvePrice('mimo-v2.5-pro', at('2026-09-01T10:00:00+08:00'))
  assert.equal(legacy.ruleKey, 'mimo-v2.6-pro')
  assert.equal(legacy.entry.inputPerMillion, 3)

  // ultraspeed 是 pro 的前缀超集，必须先命中。
  assert.equal(matchRuleKey('mimo-v2.6-pro-ultraspeed'), 'mimo-v2.6-pro-ultraspeed')
  const ultra = resolvePrice('mimo-v2.6-pro-ultraspeed', at('2026-10-01T10:00:00+08:00'))
  assert.equal(ultra.entry.inputPerMillion, 30)
  assert.equal(ultra.entry.cacheReadPerMillion, 0.25)
  assert.equal(ultra.entry.outputPerMillion, 60)

  const flash = resolvePrice('mimo-v2.6-flash', at('2026-10-01T10:00:00+08:00'))
  assert.equal(flash.entry.inputPerMillion, 1)
  assert.equal(flash.entry.cacheReadPerMillion, 0.02)
  assert.equal(flash.entry.outputPerMillion, 2)
})

test('用户覆盖可带 cacheWritePerMillion；目录视图透出', () => {
  const config = {
    version: 2,
    rateUsdCny: DEFAULT_RATE_USD_CNY,
    models: {
      'my-openai-model': { currency: 'USD', inputPerMillion: 2, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5, outputPerMillion: 10 },
    },
  }
  const priv = resolvePrice('my-openai-model', at('2026-10-01T10:00:00+08:00'), config)
  assert.equal(priv.entry.cacheWritePerMillion, 2.5)
  const cost = costOf({ input: 1_000_000, cacheRead: 0, cacheWrite: 2_000_000, output: 0 }, priv, 7.2)
  assert.ok(Math.abs(cost.usd - 7) < 1e-9) // 2 + 2×2.5

  const catalog = pricingCatalog(config)
  const privEntry = catalog.find((e) => e.model === 'my-openai-model')
  assert.equal(privEntry.eras[0].cacheWritePerMillion, 2.5)
  const astraEntry = catalog.find((e) => e.model === 'gpt-6-astra')
  assert.equal(astraEntry.eras[0].cacheWritePerMillion, 12.5)
  const glmEntry = catalog.find((e) => e.model === 'glm-5.3')
  assert.equal(glmEntry.eras[0].cacheWritePerMillion, undefined)
})

test('未知模型返回 null；带日期后缀的模型按前缀匹配', () => {
  assert.equal(resolvePrice('gpt-99', at('2026-08-18T10:00:00+08:00')), null)
  assert.equal(resolvePrice('', at('2026-08-18T10:00:00+08:00')), null)
  assert.equal(matchRuleKey('deepseek-v4-pro-0813'), 'deepseek-v4-pro')
  assert.equal(matchRuleKey('DeepSeek-V4-Flash'), 'deepseek-v4-flash')
  const suffixed = resolvePrice('deepseek-v4-pro-0813', at('2026-08-18T15:00:00+08:00'))
  assert.equal(suffixed.entry.inputPerMillion, 9.0)
})

test('DeepSeek V4.1 Flash（deepseek-flash）：峰时仅工作日、不含法定节假日', () => {
  const at10 = (iso) => resolvePrice('deepseek-flash', at(iso))
  // 工作日峰时段 → 峰价（2026-10-08 周四 10:00）。
  const peak = at10('2026-10-08T10:00:00+08:00')
  assert.equal(peak.ruleKey, 'deepseek-flash')
  assert.equal(peak.entry.peak, true)
  assert.equal(peak.entry.inputPerMillion, 2)
  assert.equal(peak.entry.cacheReadPerMillion, 0.04)
  assert.equal(peak.entry.outputPerMillion, 8)
  // 国庆法定节假日（2026-10-01 周四）同一时段 → 谷价。
  const holiday = at10('2026-10-01T10:00:00+08:00')
  assert.equal(holiday.entry.peak, false)
  assert.equal(holiday.entry.inputPerMillion, 1)
  // 周末（2026-10-03 周六）峰时段 → 谷价；工作日晚间（2026-10-08 周四 20:00）→ 谷价。
  assert.equal(at10('2026-10-03T10:00:00+08:00').entry.peak, false)
  assert.equal(at10('2026-10-08T20:00:00+08:00').entry.peak, false)
  // 中秋（2026-09-25 周五）峰时段 → 谷价。
  assert.equal(at10('2026-09-25T10:00:00+08:00').entry.peak, false)
  // 调休上班的周六（2026-10-10）→ 按官方「周一至五」字面口径仍谷时。
  assert.equal(at10('2026-10-10T10:00:00+08:00').entry.peak, false)
  // 谷价数值：输入 ¥1 / 缓存 ¥0.02 / 输出 ¥4。
  const offpeak = at10('2026-10-03T10:00:00+08:00')
  assert.equal(offpeak.entry.inputPerMillion, 1)
  assert.equal(offpeak.entry.cacheReadPerMillion, 0.02)
  assert.equal(offpeak.entry.outputPerMillion, 4)
})

test('V4 系峰谷不受工作日/节假日口径影响（每日峰谷，回归保护）', () => {
  // 节假日（2026-10-01 周四）与周日（2026-09-20）的峰时段，V4 Flash 仍为峰价。
  assert.equal(resolvePrice('deepseek-v4-flash', at('2026-10-01T10:00:00+08:00')).entry.peak, true)
  assert.equal(resolvePrice('deepseek-v4-flash', at('2026-09-20T10:00:00+08:00')).entry.peak, true)
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
