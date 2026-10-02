/**
 * 账号池管理器装配 —— 从 API-Key 注册表为每个「池 scope」的 key 建一个 PoolManager。
 *
 * 单账号直通（poolScope 未设）的 key 不建 manager —— 行为与改造前完全一致，
 * 不引入任何额外状态。池状态全部进程内（throttleAt / lastSwitchedAt），重启即清。
 */
import type { KeyRegistry } from '../api-key/keys.ts'
import { PoolManager, POOL_ACCOUNTS_ENV, POOL_INTERVAL_ENV, type PoolScope, type PoolManagers } from './pool.ts'

export interface PoolFactoryConfig {
  log?: (line: string) => void
}

/** 从 DSW_ACCOUNT_POOL 解析子池账号清单（逗号分隔 acc_*；缺省 = 全库）。 */
function poolAccountIds(): string[] | undefined {
  const raw = process.env[POOL_ACCOUNTS_ENV]
  if (!raw) return undefined
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return ids.length ? ids : undefined
}

/** 从 DSW_POOL_INTERVAL_MINUTES 解析轮换间隔（分钟，>0 才启用均衡）。 */
function poolIntervalMinutes(): number {
  const n = Number(process.env[POOL_INTERVAL_ENV])
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 为所有带 poolScope 的 key 建 PoolManager。 */
export function buildPoolManagers(registry: KeyRegistry, config: PoolFactoryConfig = {}): PoolManagers {
  const log = config.log ?? (() => {})
  const accountIds = poolAccountIds()
  const intervalMinutes = poolIntervalMinutes()
  const managers: PoolManagers = new Map()

  for (const [, entry] of registry) {
    if (!entry.poolScope) continue
    const scope = entry.poolScope as PoolScope
    const existing = managers.get(entry.key)
    if (existing) continue // 同一 key 不会重复注册
    managers.set(entry.key, new PoolManager({ scope, accountIds, intervalMinutes, log }))
    log(
      `[pool] key ${entry.label} → 池（scope=${scope}${accountIds ? `，子池 ${accountIds.length} 号` : '，全库'}）` +
        (scope !== 'account' ? '' : '（account：与单号直通等价）'),
    )
  }
  return managers
}
