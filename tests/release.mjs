#!/usr/bin/env node
/**
 * 版本纪律（v1.4.0）：`package.json` 的 version 必须领先于最近一个 tag。
 *
 * 为什么需要这条：v1.3.2 打完标签后，一个 `feat(brand)` 提交跑到了版本号前面，
 * `package.json` 仍是 1.3.2。用户报「图标长得不一样」时，没法用版本号区分自己
 * 拿到的是哪一版——标签、版本号、代码三者各说各话。
 *
 * 规则：
 *   - 没有任何 tag → 跳过（浅克隆/新仓库）。
 *   - HEAD 就是 tag 指向的提交 → version 必须等于 tag。
 *   - HEAD 领先 tag → version 必须**严格大于** tag（有新提交就必须发新版本）。
 *
 * 依赖：git（CI 里 checkout 需要 fetch-depth: 0 才能拿到 tag）。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

const parse = (value) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const fmt = (v) => `v${v.join('.')}`

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = parse(pkg.version)
assert.ok(version, `package.json 的 version 不是合法 semver：${JSON.stringify(pkg.version)}`)

let tags = []
try {
  tags = git(['tag', '--list']).split('\n').map((line) => line.trim()).filter(Boolean)
} catch {
  tags = []
}
const versions = tags.map((tag) => ({ tag, v: parse(tag) })).filter((entry) => entry.v).sort((a, b) => compare(b.v, a.v))

if (versions.length === 0) {
  console.log('  skip  没有可用的 semver 标签（浅克隆或新仓库），版本纪律检查跳过')
  process.exit(0)
}

const latest = versions[0]
let ahead = 0
try {
  ahead = Number(git(['rev-list', '--count', `${latest.tag}..HEAD`]))
} catch {
  console.log(`  skip  无法比较 ${latest.tag}..HEAD，版本纪律检查跳过`)
  process.exit(0)
}

if (ahead === 0) {
  assert.equal(compare(version, latest.v), 0, `HEAD 位于 ${latest.tag}，package.json 应保持 ${latest.tag.replace(/^v/, '')}，实际 ${pkg.version}`)
  console.log(`  ok    HEAD 即 ${latest.tag}，version 与之一致（${pkg.version}）`)
} else {
  assert.ok(compare(version, latest.v) > 0, `HEAD 比 ${latest.tag} 多 ${ahead} 个提交，package.json 必须发新版本（当前 ${pkg.version} ≤ ${latest.tag.replace(/^v/, '')}）`)
  console.log(`  ok    HEAD 领先 ${latest.tag} ${ahead} 个提交，version ${pkg.version} > ${latest.tag.replace(/^v/, '')}`)
}

console.log(`\n[summary] release: 版本纪律 1 项通过`)
