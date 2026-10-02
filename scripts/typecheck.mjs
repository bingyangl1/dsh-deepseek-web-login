#!/usr/bin/env node
/**
 * 类型检查：主工程（tsconfig.json，src/）＋ 独立服务（tsconfig.server.json，server/）。
 *
 * 为什么要有两个：CI 现有的 `npx tsc --noEmit` 只查 `src/`（tsconfig include 是 src/**）。
 * 而 server/ 是独立于宿主自包含 bundle 的另一份代码（Node 24 type-strip 直接跑，不参与
 * tsdown 构建）—— 它一旦缺类型检查，用户改坏 server/ 也一样能「构建通过」。
 * 只用 tsdown/esbuild 是查不出的（CI 注释里 P0-1 的教训）。
 *
 * 取 typescript 的 JS 入口（typescript/bin/tsc）用 node 直接跑，不依赖 .bin 软链，
 * Windows 上更稳（沿用 scripts/build.mjs 找 tsdown CLI 的同一手法）。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const tscPkgJson = require.resolve('typescript/package.json')
const tscBin = join(dirname(tscPkgJson), require(tscPkgJson).bin.tsc)

/** 跑一次 tsc，返回是否成功。 */
function run(configName) {
  const result = spawnSync(process.execPath, [tscBin, '--noEmit', '-p', configName], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  return (result.status ?? 1) === 0
}

const okMain = run('tsconfig.json')
const okServer = run('tsconfig.server.json')

if (!okMain) console.error('\n[typecheck] FAIL: 主工程（tsconfig.json）类型不通过')
if (!okServer) console.error('\n[typecheck] FAIL: 独立服务（tsconfig.server.json）类型不通过')

if (okMain && okServer) {
  console.log('[typecheck] 主工程 + 独立服务 全部通过 OK')
} else {
  process.exitCode = 1
}
