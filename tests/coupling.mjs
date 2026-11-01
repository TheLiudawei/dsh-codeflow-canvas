/**
 * Module coupling analysis (v1.2) — engine, cleaning, persistence and stale
 * probes. Pure Node: fixtures are small source trees written into a tmpdir at
 * runtime, scores asserted against the fixed formula in lib/coupling.js.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/coupling.mjs
 */
import assert from 'node:assert/strict'
import { utimes, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const module = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)

const {
  clamp01, computeStale, isFileModuleNode, levelOf, metaCouplingOf,
  overallOf, runCoupling, sat, LEVEL_MEDIUM, LEVEL_HIGH,
  clearStaleCache,
} = await module('lib/coupling.js')
const { normalizeCoupling, normalizeMetaCoupling, normalizeGraph, createStore } = await module('lib/store.js')
const { analyzeModules } = await module('lib/analyst.js')

let passed = 0
const ok = (name) => { passed += 1; console.log('  ok ', name) }

const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-coupling-'))
const now = '2026-11-01T09:20:11.000Z'

/* ---- 纯函数与阈值 ---- */
assert.equal(sat(0, 12), 0)
assert.equal(sat(12, 12), 1)
assert.ok(sat(6, 12) > 0 && sat(6, 12) < 1)
assert.equal(clamp01(1.5), 1)
assert.equal(clamp01(-3), 0)
assert.equal(LEVEL_MEDIUM, 30)
assert.equal(LEVEL_HIGH, 60)
assert.equal(levelOf(29), 'low')
assert.equal(levelOf(30), 'medium')
assert.equal(levelOf(59), 'medium')
assert.equal(levelOf(60), 'high')
ok('sat/clamp/levelOf: threshold 30/60 and saturation curve hold')

/* ---- 夹具：small / cyclic / symbols / unknown ---- */
const smallDir = path.join(workspace, 'small')
await mkdir(smallDir, { recursive: true })
await writeFile(path.join(smallDir, 'one.py'), 'def one():\n    return 1\n', 'utf8')
await writeFile(path.join(smallDir, 'two.py'), 'def two():\n    return 2\n', 'utf8')
await writeFile(path.join(smallDir, 'three.py'), 'def three():\n    return 3\n', 'utf8')

// cyclic：a↔b↔d↔e↔f 成环（a 与每个同伴互相 import），c 被多方引用；a.py 内部 8 个符号稠密互调（两个内环）、
// 4 个外部 import、fanIn/fanOut 4/5 —— 把 a.py 的分数真实地推到「高」。
const cyclicDir = path.join(workspace, 'cyclic')
await mkdir(cyclicDir, { recursive: true })
await writeFile(path.join(cyclicDir, 'a.py'), [
  'import json',
  'import os',
  'import re',
  'import sys',
  'import b',
  'import c',
  'import d',
  'import e',
  'import f',
  '',
  'def fa(items):',
  '    data = json.dumps(items)',
  '    return b.fb(data) + c.fc(data) + d.fd(data) + hub(3) + parse(data)',
  '',
  'def hub(n):',
  '    total = 0',
  '    for i in range(n):',
  '        total += helper(i)',
  '    return total',
  '',
  'def helper(x):',
  '    return rank(x) * 2',
  '',
  'def rank(x):',
  '    return helper(x - 1) % 3',
  '',
  'def parse(data):',
  '    rows = re.split(",", str(data))',
  '    return merge(rows)',
  '',
  'def merge(rows):',
  '    clean = [validate(r) for r in rows]',
  '    return fmt(clean)',
  '',
  'def validate(row):',
  '    if not row:',
  '        return parse("")',
  '    return str(row).strip() or str(sys.platform)',
  '',
  'def fmt(clean):',
  '    return os.path.join(*[str(item) for item in clean])',
  '',
].join('\n'), 'utf8')
await writeFile(path.join(cyclicDir, 'b.py'), [
  'import a',
  'import c',
  'def fb(data):',
  '    return len(data) + c.fc(data) + a.hub(2)',
  '',
].join('\n'), 'utf8')
await writeFile(path.join(cyclicDir, 'c.py'), [
  'def fc(data):',
  '    return len(data)',
  '',
].join('\n'), 'utf8')
await writeFile(path.join(cyclicDir, 'd.py'), [
  'import a',
  'import os',
  'def fd(data):',
  '    return os.path.basename(str(data)) + str(a.hub(1))',
  '',
].join('\n'), 'utf8')
await writeFile(path.join(cyclicDir, 'e.py'), [
  'import a',
  'import c',
  'def fe(data):',
  '    return a.hub(2) + c.fc(data)',
  '',
].join('\n'), 'utf8')
await writeFile(path.join(cyclicDir, 'f.py'), [
  'import a',
  'def ff(x):',
  '    return a.parse(str(x))',
  '',
].join('\n'), 'utf8')

// symbols：单文件 6 个函数互相调用（部分孤立），断言内部密度/refs。
const symbolsDir = path.join(workspace, 'symbols')
await mkdir(symbolsDir, { recursive: true })
await writeFile(path.join(symbolsDir, 'app.js'), [
  'function alpha() { return beta() + 1 }',
  'function beta() { return gamma() }',
  'function gamma() { return alpha() }',
  'function delta() { return alpha() + beta() }',
  'function lonely() { return 42 }',
  'function alsoLonely() { return 7 }',
  '',
].join('\n'), 'utf8')

// unknown：解析器不认识的扩展名 → parsed:false 且不崩。
const unknownDir = path.join(workspace, 'unknown')
await mkdir(unknownDir, { recursive: true })
await writeFile(path.join(unknownDir, 'comp.vue'), '<template>\n  <div>{{ msg }}</div>\n</template>\n', 'utf8')
await writeFile(path.join(unknownDir, 'weird.custom'), '??? whatever ???\n'.repeat(200), 'utf8')

/* ---- 引擎行为 ---- */
const { graph: cyclicGraph } = await analyzeModules({ path: cyclicDir, projectName: 'cyclic' })
const cyclicRun = await runCoupling({ graph: cyclicGraph, dir: workspace, now })
const nodeByTitle = new Map(cyclicGraph.nodes.filter(isFileModuleNode).map((node) => [node.title, node.id]))
{
  const aCoupling = cyclicRun.perNode.get(nodeByTitle.get('a.py'))
  assert.ok(aCoupling, 'a.py was analyzed')
  assert.equal(aCoupling.metrics.sccSize, 5, 'a.py sits inside the a↔b↔d↔e↔f cycle')
  assert.equal(aCoupling.metrics.fanOut, 5, `a.py imports five modules (${aCoupling.metrics.fanOut})`)
  assert.equal(aCoupling.metrics.fanIn, 4, `b/d/e/f import a.py (${aCoupling.metrics.fanIn})`)
  assert.ok(aCoupling.metrics.closure >= 5, `transitive closure covers the project (${aCoupling.metrics.closure})`)
  assert.equal(aCoupling.level, 'high', `cyclic hub must score high, got ${aCoupling.score}`)
  assert.ok(aCoupling.score >= LEVEL_HIGH, `score ${aCoupling.score} >= 60`)
  assert.equal(aCoupling.metrics.parsed, true)
  assert.ok(aCoupling.metrics.refs >= 8, `intra references found inside a.py (${aCoupling.metrics.refs})`)
  assert.equal(aCoupling.at, now)
  ok(`cyclic fixture: a.py is high (${aCoupling.score}) with sccSize=5, refs=${aCoupling.metrics.refs}`)
}
{
  const cCoupling = cyclicRun.perNode.get(nodeByTitle.get('c.py'))
  assert.ok(cCoupling, 'c.py analyzed')
  assert.equal(cCoupling.metrics.sccSize, 1, 'c.py is not in the cycle')
  assert.equal(cCoupling.metrics.fanIn, 3, `a/b/e reference c.py (${cCoupling.metrics.fanIn})`)
  assert.ok(cCoupling.score < LEVEL_MEDIUM, `a passive leaf stays low (${cCoupling.score})`)
  ok(`cyclic fixture: c.py stays outside the SCC (score ${cCoupling.score})`)
}
{
  assert.ok(cyclicRun.overall, 'overall verdict present')
  assert.equal(cyclicRun.overall.modules, 6)
  assert.equal(cyclicRun.overall.analyzed, 6)
  assert.equal(cyclicRun.overall.partial, false)
  assert.equal(cyclicRun.overall.cycles, 5, `every cycle member counted (${cyclicRun.overall.cycles})`)
  assert.ok(cyclicRun.overall.worst.score >= LEVEL_HIGH)
  assert.equal(cyclicRun.overall.worst.id, nodeByTitle.get('a.py'))
  ok(`cyclic overall: ${cyclicRun.overall.level} score=${cyclicRun.overall.score} cycles=${cyclicRun.overall.cycles}`)
}
{
  // 确定性：同一输入两次分析（不同时间戳）除 at 外逐字节一致。
  const again = await runCoupling({ graph: cyclicGraph, dir: workspace, now: '2026-11-02T00:00:00.000Z' })
  assert.equal(again.perNode.size, cyclicRun.perNode.size)
  for (const [id, coupling] of cyclicRun.perNode) {
    const other = again.perNode.get(id)
    const { at, ...rest } = coupling
    const { at: at2, ...rest2 } = other
    assert.deepEqual(rest2, rest, `deterministic result for ${id}`)
  }
  ok('determinism: same tree → byte-identical scores (at excluded)')
}

{
  const { graph: smallGraph } = await analyzeModules({ path: smallDir, projectName: 'small' })
  const run = await runCoupling({ graph: smallGraph, dir: workspace, now })
  for (const coupling of run.perNode.values()) {
    assert.equal(coupling.level, 'low', `isolated files are low (${coupling.score})`)
    assert.equal(coupling.metrics.sccSize, 1)
    assert.equal(coupling.metrics.fanIn, 0)
  }
  assert.equal(run.overall.level, 'low')
  assert.equal(run.overall.cycles, 0)
  ok('small fixture: every isolated module is low; overall low with 0 cycles')
}

{
  const { graph: symbolsGraph } = await analyzeModules({ path: symbolsDir, projectName: 'symbols' })
  const run = await runCoupling({ graph: symbolsGraph, dir: workspace, now })
  const coupling = [...run.perNode.values()][0]
  assert.equal(coupling.metrics.symbols, 6)
  assert.equal(coupling.metrics.refs, 5, 'deduped pairs: α→β, β→γ, γ→α, δ→α, δ→β')
  assert.ok(coupling.metrics.density > 0 && coupling.metrics.density < 1, `density in (0,1): ${coupling.metrics.density}`)
  assert.equal(coupling.metrics.maxFanOut, 2, 'delta reaches two symbols')
  assert.ok(coupling.intra > 0, 'inner cycle lifts the intra score: ' + coupling.intra)
  ok(`symbols fixture: refs=${coupling.metrics.refs} density=${coupling.metrics.density} intra=${coupling.intra}`)
}

{
  const { graph: unknownGraph } = await analyzeModules({ path: unknownDir, projectName: 'unknown' })
  const run = await runCoupling({ graph: unknownGraph, dir: workspace, now })
  assert.ok(run.perNode.size >= 1)
  for (const coupling of run.perNode.values()) {
    assert.equal(coupling.metrics.parsed, false, 'unrecognized language degrades honestly')
    assert.ok(Number.isFinite(coupling.score))
  }
  ok('unknown fixture: parsed=false, degraded formula, no crash')
}

/* ---- 部分结果 / 单节点 / 缺失文件 ---- */
{
  const first = cyclicGraph.nodes.filter(isFileModuleNode)[0]
  const partial = await runCoupling({ graph: cyclicGraph, dir: workspace, nodeIds: [first.id], now })
  assert.equal(partial.perNode.size, 1)
  assert.ok(partial.perNode.has(first.id))
  const full = cyclicRun.perNode.get(first.id)
  const { at, ...rest } = partial.perNode.get(first.id)
  const { at: at2, ...rest2 } = full
  assert.deepEqual(rest2, rest, 'single-node analysis matches the full analysis')
  assert.equal(partial.overall.partial, true)
  assert.equal(partial.overall.analyzed, 1)
  assert.equal(partial.overall.modules, 6)
  ok('partial run: one node, same score as the full run, overall partial 1/6')
}
{
  const ghostGraph = {
    format: 'codeflow/1', rev: 0,
    project: { name: 'ghost', origin: 'import' },
    nodes: [
      { id: 'm1', type: 'module', title: 'gone.py', pos: [0, 0], params: { path: path.join(cyclicDir, 'deleted.py'), symbol: '' }, status: 'pending' },
      { id: 'm2', type: 'module', title: 'a.py', pos: [0, 150], params: { path: path.join(cyclicDir, 'a.py'), symbol: '' }, status: 'pending' },
    ],
    links: [], meta: { importedFrom: cyclicDir, strategy: 'modules' },
  }
  const run = await runCoupling({ graph: ghostGraph, dir: workspace, now })
  assert.equal(run.perNode.get('m1'), null, 'missing file → null (clear the field)')
  assert.equal(run.skipped.length, 1)
  assert.ok(run.perNode.get('m2'))
  assert.equal(run.overall.partial, true)
  assert.equal(run.overall.analyzed, 1)
  ok('missing source file: coupling cleared, skipped counted, overall partial')
}
{
  // 符号子节点与 scan 等非 module 节点不参与。
  const mixed = {
    format: 'codeflow/1', rev: 0,
    project: { name: 'mixed', origin: 'import' },
    nodes: [
      { id: 'm1', type: 'scan', title: '扫描', pos: [0, 0], params: { path: cyclicDir }, status: 'done' },
      { id: 'm2', type: 'module', title: 'a.py', pos: [0, 150], params: { path: path.join(cyclicDir, 'a.py'), symbol: '' }, status: 'pending' },
      { id: 'm3', type: 'module', title: 'a.py · hub', pos: [0, 300], params: { path: path.join(cyclicDir, 'a.py'), symbol: 'hub' }, status: 'pending' },
    ],
    links: [], meta: { importedFrom: cyclicDir, strategy: 'modules' },
  }
  const run = await runCoupling({ graph: mixed, dir: workspace, now })
  assert.equal(run.perNode.size, 1, 'only the file-level module node is analyzed')
  assert.equal(run.overall.modules, 1)
  ok('symbol children and scan nodes are excluded from coupling')
}

/* ---- 清洗（store 白名单） ---- */
{
  assert.equal(normalizeCoupling(undefined), undefined)
  assert.equal(normalizeCoupling('nope'), undefined)
  assert.equal(normalizeCoupling({ level: 'extreme', score: 50 }), undefined, 'unknown level rejected')
  assert.equal(normalizeCoupling({ level: 'HIGH', score: 250 }), undefined, 'level is case-sensitive')
  assert.equal(normalizeCoupling({ level: 'high', score: 'x' }), undefined, 'NaN score rejected')
  assert.equal(normalizeCoupling({ level: 'high' }), undefined, 'missing score rejected')
  assert.equal(normalizeCoupling({ level: 'high', score: 50, metrics: 'nope' }).metrics.parsed, false, 'a broken metrics block degrades to defaults')
  ok('normalizeCoupling: illegal shapes rejected or degraded (see assertions above)')
}
{
  // 合法字段被夹紧到边界，未知键丢弃。
  const cleaned = normalizeCoupling({
    level: 'high', score: 250, intra: -5, inter: 40.6,
    metrics: { fanIn: 2.9, fanOut: -3, closure: 7, sccSize: 3, symbols: 4, refs: 5, density: 4.2, maxFanOut: 2, lines: 100, parsed: true, junk: 1 },
    at: '2026-11-01T09:20:11.000Z',
  })
  assert.deepEqual(cleaned, {
    level: 'high', score: 100, intra: 0, inter: 40,
    metrics: { fanIn: 2, fanOut: 0, closure: 7, depth: 0, sccSize: 3, symbols: 4, refs: 5, density: 1, maxFanOut: 2, lines: 100, parsed: true },
    at: '2026-11-01T09:20:11.000Z',
  })
  assert.ok(JSON.stringify(cleaned).length <= 800, 'serialized coupling stays ≤ 800 bytes')
  ok('normalizeCoupling: clamping, whitelist, density rounding, 800-byte bound')
}
{
  const mirror = normalizeMetaCoupling({
    version: 1, root: 'C:\\proj', at: '2026-11-01T09:20:11.000Z',
    overall: { level: 'medium', score: 44, modules: 12, analyzed: 3, cycles: 2, partial: true, worst: { id: 'm7', title: 'api.py', score: 78 } },
  })
  assert.equal(mirror.overall.analyzed, 3)
  assert.equal('source' in mirror, false, 'modules-graph meta carries no source')
  const mirrored = normalizeMetaCoupling({ ...mirror, source: 'modules' }, { mirror: true })
  assert.equal(mirrored.source, 'modules')
  assert.equal(normalizeMetaCoupling({ ...mirror, source: 'bogus' }, { mirror: true }), undefined, 'mirror must say modules')
  assert.equal(normalizeMetaCoupling({ source: 'modules' }, { mirror: true }), undefined, 'mirror without overall rejected')
  const bad = normalizeMetaCoupling({ overall: { level: 'meh', score: 10 } })
  assert.equal(bad, undefined, 'bad overall level rejected')
  ok('normalizeMetaCoupling: mirror/source discipline and overall validation')
}

/* ---- 旧图字节不变 / 写回 / tasks 隔离 ---- */
{
  const legacy = {
    format: 'codeflow/1', rev: 3,
    project: { name: 'legacy', origin: 'import' },
    nodes: [{ id: 'm1', type: 'module', title: 'a.py', pos: [1, 2], params: { path: '/x/a.py', symbol: '' }, status: 'pending', result: '', detail: '', artifacts: [{ path: 'a.py', kind: 'code' }] }],
    links: [['m1', 0, 'm1', 0]],
    meta: { createdAt: 't', updatedAt: 't', importedFrom: '/x', strategy: 'modules' },
  }
  const roundTripped = JSON.parse(JSON.stringify(normalizeGraph(legacy)))
  const stripped = JSON.parse(JSON.stringify(legacy))
  assert.deepEqual(roundTripped, stripped, 'a graph without coupling normalizes to itself (no phantom keys)')
  ok('legacy graphs stay byte-identical through normalizeGraph')
}
{
  const store = createStore(console)
  const modulesGraph = {
    format: 'codeflow/1', rev: 0,
    project: { name: 'couple-store', origin: 'import' },
    nodes: [{ id: 'm1', type: 'module', title: 'a.py', pos: [0, 0], params: { path: path.join(cyclicDir, 'a.py'), symbol: '' }, status: 'pending', result: '', detail: '' }],
    links: [], meta: { importedFrom: cyclicDir, strategy: 'modules' },
  }
  await store.write(modulesGraph, { persist: 'now', cwd: workspace, view: 'modules' })
  // 先有任务图，镜像才有落点（与真实项目一致：导入一次生成两张图）。
  await store.write({
    format: 'codeflow/1', rev: 0,
    project: { name: 'couple-store', origin: 'import' },
    nodes: [{ id: 't1', type: 'edit', title: '任务', pos: [0, 0], params: {}, status: 'pending', result: '', detail: '' }],
    links: [], meta: { importedFrom: cyclicDir, strategy: 'tasks' },
  }, { persist: 'now', cwd: workspace, view: 'tasks' })
  const { result, written } = await runCouplingForStore(store, modulesGraph, 'couple-store')
  assert.equal(written?.view, 'modules')
  const node = store.get('couple-store', 'modules').graph.nodes[0]
  assert.ok(node.coupling, 'coupling persisted on the node')
  assert.ok(store.get('couple-store', 'modules').graph.meta.coupling, 'meta.coupling written')
  const tasksState = store.get('couple-store', 'tasks')
  assert.ok(tasksState.rev > 0, 'tasks view exists (mirror)')
  assert.ok(tasksState.graph.meta.coupling, 'meta.coupling mirrored to tasks')
  assert.equal(tasksState.graph.meta.coupling.source, 'modules')
  assert.ok(tasksState.graph.nodes.every((entry) => entry.coupling === undefined), 'tasks nodes never carry coupling')
  const modulesOnDisk = JSON.parse(await readFile(path.join(workspace, 'CodeFlow', 'flow-projects', 'couple-store', 'workflow.modules.json'), 'utf8'))
  assert.ok(modulesOnDisk.nodes[0].coupling)
  const tasksOnDisk = JSON.parse(await readFile(path.join(workspace, 'CodeFlow', 'flow-projects', 'couple-store', 'workflow.json'), 'utf8'))
  assert.equal(tasksOnDisk.meta.coupling.source, 'modules')
  assert.ok(tasksOnDisk.nodes.every((entry) => entry.coupling === undefined))
  assert.equal(result.overall.partial, false, 'the single-node store run analyzed its only module')
  ok('persistence: node coupling + meta on modules, source:modules mirror on tasks, tasks nodes clean')
}
{
  // tasks 视图写入时强行携带节点级 coupling → 被清洗（双视图隔离）。
  const store = createStore(console)
  const tainted = {
    format: 'codeflow/1', rev: 0,
    project: { name: 'tainted', origin: 'new' },
    nodes: [{ id: 't1', type: 'edit', title: '任务', pos: [0, 0], params: {}, status: 'pending', result: '', detail: '', coupling: { level: 'high', score: 90 } }],
    links: [], meta: {},
  }
  await store.write(tainted, { persist: 'never', cwd: workspace, view: 'tasks' })
  assert.ok(store.get('tainted', 'tasks').graph.nodes.every((entry) => entry.coupling === undefined), 'tasks write strips node coupling')
  ok('dual-view isolation: a tainted tasks write loses its node coupling labels')
}

/* ---- 过期判定 ---- */
{
  clearStaleCache()
  const filePath = path.join(cyclicDir, 'a.py')
  const graph = {
    format: 'codeflow/1', rev: 0,
    project: { name: 'stale', origin: 'import' },
    nodes: [{ id: 'm1', type: 'module', title: 'a.py', pos: [0, 0], params: { path: filePath, symbol: '' }, status: 'pending', coupling: { level: 'low', score: 5, at: '2026-01-01T00:00:00.000Z' } }],
    links: [], meta: { importedFrom: cyclicDir, strategy: 'modules', coupling: { version: 1, at: '2026-01-01T00:00:00.000Z', overall: { level: 'low', score: 5, modules: 1, analyzed: 1, cycles: 0, partial: false } } },
  }
  const fresh = await computeStale({ graph })
  // 文件 mtime 晚于 coupling.at → 节点过期。
  assert.equal(fresh.overall, true)
  assert.equal(fresh.nodes.m1, true)
  // 把文件 mtime 拨回到分析时间之前 → 不再过期。
  const analyzedAt = new Date('2026-01-01T00:00:00.000Z')
  await utimes(filePath, analyzedAt, analyzedAt)
  clearStaleCache()
  const stillFresh = await computeStale({ graph })
  assert.equal(stillFresh.overall, false)
  assert.equal(stillFresh.nodes.m1, undefined)
  // 模块数量漂移 → 整体过期。
  const drifted = JSON.parse(JSON.stringify(graph))
  drifted.nodes.push({ id: 'm2', type: 'module', title: 'b.py', pos: [0, 150], params: { path: filePath, symbol: '' }, status: 'pending' })
  const drift = await computeStale({ graph: drifted })
  assert.equal(drift.overall, true, 'module count drift marks the verdict stale')
  ok('stale: mtime comparison + module-count drift, 10s cache resettable')
}

/* ---- metaCouplingOf / overallOf 单元 ---- */
{
  const overall = overallOf(
    [{ id: 'm1' }, { id: 'm2' }],
    new Map([['m1', { score: 80, metrics: { lines: 100, sccSize: 2, parsed: true } }]]),
    [{ id: 'm1', title: 'a.py', score: 80, metrics: { lines: 100, sccSize: 2, parsed: true } }],
  )
  // base=80, cyclePenalty=3 → 83 → high；partial（1/2）。
  assert.equal(overall.score, 83)
  assert.equal(overall.level, 'high')
  assert.equal(overall.partial, true)
  assert.equal(overall.cycles, 1)
  assert.deepEqual(overall.worst, { id: 'm1', title: 'a.py', score: 80 })
  assert.equal(overallOf([], new Map(), []), null, 'nothing analyzed → overall null')
  const meta = metaCouplingOf({ root: 'C:\\proj', overall, now })
  assert.equal(meta.version, 1)
  assert.equal(meta.overall.modules, 2)
  assert.equal('restricted' in meta.overall, false, 'response shape stays exactly as specified')
  ok('overallOf/metaCouplingOf: weighted mean + cycle penalty + exact shape')
}

await rm(workspace, { recursive: true, force: true })
console.log(`\ncoupling: ${passed} checks passed`)

/* ---- helper：在 store 上跑一次完整耦合（tests 内的迷你编排） ---- */
async function runCouplingForStore(store, modulesGraph, projectKey) {
  const state = store.get(projectKey, 'modules')
  const result = await runCoupling({ graph: state.graph ?? modulesGraph, dir: workspace, now })
  const nextNodes = state.graph.nodes.map((node) => {
    if (!result.perNode.has(node.id)) return node
    const coupling = result.perNode.get(node.id)
    const clean = { ...node }
    if (coupling === null) delete clean.coupling
    else clean.coupling = coupling
    return clean
  })
  const metaCoupling = metaCouplingOf({ root: result.root, overall: result.overall })
  const written = await store.write(
    { ...state.graph, nodes: nextNodes, meta: { ...state.graph.meta, ...(metaCoupling !== undefined ? { coupling: metaCoupling } : {}) } },
    { view: 'modules', persist: 'now', cwd: workspace },
  )
  const tasksState = store.get(projectKey, 'tasks')
  if (tasksState.rev > 0 || tasksState.viewLoaded === true) {
    const mirror = metaCouplingOf({ root: result.root, overall: result.overall, source: 'modules' })
    if (mirror !== undefined) {
      await store.write(
        { ...tasksState.graph, meta: { ...tasksState.graph.meta, coupling: mirror } },
        { view: 'tasks', persist: 'now', cwd: workspace },
      )
    }
  }
  return { result, written }
}
