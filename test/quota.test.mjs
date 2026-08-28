/**
 * quota 模块测试：provider 三级识别、zai/kimi 适配器响应解析（fetchImpl 注入）、
 * /quota/all 聚合（fake home + fake 适配器，无真实网络）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchAdapter } from '../lib/quota/shared.js'
import { fetchZaiQuota } from '../lib/quota/adapters/zai.js'
import { fetchKimiQuota } from '../lib/quota/adapters/kimi.js'
import { queryAllQuotas, registerQuotaAdapter, resetQuotaServiceCaches } from '../lib/quota/service.js'
import { resetConfigCache } from '../lib/core/config.js'

const CONFIG = { version: 2, rateUsdCny: 7.2, models: {}, providers: {} }

/* ─────────────────── matchAdapter 三级识别 ─────────────────── */

test('matchAdapter：config 显式映射优先（含 none 关闭）', () => {
  const config = { ...CONFIG, providers: { 'my-glm': { adapter: 'zai' }, off: { adapter: 'none' } } }
  assert.deepEqual(matchAdapter('my-glm', null, config), { adapter: 'zai', reason: 'config' })
  assert.equal(matchAdapter('off', null, config), null)
})

test('matchAdapter：内置 provider id → baseURL 特征 → 未命中', () => {
  assert.deepEqual(matchAdapter('zai-coding-cn', null, CONFIG), { adapter: 'zai', reason: 'builtin' })
  assert.deepEqual(matchAdapter('kimi-code', null, CONFIG), { adapter: 'kimi', reason: 'builtin' })
  // baseURL 特征（自建 provider）
  const route = { provider: 'self-built', baseURL: 'https://api.kimi.com/coding/v1' }
  assert.deepEqual(matchAdapter('self-built', route, CONFIG), { adapter: 'kimi', reason: 'baseurl' })
  const zaiRoute = { provider: 'self-zai', baseURL: 'https://open.bigmodel.cn/api/paas/v4' }
  assert.deepEqual(matchAdapter('self-zai', zaiRoute, CONFIG), { adapter: 'zai', reason: 'baseurl' })
  // 未命中
  assert.equal(matchAdapter('deepseek-official', { provider: 'deepseek-official', baseURL: 'https://api.deepseek.com' }, CONFIG), null)
})

/* ─────────────────── zai 适配器解析 ─────────────────── */

function fakeFetch(body, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

test('fetchZaiQuota：limits 归类为 5h/周/月窗口，套餐标签与排序正确', async () => {
  const body = {
    code: 200,
    data: {
      level: 'pro',
      limits: [
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 1000000, currentValue: 250000, nextResetTime: 1787086062567 },
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 500000, currentValue: 100000, nextResetTime: 1787086062567 },
        { type: 'TIME_LIMIT', unit: 5, usage: 100, currentValue: 3 },
      ],
    },
  }
  const snapshot = await fetchZaiQuota('key', undefined, fakeFetch(body))
  assert.equal(snapshot.adapter, 'zai')
  assert.equal(snapshot.planLabel, 'Pro')
  assert.equal(snapshot.primaryId, '5h')
  assert.deepEqual(snapshot.windows.map((w) => w.id), ['5h', 'weekly', 'monthly-count'])
  assert.equal(snapshot.windows[0].used, 100000)
  assert.equal(snapshot.windows[0].limit, 500000)
  assert.equal(snapshot.windows[2].unit, 'requests')
})

test('fetchZaiQuota：只有 percentage/remaining 时 used 兜底推算', async () => {
  const body = {
    code: 200,
    data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, remaining: 11949 }] },
  }
  const snapshot = await fetchZaiQuota('key', undefined, fakeFetch(body))
  assert.equal(snapshot.windows[0].used, 51)
  assert.equal(snapshot.windows[0].unit, 'credits')
})

/* ─────────────────── kimi 适配器解析 ─────────────────── */

test('fetchKimiQuota：5h 主窗口 + 订阅周期 + 并发/加速包 notes', async () => {
  const body = {
    user: { membership: { level: 'LEVEL_ADVANCED' } },
    usage: { limit: '100', used: '6', remaining: '94', resetTime: '2026-08-24T01:55:32Z' },
    limits: [
      { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '90', resetTime: '2026-08-18T15:55:32Z' } },
    ],
    parallel: { limit: '30' },
    boosterWallet: { balance: { amount: '10000000000', amountLeft: '3823342900' } },
  }
  const snapshot = await fetchKimiQuota('key', undefined, fakeFetch(body))
  assert.equal(snapshot.adapter, 'kimi')
  assert.equal(snapshot.planLabel, '高档')
  assert.equal(snapshot.primaryId, '5h')
  assert.deepEqual(snapshot.windows.map((w) => w.id), ['5h', 'subscription'])
  assert.equal(snapshot.windows[0].used, 10)
  assert.equal(snapshot.windows[1].used, 6)
  assert.ok(snapshot.notes.some((n) => n.includes('并发请求上限 30')))
  assert.ok(snapshot.notes.some((n) => n.includes('加速包余额 38%')))
})

/* ─────────────────── /quota/all 聚合 ─────────────────── */

test('queryAllQuotas：只返回 Coding Plan provider，skipped 计数正确，错误不致命', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-usage-quota-'))
  try {
    await mkdir(join(home, 'plugins', 'dsh-usage'), { recursive: true })
    await writeFile(
      join(home, 'settings.yaml'),
      [
        'llm-pi-ai:',
        '  providers:',
        '    zai-coding-cn:',
        '      displayName: GLM Coding',
        '      apiKeyEnv: ZAI_TEST_KEY',
        '      baseURL: https://open.bigmodel.cn',
        '    deepseek:',
        '      displayName: DeepSeek',
        '      apiKeyEnv: DS_TEST_KEY',
        '      baseURL: https://api.deepseek.com',
        '    kimi-code:',
        '      apiKeyEnv: KIMI_MISSING_KEY',
        '      baseURL: https://api.kimi.com/coding',
        '',
      ].join('\n'),
    )
    await writeFile(join(home, 'plugins', 'dsh-usage', 'config.json'), JSON.stringify({ version: 2, rateUsdCny: 7.2, models: {}, providers: {} }))

    // fake zai 适配器（避免真实网络）；kimi 不注册 fake → 走真实适配器但 key 缺失 → NO_KEY
    process.env.ZAI_TEST_KEY = 'fake-key'
    registerQuotaAdapter('zai', async () => ({
      adapter: 'zai',
      adapterLabel: 'GLM Coding Plan',
      primaryId: '5h',
      windows: [{ id: '5h', label: '5 小时额度', used: 1, limit: 100, unit: 'credits' }],
      fetchedAt: Date.now(),
    }))

    resetConfigCache()
    resetQuotaServiceCaches()
    const result = await queryAllQuotas(true, home)

    assert.equal(result.ok, true)
    assert.equal(result.skipped, 1) // deepseek 未识别
    assert.equal(result.providers.length, 2)

    const zai = result.providers.find((p) => p.provider === 'zai-coding-cn')
    assert.equal(zai.response.ok, true)
    assert.equal(zai.response.snapshot.windows[0].used, 1)
    assert.equal(zai.displayName, 'GLM Coding')

    const kimi = result.providers.find((p) => p.provider === 'kimi-code')
    assert.equal(kimi.response.ok, false)
    assert.equal(kimi.response.error, 'NO_KEY')
  } finally {
    delete process.env.ZAI_TEST_KEY
    await rm(home, { recursive: true, force: true })
  }
})
