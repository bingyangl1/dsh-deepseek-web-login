/**
 * 运行期装配：载荷闸门（按账号）+ 会话清理（及时删 + journal 补删）。
 *
 * 这是「尽量降低被风控的可能」的实现核心：
 *  1. **按账号串行 + 随机间隔**：同一账号所有 API-Key 共享一把 `createRequestGate`
 *     （风控量化单位是账号的请求节奏；两个 key 绑同一账号必须共享锁，否则绕过防风控）。
 *  2. **成对传 min+max**：随机区间（2~4s）。只传 min 会让 max 跟随 min → 退化成固定间隔
 *     （定时器特征，风控大忌，见 src/gate.ts:455 注释）。
 *  3. **会话及时清理**：退役会话交给 webapi 的 defaultCleaner 排队删（scheduleDeleteSession），
 *     注册 setSessionLifecycleHook 落 journal，进程被强杀后下次启动 runStartupSweep 补删 ——
 *     目标是不让网页端残留一堆临时会话（机器特征）。
 */
import { createRequestGate, type RequestGate } from '../src/gate.ts'
import { scheduleDeleteSession, setSessionLifecycleHook } from '../src/webapi.ts'
// WebAuth 的唯一来源是 src/auth.ts（webapi.ts 并不 re-export 它 —— 见 server/http/server.ts
// 同样是 `import type { WebAuth } from '../../src/auth.ts'`）。
import type { WebAuth } from '../src/auth.ts'
import {
  readJournal,
  runStartupSweep,
  upsertJournalEntry,
  removeJournalEntry,
  writeJournal,
  sessionJournalPath,
} from '../src/session-journal.ts'
import { listAccounts, readAccount } from '../src/accounts.ts'

export interface RuntimeOptions {
  /** 成对传最小/最大请求间隔（随机 2s~4s）。 */
  minIntervalMs?: number
  maxIntervalMs?: number
  /** 是否允许并发（**默认 false = 串行**；同账号并发生成是实测最重的风控触发）。 */
  allowConcurrent?: boolean
  /** 长任务强制休整：连续触发多少次后长休（0 = 关），复用 src/gate.ts 的长休逻辑。 */
  longRunThreshold?: number
}

const MAX_CONCURRENCY_GUARD = 6 // reuseSlots 上限兜底（webapi.ts:1967）

const gates = new Map<string, RequestGate>()
let journalInstalled = false

/** 取某账号的闸门（lazy 创建，同账号共享一把锁）。 */
export function gateFor(accountId: string, opts: RuntimeOptions = {}): RequestGate {
  let gate = gates.get(accountId)
  if (!gate) {
    gate = createRequestGate({
      allowConcurrent: opts.allowConcurrent === true,
      // ⚠️ 必须成对传：只传 min 会让 max 跟随 min → 随机区间退化为固定间隔
      minIntervalMs: opts.minIntervalMs ?? 2_000,
      maxIntervalMs: opts.maxIntervalMs ?? 4_000,
      // 长任务休整（默认 15，见 src/gate.ts DEFAULT_LONG_RUN_THRESHOLD）：
      // 连续跑到这份密度仍然太"脚本"，强制长休一次，降低被风控判定的长期形态。
      longRunThreshold: opts.longRunThreshold ?? 15,
    })
    gates.set(accountId, gate)
  }
  return gate
}

/** token → accountId（journal 记账需要把 auth 归到账号）。 */
function accountIdOfAuth(auth: WebAuth): string | undefined {
  const found = listAccounts().find((a) => a.token === auth.token)
  return found?.id
}

/**
 * 安装会话生命周期钩子：把「还欠一次删除」的会话落盘 journal。
 * 幂等：进程内只装一次。
 * @param allowJournal 是否记账（服务端删会话启用；false = 只销账不记新账）。
 * @param keepMode 是否用户选择「不删会话」——此时不记新账但仍销账。
 */
export function installSessionJournal(allowJournal: boolean, keepMode: boolean): void {
  if (journalInstalled) return
  journalInstalled = true
  setSessionLifecycleHook((event) => {
    // 销账必须在判断之前：即使不记新账，也要摘掉既有欠账（否则下次补扫会误删已放弃的）
    if (event.kind === 'deleted' || event.kind === 'abandoned') {
      removeJournalEntry(event.sessionId)
      return
    }
    if (!allowJournal || keepMode) return
    const accountId = accountIdOfAuth(event.auth)
    if (!accountId) return
    upsertJournalEntry({
      accountId,
      sessionId: event.sessionId,
      state: event.kind === 'queued' ? 'queued' : 'slot',
    })
  })
}

/**
 * 启动补删：上次退出（含强杀）遗留的会话，按账号排进清理器。
 * 失败不致命（不影响服务启动）。
 * @param deleteEnabled 服务端是否允许删会话（默认 true；false = 保底不删）。
 * @param onSweep 实际删除动作 —— 默认交给 defaultCleaner。
 */
export function runStartupSessionSweep(
  deleteEnabled: boolean,
  onSweep?: (accountId: string, sessionId: string) => void,
): void {
  if (!deleteEnabled) return
  try {
    runStartupSweep({
      ownPid: process.pid,
      accountExists: (id) => readAccount(id) !== undefined,
      deleteEnabled: true,
      mode: 'immediate',
      onSweep: (entry) => {
        const account = readAccount(entry.accountId)
        if (!account) throw new Error('账号已不在账号库里')
        const doDelete = onSweep ?? ((_acc, sid) => void scheduleDeleteSession(account as WebAuth, sid))
        doDelete(entry.accountId, entry.sessionId)
      },
    })
  } catch (error: any) {
    // 补删失败不影响使用（novalue 日志可有可无，这里静默）
    void error
  }
}

/** 退出前 flush：把还欠删除的会话交给清理器。 */
export function flushSessions(): void {
  try {
    const entries = readJournal()
    writeJournal(entries)
  } catch {
    /* noop */
  }
}

export { sessionJournalPath }
export { MAX_CONCURRENCY_GUARD }
