/**
 * HTTP 侧小工具：响应头/JSON + SSE 写帧。
 * 刻意自包含（复制自 src/index.ts 的 sendJson 思路），不 import index.ts ——
 * 那是 DSH 插件入口，独立进程不该碰它。
 */
import type { ServerResponse } from 'node:http'

/** 写一个 JSON 响应（可带状态码）。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 写一个纯文本错误（非 JSON 也保底可用）。 */
export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/** 准备一个 SSE 响应流，返回写帧函数。 */
export function startSse(res: ServerResponse): (frame: string) => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  // 首帧前先发一行注释，让代理尽早 flush 缓冲
  res.write(': connected\n\n')
  const write = (frame: string): void => {
    try {
      res.write(frame)
    } catch {
      /* 连接已断，忽略 */
    }
  }
  return write
}

/** SSE 结束标记（OpenAI 客户端以此判定流结束）。 */
export const DONE_MARKER = 'data: [DONE]\n\n'
