#!/usr/bin/env node
/**
 * 顺序跑完所有套件，收集退出码，最后统一汇总。
 *
 * 与 CI 的 `if: always()` 对齐：一个套件失败不掩盖它之后的套件——一次运行就能
 * 看到全部结果，而不是修一个跑一次。子进程继承当前环境（`ELECTRON_RUN_AS_NODE=1`
 * 也一并继承，因此用 DSH 二进制当运行时同样可用）。
 *
 * Run: node tests/run-all.mjs
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 套件顺序即 CI 步骤顺序（validate 先跑，暴露最多结构问题）。 */
export const SUITES = [
  'validate', 'regression', 'cards', 'menu', 'architecture', 'logging',
  'undo', 'typing', 'coupling', 'features', 'workspace', 'browse', 'import-shells',
  'log-viewer', 'drop-import', 'e2e', 'buttons', 'release', 'bench',
]

const HERE = path.dirname(fileURLToPath(import.meta.url))
const results = []

for (const suite of SUITES) {
  process.stdout.write(`\n=== ${suite} ===\n`)
  const started = Date.now()
  const run = spawnSync(process.execPath, [path.join(HERE, `${suite}.mjs`)], {
    stdio: 'inherit',
    env: process.env,
  })
  const ms = Date.now() - started
  const code = run.status ?? 1
  results.push({ suite, code, ms })
  if (run.error) process.stdout.write(`  （启动失败：${run.error.message}）\n`)
}

const failed = results.filter((entry) => entry.code !== 0)
const width = Math.max(...results.map((entry) => entry.suite.length))

process.stdout.write('\n[summary]\n')
for (const entry of results) {
  const mark = entry.code === 0 ? 'ok  ' : `FAIL(${entry.code})`
  process.stdout.write(`  ${mark.padEnd(8)} ${entry.suite.padEnd(width)}  ${(entry.ms / 1000).toFixed(1)}s\n`)
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} suites passed\n`)
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.map((entry) => entry.suite).join(', ')}\n`)
  process.exit(1)
}
