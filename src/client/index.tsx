/**
 * @dsh-external/dsh-usage — client half（统一入口）。
 *
 * 一个 effect 注册三个 UI 面，构成完整 Token 消耗体系：
 *   - conversation.session.header.actions    左徽标：实时费用（SessionBadge）
 *   - conversation.session.header.utilities  右徽标：订阅额度（QuotaBadge）
 *   - settings.section                       用量看板：全局账单 + 订阅额度区块（UsageBoardSection）
 */
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { PLUGIN_ID } from '../core/pricing'
import { BOARD_CSS, UsageBoardSection } from './board-page'
import { QuotaBadge, QUOTA_BADGE_CSS, createFetchQuota, type ModelSelectionInfo } from './quota-badge'
import { createFetchUsage, SessionBadge, SESSION_BADGE_CSS, type DirectoryStore } from './session-badge'
import { DEFAULT_REFRESH_MS } from '../quota/shared'

interface ClientContext {
  effect(fn: () => (() => void) | void, label?: string): void
  slots: {
    inject(slot: string, factory: () => unknown): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  connection: ConnectionHandle
  modelDirectories: {
    directoryFor(sessionId: string): {
      store: DirectoryStore
      load(): Promise<unknown>
    }
  }
}

export const inject = ['slots', 'connection', 'modelDirectories']

export function apply(ctx: ClientContext): void {
  const fetchUsage = createFetchUsage()
  const fetchQuota = createFetchQuota()

  const getSelection = async (sessionId: string): Promise<ModelSelectionInfo | undefined> => {
    try {
      const response = await ctx.connection.api.sessions.models({ sessionId: sessionId as SessionId })
      if (!response.result.ok) return undefined
      return {
        provider: response.result.value.current.provider,
        model: response.result.value.current.model,
      }
    } catch {
      return undefined
    }
  }

  const directoryFor = (sessionId: string) => {
    try {
      return ctx.modelDirectories.directoryFor(sessionId)
    } catch {
      return null
    }
  }
  const getDirectoryStore = (sessionId: string): DirectoryStore | null => directoryFor(sessionId)?.store ?? null
  const primeDirectory = (sessionId: string): void => {
    try {
      void directoryFor(sessionId)?.load().catch(() => undefined)
    } catch {
      // 目录服务不可用：徽标退化为「—」模型显示，不影响计费归集。
    }
  }

  ctx.effect(() => {
    const style = document.createElement('style')
    style.id = 'dsh-usage-styles'
    style.setAttribute('data-plugin', PLUGIN_ID)
    style.textContent = `${SESSION_BADGE_CSS}\n${QUOTA_BADGE_CSS}\n${BOARD_CSS}`
    document.head.appendChild(style)

    const disposeSession = ctx.slots.inject('conversation.session.header.actions', () =>
      ctx.slots.register(
        {
          name: 'conversation.session.header.actions',
          id: PLUGIN_ID,
          order: -100,
          inject: () => ({ fetchUsage, getDirectoryStore, primeDirectory }),
        },
        SessionBadge,
      ),
    )

    const disposeQuota = ctx.slots.inject('conversation.session.header.utilities', () =>
      ctx.slots.register(
        {
          name: 'conversation.session.header.utilities',
          id: PLUGIN_ID,
          order: 100,
          inject: () => ({ getSelection, fetchQuota, refreshMs: DEFAULT_REFRESH_MS }),
        },
        QuotaBadge,
      ),
    )

    const disposeBoard = ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'usage-board',
          order: 12,
          label: () => '用量看板',
        },
        UsageBoardSection,
      ),
    )

    return () => {
      style.remove()
      if (typeof disposeSession === 'function') (disposeSession as () => void)()
      if (typeof disposeQuota === 'function') (disposeQuota as () => void)()
      if (typeof disposeBoard === 'function') (disposeBoard as () => void)()
    }
  }, `${PLUGIN_ID}: unified usage ui`)
}
