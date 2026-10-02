/**
 * OpenAI Chat Completions 请求/响应/SSE 的最小类型面。
 *
 * 只覆盖本服务实际支持的字段；网页端没有的（temperature/stop/top_p/max_tokens 等）
 * 在 to-engine.ts 里被**忽略**（网页端无 temperature/stop/max_tokens，见 src/adapter.ts:6-7）。
 * 类型字段保持宽松，避免被 OpenAI 客户端多塞几个字段就 TypeScript 报错。
 */

export interface OpenAIChatMessageContentPart {
  type?: string
  text?: string
  image_url?: { url?: string } | string
}

export interface OpenAIChatMessage {
  role?: string
  content?: string | OpenAIChatMessageContentPart[]
  name?: string
  tool_call_id?: string
  tool_calls?: unknown[]
}

export interface OpenAIToolParam {
  type?: string
  function?: {
    name?: string
    description?: string
    parameters?: unknown
  }
}

/** 收到的最小补全请求。未知/额外字段一律忽略，type 本身保持宽松。 */
export interface OpenAIChatCompletionRequest {
  model?: string
  messages?: OpenAIChatMessage[]
  stream?: boolean
  /** 非标准扩展：经 resolveThinking 决定思考开关。 */
  reasoning_effort?: string
  /** 会话延续标识（OpenAI user 字段）；同 user 复用网页端会话，缺省每请求独立会话。 */
  user?: string
  /** 自定义会话延续头（本服务扩展，优先级高于 user）。 */
  // eslint-disable-next-line
  // （HTTP 层从 x-session-id 头读取，不进 body）
  tools?: OpenAIToolParam[]
  temperature?: unknown
  top_p?: unknown
  max_tokens?: unknown
  stop?: unknown
  /** 附加在 body 上的服务内透传（HTTP 层写入，如 signal / x-session-id）。 */
  [key: string]: unknown
}

export interface OpenAIUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  reasoning_tokens?: number
}

/** 非流式整包响应。 */
export interface OpenAIChatCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | null
  }>
  usage?: OpenAIUsage
}

/** SSE 流式帧（data: <json>）。 */
export interface OpenAIChatChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | null
  }>
  usage?: OpenAIUsage
}
