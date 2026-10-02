/**
 * 阶段二离线测试：会话分槽（防串窗）+ 启动补删决策（会话不残留）。
 *
 * 判据：
 *   - deriveSessionId：带会话提示 ⇒ 稳定（同提示同槽，上下文延续）；不带 ⇒ 每次新值（不串窗）；
 *     且一律带 `api:` 前缀（与 DSH 主进程会话隔离）。
 *   - planStartupSweep（src/session-journal.ts 纯函数）：上次被强杀的进程留下的会话
 *     该补删，账号已在库且进程已死 ⇒ toDelete。
 */
import assert from 'node:assert/strict'
import { deriveSessionId } from '../server/openai/to-engine.ts'
import { planStartupSweep } from '../src/session-journal.ts'

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

await run('带会话提示 ⇒ 稳定槽（同提示复用，跨调一致）', async () => {
  const a = deriveSessionId('k1', 'user-abc')
  const b = deriveSessionId('k1', 'user-abc')
  assert.equal(a, b, '同一 key+同一会话提示应稳定（复用网页端会话）')
})

await run('不同 key ⇒ 不同槽（即使会话提示相同）', async () => {
  const a = deriveSessionId('k1', 'user-abc')
  const c = deriveSessionId('k2', 'user-abc')
  assert.notEqual(a, c, '不同 API-Key 不应共享槽')
})

await run('不同会话提示 ⇒ 不同槽', async () => {
  const a = deriveSessionId('k1', 'u1')
  const d = deriveSessionId('k1', 'u2')
  assert.notEqual(a, d)
})

await run('无会话提示 ⇒ 每次新槽（默认零串窗）', async () => {
  const x = deriveSessionId('k1', undefined)
  const y = deriveSessionId('k1', undefined)
  assert.notEqual(x, y, '无 user 应每请求独立槽，绝不复用（否则并发请求串窗）')
})

await run('【反向】前缀必须带 api:（不落入 DSH 主进程槽命名空间）', async () => {
  const v = deriveSessionId('k1', 'u')
  assert.ok(v.startsWith('api:'), `dshSessionId 应以 api: 开头（与 DSH 主进程隔离），实际 ${v}`)
})

// ── 启动补删决策（纯函数，不碰盘）────────────────────────────────────────
await run('planStartupSweep：进程已死+账号在库 ⇒ 该补删', async () => {
  const plan = planStartupSweep(
    [
      { accountId: 'acc_1', sessionId: 'S1', pid: 99999, at: 0, state: 'slot' },
      { accountId: 'acc_2', sessionId: 'S2', pid: 88888, at: 0, state: 'queued' },
    ],
    { ownPid: process.pid, isAlive: () => false, accountExists: (id) => id === 'acc_1' || id === 'acc_2', deleteEnabled: true, mode: 'immediate' },
  )
  assert.equal(plan.toDelete.length, 2, '进程都死了、账号都在 ⇒ 都该补删')
})

await run('planStartupSweep：进程还活着 ⇒ 保留（不动别的实例正在用的会话）', async () => {
  const plan = planStartupSweep(
    [{ accountId: 'acc_1', sessionId: 'S1', pid: process.pid, at: 0, state: 'slot' }],
    { ownPid: process.pid, isAlive: () => true, accountExists: () => true, deleteEnabled: true, mode: 'immediate' },
  )
  assert.equal(plan.toDelete.length, 0, `进程活着（自己 pid）⇒ 保留，实际 ${plan.toDelete.length}`)
})

await run('planStartupSweep：账号已被移除 ⇒ 放弃（无凭证可删，不误删）', async () => {
  const plan = planStartupSweep(
    [{ accountId: 'gone', sessionId: 'S1', pid: 1, at: 0, state: 'slot' }],
    { ownPid: process.pid, isAlive: () => false, accountExists: () => false, deleteEnabled: true, mode: 'immediate' },
  )
  assert.equal(plan.dropped.length, 1, '账号没了 ⇒ dropped（放弃）')
  assert.equal(plan.toDelete.length, 0)
})

await run('【反向】deleteEnabled=false ⇒ 不补删（用户要求不删会话）', async () => {
  const plan = planStartupSweep(
    [{ accountId: 'acc_1', sessionId: 'S1', pid: 1, at: 0, state: 'slot' }],
    { ownPid: process.pid, isAlive: () => false, accountExists: () => true, deleteEnabled: false, mode: 'keep' },
  )
  assert.equal(plan.toDelete.length, 0, 'deleteEnabled=false 绝不补删')
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
