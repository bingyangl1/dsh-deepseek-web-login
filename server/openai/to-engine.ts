/**
 * OpenAI Chat Completion 请求 → 引擎（CompletionParams）输入。
 *
 * 核心职责：
 *   - 把 OpenAI messages/system/model 序列化成网页端单段 prompt（复用 src/protocol.ts）
 *   - 解析思考开关（复用 server/model.ts 的 resolveThinking，它复刻 adapter 私有函数）
 *   - 派发稳定的 dshSessionId（会话分槽，防串窗）
 *   - 忽略网页端不支持的字段（temperature/stop/max_tokens/top_p —— 见 src/adapter.ts:6-7）
 */
import { createHash } from 'node:crypto'
import { serializePromptParts } from '../../src/protocol.ts'
import type { CompletionParams } from '../../src/webapi.ts'
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from './types.ts'
import { resolveSpec, resolveThinking } from '../model.ts'

/** 把文本 content（string 或 parts 数组）抽成 DSH 内部 text 块结构。 */
function normalizeTextContent(content: unknown): Array<{ type: string; text?: string }> {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    const out: Array<{ type: string; text?: string }> = []
    for (const part of content) {
      if (part && typeof part === 'object') {
        const p = part as { type?: string; text?: string; image_url?: unknown }
        if (p.type === 'text' || typeof p.text === 'string') out.push({ type: 'text', text: p.text ?? '' })
        else if (p.type === 'image_url' || p.image_url !== undefined) {
          // 图片输入：阶段二不做（网页端要经 uploadImageFile 上传，属于后续增强）。
          // 序列化器会把它当占位/忽略 —— 这里显式标注，避免静默丢内容。
          out.push({ type: 'text', text: '[image omitted: 本服务暂不支持图片输入]' })
        }
      }
    }
    return out
  }
  return []
}

/** OpenAI messages → DSH 内部 message 结构（可持续序列化）。工具消息暂降级为文本。 */
export function toDsMessages(messages: OpenAIChatMessage[] | undefined): any[] {
  const out: any[] = []
  for (const msg of messages ?? []) {
    const role = typeof msg.role === 'string' ? msg.role : 'user'
    if (role === 'system') continue // system 单独走（见 toCompletionParams）
    out.push({ role, content: normalizeTextContent(msg.content) })
  }
  return out
}

/** 抽出 system 提示（多条时用换行拼）。 */
export function extractSystem(messages: OpenAIChatMessage[] | undefined): string {
  return (messages ?? [])
    .filter((m) => m?.role === 'system')
    .map((m) => {
      const c = m?.content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' ? (p as any).text ?? '' : '')).join('\n')
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 派发会话延续的 dshSessionId（风控：防串窗）。
 *   - 带 user（或 x-session-id）⇒ 稳定值（同 user 复用网页端会话，上下文延续）
 *   - 不带 ⇒ 每次新值（每请求独立会话，默认零串窗）
 * 前缀 `api:` 让独立服务的槽与 DSH 主进程隔离（见方案第四节）。
 */
export function deriveSessionId(keyShort: string, sessionHint: string | undefined): string {
  if (sessionHint) {
    const hash = createHash('sha256').update(sessionHint).digest('hex').slice(0, 16)
    return `api:${keyShort}:${hash}`
  }
  return `api:${keyShort}:${randomSuffix()}`
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

export interface EngineCallInput {
  prompt: string
  thinkingEnabled: boolean
  modelType: 'default' | 'expert' | 'vision'
  dshSessionId: string
  /** 有 user ⇒ 20 轮复用；无 user ⇒ 0（每请求新会话，用完即退役）。 */
  sessionReuseTurns: number
  maxPromptChars?: number
  /**
   * 结构化 prompt（链式投喂 + 会话分槽用）。
   *
   * 🔴 上下文污染规避的关键（方案 Step 1）：只有传了 `promptParts`，`src/webapi.ts` 的
   * `requestSlotKey` 才会把请求路由到「账号|dshSessionId」槽 —— 每 user 一条链 / 一个网页端会话；
   * 不传则所有真实请求都落进共享的 `internal|<account>` 槽（跨 user 串上下文）。
   *
   * 只在**有稳定会话标识**（user / x-session-id）时才传：无标识的请求本来就是"每请求独立会话、
   * 用完即删"（`sessionReuseTurns: 0`），没有跨请求身份可延续，传了反而让它们占了会话槽。
   */
  promptParts?: { head: string; entries: readonly string[]; maxChars?: number }
}

/**
 * 把 OpenAI 请求转成引擎调用输入。
 * @param keyShort 映射该请求 API-Key 的短标识（用于 dshSessionId 前缀）。
 * @param sessionHint 会话延续标识（user 或 x-session-id），可为空。
 * @param maxPromptChars `maxPromptChars` 体量阀（风控）：传给序列化器做中段截断，缺省
 *        120_000（serializePromptParts 默认）。下界 128 由序列化器强校验。
 */
export function toCompletionParams(
  req: OpenAIChatCompletionRequest,
  keyShort: string,
  sessionHint: string | undefined,
  maxPromptChars?: number,
): EngineCallInput {
  const model = typeof req?.model === 'string' ? req.model : 'deepseek-chat'
  const spec = resolveSpec(model)
  const system = extractSystem(req?.messages)
  const messages = toDsMessages(req?.messages)

  const parts = serializePromptParts({
    system,
    messages,
    // 工具目录：阶段二不展开（tools 在阶段三）；留空让序列化器走纯文本协议。
    tools: undefined,
    serialToolCalls: true,
    ...(maxPromptChars ? { maxChars: maxPromptChars } : {}),
  })

  const hasSession = Boolean(sessionHint)
  return {
    prompt: parts.full,
    thinkingEnabled: resolveThinking(model, req?.reasoning_effort),
    modelType: spec.modelType,
    dshSessionId: deriveSessionId(keyShort, sessionHint || undefined),
    sessionReuseTurns: hasSession ? 20 : 0,
    // 只在有稳定会话标识时启用链式/分槽（见字段注释）。部件不含 `full` ——
    // `CompletionParams.promptParts` 只要 head+entries 就够算增量，prompt 仍单独传。
    ...(hasSession
      ? {
          promptParts: {
            head: parts.head,
            entries: parts.entries,
            ...(maxPromptChars ? { maxChars: maxPromptChars } : {}),
          } satisfies CompletionParams['promptParts'],
        }
      : {}),
  }
}

/** 组装真正传给引擎的 CompletionParams（不含会话清理钩子，那由调用方注入）。 */
export function buildCompletionParams(
  input: EngineCallInput,
  extra: Partial<CompletionParams> = {},
): CompletionParams {
  const { prompt, thinkingEnabled, modelType, dshSessionId, sessionReuseTurns, promptParts } = input
  return {
    prompt,
    thinkingEnabled,
    modelType,
    dshSessionId,
    sessionReuseTurns,
    ...(promptParts ? { promptParts } : {}),
    ...extra,
  }
}
