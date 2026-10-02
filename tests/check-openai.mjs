/**
 * 阶段二离线测试：OpenAI ↔ 引擎 ↔ SSE 的映射正确性（含 AGENTS.md 2.4 反向验证）。
 *
 * 只测转换层（to-engine / from-engine）的纯函数，不碰网络、不真起服务。
 * 关键判据：如果某个映射被改坏，下面的用例必须红。
 */
import assert from 'node:assert/strict'
import { toCompletionParams, buildCompletionParams } from '../server/openai/to-engine.ts'
import { newCompletionId, makeChunk, sseDataLine, consumeStream, estimateUsage, toCompletionObject } from '../server/openai/from-engine.ts'
import { resolveSpec, resolveThinking, estimateTokens } from '../server/model.ts'
import { serializePromptParts } from '../src/protocol.ts'

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

// ── to-engine：OpenAI 请求 → 引擎输入 ─────────────────────────────────────

await run('OpenAI messages → 序列化 prompt 含 system 与对话内容', async () => {
  const input = toCompletionParams(
    {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
      ],
    },
    'key1',
    undefined,
  )
  assert.ok(input.prompt.includes('你是助手'), 'prompt 应含 system')
  assert.ok(input.prompt.includes('你好'), 'prompt 应含对话内容')
  assert.equal(input.thinkingEnabled, false, 'deepseek-chat 默认不思考')
  assert.equal(input.modelType, 'default')
})

await run('model → thinking：deepseek-reasoner 默认开思考；reasoning_effort 可覆盖', async () => {
  assert.equal(resolveThinking('deepseek-reasoner', undefined), true, 'reasoner 默认思考')
  assert.equal(resolveThinking('deepseek-chat', undefined), false, 'chat 默认不思考')
  assert.equal(resolveThinking('deepseek-chat', 'high'), true, 'chat + reasoning_effort=high → 开思考')
  assert.equal(resolveThinking('deepseek-reasoner', 'off'), false, 'reasoner + off → 关思考')
  const input = toCompletionParams({ model: 'deepseek-chat', reasoning_effort: 'high', messages: [] }, 'k', undefined)
  assert.equal(input.thinkingEnabled, true)
})

await run('未知 model 回落到 chat（不报错）', async () => {
  const input = toCompletionParams({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }, 'k', undefined)
  assert.equal(input.thinkingEnabled, false)
  assert.ok(input.prompt.includes('hi'))
})

await run('会话分槽：带 user 稳定、不带 user 每请求独立', async () => {
  const a = toCompletionParams({ user: 'u1', messages: [] }, 'k', 'u1')
  const b = toCompletionParams({ user: 'u1', messages: [] }, 'k', 'u1')
  const c = toCompletionParams({ user: 'u2', messages: [] }, 'k', 'u2')
  assert.equal(a.dshSessionId, b.dshSessionId, '同 user 应稳定复用同一槽')
  assert.notEqual(a.dshSessionId, c.dshSessionId, '不同 user 应不同槽')
  assert.ok(a.dshSessionId.startsWith('api:'), 'dshSessionId 应带 api: 前缀隔离')
  // 无 user：每请求独立槽
  const x = toCompletionParams({ messages: [] }, 'k', undefined)
  const y = toCompletionParams({ messages: [] }, 'k', undefined)
  assert.notEqual(x.dshSessionId, y.dshSessionId, '无 user 应该每请求独立槽（不串窗）')
})

await run('完整链路：buildCompletionParams 产出 engine 需要的字段', async () => {
  const input = toCompletionParams({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }, 'k', undefined)
  const params = buildCompletionParams(input)
  assert.equal(typeof params.prompt, 'string')
  assert.equal(params.thinkingEnabled, false)
  assert.equal(params.modelType, 'default')
  assert.equal(params.sessionReuseTurns, 0, '无 user 时应 0（每请求独立会话）')
  const withUser = toCompletionParams({ user: 'u', messages: [] }, 'k', 'u')
  assert.equal(withUser.sessionReuseTurns, 20, '带 user 时应复用 20 轮')
})

// ── 上下文污染规避：结构化 promptParts 接入（方案 Step 1）──────────────────
// 判据：带 user 的请求必须带 promptParts（→ requestSlotKey 路由到「账号|user」槽，
// 不同 user 不串会话）；不带 user 的保持「每请求独立会话」（promptParts 缺省 → 共享 internal 槽，
// 但 reuseTurns=0 ⇒ 每请求新会话，无跨请求身份可延续）。

await run('带 user ⇒ 出 promptParts；不带 user ⇒ 不出（上下文隔离的关键）', async () => {
  const withUser = toCompletionParams({ user: 'u1', messages: [{ role: 'user', content: 'hi' }] }, 'k', 'u1')
  assert.ok(withUser.promptParts, '带 user 必须出 promptParts（否则 requestSlotKey 走共享 internal 槽，跨 user 串上下文）')
  assert.equal(typeof withUser.promptParts.head, 'string', 'head = 固定头（系统/协议/工具目录）')
  assert.ok(Array.isArray(withUser.promptParts.entries), 'entries = 未截断的历史条目')

  const noUser = toCompletionParams({ messages: [{ role: 'user', content: 'hi' }] }, 'k', undefined)
  assert.equal(noUser.promptParts, undefined, '无 user ⇒ 不出 promptParts（保持每请求独立会话）')
  assert.equal(noUser.sessionReuseTurns, 0, '无 user ⇒ 0（每请求新会话）')
})

await run('prompt 与 promptParts.full 语义一致（prompt 就是那份全量串）', async () => {
  const withUser = toCompletionParams({ user: 'u', messages: [{ role: 'user', content: '你好' }] }, 'k', 'u')
  assert.ok(withUser.prompt.includes('你好'), 'prompt 应含对话内容')
  assert.ok(withUser.prompt.startsWith(withUser.promptParts.head), 'prompt 应以 head（固定头）开头 —— 说明同一份序列化')
})

await run('两个不同 user 走同一账号 ⇒ dshSessionId 不同（落到不同槽，不串会话）', async () => {
  const a = toCompletionParams({ user: 'u1', messages: [] }, 'k', 'u1')
  const b = toCompletionParams({ user: 'u2', messages: [] }, 'k', 'u2')
  assert.notEqual(a.dshSessionId, b.dshSessionId, '不同 user 应不同会话槽')
  assert.ok(a.dshSessionId.startsWith('api:k:'), 'dshSessionId 应带 api: 前缀 + key 短标隔离')
  assert.ok(a.promptParts && b.promptParts, '都应有 promptParts（各自独立链）')
})

await run('maxPromptChars 透传给序列化器与 promptParts.maxChars', async () => {
  const withUser = toCompletionParams({ user: 'u', messages: [] }, 'k', 'u', 200_000)
  assert.equal(withUser.promptParts.maxChars, 200_000, 'promptParts.maxChars 应透传')
})

await run('【反向】若 server 对带 user 的请求不传 promptParts，用例必须红', async () => {
  const withUser = toCompletionParams({ user: 'u1', messages: [] }, 'k', 'u1')
  // 这条是正向判据；变异反向：临时把手改回只传 prompt 不传 promptParts 时，第一行断言会红。
  assert.ok(withUser.promptParts, '带 user 必须出 promptParts —— 注释掉 to-engine 的 promptParts 赋值就红')
})

// ── 链式投喂（decideFeed 纯函数）在"复用同会话 + 严格追加"时只发增量 ──────
// 用插件自身的 decideFeed（src/context-feed.ts，纯函数不碰网络），证明 Step 1 喂给
// engine 的 promptParts 在链建立后确实只发增量（上下文污染规避：不重发回声/历史）。
await run('链式：复用同会话 + 历史追加 ⇒ 只发增量（不重发全量/回声）', async () => {
  const feed = await import('../src/context-feed.ts')
  const decision = feed.decideFeed({
    mode: 'chained',
    head: '[系统头]',
    entries: ['第一条', 'Assistant: 上一轮回答', 'User: 新问题'],
    full: '[整段全量]',
    sessionId: 'S',
    accountKey: 'A',
    reused: true,
    chain: { head: '[系统头]', entries: ['第一条'], parentId: 2, sessionId: 'S', accountKey: 'A' },
  })
  assert.equal(decision.reason, 'chained', '应走链式（发增量）')
  // 增量里剔掉「Assistant: 上一轮回答」这条模型回声（它已在链上 = 正是我们要挂的父消息）
  assert.equal(decision.echoDropped, 1, '应剔除 1 条模型回声（上一轮回答不进增量）')
  assert.equal(decision.prompt, 'User: 新问题', '增量只含真正的新内容，不重发回声')
  assert.equal(decision.parentMessageId, 2, 'parent 指向上一轮 assistant 的 message_id')
})

// ── from-engine：引擎事件 → OpenAI 帧/整包 ────────────────────────────────

async function fakeEngine(events) {
  return (async function* () {
    for (const e of events) yield e
  })()
}

await run('makeChunk：text → delta.content；收尾帧带 finish_reason', async () => {
  const meta = { id: 'id1', model: 'deepseek-chat', created: 1 }
  const t = makeChunk(meta, { content: '你好' }, undefined)
  assert.equal(t.choices[0].delta.content, '你好', '正文应该进 delta.content')
  assert.equal(t.choices[0].finish_reason, null)
  const f = makeChunk(meta, undefined, { reason: 'stop' })
  assert.equal(f.choices[0].finish_reason, 'stop')
})

await run('【反向】makeChunk 若把 content 写成别的字段，用例必须红', async () => {
  const meta = { id: 'i', model: 'm', created: 1 }
  const t = makeChunk(meta, { content: 'X' }, undefined)
  assert.equal(t.choices[0].delta.content, 'X', '映射必须在 choices[0].delta.content —— 改坏就红')
})

await run('sseDataLine 产出标准 OpenAI SSE data 帧', async () => {
  const meta = { id: 'id', model: 'deepseek-chat', created: 2 }
  const line = sseDataLine(makeChunk(meta, { content: 'hi' }, undefined))
  assert.ok(line.startsWith('data: '), '应以 data: 开头')
  assert.ok(line.endsWith('\n\n'), '应以空行隔开事件')
  const parsed = JSON.parse(line.slice(6).trim())
  assert.equal(parsed.object, 'chat.completion.chunk')
  assert.equal(parsed.choices[0].delta.content, 'hi')
})

await run('consumeStream：聚合 text/thinking/finish；error 折进字段不抛', async () => {
  const events = await consumeStream(
    await fakeEngine([
      { kind: 'thinking', text: '想' },
      { kind: 'text', text: '答案' },
      { kind: 'finish', reason: 'stop', totalTokens: 99 },
    ]),
  )
  assert.equal(events.text, '答案')
  assert.equal(events.thinking, '想')
  assert.equal(events.finishReason, 'stop')
  assert.equal(events.totalTokens, 99)
  assert.equal(events.error, undefined)
})

await run('consumeStream：error 事件中断并回报', async () => {
  const events = await consumeStream(
    await fakeEngine([
      { kind: 'text', text: '前' },
      { kind: 'error', message: 'boom', code: 'RATE_LIMIT' },
      { kind: 'text', text: '后' }, // 不应被消费
    ]),
  )
  assert.equal(events.text, '前')
  assert.equal(events.error?.code, 'RATE_LIMIT')
})

await run('estimateTokens：中文按约 1.5 字符/token、英文按 4', async () => {
  assert.equal(estimateTokens(''), 0)
  const zh = estimateTokens('你好')
  assert.ok(zh >= 1 && zh <= 2, `"你好" 两中文字符约 1~2 token，实际 ${zh}`)
  const en = estimateTokens('hello')
  assert.equal(en, 2, `"hello" 5 ascii → ceil(5/4)=2，实际 ${en}`)
})

await run('toCompletionObject：非流式整包结构正确', async () => {
  const meta = { id: 'id', model: 'deepseek-chat', created: 3 }
  const consumed = { text: '答案', thinking: '', finishReason: 'stop', totalTokens: 42, error: undefined }
  const usage = estimateUsage('prompt', consumed.text, 42)
  const full = toCompletionObject(meta, consumed, 'prompt', usage)
  assert.equal(full.object, 'chat.completion')
  assert.equal(full.choices[0].message.content, '答案')
  assert.equal(full.choices[0].finish_reason, 'stop')
  assert.equal(full.usage?.total_tokens, 42, 'total 优先服务端值')
})

await run('serializePromptParts 仍可用（回归：协议序列化不被 server 改动破坏）', async () => {
  const p = serializePromptParts({
    system: 'S',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.ok(p.full.includes('S') && p.full.includes('hi'))
})

await run('newCompletionId：两次不同', async () => {
  assert.notEqual(newCompletionId(), newCompletionId())
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
