/**
 * OpenAI 兼容 HTTP 服务（node:http，无框架）。
 *
 * 路由：
 *   POST /v1/chat/completions   —— 补全（stream:true → SSE；false → 整包 JSON）
 *   GET  /v1/models             —— 模型列表
 *
 * 处理链（风控优先）：
 *   Bearer 校验 → readAccount(accountId) 精确取号（不碰全局 activeAccount）
 *   → 该账号的 gate.acquire（串行 + 随机间隔）→ 序列化 → engine 流 → OpenAI 格式
 *   → 客户端断开即 abort → 引擎错归类成 HTTP 状态。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { KeyRegistry, KeyEntry } from '../api-key/keys.ts'
import { authenticate } from './auth.ts'
import { sendJson, sendText, startSse, DONE_MARKER } from './sse.ts'
import { listAccounts, readAccount } from '../../src/accounts.ts'
import { streamWebCompletion } from '../../src/webapi.ts'
import { flushSessions, gateFor, installSessionJournal } from '../runtime.ts'
import { toCompletionParams, buildCompletionParams } from '../openai/to-engine.ts'
import { consumeStream, makeChunk, newCompletionId, toCompletionObject, estimateUsage, sseDataLine } from '../openai/from-engine.ts'
import type { OpenAIChatCompletionRequest } from '../openai/types.ts'
import type { WebAuth } from '../../src/auth.ts'
import type { PoolManager, PoolManagers } from '../pool/pool.ts'

export interface ServerDeps {
  registry: KeyRegistry
  /** 会话删除开关（默认 true）。 */
  deleteWebSessions?: boolean
  /** 是否记录会话 journal（默认跟随 deleteWebSessions）。 */
  allowJournal?: boolean
  /** 会话清理模式：'keep' = 用户要求不删（默认即删）。 */
  keepSessions?: boolean
  /** 日志器。 */
  log?: (line: string) => void
  /** 账号池管理器（带 poolScope 的 key → PoolManager）。缺省 = 全部单号直通。 */
  poolManagers?: PoolManagers
  /**
   * `maxPromptChars` 体量阀（风控）：单次发送 prompt 的字符上限，超出走中段截断。
   * 缺省 400_000（复用 `src/gate.ts` 的默认 —— 低密度默认，不顶格 1M）。
   */
  maxPromptChars?: number
  /** 长任务强制休整阈值（连续触发 N 次后长休；0 = 关）。缺省 15（src/gate.ts 同源）。 */
  longRunThreshold?: number
}

interface Account {
  id: string
  auth: WebAuth
  /** 稳定 key 短标（dshSessionId 前缀，跨账号稳定）。 */
  keyShortBase: string
}

function httpErrorStatus(code: string | undefined): number {
  switch (code) {
    case 'AUTH':
      return 401
    case 'RATE_LIMIT':
    case 'THROTTLED':
      return 429
    case 'TIMEOUT':
      return 504
    case 'TRANSPORT':
    case 'PROVIDER_ERROR':
      return 502
    default:
      return 500
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 2_000_000) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function startServer(deps: ServerDeps, port: number, host = '127.0.0.1'): ReturnType<typeof createServer> {
  const log = deps.log ?? (() => {})
  const deleteEnabled = deps.deleteWebSessions !== false
  const keepSessions = deps.keepSessions === true
  installSessionJournal(deps.allowJournal ?? deleteEnabled, keepSessions)

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      void handleCompletion(req, res, deps).catch((error) => {
        sendJson(res, httpErrorStatus(error?.code), { error: { message: error?.message ?? String(error), type: 'server_error' } })
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: [
          { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek-web' },
          { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek-web' },
        ],
      })
      return
    }
    sendText(res, 404, 'not found')
  })

  // 优雅退出：flush 会话清理
  const shutdown = (): void => {
    try {
      flushSessions()
    } catch {
      /* noop */
    }
    server.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  server.listen(port, host, () => {
    log(`deepseek-web-api listening on http://${host}:${port}`)
  })
  return server
}

interface LoadedAccount {
  account: Account
  entry: KeyEntry
}

function loadAccount(
  req: IncomingMessage,
  deps: ServerDeps,
): LoadedAccount | { error: { status: number; message: string } } {
  const auth = authenticate(deps.registry, req.headers.authorization)
  if (!auth.ok) {
    return { error: { status: 401, message: 'Invalid or missing API key' } }
  }
  const entry = auth.entry
  const keyShortBase = stableKeyShort(entry.key)

  // 池 key：per-request 选号（health-aware；round-robin / failover 由 PoolManager 决定）。
  const manager = deps.poolManagers?.get(entry.key)
  if (manager && entry.poolScope) {
    const picked = manager.selectAccount(entry.accountId, () => listAccounts(), Date.now())
    const record = picked.auth ?? readAccount(picked.accountId)
    if (!record) {
      return { error: { status: 401, message: 'Account not found for this key' } }
    }
    return { account: { id: picked.accountId, auth: record as WebAuth, keyShortBase }, entry }
  }

  // 单账号直通（默认）：精确取号，不碰全局 activeAccount（既有约定）。
  const record = readAccount(entry.accountId)
  if (!record) {
    return { error: { status: 401, message: 'Account not found for this key' } }
  }
  return { account: { id: entry.accountId, auth: record as WebAuth, keyShortBase }, entry }
}

/** 从 key 原文导出稳定的短标（dshSessionId 前缀用，跨账号稳定、不泄漏 key）。 */
function stableKeyShort(key: string): string {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36).slice(-8)
}

async function handleCompletion(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const first = loadAccount(req, deps)
  if ('error' in first) {
    sendJson(res, first.error.status, { error: { message: first.error.message, type: 'invalid_request_error' } })
    return
  }
  const entry = first.entry

  let bodyText: string
  try {
    bodyText = await readBody(req)
  } catch (error: any) {
    sendText(res, 400, error?.message ?? 'bad request')
    return
  }
  let parsed: OpenAIChatCompletionRequest
  try {
    parsed = JSON.parse(bodyText || '{}')
  } catch {
    sendJson(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } })
    return
  }

  const stream = parsed.stream === true
  const sessionHint = (req.headers['x-session-id'] as string | undefined) || parsed.user
  const keyShort = first.account.keyShortBase
  // 池 failover 是否启用：key 绑定了 pool-failover 池（默认关，见 server/pool/pool.ts）。
  const manager = deps.poolManagers?.get(entry.key)
  const failable = Boolean(manager && entry.poolScope === 'pool-failover')

  const controller = new AbortController()
  const onClose = (): void => controller.abort()
  res.on('close', onClose)
  req.on('aborted', onClose)
  const maxPromptChars = deps.maxPromptChars

  let account = first.account
  let release: (() => void) | undefined
  try {
    // 串行闸门：同账号共享一把锁（切号/failover 后为新账号重排）。
    // 长任务休整阈值随配置走（缺省 15）；gate 按账号缓存、首次创建时生效。
    const gate = gateFor(account.id, deps.longRunThreshold !== undefined ? { longRunThreshold: deps.longRunThreshold } : {})
    release = await gate.acquire('chat', controller.signal)
  } catch (error: any) {
    if (controller.signal.aborted) {
      return
    }
    sendJson(res, 503, { error: { message: error?.message ?? 'gate', type: 'server_error' } })
    return
  }

  try {
    if (stream) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        // 只在"还没写任何响应"时才可能透明换号重试；SSE 已开始就无法回滚了。
        const input = toCompletionParams(parsed, keyShort, sessionHint, maxPromptChars)
        const engine = streamWebCompletion(
          account.auth,
          buildCompletionParams(input, {
            signal: controller.signal,
            idleTimeoutMs: 180_000,
            ...(deps.deleteWebSessions !== false
              ? { onDeleteSession: (sid: string) => void scheduleDelete(account.auth, sid) }
              : {}),
            ...(failable ? { canFailover: failoverGate(manager!, account.id) } : {}),
          }),
        )
        try {
          await handleStream(res, engine, input.prompt, parsed, account, controller.signal)
          return
        } catch (error: any) {
          if (controller.signal.aborted) return
          if (res.headersSent) throw error // 已写过 SSE，退回普通错误帧
          const kind = failoverKind(error?.code)
          if (attempt < 2 && failable && kind && manager!.canFailover(true, { kind, accountId: account.id, list: () => listAccounts(), now: Date.now() })) {
            onFailoverThrottle(manager, kind, account.id)
            const next = manager!.nextAfterFailover(account.id, () => listAccounts(), Date.now())
            if (next && next !== account.id) {
              manager!.noteSwitched(Date.now())
              const picked = listAccounts().find((a) => a.id === next)
              if (picked) {
                release?.()
                account = { id: next, auth: picked as WebAuth, keyShortBase: keyShort }
                release = await gateFor(next).acquire('chat', controller.signal)
                continue // 重试，用新账号
              }
            }
          }
          throw error
        }
      }
    } else {
      const input = toCompletionParams(parsed, keyShort, sessionHint, maxPromptChars)
      const engine = streamWebCompletion(
        account.auth,
        buildCompletionParams(input, {
          signal: controller.signal,
          idleTimeoutMs: 180_000,
          ...(deps.deleteWebSessions !== false
            ? { onDeleteSession: (sid: string) => void scheduleDelete(account.auth, sid) }
            : {}),
          ...(failable ? { canFailover: failoverGate(manager!, account.id) } : {}),
        }),
      )
      await handleNonStream(res, engine, input.prompt, parsed, controller.signal)
    }
  } catch (error: any) {
    // 客户端断开不算错
    if (controller.signal.aborted) return
    if (!res.headersSent) {
      const status = httpErrorStatus(error?.code)
      // 节流/限流 → 429 + Retry-After，让标准 OpenAI 客户端按退避重试
      if (status === 429 && Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))))
      }
      sendJson(res, status, { error: { message: error?.message ?? String(error), type: 'server_error' } })
    } else {
      try { res.write(`data: ${JSON.stringify({ error: { message: error?.message ?? String(error) } })}\n\n`) } catch { /* noop */ }
    }
  } finally {
    release?.()
    res.removeListener('close', onClose)
    req.removeListener('aborted', onClose)
    if (!res.writableEnded) res.end()
  }
}

/**
 * 给 engine 注入的 `canFailover`（与池选号同源）。
 * 只回答"这次失败要不要给短退避、能不能换号"；真正的换号由外层 failover 循环做。
 */
function failoverGate(manager: PoolManager, accountId: string): (kind?: 'muted' | 'throttled' | 'auth') => boolean {
  return (kind) => {
    try {
      return manager.canFailover(true, { kind, accountId, list: () => listAccounts(), now: Date.now() })
    } catch {
      return false
    }
  }
}

/** 把 engine 错误码归类成 failover kind（不可换的返回 undefined）。 */
function failoverKind(code: string | undefined): 'muted' | 'throttled' | 'auth' | undefined {
  if (!code) return undefined
  if (/auth/i.test(code)) return 'auth'
  if (code === 'THROTTLED' || code === 'RATE_LIMIT') return 'throttled'
  if (/muted/i.test(code)) return 'muted'
  return undefined
}

/** 失败换号/限流时，记下账号被限流（throttleAt，仅进程内）。 */
function onFailoverThrottle(manager: PoolManager, kind: string, accountId: string): void {
  if (kind === 'throttled' || kind === 'muted') manager.noteThrottled(accountId, Date.now())
}

function scheduleDelete(auth: WebAuth, sessionId: string): void {
  // webapi 的模块级 defaultCleaner 会在延迟后发 DELETE；退役会话也一并清理。
  void import('../../src/webapi.ts').then((m) => m.scheduleDeleteSession(auth, sessionId)).catch(() => {})
}

async function handleStream(
  res: ServerResponse,
  engine: AsyncGenerator<any>,
  prompt: string,
  parsed: OpenAIChatCompletionRequest,
  account: Account,
  signal: AbortSignal,
): Promise<void> {
  const write = startSse(res)
  const id = newCompletionId()
  const created = Math.floor(Date.now() / 1000)
  const model = typeof parsed?.model === 'string' ? parsed.model : 'deepseek-chat'
  const meta = { id, model, created }

  let textAcc = ''
  for await (const event of engine) {
    if (signal.aborted) return
    if (event.kind === 'thinking') {
      write(sseDataLine(makeChunk(meta, { reasoning_content: event.text }, { reason: null })))
    } else if (event.kind === 'text') {
      textAcc += event.text
      write(sseDataLine(makeChunk(meta, { content: event.text }, { reason: null })))
    } else if (event.kind === 'status') {
      // 忽略状态帧
    } else if (event.kind === 'finish') {
      const reason = event.reason === 'length' ? 'length' : 'stop'
      write(sseDataLine(makeChunk(meta, undefined, { reason })))
      if (event.totalTokens !== undefined) {
        const usage = estimateUsage(prompt, textAcc, event.totalTokens)
        // OpenAI 某些客户端在最后一个 chunk 带 usage；追加一个 usage-only 帧
        const finalChunk = makeChunk(meta, undefined, undefined)
        ;(finalChunk as any).usage = usage
        write(sseDataLine(finalChunk))
      }
      write(DONE_MARKER)
      return
    } else if (event.kind === 'error') {
      const status = httpErrorStatus(event.code)
      write(`data: ${JSON.stringify({ error: { message: event.message, type: event.code } })}\n\n`)
      write(DONE_MARKER)
      void status
      return
    }
  }
  // 引擎正常结束（无 finish 事件）：兜底收尾
  write(sseDataLine(makeChunk(meta, undefined, { reason: 'stop' })))
  write(DONE_MARKER)
}

async function handleNonStream(
  res: ServerResponse,
  engine: AsyncGenerator<any>,
  prompt: string,
  parsed: OpenAIChatCompletionRequest,
  signal: AbortSignal,
): Promise<void> {
  void signal
  const consumed = await consumeStream(engine)
  const id = newCompletionId()
  const created = Math.floor(Date.now() / 1000)
  const model = typeof parsed?.model === 'string' ? parsed.model : 'deepseek-chat'
  const meta = { id, model, created }

  if (consumed.error) {
    sendJson(res, httpErrorStatus(consumed.error.code), {
      error: { message: consumed.error.message, type: consumed.error.code },
    })
    return
  }
  const usage = estimateUsage(prompt, consumed.text + consumed.thinking, consumed.totalTokens)
  const full = toCompletionObject(meta, consumed, prompt, usage)
  sendJson(res, 200, full)
}
