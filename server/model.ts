/**
 * 模型解析与 token 估算 —— 复刻 `src/adapter.ts` 里**私有**（未 export）的函数。
 *
 * 为什么复刻而不是 import：`resolveSpec` / `resolveThinking` / `MODEL_SPECS` 在 adapter.ts
 * 里是模块内私有（adapter.ts:276/:552/:565）。独立服务不该 import 整个 adapter.ts
 * （它会连带 AdapterDeps 那堆 DSH 宿主钩子）。这几段逻辑很小、且以服务端目录为准，
 * 直接按同样语义搬过来，来源行号已标注。若服务端目录变动需同步这里。
 */
import { AdapterLlmError } from '../src/auth.ts'

export interface ModelSpec {
  id: string
  name: string
  modelType: 'default' | 'expert' | 'vision'
  thinking: boolean
  configurableThinking: boolean
  contextWindow: number
  maxOutputTokens: number
}

/** 与 src/adapter.ts:276 的 MODEL_SPECS 同源（网页免费模型目录，见该处注释）。 */
export const MODEL_SPECS: ModelSpec[] = [
  {
    id: 'deepseek-chat',
    name: 'DeepSeek 网页 · 快速模式（不思考）',
    modelType: 'default',
    thinking: false,
    configurableThinking: true,
    contextWindow: 1_048_576,
    maxOutputTokens: 16_384,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek 网页 · 快速模式（深度思考）',
    modelType: 'default',
    thinking: true,
    configurableThinking: true,
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
  },
]

/** 与 src/adapter.ts:303 的 LEGACY_ALIASES 同源。 */
const LEGACY_ALIASES: Record<string, string> = {
  'deepseek-pro': 'deepseek-reasoner',
  'deepseek-expert': 'deepseek-reasoner',
  'deepseek-vision': 'deepseek-chat',
}

const EFFORT_OFF = 'off'
const EFFORT_LOW = 'low'
const EFFORT_HIGH = 'high'
const EFFORT_MAX = 'max'

/** 与 src/adapter.ts:552 同义：把模型字符串解析成目录条目（未知回落 chat/不思考）。 */
export function resolveSpec(model: string | undefined | null): ModelSpec {
  const requested = String(model ?? '')
  const direct = MODEL_SPECS.find((spec) => spec.id === requested)
  if (direct) return direct
  const alias = LEGACY_ALIASES[requested]
  if (alias) {
    const mapped = MODEL_SPECS.find((spec) => spec.id === alias)
    if (mapped) return mapped
  }
  return MODEL_SPECS[0]
}

/** 与 src/adapter.ts:565 同义：解析本次请求的思考开关。 */
export function resolveThinking(model: string | undefined | null, reasoningEffort?: unknown): boolean {
  const spec = resolveSpec(model)
  if (!spec.configurableThinking) return spec.thinking
  if (reasoningEffort === undefined || reasoningEffort === null) return spec.thinking
  const effort = String(reasoningEffort)
  if (effort === EFFORT_OFF) return false
  if (effort === EFFORT_LOW || effort === EFFORT_HIGH || effort === EFFORT_MAX) return true
  throw new AdapterLlmError(
    `deepseek-web 不支持 reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** 与 src/adapter.ts:323 同义：网页端不返回 usage，本地估算（CJK ~1.5 字符/token、ASCII ~4）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x3000 && code <= 0x9fff) cjk += 1
  }
  const ascii = text.length - cjk
  return Math.ceil(cjk / 1.5 + ascii / 4)
}
