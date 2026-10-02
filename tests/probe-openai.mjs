/**
 * 阶段一（OpenAI API 化改造）可行性「真实探路」：
 * 用**当前账号库的登录态**，在**无 DSH 宿主**的裸 Node 下直接调引擎 `streamWebCompletion`，
 * 跑一次真实生成，确认「引擎当库复用 → 对外 API 服务」最关键的路线成立。
 *
 * 用法：node tests/probe-openai.mjs ["自定义提示词"] [modelType] [thinking true/false]
 *
 * ⚠️ 与所有 probe-*.mjs 一样：会打真实网络、消耗一点免费额度，**不进入自动化**。
 * ⚠️ 凭证安全（AGENTS.md 2.5）：只在本机读当前账号，绝不打印 / 回传 token、cookie。
 */
import { readAuth } from '../src/auth.ts'
import { streamWebCompletion } from '../src/webapi.ts'
import { serializePromptParts } from '../src/protocol.ts'
import { maskIdentifier } from '../src/auth.ts'

const auth = readAuth()
if (!auth) {
  console.error('[probe-openai] 没有当前账号（readAuth() 为空）。请先在 DSH 里添加并选择账号，或提供凭证。')
  process.exit(1)
}

const rawPrompt = process.argv[2] || '请用一句话回答：网页版 DeepSeek 接口在裸 Node 下能否被直接调用？'
const modelType = process.argv[3] || 'default'
const thinking = process.argv[4] === 'true'

// 用协议序列化器把这条用户消息转成网页端 single prompt（验证独立服务那层适配也能用引擎的序列化）
const { full } = serializePromptParts({
  system: '',
  messages: [{ role: 'user', content: [{ type: 'text', text: rawPrompt }] }],
})

const started = Date.now()
let firstByte = null
let textLen = 0
let thinkingLen = 0
const statuses = []
let finish = null
let error = null

console.log(
  `[probe-openai] 账号=${maskIdentifier(auth.user?.display) || maskIdentifier(auth.token)} ` +
    `modelType=${modelType} thinking=${thinking}`,
)
console.log(`[probe-openai] prompt=${rawPrompt.slice(0, 60)}…`)

try {
  for await (const event of streamWebCompletion(
    auth,
    {
      prompt: full,
      thinkingEnabled: thinking,
      modelType,
      idleTimeoutMs: 180_000,
    },
  )) {
    const at = Date.now() - started
    if (firstByte === null && (event.kind === 'text' || event.kind === 'thinking')) firstByte = at
    if (event.kind === 'text') textLen += event.text.length
    else if (event.kind === 'thinking') thinkingLen += event.text.length
    else if (event.kind === 'status') statuses.push(`${event.value}@${at}ms`)
    else if (event.kind === 'finish') finish = { reason: event.reason, totalTokens: event.totalTokens, atMs: at }
    else if (event.kind === 'error') error = { message: event.message, code: event.code, atMs: at }
  }
} catch (thrown) {
  error = { thrown: String(thrown?.message ?? thrown), code: thrown?.code }
}

console.log(
  JSON.stringify(
    {
      verdict: error ? 'FAIL' : 'OK',
      totalMs: Date.now() - started,
      firstTokenMs: firstByte,
      textChars: textLen,
      thinkingChars: thinkingLen,
      statuses,
      finish,
      error,
      note: 'OK ⇒ 引擎可在裸 Node 下用账号库登录态真实生成，阶段一可行性成立',
    },
    null,
    2,
  ),
)

process.exitCode = error ? 1 : 0
