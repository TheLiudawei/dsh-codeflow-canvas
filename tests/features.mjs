/**
 * Feature-group recognition (v1.1) self-check: recognition algorithm, the
 * features.json contract, the HTTP surface, the `codeflow_features` tool and
 * the idempotency of the ported canvas asset.
 *
 * Everything runs against temp fixtures and the fake Cordis context — no DSH
 * runtime, no model, no network.
 *
 * Run: node tests/features.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Dynamic import that survives Windows absolute paths (file:// URL). */
const importFrom = (...segments) => import(pathToFileURL(path.join(ROOT, ...segments)).href)

const failures = []
let checks = 0

/** Run one named assertion, recording rather than throwing. */
async function check(name, fn) {
  checks += 1
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL  ${name}: ${error.message}`)
  }
}

/* ------------------------------------------------------------------ fakes --- */

function fakeRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return Object.assign(Readable.from(chunks), {
    method,
    url,
    headers: { host: '127.0.0.1:19387' },
  })
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(chunk) {
      if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    },
  }
}

/** A fake Cordis context (same shape as validate.mjs). */
function fakeContext(services = {}) {
  const recorded = { skillProviders: [], commands: [], tools: [], routes: [], agents: new Map() }
  const ctx = {
    logger: { warn() {}, info() {} },
    effects: [],
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') ctx.effects.push(dispose)
      return dispose
    },
    on() { return () => {} },
    get(name) {
      if (Object.hasOwn(services, name)) return services[name]
      if (name === 'agents') return { get: (id) => recorded.agents.get(id), roots: () => [...recorded.agents.values()] }
      return undefined
    },
    inject(names, callback) {
      callback(ctx)
    },
    skills: { registerProvider() { return () => {} } },
    commands: { register() { return () => {} } },
    tools: {
      register(definition) {
        recorded.tools.push(definition)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        recorded.routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, recorded }
}

/** A session controller whose prompts are recorded (for the agent endpoint). */
function fakeSessionController() {
  const state = { created: [], prompts: [], renamed: [] }
  return {
    state,
    async create(request) {
      const sessionId = `sess-${state.created.length + 1}`
      state.created.push({ sessionId, cwd: request.cwd })
      return { sessionId }
    },
    async rename(request) {
      state.renamed.push(request)
      return { title: request.title, seq: 1 }
    },
    async prompt(request) {
      state.prompts.push(request)
      return { accepted: true }
    },
  }
}

/** A tiny deterministic python-flavoured project. */
async function makeProject({ withDesign = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'cf-features-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  if (withDesign) {
    await mkdir(path.join(root, 'docs'), { recursive: true })
    await writeFile(
      path.join(root, 'docs', 'design.md'),
      '# 方案\n\n## 功能\n- 登录：src/auth.py、src/session.py\n- 支付: src/pay.py\n\n| 导出 | src/report.py |\n',
      'utf8',
    )
  }
  await writeFile(
    path.join(root, 'src', 'auth.py'),
    'import session\nfrom flask import Flask\napp=Flask(__name__)\n@app.route("/login")\ndef login():\n    return session.ok()\n\nclass AuthService:\n    pass\n',
    'utf8',
  )
  await writeFile(path.join(root, 'src', 'session.py'), 'def ok():\n    return True\n', 'utf8')
  await writeFile(path.join(root, 'src', 'pay.py'), '@app.route("/pay")\ndef pay():\n    return 1\n', 'utf8')
  await writeFile(path.join(root, 'src', 'report.py'), '@app.route("/export")\ndef export_csv():\n    return 1\n', 'utf8')
  await writeFile(path.join(root, 'src', 'misc.py'), 'X = 1\n', 'utf8')
  return root
}

/** A two-node modules graph for `root`. */
function modulesGraphOf(root, extra = []) {
  return {
    format: 'codeflow/1', rev: 0,
    project: { name: 'feat-demo', origin: 'import' },
    nodes: [
      { id: 'm1', type: 'module', title: 'auth.py', pos: [0, 0], params: { path: path.join(root, 'src', 'auth.py'), symbol: '' }, status: 'pending', result: '', detail: '' },
      { id: 'm2', type: 'module', title: 'auth.py · AuthService', pos: [170, 150], params: { path: path.join(root, 'src', 'auth.py'), symbol: 'AuthService' }, status: 'pending', result: '', detail: '' },
      { id: 'm3', type: 'module', title: 'session.py', pos: [0, 150], params: { path: path.join(root, 'src', 'session.py'), symbol: '' }, status: 'pending', result: '', detail: '' },
      { id: 'm4', type: 'module', title: 'pay.py', pos: [340, 0], params: { path: path.join(root, 'src', 'pay.py'), symbol: '' }, status: 'pending', result: '', detail: '' },
      { id: 'm5', type: 'module', title: 'report.py', pos: [340, 150], params: { path: path.join(root, 'src', 'report.py'), symbol: '' }, status: 'pending', result: '', detail: '' },
      { id: 'm6', type: 'module', title: 'misc.py', pos: [0, 300], params: { path: path.join(root, 'src', 'misc.py'), symbol: '' }, status: 'pending', result: '', detail: '' },
      ...extra,
    ],
    links: [],
    meta: { importedFrom: root, strategy: 'modules' },
  }
}

const cleanup = []
async function rmLater(dir) {
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
}

/* ------------------------------------------------------------------ main --- */

const {
  FEATURES_FILE, buildFeatureIndex, readFeatureIndex, writeFeatureIndex, applyManual,
  effectiveFeatures, mapNodes, summarize, emptyIndex, featureOp, computeStale,
  parseDesignDoc, sanitizeIndex,
} = await importFrom('lib', 'features.js')

console.log('\n[features: recognition]')
{
  const root = await makeProject()
  await rmLater(root)
  const graph = modulesGraphOf(root)

  await check('buildFeatureIndex: design.md + entry + symbols + closure, honest about unmapped', async () => {
    const index = await buildFeatureIndex({ root, graph })
    assert.equal(index.unavailable, undefined)
    assert.ok(index.features.length >= 3, `expected ≥3 features, got ${index.features.length}`)
    const login = index.features.find((f) => f.name === '登录')
    assert.ok(login, '登录 recognized via design.md + route + dictionary')
    assert.ok(login.files.includes('src/auth.py'), login.files.join(','))
    assert.ok(login.files.includes('src/session.py'), 'import closure pulls the dependency in (≤2 hops)')
    assert.deepEqual(login.nodes.slice().sort(), ['m1', 'm2', 'm3'], 'symbol child m2 inherits the parent file assignment')
    assert.ok(login.confidence >= 0.5, `登录 confidence ${login.confidence}`)
    const pay = index.features.find((f) => f.name === '支付')
    assert.ok(pay && pay.files.includes('src/pay.py') && pay.nodes.includes('m4'))
    const dao = index.features.find((f) => f.name === '导出')
    assert.ok(dao && dao.files.includes('src/report.py'), 'design.md table rows are parsed too')
    assert.ok(index.unmapped.includes('m6'), 'misc.py has no signal → unmapped')
    assert.ok(index.evidence === undefined)
    assert.equal(index.source, 'auto')
  })

  await check('dictionary synonym merge: auth/login/session/AuthService all collapse into 登录', async () => {
    const index = await buildFeatureIndex({ root, graph })
    const login = index.features.find((f) => f.name === '登录')
    assert.ok(!index.features.some((f) => ['login', 'auth', 'session', 'AuthService'].includes(f.name)), 'no raw duplicates beside the canonical name')
    assert.ok(login.aliases.some((alias) => /login|auth|session/i.test(alias)), login.aliases.join(','))
  })

  await check('empty signal → features: [] (no fabricated clustering)', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'cf-features-bare-'))
    await rmLater(bare)
    await writeFile(path.join(bare, 'a.py'), 'X = 1\n', 'utf8')
    const index = await buildFeatureIndex({ root: bare })
    assert.deepEqual(index.features, [])
    assert.equal(index.unavailable, undefined)
  })

  await check('a missing source root degrades to an honest unavailable index', async () => {
    const missing = path.join(root, 'deleted-source')
    const index = await buildFeatureIndex({ root: missing })
    assert.deepEqual(index.features, [])
    assert.ok(String(index.unavailable).includes('不存在'), index.unavailable)
  })
}

console.log('\n[features: caps]')
{
  const root = await makeProject({ withDesign: false })
  await rmLater(root)
  // 14 routes → at most 12 features; design.md listing 40 files → capped at 30.
  const writes = []
  for (let i = 0; i < 14; i += 1) {
    writes.push(writeFile(path.join(root, `src`, `feat${i}.py`), `@app.route("/feat${i}")\ndef feat${i}():\n    return ${i}\n`, 'utf8'))
  }
  const capped = Array.from({ length: 40 }, (_, i) => `src/cap${String(i).padStart(2, '0')}.py`)
  await mkdir(path.join(root, 'docs'), { recursive: true })
  await writeFile(path.join(root, 'docs', 'design.md'), `## 功能\n- 大功能：${capped.join('、')}\n`, 'utf8')
  for (const rel of capped) await writeFile(path.join(root, rel), 'X = 1\n', 'utf8')
  await Promise.all(writes)

  await check('at most 12 features and 30 files per feature, truncation recorded in evidence', async () => {
    const index = await buildFeatureIndex({ root })
    assert.ok(index.features.length <= 12, `features capped, got ${index.features.length}`)
    const big = index.features.find((f) => f.name === '大功能')
    assert.ok(big, 'the 40-file design entry is recognized')
    assert.equal(big.files.length, 30, 'files capped at 30')
    assert.ok(big.evidence.some((entry) => entry.includes('已截断 10 个')), big.evidence.join(' | '))
  })
}

console.log('\n[features: manual priority]')
{
  const root = await makeProject()
  await rmLater(root)
  const graph = modulesGraphOf(root)

  await check('manual.labels wins and survives rebuild; renames/merge/dissolve apply', async () => {
    const index = await buildFeatureIndex({ root, graph })
    // 1. manual label on an unmapped file creates/extends a feature.
    index.manual.labels['src/misc.py'] = ['导出']
    const eff1 = effectiveFeatures(index)
    const dao1 = eff1.find((f) => f.name === '导出')
    assert.ok(dao1.files.includes('src/misc.py'), 'path-key label applies')
    const mapped1 = mapNodes({ features: eff1, manual: index.manual }, graph, { root })
    const daoNodes1 = mapped1.features.find((f) => f.name === '导出').nodes
    assert.deepEqual(daoNodes1.sort(), ['m5', 'm6'], `misc.py node m6 joins 导出: ${daoNodes1.join(',')}`)

    // 2. node-id label + excluded.
    const labeled = applyManual(index, {
      ...index.manual,
      labels: { ...index.manual.labels, m6: ['支付'] },
      excluded: { m6: ['导出'] },
    })
    const mapped2 = mapNodes(labeled, graph, { root })
    const payNodes = mapped2.features.find((f) => f.name === '支付').nodes
    assert.deepEqual(payNodes.sort(), ['m4', 'm6'], 'node-id label applies and the excluded 导出 is stripped')

    // 3. rename / merge / dissolve via featureOp, persisted, then "rebuild" keeps manual.
    const projDir = await mkdtemp(path.join(tmpdir(), 'cf-features-proj-'))
    await rmLater(projDir)
    const clean = emptyIndex()
    clean.features = index.features
    clean.generatedAt = index.generatedAt
    await writeFeatureIndex(projDir, clean)
    await featureOp({ op: 'rename', body: { from: '登录', to: '账号登录' }, index: await readFeatureIndex(projDir), dir: projDir, root, graph, persist: true })
    await featureOp({ op: 'merge', body: { from: '支付', to: '账号登录' }, index: await readFeatureIndex(projDir), dir: projDir, root, graph, persist: true })
    const afterMerge = await readFeatureIndex(projDir)
    assert.ok(afterMerge.manual.renames['登录'] === '账号登录', 'rename recorded')
    // merged 的值存「原名」：renames 在应用顺序里后于 merged，展示名再叠加。
    assert.ok(afterMerge.manual.merged['支付'] === '登录', 'merge recorded (original names)')
    const eff2 = effectiveFeatures(afterMerge)
    assert.ok(!eff2.some((f) => f.name === '支付'), 'merged-away feature is gone')
    const login2 = eff2.find((f) => f.name === '账号登录')
    assert.ok(login2, 'renamed feature exists')
    assert.ok(login2.files.includes('src/pay.py'), 'merged files moved')
    await featureOp({ op: 'dissolve', body: { feature: '导出' }, index: await readFeatureIndex(projDir), dir: projDir, root, graph, persist: true })
    const afterDissolve = await readFeatureIndex(projDir)
    assert.ok(afterDissolve.manual.dissolved.includes('导出'), 'dissolve recorded')
    assert.ok(!effectiveFeatures(afterDissolve).some((f) => f.name === '导出'), 'dissolved feature dropped')
    // 4. rebuild with the same manual: labels/renames/merged/dissolved all preserved.
    const rebuilt = await featureOp({ op: 'rebuild', index: await readFeatureIndex(projDir), dir: projDir, root, graph, persist: true })
    assert.ok(rebuilt.index.manual.renames['登录'] === '账号登录', 'manual survived the rebuild')
    assert.ok(rebuilt.index.manual.dissolved.includes('导出'), 'dissolved survived the rebuild')
    const eff3 = effectiveFeatures(rebuilt.index)
    assert.ok(eff3.some((f) => f.name === '账号登录'), 'rename re-applied after rebuild')
    assert.ok(!eff3.some((f) => f.name === '导出'), 'dissolve re-applied after rebuild')
  })
}

console.log('\n[features: lenient parsing]')
{
  const dir = await mkdtemp(path.join(tmpdir(), 'cf-features-bad-'))
  await rmLater(dir)
  const warns = []
  const originalWarn = console.warn
  console.warn = (...args) => { warns.push(args.join(' ')) }

  await check('truncated JSON → empty index, exactly one warn, no throw', async () => {
    await writeFile(path.join(dir, FEATURES_FILE), '{"version":1,"features":[{"id":"f-x","na', 'utf8')
    const index = await readFeatureIndex(dir)
    assert.equal(index.features.length, 0)
    assert.equal(index._degraded, true)
    await writeFile(path.join(dir, FEATURES_FILE), '{"version":1,"features":[{"id":"f-x","na', 'utf8')
    await readFeatureIndex(dir)
    console.warn = originalWarn
    assert.equal(warns.length, 1, `warn at most once per file, got ${warns.length}`)
  })

  await check('wrong-typed fields are dropped, not fatal', async () => {
    const index = sanitizeIndex({ version: 1, features: 'nope', unmapped: 42, manual: [1, 2], generatedAt: 7 })
    assert.deepEqual(index.features, [])
    assert.deepEqual(index.unmapped, [])
    assert.deepEqual(index.manual.labels, {})
    assert.equal(index._degraded, true)
    const partial = sanitizeIndex({
      features: [
        { name: '登录', files: ['src\\auth.py', '', null], nodes: ['m1', 'm1', 3], confidence: 9, aliases: [1, 'login'], evidence: ['ok'] },
        { name: '' },
        'junk',
        null,
      ],
      manual: { labels: { 'src/a.py': ['登录', '登录', ''] }, renames: { '登录': '' }, merged: { 'a': 'b' } },
    })
    assert.equal(partial.features.length, 1)
    assert.deepEqual(partial.features[0].files, ['src/auth.py'], 'separators normalized, empties dropped')
    assert.deepEqual(partial.features[0].nodes, ['m1'])
    assert.equal(partial.features[0].confidence, 1, 'confidence clamped into [0,1]')
    assert.deepEqual(partial.features[0].aliases, ['login'])
    assert.deepEqual(partial.manual.labels['src/a.py'], ['登录'])
    assert.deepEqual(partial.manual.renames, {}, 'empty rename targets dropped')
    assert.deepEqual(partial.manual.merged, { a: 'b' })
    assert.equal(partial._degraded, false)
  })

  await check('a missing file is null, not an error', async () => {
    assert.equal(await readFeatureIndex(dir + '-nowhere'), null)
  })
}

console.log('\n[features: mapNodes / tasks view]')
{
  const root = await makeProject()
  await rmLater(root)
  await check('symbol children inherit; tasks matching uses artifacts → params.dir → detail', async () => {
    const index = await buildFeatureIndex({ root })
    const graph = modulesGraphOf(root)
    const mapped = mapNodes({ features: index.features, manual: emptyIndex().manual }, graph, { root })
    const login = mapped.features.find((f) => f.name === '登录')
    assert.ok(login.nodes.includes('m2'), 'symbol node inherits the file-level assignment')
    assert.ok(mapped.unmapped.includes('m6'), 'file-level unassigned nodes are unmapped (symbol nodes follow their parent)')

    const tasksGraph = {
      format: 'codeflow/1', rev: 0,
      project: { name: 'feat-demo', origin: 'import' },
      nodes: [
        { id: 't1', type: 'codegen', pos: [0, 0], params: {}, status: 'pending', result: '', detail: '', artifacts: [{ path: path.join(root, 'src', 'auth.py'), kind: 'code' }] },
        { id: 't2', type: 'write', pos: [330, 0], params: { dir: 'src' }, status: 'pending', result: '', detail: '' },
        { id: 't3', type: 'edit', pos: [660, 0], params: { instruction: 'x' }, status: 'pending', result: '', detail: '修改 src/pay.py 中的支付逻辑' },
        { id: 't4', type: 'review', pos: [990, 0], params: {}, status: 'pending', result: '', detail: '' },
      ],
      links: [],
      meta: { importedFrom: root, strategy: 'tasks' },
    }
    const tasksMapped = mapNodes({ features: index.features, manual: emptyIndex().manual }, tasksGraph, { root })
    const loginTasks = tasksMapped.features.find((f) => f.name === '登录')
    assert.ok(loginTasks.nodes.includes('t1'), 'artifacts match by absolute path')
    assert.ok(loginTasks.nodes.includes('t2'), 'params.dir=src matches files under src/')
    const payTasks = tasksMapped.features.find((f) => f.name === '支付')
    assert.ok(payTasks.nodes.includes('t3'), 'detail text mentioning the rel path matches')
    assert.equal(tasksMapped.unmapped.length, 0, 'tasks view reports no module unmapped list')
  })

  await check('computeStale: newer workflow mtime or missing generatedAt → stale', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cf-features-stale-'))
    await rmLater(dir)
    const index = emptyIndex()
    index.generatedAt = new Date(Date.now() - 60_000).toISOString()
    await writeFile(path.join(dir, 'workflow.json'), '{}', 'utf8')
    assert.equal(await computeStale(index, dir), true, 'workflow.json newer than the index')
    index.generatedAt = new Date(Date.now() + 60_000).toISOString()
    assert.equal(await computeStale(index, dir), false)
    index.generatedAt = null
    assert.equal(await computeStale(index, dir), true)
  })
}

console.log('\n[features: summarize / parseDesignDoc]')
await check('summarize stays ≤80 chars and names low-confidence groups', () => {
  const text = summarize({
    features: [
      { name: '登录', files: ['a', 'b'], nodes: ['m1', 'm2'], confidence: 0.9 },
      { name: '导出', files: ['c'], nodes: [], confidence: 0.35 },
    ],
  })
  assert.ok(text.includes('识别 2 个功能'), text)
  assert.ok(text.includes('2 个模块'), text)
  assert.ok(text.includes('1 个低置信'), text)
  assert.ok(text.length <= 80, text)
  const design = parseDesignDoc('## 功能\n- 登录：src/auth.py、src/session.py\n- 没有文件的功能\n', new Set(['src/auth.py', 'src/session.py']))
  assert.equal(design.length, 1, 'entries without matchable files are dropped')
  assert.deepEqual(design[0].files, ['src/auth.py', 'src/session.py'])
})

console.log('\n[features: http surface]')
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'cf-features-http-'))
  const sourceRoot = await makeProject()
  rmLater(workspace)
  rmLater(sourceRoot)
  const projectDir = path.join(workspace, 'CodeFlow', 'flow-projects', 'feat-http')
  await mkdir(projectDir, { recursive: true })
  const controller = fakeSessionController()
  const { ctx, recorded } = fakeContext({ sessionController: controller })
  const { apply } = await importFrom('lib', 'index.js')
  apply(ctx)
  recorded.agents.set('s-feat', { id: 's-feat', session: { header: { cwd: workspace } }, followup() {} })
  const handler = recorded.routes[0].handler
  const call = async (method, url, body) => {
    const res = fakeResponse()
    await handler(fakeRequest(method, url, body), res)
    return { status: res.statusCode, json: res.body.startsWith('{') ? JSON.parse(res.body) : undefined }
  }
  // Bind the project through a graph write, exactly like the panel would.
  await call('POST', '/codeflow/api/state', {
    graph: { ...modulesGraphOf(sourceRoot), project: { name: 'feat-http', origin: 'import' } },
  })

  await check('GET /api/features recognizes and persists features.json on first read', async () => {
    const res = await call('GET', '/codeflow/api/features?project=feat-http&view=modules')
    assert.equal(res.status, 200, res.json && res.json.error)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.view, 'modules')
    assert.ok(res.json.features.length >= 3, `features: ${res.json.features.map((f) => f.name).join(',')}`)
    for (const feature of res.json.features) {
      assert.ok(feature.id.startsWith('f-'))
      assert.equal(typeof feature.count, 'number')
      assert.ok(Array.isArray(feature.nodes) && Array.isArray(feature.files) && Array.isArray(feature.aliases))
      assert.equal(feature.low, feature.confidence < 0.5)
    }
    assert.ok(res.json.features.some((f) => f.name === '登录' && f.nodes.includes('m2')), 'symbol node mapped')
    assert.ok(typeof res.json.unmappedCount === 'number')
    const persisted = JSON.parse(await readFile(path.join(projectDir, FEATURES_FILE), 'utf8'))
    assert.ok(Array.isArray(persisted.features) && persisted.features.length > 0)
    assert.ok(persisted.manual && typeof persisted.manual.labels === 'object')
  })

  await check('POST /api/features label → manual.labels written; GET reflects it', async () => {
    const post = await call('POST', '/codeflow/api/features', { op: 'label', project: 'feat-http', view: 'modules', nodeId: 'm6', feature: '支付' })
    assert.equal(post.status, 200, JSON.stringify(post.json))
    const persisted = JSON.parse(await readFile(path.join(projectDir, FEATURES_FILE), 'utf8'))
    assert.ok((persisted.manual.labels.m6 ?? []).includes('支付') || Object.values(persisted.manual.labels).some((v) => v.includes('支付')), JSON.stringify(persisted.manual.labels))
    const get = await call('GET', '/codeflow/api/features?project=feat-http&view=modules')
    const pay = get.json.features.find((f) => f.name === '支付')
    assert.ok(pay.nodes.includes('m6'), 'the manual node label is served back')
    const remove = await call('POST', '/codeflow/api/features', { op: 'label', project: 'feat-http', view: 'modules', nodeId: 'm6', feature: '支付', remove: true })
    assert.equal(remove.status, 200)
    const after = await call('GET', '/codeflow/api/features?project=feat-http&view=modules')
    assert.ok(!after.json.features.find((f) => f.name === '支付').nodes.includes('m6'), 'removal sticks')
  })

  await check('POST /api/features rename/merge/dissolve/rebuild with manual preserved', async () => {
    let res = await call('POST', '/codeflow/api/features', { op: 'rename', project: 'feat-http', from: '登录', to: '账号登录' })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.ok(res.json.features.some((f) => f.name === '账号登录'), res.json.features.map((f) => f.name).join(','))
    res = await call('POST', '/codeflow/api/features', { op: 'merge', project: 'feat-http', from: '支付', to: '账号登录' })
    assert.equal(res.status, 200)
    res = await call('POST', '/codeflow/api/features', { op: 'dissolve', project: 'feat-http', feature: '导出' })
    assert.equal(res.status, 200)
    res = await call('POST', '/codeflow/api/features', { op: 'rebuild', project: 'feat-http' })
    assert.equal(res.status, 200)
    const persisted = JSON.parse(await readFile(path.join(projectDir, FEATURES_FILE), 'utf8'))
    assert.equal(persisted.manual.renames['登录'], '账号登录')
    assert.equal(persisted.manual.merged['支付'], '登录', 'merged stores the original target name')
    assert.ok(persisted.manual.dissolved.includes('导出'))
    assert.ok(res.json.features.some((f) => f.name === '账号登录'))
    assert.ok(!res.json.features.some((f) => f.name === '导出'))
  })

  await check('a hand-broken features.json degrades to recognition without 500', async () => {
    await writeFile(path.join(projectDir, FEATURES_FILE), '{"version":1,"features":[{"id":"f-x",', 'utf8')
    const res = await call('GET', '/codeflow/api/features?project=feat-http&view=modules')
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.ok(Array.isArray(res.json.features), 'the fallback recognition answers with a shape-valid payload')
  })

  await check('POST /api/features/agent delivers [CodeFlow:FEATURES] to the dedicated session', async () => {
    const before = controller.state.prompts.length
    const res = await call('POST', '/codeflow/api/features/agent', { project: 'feat-http' })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.json.delivered, true)
    assert.equal(controller.state.prompts.length, before + 1)
    const text = controller.state.prompts[controller.state.prompts.length - 1].content[0].text
    const firstLine = text.slice(0, text.indexOf('\n'))
    assert.ok(firstLine.startsWith('[CodeFlow:FEATURES]'), firstLine)
    const payload = JSON.parse(firstLine.slice(firstLine.indexOf(']') + 1))
    assert.equal(payload.action, 'FEATURES')
    assert.equal(payload.project, 'feat-http')
    assert.equal(payload.view, 'modules')
    assert.ok(payload.graphPath.includes('workflow.modules.json'), payload.graphPath)
    assert.ok(String(payload.featuresPath).includes(FEATURES_FILE))
    assert.ok(Array.isArray(payload.candidates))
    assert.ok(text.includes('codeflow_features'), 'the requirements body names the write tool')
    assert.ok(text.includes('不要重扫全部代码'), 'the requirements body forbids full rescans')
  })

  await check('unknown ops answer 400; GET without a project falls back to mostRecent', async () => {
    assert.equal((await call('POST', '/codeflow/api/features', { op: 'explode', project: 'feat-http' })).status, 400)
    const fallback = await call('GET', '/codeflow/api/features')
    assert.equal(fallback.status, 200)
    assert.equal(fallback.json.project, 'feat-http', 'same convention as GET /api/state')
  })
}

console.log('\n[features: codeflow_features tool]')
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'cf-features-tool-'))
  const sourceRoot = await makeProject()
  rmLater(workspace)
  rmLater(sourceRoot)
  const { ctx, recorded } = fakeContext()
  const { apply } = await importFrom('lib', 'index.js')
  apply(ctx)
  const tool = recorded.tools.find((entry) => entry.name === 'codeflow_features')
  recorded.agents.set('s-tool', { id: 's-tool', session: { header: { cwd: workspace } }, followup() {} })
  const agent = recorded.agents.get('s-tool')
  // Bind the project through the HTTP layer (the tool reads the same store).
  const handler = recorded.routes[0].handler
  const call = async (method, url, body) => {
    const res = fakeResponse()
    await handler(fakeRequest(method, url, body), res)
    return { status: res.statusCode, json: res.body.startsWith('{') ? JSON.parse(res.body) : undefined }
  }
  await call('POST', '/codeflow/api/state', {
    graph: { ...modulesGraphOf(sourceRoot), project: { name: 'feat-tool', origin: 'import' } },
  })

  await check('op=list returns compact lines and never the graph', async () => {
    const value = await tool.execute({ op: 'list', project: 'feat-tool' }, { agent })
    assert.equal(value.op, 'list')
    assert.ok(value.summary.includes('登录'), value.summary)
    assert.ok(value.summary.includes('m1'), value.summary)
    assert.ok(!value.summary.includes('codeflow/1'), 'no graph envelope leaks')
    assert.ok(!value.summary.includes('def login'), 'no source leaks')
    assert.ok(value.summary.length <= 420, `summary clipped, got ${value.summary.length}`)
  })

  await check('op=write records manual labels; unmatched files are reported, not dropped', async () => {
    const value = await tool.execute({
      op: 'write',
      project: 'feat-tool',
      mode: 'replace-manual',
      features: [
        { name: '消息', files: ['src/misc.py', 'src/ghost.py'], evidence: ['agent'] },
        { name: '登录', files: ['src/session.py'] },
      ],
    }, { agent })
    assert.equal(value.op, 'write')
    assert.equal(value.unmatched, 1, `unmatched: ${value.summary}`)
    assert.ok(value.summary.includes('src/ghost.py'), value.summary)
    const projDir = path.join(workspace, 'CodeFlow', 'flow-projects', 'feat-tool')
    const persisted = JSON.parse(await readFile(path.join(projDir, FEATURES_FILE), 'utf8'))
    assert.ok((persisted.manual.labels['src/misc.py'] ?? []).includes('消息'), JSON.stringify(persisted.manual.labels))
    assert.ok((persisted.manual.labels['src/session.py'] ?? []).includes('登录'))
    const list = await tool.execute({ op: 'list', project: 'feat-tool' }, { agent })
    assert.ok(list.summary.includes('消息'), 'the written feature shows up in list')
  })

  await check('op=rename/merge and a missing project fail with actionable errors', async () => {
    const renamed = await tool.execute({ op: 'rename', project: 'feat-tool', from: '消息', to: '通知' }, { agent })
    assert.ok(renamed.summary.includes('通知'), renamed.summary)
    await assert.rejects(() => tool.execute({ op: 'list', project: 'ghost-project' }, { agent }), /无法定位|ghost-project/)
    await assert.rejects(() => tool.execute({ op: 'list' }, { agent }), /project/)
  })
}

console.log('\n[features: import hooks + port-canvas idempotency]')
{
  const { importProjectDual } = await importFrom('lib', 'duo.js')
  const workspace = await mkdtemp(path.join(tmpdir(), 'cf-features-import-'))
  rmLater(workspace)
  const sourceRoot = await makeProject()
  rmLater(sourceRoot)

  await check('duo import → features.json written next to workflow.json; summary counts', async () => {
    const result = await importProjectDual({ path: sourceRoot, cwd: workspace, existingNames: [] })
    const { buildFeatureIndex: build, summarize: sum, writeFeatureIndex: write } = await importFrom('lib', 'features.js')
    const index = await build({ root: result.modulesGraph.meta.importedFrom, graph: result.modulesGraph })
    const projectDir = path.join(workspace, 'CodeFlow', 'flow-projects', result.name)
    await write(projectDir, index)
    const line = sum(index)
    assert.ok(/识别 \d+ 个功能 \/ \d+ 个模块/.test(line), line)
    const persisted = JSON.parse(await readFile(path.join(projectDir, FEATURES_FILE), 'utf8'))
    assert.ok(persisted.features.length >= 3)
  })

  await check('port-canvas is idempotent: two runs produce byte-identical canvas.html', () => {
    const canvas = path.join(ROOT, 'assets', 'canvas', 'canvas.html')
    const generate = () => execFileSync(process.execPath, [path.join(ROOT, 'tools', 'port-canvas.mjs')], { stdio: 'pipe' })
    const hashOf = () => createHash('sha256').update(readFileSync(canvas)).digest('hex')
    generate()
    const first = hashOf()
    generate()
    const second = hashOf()
    assert.equal(second, first, 'second generation must be byte-identical')
    generate()
    const third = hashOf()
    assert.equal(third, first, 'third generation must be byte-identical too')
  })
}

console.log('\n[summary]')
for (const fn of cleanup.splice(0)) await fn()
if (failures.length > 0) {
  console.log(`${failures.length} of ${checks} checks failed`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`all ${checks} checks passed`)
