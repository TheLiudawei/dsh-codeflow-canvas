/**
 * 架构红线测试（v1.2.2）——静态解析 lib 目录树下 .js 模块的 `import … from`
 * 与 `await import(...)`，验证任务书 §9 的分层与依赖方向。
 *
 * 分层（任务书 §9.1；未列名的既有模块按它在真实依赖图里的位置归入
 * 「共享支撑 L1」——它们只被 L1/L2/L3 消费、自己不碰 HTTP）：
 *
 *   L0 基础   lib/core/*、lib/logging/*、lib/import/root-detect.js
 *   L1 领域   graph-format/paths/store/scan/*、coupling/importer/analyst、
 *             features(+features/*)、workspace、codeflow-config、migration、
 *             message、workspace-binding、archive、drop-import、starter、browse
 *   L2 编排   duo、import/pipeline、sessions/activity/undo/gestures
 *   L3 适配   http/*、routes、commands/tool/features-tool/skill、
 *             canvas-page/client
 *   L4 装配   index.js（只接线）
 *   数据     lib/ui/actions.js（零 import，单独断言）
 *
 * 通用红线：任何模块不得 import 更高层；专项红线：logging 不依赖领域/路由；
 * root-detect 只依赖 node:path；pipeline 不接触 HTTP；log-routes 不直接
 * node:fs；index.js 不被反向依赖；静态图无环。
 *
 * 动态 import() 约定（沿既有代码的明文惯例，见 lib/importer.js 的 CLI 入口）：
 * `import()` 是惰性/CLI 边——参与零 npm 依赖检查，但不进静态分层/环检测。
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/architecture.mjs
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
const ok = (name) => { passed += 1; console.log('  ok ', name) }
const violations = []

/* ------------------------------------------------------ 收集模块与依赖 --- */

async function listJs(dirRel) {
  const abs = path.join(ROOT, dirRel)
  const entries = await readdir(abs, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const entry of entries) {
    const rel = path.join(dirRel, entry.name)
    if (entry.isDirectory()) out.push(...(await listJs(rel)))
    else if (entry.name.endsWith('.js')) out.push(rel.replace(/\\/g, '/'))
  }
  return out
}

const files = await listJs('lib')
const staticGraph = new Map() // rel -> Set(静态 import 边)
const lazyGraph = new Map() // rel -> Set(动态 import() 边，惰性/CLI)
const external = new Map() // rel -> Set(node:*/包名)

/** `fromRel` 内的说明符 → 仓库内相对路径（非相对说明符返回 undefined）。 */
function resolveFrom(fromRel, spec) {
  if (!spec.startsWith('.')) return undefined
  const base = path.resolve(path.dirname(path.join(ROOT, fromRel)), spec)
  return path.relative(ROOT, base).replace(/\\/g, '/')
}

const STATIC_RE = /^\s*import\s[\s\S]*?from\s*['"]([^'"]+)['"]/gm
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g

for (const rel of files) {
  const text = await readFile(path.join(ROOT, rel), 'utf8')
  const staticDeps = new Set()
  const lazyDeps = new Set()
  const exts = new Set()
  let m
  while ((m = STATIC_RE.exec(text))) {
    const resolved = resolveFrom(rel, m[1])
    if (resolved === undefined) exts.add(m[1])
    else staticDeps.add(resolved)
  }
  while ((m = DYNAMIC_RE.exec(text))) {
    const resolved = resolveFrom(rel, m[1])
    if (resolved === undefined) exts.add(m[1])
    else lazyDeps.add(resolved)
  }
  staticGraph.set(rel, staticDeps)
  lazyGraph.set(rel, lazyDeps)
  external.set(rel, exts)
}

/* ------------------------------------------------------- 1. 零 npm 依赖 -- */

for (const [rel, exts] of external) {
  for (const spec of exts) {
    if (spec.startsWith('node:')) continue
    violations.push(`zero-dep: ${rel} import 了非 node 内建模块 ${JSON.stringify(spec)}（静态或惰性）`)
  }
}
if (!violations.some((v) => v.startsWith('zero-dep:'))) ok('零 npm 依赖：lib/** 只有 node: 内建与仓库内 import（含惰性边）')

/* ----------------------------------------------------- 2. 分层与禁边 ---- */

const L0 = (rel) => rel.startsWith('lib/core/') || rel.startsWith('lib/logging/') || rel === 'lib/import/root-detect.js'
const L1 = (rel) => [
  'lib/graph-format.js', 'lib/paths.js', 'lib/store.js', 'lib/coupling.js', 'lib/importer.js',
  'lib/analyst.js', 'lib/features.js', 'lib/workspace.js', 'lib/codeflow-config.js',
  'lib/migration.js', 'lib/message.js', 'lib/workspace-binding.js', 'lib/archive.js',
  'lib/drop-import.js', 'lib/starter.js', 'lib/browse.js',
  // v1.5.0：类型判定规则（纯函数，唯一规则表）。
  'lib/typing/classify.js',
].includes(rel) || rel.startsWith('lib/scan/') || rel.startsWith('lib/features/') || rel.startsWith('lib/cards/')
const L2 = (rel) => [
  'lib/duo.js', 'lib/import/pipeline.js', 'lib/sessions.js', 'lib/activity.js', 'lib/undo.js', 'lib/gestures.js',
  // v1.5.0：识别编排（依赖注入，读 store/undo/activity 组装证据写图）。
  'lib/typing/service.js',
].includes(rel)
const L3 = (rel) => rel.startsWith('lib/http/') || [
  'lib/routes.js', 'lib/commands.js', 'lib/tool.js', 'lib/features-tool.js', 'lib/skill.js',
  'lib/canvas-page.js', 'lib/client.js',
].includes(rel)
const layerOf = (rel) => {
  if (rel === 'lib/index.js') return 'L4'
  /* v1.3.0：lib/ui/* 数据/纯渲染层——actions 零 import（单独断言），
     menu 模型只 import actions、menu-html 只 import menu（渲染 → 模型）。 */
  if (rel.startsWith('lib/ui/')) return 'DATA'
  if (L0(rel)) return 'L0'
  if (L1(rel)) return 'L1'
  if (L2(rel)) return 'L2'
  if (L3(rel)) return 'L3'
  return null // 未知模块：没有分层断言（新增模块应显式登记）
}
const layerRank = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4, DATA: -1 }

const unknownModules = []
for (const [from, deps] of staticGraph) {
  const fromLayer = layerOf(from)
  if (fromLayer === null) { unknownModules.push(from); continue }
  for (const to of deps) {
    const toLayer = layerOf(to)
    if (toLayer === null) { unknownModules.push(to); continue }
    if (layerRank[fromLayer] < layerRank[toLayer]) {
      violations.push(`layer: ${from} (${fromLayer}) → ${to} (${toLayer}) 违反依赖方向`)
      continue
    }
    // 专项红线（任务书 §9.1 / §9.3）。
    if (from.startsWith('lib/logging/') && /^lib\/(store|routes|http|coupling|importer|analyst|duo|sessions|undo|activity|gestures)\b/.test(to)) {
      violations.push(`logging: ${from} → ${to}（日志不得依赖领域/路由模块）`)
    }
    if (from === 'lib/import/root-detect.js' && to.startsWith('lib/')) {
      violations.push(`root-detect: ${from} → ${to}（只允许 node:path + 注入 fs）`)
    }
    if (from === 'lib/import/pipeline.js' && (to.startsWith('lib/http/') || to === 'node:http')) {
      violations.push(`pipeline: ${from} → ${to}（编排层不得接触 HTTP）`)
    }
    if (from !== 'lib/index.js' && to === 'lib/index.js') {
      violations.push(`index: ${from} → lib/index.js（装配入口不得被反向依赖）`)
    }
  }
}
for (const [from, deps] of lazyGraph) {
  if (from === 'lib/import/pipeline.js' && [...deps].some((to) => to.startsWith('lib/http/'))) {
    violations.push(`pipeline: ${from} →（惰性）lib/http/*（编排层不得接触 HTTP）`)
  }
}
assert.ok(unknownModules.length === 0, `未登记分层的模块（新模块应更新本表）：${unknownModules.join('、')}`)
ok(`依赖方向：lib/** ${files.length} 个模块的静态 import 图全部低于自身层`)

/* ------------------------------------------------------- 3. 特例断言 ---- */

const actionsText = await readFile(path.join(ROOT, 'lib/ui/actions.js'), 'utf8')
const stripped = actionsText.replace(/^ \*.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
assert.ok(!/^\s*import\b/m.test(stripped), 'lib/ui/actions.js 必须零 import（注释除外）')
ok('lib/ui/actions.js：纯数据清单，零 import')

const logRoutesText = await readFile(path.join(ROOT, 'lib/http/log-routes.js'), 'utf8')
assert.ok(!/from\s*['"]node:fs/.test(logRoutesText) && !/import\(\s*['"]node:fs/.test(logRoutesText), 'log-routes 不得 import node:fs')
ok('lib/http/log-routes.js：只走注入 logger，不直接 fs')

const indexText = await readFile(path.join(ROOT, 'lib/index.js'), 'utf8')
assert.ok(!/scan\.params|detectProjectRoot|appendFile/.test(indexText), 'index.js 只装配，不写导入/根解析/落盘业务')
ok('lib/index.js：纯装配')

/* ------------------------------------------------------- 4. 循环依赖 ---- */

const cycles = []
const state = new Map()
const stack = []
function dfs(node) {
  state.set(node, 1)
  stack.push(node)
  for (const dep of staticGraph.get(node) ?? []) {
    if (!staticGraph.has(dep)) continue
    const st = state.get(dep) ?? 0
    if (st === 1) {
      const at = stack.indexOf(dep)
      cycles.push([...stack.slice(at), dep].join(' → '))
    } else if (st === 0) {
      dfs(dep)
    }
  }
  stack.pop()
  state.set(node, 2)
}
for (const node of staticGraph.keys()) {
  if ((state.get(node) ?? 0) === 0) dfs(node)
}
if (cycles.length > 0) {
  for (const cycle of cycles) violations.push(`cycle: ${cycle}`)
} else {
  ok('循环依赖：静态图无环（DFS；惰性/CLI 边按既有约定不进静态图）')
}

/* ------------------------------------------------------------ 输出 ------ */

if (violations.length > 0) {
  console.log('\n[failures]')
  for (const v of violations) console.log(`  ✗ ${v}`)
  console.log(`\n[summary] architecture: ${passed} checks passed, ${violations.length} violation(s)`)
  process.exit(1)
}
console.log(`\n[summary] architecture: all ${passed} checks passed`)
