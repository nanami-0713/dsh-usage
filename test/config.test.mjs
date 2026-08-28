/**
 * 统一配置与旧配置迁移测试：v1×2 → v2 合并、幂等、旧文件改名保留、
 * 索引缓存复制（不移动）、v1 视图双向转换。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  boardConfigView,
  mergeBoardConfig,
  mergeVisorConfig,
  migrateLegacyConfigs,
  normalizeUsageConfig,
  resetConfigCache,
  visorConfigView,
} from '../lib/core/config.js'

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-usage-config-'))
  await mkdir(join(home, 'plugins', 'dsh-usage-board'), { recursive: true })
  await mkdir(join(home, 'plugins', 'dsh-quota-visor'), { recursive: true })
  return home
}

test('迁移：两个旧配置合并进 v2，旧文件改名保留，缓存复制不移动', async () => {
  const home = await makeHome()
  try {
    await writeFile(
      join(home, 'plugins', 'dsh-usage-board', 'config.json'),
      JSON.stringify({ version: 1, rateUsdCny: 7.0, models: { 'my-model': { currency: 'CNY', inputPerMillion: 1, cacheReadPerMillion: 0.1, outputPerMillion: 2 } } }),
    )
    await writeFile(join(home, 'plugins', 'dsh-usage-board', 'cache.json'), JSON.stringify({ version: 1, sessions: { 'f/s': { id: 's' } }, indexedAt: 1 }))
    await writeFile(
      join(home, 'plugins', 'dsh-quota-visor', 'config.json'),
      JSON.stringify({ version: 1, providers: { 'my-glm': { adapter: 'zai' } }, refreshMs: 30_000 }),
    )

    resetConfigCache()
    const report = await migrateLegacyConfigs(home)
    assert.equal(report.migrated, true)
    assert.equal(report.boardConfig, true)
    assert.equal(report.visorConfig, true)
    assert.equal(report.boardCacheCopied, true)

    const merged = JSON.parse(await readFile(join(home, 'plugins', 'dsh-usage', 'config.json'), 'utf8'))
    assert.equal(merged.version, 2)
    assert.equal(merged.rateUsdCny, 7.0)
    assert.equal(merged.models['my-model'].inputPerMillion, 1)
    assert.equal(merged.providers['my-glm'].adapter, 'zai')
    assert.equal(merged.refreshMs, 30_000)

    // 旧文件改名保留（不删除）
    const boardMigrated = JSON.parse(await readFile(join(home, 'plugins', 'dsh-usage-board', 'config.migrated.json'), 'utf8'))
    assert.equal(boardMigrated.version, 1)
    const visorMigrated = JSON.parse(await readFile(join(home, 'plugins', 'dsh-quota-visor', 'config.migrated.json'), 'utf8'))
    assert.equal(visorMigrated.version, 1)

    // 缓存是【复制】：旧位置仍在
    const legacyCache = JSON.parse(await readFile(join(home, 'plugins', 'dsh-usage-board', 'cache.json'), 'utf8'))
    assert.equal(legacyCache.version, 1)
    const newCache = JSON.parse(await readFile(join(home, 'plugins', 'dsh-usage', 'cache.json'), 'utf8'))
    assert.equal(newCache.version, 1)

    // 幂等：第二次迁移直接返回（已是 v2）
    resetConfigCache()
    const again = await migrateLegacyConfigs(home)
    assert.equal(again.migrated, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('迁移：没有任何旧文件时不产生新配置', async () => {
  const home = await makeHome()
  try {
    resetConfigCache()
    const report = await migrateLegacyConfigs(home)
    assert.equal(report.migrated, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('normalizeUsageConfig：非法字段全部落回默认', () => {
  const config = normalizeUsageConfig({ rateUsdCny: -1, models: { bad: { inputPerMillion: 'x' } }, providers: { p: { adapter: '' } }, refreshMs: 5 })
  assert.equal(config.rateUsdCny, 7.2)
  assert.deepEqual(config.models, {})
  assert.deepEqual(config.providers, {})
  assert.equal(config.refreshMs, 10_000) // refreshMs 取钳制而非丢弃（与前 visor 行为一致）
})

test('v1 视图双向转换：board 子集与 visor 子集互不干扰', () => {
  const base = normalizeUsageConfig({
    rateUsdCny: 7.0,
    models: { m: { currency: 'CNY', inputPerMillion: 1, cacheReadPerMillion: 0.1, outputPerMillion: 2 } },
    providers: { p: { adapter: 'kimi' } },
    refreshMs: 30_000,
  })

  const boardView = boardConfigView(base)
  assert.equal(boardView.version, 1)
  assert.equal(boardView.rateUsdCny, 7.0)
  assert.deepEqual(boardView.models, base.models)

  const visorView = visorConfigView(base)
  assert.equal(visorView.version, 1)
  assert.deepEqual(visorView.providers, base.providers)
  assert.equal(visorView.refreshMs, 30_000)

  // board PUT 只动 models/rateUsdCny，providers 不动
  const afterBoard = mergeBoardConfig(base, { version: 1, rateUsdCny: 6.5, models: {} })
  assert.equal(afterBoard.rateUsdCny, 6.5)
  assert.deepEqual(afterBoard.models, {})
  assert.deepEqual(afterBoard.providers, base.providers)
  assert.equal(afterBoard.refreshMs, 30_000)

  // visor PUT 只动 providers/refreshMs，models 不动
  const afterVisor = mergeVisorConfig(base, { version: 1, providers: { q: { adapter: 'zai' } }, refreshMs: 20_000 })
  assert.deepEqual(afterVisor.providers, { q: { adapter: 'zai' } })
  assert.equal(afterVisor.refreshMs, 20_000)
  assert.deepEqual(afterVisor.models, base.models)
})
