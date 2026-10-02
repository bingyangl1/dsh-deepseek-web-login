/**
 * 账号池选号器离线测试（方案 Step 2 / Step 3）。
 *
 * 只测 `server/pool/pool.ts` 的**纯选号/换号判据**，不碰网络、不起服务、不读真实账号库。
 * 关键判据（配反向验证，AGENTS.md 2.4）：
 *   - account scope：单号直通，永远返回绑定号（向后兼容，零行为变化）。
 *   - pool-failover：固定号健康时用固定号；固定号失效/受限时换到另一个健康号。
 *   - pool-roundrobin：健康账号间均衡（取固定号"之后的下一个"，不是每次第一个）。
 *   - canFailover：auth 一类不过窗口/冷却（死号越快换越好）；throttled 要过窗口 + 冷却。
 *   - 选择从不动"账号库全局 activeId"（池选号是 per-request 局部决定）。
 */
import assert from 'node:assert/strict'
import { PoolManager, normalizePoolScope, parsePoolBinding } from '../server/pool/pool.ts'

let passed = 0
const failures = []
async function run(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

/** 构造一棵假的账号记录（只填选号判据用到的字段）。 */
function acct(id, { invalid = false, limited = 0 } = {}) {
  return {
    id,
    token: `tok-${id}`,
    cookie: '',
    hifDliq: '',
    hifLeim: '',
    wasmUrl: '',
    userAgent: 'test',
    capturedAt: '2026-10-01T00:00:00.000Z',
    ...(invalid ? { lastVerifyError: { at: new Date().toISOString(), message: 'AUTH' } } : {}),
    ...(limited > 0 ? { limit: { untilMs: Date.now() + limited, observedAt: new Date().toISOString() } } : {}),
  }
}

// ── normalizePoolScope / 绑定段解析 ─────────────────────────────────────

await run('normalizePoolScope：可识别 + 未知回落', async () => {
  assert.equal(normalizePoolScope('account'), 'account')
  assert.equal(normalizePoolScope('pool-roundrobin'), 'pool-roundrobin')
  assert.equal(normalizePoolScope('pool-failover'), 'pool-failover')
  assert.equal(normalizePoolScope('garbage'), undefined, '未知回落未定义（不报错）')
})

await run('parsePoolBinding：key@acc_xxx ⇒ 单号；key@pool[-scope] ⇒ 池', async () => {
  const single = parsePoolBinding('acc_111111', undefined)
  assert.equal(single.accountId, 'acc_111111')
  assert.equal(single.poolScope, undefined, 'acc_xxx ⇒ 单号直通')
  assert.equal(parsePoolBinding('pool', undefined).poolScope, undefined, '裸 pool 由 DSW_POOL_SCOPE 兜底')
  assert.equal(parsePoolBinding('pool', 'pool-failover').poolScope, 'pool-failover', '裸 pool 用 DSW_POOL_SCOPE')
  assert.equal(parsePoolBinding('pool-failover', undefined).poolScope, 'pool-failover')
  assert.equal(parsePoolBinding('pool-roundrobin', undefined).poolScope, 'pool-roundrobin')
})

// ── account scope：单号直通（向后兼容）──────────────────────────────────

await run('account scope：永远返回绑定号，哪怕它失效（选择层不动，由调用方失败时处理）', async () => {
  const pool = new PoolManager({ scope: 'account' })
  const accounts = [acct('a1', { invalid: true }), acct('a2')]
  const picked = pool.selectAccount('a1', () => accounts, Date.now())
  assert.equal(picked.accountId, 'a1')
})

// ── pool-failover：固定号健康用固定号；失效换健康号 ─────────────────────

await run('pool-failover：固定号健康 ⇒ 用固定号', async () => {
  const pool = new PoolManager({ scope: 'pool-failover' })
  const accounts = [acct('a1'), acct('a2')]
  const picked = pool.selectAccount('a1', () => accounts, Date.now())
  assert.equal(picked.accountId, 'a1')
})

await run('pool-failover：固定号失效 ⇒ 换到另一个健康号', async () => {
  const pool = new PoolManager({ scope: 'pool-failover' })
  const accounts = [acct('a1', { invalid: true }), acct('a2')]
  const picked = pool.selectAccount('a1', () => accounts, Date.now())
  assert.equal(picked.accountId, 'a2', '固定号失效时应切到健康号')
})

await run('pool-failover：固定号受限（limit）⇒ 换到另一个健康号', async () => {
  const pool = new PoolManager({ scope: 'pool-failover' })
  const accounts = [acct('a1', { limited: 60_000 }), acct('a2')]
  const picked = pool.selectAccount('a1', () => accounts, Date.now())
  assert.equal(picked.accountId, 'a2')
})

await run('pool-failover：无其他可用 ⇒ 退回固定号（不假装有可用的）', async () => {
  const pool = new PoolManager({ scope: 'pool-failover' })
  const accounts = [acct('a1', { invalid: true }), acct('a2', { invalid: true })]
  const picked = pool.selectAccount('a1', () => accounts, Date.now())
  assert.equal(picked.accountId, 'a1', '无候选时退回固定号，让底层报真实错误')
})

// ── pool-roundrobin：均衡轮换 ───────────────────────────────────────────

await run('pool-roundrobin：在健康账号间取"固定号之后的下一个"（分散，不集中到第一个）', async () => {
  const pool = new PoolManager({ scope: 'pool-roundrobin', intervalMinutes: 5 })
  // 只给 interval>0 才轮换；这里模拟多次选择，应轮换到 a2
  const accounts = [acct('a1'), acct('a2'), acct('a3')]
  const pickedA = pool.selectAccount('a1', () => accounts, Date.now())
  const pickedB = pool.selectAccount('a2', () => accounts, Date.now() + 1)
  assert.equal(pickedA.accountId, 'a2', 'a1 之后的下一个健康号是 a2')
  assert.equal(pickedB.accountId, 'a3', 'a2 之后的下一个健康号是 a3（绕回）')
})

await run('pool-roundrobin：interval=0（未显式开）⇒ 回落固定号，不轮换', async () => {
  const pool = new PoolManager({ scope: 'pool-roundrobin', intervalMinutes: 0 })
  const accounts = [acct('a1'), acct('a2')]
  const picked = pool.selectAccount('a1', () => accounts, Date.now())
  assert.equal(picked.accountId, 'a1')
})

// ── canFailover / 选号不动全局 activeId ─────────────────────────────────

await run('canFailover：pool-failover + 有候选 ⇒ 可换；account scope ⇒ 不可换', async () => {
  const failover = new PoolManager({ scope: 'pool-failover' })
  const ok = failover.canFailover(true, { kind: 'auth', accountId: 'a1', list: () => [acct('a1'), acct('a2')], now: Date.now() })
  assert.equal(ok, true, 'pool-failover + 有别的健康号 ⇒ 可换')

  const single = new PoolManager({ scope: 'account' })
  assert.equal(single.canFailover(true, { kind: 'auth', accountId: 'a1', list: () => [acct('a1'), acct('a2')], now: Date.now() }), false, 'account scope 永不换号')
})

await run('canFailover：auth 类不过窗口/冷却（死号越快换越好）；throttled 要过冷却', async () => {
  const pool = new PoolManager({ scope: 'pool-failover' })
  const now = Date.now()
  // 刚换过号（lastSwitchedAt 刚 set），throttled 会被冷却挡住
  pool.noteSwitched(now)
  const t = pool.canFailover(true, { kind: 'throttled', accountId: 'a1', list: () => [acct('a1'), acct('a2')], now })
  assert.equal(t, false, 'throttled 未过冷却 ⇒ 不换（避免连环换号）')
  const a = pool.canFailover(true, { kind: 'auth', accountId: 'a1', list: () => [acct('a1'), acct('a2')], now })
  assert.equal(a, true, 'auth 类不过冷却 ⇒ 换（凭证作废是永久坏状态）')
})

await run('noteThrottled 后该号被排除（freshThrottled 当隔离项）', async () => {
  const pool = new PoolManager({ scope: 'pool-failover' })
  pool.noteThrottled('a2', Date.now())
  const picked = pool.nextAfterFailover('a1', () => [acct('a1'), acct('a2'), acct('a3')], Date.now())
  assert.equal(picked, 'a3', '刚被限流的 a2 应被排除，切到 a3')
})

console.log(`\n通过 ${passed} 项，${failures.length ? `失败 ${failures.length} 项：\n` + failures.join('\n') : '全部通过 OK'}`)
process.exitCode = failures.length ? 1 : 0
