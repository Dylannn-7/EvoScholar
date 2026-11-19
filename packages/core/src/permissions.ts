// Permission modes (modelled on Claude Code): which side effects reach the user for approval.
import type { PermissionMode } from './config'
import type { ApprovalKind, ToolEnv } from './tools/types'

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  ask: '询问',
  acceptEdits: '自动接受编辑',
  plan: '计划',
  bypass: '完全放行'
}

export const PLAN_MODE_NOTE = '【计划模式】本回合只读：可以阅读文件、检索和分析，但不要写文件、不要运行代码或命令。先给出分步计划和需要用户确认的问题，等用户确认后再执行。'

/**
 * Wrap the UI approval callback with the session's permission mode.
 * Unattended runs auto-approve ordinary operations outside plan mode.
 */
export function permissionGate(mode: () => PermissionMode, ask?: ToolEnv['approve']): ToolEnv['approve'] {
  return async (tool: string, summary: string, kind: ApprovalKind = 'exec', signal) => {
    if (signal?.aborted) return false
    const m = mode()
    if (m === 'plan') return false
    if (kind !== 'evolution' && (m === 'bypass' || (m === 'acceptEdits' && kind === 'edit'))) return true
    if (!ask) return kind !== 'evolution'
    if (!signal) return ask(tool, summary, kind)
    return new Promise<boolean>((resolve, reject) => {
      const cancel = () => resolve(false)
      signal.addEventListener('abort', cancel, { once: true })
      Promise.resolve().then(() => signal.aborted ? false : ask(tool, summary, kind, signal))
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', cancel))
    })
  }
}
