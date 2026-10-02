/**
 * Bearer 校验：Authorization: Bearer <key> → 匹配 key 注册表 → accountId。
 */
import type { KeyRegistry, KeyEntry } from '../api-key/keys.ts'

export interface AuthOk {
  ok: true
  entry: KeyEntry
  /** 展示用短名（已掩码，用于日志）。 */
  label: string
}

export interface AuthFail {
  ok: false
  reason: 'missing' | 'invalid'
}

export type AuthResult = AuthOk | AuthFail

/** 从请求头的 authorization 提取 Bearer token。 */
export function bearerFromHeader(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return m ? m[1].trim() : undefined
}

/** 校验：返回 ok/账号 或 失败原因。纯函数，便于离线测试。 */
export function authenticate(
  registry: KeyRegistry,
  authorization: string | undefined,
): AuthResult {
  const key = bearerFromHeader(authorization)
  if (!key) return { ok: false, reason: 'missing' }
  const entry = registry.get(key)
  if (!entry) return { ok: false, reason: 'invalid' }
  return { ok: true, entry, label: entry.label }
}
