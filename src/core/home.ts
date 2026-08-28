/**
 * @hsinsekai-nanami/dsh-usage — 本机路径工具（host 侧，core 内核）。
 *
 * 统一三个前身插件（dsh-token-cost / dsh-usage-board / dsh-quota-visor）
 * 各自复制一份的 dshHomeDir / sessionsDir / pluginDataDir。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHomeDir(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function sessionsDir(home = dshHomeDir()): string {
  return join(home, 'sessions')
}

/** 本插件的数据目录（config.json / cache.json 落盘处）。 */
export function pluginDataDir(home = dshHomeDir()): string {
  return join(home, 'plugins', 'dsh-usage')
}

/** 前身插件的数据目录（迁移来源，只读 + 重命名标记，不删除）。 */
export function legacyDataDirs(home = dshHomeDir()): { board: string; visor: string } {
  return {
    board: join(home, 'plugins', 'dsh-usage-board'),
    visor: join(home, 'plugins', 'dsh-quota-visor'),
  }
}
