/**
 * 引擎事件（WebStreamEvent）→ OpenAI SSE chunk / 整包 JSON 转换。
 *
 * 映射（src/webapi.ts:1322）：
 *   text     → choices[0].delta.content
 *   thinking → choices[0].delta.reasoning_content（非标准扩展字段，仅 thinking 时出现）
 *   status   → 忽略
 *   finish   → 末尾 chunk 的 finish_reason + usage
 *   error    → 调用方以 HTTP 错误 / SSE error 处理（本模块不吞，向上抛）
 *
 * usage（网页端不返回精确 token）：total 用服务端 `finish.totalTokens`（若给），
 * input/output 用本地估算（prompt 估算 input、累计正文算 output）。
 */
import { estimateTokens } from '../model.ts'
import type { CompletionParams, WebStreamEvent } from '../../src/webapi.ts'
import type { OpenAIChatChunk, OpenAIChatCompletion, OpenAIUsage } from './types.ts'

let idCounter = 0
/** 每次请求生成唯一的补全 id（线程内自增，前缀带随机）。 */
export function newCompletionId(): string {
  idCounter = (idCounter + 1) % 0xffffff
  return `chatcmpl-dsw-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

/**
 * 收齐一次引擎流，供「非流式」整包响应使用。
 * 不抛错：error 事件折进 `error` 字段返回（调用方决定 HTTP 状态）。
 */
export async function consumeStream(
  stream: AsyncGenerator<WebStreamEvent>,
): Promise<{
  text: string
  thinking: string
  finishReason: 'stop' | 'length' | null
  totalTokens: number | undefined
  error: { message: string; code?: string } | undefined
}> {
  let text = ''
  let thinking = ''
  let finishReason: 'stop' | 'length' | null = null
  let totalTokens: number | undefined
  let error: { message: string; code?: string } | undefined
  for await (const event of stream) {
    if (event.kind === 'text') text += event.text
    else if (event.kind === 'thinking') thinking += event.text
    else if (event.kind === 'finish') {
      finishReason = event.reason === 'length' ? 'length' : 'stop'
      if (typeof event.totalTokens === 'number' && Number.isFinite(event.totalTokens)) totalTokens = event.totalTokens
    } else if (event.kind === 'error') {
      error = { message: event.message, code: event.code }
      break
    }
  }
  return { text, thinking, finishReason, totalTokens, error }
}

/** 本地估算 usage（total 优先服务端，否则 input+output 求和）。 */
export function estimateUsage(
  prompt: string,
  output: string,
  serverTotal: number | undefined,
): OpenAIUsage {
  const input = estimateTokens(prompt)
  const completion = estimateTokens(output)
  return {
    prompt_tokens: input,
    completion_tokens: completion,
    total_tokens: serverTotal ?? input + completion,
  }
}

/**
 * 把一帧增量变成一个 OpenAI chunk 对象。
 * @param delta 本帧的 delta 字段（content / reasoning_content）。
 * @param finish 本帧是否收尾 + finish_reason。
 * @param meta id/model（可由 newCompletionId 提供）。
 */
export function makeChunk(
  meta: { id: string; model: string; created: number },
  delta: { content?: string; reasoning_content?: string } | undefined,
  finish: { reason: 'stop' | 'length' | null } | undefined,
): OpenAIChatChunk {
  const choices: OpenAIChatChunk['choices'] = [
    {
      index: 0,
      delta: {},
      finish_reason: finish?.reason ?? null,
    },
  ]
  if (delta?.content !== undefined) (choices[0].delta as any).content = delta.content
  if (delta?.reasoning_content !== undefined) (choices[0].delta as any).reasoning_content = delta.reasoning_content
  if (finish?.reason === null) choices[0].delta.role = 'assistant'
  return { id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: meta.model, choices }
}

/** 把一帧 chunk 序列化成 SSE 的 `data: <json>` 行（末尾带空行）。 */
export function sseDataLine(chunk: OpenAIChatChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/** 非流式整包：把聚合结果组装成 OpenAI ChatCompletion。 */
export function toCompletionObject(
  meta: { id: string; model: string; created: number },
  consumed: Awaited<ReturnType<typeof consumeStream>>,
  prompt: CompletionParams['prompt'],
  usage: OpenAIUsage,
): OpenAIChatCompletion {
  return {
    id: meta.id,
    object: 'chat.completion',
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: consumed.text || null,
          ...(consumed.thinking ? { reasoning_content: consumed.thinking } : {}),
        },
        finish_reason: consumed.finishReason,
      },
    ],
    usage,
  }
}
