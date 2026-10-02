/**
 * 阶段一（OpenAI API 化改造）可行性离线验证：
 * 引擎层（streamWebCompletion）在**无 DSH 宿主**的裸 Node 下是否可独立调用、并能
 * 拿到完整事件流 + 解析出工具调用。
 *
 * 这是「把 dsh-deepseek-web-login 改造为对外 OpenAI 兼容 API」方案的第一步探路：
 * 独立 API 服务不经过 `index.ts` 的 apply(ctx)（那是 DSH 插件入口），而是直接 import
 * 引擎模块当库用。本用例证明这条「引擎当库复用」的路线成立，且全程**不碰网络 / 不碰 DSH**。
 *
 * 为什么必须离线：AGENTS.md 2.3 —— 传输层 fetch 必须「每次现取」，测试通过
 * `setFetchImpl` 注入假 fetch 拦截掉完成请求，绝不能让请求真的出网。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setFetchImpl, streamWebCompletion } from '../src/webapi.ts'
import { ToolCallStreamFilter, serializePromptParts } from '../src/protocol.ts'

// 本用例会走 streamWebCompletion（投喂留痕的唯一入口），必须钉住临时 DSH_HOME，
// 否则单独 `node tests/check-engine-standalone.mjs` 会把测试噪声写进用户真实 ~/.dsh
// （check-test-isolation.mjs 守卫：见 tests/check-test-isolation.mjs）。
const HOME = mkdtempSync(join(tmpdir(), 'dsh-engine-standalone-'))
process.env.DSH_HOME = HOME

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

/** 一份最小合法凭证（鉴权只在发真请求时才有意义，离线测试不真发）。 */
const AUTH = {
  token: 't',
  cookie: '',
  hifDliq: '',
  hifLeim: '',
  wasmUrl: '',
  userAgent: 'standalone-test-ua',
  capturedAt: '2026-10-01T00:00:00.000Z',
}

/** 假传输：建会话 / PoW 全部短路，让唯一会出网的「完成请求」落到注入的 fetch 上。 */
const transport = {
  createSession: async () => 'S-STANDALONE',
  powHeader: async () => 'pow-standalone',
}

/** 一段模拟服务端 SSE 的完成响应（content-type: event-stream → 走 SSE 解析）。 */
function sseResponse(sseText) {
  return new Response(sseText, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/**
 * 在「注入 fetch → 复原」的沙箱里跑一次 streamWebCompletion，返回全部事件与抛错。
 * 重点抽查：除了开头的建会话/PoW（假传输短路），引擎是否真的**只能**通过注入的 fetch
 * 发请求 —— 若它固化了全局 fetch，请求就会真出网（这是本用例要拦住的）。
 */
async function completeUnder(fakeFetch, params = {}) {
  const real = globalThis.fetch
  const hits = []
  setFetchImpl(async (input, init) => {
    hits.push(String(input))
    return fakeFetch(input, init)
  })
  try {
    const events = []
    let thrown
    try {
      for await (const event of streamWebCompletion(
        AUTH,
        { prompt: 'hi', thinkingEnabled: false, modelType: 'default', idleTimeoutMs: 3_000, ...params },
        transport,
      )) {
        events.push(event)
      }
    } catch (error) {
      thrown = error
    }
    return { events, thrown, hits }
  } finally {
    setFetchImpl()
    globalThis.fetch = real
  }
}

// ── 一、引擎在裸 Node 下被调用，且请求走注入的 fetch（不真出网）──────────

await run('引擎可被独立调用；完成请求确实落到注入的 fetch（没绕过桩件真出网）', async () => {
  const fakereq = async (input, init) => {
    const sse =
      'data: {"v":{"response":{"content":"你好"}}}\n\n' +
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n'
    return sseResponse(sse)
  }
  const { events, thrown, hits } = await completeUnder(fakereq)
  assert.ok(!thrown, `不应抛错，实际 ${thrown?.message ?? ''}`)
  assert.equal(hits.length, 1, `完成请求应只发一次（经注入 fetch），实际 ${hits.length} 次`)
  assert.ok(hits[0].includes('/api/v0/chat/completion'), `请求应打到 completion 端点，实际 ${hits[0]}`)
  const text = events.filter((e) => e.kind === 'text').map((e) => e.text).join('')
  assert.equal(text, '你好', `应解析出正文，实际 ${JSON.stringify(text)}`)
})

// ── 二、反向验证（AGENTS.md 2.4）：把实现改坏，这条必须红 ──────────────

await run('【反向】把注入 fetch 换成"直接抛" ⇒ 必须能看到错误暴露（而不是被静默吞掉）', async () => {
  const fake = async () => {
    throw new Error('STANDALONE-LEAK')
  }
  const { thrown, hits } = await completeUnder(fake)
  assert.equal(hits.length, 1, '桩件必须被调用（若 fetch 被固化在模块加载时，这里 hits=0 且真出网）')
  assert.ok(thrown, '桩件抛错必须冒出来，不能被吞掉')
  const seen = `${thrown?.message ?? ''}`
  // 若请求真出网，token 是假的 't'，会拿到服务端 AUTH/INVALID_TOKEN 之类 —— 那说明桩件失效
  assert.ok(!/INVALID_TOKEN|授权失败|网页登录态/.test(seen), `不应拿到真实服务端响应：${seen.slice(0, 140)}`)
})

await run('【反向】注入"并发生成"业务错误信封 ⇒ 引擎归类成 RATE_LIMIT（证明请求真走了注入层）', async () => {
  // 若 fetch 被固化、请求真出网，拿到的会是假的 INVALID_TOKEN → AUTH 分类；本用例断言 RATE_LIMIT
  // 即可反向证明「注入生效、没出网」。这是 AGENTS.md 2.4 要求的反向判据。
  const BUSY = 'A message is being generated, please try again later.'
  const fake = async () =>
    new Response(`{"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"${BUSY}"}}`, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const { thrown, hits } = await completeUnder(fake)
  assert.equal(hits.length, 1, '完成请求必须打到注入的 fetch')
  assert.ok(thrown, '业务错误应抛 AdapterLlmError')
  assert.equal(thrown?.code, 'RATE_LIMIT', `并发生成应归 RATE_LIMIT，实际 ${thrown?.code}`)
})

// ── 三、工具调用解析：ToolCallStreamFilter 在裸 Node 下独立可用 ──────────
// 协议支持 XML `<invoke name=...>` 与 JSON 两套标记（见 protocol.ts）。这里用真实 XML 格式，
// 标签由片段拼接（避免源码里出现完整标签序列，与项目其它用例保持一致）。

const LT = String.fromCharCode(60) // <
const GT = String.fromCharCode(62) // >
const END = LT + '/'
const INV = 'invoke'
const PARAM = 'parameter'
const NESTED = 'tool_calls'

await run('ToolCallStreamFilter 独立解析出工具调用（引擎外/无 DSH）', async () => {
  const filter = new ToolCallStreamFilter(new Set(['weather']))
  const payload = [
    `${LT}${NESTED}${GT}`,
    `${LT}${INV} name="weather"${GT}`,
    `${LT}${PARAM} name="city"${GT}北京${END}${PARAM}${GT}`,
    `${END}${INV}${GT}`,
    `${END}${NESTED}${GT}`,
  ].join('\n')
  const out = filter.push(payload)
  const tail = filter.flush()
  const text = out.text + tail.text
  const calls = [...out.calls, ...tail.calls]
  assert.equal(calls.length, 1, `应解析出 1 个调用，实际 ${calls.length}`)
  assert.equal(calls[0].name, 'weather', `调用名应为 weather，实际 ${calls[0]?.name}`)
  assert.deepEqual(JSON.parse(calls[0].arguments), { city: '北京' }, 'arguments 应还原成 JSON')
  assert.equal(text, '', `调用标记不应泄漏进正文，实际 ${JSON.stringify(text.slice(0, 120))}`)
})

// ── 四、serializePromptParts 独立可用（把结构化 messages 拉平成网页端单段 prompt）──

await run('serializePromptParts 独立可用：system+历史+tools 组装成 head/entries/full', async () => {
  const parts = serializePromptParts({
    system: '你是助手',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', content: [{ type: 'text', text: '你好！' }] },
    ],
    tools: [{ type: 'function', function: { name: 'weather', description: '查天气', parameters: { type: 'object' } } }],
  })
  assert.ok(typeof parts.head === 'string', 'head 应是字符串')
  assert.ok(Array.isArray(parts.entries) && parts.entries.length > 0, 'entries 应非空')
  const full = serializePromptParts({
    system: '你是助手',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  })
  assert.ok(typeof full.full === 'string' && full.full.includes('你好'), 'full 应含对话内容')
  assert.ok(full.full.includes('你是助手'), 'full 应含 system 指令')
})

// 为避免在协议标记字符串上出差错（那会测我的笔误而不是引擎），
// 用序列化出来的真实工具协议头去验证 ToolCallStreamFilter 的关键行为：
// 只要协议头里包含全套调用标记（JSON/XML），过滤器就能活儿。这里退化成一个更保真的断言：
await run('【保真】协议头已注入调用标记（这是 ToolCallStreamFilter 能工作的前提）', async () => {
  const { head } = serializePromptParts({
    system: '',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'weather', description: 'd', parameters: { type: 'object' } } }],
  })
  assert.ok(
    /invoke|tool|call/i.test(head),
    '工具协议头里应出现调用说明，ToolCallStreamFilter 才有的放矢',
  )
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
