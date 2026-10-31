/**
 * Live end-to-end smoke for dsh-codeflow-canvas — the field report's method:
 * a real http server + real fetch, so keep-alive/socket behaviour, status
 * codes and concurrent-write snapshots are exercised the way a browser sees
 * them. Complements tests/validate.mjs (fake req/res) and tests/regression.mjs.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const { createRouter } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'routes.js')).href)
const { createStore } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'store.js')).href)

const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-e2e-'))
const store = createStore(console)
const handler = createRouter({
  store,
  logger: console,
  resolveCwd: async () => workspace,
  submit: async (g) => ({ sessionId: 'sess-e2e', gesture: g }),
  ensureSession: async () => ({ sessionId: 'sess-e2e', created: false }),
})
const server = createServer((req, res) => handler(req, res).catch(() => {
  res.writeHead(500, { 'content-type': 'application/json' })
  res.end('{"ok":false}')
}))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let passed = 0
const ok = (name) => { passed += 1; console.log('  ok ', name) }

const graph = (name, nodes = 1) => ({
  format: 'codeflow/1', rev: 0,
  project: { name, language: 'python', origin: 'new' },
  nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i + 1}`, type: 'requirement', title: `节点${i + 1}`, pos: [i * 300, 0], params: {}, status: 'pending', result: '', detail: '' })),
  links: [], meta: {},
})
const post = async (url, body) => (await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const get = async (url) => (await fetch(base + url))

/* 1. boot page */
{
  const r = await get('/codeflow/canvas?boot=1')
  const text = await r.text()
  assert.equal(r.status, 200)
  assert.ok(text.startsWith('<!doctype html>') && text.includes('CodeFlow 画布'))
  ok('GET /codeflow/canvas?boot=1 → 200 HTML')
}

/* 2. autosave round-trip with persisted flag */
let rev = 0
{
  const r = await post('/codeflow/api/state', { graph: graph('e2e-a'), view: [1, 2, 1] })
  const j = await r.json()
  assert.equal(r.status, 200); assert.equal(j.ok, true); assert.equal(j.persisted, true)
  rev = j.rev
  const file = path.join(workspace, 'flow-projects', 'e2e-a', 'workflow.json')
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.rev, rev)
  const g = await (await get('/codeflow/api/state?project=e2e-a')).json()
  assert.deepEqual(g.viewport, [1, 2, 1], 'viewport is remembered (view names the view now)')
  assert.equal(g.view, 'tasks', 'default view is the task pipeline')
  ok(`POST /api/state → 200 persisted:true (rev ${rev}), file on disk, viewport kept`)
}

/* 3. invalid graph → 400 (was 500) */
{
  const r = await post('/codeflow/api/state', { graph: 5 })
  assert.equal(r.status, 400)
  ok('POST /api/state {"graph":5} → 400 (B7)')
}

/* 4. oversized body → 413 (was 500) */
{
  const big = { graph: graph('big', 1) }
  big.graph.nodes[0].params = { pad: 'x'.repeat(5 * 1024 * 1024) }
  const r = await post('/codeflow/api/state', big)
  assert.equal(r.status, 413)
  ok('POST /api/state 5MB body → 413 (B6)')
}

/* 5. stale expectedRev → 409 + currentRev (B5) */
{
  const r1 = await post('/codeflow/api/state', { graph: graph('e2e-conflict'), expectedRev: 0 })
  const j1 = await r1.json(); assert.equal(r1.status, 200)
  const r2 = await post('/codeflow/api/state', { graph: graph('e2e-conflict'), expectedRev: 0 })
  assert.equal(r2.status, 409)
  const j2 = await r2.json(); assert.equal(j2.currentRev, j1.rev)
  const r3 = await post('/codeflow/api/state', { graph: graph('e2e-conflict'), expectedRev: j1.rev })
  assert.equal(r3.status, 200)
  ok(`stale expectedRev → 409 currentRev:${j2.currentRev}, fresh → 200 (B5)`)
}

/* 6. 10 concurrent autosaves: contiguous revs, final file = newest, atomic (field report D) */
{
  const responses = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    post('/codeflow/api/state', { graph: graph('e2e-conc'), expectedRev: i })))
  const statuses = responses.map((r) => r.status)
  // Serialized client semantics: exactly the writer holding the right base wins.
  const revs = []
  for (const r of responses) if (r.status === 200) revs.push((await r.json()).rev)
  assert.equal(statuses.filter((s) => s === 409).length + revs.length, 10)
  assert.deepEqual(revs.sort((a, b) => a - b), Array.from({ length: revs.length }, (_, i) => i + 1), 'revs contiguous from 1')
  const file = path.join(workspace, 'flow-projects', 'e2e-conc', 'workflow.json')
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.rev, Math.max(...revs), 'file holds the newest rev (no rename race)')
  const entries = await readdir(path.join(workspace, 'flow-projects', 'e2e-conc'))
  assert.equal(entries.filter((n) => n.includes('.tmp')).length, 0, 'no .tmp leftovers')
  ok(`10 concurrent autosaves → revs ${revs.join(',')} | file rev ${onDisk.rev} | no tmp litter`)
}

/* 7. 30 concurrent save-now (field report D) */
{
  const responses = await Promise.all(Array.from({ length: 30 }, () =>
    post('/codeflow/api/save', { graph: graph('e2e-save') })))
  const bodies = await Promise.all(responses.map((r) => r.json()))
  assert.ok(responses.every((r) => r.status === 200))
  assert.ok(bodies.every((b) => b.ok === true && b.persisted === true))
  const file = path.join(workspace, 'flow-projects', 'e2e-save', 'workflow.json')
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.rev, Math.max(...bodies.map((b) => b.rev)))
  ok('30 concurrent /api/save → 30/30 persisted:true, file parses at newest rev')
}

/* 8. 2000-node autosave (field report D) */
{
  const started = Date.now()
  const r = await post('/codeflow/api/state', { graph: graph('e2e-big', 2000) })
  const ms = Date.now() - started
  const j = await r.json()
  assert.equal(r.status, 200); assert.equal(j.persisted, true)
  const file = path.join(workspace, 'flow-projects', 'e2e-big', 'workflow.json')
  const size = (await readFile(file, 'utf8')).length
  assert.ok(size > 100000)
  ok(`2000-node autosave → ${ms}ms, file ${(size / 1024).toFixed(0)}KB persisted`)
}

/* 9. corrupt file: boot degrades, quarantines, and a later save does not destroy it (B4) */
{
  const dir = path.join(workspace, 'flow-projects', 'e2e-corrupt')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'workflow.json'), '{"format":"codefl', 'utf8')
  const page = await get('/codeflow/canvas?boot=1&project=e2e-corrupt')
  const html = await page.text()
  const boot = JSON.parse(/window\.__CF_BOOT__=([\s\S]*?);<\/script>/.exec(html)[1])
  assert.notEqual(boot.degraded, null, 'boot payload carries degraded')
  const state = await (await get('/codeflow/api/state?project=e2e-corrupt')).json()
  assert.notEqual(state.degraded, null)
  const save = await post('/codeflow/api/save', { graph: graph('e2e-corrupt') })
  const sj = await save.json()
  assert.equal(save.status, 200); assert.equal(sj.persisted, true)
  const entries = await readdir(dir)
  const bad = entries.filter((n) => n.startsWith('workflow.json.bad-'))
  assert.equal(bad.length, 1, 'original bytes quarantined')
  assert.equal(await readFile(path.join(dir, bad[0]), 'utf8'), '{"format":"codefl')
  const restored = JSON.parse(await readFile(path.join(dir, 'workflow.json'), 'utf8'))
  assert.equal(restored.format, 'codeflow/1')
  ok(`corrupt file → degraded on boot & state, quarantined as ${bad[0].slice(13, 40)}…, save then succeeds (B4)`)
}

/* 10. /api/save failure → 507 (B3) */
{
  const dir = path.join(workspace, 'flow-projects', 'e2e-507')
  await mkdir(path.join(dir), { recursive: true })
  const r1 = await post('/codeflow/api/save', { graph: graph('e2e-507') })
  assert.equal(r1.status, 200)
  const file = path.join(dir, 'workflow.json')
  await rm(file); await mkdir(file) // same EISDIR trick, portable
  const r2 = await post('/codeflow/api/save', { graph: graph('e2e-507') })
  assert.equal(r2.status, 507)
  const j2 = await r2.json()
  assert.equal(j2.ok, false); assert.equal(j2.persisted, false)
  await rm(file, { recursive: true, force: true })
  ok('/api/save with unusable target → 507 ok:false persisted:false (B3)')
}

/* 11. untitled bucket unity (B9) */
{
  const r1 = await post('/codeflow/api/state', { graph: { ...graph('..'), project: { name: '..' } } })
  const j1 = await r1.json()
  assert.equal(r1.status, 200)
  assert.equal(j1.project, '__untitled__')
  assert.equal(j1.persisted, true)
  const bucket = JSON.parse(await readFile(path.join(workspace, 'flow-projects', 'untitled', 'workflow.json'), 'utf8'))
  assert.equal(bucket.rev, j1.rev, 'the bucket persists at flow-projects/untitled/')
  const g2 = await (await get('/codeflow/api/state?project=untitled')).json()
  assert.equal(g2.project, '__untitled__', 'literal "untitled" reads the same bucket')
  assert.equal(g2.rev, j1.rev)
  ok(`".."/"  "/"untitled" all resolve to the __untitled__ bucket at flow-projects/untitled/ (B9)`)
}

/* ---- v0.6.0: dual import, independent views, switch & persistence ---- */

/** A small source tree the dual import scans. */
const dualSrc = path.join(workspace, 'dual-src')
/** A fresh store + server on the same workspace: a process "restart". */
const restart = async () => {
  const freshStore = createStore(console)
  const freshHandler = createRouter({
    store: freshStore,
    logger: console,
    resolveCwd: async () => workspace,
    submit: async () => ({ sessionId: 'sess-restart' }),
    ensureSession: async () => ({ sessionId: 'sess-restart', created: false }),
  })
  const freshServer = createServer((req, res) => freshHandler(req, res).catch(() => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"ok":false}')
  }))
  await new Promise((resolve) => freshServer.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${freshServer.address().port}`,
    close: () => new Promise((resolve) => freshServer.close(resolve)),
  }
}
{
  await mkdir(path.join(dualSrc, 'src'), { recursive: true })
  await writeFile(path.join(dualSrc, 'src', 'main.py'), '"""入口。"""\n# TODO: 补参数\n', 'utf8')
  await writeFile(path.join(dualSrc, 'src', 'util.py'), 'def helper(x):\n    return x\n', 'utf8')
}

/* 12. one import produces both graphs, both files, one project name */
let dualProject = null
{
  const r = await post('/codeflow/api/import', { path: dualSrc })
  const j = await r.json()
  assert.equal(r.status, 200); assert.equal(j.ok, true)
  dualProject = j.project
  assert.ok(j.modulesAvailable === true, `module graph must be generated: ${j.warning ?? ''}`)
  assert.ok(j.summary.includes('任务流水线') && j.summary.includes('模块结构图'), j.summary)
  const dir = path.join(workspace, 'flow-projects', dualProject)
  const tasksDisk = JSON.parse(await readFile(path.join(dir, 'workflow.json'), 'utf8'))
  const modulesDisk = JSON.parse(await readFile(path.join(dir, 'workflow.modules.json'), 'utf8'))
  assert.equal(tasksDisk.project.name, modulesDisk.project.name, 'one project name for both views')
  assert.equal(tasksDisk.meta.importedFrom, modulesDisk.meta.importedFrom)
  assert.equal(tasksDisk.meta.strategy, 'tasks')
  assert.equal(modulesDisk.meta.strategy, 'modules')
  assert.ok(!tasksDisk.nodes.some((n) => n.type === 'module'), 'task graph has no module nodes')
  assert.ok(modulesDisk.nodes.some((n) => n.type === 'module'), 'module graph has module nodes')
  assert.ok(!modulesDisk.nodes.some((n) => ['edit', 'testgen', 'deliver'].includes(n.type)), 'module graph has no task chain')
  // A legacy `strategy` field from an old client must not change the outcome.
  const r2 = await post('/codeflow/api/import', { path: dualSrc, strategy: 'modules' })
  const j2 = await r2.json()
  assert.equal(r2.status, 200)
  assert.equal(j2.project, `${dualProject}-flow`, 'second import gets a fresh name')
  assert.equal(j2.modulesAvailable, true, 'strategy is ignored: still dual')
  ok(`dual import → workflow.json + workflow.modules.json, one name, strategy ignored (${dualProject})`)
}

/* 13. independent revs: writing one view never moves the other */
{
  const s1 = await (await get(`/codeflow/api/state?project=${dualProject}&view=tasks`)).json()
  const s2 = await (await get(`/codeflow/api/state?project=${dualProject}&view=modules`)).json()
  assert.equal(s1.view, 'tasks'); assert.equal(s2.view, 'modules')
  assert.ok(s1.rev > 0 && s2.rev > 0)
  const tasksRev = s1.rev
  const modulesRev = s2.rev
  // autosave the modules view (with its own viewport)
  const w = await post('/codeflow/api/state', { project: dualProject, graph: s2.graph, view: 'modules', viewport: [5, 6, 0.9], expectedRev: modulesRev })
  assert.equal(w.status, 200)
  const wj = await w.json()
  assert.equal(wj.view, 'modules')
  const after = await (await get(`/codeflow/api/state?project=${dualProject}&view=tasks`)).json()
  assert.equal(after.rev, tasksRev, 'the tasks rev is untouched by a modules write')
  // stale expectedRev per view → 409 with that view's rev
  const stale = await post('/codeflow/api/state', { project: dualProject, graph: s2.graph, view: 'modules', expectedRev: 0 })
  assert.equal(stale.status, 409)
  const sj = await stale.json()
  assert.equal(sj.currentRev, modulesRev + 1)
  assert.equal(sj.view, 'modules')
  ok(`independent revs (tasks ${tasksRev} vs modules ${modulesRev + 1}); per-view 409 carries the view`)
}

/* 14. switch the active view; a real restart restores it */
{
  const sw = await post('/codeflow/api/view', { project: dualProject, view: 'modules' })
  assert.equal(sw.status, 200)
  const sj = await sw.json()
  assert.equal(sj.activeView, 'modules')
  // Dispose semantics: the flush hook is what persists viewport state too.
  await store.flushAll()
  // A brand-new store (process restart) must come back on the persisted view.
  const fresh = await restart()
  const freshGet = async (url) => fetch(`${fresh.base}${url}`)
  const freshPost = async (url, body) => fetch(`${fresh.base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const page = await freshGet(`/codeflow/canvas?boot=1&project=${dualProject}`)
    const html = await page.text()
    const boot = JSON.parse(/window\.__CF_BOOT__=([\s\S]*?);<\/script>/.exec(html)[1])
    assert.equal(boot.activeView, 'modules', 'the reboot lands on the persisted active view')
    assert.equal(boot.views.tasks.available, true)
    assert.equal(boot.views.modules.available, true)
    assert.equal(boot.graph.meta.strategy, 'modules', 'boot serves the active view’s graph')
    assert.deepEqual(boot.viewport, [5, 6, 0.9], 'boot carries the active view’s persisted viewport')
    // and switching back works
    const back = await freshPost('/codeflow/api/view', { project: dualProject, view: 'tasks' })
    assert.equal((await back.json()).activeView, 'tasks')
  } finally {
    await fresh.close()
  }
  ok(`POST /api/view switches + view.json persists; a cold restart restores the active view`)
}

/* 15. legacy single-module project: workflow.json IS the modules view */
{
  const dir = path.join(workspace, 'flow-projects', 'e2e-legacy-mod')
  await mkdir(dir, { recursive: true })
  const legacy = { format: 'codeflow/1', rev: 3, project: { name: 'e2e-legacy-mod', origin: 'import' }, nodes: [{ id: 'n1', type: 'module', title: 'm', params: { path: '/x/y.py', symbol: '' }, status: 'pending' }], links: [], meta: { importedFrom: dualSrc, strategy: 'modules' } }
  await writeFile(path.join(dir, 'workflow.json'), JSON.stringify(legacy), 'utf8')
  const fresh = await restart()
  try {
    const page = await fetch(`${fresh.base}/codeflow/canvas?boot=1&project=e2e-legacy-mod`)
    const boot = JSON.parse(/window\.__CF_BOOT__=([\s\S]*?);<\/script>/.exec(await page.text())[1])
    assert.equal(boot.activeView, 'modules', 'a legacy modules project activates the modules view')
    assert.equal(boot.views.modules.available, true)
    assert.equal(boot.views.tasks.available, false, 'no fabricated task view')
    assert.equal(boot.views.modules.reason, undefined)
    assert.equal(boot.views.tasks.reason.length > 0, true, 'the missing view explains itself')
    // writing to the modules view maps to workflow.json (no rename, no copy)
    const w = await fetch(`${fresh.base}/codeflow/api/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'e2e-legacy-mod', graph: legacy, view: 'modules', expectedRev: 3 }) })
    assert.equal(w.status, 200)
    const onDisk = JSON.parse(await readFile(path.join(dir, 'workflow.json'), 'utf8'))
    assert.equal(onDisk.rev, 4, 'the legacy file is still the modules view’s durable copy')
    const hasModulesFile = await readFile(path.join(dir, 'workflow.modules.json'), 'utf8').then(() => true, () => false)
    assert.equal(hasModulesFile, false, 'no file copied')
    // writing to the tasks view of a legacy project is refused
    const bad = await fetch(`${fresh.base}/codeflow/api/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'e2e-legacy-mod', graph: { ...graph('e2e-legacy-mod') }, view: 'tasks' }) })
    assert.equal(bad.status, 409)
  } finally {
    await fresh.close()
  }
  ok('legacy modules project: activeView=modules, tasks hidden, workflow.json keeps serving modules')
}

/* 16. corrupt modules file is isolated; the tasks view keeps working */
{
  const dir = path.join(workspace, 'flow-projects', dualProject)
  await writeFile(path.join(dir, 'workflow.modules.json'), '{"broken"', 'utf8')
  const fresh = await restart()
  try {
    const state = await (await fetch(`${fresh.base}/codeflow/api/state?project=${dualProject}&view=modules`)).json()
    assert.notEqual(state.degraded, null, 'modules view reports degraded')
    const tasks = await (await fetch(`${fresh.base}/codeflow/api/state?project=${dualProject}&view=tasks`)).json()
    assert.equal(tasks.degraded, null, 'the tasks view is unaffected')
    assert.ok(tasks.rev > 0)
    const entries = await readdir(dir)
    const bad = entries.filter((n) => n.startsWith('workflow.modules.json.bad-'))
    assert.equal(bad.length, 1, 'the damaged modules file is quarantined')
  } finally {
    await fresh.close()
  }
  ok('corrupt workflow.modules.json quarantined on a cold load; tasks view untouched')
}

await new Promise((resolve) => server.close(resolve))
await rm(workspace, { recursive: true, force: true })
console.log(`\nsmoke: ${passed} scenarios passed`)
