/**
 * 账号池选号器 —— 把「一个 key 绑一个账号」升级成「一个 key 选一个号」。
 *
 * 独立 OpenAI 服务的风控编排层（方案 Step 2 / Step 3）。**不碰 DSH 宿主**：
 * 不复刻 `src/index.ts` 的 `maybeAutoSwitch`（那套会改全局 activeId、有探活与界面回调），
 * 而是把 `src/auto-switch.ts` 的**纯判据**拿进来，做 per-request 的局部选号。
 *
 * 姿态（与项目立场一致，见 AGENTS.md §2.6 / `src/accounts.ts:19-37`）：
 *   - 默认 scope = `account`：一个 key 绑一个账号（向后兼容，零行为变化）。
 *   - `pool-roundrobin` **默认关**：开启后按 `pickNextAccount` 在健康账号间按时间/计数均衡。
 *   - `pool-failover` **默认关**：开启后被 mute / throttle / AUTH 时换到池里另一个健康号。
 *   激进高频轮换被明确视为高风险（服务商会关联多账号、处置更重）—— 这里只做健康的、
 *   有节制的切换，且全部默认关。
 *
 * 🔴 安全与边界（沿用 AGENTS.md 2.5）：
 *   - **永不写账号库的 activeId**（endpoint 不该动 DSH 的「当前账号」全局态；
 *     server/http/server.ts 明确"精确取号，不碰全局 activeAccount"）。
 *   - key / token / cookie 原文绝不落盘、绝不打进日志/HTTP；状态全放进程内存。
 */

import type { AccountRecord } from '../../src/accounts.ts'
import {
  isUsable,
  pickNextAccount,
  isThrottleSwitchAllowed,
  hasFailoverCandidate,
  THROTTLE_SWITCH_WINDOW_MS,
  type SwitchableAccount,
} from '../../src/auto-switch.ts'

/** 池作用域：`account`（默认，绑单号）／`pool-roundrobin`（均衡轮换，默认关）／`pool-failover`（失效换号，默认关）。 */
export type PoolScope = 'account' | 'pool-roundrobin' | 'pool-failover'

/** key 原文 → PoolManager（每个池 key 一个实例，状态全进程内）。 */
export type PoolManagers = Map<string, PoolManager>

export const POOL_SCOPE_ENV = 'DSW_POOL_SCOPE'
/** 池账号清单来源：`DSW_ACCOUNT_POOL`（逗号分隔的 acc_* 或 group:*，缺省 = 全库）。 */
export const POOL_ACCOUNTS_ENV = 'DSW_ACCOUNT_POOL'
/** 轮换间隔（分钟）；0 = 关闭。只在 pool-roundrobin 下有意义。 */
export const POOL_INTERVAL_ENV = 'DSW_POOL_INTERVAL_MINUTES'

/** 环境变量里可识别的 scope（未知回落 account，不报错 —— 向后兼容）。 */
export function normalizePoolScope(value: unknown): PoolScope | undefined {
  if (value === 'pool-roundrobin' || value === 'pool-failover' || value === 'account') return value
  return undefined
}

/** 把 `key@pool...` 的绑定段解析成池 scope（`key@pool` / `key@pool-roundrobin` / `key@pool-failover`）。 */
export function scopeFromBind(bind: string): PoolScope | undefined {
  if (bind === 'pool') return undefined // 具体用哪个由 DSW_POOL_SCOPE 兜底决定
  return normalizePoolScope(bind)
}

export interface PoolBinding {
  /** 单账号直通的账号 id（绑 `acc_xxx` 时）。池模式可为空（锚点由选号时现取）。 */
  accountId?: string
  /** 池作用域；undefined = 单账号直通（默认）。 */
  poolScope?: PoolScope
}

/**
 * 解析一个 `@` 右侧的绑定值。
 *   - `acc_xxx`       ⇒ 单账号直通（{ accountId }）。
 *   - `pool[:scope]`  ⇒ 池绑定；scope 取绑定段（`pool-failover` 等），其次 `envScope`（DSW_POOL_SCOPE），
 *                       都没有则回落单账号（保守，向后兼容）。
 * @param envScope DSW_POOL_SCOPE 的规范化值（可为 undefined）。
 */
export function parsePoolBinding(bind: string, envScope?: PoolScope): PoolBinding {
  if (!bind.startsWith('pool')) {
    return { accountId: bind }
  }
  const scoped = bind.includes(':') ? bind.split(':')[1] : bind
  const scope = scopeFromBind(scoped) ?? envScope
  return { accountId: undefined, poolScope: scope }
}

export interface PoolConfig {
  /** 池的账号清单。缺省 = 全部账号；可用 acc_* 列表过滤成子池。 */
  accountIds?: readonly string[]
  /** round-robin / failover 的开关（默认 account 关）。 */
  scope?: PoolScope
  /** 均衡轮换间隔（分钟），0 = 关。 */
  intervalMinutes?: number
  /** 进程内"刚被限流"的时刻表（按账号），由本模块读写。 */
  log?: (line: string) => void
}

interface PooledAccount extends SwitchableAccount {
  auth: AccountRecord
}

/**
 * 账号池管理器（per-key 局部状态，全部进程内）。
 *
 * 每个池 scope 的 API-Key 对应一个实例；它维护该池的：
 *   - 健康账号列表（从 listAccounts() 过滤出存活/未被 limit 的）；
 *   - 进程内 `throttleAt`（限流时刻，不落盘 —— 限流是瞬时反馈，写入账号记录会污染 UI）；
 *   - `lastSwitchAt`（上次切换，用于 throttle 换号的冷却）。
 */
export class PoolManager {
  private readonly scope: PoolScope
  private readonly intervalMinutes: number
  private readonly accountIds?: ReadonlySet<string>
  private readonly log: (line: string) => void

  /** 各账号最近一次被限流（throttled，非封禁）的时刻。 */
  private readonly throttleAt = new Map<string, number>()
  /** 上次真正换过号的时刻（0 = 本次启动还没换过）。 */
  private lastSwitchedAt = 0

  constructor(config: PoolConfig) {
    // 默认 scope：account（单号直通，零行为变化）。round-robin / failover 都默认关，
    // 与项目"默认不自动换号"的立场一致 —— 要开必须显式配置。
    this.scope = config.scope ?? 'account'
    this.intervalMinutes = Number.isFinite(config.intervalMinutes) && Number(config.intervalMinutes) > 0 ? Number(config.intervalMinutes) : 0
    this.accountIds = config.accountIds?.length ? new Set(config.accountIds) : undefined
    this.log = config.log ?? (() => {})
  }

  get mode(): PoolScope {
    return this.scope
  }

  /** 池里的账号（按传入顺序）。可按 DSW_ACCOUNT_POOL 交的子池过滤。 */
  private allAccounts(now: number, list: () => AccountRecord[]): PooledAccount[] {
    const records = list()
    const filtered = this.accountIds ? records.filter((a) => this.accountIds.has(a.id)) : records
    return filtered.map((auth) => ({ id: auth.id, auth, lastVerifyError: auth.lastVerifyError, limit: auth.limit }))
  }

  /** 健康账号（未失效、未在 limit 窗口内、未刚被限流）。 */
  private usable(accounts: readonly PooledAccount[], now: number): PooledAccount[] {
    const fresh = this.freshThrottled(now)
    return accounts.filter((a) => isUsable(a, now) && !fresh.has(a.id))
  }

  /** 进程内"刚被限流"的 id 集（还在窗口内的才算）。 */
  private freshThrottled(now: number): Set<string> {
    const out = new Set<string>()
    for (const [id, at] of this.throttleAt) {
      if (Number.isFinite(at) && now - at <= THROTTLE_SWITCH_WINDOW_MS) out.add(id)
    }
    return out
  }

  /**
   * 为一次请求解析绑定的账号（单号直通 / 池选号）。
   * @param fixedAccountId 该 key 绑定的唯一账号（account scope / failover 的"首选"）。
   * @param list 账号库读取源（注入以便离线测试）。
   */
  selectAccount(
    fixedAccountId: string,
    list: () => AccountRecord[],
    now: number,
  ): { accountId: string; auth: AccountRecord | undefined } {
    // 单号直通：永远返回绑定号；它是否健康由调用方在失败时再判断（failover 路径）。
    if (this.scope === 'account') {
      const auth = list().find((a) => a.id === fixedAccountId)
      return { accountId: fixedAccountId, auth }
    }

    // 池模式：先在绑定号（作为"当前/首选"）之外挑。
    const accounts = this.allAccounts(now, list)
    const fixed = accounts.find((a) => a.id === fixedAccountId)
    // round-robin：健康账号里，取"固定号之后的下一个"（包一圈），让请求在池内分散。
    if (this.scope === 'pool-roundrobin' && this.intervalMinutes > 0) {
      const nextId = pickNextAccount(accounts, fixedAccountId, now, this.freshThrottled(now))
      if (nextId && nextId !== fixedAccountId) {
        const picked = accounts.find((a) => a.id === nextId)
        if (picked) {
          this.lastSwitchedAt = now
          return { accountId: nextId, auth: picked.auth }
        }
      }
    }
    // 固定号仍健康时，pool-failover 默认先用它（只在失败时才换）。
    if (fixed && isUsable(fixed, now)) return { accountId: fixedAccountId, auth: fixed.auth }
    // 固定号不可用（失效/受限）→ 救急：切到另一个健康账号（不覆盖全局 activeId）。
    const nextId = pickNextAccount(accounts, fixedAccountId, now, this.freshThrottled(now))
    if (nextId) {
      const picked = accounts.find((a) => a.id === nextId)
      if (picked) {
        this.lastSwitchedAt = now
        return { accountId: nextId, auth: picked.auth }
      }
    }
    // 无可用候选：退回固定号（让底层报 AUTH/受限），别假装有一个可用的。
    return { accountId: fixedAccountId, auth: fixed?.auth }
  }

  /** 记录一次限流（throttled）—— 只放内存，不碰账号记录。 */
  noteThrottled(accountId: string, now: number): void {
    this.throttleAt.set(accountId, now)
  }

  /**
   * 「当前账号失败时，能不能换个号接着干」—— 注入 engine 的 `canFailover`。
   * 三种 kind 的语义与 `src/index.ts` 的宿主版一致：
   *   - 'auth'：凭证被服务端作废 —— 永久坏状态，**不过**窗口/冷却，越早换越好；
   *   - 'throttled'：限流 —— 必须过 `isThrottleSwitchAllowed`（窗口 + 冷却），
   *     否则"每个号都被限流"时会连环换完整个池（有组织的规避形态）。
   *   - 'muted'：账号级封禁 —— 这个号暂时废了，换走。
   * @param failable 该 key 是否启用了 failover（pool-failover scope）。
   */
  canFailover(
    failable: boolean,
    params: {
      kind?: 'muted' | 'throttled' | 'auth'
      accountId: string
      list: () => AccountRecord[]
      now: number
    },
  ): boolean {
    if (!failable || this.scope === 'account') return false
    const { kind, accountId, list, now } = params
    if (kind === 'throttled') {
      if (!isThrottleSwitchAllowed({ throttledAt: now, lastSwitchAt: this.lastSwitchedAt, now })) return false
    }
    const candidate = hasFailoverCandidate({
      minutes: this.intervalMinutes > 0 ? this.intervalMinutes : 1, // failover 需要"能换"的最小门槛
      switching: false,
      accounts: this.allAccounts(now, list),
      currentId: accountId,
      now,
      excludeIds: this.freshThrottled(now),
    })
    if (!candidate && kind) {
      this.log(`[pool] 本池无可用候选，无法按 ${kind} 换号`)
    }
    return candidate
  }

  /** failover 换到哪个号（与 canFailover 的判据同源，保证"给了短退避就一定能换"）。 */
  nextAfterFailover(
    currentAccountId: string,
    list: () => AccountRecord[],
    now: number,
  ): string | undefined {
    return pickNextAccount(this.allAccounts(now, list), currentAccountId, now, this.freshThrottled(now))
  }

  /** 换号成功后，更新"上次切换"时间（供 throttle 冷却）。 */
  noteSwitched(now: number): void {
    this.lastSwitchedAt = now
  }
}
