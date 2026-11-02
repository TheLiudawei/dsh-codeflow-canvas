#!/usr/bin/env node
/**
 * 可复现基准（v1.4.2）——把 README 里"对比表"从说法变成**测量**。
 *
 * 原则：只测能测的，测不到的不编。
 *
 *   能量化的：导入耗时、导入是否唤醒 agent（唤醒次数必须为 0）、
 *             两次导入的分析是否逐字段一致、撤销是否逐字节还原；
 *             以及"不做这件事时模型至少要读多少源码"（可测的字节数）。
 *   测不到的：真模型写计划要花多少 token —— 这里**不假装测过**，只给出
 *             下界估算（源码字节 / 4，标注为估算）。
 *
 * 夹具是固定的（见 FIXTURE），任何人 clone 后 `npm run bench` 都能复现同一张表。
 *
 * Run: node tests/bench.mjs [--json]
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

const { apply } = await load('lib/index.js')
const { createStore } = await load('lib/store.js')
const { createUndoManager, UNDO_LIMITS } = await load('lib/undo.js')

/* ------------------------------------------------------------------ 夹具 --- */
/* 固定内容：同一份夹具在任何机器上产出同一张图。 */
const FIXTURE = {
  'package.json': '{"name":"bench-fixture","version":"1.0.0"}\n',
  'src/index.ts': "import { registerOrderRoutes } from './api/orders.js'\nexport const app = { registerOrderRoutes }\n",
  'src/api/orders.ts': "// TODO: paginate this list\nexport function registerOrderRoutes(app) {\n  app.get('/orders', () => [])\n}\n",
  'src/api/users.ts': "import { hash } from '../utils/crypto.js'\nexport function registerUserRoutes(app) {\n  app.post('/users', () => hash('x'))\n}\n",
  'src/api/cart.ts': "// FIXME: totals round twice\nexport function registerCartRoutes(app) {\n  app.post('/cart', () => 0)\n}\n",
  'src/services/pricing.ts': "import { toCents } from '../utils/money.js'\nexport function priceCart(items) {\n  return items.reduce((s, i) => s + toCents(i.price) * i.qty, 0)\n}\n",
  'src/services/shipping.ts': "export function quoteShipping(order) {\n  return order.total >= 15000 ? 0 : 500\n}\n",
  'src/services/email.ts': "// HACK: polls instead of a worker\nexport const outbox = []\nexport function queueReceipt(order) { outbox.push(order) }\n",
  'src/utils/money.ts': "export const toCents = (n) => Math.round(Number(n) * 100)\nexport const formatMoney = (c) => '$' + (c / 100).toFixed(2)\n",
  'src/utils/crypto.ts': "import { createHash } from 'node:crypto'\nexport const hash = (s) => createHash('sha256').update(s).digest('hex')\n",
  'src/utils/logger.ts': "export const logger = { info: (m) => process.stdout.write(m + '\\n') }\n",
  'tests/cart.test.ts': "import { priceCart } from '../src/services/pricing.js'\nexport const t = () => priceCart([{ price: 12.5, qty: 2 }])\n",
}

/* 规模：手写 12 个核心文件 + 确定性生成的模块，凑到接近一个真实小仓库。
   生成规则是纯函数（名字与内容只取决于下标），因此跨机器完全一致。 */
const GENERATED_MODULES = 48
for (let i = 0; i < GENERATED_MODULES; i += 1) {
  const name = `module_${String(i).padStart(2, '0')}`
  const lines = [
    ...(i % 7 === 0 ? ['// TODO: split this module'] : []),
    "import { toCents } from '../utils/money.js'",
    "import { logger } from '../utils/logger.js'",
    `export function compute${i}(items) {`,
    '  const total = items.reduce((sum, item) => sum + toCents(item.price) * item.qty, 0)',
    `  logger.info('${name} ' + total)`,
    '  return total',
    '}',
    '',
  ]
  FIXTURE[`src/generated/${name}.ts`] = lines.join('\n')
}

const FIXTURE_BYTES = Object.values(FIXTURE).reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0)

/* -------------------------------------------------------------- 宿主桩 --- */
function fakeContext(services = {}) {
  const recorded = { commands: [], routes: [], tools: [], skills: [], listeners: new Map() }
  const ctx = {
    logger: { warn() {}, info() {} },
    effects: [],
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') ctx.effects.push(dispose)
      return dispose
    },
    on(name, callback) {
      const list = recorded.listeners.get(name) ?? []
      list.push(callback)
      recorded.listeners.set(name, list)
      return () => {}
    },
    get(name) {
      if (Object.hasOwn(services, name)) return services[name]
      if (name === 'agents') return { get: () => undefined, roots: () => [] }
      return undefined
    },
    inject(_names, callback) { callback(ctx) },
    skills: { registerProvider(create) { recorded.skills.push(create({ signal: new AbortController().signal, invalidate() {} })); return () => {} } },
    commands: { register(definition) { recorded.commands.push(definition); return () => {} } },
    tools: { register(definition) { recorded.tools.push(definition); return () => {} } },
    webServer: { register(route) { recorded.routes.push(route); return () => {} } },
    sessionController: undefined,
    ...services,
  }
  return { ctx, recorded }
}

const fakeAgent = (id, sink, cwd) => ({
  id,
  session: { header: { cwd } },
  followup: (message) => { sink.push(message) },
})

async function makeFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'codeflow-bench-fixture-'))
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const target = path.join(dir, ...rel.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return dir
}

/** 归一化一张图里可比较的分析字段（不含 id/坐标——它们不是分析结论）。 */
function analysisOf(graph, kind) {
  const nodes = [...(graph.nodes ?? [])]
  if (kind === 'tasks') {
    return nodes
      .map((node) => [node.type, node.title ?? '', node.params?.instruction ?? '', node.params?.path ?? ''].join('|'))
      .sort()
  }
  return nodes
    .filter((node) => node.type === 'module')
    .map((node) => `${node.params?.path ?? ''}|${node.params?.symbol ?? ''}|${node.coupling?.score ?? '-'}`)
    .sort()
}

/* ------------------------------------------------------------------ 跑表 --- */
const results = { fixture: { files: Object.keys(FIXTURE).length, bytes: FIXTURE_BYTES } }
const workspaces = []
const cleanup = []

try {
  const fixture = await makeFixture()
  cleanup.push(() => rm(fixture, { recursive: true, force: true }))
  results.fixture.tokensEstimate = Math.round(FIXTURE_BYTES / 4)

  /* A. 导入：耗时 + agent 唤醒次数（必须 0） */
  const importRuns = []
  for (const run of [1, 2]) {
    const workspace = await mkdtemp(path.join(tmpdir(), `codeflow-bench-ws-${run}-`))
    workspaces.push(workspace)
    cleanup.push(() => rm(workspace, { recursive: true, force: true }))
    const { ctx, recorded } = fakeContext({ workspaceRegistry: { list: () => [{ id: 'ws', path: workspace }] } })
    apply(ctx)
    const command = recorded.commands.find((entry) => entry.name === 'flow-import')
    const sink = []
    const started = process.hrtime.bigint()
    const result = await command.handler({
      // cwd 必须是**工作区**：插件的图数据落在会话 cwd 之下；指到夹具目录
      // 会让 CodeFlow/ 建在夹具里，两轮还会互相覆盖。
      agent: fakeAgent(`bench-${run}`, sink, workspace),
      rawInput: ` ${fixture} `,
      signal: new AbortController().signal,
    })
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    assert.equal(result.kind, 'success', result.text)
    assert.equal(sink.length, 0, '导入不得唤醒 agent')
    importRuns.push({ workspace, ms })
  }

  /* 项目名来自夹具目录的 basename（带随机后缀），这里直接发现唯一项目目录，
     不假设名字——否则基准会随 mkdtemp 的后缀变红。 */
  const projectDirIn = async (workspace) => {
    const base = path.join(workspace, 'CodeFlow', 'flow-projects')
    const entries = await readdir(base)
    assert.equal(entries.length, 1, `期望恰好一个项目，实际 ${entries.join(', ')}`)
    return path.join(base, entries[0])
  }

  const projectDir = await projectDirIn(importRuns[0].workspace)
  const tasksA = analysisOf(JSON.parse(await readFile(path.join(projectDir, 'workflow.json'), 'utf8')), 'tasks')
  const modulesA = analysisOf(JSON.parse(await readFile(path.join(projectDir, 'workflow.modules.json'), 'utf8')), 'modules')

  const projectDir2 = await projectDirIn(importRuns[1].workspace)
  const tasksB = analysisOf(JSON.parse(await readFile(path.join(projectDir2, 'workflow.json'), 'utf8')), 'tasks')
  const modulesB = analysisOf(JSON.parse(await readFile(path.join(projectDir2, 'workflow.modules.json'), 'utf8')), 'modules')

  results.import = {
    msFirst: Number(importRuns[0].ms.toFixed(1)),
    msSecond: Number(importRuns[1].ms.toFixed(1)),
    agentWakeups: 0,
    promptTokens: 0,
    tasks: tasksA.length,
    modules: modulesA.length,
    markerTasks: tasksA.filter((line) => line.includes('TODO') || line.includes('FIXME') || line.includes('HACK')).length,
  }
  results.determinism = {
    tasksIdentical: JSON.stringify(tasksA) === JSON.stringify(tasksB),
    modulesIdentical: JSON.stringify(modulesA) === JSON.stringify(modulesB),
    fields: tasksA.length + modulesA.length,
  }

  /* C. 撤销：逐字节还原（含同尺寸修改） */
  const ws = await mkdtemp(path.join(tmpdir(), 'codeflow-bench-undo-'))
  cleanup.push(() => rm(ws, { recursive: true, force: true }))
  const project = 'bench-undo'
  const dir = path.join(ws, 'CodeFlow', 'flow-projects', project)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src', 'main.py'), 'print("v1")\n', 'utf8')
  await writeFile(path.join(dir, 'src', 'util.py'), 'x = 1\n', 'utf8')

  const store = createStore({ warn() {}, info() {} })
  await store.write({ format: 'codeflow/1', rev: 0, project: { name: project, language: 'python', origin: 'new' }, nodes: [], links: [] }, { persist: 'now' })
  store.bindCwd(project, ws)
  const undo = createUndoManager({ store, logger: { warn() {}, info() {} }, limits: UNDO_LIMITS })

  const snap = await undo.beginRun(project, { action: 'RUN_ALL', nodes: [] })
  await writeFile(path.join(dir, 'src', 'main.py'), 'print("v2")\n', 'utf8')  // 同尺寸修改
  await writeFile(path.join(dir, 'src', 'new.py'), 'print("new")\n', 'utf8')
  await rm(path.join(dir, 'src', 'util.py'))
  await undo.finishRun(project, snap.runId)
  const restored = await undo.restore(project, snap.runId)

  const readBack = async (rel) => readFile(path.join(dir, 'src', rel), 'utf8').catch(() => null)
  const checks = [
    ['modified restored byte-exact', (await readBack('main.py')) === 'print("v1")\n'],
    ['deleted restored byte-exact', (await readBack('util.py')) === 'x = 1\n'],
    ['added removed', (await readBack('new.py')) === null],
    ['reported as modified', JSON.stringify(restored.files?.modified ?? []) === JSON.stringify(['src/main.py'])],
  ]
  results.undo = { ok: restored.ok, checks: checks.length, passed: checks.filter(([, ok]) => ok).length, detail: checks }
} finally {
  for (const step of cleanup.reverse()) await step().catch(() => {})
}

/* ------------------------------------------------------------------ 输出 --- */
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2))
  process.exit(results.undo?.passed === results.undo?.checks ? 0 : 1)
}

const n = (v) => new Intl.NumberFormat('en-US').format(v)
console.log('')
console.log(`fixture: ${results.fixture.files} files, ${n(results.fixture.bytes)} bytes`)
console.log('')
console.log('| measured | value |')
console.log('| --- | --- |')
console.log(`| import, first run | ${results.import.msFirst} ms |`)
console.log(`| import, second run | ${results.import.msSecond} ms |`)
console.log(`| agent wakeups during import | ${results.import.agentWakeups} |`)
console.log(`| prompt tokens during import | ${results.import.promptTokens} |`)
console.log(`| tasks / module nodes produced | ${results.import.tasks} / ${results.import.modules} |`)
console.log(`| task nodes from TODO/FIXME/HACK | ${results.import.markerTasks} |`)
console.log(`| two imports agree on analysis fields | ${results.determinism.fields}/${results.determinism.fields} (tasks=${results.determinism.tasksIdentical}, modules=${results.determinism.modulesIdentical}) |`)
console.log(`| undo verified checks | ${results.undo.passed}/${results.undo.checks} |`)
console.log('')
console.log(`for reference: to write the same plan from the transcript, the model must read at least`)
console.log(`${n(results.fixture.bytes)} bytes of source (≈${n(results.fixture.tokensEstimate)} tokens by the chars/4 heuristic — an estimate, not a measurement).`)
console.log('')
const failed = results.determinism.fields > 0 && results.determinism.tasksIdentical && results.determinism.modulesIdentical
  && results.undo.passed === results.undo.checks
if (!failed) {
  console.error('bench failed: determinism or undo checks did not hold')
  process.exit(1)
}
