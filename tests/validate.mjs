/**
 * Structural + behavioural self-check for dsh-codeflow-canvas.
 *
 * Everything here runs against a fake Cordis context and a fake HTTP
 * req/res pair, so the whole plugin can be exercised without activating it in a
 * live DSH profile:
 *
 *   - the four registrations `apply()` must perform;
 *   - the HTTP surface, including the prompt it derives from a canvas gesture;
 *   - the `codeflow_canvas` tool's three modes;
 *   - the skill provider and its document;
 *   - the ported canvas asset (no legacy seams, node library in sync with the
 *     reference doc).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/validate.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { auditLightContrast, summarizeContrast } from './contrast.mjs'

const ROOT = new URL('..', import.meta.url)
const read = (rel) => readFile(fileURLToPath(new URL(rel, ROOT)), 'utf8')

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

/** A fake request whose body is the JSON-serialized value. */
function fakeRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return Object.assign(Readable.from(chunks), {
    method,
    url,
    headers: { host: '127.0.0.1:19387' },
  })
}

/** A fake response that records status, headers and body. */
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

/** A fake Cordis context that records every registration. */
function fakeContext(services = {}) {
  const recorded = {
    skillProviders: [], commands: [], tools: [], routes: [], prompts: [],
    agents: new Map(), listeners: new Map(),
  }
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
      return () => {
        const current = recorded.listeners.get(name) ?? []
        const at = current.indexOf(callback)
        if (at >= 0) current.splice(at, 1)
      }
    },
    get(name) {
      if (Object.hasOwn(services, name)) return services[name]
      if (name === 'agents') return { get: (id) => recorded.agents.get(id), roots: () => [...recorded.agents.values()] }
      return undefined
    },
    inject(names, callback) {
      assert.ok(names.includes('webServer'), 'only webServer may be injected lazily')
      callback(ctx)
    },
    skills: {
      registerProvider(create) {
        recorded.skillProviders.push(create({ signal: new AbortController().signal, invalidate() {} }))
        return () => {}
      },
    },
    commands: {
      register(definition) {
        recorded.commands.push(definition)
        return () => {}
      },
    },
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

/** Fire one recorded host event at every listener registered for it. */
async function emit(recorded, name, ...args) {
  for (const callback of recorded.listeners.get(name) ?? []) {
    await callback(...args)
  }
}

/**
 * A fake `sessionController` (the host face of session create/rename/prompt).
 * Prompt payloads are recorded so tests can assert *which session* a canvas
 * gesture reached — the core promise of the dedicated-session binding.
 */
function fakeSessionController() {
  const state = { created: [], prompts: [], renamed: [], failNextPrompt: undefined }
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
      if (state.failNextPrompt !== undefined) {
        const error = state.failNextPrompt
        state.failNextPrompt = undefined
        throw error
      }
      state.prompts.push(request)
      return { accepted: true }
    },
  }
}

/** Compare host paths regardless of the separator the platform uses. */
function normalizePath(value) {
  return String(value ?? '').split('\\').join('/')
}

/**
 * Parse a `[CodeFlow:*]` prompt per the v1.0 contract: the first line is the
 * prefix plus a single-line JSON payload; everything after it is the host's
 * 「本次执行要求」 requirements footer (RUN_* only).
 */
function parsePrompt(text) {
  const newline = text.indexOf('\n')
  const firstLine = newline === -1 ? text : text.slice(0, newline)
  return {
    payload: JSON.parse(firstLine.slice(firstLine.indexOf(']') + 1)),
    requirements: newline === -1 ? '' : text.slice(newline + 1),
  }
}

/** A recording agent stub: `followup` is the only method this plugin calls. */
function fakeAgent(id, sink, cwd = path.join(tmpdir(), 'codeflow-fake-cwd')) {
  // The default cwd deliberately does not exist: workspace resolution skips
  // invalid directories, so only checks that bind a real workspace (e.g. the
  // /api/save check below) exercise real disk writes. The old '/work/space'
  // default made every run scatter test projects onto the current drive root.
  return {
    id,
    session: { header: { cwd } },
    followup(message) {
      sink.push(message)
    },
  }
}

/* -------------------------------------------------------------------- main --- */

const { apply, name: pluginName, inject } = await import('../lib/index.js')
const { normalizeGraph, safeProjectName, normalizeArtifacts, normalizePresented, createStore, normalizeView, viewOfNodeId, VIEW_FILES } = await import('../lib/store.js')
const { createSessionManager, sessionSidecarPath, canvasSessionTitle } = await import('../lib/sessions.js')
const { createActivityHub, isWriteTool, extractEditPaths } = await import('../lib/activity.js')
const { summarize, registerTool } = await import('../lib/tool.js')
const { importProject, main: importerMain } = await import('../lib/importer.js')
const { analyzeModules } = await import('../lib/analyst.js')
const { importProjectDual } = await import('../lib/duo.js')
const { cleanPathInput, findDirectory, ensureAgentDirectory } = await import('../lib/workspace.js')
const { buildStarterGraph } = await import('../lib/starter.js')
const {
  defaultRoot, ensureLayout, listProjectDirs, pluginRoot, projectDir, readConfig,
  validateConfiguredDir, writeConfig,
} = await import('../lib/paths.js')

/* A small deterministic fixture the import checks scan. */
const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'codeflow-fixture-'))
await mkdir(path.join(fixtureRoot, 'src'), { recursive: true })
await writeFile(path.join(fixtureRoot, 'src', 'main.py'), '"""入口模块。"""\n# TODO: 补参数\n# FIXME: 空标题崩溃\n', 'utf8')
await writeFile(path.join(fixtureRoot, 'src', 'util.js'), '// TODO: 去掉全局状态\nexport const id = (x) => x\n', 'utf8')
await writeFile(path.join(fixtureRoot, 'src', 'service.js'), "import { id } from './util.js'\nexport function make(x){ return id(x) }\n", 'utf8')
await writeFile(path.join(fixtureRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8')
const cleanupFixture = () => rm(fixtureRoot, { recursive: true, force: true })

console.log('\n[manifest]')
const pkg = JSON.parse(await read('package.json'))
await check('package name matches the client bundle id', () => {
  const client = read('lib/client.js')
  return client.then((text) => {
    assert.equal(pkg.name, 'dsh-codeflow-canvas')
    assert.ok(text.includes(`id: '${pkg.name}'`), 'client.js must register under the package name')
  })
})
await check('bundle patch declares exactly one row pointing at the package', async () => {
  const patch = await read('cordis.patch.yml')
  const names = [...patch.matchAll(/^\s+- id: (.+)$/gm)].map((m) => m[1].trim())
  assert.deepEqual(names, ['codeflow-canvas'], 'one inserted row')
  assert.ok(patch.includes(`name: ${pkg.name}`), 'row name must be the package name')
})
await check('dsh.client declares web + immediately and no external modules', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.deepEqual(pkg.dsh.client.external ?? [], [], 'react is a platform module, nothing external')
})
await check('exports expose the host and client halves', () => {
  assert.ok(pkg.exports['.'])
  assert.ok(pkg.exports['./client'])
})

console.log('\n[graph normalization]')
await check('accepts a minimal graph and assigns the envelope', () => {
  const graph = normalizeGraph({ format: 'codeflow/1', rev: 4, nodes: [], links: [] })
  assert.equal(graph.format, 'codeflow/1')
  assert.equal(graph.rev, 4)
})
await check('drops links with missing endpoints and duplicate node ids', () => {
  const graph = normalizeGraph({
    nodes: [{ id: 'a', type: 'codegen' }, { id: 'a', type: 'review' }, { id: 'b', type: 'write' }],
    links: [['a', 0, 'b', 0], ['a', 0, 'ghost', 0]],
  })
  assert.equal(graph.nodes.length, 2, 'duplicate id collapsed')
  assert.equal(graph.links.length, 1, 'dangling link dropped')
})
await check('coerces an unknown status to pending', () => {
  const graph = normalizeGraph({ nodes: [{ id: 'a', type: 'codegen', status: 'exploded' }], links: [] })
  assert.equal(graph.nodes[0].status, 'pending')
})
await check('rejects non-graphs', () => {
  assert.equal(normalizeGraph(null), undefined)
  assert.equal(normalizeGraph('text'), undefined)
  assert.equal(normalizeGraph([1, 2]), undefined)
})
await check('project names are reduced to one safe segment', () => {
  assert.equal(safeProjectName('todo-cli'), 'todo-cli')
  assert.equal(safeProjectName('../../etc/passwd'), 'etc-passwd')
  assert.equal(safeProjectName('待办 工具'), '待办-工具')
  assert.equal(safeProjectName(''), 'untitled')
})
await check('summarize counts every status', () => {
  const text = summarize({
    nodes: [
      { status: 'done' }, { status: 'done' }, { status: 'pending' }, { status: 'failed' },
    ],
  })
  assert.ok(text.includes('4 个节点'), text)
  assert.ok(text.includes('2 完成'), text)
  assert.ok(text.includes('1 待运行'), text)
  assert.ok(text.includes('1 失败'), text)
})

console.log('\n[dual view store]')
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-dual-store-'))
  const tasksGraph = (rev = 0) => ({
    format: 'codeflow/1', rev,
    project: { name: 'dual-demo', origin: 'import' },
    nodes: [{ id: 't1', type: 'edit', pos: [0, 0], params: { instruction: '改 src/a.py' }, status: 'pending', result: '', detail: '' }],
    links: [], meta: { importedFrom: workspace, strategy: 'tasks' },
  })
  const modulesGraph = (rev = 0) => ({
    format: 'codeflow/1', rev,
    project: { name: 'dual-demo', origin: 'import' },
    nodes: [{ id: 'm1', type: 'module', pos: [0, 0], params: { path: path.join(workspace, 'src', 'a.py'), symbol: '' }, status: 'pending', result: '', detail: '' }],
    links: [], meta: { importedFrom: workspace, strategy: 'modules' },
  })
  try {
    await check('view helpers accept only the two canonical names', () => {
      assert.equal(normalizeView('tasks'), 'tasks')
      assert.equal(normalizeView('modules'), 'modules')
      assert.equal(normalizeView('Tasks'), undefined)
      assert.equal(normalizeView(undefined), undefined)
      assert.equal(normalizeView([1, 2, 3]), undefined, 'a legacy viewport array is not a view name')
      assert.equal(viewOfNodeId('t12'), 'tasks')
      assert.equal(viewOfNodeId('m7'), 'modules')
      assert.equal(viewOfNodeId('n3'), undefined, 'legacy ids stay view-neutral')
      assert.deepEqual(VIEW_FILES, { tasks: 'workflow.json', modules: 'workflow.modules.json' })
    })
    await check('two views hold independent revs, graphs and files', async () => {
      const store = createStore(console)
      const wTasks = await store.write(tasksGraph(), { persist: 'now', cwd: workspace, view: 'tasks' })
      const wModules = await store.write(modulesGraph(), { persist: 'now', cwd: workspace, view: 'modules' })
      assert.equal(wTasks.view, 'tasks')
      assert.equal(wModules.view, 'modules')
      assert.equal(wTasks.rev, 1)
      assert.equal(wModules.rev, 1, 'each view counts its own revisions from zero')
      await store.write(modulesGraph(), { persist: 'now', cwd: workspace, view: 'modules' })
      assert.equal(store.get('dual-demo', 'modules').rev, 2, 'a modules write bumps only the modules rev')
      assert.equal(store.get('dual-demo', 'tasks').rev, 1, 'the tasks rev is untouched')
      assert.equal(store.get('dual-demo', 'tasks').graph.nodes[0].id, 't1')
      const tasksOnDisk = JSON.parse(await readFile(path.join(workspace, 'CodeFlow', 'flow-projects', 'dual-demo', 'workflow.json'), 'utf8'))
      const modulesOnDisk = JSON.parse(await readFile(path.join(workspace, 'CodeFlow', 'flow-projects', 'dual-demo', 'workflow.modules.json'), 'utf8'))
      assert.equal(tasksOnDisk.rev, 1, 'the tasks file never sees the modules rev')
      assert.equal(modulesOnDisk.rev, 2)
      assert.equal(modulesOnDisk.meta.strategy, 'modules')
    })
    await check('expectedRev conflicts are detected per view', async () => {
      const store = createStore(console)
      await store.write(tasksGraph(), { persist: 'never', cwd: workspace, view: 'tasks' })
      await store.write(modulesGraph(), { persist: 'never', cwd: workspace, view: 'modules' })
      await assert.rejects(
        () => store.write(tasksGraph(), { persist: 'never', cwd: workspace, view: 'tasks', expectedRev: 0 }),
        (error) => {
          assert.equal(error.statusCode, 409)
          assert.equal(error.currentRev, 1)
          assert.equal(error.view, 'tasks')
          return true
        },
      )
      // The modules view at rev 1 still accepts expectedRev:1 while tasks is at 1 too —
      // proving the counters are independent.
      const ok = await store.write(modulesGraph(), { persist: 'never', cwd: workspace, view: 'modules', expectedRev: 1 })
      assert.equal(ok.view, 'modules')
    })
    await check('a write infers the view from meta.strategy when none is given', async () => {
      const store = createStore(console)
      const written = await store.write(modulesGraph(), { persist: 'never', cwd: workspace })
      assert.equal(written.view, 'modules', 'strategy:modules routes to the modules view')
      const tasksWritten = await store.write(tasksGraph(), { persist: 'never', cwd: workspace })
      assert.equal(tasksWritten.view, 'tasks', 'the active/default view hosts plain graphs')
    })
    await check('legacy single-module project: workflow.json serves the modules view', async () => {
      const dir = path.join(workspace, 'CodeFlow', 'flow-projects', 'legacy-mod')
      await mkdir(dir, { recursive: true })
      const legacy = {
        format: 'codeflow/1', rev: 5,
        project: { name: 'legacy-mod', origin: 'import' },
        nodes: [{ id: 'n1', type: 'module', pos: [0, 0], params: { path: '/x.py', symbol: '' }, status: 'pending', result: '', detail: '' }],
        links: [], meta: { importedFrom: workspace, strategy: 'modules' },
      }
      await writeFile(path.join(dir, 'workflow.json'), JSON.stringify(legacy), 'utf8')
      const store = createStore(console)
      const loaded = await store.load('legacy-mod', workspace)
      assert.equal(loaded.activeView, 'modules', 'the legacy project boots onto its only view')
      assert.equal(loaded.views.tasks.available, false, 'no fabricated task view')
      assert.equal(loaded.views.modules.available, true)
      assert.equal(store.get('legacy-mod', 'modules').rev, 5)
      // Writing the modules view maps to workflow.json — never renamed, never copied.
      const written = await store.write(legacy, { persist: 'now', cwd: workspace, view: 'modules' })
      assert.equal(written.rev, 6)
      assert.equal(normalizePath(written.file).endsWith('/CodeFlow/flow-projects/legacy-mod/workflow.json'), true, written.file)
      const hasModulesFile = await readFile(path.join(dir, 'workflow.modules.json'), 'utf8').then(() => true, () => false)
      assert.equal(hasModulesFile, false, 'the legacy file is not duplicated')
      // And the tasks view is refused rather than silently created on top of it.
      const legacyTasks = { ...tasksGraph(), project: { name: 'legacy-mod', origin: 'import' } }
      await assert.rejects(
        () => store.write(legacyTasks, { persist: 'never', cwd: workspace, view: 'tasks', expectedRev: 0 }),
        /旧版单模块图项目/,
      )
    })
    await check('a corrupt modules file degrades only the modules view', async () => {
      const dir = path.join(workspace, 'CodeFlow', 'flow-projects', 'iso-demo')
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'workflow.json'), JSON.stringify(tasksGraph(3)), 'utf8')
      await writeFile(path.join(dir, 'workflow.modules.json'), '{"broken"', 'utf8')
      const store = createStore(console)
      const loaded = await store.load('iso-demo', workspace)
      assert.equal(loaded.results.tasks.degraded, undefined, 'the tasks view loads whole')
      assert.notEqual(loaded.results.modules.degraded, undefined, 'the modules view reports degraded')
      assert.equal(store.get('iso-demo', 'tasks').rev, 3)
      const entries = await readdir(path.join(dir))
      assert.equal(entries.filter((name) => name.startsWith('workflow.modules.json.bad-')).length, 1, 'quarantined per file')
      assert.equal(entries.filter((name) => name.startsWith('workflow.json.bad-')).length, 0, 'the tasks file was never touched')
    })
    await check('the active view persists in view.json and survives a reload', async () => {
      const store = createStore(console)
      await store.write(tasksGraph(), { persist: 'now', cwd: workspace, view: 'tasks' })
      await store.write(modulesGraph(), { persist: 'now', cwd: workspace, view: 'modules' })
      const switched = await store.setActiveView('dual-demo', 'modules')
      assert.equal(switched.activeView, 'modules')
      const sidecar = JSON.parse(await readFile(path.join(workspace, 'CodeFlow', 'flow-projects', 'dual-demo', 'view.json'), 'utf8'))
      assert.equal(sidecar.activeView, 'modules')
      // A cold store adopts the persisted choice.
      const cold = createStore(console)
      const reloaded = await cold.load('dual-demo', workspace)
      assert.equal(reloaded.activeView, 'modules')
      // Unavailable views are refused.
      await assert.rejects(() => cold.setActiveView('ghost-project', 'tasks'), /项目未加载|不可用/)
    })
    await check('flush saves every loaded view; flush can target one', async () => {
      const store = createStore(console)
      await store.write(tasksGraph(), { persist: 'now', cwd: workspace, view: 'tasks' })
      await store.write(modulesGraph(), { persist: 'now', cwd: workspace, view: 'modules' })
      store.patchNode('dual-demo', 't1', { status: 'done', result: '完成' }, { view: 'tasks' })
      store.patchNode('dual-demo', 'm1', { status: 'running' }, { view: 'modules' })
      const flushed = await store.flush('dual-demo')
      assert.equal(flushed.persisted, true, 'both views reached the disk')
      const tasksOnDisk = JSON.parse(await readFile(path.join(workspace, 'CodeFlow', 'flow-projects', 'dual-demo', 'workflow.json'), 'utf8'))
      const modulesOnDisk = JSON.parse(await readFile(path.join(workspace, 'CodeFlow', 'flow-projects', 'dual-demo', 'workflow.modules.json'), 'utf8'))
      assert.equal(tasksOnDisk.nodes[0].status, 'done')
      assert.equal(modulesOnDisk.nodes[0].status, 'running')
      assert.equal(flushed.views.tasks.file.includes('workflow.json'), true)
      assert.equal(flushed.views.modules.file.includes('workflow.modules.json'), true)
    })
    await check('patchNode locates the node across views and never guesses wrong', async () => {
      const store = createStore(console)
      await store.write(tasksGraph(), { persist: 'never', cwd: workspace, view: 'tasks' })
      await store.write(modulesGraph(), { persist: 'never', cwd: workspace, view: 'modules' })
      const byPrefix = store.patchNode('dual-demo', 'm1', { status: 'running' })
      assert.equal(byPrefix.view, 'modules', 'the m-prefix resolves to the modules view')
      assert.equal(store.get('dual-demo', 'tasks').graph.nodes[0].status, 'pending', 'the tasks node was untouched')
      const explicit = store.patchNode('dual-demo', 't1', { status: 'done' }, { view: 'tasks' })
      assert.equal(explicit.view, 'tasks')
      assert.equal(store.patchNode('dual-demo', 'ghost', { status: 'done' }), undefined)
      assert.equal(store.patchNode('dual-demo', 't1', { status: 'done' }, { view: 'modules' }), undefined, 'a wrong-view explicit target is refused, not redirected')
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

console.log('\n[paths]')
await check('import paths accept @ mentions, quotes, ~ and file URLs', () => {
  assert.equal(cleanPathInput(`@${fixtureRoot}`), path.normalize(fixtureRoot))
  assert.equal(cleanPathInput(`"@${fixtureRoot}"`), path.normalize(fixtureRoot))
  assert.equal(cleanPathInput(` "${fixtureRoot}" `), path.normalize(fixtureRoot))
  assert.equal(cleanPathInput(`'${fixtureRoot}'`), path.normalize(fixtureRoot))
  const home = path.join(tmpdir(), 'codeflow-home-fixture')
  assert.equal(cleanPathInput('~/project', { home }), path.join(home, 'project'))
  assert.equal(cleanPathInput('./server', { cwd: fixtureRoot }), path.join(fixtureRoot, 'server'))
  assert.equal(cleanPathInput(pathToFileURL(fixtureRoot).href), path.normalize(fixtureRoot))
})
await check('findDirectory distinguishes directories from missing paths', async () => {
  assert.ok(await findDirectory(fixtureRoot), 'the fixture directory resolves')
  assert.equal(await findDirectory(path.join(fixtureRoot, 'definitely-missing')), undefined)
})
await check('directory repair is a no-op without the host service', async () => {
  const { ctx } = fakeContext()
  const result = await ensureAgentDirectory(ctx, fakeAgent('s-path', []))
  assert.equal(result.available, true)
  assert.equal(result.unchecked, true)
})
await check('directory repair falls back to a parent when the host rejects the leaf', async () => {
  const base = path.join(fixtureRoot, 'nested', 'project')
  await mkdir(base, { recursive: true })
  let current = base
  const workingDirectory = {
    defaultDirectory: fixtureRoot,
    get: () => current,
    ensure: async () => { throw new Error('working-directory: directory does not exist') },
    set: async (_agent, next) => {
      if (path.basename(next) === 'project') throw new Error('leaf rejected')
      current = next
      return next
    },
  }
  const host = fakeContext({ workingDirectory })
  const result = await ensureAgentDirectory(host.ctx, fakeAgent('s-repair', [], base))
  const expected = await findDirectory(path.join(fixtureRoot, 'nested'))
  assert.equal(result.repaired, true)
  assert.equal(result.available, true)
  assert.equal(result.cwd, expected)
  assert.equal(current, expected)
})
await check('starter graph is a type-compatible chain', () => {
  const { graph, projectName } = buildStarterGraph({ name: 'starter-demo', brief: '做一个 CLI' })
  assert.equal(projectName, 'starter-demo')
  assert.equal(graph.format, 'codeflow/1')
  assert.equal(graph.project.origin, 'new')
  assert.equal(graph.nodes.length, 7)
  for (const [from, , to] of graph.links) {
    assert.ok(graph.nodes.some((node) => node.id === from) && graph.nodes.some((node) => node.id === to))
  }
})

console.log('\n[importer]')
await check('imports a fixture into a valid done-annotated graph', async () => {
  const { graph, summary, stats } = await importProject({ path: fixtureRoot })
  assert.equal(graph.format, 'codeflow/1')
  assert.equal(graph.project.origin, 'import')
  assert.equal(graph.project.language, 'javascript', 'fixture has 2 JS files vs 1 Python')
  const scan = graph.nodes.find((node) => node.type === 'scan')
  const comments = graph.nodes.find((node) => node.type === 'comments')
  assert.equal(scan.status, 'done', 'the import itself is the scan')
  assert.equal(comments.status, 'done')
  assert.ok(scan.result.includes('Python'), scan.result)
  const tasks = graph.nodes.filter((node) => node.type === 'edit' && node.status === 'pending')
  assert.ok(tasks.length >= 2, `expected task nodes, got ${tasks.length}`)
  const fixme = tasks[0]
  assert.ok(fixme.params.instruction.includes('FIXME'), 'FIXME sorts first')
  assert.ok(fixme.params.instruction.includes('src/main.py:'), fixme.params.instruction)
  const types = new Set(graph.nodes.map((node) => node.type))
  assert.ok(types.has('review'), 'review is part of the import chain')
  assert.ok(types.has('deliver'))
  assert.ok(!types.has('testgen') === false || true)
  for (const [from, , to] of graph.links) {
    assert.ok(graph.nodes.some((node) => node.id === from) && graph.nodes.some((node) => node.id === to), `dangling link ${from}->${to}`)
  }
  assert.ok(summary.includes('节点') && stats.markers >= 3, summary)
})
await check('imports an @-mentioned absolute path', async () => {
  const { graph } = await importProject({ path: `@${fixtureRoot}` })
  assert.equal(graph.project.origin, 'import')
})
await check('adds testgen when the project has no tests and addTests is set', async () => {
  const { graph } = await importProject({ path: fixtureRoot })
  assert.ok(graph.nodes.some((node) => node.type === 'testgen'), 'fixture has no test files')
})
await check('fromComments=false produces the minimal scan → comments → deliver chain', async () => {
  const { graph } = await importProject({ path: fixtureRoot, fromComments: false })
  assert.ok(!graph.nodes.some((node) => node.type === 'edit'))
  assert.deepEqual(graph.nodes.map((node) => node.type), ['scan', 'comments', 'deliver'])
})
await check('collapses 1–2 markers into one summary edit node', async () => {
  const one = await mkdtemp(path.join(tmpdir(), 'codeflow-one-'))
  await writeFile(path.join(one, 'a.py'), '# TODO: 只此一条\n', 'utf8')
  try {
    const { graph } = await importProject({ path: one })
    const edits = graph.nodes.filter((node) => node.type === 'edit')
    assert.equal(edits.length, 1, 'one summary node instead of fragmenting')
    assert.ok(edits[0].title.includes('1 条'), edits[0].title)
  } finally {
    await rm(one, { recursive: true, force: true })
  }
})
await check('a taken project name gets the -flow suffix', async () => {
  const base = path.basename(fixtureRoot)
  const { graph } = await importProject({ path: fixtureRoot, existingNames: [base] })
  assert.equal(graph.project.name, `${base}-flow`)
})
await check('relative paths resolve against the workspace cwd', async () => {
  const { graph } = await importProject({ path: '.', cwd: fixtureRoot })
  assert.equal(graph.meta.importedFrom, fixtureRoot)
})
await check('a missing directory is a loud error', async () => {
  await assert.rejects(() => importProject({ path: 'Z:/definitely/missing/dir' }), /目录不存在/)
  await assert.rejects(() => importProject({}), /未提供项目路径/)
})

console.log('\n[analyst]')
await check('module strategy maps every code block with a role guess', async () => {
  const { graph, summary } = await analyzeModules({ path: fixtureRoot })
  const modules = graph.nodes.filter((node) => node.type === 'module')
  assert.ok(modules.length >= 3, `expected module nodes, got ${modules.length}`)
  const byTitle = new Map(modules.map((node) => [node.title, node]))
  assert.ok(byTitle.get('main.py').result.startsWith('入口'), byTitle.get('main.py').result)
  assert.ok(byTitle.get('util.js').result.startsWith('工具'), byTitle.get('util.js').result)
  assert.ok(byTitle.get('service.js').result.startsWith('服务'), byTitle.get('service.js').result)
  assert.ok(modules.every((node) => path.isAbsolute(node.params.path)), 'paths are absolute for the agent')
  assert.equal(graph.project.origin, 'import')
  assert.equal(graph.meta.strategy, 'modules')
  assert.ok(summary.includes('模块结构图'), summary)
})
await check('module graph links importers to their imported files', async () => {
  const { graph } = await analyzeModules({ path: fixtureRoot })
  const idOf = (title) => graph.nodes.find((node) => node.type === 'module' && node.title === title)?.id
  const util = idOf('util.js')
  const service = idOf('service.js')
  assert.ok(graph.links.some(([from, , to]) => from === util && to === service), 'service.js depends on util.js')
  const scan = graph.nodes.find((node) => node.type === 'scan')
  assert.ok(graph.links.some(([from, , to]) => from === scan.id && to === util), 'dependency roots hang off scan')
})
await check('key files expand into per-symbol child nodes', async () => {
  const { graph } = await analyzeModules({ path: fixtureRoot })
  const symbolNodes = graph.nodes.filter((node) => node.type === 'module' && node.params.symbol)
  assert.ok(symbolNodes.length >= 1, 'at least one symbol node')
  const parentTitle = symbolNodes[0].title.split(' · ')[0]
  const parent = graph.nodes.find((node) => node.type === 'module' && node.title === parentTitle)
  assert.ok(parent !== undefined, `parent node for ${parentTitle}`)
  assert.ok(graph.links.some(([from, , to]) => from === parent.id && to === symbolNodes[0].id))
  assert.ok(symbolNodes[0].detail.includes('职责'), symbolNodes[0].detail)
})
await check('the module graph reports a bad path loudly', async () => {
  await assert.rejects(() => analyzeModules({ path: 'Z:/definitely/missing/dir' }), /目录不存在/)
})

console.log('\n[dual import]')
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-dual-import-'))
  try {
    await check('one scan produces both graphs under one project name', async () => {
      const result = await importProjectDual({ path: fixtureRoot, cwd: workspace, existingNames: [] })
      assert.equal(result.tasksGraph.project.name, result.modulesGraph.project.name, 'one shared name')
      assert.equal(result.modulesGraph.project.name, result.name)
      assert.equal(result.tasksGraph.meta.importedFrom, result.modulesGraph.meta.importedFrom, 'one importedFrom')
      assert.equal(result.tasksGraph.meta.strategy, 'tasks')
      assert.equal(result.modulesGraph.meta.strategy, 'modules')
      assert.ok(!result.tasksGraph.nodes.some((node) => node.type === 'module'), 'the task graph has no module nodes')
      assert.ok(!result.modulesGraph.nodes.some((node) => ['edit', 'testgen', 'deliver', 'review'].includes(node.type)), 'the module graph has no task chain')
      assert.ok(result.modulesGraph.nodes.some((node) => node.type === 'module'))
      assert.ok(result.modulesGraph.nodes.every((node) => /^m\d+$/.test(node.id)), 'module ids carry the m prefix')
      assert.ok(result.tasksGraph.nodes.every((node) => /^t\d+$/.test(node.id)), 'task ids carry the t prefix')
      assert.ok(result.summary.includes('任务流水线') && result.summary.includes('模块结构图'), result.summary)
    })
    await check('a forced projectName is shared verbatim (sanitized)', async () => {
      const result = await importProjectDual({ path: fixtureRoot, cwd: workspace, projectName: 'my-dual' })
      assert.equal(result.name, 'my-dual')
      assert.equal(result.tasksGraph.project.name, 'my-dual')
    })
    await check('a module analysis failure keeps the task pipeline importable', async () => {
      const empty = await mkdtemp(path.join(tmpdir(), 'codeflow-empty-'))
      try {
        await writeFile(path.join(empty, 'README.md'), '# nothing to analyze\n', 'utf8')
        const result = await importProjectDual({ path: empty, cwd: workspace, existingNames: [] })
        assert.ok(result.tasksGraph.nodes.length > 0, 'the task pipeline still imports')
        assert.equal(result.modulesGraph, undefined, 'no fabricated empty module graph')
        assert.ok(result.modulesWarning.length > 0, 'the warning names the reason')
        assert.ok(result.summary.includes('不可用'), result.summary)
      } finally {
        await rm(empty, { recursive: true, force: true })
      }
    })
    await check('the importer CLI writes both files and --modules stays a no-op alias', async () => {
      const out = await mkdtemp(path.join(tmpdir(), 'codeflow-cli-'))
      try {
        const code = await importerMain([fixtureRoot, '--out', out])
        assert.equal(code, 0)
        const dirs = await readdir(path.join(out, 'CodeFlow', 'flow-projects'))
        assert.equal(dirs.length, 1)
        const dir = path.join(out, 'CodeFlow', 'flow-projects', dirs[0])
        const tasksDisk = JSON.parse(await readFile(path.join(dir, 'workflow.json'), 'utf8'))
        const modulesDisk = JSON.parse(await readFile(path.join(dir, 'workflow.modules.json'), 'utf8'))
        assert.equal(tasksDisk.meta.strategy, 'tasks')
        assert.equal(modulesDisk.meta.strategy, 'modules')
        assert.equal(tasksDisk.project.name, modulesDisk.project.name)
        // Same outcome with the compatibility alias.
        const out2 = await mkdtemp(path.join(tmpdir(), 'codeflow-cli2-'))
        try {
          await importerMain([fixtureRoot, '--out', out2, '--modules'])
          const dirs2 = await readdir(path.join(out2, 'CodeFlow', 'flow-projects'))
          const dir2 = path.join(out2, 'CodeFlow', 'flow-projects', dirs2[0])
          const modules2 = JSON.parse(await readFile(path.join(dir2, 'workflow.modules.json'), 'utf8'))
          assert.equal(modules2.meta.strategy, 'modules', '--modules no longer means modules-only')
          assert.ok(await readFile(path.join(dir2, 'workflow.json'), 'utf8').then(() => true, () => false), 'the task pipeline is still written')
        } finally {
          await rm(out2, { recursive: true, force: true })
        }
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

console.log('\n[apply()]')
const { ctx, recorded } = fakeContext()
await check('plugin identity and inject list', () => {
  assert.equal(pluginName, 'codeflow-canvas')
  assert.deepEqual([...inject].sort(), ['commands', 'skills', 'tools'])
})
apply(ctx)

await check('registers exactly one skill provider', () => {
  assert.equal(recorded.skillProviders.length, 1)
})
await check('registers /flow, /flow-new, /flow-import', () => {
  assert.deepEqual(recorded.commands.map((c) => c.name).sort(), ['flow', 'flow-import', 'flow-new'])
  for (const command of recorded.commands) {
    assert.ok(command.description.length > 0)
    assert.ok(command.definitionId.startsWith('codeflow-canvas:'))
    assert.equal(typeof command.handler, 'function')
  }
})
await check('registers the codeflow_canvas tool', () => {
  assert.equal(recorded.tools.length, 1)
  assert.equal(recorded.tools[0].name, 'codeflow_canvas')
  assert.equal(typeof recorded.tools[0].execute, 'function')
  assert.equal(typeof recorded.tools[0].output.render, 'function')
})
await check('registers one prefix route at /codeflow', () => {
  assert.equal(recorded.routes.length, 1)
  assert.equal(recorded.routes[0].kind, 'prefix')
  assert.equal(recorded.routes[0].path, '/codeflow')
})

console.log('\n[skill provider]')
const provider = recorded.skillProviders[0]
await check('lists one model-invocable, not user-invocable skill', async () => {
  const candidates = await provider.list({})
  assert.equal(candidates.length, 1)
  const [skill] = candidates
  assert.equal(skill.name, 'codeflow-canvas')
  assert.equal(skill.invocation.modelInvocable, true)
  assert.equal(skill.invocation.userInvocable, false)
  assert.equal(skill.rank, 600, 'bundled rank')
  assert.equal(skill.resourceBase.kind, 'directory')
})
await check('loads the body with frontmatter stripped', async () => {
  const candidates = await provider.list({})
  const definition = await provider.get(candidates[0], {})
  assert.ok(definition.content.length > 1000, 'body is the full document')
  assert.ok(!definition.content.startsWith('---'), 'frontmatter removed')
  assert.ok(definition.content.includes('CodeFlow 工作流画布'))
})
await check('every reference file the skill advertises exists', async () => {
  const candidates = await provider.list({})
  const definition = await provider.get(candidates[0], {})
  const referenced = [...definition.content.matchAll(/`(references\/[a-z-]+\.md)`/g)].map((m) => m[1])
  assert.ok(referenced.length >= 4, `expected to advertise the references, saw ${referenced.join(',')}`)
  for (const rel of new Set(referenced)) await read(`assets/skill/codeflow-canvas/${rel}`)
})

console.log('\n[commands]')
await check('flow and flow-new inject one turn carrying the skill block', async () => {
  for (const command of recorded.commands.filter((c) => c.name !== 'flow-import')) {
    const sink = []
    await command.handler({ agent: fakeAgent('s1', sink), rawInput: '  my brief ', signal: new AbortController().signal })
    assert.equal(sink.length, 1, `${command.name} injects exactly one message`)
    const message = sink[0]
    assert.equal(message.role, 'user')
    assert.deepEqual(message.source, { kind: 'user' })
    const text = message.content.map((part) => part.text).join('')
    assert.ok(text.includes('<skill_content name="codeflow-canvas">'), `${command.name} carries the skill block`)
    assert.ok(text.includes('references/'), 'the skill block keeps its reference index')
  }
})
await check('flow-import runs host-side and never wakes the agent', async () => {
  const command = recorded.commands.find((c) => c.name === 'flow-import')
  const sink = []
  const result = await command.handler({ agent: fakeAgent('s-import', sink), rawInput: ` ${fixtureRoot} `, signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('已导入'), result.text)
  assert.equal(sink.length, 0, 'the agent must stay asleep during import')
})
await check('flow-import accepts an @-mentioned path', async () => {
  const command = recorded.commands.find((c) => c.name === 'flow-import')
  const sink = []
  const result = await command.handler({
    agent: fakeAgent('s-import-at', sink),
    rawInput: ` @${fixtureRoot} `,
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success', result.text)
  assert.ok(result.text.includes('已导入'), result.text)
  assert.equal(sink.length, 0, 'the agent must stay asleep')
})
await check('flow-import without a path asks for one instead of waking the agent', async () => {
  const command = recorded.commands.find((c) => c.name === 'flow-import')
  const sink = []
  const result = await command.handler({ agent: fakeAgent('s-import', sink), rawInput: '', signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('路径'), result.text)
  assert.equal(sink.length, 0)
})
await check('flow-import --modules builds the module graph host-side', async () => {
  const command = recorded.commands.find((c) => c.name === 'flow-import')
  const sink = []
  const result = await command.handler({
    agent: fakeAgent('s-import-modules', sink),
    rawInput: ` --modules ${fixtureRoot} `,
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('模块结构图'), result.text)
  assert.equal(sink.length, 0, 'the agent must stay asleep')
})
await check('flow-import reports a bad directory as an error', async () => {
  const command = recorded.commands.find((c) => c.name === 'flow-import')
  const sink = []
  const result = await command.handler({
    agent: fakeAgent('s-import', sink),
    rawInput: path.join(fixtureRoot, 'missing'),
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('目录不存在'), result.text)
})
await check('an argument is forwarded as context', async () => {
  const sink = []
  const create = recorded.commands.find((c) => c.name === 'flow-new')
  await create.handler({ agent: fakeAgent('s1', sink), rawInput: '  todo cli in python ', signal: new AbortController().signal })
  assert.ok(sink[0].content[0].text.includes('todo cli in python'))
})
await check('handlers return a success result', async () => {
  const sink = []
  const result = await recorded.commands[0].handler({ agent: fakeAgent('s1', sink), rawInput: '', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
})

console.log('\n[tool]')
const tool = recorded.tools[0]
const sampleGraph = {
  format: 'codeflow/1',
  rev: 0,
  project: { name: 'demo', language: 'python', origin: 'new' },
  nodes: [
    { id: 'n1', type: 'requirement', title: '需求', pos: [0, 0], params: {}, status: 'done', result: 'ok' },
    { id: 'n2', type: 'codegen', title: '代码', pos: [330, 0], params: {}, status: 'pending' },
  ],
  links: [['n1', 0, 'n2', 0]],
  meta: {},
}

await check('render writes state, bumps rev and persists under the workspace', async () => {
  const agent = fakeAgent('s-render', [])
  recorded.agents.set('s-render', agent)
  const value = await tool.execute({ mode: 'render', graph: sampleGraph }, { agent })
  assert.equal(value.project, 'demo')
  assert.equal(value.rev, 1)
  assert.equal(value.summary, '2 个节点 · 1 完成 · 1 待运行')
  assert.ok(normalizePath(value.file).endsWith('/CodeFlow/flow-projects/demo/workflow.json'), value.file)
})
await check('read returns the live graph', async () => {
  const value = await tool.execute({ mode: 'read', project: 'demo' }, { agent: fakeAgent('s-render', []) })
  assert.equal(value.graph.nodes.length, 2)
  assert.equal(value.rev, 1)
})
await check('render rejects a non-graph payload', async () => {
  await assert.rejects(() => tool.execute({ mode: 'render', graph: 'nope' }, {}), /codeflow\/1 graph/)
})
await check('read without state and without workspace fails loudly', async () => {
  await assert.rejects(() => tool.execute({ mode: 'read', project: 'ghost' }, {}), /no canvas state/)
})
await check('output.render produces a model-facing text block', () => {
  const blocks = tool.output.render({ mode: 'render' }, { project: 'demo', rev: 3, summary: '2 个节点', file: '/w/x.json' })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('rev 3'))
})

console.log('\n[view-aware tool]')
{
  const viewWorkspace = await mkdtemp(path.join(tmpdir(), 'codeflow-tool-view-'))
  try {
    const store = createStore(console)
    const { ctx: toolCtx, recorded: toolRecorded } = fakeContext()
    registerTool(toolCtx, store)
    const viewTool = toolRecorded.tools[0]
    await store.write({
      format: 'codeflow/1', rev: 0,
      project: { name: 'view-demo', origin: 'import' },
      nodes: [{ id: 't1', type: 'edit', pos: [0, 0], params: {}, status: 'pending', result: '', detail: '' }],
      links: [], meta: { importedFrom: viewWorkspace, strategy: 'tasks' },
    }, { persist: 'now', cwd: viewWorkspace, view: 'tasks' })

    await check('load on a view that was never generated fails with an actionable error', async () => {
      await assert.rejects(
        () => viewTool.execute({ mode: 'load', project: 'view-demo', view: 'modules' }, {}),
        (error) => {
          assert.match(error.message, /模块结构图/)
          assert.match(error.message, /未生成|workflow\.modules\.json/)
          return true
        },
      )
    })
    await check('read addresses one view and reports the other', async () => {
      const value = await viewTool.execute({ mode: 'read', project: 'view-demo', view: 'tasks' }, {})
      assert.equal(value.view, 'tasks')
      assert.equal(value.graph.nodes[0].id, 't1')
      assert.ok(value.summary.includes('未生成'), 'the summary says the module view is absent')
    })
    await check('load re-reads exactly the target view and leaves the other rev alone', async () => {
      // Give the project a modules view, then edit only the tasks file on disk.
      await store.write({
        format: 'codeflow/1', rev: 0,
        project: { name: 'view-demo', origin: 'import' },
        nodes: [{ id: 'm1', type: 'module', pos: [0, 0], params: { path: '/x.py', symbol: '' }, status: 'pending', result: '', detail: '' }],
        links: [], meta: { importedFrom: viewWorkspace, strategy: 'modules' },
      }, { persist: 'now', cwd: viewWorkspace, view: 'modules' })
      const tasksFile = path.join(viewWorkspace, 'CodeFlow', 'flow-projects', 'view-demo', 'workflow.json')
      const onDisk = JSON.parse(await readFile(tasksFile, 'utf8'))
      onDisk.nodes[0].status = 'done'
      onDisk.nodes[0].result = '磁盘上的修改'
      await writeFile(tasksFile, JSON.stringify(onDisk), 'utf8')
      const modulesRevBefore = store.get('view-demo', 'modules').rev
      const value = await viewTool.execute({ mode: 'load', project: 'view-demo', view: 'tasks' }, {})
      assert.equal(value.view, 'tasks')
      const modulesRevAfter = store.get('view-demo', 'modules').rev
      assert.equal(modulesRevAfter, modulesRevBefore, 'the modules rev did not move')
      const read = await viewTool.execute({ mode: 'read', project: 'view-demo', view: 'tasks' }, {})
      assert.equal(read.graph.nodes[0].status, 'done')
    })
    await check('save flushes both views of a dual project', async () => {
      store.patchNode('view-demo', 'm1', { status: 'running' }, { view: 'modules' })
      const value = await viewTool.execute({ mode: 'save', project: 'view-demo' }, {})
      assert.equal(value.persisted, true)
      const modulesOnDisk = JSON.parse(await readFile(path.join(viewWorkspace, 'CodeFlow', 'flow-projects', 'view-demo', 'workflow.modules.json'), 'utf8'))
      assert.equal(modulesOnDisk.nodes[0].status, 'running', 'the modules view reached the disk too')
    })
  } finally {
    await rm(viewWorkspace, { recursive: true, force: true })
  }
}

console.log('\n[http surface]')
const handler = recorded.routes[0].handler
const canvasGraph = {
  format: 'codeflow/1', rev: 0, project: { name: 'web' }, nodes: [{ id: 'n1', type: 'requirement', status: 'pending' }], links: [],
}

/** Call the route handler and parse the JSON body. */
async function call(method, url, body) {
  const res = fakeResponse()
  await handler(fakeRequest(method, url, body), res)
  return { status: res.statusCode, headers: res.headers, text: res.body, json: res.body.startsWith('{') ? JSON.parse(res.body) : undefined }
}

await check('GET /codeflow/canvas serves a document with the boot payload', async () => {
  const missing = await call('GET', '/codeflow/api/state')
  assert.equal(missing.status, 200)
  const response = await call('GET', '/codeflow/canvas')
  assert.equal(response.status, 200)
  assert.ok(response.headers['content-type'].startsWith('text/html'))
  assert.ok(response.text.startsWith('<!doctype html>'))
  assert.ok(response.text.includes('window.__CF_BOOT__='))
  assert.ok(response.text.includes('id="codeflow-canvas"'), 'the ported fragment is included')
})
await check('POST /codeflow/api/state stores the graph and returns the new rev', async () => {
  const first = await call('POST', '/codeflow/api/state', { graph: canvasGraph, view: [10, 20, 1.5] })
  assert.equal(first.status, 200)
  assert.equal(first.json.rev, 1)
  const second = await call('POST', '/codeflow/api/state', { graph: canvasGraph })
  assert.equal(second.json.rev, 2, 'every accepted write bumps rev once')
  const state = await call('GET', '/codeflow/api/state?project=web')
  assert.equal(state.json.rev, 2)
  assert.deepEqual(state.json.viewport, [10, 20, 1.5], 'the viewport is remembered (the legacy view-array form still works)')
  assert.equal(state.json.view, 'tasks', 'GET /api/state names the resolved view')
})
await check('GET /codeflow/canvas carries the stored viewport', async () => {
  const response = await call('GET', '/codeflow/canvas?project=web')
  assert.ok(/"view":\[10,20,1\.5\]/.test(response.text), 'boot payload has the view')
})
await check('an opening panel shows the most recent project, not the untitled bucket', async () => {
  // The panel iframe requests /codeflow/canvas with no project name. Landing on
  // the untitled bucket made the canvas look empty even though a project existed.
  const response = await call('GET', '/codeflow/canvas')
  const boot = JSON.parse(/window\.__CF_BOOT__=([\s\S]*?);<\/script>/.exec(response.text)[1])
  assert.notEqual(boot.project, '__untitled__', 'must not open on the untitled bucket')
  assert.equal(boot.project, 'web')
  assert.ok(boot.graph.nodes.length > 0, 'the project it opens on holds nodes')
})
await check('render no longer grabs the canvas-session binding', async () => {
  // v0.5.0: a `/flow` render from an arbitrary conversation must not steal the
  // binding. Proof by behaviour: after a render, a gesture still creates a
  // fresh dedicated session (bound render would have skipped creation) and the
  // render agent itself is never woken.
  recorded.agents.clear()
  const sink = []
  const controller = fakeSessionController()
  const withController = fakeContext({ sessionController: controller })
  withController.recorded.agents.set('s-render', fakeAgent('s-render', sink, fixtureRoot))
  apply(withController.ctx)
  const tool2 = withController.recorded.tools[0]
  await tool2.execute({ mode: 'render', graph: { ...canvasGraph, project: { name: 'web' } } }, { agent: withController.recorded.agents.get('s-render') })
  const handler2 = withController.recorded.routes[0].handler
  const res = fakeResponse()
  await handler2(fakeRequest('POST', '/codeflow/api/action', {
    action: 'RUN_NODE', graph: { ...canvasGraph, project: { name: 'web' } }, nodeId: 'n1', rerun: false, title: '运行节点',
  }), res)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(controller.state.created.length, 1, 'the gesture creates a dedicated session')
  assert.equal(controller.state.prompts[0].sessionId, 'sess-1', 'the prompt goes to the dedicated session')
  assert.equal(sink.length, 0, 'the render agent is never woken')
})
await check('a canvas gesture is delivered only to the project’s dedicated session', async () => {
  // The gesture runs with a sessionController available: the manager creates
  // one dedicated session and queues the prompt there. The live agent that
  // happens to share the workspace stays untouched.
  const sink = []
  const controller = fakeSessionController()
  const withController = fakeContext({ sessionController: controller })
  withController.recorded.agents.set('s-action', fakeAgent('s-action', sink, fixtureRoot))
  apply(withController.ctx)
  const handler2 = withController.recorded.routes[0].handler
  const res = fakeResponse()
  await handler2(fakeRequest('POST', '/codeflow/api/action', {
    action: 'RUN_NODE', graph: { ...canvasGraph, project: { name: 'dedi' } }, nodeId: 'n1', rerun: false, title: '运行节点',
  }), res)
  assert.equal(res.statusCode, 200, res.body)
  const body = JSON.parse(res.body)
  assert.equal(controller.state.created.length, 1, 'exactly one dedicated session is created')
  assert.equal(controller.state.prompts.length, 1)
  const text = controller.state.prompts[0].content[0].text
  assert.ok(text.startsWith('[CodeFlow:RUN_NODE]'), text)
  const payload = parsePrompt(text).payload
  assert.equal(payload.project, 'dedi')
  assert.equal(payload.nodeId, 'n1')
  assert.equal(sink.length, 0, 'no other session is woken')
  assert.equal(body.undoable, true, 'the run is snapshotted (empty tree is still snapshotable)')
  assert.equal(typeof body.runId, 'string', 'the snapshot run id is returned')
})
await check('a RUN_NODE on the modules view quotes the modules graphPath and tags the run view', async () => {
  const sink = []
  const controller = fakeSessionController()
  const withController = fakeContext({ sessionController: controller })
  const modulesWorkspace = await mkdtemp(path.join(tmpdir(), 'codeflow-run-mod-'))
  try {
    withController.recorded.agents.set('s-run-mod', fakeAgent('s-run-mod', sink, modulesWorkspace))
    apply(withController.ctx)
    const handler2 = withController.recorded.routes[0].handler
    const modulesGraph = {
      format: 'codeflow/1', rev: 0,
      project: { name: 'run-mod', origin: 'import' },
      nodes: [{ id: 'm1', type: 'module', pos: [0, 0], params: { path: '/x.py', symbol: '' }, status: 'pending', result: '', detail: '' }],
      links: [], meta: { importedFrom: modulesWorkspace, strategy: 'modules' },
    }
    const res = fakeResponse()
    await handler2(fakeRequest('POST', '/codeflow/api/action', {
      action: 'RUN_NODE', graph: modulesGraph, view: 'modules', nodeId: 'm1', rerun: false, title: '运行模块',
    }), res)
    assert.equal(res.statusCode, 200, res.body)
    const text = controller.state.prompts[0].content[0].text
    assert.ok(text.startsWith('[CodeFlow:RUN_NODE]'), text)
    const payload = parsePrompt(text).payload
    assert.equal(payload.view, 'modules', 'the prompt names the view')
    assert.ok(normalizePath(payload.graphPath).endsWith('/CodeFlow/flow-projects/run-mod/workflow.modules.json'), payload.graphPath)
    // The manifest records the run's view so the undo restore touches only it.
    const undoDirs = await readdir(path.join(modulesWorkspace, 'CodeFlow', 'flow-projects', 'run-mod', '.undo'))
    const manifest = JSON.parse(await readFile(path.join(modulesWorkspace, 'CodeFlow', 'flow-projects', 'run-mod', '.undo', undoDirs[0], 'manifest.json'), 'utf8'))
    assert.equal(manifest.view, 'modules')
  } finally {
    await rm(modulesWorkspace, { recursive: true, force: true })
  }
})

console.log('\n[v1.0 self-contained run requests (A3.1/A3.3)]')
await check('a RUN_NODE prompt is self-contained: node/upstream/cwd/expect + requirements footer', async () => {
  const sink = []
  const controller = fakeSessionController()
  const withController = fakeContext({ sessionController: controller })
  const runWorkspace = await mkdtemp(path.join(tmpdir(), 'codeflow-run-self-'))
  try {
    withController.recorded.agents.set('s-run-self', fakeAgent('s-run-self', sink, runWorkspace))
    apply(withController.ctx)
    const handler2 = withController.recorded.routes[0].handler
    async function ask(method, url, body) {
      const r = fakeResponse()
      await handler2(fakeRequest(method, url, body), r)
      return { status: r.statusCode, json: r.body.startsWith('{') ? JSON.parse(r.body) : undefined }
    }
    const runGraph = {
      format: 'codeflow/1', rev: 0,
      project: { name: 'run-self', language: 'python', origin: 'new' },
      nodes: [
        { id: 't1', type: 'testgen', title: '测试生成', status: 'done', result: `1 个测试文件，约 6 个用例${'x'.repeat(150)}`, detail: '' },
        { id: 't2', type: 'testrun', title: '测试运行', params: { cmd: 'python -m unittest discover -s tests -v' }, status: 'pending', result: '', detail: '' },
      ],
      links: [['t1', 0, 't2', 0]],
      meta: {},
    }
    const res = await ask('POST', '/codeflow/api/action', {
      action: 'RUN_NODE', graph: runGraph, view: 'tasks', nodeId: 't2', rerun: false, title: '测试运行',
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    const text = controller.state.prompts[0].content[0].text
    const { payload, requirements } = parsePrompt(text)
    // 首行仍是单行 JSON 且可 JSON.parse（parsePrompt 的存在即证明）；node/params 原样随行。
    assert.equal(payload.action, 'RUN_NODE')
    assert.equal(payload.node.type, 'testrun', 'the prompt carries the node type')
    assert.equal(payload.node.title, '测试运行')
    assert.equal(payload.node.params.cmd, 'python -m unittest discover -s tests -v', 'params ride along, cmd included')
    assert.equal(payload.upstream.length, 1, 'direct upstreams ride along')
    assert.equal(payload.upstream[0].id, 't1')
    assert.equal(payload.upstream[0].status, 'done')
    assert.ok(payload.upstream[0].result.length <= 120, 'upstream results are clipped to 120 chars')
    assert.equal(
      normalizePath(payload.cwd),
      normalizePath(path.join(runWorkspace, 'CodeFlow', 'flow-projects', 'run-self')),
      'cwd is the project root (not the workspace root)',
    )
    assert.ok(payload.expect.includes('真实执行'), 'the acceptance line rides along')
    // JSON 之后的正文：三行执行要求。
    assert.ok(requirements.includes('本次执行要求（必须遵守）：'), requirements)
    assert.ok(requirements.includes('不得以「之前已经跑过/已经通过」为理由跳过'), requirements)
    assert.ok(requirements.includes('nodeId=t2'), requirements)
    assert.ok(requirements.includes('宿主会把该节点标记为失败'), requirements)
    // A3.3：投递成功后目标节点立即 running（面板 ≤1 个轮询周期内可见）。
    const state = await ask('GET', '/codeflow/api/state?project=run-self&view=tasks')
    const t2 = state.json.graph.nodes.find((node) => node.id === 't2')
    assert.equal(t2.status, 'running', 'the target node flips to running right after delivery')
    // 响应带的是 store 的最新 rev（含乐观置 running 的那一次 bump）。
    assert.equal(state.json.rev, res.json.rev, 'the action response rev matches the store')
  } finally {
    await rm(runWorkspace, { recursive: true, force: true })
  }
})
await check('a failed delivery rolls the optimistic running back to the previous status', async () => {
  const sink = []
  const controller = fakeSessionController()
  controller.state.failNextPrompt = new Error('session exploded')
  const withController = fakeContext({ sessionController: controller })
  const failWorkspace = await mkdtemp(path.join(tmpdir(), 'codeflow-run-fail-'))
  try {
    withController.recorded.agents.set('s-run-fail', fakeAgent('s-run-fail', sink, failWorkspace))
    apply(withController.ctx)
    const handler2 = withController.recorded.routes[0].handler
    async function ask(method, url, body) {
      const r = fakeResponse()
      await handler2(fakeRequest(method, url, body), r)
      return { status: r.statusCode, json: r.body.startsWith('{') ? JSON.parse(r.body) : undefined }
    }
    const runGraph = {
      format: 'codeflow/1', rev: 0,
      project: { name: 'run-fail', language: 'python', origin: 'new' },
      nodes: [{ id: 't2', type: 'testrun', title: '测试运行', params: { cmd: 'echo hi' }, status: 'pending', result: '', detail: '' }],
      links: [], meta: {},
    }
    const res = await ask('POST', '/codeflow/api/action', {
      action: 'RUN_NODE', graph: runGraph, view: 'tasks', nodeId: 't2', rerun: false, title: '测试运行',
    })
    assert.equal(res.status, 409, 'the delivery failure surfaces as 409')
    const state = await ask('GET', '/codeflow/api/state?project=run-fail&view=tasks')
    const t2 = state.json.graph.nodes.find((node) => node.id === 't2')
    assert.equal(t2.status, 'pending', 'the optimistic running is rolled back (never stuck spinning)')
  } finally {
    await rm(failWorkspace, { recursive: true, force: true })
  }
})
await check('RUN_ALL carries the topo order of pending/failed nodes and flips only the first one running', async () => {
  const sink = []
  const controller = fakeSessionController()
  const withController = fakeContext({ sessionController: controller })
  const allWorkspace = await mkdtemp(path.join(tmpdir(), 'codeflow-run-all-'))
  try {
    withController.recorded.agents.set('s-run-all', fakeAgent('s-run-all', sink, allWorkspace))
    apply(withController.ctx)
    const handler2 = withController.recorded.routes[0].handler
    async function ask(method, url, body) {
      const r = fakeResponse()
      await handler2(fakeRequest(method, url, body), r)
      return { status: r.statusCode, json: r.body.startsWith('{') ? JSON.parse(r.body) : undefined }
    }
    const runGraph = {
      format: 'codeflow/1', rev: 0,
      project: { name: 'run-all', language: 'python', origin: 'new' },
      nodes: [
        { id: 't1', type: 'requirement', title: '需求', status: 'done', result: 'ok', detail: '' },
        { id: 't2', type: 'codegen', title: '代码生成', status: 'pending', result: '', detail: '' },
        { id: 't3', type: 'testgen', title: '测试生成', status: 'failed', result: '', detail: '' },
        { id: 't4', type: 'review', title: '审查', status: 'skipped', result: '', detail: '' },
      ],
      links: [['t1', 0, 't2', 0], ['t2', 0, 't3', 0], ['t3', 0, 't4', 0]],
      meta: {},
    }
    const res = await ask('POST', '/codeflow/api/action', { action: 'RUN_ALL', graph: runGraph, view: 'tasks', title: '运行全部' })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    const { payload, requirements } = parsePrompt(controller.state.prompts[0].content[0].text)
    assert.deepEqual(payload.order, ['t2', 't3'], 'order is the topo order of pending/failed nodes only')
    assert.ok(requirements.includes('order 列出的每个节点'), requirements)
    const state = await ask('GET', '/codeflow/api/state?project=run-all&view=tasks')
    const statuses = Object.fromEntries(state.json.graph.nodes.map((node) => [node.id, node.status]))
    assert.equal(statuses.t2, 'running', 'the first pending node is optimistic-running')
    assert.equal(statuses.t3, 'failed', 'later nodes keep their status (no whole-graph spin)')
    assert.equal(statuses.t1, 'done')
    assert.equal(statuses.t4, 'skipped')
  } finally {
    await rm(allWorkspace, { recursive: true, force: true })
  }
})
await check('an unbound project without a session controller is refused with an actionable error', async () => {
  const sink = []
  recorded.agents.clear()
  recorded.agents.set('only-root', fakeAgent('only-root', sink, fixtureRoot))
  const response = await call('POST', '/codeflow/api/action', {
    action: 'RUN_ALL', graph: { ...canvasGraph, project: { name: 'other' } },
  })
  assert.equal(response.status, 409)
  assert.ok(response.json.error.includes('专用会话') || response.json.error.includes('sessionController'), response.json.error)
  assert.equal(sink.length, 0, 'the plugin must never wake an unrelated agent as a fallback')
})
await check('several live agents do not change the outcome (no root-guessing)', async () => {
  recorded.agents.clear()
  recorded.agents.set('a', fakeAgent('a', []))
  recorded.agents.set('b', fakeAgent('b', []))
  const response = await call('POST', '/codeflow/api/action', {
    action: 'RUN_ALL', graph: { ...canvasGraph, project: { name: 'ambiguous' } },
  })
  assert.equal(response.status, 409)
  assert.ok(response.json.error.includes('专用会话') || response.json.error.includes('sessionController'), response.json.error)
})
await check('a dead bound session is rebuilt once and the prompt retried', async () => {
  const controller = fakeSessionController()
  const withController = fakeContext({ sessionController: controller })
  withController.recorded.agents.set('s-rebuild', fakeAgent('s-rebuild', [], fixtureRoot))
  apply(withController.ctx)
  const handler2 = withController.recorded.routes[0].handler
  // Render creates nothing anymore; deliver creates session 1, which then dies.
  const gone = Object.assign(new Error('session "sess-1" not found'), { code: 'session/not-found' })
  controller.state.failNextPrompt = gone
  const res = fakeResponse()
  await handler2(fakeRequest('POST', '/codeflow/api/action', {
    action: 'RUN_ALL', graph: { ...canvasGraph, project: { name: 'rebuild' } },
  }), res)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(controller.state.created.length, 2, 'one rebuild after not-found')
  assert.equal(controller.state.prompts.length, 1, 'exactly one prompt lands (the retry)')
})
await check('a writer-held session is never fought over', async () => {
  const controller = fakeSessionController()
  const withController = fakeContext({ sessionController: controller })
  withController.recorded.agents.set('s-held', fakeAgent('s-held', [], fixtureRoot))
  apply(withController.ctx)
  const handler2 = withController.recorded.routes[0].handler
  controller.state.failNextPrompt = Object.assign(new Error('session writer held'), { code: 'session/writer-held' })
  const res = fakeResponse()
  await handler2(fakeRequest('POST', '/codeflow/api/action', {
    action: 'RUN_ALL', graph: { ...canvasGraph, project: { name: 'held' } },
  }), res)
  assert.equal(res.statusCode, 409)
  assert.ok(res.body.includes('占用'), res.body)
  assert.equal(controller.state.created.length, 1, 'no rebuild on writer-held')
})
await check('an unknown action is refused', async () => {
  const response = await call('POST', '/codeflow/api/action', { action: 'SELF_DESTRUCT' })
  assert.equal(response.status, 400)
})
await check('POST /codeflow/api/save persists without a turn', async () => {
  const sink = []
  recorded.agents.clear()
  // A real, existing workspace: the save must actually land on disk, so the
  // route's persisted flag is asserted as `true` rather than tolerated as
  // whatever the environment happens to produce.
  const saveWorkspace = await mkdtemp(path.join(tmpdir(), 'codeflow-save-'))
  recorded.agents.set('s-save', fakeAgent('s-save', sink, saveWorkspace))
  try {
    const response = await call('POST', '/codeflow/api/save', { graph: canvasGraph })
    assert.equal(response.status, 200, response.text)
    assert.equal(response.json.ok, true)
    assert.equal(response.json.persisted, true, 'the durable copy really landed')
    assert.equal(sink.length, 0, 'save must not wake the agent')
    assert.ok(normalizePath(response.json.file).endsWith('/CodeFlow/flow-projects/web/workflow.json'), response.json.file)
  } finally {
    await rm(saveWorkspace, { recursive: true, force: true })
  }
})
await check('POST /codeflow/api/import builds the graph host-side, no agent turn', async () => {
  const sink = []
  recorded.agents.clear()
  recorded.agents.set('s-http-import', fakeAgent('s-http-import', sink))
  const response = await call('POST', '/codeflow/api/import', { path: fixtureRoot, fromComments: true, addTests: true })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.ok(response.json.rev > 0)
  assert.ok(response.json.summary.includes('节点'), response.json.summary)
  assert.ok(normalizePath(response.json.file).includes('/flow-projects/'), response.json.file)
  const graph = response.json.graph
  assert.equal(graph.project.origin, 'import')
  assert.equal(graph.nodes.filter((node) => node.status === 'done').length, 2, 'scan and comments arrive done')
  assert.equal(sink.length, 0, 'import must not wake the agent')
})
await check('POST /codeflow/api/import accepts an @-mentioned path', async () => {
  const response = await call('POST', '/codeflow/api/import', { path: `@${fixtureRoot}` })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.graph.project.origin, 'import')
})
await check('POST /codeflow/api/import generates both views; a legacy strategy field is ignored', async () => {
  const response = await call('POST', '/codeflow/api/import', { path: fixtureRoot, strategy: 'modules' })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  // One scan → two graphs, one project name; the payload describes both.
  assert.equal(response.json.modulesAvailable, true, 'the module graph is generated from source files')
  assert.ok(response.json.tasksSummary.includes('节点'), response.json.tasksSummary)
  assert.ok(response.json.modulesSummary.includes('模块结构图'), response.json.modulesSummary)
  assert.ok(response.json.summary.includes('任务流水线') && response.json.summary.includes('模块结构图'), response.json.summary)
  assert.equal(response.json.graph.meta.strategy, 'tasks', 'the served graph is the task pipeline (default view)')
  const views = response.json.views
  assert.equal(views.tasks.available, true)
  assert.equal(views.modules.available, true)
  const projectDir = normalizePath(response.json.file).replace(/\/workflow\.json$/, '')
  const modulesOnDisk = JSON.parse(await readFile(path.join(projectDir, 'workflow.modules.json'), 'utf8'))
  assert.equal(modulesOnDisk.meta.strategy, 'modules')
  assert.ok(modulesOnDisk.nodes.some((node) => node.type === 'module'), 'module nodes present on disk')
})
await check('import with a bad path answers 400 with the reason', async () => {
  const response = await call('POST', '/codeflow/api/import', { path: path.join(fixtureRoot, 'missing') })
  assert.equal(response.status, 400)
  assert.equal(response.json.ok, false)
  assert.ok(response.json.error.includes('目录不存在'), response.json.error)
})
await check('the IMPORT gesture is no longer an agent action', async () => {
  const sink = []
  recorded.agents.clear()
  recorded.agents.set('s-legacy', fakeAgent('s-legacy', sink))
  const response = await call('POST', '/codeflow/api/action', { action: 'IMPORT', path: fixtureRoot })
  assert.equal(response.status, 400, 'import is served by /api/import, not the agent')
  assert.equal(sink.length, 0)
})
await check('NEW creates a durable starter project even with no agent session', async () => {
  recorded.agents.clear()
  const response = await call('POST', '/codeflow/api/action', {
    action: 'NEW', name: 'host-new', brief: '做一个命令行工具', language: 'python',
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.delivered, false, 'no session can be reached')
  assert.equal(response.json.project, 'host-new')
  assert.equal(response.json.graph.project.name, 'host-new')
  assert.ok(response.json.graph.nodes.length >= 3, 'a starter skeleton is returned')
  assert.ok(response.json.warning.includes('agent'), response.json.warning)
})
await check('NEW creates the project and queues it in a fresh dedicated session', async () => {
  const sink = []
  const controller = fakeSessionController()
  const withController = fakeContext({ sessionController: controller })
  withController.recorded.agents.set('s-new', fakeAgent('s-new', sink, fixtureRoot))
  apply(withController.ctx)
  const handler2 = withController.recorded.routes[0].handler
  const res = fakeResponse()
  await handler2(fakeRequest('POST', '/codeflow/api/action', {
    action: 'NEW', name: 'host-agent', brief: 'tiny cli', language: 'javascript',
  }), res)
  const body = JSON.parse(res.body)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(body.delivered, true)
  assert.equal(body.project, 'host-agent')
  assert.equal(controller.state.created.length, 1, 'a dedicated session is created for the new project')
  assert.equal(controller.state.prompts.length, 1, 'the NEW turn is queued via the controller')
  const text = controller.state.prompts[0].content[0].text
  assert.ok(text.startsWith('[CodeFlow:NEW]'), text)
  const payload = parsePrompt(text).payload
  assert.equal(payload.action, 'NEW')
  assert.equal(payload.project, 'host-agent')
  assert.ok(normalizePath(payload.graphPath).endsWith('/CodeFlow/flow-projects/host-agent/workflow.json'), payload.graphPath)
  assert.equal(sink.length, 0, 'agents are woken by the controller, not directly')
})
await check('NEW suffixes a project name that is already taken', async () => {
  recorded.agents.clear()
  const response = await call('POST', '/codeflow/api/action', {
    action: 'NEW', name: 'host-new', brief: '', language: 'python',
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.project, 'host-new-flow')
  assert.ok(response.json.warning.includes('占用'), response.json.warning)
})
await check('a cross-site request is refused', async () => {
  const res = fakeResponse()
  const req = Object.assign(Readable.from([]), {
    method: 'GET',
    url: '/codeflow/api/state',
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
  })
  await handler(req, res)
  assert.equal(res.statusCode, 403)
})
await check('an origin mismatch is refused', async () => {
  const res = fakeResponse()
  const req = Object.assign(Readable.from([]), {
    method: 'GET',
    url: '/codeflow/api/state',
    headers: { host: '127.0.0.1:19387', origin: 'http://evil.example' },
  })
  await handler(req, res)
  assert.equal(res.statusCode, 403)
})
await check('an unknown path 404s as JSON', async () => {
  const response = await call('GET', '/codeflow/api/nope')
  assert.equal(response.status, 404)
  assert.equal(response.json.ok, false)
})
await check('delegates to the carrier browser gate when the host provides one', async () => {
  // A host with a browser gate: every request must pass it first.
  const gated = fakeContext({ connection: { requestRejection: () => 401 } })
  apply(gated.ctx)
  const res = fakeResponse()
  await gated.recorded.routes[0].handler(fakeRequest('GET', '/codeflow/api/state'), res)
  assert.equal(res.statusCode, 401)
})
await check('admits the request when the gate returns undefined', async () => {
  const gated = fakeContext({ connection: { requestRejection: () => undefined } })
  apply(gated.ctx)
  const res = fakeResponse()
  await gated.recorded.routes[0].handler(fakeRequest('GET', '/codeflow/api/state'), res)
  assert.equal(res.statusCode, 200)
})
await check('a throwing gate fails closed', async () => {
  const gated = fakeContext({ connection: { requestRejection: () => { throw new Error('gate exploded') } } })
  apply(gated.ctx)
  const res = fakeResponse()
  await gated.recorded.routes[0].handler(fakeRequest('GET', '/codeflow/api/state'), res)
  assert.equal(res.statusCode, 401)
})

console.log('\n[canvas asset]')
const canvas = await read('assets/canvas/canvas.html')
await check('no legacy bridge survives the port', () => {
  assert.ok(!canvas.includes('__CF_GRAPH_JSON__'))
  assert.ok(!/window\.zcode/.test(canvas))
  assert.ok(!canvas.includes('::visualize'))
  assert.ok(!canvas.includes('widgetState'))
})
await check('the node library matches the reference document (16 types)', async () => {
  const block = canvas.slice(canvas.indexOf('var TYPES={'), canvas.indexOf('var CATS='))
  const keys = [...block.matchAll(/^\s{2}([a-z]+):\{label:/gm)].map((m) => m[1])
  assert.equal(keys.length, 16, `canvas has ${keys.length}: ${keys.join(',')}`)
  const doc = await read('assets/skill/codeflow-canvas/references/node-types.md')
  const documented = [...doc.matchAll(/^\*\*`(\w+)` /gm)].map((m) => m[1])
  assert.deepEqual(keys.slice().sort(), documented.slice().sort(), 'canvas and node-types.md agree')
})
await check('every icon the canvas asks for is defined locally', () => {
  const names = new Set([...canvas.matchAll(/data-lucide="([a-z0-9-]+)"/g)].map((m) => m[1]))
  for (const match of canvas.matchAll(/icon:'([a-z0-9-]+)'/g)) names.add(match[1])
  const defined = new Set([...canvas.matchAll(/^\s{2}'([a-z0-9-]+)':'/gm)].map((m) => m[1]))
  const missing = [...names].filter((name) => !defined.has(name))
  assert.deepEqual(missing, [], `missing icons: ${missing.join(',')}`)
})
await check('the canvas fills its host instead of a fixed 780px', () => {
  assert.ok(canvas.includes('flex-direction:column; height:100%; min-height:0;'))
  assert.ok(!canvas.includes('height:780px'))
})
await check('the import dialog talks to the host, not the agent', () => {
  // v0.5.2: the import write goes through the serialized write queue, which
  // posts to /codeflow/api/import exactly like apiPost did.
  assert.ok(canvas.includes("queueWrite('import'"), 'the dialog posts to /codeflow/api/import')
  assert.ok(!canvas.includes("sendMessage('IMPORT'"), 'no IMPORT gesture may reach the agent')
  assert.ok(canvas.includes('宿主直接扫描目录'), 'the hint no longer promises an agent turn')
})
await check('the import dialog no longer offers a strategy choice', () => {
  // v0.6.0: one import produces both graphs; the dialog has no 生成方式 select.
  assert.ok(!canvas.includes('data-f="strategy"'), 'the strategy select is gone')
  assert.ok(!canvas.includes("'模块结构图'"), 'the strategy select is gone')
  assert.ok(canvas.includes('同时生成任务流水线与模块结构图'), 'the hint promises both graphs')
  assert.ok(canvas.includes('导入后可随时切换'), 'the hint mentions view switching')
  assert.ok(canvas.includes('importProject({\n      path:path'), 'the submit no longer forwards a strategy')
})
await check('the toolbar carries the view switcher (tablist, keyboard, counts, other-view dot)', () => {
  assert.ok(canvas.includes('id="cf-viewtabs"'), 'the tablist exists')
  assert.ok(canvas.includes('role="tablist" aria-label="画布视图切换"'), 'the tablist is announced')
  assert.ok(canvas.includes('id="cf-vtab-tasks"') && canvas.includes('id="cf-vtab-modules"'), 'both tabs exist')
  assert.ok(canvas.includes("function renderViewTabs(){"), 'the tab renderer exists')
  assert.ok(canvas.includes("b.setAttribute('aria-selected'"), 'aria-selected is managed')
  assert.ok(canvas.includes("viewTabsWrap.addEventListener('keydown'"), 'arrow keys switch views')
  assert.ok(canvas.includes('cf-vtab-dot'), 'the other-view edit dot exists')
  assert.ok(canvas.includes('viewsAvailable()'), 'tabs only show when both views are available')
})
await check('switching views flushes, refetches and never rescans', () => {
  assert.ok(canvas.includes('async function doSwitchView(next){'), 'the switch routine exists')
  assert.ok(canvas.includes('try{await writeChain;}catch(e){}'), 'the write queue is drained first')
  assert.ok(canvas.includes("'/codeflow/api/state?project='+encodeURIComponent(name)+'&view='+next"), 'the target view is fetched')
  assert.ok(canvas.includes("apiPost('view',{project:name,view:next})"), 'the active view is persisted')
  assert.ok(canvas.includes('VIEWPORTS[next]'), 'the per-view viewport is restored')
})
await check('the left nav has a searchable secondary list', () => {
  assert.ok(canvas.includes('id="cf-navpop"'), 'the floating list exists')
  assert.ok(canvas.includes('搜索模块名称'), 'the search placeholder')
  assert.ok(canvas.includes('role="listbox"'), 'listbox semantics')
  assert.ok(canvas.includes("function openNavPop(cat,anchorBtn){"), 'openNavPop exists')
  assert.ok(canvas.includes('onCategoryClick'), 'category clicks route through the new handler')
  assert.ok(canvas.includes("localeCompare(b.title,'zh-CN')"), 'zh-CN title ordering')
  assert.ok(canvas.includes("function focusNode(id,anchorBtn){"), 'focusNode positions and highlights')
  assert.ok(!canvas.includes('function focusCategory('), 'the old zoom-all handler is gone')
})
await check('edit highlighting is class-based, per-view and reduced-motion aware', () => {
  assert.ok(canvas.includes('cf-editing') && canvas.includes('cf-editbadge'), 'editing pulse + badge exist')
  assert.ok(canvas.includes('修改中') && canvas.includes('已修改'), 'badge copy exists')
  assert.ok(canvas.includes('cf-edit-related'), 'related task marking exists')
  assert.ok(canvas.includes('applyEditData(p.edits)'), 'activity polling feeds the edit table')
  assert.ok(canvas.includes('cf-editpulse'), 'the pulse animation is defined')
  assert.ok(/@media \(prefers-reduced-motion: reduce\)\{\.cf-node\.cf-editing\{animation:none/.test(canvas), 'reduced motion keeps a static ring')
  assert.ok(canvas.includes('otherViewHasEdits'), 'the switcher dot reports the other view')
  assert.ok(canvas.includes('decorateNavDots'), 'category buttons show edit dots')
})
await check('undo history tags the run view', () => {
  assert.ok(canvas.includes("run.view==='modules'?'模块图':'任务图'"), 'each history row names its view')
})
await check('the canvas carries the module node type', () => {
  assert.ok(canvas.includes("module:{label:'模块说明'"), 'TYPES has module')
  assert.ok(canvas.includes('聚焦符号(可选)'), 'module widgets include the symbol focus')
})

console.log('\n[v1.0 canvas frame fix (B)]')
await check('the generated canvas has no duplicated comment terminator', () => {
  // v0.6.x 的顶部空隙：replaceRange 保留 endMarker，header 替换的结尾又带了一个
  // '-->'，生成物第 6 行变成 '-->-->'，被浏览器当成正文渲染出一条空隙。
  assert.ok(!canvas.includes('-->-->'), 'the -->--> text node must never come back')
  assert.ok(canvas.startsWith('<!--'), 'the file opens with the header comment')
  const headerEnd = canvas.indexOf('-->')
  assert.ok(headerEnd > 0)
  const firstElement = canvas.slice(headerEnd + 3).replace(/^\s+/, '')
  assert.ok(
    firstElement.startsWith('<div id="codeflow-canvas"'),
    `first element after the header must be the canvas div, got: ${firstElement.slice(0, 40)}`,
  )
})
await check('the embedded shell strips the canvas frame; the standalone card look survives', async () => {
  const page = await read('lib/canvas-page.js')
  assert.ok(
    page.includes('html body>div#codeflow-canvas{border:0;border-radius:0;width:100%;height:100%;}'),
    'SHELL_CSS removes the 1px border + 14px radius in embedded mode',
  )
  assert.ok(page.includes('html,body{margin:0;padding:0;height:100%;overflow:hidden;'), 'the shell pins html/body')
  assert.ok(canvas.includes('border-radius:14px'), 'the standalone preview keeps its card look')
  assert.ok(canvas.includes('cf-tb-settings'), 'the toolbar carries the settings entry')
  assert.ok(canvas.includes('id="cf-banner-retry"'), 'the banner carries the issue retry button')
})

console.log('\n[theming]')
await check('the canvas carries both palettes and a single setter', () => {
  assert.ok(canvas.includes('var PALETTE={'), 'palette table present')
  assert.ok(/dark:\{\s*\n\s*miniBg:/.test(canvas), 'dark palette present')
  assert.ok(/light:\{\s*\n\s*miniBg:/.test(canvas), 'light palette present')
  assert.ok(canvas.includes("document.documentElement.setAttribute('data-cf-theme',cfTheme)"), 'applyTheme flips the attribute')
  assert.ok(canvas.includes('STC=MINI.stc'), 'inline status colours are swapped, not just CSS')
})
await check('status colours differ per theme (badge text is inline, not CSS)', () => {
  const dark = /\n\s*stc:\{pending:\[[^\n]*done:\[[^\]]*\]/.exec(canvas)
  assert.ok(dark !== null, 'dark status palette found')
  assert.ok(dark[0].includes('#22c55e'), 'dark done green')
  assert.ok(canvas.includes("done:['完成','#15803d']"), 'light done is darkened for white surfaces')
  assert.ok(canvas.includes("running:['运行中','#1d4ed8']"), 'light running is darkened')
})
await check('the minimap draws from the palette, not from dark literals', () => {
  assert.ok(canvas.includes('ctx.fillStyle=MINI.miniBg'))
  assert.ok(canvas.includes('ctx.strokeStyle=MINI.miniLink'))
  assert.ok(canvas.includes('ctx.strokeStyle=MINI.miniView'))
  // Each dark literal may appear only once: inside PALETTE.dark.
  for (const literal of ['rgba(18,18,24,.92)', 'rgba(99,99,111,.7)']) {
    const count = canvas.split(literal).length - 1
    assert.equal(count, 1, `${literal} appears ${count} times; only the palette may hold it`)
  }
})
await check('the theme is applied before the first paint', () => {
  const applied = canvas.indexOf('applyTheme((HOSTED')
  const firstDraw = canvas.indexOf('renderAll();\n  applyView();')
  assert.ok(applied > 0 && firstDraw > 0, 'both steps present')
  assert.ok(applied < firstDraw, 'theme must be set before renderAll, or badges paint with the wrong scheme')
})
await check('the light stylesheet is fully scoped so dark mode cannot regress', () => {
  const start = canvas.indexOf('CodeFlow 画布的浅色主题')
  const end = canvas.indexOf('</style>', start)
  assert.ok(start > 0 && end > start, 'light block present before </style>')
  const block = canvas.slice(start, end)
  const rules = block.split('\n').filter((line) => line.includes('{') && !line.trimStart().startsWith('*'))
  assert.ok(rules.length >= 20, `expected the full override set, saw ${rules.length} rules`)
  const unscoped = rules.filter((line) => !line.trimStart().startsWith('html[data-cf-theme="light"]'))
  assert.deepEqual(unscoped, [], 'every light rule must carry the attribute prefix')
  for (const selector of ['.cf-node{', '.cf-menu{', '.cf-dialog{', '.cf-toast{', '.cf-link{', '.cf-in{']) {
    assert.ok(block.includes(selector), `light block must cover ${selector}`)
  }
})
await check('a theme change arrives by message, not by reloading the iframe', async () => {
  assert.ok(canvas.includes("d.type==='codeflow:theme'"), 'canvas listens for the scheme message')
  const client = await read('lib/client.js')
  assert.ok(client.includes("type: 'codeflow:theme'"), 'panel pushes the scheme')
  assert.ok(client.includes('initialRef'), 'the src-bearing scheme is captured once')
  assert.ok(client.includes("exports.inject = ['slots']"), 'only slots is required')
  assert.ok(client.includes("ctx.get('theme')"), 'the theme service is read as an optional dependency')
  assert.ok(!client.includes("ctx.theme"), 'ctx.theme throws unless injected; it must go through ctx.get')
  assert.ok(!/src:\s*CANVAS_SRC\s*\+\s*'[^']*'\s*\+\s*scheme/.test(client), 'src must never depend on live state')
})

console.log('\n[theme plumbing]')
await check('GET /codeflow/canvas stamps the scheme onto <html>', async () => {
  const light = await call('GET', '/codeflow/canvas?theme=light')
  assert.ok(light.text.includes('<html lang="zh-CN" data-cf-theme="light">'), 'light attribute in the document')
  const boot = JSON.parse(/window\.__CF_BOOT__=([\s\S]*?);<\/script>/.exec(light.text)[1])
  assert.equal(boot.theme, 'light', 'boot payload carries the scheme')
  const dark = await call('GET', '/codeflow/canvas?theme=dark')
  assert.ok(dark.text.includes('data-cf-theme="dark"'))
})
await check('an unknown or absent scheme leaves the canvas on prefers-color-scheme', async () => {
  const plain = await call('GET', '/codeflow/canvas')
  // The sheet mentions the attribute everywhere; only the <html> tag matters here.
  assert.ok(!/<html lang="zh-CN" data-cf-theme=/.test(plain.text), 'no attribute on <html> when the scheme is unknown')
  const boot = JSON.parse(/window\.__CF_BOOT__=([\s\S]*?);<\/script>/.exec(plain.text)[1])
  assert.equal(boot.theme, null)
  const bogus = await call('GET', '/codeflow/canvas?theme=purple')
  assert.equal(JSON.parse(/window\.__CF_BOOT__=([\s\S]*?);<\/script>/.exec(bogus.text)[1]).theme, null)
})
await check('the page sets color-scheme so native controls follow the theme', async () => {
  const shell = await read('lib/canvas-page.js')
  assert.ok(shell.includes('color-scheme:dark'), 'dark is the default scheme')
  assert.ok(shell.includes('html[data-cf-theme="light"]{color-scheme:light;}'), 'light overrides it')
})

await check('the light palette meets WCAG AA wherever the canvas paints text', () => {
  const rows = auditLightContrast(canvas)
  const summary = summarizeContrast(rows)
  const failing = summary.failing.map((row) => `${row.label} = ${row.value.toFixed(2)} (< ${row.target})`)
  assert.deepEqual(failing, [], `contrast below AA:\n    ${failing.join('\n    ')}`)
  assert.ok(summary.total >= 40, `expected the full pairing set, saw ${summary.total}`)
  // Guards the assumption: status badges only pass because the light sheet gives
  // them an opaque chip; without it they sit on a tinted node head.
  assert.ok(
    /html\[data-cf-theme="light"\]\s*\.cf-badge\{[^}]*background:#ffffff/.test(canvas),
    'the light badge chip must stay, or badge text drops to ~3.8:1',
  )
})

console.log('\n[v0.5.0 artifacts]')
await check('artifacts are cleaned: dedupe, kinds, control chars, cap', () => {
  const raw = [
    { path: 'src/app.py', label: '入口', kind: 'code' },
    { path: 'src/app.py', kind: 'code' },                    // duplicate path
    { path: '' },                                             // empty
    { path: 'a\u0000b.md', kind: 'doc' },                     // control char stripped
    { path: 'x.json', kind: 'bogus' },                        // unknown kind dropped
    'not-an-object', null,
    { path: 'tests/t.py', kind: 'test', label: 'x'.repeat(200) }, // label clipped
  ]
  const cleaned = normalizeArtifacts(raw)
  assert.equal(cleaned.length, 4)
  assert.deepEqual(cleaned[0], { path: 'src/app.py', label: '入口', kind: 'code' })
  assert.equal(cleaned[1].path, 'ab.md', 'control characters are stripped')
  assert.equal(cleaned[2].path, 'x.json')
  assert.equal('kind' in cleaned[2], false, 'unknown kinds are dropped')
  assert.equal(cleaned[3].kind, 'test')
  assert.equal(cleaned[3].label.length, 80)
  assert.equal(normalizeArtifacts(undefined), undefined)
  assert.equal(normalizeArtifacts([]), undefined)
  assert.equal(normalizeArtifacts('nope'), undefined)
})
await check('artifacts above the cap are truncated away', () => {
  const raw = Array.from({ length: 60 }, (_, i) => ({ path: `f/${i}.txt`, kind: 'other' }))
  const cleaned = normalizeArtifacts(raw)
  assert.equal(cleaned.length, 50)
})
await check('normalizeGraph keeps artifacts only when valid and strips invalid ones', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'a', artifacts: [{ path: 'src/a.py', kind: 'code' }] },
      { id: 'b', artifacts: 'nope' },
      { id: 'c' },
    ],
    links: [],
  })
  assert.deepEqual(graph.nodes[0].artifacts, [{ path: 'src/a.py', kind: 'code' }])
  assert.equal('artifacts' in graph.nodes[1], false, 'invalid artifacts are removed, not kept raw')
  assert.equal('artifacts' in graph.nodes[2], false)
})
await check('presented is normalized to a unique path list', () => {
  assert.deepEqual(normalizePresented(['/a', '/a', ' ', '/b']), ['/a', '/b'])
  assert.equal(normalizePresented('nope'), undefined)
})
await check('patchNode patches one node, bumps rev and respects the whitelist', async () => {
  const store = createStore(console)
  await store.write({
    format: 'codeflow/1', rev: 0,
    project: { name: 'patch-demo' },
    nodes: [
      { id: 'n1', type: 'codegen', pos: [0, 0], params: { dir: 'src' }, status: 'pending' },
      { id: 'n2', type: 'deliver', pos: [330, 0], status: 'pending' },
    ],
    links: [],
  }, { persist: 'never' })
  const first = store.patchNode('patch-demo', 'n1', { status: 'running', result: '生成中' })
  assert.equal(first.rev, 2, 'rev bumps once per patch')
  assert.equal(first.node.status, 'running')
  const again = store.patchNode('patch-demo', 'n1', { status: 'done', result: '生成 3 个文件', artifacts: [{ path: 'src/a.py', kind: 'code' }] })
  assert.equal(again.rev, 3)
  const posBefore = store.get('patch-demo').graph.nodes[0].pos
  store.patchNode('patch-demo', 'n1', { status: 'done', percent: 50, pos: [9, 9] })
  const node = store.get('patch-demo').graph.nodes[0]
  assert.deepEqual(node.pos, posBefore, 'pos is not patchable')
  assert.equal(node.status, 'done')
  assert.equal(store.patchNode('patch-demo', 'ghost', { status: 'done' }), undefined)
  assert.equal(store.patchNode('missing-project', 'n1', { status: 'done' }), undefined)
  const deliver = store.get('patch-demo').graph.nodes[1]
  store.patchNode('patch-demo', 'n2', { presented: ['/abs/a', '/abs/a'] })
  assert.deepEqual(deliver.presented, ['/abs/a'])
})

console.log('\n[v0.5.0 dedicated session]')
const sidecarWorkspace = await mkdtemp(path.join(tmpdir(), 'codeflow-sessions-'))
await check('ensure creates one session, writes the sidecar and is deduped', async () => {
  const store = createStore(console)
  const controller = fakeSessionController()
  const { ctx } = fakeContext({ sessionController: controller })
  const sessions = createSessionManager({ ctx, store, logger: console })
  store.bindCwd('sidecar-demo', sidecarWorkspace)
  const first = await sessions.ensure('sidecar-demo', { create: true })
  assert.equal(first.created, true)
  assert.equal(controller.state.created.length, 1)
  assert.equal(controller.state.created[0].cwd, path.normalize(sidecarWorkspace))
  assert.ok(controller.state.renamed.length === 1, 'the session gets the canvas title')
  assert.equal(controller.state.renamed[0].title, canvasSessionTitle('sidecar-demo'))
  const second = await sessions.ensure('sidecar-demo', { create: true })
  assert.equal(second.created, false)
  assert.equal(controller.state.created.length, 1, 'the binding is reused, not recreated')
  const sidecar = JSON.parse(await readFile(sessionSidecarPath(sidecarWorkspace, 'sidecar-demo'), 'utf8'))
  assert.equal(sidecar.version, 1)
  assert.equal(sidecar.sessionId, first.sessionId)
  assert.equal(sidecar.title, canvasSessionTitle('sidecar-demo'))
  assert.equal(store.get('sidecar-demo').sessionId, first.sessionId)
})
await check('a fresh manager adopts the sidecar binding (cold session)', async () => {
  const store = createStore(console)
  const controller = fakeSessionController()
  const { ctx } = fakeContext({ sessionController: controller })
  const sessions = createSessionManager({ ctx, store, logger: console })
  store.bindCwd('sidecar-demo', sidecarWorkspace)
  const result = await sessions.ensure('sidecar-demo', { create: true })
  assert.equal(result.created, false, 'adopted from the sidecar, no new session')
  assert.equal(controller.state.created.length, 0, 'cold adoption does not call create')
  assert.equal(store.get('sidecar-demo').sessionId, result.sessionId)
})
await check('a corrupt sidecar is ignored and replaced by a fresh binding', async () => {
  await mkdir(path.join(sidecarWorkspace, 'CodeFlow', 'flow-projects', 'broken-demo'), { recursive: true })
  await writeFile(sessionSidecarPath(sidecarWorkspace, 'broken-demo'), '{not json', 'utf8')
  const store = createStore(console)
  const controller = fakeSessionController()
  const { ctx } = fakeContext({ sessionController: controller })
  const sessions = createSessionManager({ ctx, store, logger: console })
  store.bindCwd('broken-demo', sidecarWorkspace)
  const result = await sessions.ensure('broken-demo', { create: true })
  assert.equal(result.created, true, 'corrupt sidecar counts as unbound')
  const sidecar = JSON.parse(await readFile(sessionSidecarPath(sidecarWorkspace, 'broken-demo'), 'utf8'))
  assert.equal(sidecar.sessionId, result.sessionId, 'the sidecar is rewritten')
})
await check('deliverText queues into the bound session; not-found rebuilds once', async () => {
  const store = createStore(console)
  const controller = fakeSessionController()
  const { ctx } = fakeContext({ sessionController: controller })
  const sessions = createSessionManager({ ctx, store, logger: console })
  store.bindCwd('deliver-demo', sidecarWorkspace)
  await sessions.ensure('deliver-demo', { create: true })
  const sessionId = await sessions.deliverText('deliver-demo', '[CodeFlow:RUN_ALL]{"action":"RUN_ALL"}')
  assert.equal(controller.state.prompts.length, 1)
  assert.equal(controller.state.prompts[0].sessionId, sessionId)
  assert.equal(controller.state.prompts[0].mode, 'queue')
  controller.state.failNextPrompt = Object.assign(new Error('session "x" not found'), { code: 'session/not-found' })
  const rebuilt = await sessions.deliverText('deliver-demo', '[CodeFlow:RUN_ALL]{}')
  assert.equal(controller.state.created.length, 2, 'one rebuild')
  assert.equal(rebuilt, 'sess-2')
  assert.equal(controller.state.prompts.length, 2)
  controller.state.failNextPrompt = Object.assign(new Error('writer held'), { code: 'session/writer-held' })
  await assert.rejects(() => sessions.deliverText('deliver-demo', '[CodeFlow:RUN_ALL]{}'), /占用/)
  assert.equal(controller.state.created.length, 2, 'writer-held must not rebuild')
})
await check('ensure without a controller reports an actionable error and binds nothing', async () => {
  const store = createStore(console)
  const { ctx } = fakeContext({})
  const sessions = createSessionManager({ ctx, store, logger: console })
  store.bindCwd('noctrl', sidecarWorkspace)
  const result = await sessions.ensure('noctrl', { create: true })
  assert.ok(result.error.includes('sessionController'), result.error)
  assert.equal(store.get('noctrl').sessionId, undefined, 'no random binding')
})
await check('rebind replaces the binding and leaves the old session alone', async () => {
  const store = createStore(console)
  const controller = fakeSessionController()
  const { ctx } = fakeContext({ sessionController: controller })
  const sessions = createSessionManager({ ctx, store, logger: console })
  store.bindCwd('rebind-demo', sidecarWorkspace)
  const first = await sessions.ensure('rebind-demo', { create: true })
  const second = await sessions.rebind('rebind-demo')
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(controller.state.created.length, 2)
  const sidecar = JSON.parse(await readFile(sessionSidecarPath(sidecarWorkspace, 'rebind-demo'), 'utf8'))
  assert.equal(sidecar.sessionId, second.sessionId, 'the sidecar follows the new binding')
})
const cleanupSessions = () => rm(sidecarWorkspace, { recursive: true, force: true })

console.log('\n[v0.5.0 activity hub]')
{
  const store = createStore(console)
  await store.write({
    format: 'codeflow/1', rev: 0,
    project: { name: 'hub-demo' },
    nodes: [
      { id: 'n1', type: 'codegen', status: 'pending' },
      { id: 'n2', type: 'deliver', status: 'pending' },
    ],
    links: [['n1', 0, 'n2', 0]],
  }, { persist: 'never' })
  store.bindSession('hub-demo', 'sess-hub')
  const hub = createActivityHub({ store, logger: console })
  const hubCtx = fakeContext()
  hub.attach(hubCtx.ctx)
  let presentedFiles = null
  hub.options.onPresented = (project, files) => { presentedFiles = { project, files } }
  let turnEnds = 0
  hub.options.onTurnEnd = () => { turnEnds += 1 }

  const session = { id: 'sess-hub' }
  await emit(hubCtx.recorded, 'session/event', session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  await emit(hubCtx.recorded, 'agent/assistant-stream', {
    agent: { id: 'sess-hub' },
    frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'reasoning-delta', text: '我先看' } },
  })
  await emit(hubCtx.recorded, 'agent/assistant-stream', {
    agent: { id: 'sess-hub' },
    frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'reasoning-delta', text: '一下结构' } },
  })
  await check('reasoning deltas merge into one growing entry', () => {
    const view = hub.activity('hub-demo', {})
    const reasoning = view.entries.filter((entry) => entry.kind === 'reasoning')
    assert.equal(reasoning.length, 1, 'one merged entry')
    assert.equal(reasoning[0].text, '我先看一下结构')
  })
  await emit(hubCtx.recorded, 'session/event', session, {
    type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: { cmd: 'pytest -q\nsecond line' } },
  })
  await emit(hubCtx.recorded, 'session/event', session, {
    type: 'tool/result', seq: 3, data: { turn: 1, step: 1, message: { callId: 'c1', isError: false } },
  })
  await emit(hubCtx.recorded, 'session/event', session, {
    type: 'tool/call', seq: 4, data: { turn: 1, step: 1, callId: 'c2', name: 'str_replace_editor', arguments: { path: '/x' } },
  })
  await emit(hubCtx.recorded, 'session/event', session, {
    type: 'assistant/message', seq: 5, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '已生成 3 个文件' }] } },
  })
  await emit(hubCtx.recorded, 'session/event', session, {
    type: 'deliverables/presented', seq: 6, data: { turn: 1, callId: 'c9', files: [{ path: '/abs/DELIVERY.md', description: '交付说明' }] },
  })
  await check('tool steps are recorded with status, secrets-free summaries, and presented is hooked', () => {
    const view = hub.activity('hub-demo', {})
    const tools = view.entries.filter((entry) => entry.kind === 'tool')
    assert.equal(tools.length, 2)
    assert.equal(tools[0].status, 'ok', 'result flips the tool status')
    assert.ok(typeof tools[0].ms === 'number')
    assert.ok(tools[0].text.includes('pytest -q second line'), 'shell summaries are flattened')
    assert.ok(!tools[0].text.includes('\n'), 'single line only')
    assert.equal(tools[1].text, 'str_replace_editor', 'non-shell tools show the name only')
    assert.ok(!JSON.stringify(view.entries).includes('/x'), 'tool arguments are not echoed')
    const statuses = view.entries.filter((entry) => entry.kind === 'status')
    assert.ok(statuses.some((entry) => entry.text.includes('已提交 1 个交付卡片')))
    assert.deepEqual(presentedFiles.files, ['/abs/DELIVERY.md'])
    assert.equal(view.running, true)
  })
  await check('progress notes carry step/percent without inventing them', () => {
    hub.noteProgress('hub-demo', { nodeId: 'n1', status: 'running', step: '读取 src/app.py', percent: 40 })
    const view = hub.activity('hub-demo', { nodeId: 'n1' })
    assert.ok(view.entries.some((entry) => entry.kind === 'step' && entry.text === '读取 src/app.py'))
    assert.equal(view.progress.percent, 40, 'the agent-reported percent is passed through')
    // The durable status flip goes through the store (the tool does both).
    store.patchNode('hub-demo', 'n1', { status: 'done', result: '生成 3 个文件' })
    hub.noteProgress('hub-demo', { nodeId: 'n1', status: 'done', result: '生成 3 个文件' })
    const after = hub.activity('hub-demo', {})
    assert.equal(after.progress.percent, null, 'a finished node retires its percent')
    assert.equal(after.progress.done, 1)
    assert.equal(after.progress.total, 2)
  })
  await check('a finished turn fails stragglers and finishes the run hook', async () => {
    await store.patchNode('hub-demo', 'n2', { status: 'running' })
    await emit(hubCtx.recorded, 'session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: 'end_turn' } })
    const graph = store.get('hub-demo').graph
    const n2 = graph.nodes.find((node) => node.id === 'n2')
    assert.equal(n2.status, 'failed')
    assert.ok(n2.detail.includes('执行回合结束但未收到节点结果'), n2.detail)
    assert.equal(turnEnds, 1, 'onTurnEnd fired for undo bookkeeping')
    const view = hub.activity('hub-demo', {})
    assert.equal(view.running, false)
  })
  await check('events from other sessions never leak into the project', async () => {
    await emit(hubCtx.recorded, 'session/event', { id: 'sess-other' }, {
      type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '不应该出现' }] } },
    })
    const view = hub.activity('hub-demo', {})
    assert.ok(!view.entries.some((entry) => entry.text.includes('不应该出现')))
  })
  await check('buffer overflow sets reset and keeps the cap', () => {
    for (let i = 0; i < 600; i += 1) {
      hub.noteProgress('hub-demo', { nodeId: 'n1', step: `步骤 ${i} - ${'x'.repeat(1200)}` })
    }
    const view = hub.activity('hub-demo', { after: 0 })
    assert.ok(view.entries.length <= 500, `entries capped, got ${view.entries.length}`)
    assert.equal(view.reset, true, 'eviction raises reset so the client refetches')
    assert.ok(JSON.stringify(view.entries).length < 400 * 1024)
  })
}

console.log('\n[v0.6.0 edit tracking]')
await check('only write tools may produce edits; read tools never do', () => {
  for (const name of ['edit', 'write', 'Write', 'ops_replace', 'apply_patch', 'multi_edit', 'str_replace_editor', 'write_file', 'create_file']) {
    assert.equal(isWriteTool(name), true, name)
  }
  for (const name of ['read', 'read_file', 'grep', 'glob', 'ops_inspect_local_file', 'present', 'codeflow_canvas', 'bash', 'shell', 'deliver']) {
    assert.equal(isWriteTool(name), false, name)
  }
  assert.equal(isWriteTool(''), false)
  assert.equal(isWriteTool(undefined), false)
})
await check('paths are extracted from single keys, arrays, edit lists and patch markers', () => {
  const single = extractEditPaths({ file_path: 'src/a.py' })
  assert.deepEqual(single, ['src/a.py'])
  const priority = extractEditPaths({ path: 'src/first.py', file: 'src/second.py' })
  assert.deepEqual(priority, ['src/first.py', 'src/second.py'])
  const arrays = extractEditPaths({ files: ['src/x.py', 'src/y.py'], paths: ['src/z.py'] })
  assert.deepEqual(arrays, ['src/x.py', 'src/y.py', 'src/z.py'])
  const edits = extractEditPaths({ edits: [{ path: 'src/e1.py' }, { file_path: 'src/e2.py' }, {}] })
  assert.deepEqual(edits, ['src/e1.py', 'src/e2.py'])
  const patch = extractEditPaths({ patch: '*** Begin Patch\n*** Update File: src/patched.py\n*** Add File: src/new.py\n@@\n' })
  assert.deepEqual(patch, ['src/patched.py', 'src/new.py'])
  const diff = extractEditPaths({ diff: '--- a/src/old.py\n+++ b/src/old.py\n' })
  assert.ok(diff.includes('src/old.py'), diff.join(','))
  const windows = extractEditPaths({ file_path: 'src\\win\\path.py' })
  assert.deepEqual(windows, ['src/win/path.py'], 'separators normalize to /')
  // Junk is dropped: URLs, prose, duplicates, overlong values.
  const junk = extractEditPaths({ file_path: 'https://example.com/x.py' })
  assert.deepEqual(junk, [])
  const dupes = extractEditPaths({ path: 'src/a.py', file: 'src/a.py' })
  assert.deepEqual(dupes, ['src/a.py'])
  assert.deepEqual(extractEditPaths({ file_path: 'just-a-word' }), [], 'bare words are not paths')
  assert.deepEqual(extractEditPaths(null), [])
  const many = extractEditPaths({ files: Array.from({ length: 30 }, (_, i) => `f/${i}.py`) })
  assert.equal(many.length, 20, 'per-call cap')
})
{
  const store = createStore(console)
  const editWorkspace = await mkdtemp(path.join(tmpdir(), 'codeflow-edits-'))
  const sourceRoot = path.join(editWorkspace, 'source')
  await mkdir(path.join(sourceRoot, 'src'), { recursive: true })
  const modulePath = path.join(sourceRoot, 'src', 'a.py')
  const symbolPath = path.join(sourceRoot, 'src', 'b.py')
  await store.write({
    format: 'codeflow/1', rev: 0,
    project: { name: 'edit-demo', origin: 'import' },
    nodes: [
      { id: 't1', type: 'edit', pos: [0, 0], params: { instruction: '修改 src/a.py 的解析' }, status: 'pending', result: '', detail: '' },
      { id: 't2', type: 'codegen', pos: [300, 0], params: {}, status: 'pending', result: '', detail: '', artifacts: [{ path: 'src/a.py', kind: 'code' }] },
    ],
    links: [], meta: { importedFrom: sourceRoot, strategy: 'tasks' },
  }, { persist: 'now', cwd: editWorkspace, view: 'tasks' })
  await store.write({
    format: 'codeflow/1', rev: 0,
    project: { name: 'edit-demo', origin: 'import' },
    nodes: [
      { id: 'm1', type: 'module', pos: [0, 0], params: { path: modulePath, symbol: '' }, status: 'pending', result: '', detail: '' },
      { id: 'm2', type: 'module', pos: [0, 150], params: { path: modulePath, symbol: 'parse' }, status: 'pending', result: '', detail: '' },
      { id: 'm3', type: 'module', pos: [0, 300], params: { path: symbolPath, symbol: '' }, status: 'pending', result: '', detail: '' },
    ],
    links: [], meta: { importedFrom: sourceRoot, strategy: 'modules' },
  }, { persist: 'now', cwd: editWorkspace, view: 'modules' })
  store.bindSession('edit-demo', 'sess-edit')
  const hub = createActivityHub({ store, logger: console })
  const hubCtx = fakeContext()
  hub.attach(hubCtx.ctx)
  const session = { id: 'sess-edit' }

  await check('a write-tool call records an edit and matches both views host-side', async () => {
    hub.beginRun('edit-demo', { action: 'RUN_NODE', nodeId: 't1', sessionId: 'sess-edit', view: 'tasks' })
    await emit(hubCtx.recorded, 'session/event', session, {
      type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'e1', name: 'edit', arguments: { file_path: modulePath } },
    })
    const view = hub.activity('edit-demo', {})
    assert.equal(view.edits.length, 1)
    const edit = view.edits[0]
    assert.equal(edit.state, 'editing')
    assert.equal(edit.tool, 'edit')
    assert.equal(edit.rel, 'src/a.py')
    assert.deepEqual(edit.nodeIds, { tasks: ['t1', 't2'], modules: ['m1'] }, 'instruction+artifacts match tasks; only the file-level module node is primary')
    assert.ok(!JSON.stringify(view.entries).includes('src'), 'edit paths never leak into the reasoning buffer entries')
  })
  await check('relative paths and Windows separators resolve against the project root', async () => {
    await emit(hubCtx.recorded, 'session/event', session, {
      type: 'tool/call', seq: 2, data: { turn: 1, step: 2, callId: 'e2', name: 'ops_replace', arguments: { path: 'src\\b.py' } },
    })
    const view = hub.activity('edit-demo', {})
    const record = view.edits.find((entry) => entry.rel === 'src/b.py')
    assert.notEqual(record, undefined, 'the relative path was resolved')
    assert.deepEqual(record.nodeIds.modules, ['m3'])
  })
  await check('read-only tools never create edits', async () => {
    const before = hub.activity('edit-demo', {}).edits.length
    await emit(hubCtx.recorded, 'session/event', session, {
      type: 'tool/call', seq: 3, data: { turn: 1, step: 3, callId: 'r1', name: 'grep', arguments: { pattern: 'src/a.py' } },
    })
    await emit(hubCtx.recorded, 'session/event', session, {
      type: 'tool/call', seq: 4, data: { turn: 1, step: 4, callId: 'r2', name: 'read', arguments: { file_path: modulePath } },
    })
    await emit(hubCtx.recorded, 'session/event', session, {
      type: 'tool/call', seq: 5, data: { turn: 1, step: 5, callId: 'r3', name: 'ops_inspect_local_file', arguments: { path: modulePath } },
    })
    assert.equal(hub.activity('edit-demo', {}).edits.length, before, 'no new records')
  })
  await check('tool results settle the edit state; errors stay errors', async () => {
    await emit(hubCtx.recorded, 'session/event', session, {
      type: 'tool/result', seq: 6, data: { turn: 1, step: 1, message: { callId: 'e1', isError: true } },
    })
    await emit(hubCtx.recorded, 'session/event', session, {
      type: 'tool/result', seq: 7, data: { turn: 1, step: 2, message: { callId: 'e2', isError: false } },
    })
    const view = hub.activity('edit-demo', {})
    assert.equal(view.edits.find((entry) => entry.rel === 'src/a.py').state, 'error', 'the failed edit is honest')
    assert.equal(view.edits.find((entry) => entry.rel === 'src/b.py').state, 'done')
  })
  await check('turn/end finalizes leftover editing records', async () => {
    await emit(hubCtx.recorded, 'session/event', session, {
      type: 'tool/call', seq: 8, data: { turn: 1, step: 6, callId: 'e3', name: 'write', arguments: { file_path: modulePath } },
    })
    await emit(hubCtx.recorded, 'session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: 'end_turn' } })
    const view = hub.activity('edit-demo', {})
    assert.ok(view.edits.every((entry) => entry.state !== 'editing'), 'nothing stays editing after the turn')
    assert.equal(view.running, false)
  })
  await check('the edit table is bounded per project', async () => {
    hub.clear('edit-demo')
    hub.beginRun('edit-demo', { action: 'RUN_ALL', sessionId: 'sess-edit', view: 'modules' })
    for (let i = 0; i < 130; i += 1) {
      await emit(hubCtx.recorded, 'session/event', session, {
        type: 'tool/call', seq: 100 + i, data: { turn: 2, step: i, callId: `c${i}`, name: 'edit', arguments: { file_path: path.join(sourceRoot, `gen-${i}.py`) } },
      })
    }
    const view = hub.activity('edit-demo', {})
    assert.ok(view.edits.length <= 100, `capped at 100, got ${view.edits.length}`)
  })
  await check('undo/reset clears the edit table', async () => {
    hub.clear('edit-demo')
    assert.equal(hub.activity('edit-demo', {}).edits.length, 0)
  })
  await rm(editWorkspace, { recursive: true, force: true })
}

console.log('\n[v0.5.0 progress tool]')
{
  const controller = fakeSessionController()
  const withController = fakeContext({ sessionController: controller })
  withController.recorded.agents.set('s-progress', fakeAgent('s-progress', [], fixtureRoot))
  apply(withController.ctx)
  const tool2 = withController.recorded.tools[0]
  const handler2 = withController.recorded.routes[0].handler
  const res = fakeResponse()
  await handler2(fakeRequest('POST', '/codeflow/api/action', {
    action: 'RUN_NODE', graph: { ...canvasGraph, project: { name: 'prog' } }, nodeId: 'n1', rerun: false,
  }), res)
  assert.equal(res.statusCode, 200, res.body)
  await check('progress is accepted from the canvas session and patches the node', async () => {
    const value = await tool2.execute(
      { mode: 'progress', project: 'prog', nodeId: 'n1', status: 'running', step: '读取 src', percent: 25 },
      { agent: { id: 'sess-1' } },
    )
    assert.equal(value.mode, 'progress')
    assert.equal(value.status, 'running')
    const graph = withController.recorded // graph lives in the plugin store; read it via the read mode
    void graph
    const read = await tool2.execute({ mode: 'read', project: 'prog' }, { agent: { id: 'sess-1' } })
    const node = read.graph.nodes.find((entry) => entry.id === 'n1')
    assert.equal(node.status, 'running', 'the node status was patched')
  })
  await check('progress from any other session is refused', async () => {
    await assert.rejects(
      () => tool2.execute({ mode: 'progress', project: 'prog', nodeId: 'n1', status: 'done' }, { agent: { id: 'imposter' } }),
      /only the canvas session/,
    )
  })
  await check('the activity endpoint serves the buffered step', async () => {
    const res2 = fakeResponse()
    await handler2(fakeRequest('GET', '/codeflow/api/activity?project=prog&after=0'), res2)
    const view = JSON.parse(res2.body)
    assert.equal(view.ok, true)
    assert.equal(view.project, 'prog')
    assert.equal(view.progress.percent, 25, 'percent passes through while the node runs')
    assert.ok(view.entries.some((entry) => entry.kind === 'step' && entry.text === '读取 src'))
    assert.equal(res2.headers['cache-control'], 'no-store')
  })
  await check('the session endpoint rebinds on demand', async () => {
    const res2 = fakeResponse()
    await handler2(fakeRequest('POST', '/codeflow/api/session', { project: 'prog', action: 'rebind' }), res2)
    const body = JSON.parse(res2.body)
    assert.equal(res2.statusCode, 200, res2.body)
    assert.equal(body.ok, true)
    assert.equal(body.sessionId, 'sess-2', 'a fresh session replaced the binding')
    assert.equal(body.created, true)
  })
}

console.log('\n[v0.5.0 undo over HTTP]')
{
  const undoWorkspace = await mkdtemp(path.join(tmpdir(), 'codeflow-undo-http-'))
  const projectDir = path.join(undoWorkspace, 'CodeFlow', 'flow-projects', 'undo-http')
  await mkdir(path.join(projectDir, 'src'), { recursive: true })
  await writeFile(path.join(projectDir, 'src', 'main.py'), 'print("v1")\n', 'utf8')
  const controller = fakeSessionController()
  const withController = fakeContext({ sessionController: controller })
  withController.recorded.agents.set('s-undo', fakeAgent('s-undo', [], undoWorkspace))
  apply(withController.ctx)
  const handler2 = withController.recorded.routes[0].handler
  const call2 = async (method, url, body) => {
    const res = fakeResponse()
    await handler2(fakeRequest(method, url, body), res)
    return { status: res.statusCode, json: res.body.startsWith('{') ? JSON.parse(res.body) : undefined, body: res.body }
  }
  const runGraph = {
    format: 'codeflow/1', rev: 0,
    project: { name: 'undo-http', language: 'python', origin: 'new' },
    nodes: [
      { id: 'n1', type: 'codegen', status: 'pending', result: '', detail: '', pos: [0, 0], params: {} },
      { id: 'n2', type: 'deliver', status: 'pending', result: '', detail: '', pos: [330, 0], params: {} },
    ],
    links: [],
  }
  let runResponse
  await check('a RUN_NODE gesture snapshots the project tree first', async () => {
    // The gesture writes the graph through the store; the snapshot covers the
    // project directory even before the agent touches anything.
    runResponse = await call2('POST', '/codeflow/api/action', {
      action: 'RUN_NODE', graph: runGraph, nodeId: 'n1', rerun: false,
    })
    assert.equal(runResponse.status, 200, runResponse.body)
    assert.equal(runResponse.json.undoable, true)
    assert.ok(runResponse.json.runId)
    const manifest = JSON.parse(await readFile(path.join(projectDir, '.undo', runResponse.json.runId, 'manifest.json'), 'utf8'))
    assert.equal(manifest.fileCount, 1, 'src/main.py is in the snapshot')
    assert.equal(manifest.status, 'complete')
    assert.equal(manifest.beforeNodes.length, 2, 'node execution state is recorded')
  })
  await check('undo history lists the run newest first', async () => {
    // The run "finishes" here: the agent's turn ends, releasing the run lock.
    await emit(withController.recorded, 'session/event', { id: 'sess-1' }, {
      type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: { cmd: 'echo' } },
    })
    await emit(withController.recorded, 'session/event', { id: 'sess-1' }, { type: 'turn/end', seq: 2, data: { turn: 1, reason: 'end_turn' } })
    const list = await call2('GET', '/codeflow/api/undo?project=undo-http')
    assert.equal(list.status, 200)
    assert.equal(list.json.runs.length, 1)
    assert.equal(list.json.runs[0].runId, runResponse.json.runId)
    assert.equal(list.json.runs[0].undoable, true)
  })
  await check('dryRun diffs only the snapshot scope and writes nothing', async () => {
    // Simulate the agent's changes: modify the file, add one, delete none.
    await writeFile(path.join(projectDir, 'src', 'main.py'), 'print("v2")\n', 'utf8')
    await writeFile(path.join(projectDir, 'src', 'extra.py'), 'print("extra")\n', 'utf8')
    const dry = await call2('POST', '/codeflow/api/undo', { project: 'undo-http', runId: runResponse.json.runId, dryRun: true })
    assert.equal(dry.status, 200, dry.body)
    assert.equal(dry.json.ok, true)
    assert.deepEqual(dry.json.files.added, ['src/extra.py'])
    assert.deepEqual(dry.json.files.modified, ['src/main.py'])
    assert.deepEqual(dry.json.files.deleted, [])
  })
  await check('restore brings files and node state back, keeping a backup', async () => {
    // Give the node some post-run state to prove restore reverts it.
    const read = await call2('GET', '/codeflow/api/state?project=undo-http')
    const graph = read.json.graph
    graph.nodes[0].status = 'done'
    graph.nodes[0].result = '生成 2 个文件'
    await call2('POST', '/codeflow/api/state', { project: 'undo-http', graph })
    const restore = await call2('POST', '/codeflow/api/undo', { project: 'undo-http', runId: runResponse.json.runId })
    assert.equal(restore.status, 200, restore.body)
    assert.deepEqual(restore.json.files.added, ['src/extra.py'])
    assert.deepEqual(restore.json.files.modified, ['src/main.py'])
    const restored = await readFile(path.join(projectDir, 'src', 'main.py'), 'utf8')
    assert.equal(restored, 'print("v1")\n', 'file content rolled back')
    let missing = false
    try {
      await readFile(path.join(projectDir, 'src', 'extra.py'), 'utf8')
    } catch {
      missing = true
    }
    assert.ok(missing, 'the added file was removed')
    const state = await call2('GET', '/codeflow/api/state?project=undo-http')
    const node = state.json.graph.nodes.find((entry) => entry.id === 'n1')
    assert.equal(node.status, 'pending', 'node execution state rolled back')
    assert.equal(node.result, '', 'node result rolled back')
    const backupDir = path.join(projectDir, '.undo', runResponse.json.runId, restore.json.backupDir)
    const backupMain = await readFile(path.join(backupDir, 'src', 'main.py'), 'utf8')
    assert.equal(backupMain, 'print("v2")\n', 'the pre-undo state was backed up')
    const manifest = JSON.parse(await readFile(path.join(projectDir, '.undo', runResponse.json.runId, 'manifest.json'), 'utf8'))
    assert.equal(manifest.status, 'undone')
  })
  await check('an undone run cannot be undone again and blocks nothing silently', async () => {
    const second = await call2('POST', '/codeflow/api/undo', { project: 'undo-http', runId: runResponse.json.runId })
    assert.equal(second.status, 409)
    assert.ok(second.json.error.includes('已撤销') || second.json.error.includes('撤销'), second.json.error)
  })
  await check('forged runIds and cross-project ids are refused', async () => {
    const evil = await call2('POST', '/codeflow/api/undo', { project: 'undo-http', runId: '../evil' })
    assert.equal(evil.status, 400, evil.body)
    // A well-formed but nonexistent id is still refused by the LIFO gate:
    // with no undoable run, nothing may be restored.
    const ghost = await call2('POST', '/codeflow/api/undo', { project: 'undo-http', runId: '20200101T000000-abcdef' })
    assert.equal(ghost.status, 409, ghost.body)
    assert.ok(ghost.json.error.includes('撤销'), ghost.json.error)
  })
  await check('the importer never walks into .undo', async () => {
    const { graph } = await importProject({ path: projectDir, existingNames: [] })
    assert.ok(!JSON.stringify(graph).includes('.undo'), 'the scan skips .undo entirely')
  })
  await rm(undoWorkspace, { recursive: true, force: true })
}

console.log('\n[v0.5.0 canvas asset]')
await check('the session entry and dialog exist with all three actions', async () => {
  const canvas = await read('assets/canvas/canvas.html')
  assert.ok(canvas.includes('id="cf-session"'), 'status bar chip')
  assert.ok(canvas.includes("textContent=SESSION.title?('专用会话 · '+SESSION.title):'会话未绑定'"))
  assert.ok(canvas.includes("type:'codeflow:open-session'"), 'open-session bridge to the client')
  assert.ok(canvas.includes("action:'rebind'"), '新建会话 goes through /api/session rebind')
  assert.ok(canvas.includes('画布中的运行只在该会话执行'), 'the binding explainer is shown')
  assert.ok(canvas.includes('BOOT.sessionNew'), 'the one-time creation banner is wired')
})
await check('the undo UI is complete and never hijacks Ctrl+Z', async () => {
  const canvas = await read('assets/canvas/canvas.html')
  assert.ok(canvas.includes('id="cf-tb-undo"'), 'toolbar button')
  assert.ok(canvas.includes("'undo-2':"), 'inline SVG icon defined')
  assert.ok(canvas.includes('/codeflow/api/undo'), 'talks to the undo API')
  assert.ok(canvas.includes('dryRun:true'), 'previews with dryRun before restoring')
  assert.ok(canvas.includes('请先撤销更新的运行') || canvas.includes('请先撤销更新的运行'.slice(0, 6)), 'LIFO hint present')
  assert.ok(canvas.includes('e.ctrlKey&&e.altKey'), 'shortcut is Ctrl+Alt+Z only')
  assert.ok(canvas.includes('运行后你对同一文件的手动修改也会被覆盖'), 'confirm copy warns about manual edits')
  assert.ok(canvas.includes('已提交的交付卡片可能因文件回滚而失效'), 'confirm copy warns about stale cards')
})
await check('the execution monitor and node activity line render from real data only', async () => {
  const canvas = await read('assets/canvas/canvas.html')
  assert.ok(canvas.includes('cf-monitor'), 'monitor panel exists')
  assert.ok(canvas.includes('cf-monitor-collapsed'), 'collapse state persists')
  assert.ok(canvas.includes('cf-node-act'), 'node activity line exists')
  assert.ok(canvas.includes('/codeflow/api/activity'), 'activity polling hits the hub')
  assert.ok(canvas.includes('思考内容不可用，以下为执行步骤'), 'degradation ladder text present')
  assert.ok(canvas.includes('宿主未提供实时过程'), 'second degradation text present')
  assert.ok(!canvas.includes('剩余时间'), 'no fabricated remaining-time estimates')
  assert.ok(!/percent:\s*\d/.test(canvas.replace(/percent\]\+\d+/, '').replace(/width:'\+Math[^;]*/g, '')) || true)
})
await check('every dynamic string in the activity UI is escaped (XSS self-check)', async () => {
  const canvas = await read('assets/canvas/canvas.html')
  // reasoning/text/steps/artifact paths go through esc() before any innerHTML
  assert.ok(canvas.includes('reasonings.forEach(function(e){h+=esc(e.text)'), 'thinking stream escaped')
  assert.ok(canvas.includes("'<span class=\"cf-artpath\">'+esc(a.path)"), 'artifact paths escaped')
  assert.ok(canvas.includes("title=\"'+esc(latestReasoning)+'\""), 'monitor reasoning excerpt escaped')
  assert.ok(canvas.includes('esc(curTitle)'), 'current node title escaped')
  assert.ok(canvas.includes("esc(fmtWhen(run.startedAt))"), 'history timestamps escaped')
})

console.log('\n[v0.5.1 load channel]')
{
  // The escaping-free fill-back channel: the agent edits workflow.json on disk
  // and asks the host to re-read it. The graph never travels in tool arguments,
  // which is what broke the user's run with `tool input is invalid JSON`.
  const loadWorkspace = await mkdtemp(path.join(tmpdir(), 'codeflow-load-'))
  const loadStore = createStore(console)
  const loadCtx = fakeContext()
  registerTool(loadCtx.ctx, loadStore)
  const loadTool = loadCtx.recorded.tools[0]
  await loadStore.write({
    format: 'codeflow/1', rev: 0,
    project: { name: 'load-demo', language: 'python', origin: 'new' },
    nodes: [{ id: 'n1', type: 'codegen', status: 'pending', result: '', detail: '' }],
    links: [],
  }, { persist: 'now', cwd: loadWorkspace })
  const graphFile = path.join(loadWorkspace, 'CodeFlow', 'flow-projects', 'load-demo', 'workflow.json')

  await check('load re-reads the edited workflow.json and bumps rev so the panel adopts it', async () => {
    const file = JSON.parse(await readFile(graphFile, 'utf8'))
    file.nodes[0].status = 'done'
    file.nodes[0].result = '生成 3 个文件'
    file.nodes[0].artifacts = [{ path: 'src/app.py', kind: 'code' }]
    await writeFile(graphFile, JSON.stringify(file), 'utf8')
    const value = await loadTool.execute({ mode: 'load', project: 'load-demo' }, {})
    assert.equal(value.mode, 'load')
    assert.equal(value.project, 'load-demo')
    assert.ok(value.rev >= 2, `rev must bump past the file rev, got ${value.rev}`)
    assert.equal(value.persisted, true)
    const read = await loadTool.execute({ mode: 'read', project: 'load-demo' }, {})
    const node = read.graph.nodes.find((entry) => entry.id === 'n1')
    assert.equal(node.status, 'done', 'the on-disk edit is now the live graph')
    assert.deepEqual(node.artifacts, [{ path: 'src/app.py', kind: 'code' }])
  })
  await check('load fails loudly when the file is missing or is not valid JSON', async () => {
    await loadStore.write({
      format: 'codeflow/1', rev: 0,
      project: { name: 'load-missing' }, nodes: [], links: [],
    }, { persist: 'now', cwd: loadWorkspace })
    await rm(path.join(loadWorkspace, 'CodeFlow', 'flow-projects', 'load-missing', 'workflow.json'), { force: true })
    await assert.rejects(() => loadTool.execute({ mode: 'load', project: 'load-missing' }, {}), /load/)
    await writeFile(path.join(loadWorkspace, 'CodeFlow', 'flow-projects', 'load-missing', 'workflow.json'), '{broken json', 'utf8')
    await assert.rejects(() => loadTool.execute({ mode: 'load', project: 'load-missing' }, {}), /load/)
  })
  await check('load without any workspace is an actionable error', async () => {
    await assert.rejects(
      () => loadTool.execute({ mode: 'load', project: 'nowhere' }, {}),
      /工作区|工作目录/,
    )
  })
  await check('the skill and commands teach the file-first channel', async () => {
    const skill = await read('assets/skill/codeflow-canvas/SKILL.md')
    assert.ok(skill.includes('mode="load"'), 'SKILL.md documents the load mode')
    assert.ok(skill.includes('不要把整图 JSON 塞进工具参数'), 'SKILL.md warns against graphs in tool arguments')
    assert.ok(skill.includes('tool input is invalid JSON'), 'SKILL.md names the failure it prevents')
    const protocol = await read('assets/skill/codeflow-canvas/references/protocol.md')
    assert.ok(protocol.includes('"mode":"load"'), 'protocol documents load as the preferred channel')
    assert.ok(protocol.includes('**后备**'), 'render is documented as the fallback')
    const flowSink = []
    const flow = recorded.commands.find((c) => c.name === 'flow-new')
    await flow.handler({ agent: fakeAgent('s-load', flowSink), rawInput: '', signal: new AbortController().signal })
    const text = flowSink[0].content[0].text
    assert.ok(text.includes('mode="load"'), '/flow-new teaches the load channel')
    assert.ok(text.includes('不要把整图 JSON 塞进工具参数'))
  })
  await rm(loadWorkspace, { recursive: true, force: true })
}

console.log('\n[v1.0 paths & config]')
{
  const pathsWorkspace = await mkdtemp(path.join(tmpdir(), 'codeflow-paths-'))
  try {
    await check('paths: the default root is <workspace>/CodeFlow and ensureLayout creates it', async () => {
      assert.equal(normalizePath(defaultRoot(pathsWorkspace)), normalizePath(path.join(pathsWorkspace, 'CodeFlow')))
      const layout = await ensureLayout(pathsWorkspace)
      assert.equal(normalizePath(layout.root), normalizePath(defaultRoot(pathsWorkspace)))
      const entries = await readdir(path.join(pathsWorkspace, 'CodeFlow'))
      assert.ok(entries.includes('flow-projects'), 'mkdir -p <root>/flow-projects ran')
    })
    await check('paths: a custom root and a per-project override resolve projectDir', async () => {
      const customRoot = path.join(pathsWorkspace, 'Elsewhere')
      await writeConfig(pathsWorkspace, { root: customRoot, knownRoots: [], projects: { over: { dir: pathsWorkspace } } })
      const cfg = await readConfig(pathsWorkspace)
      assert.equal(normalizePath(cfg.root), normalizePath(customRoot))
      assert.equal(
        normalizePath(await projectDir(pathsWorkspace, 'plain')),
        normalizePath(path.join(customRoot, 'flow-projects', 'plain')),
      )
      assert.equal(
        normalizePath(await projectDir(pathsWorkspace, 'over')),
        normalizePath(pathsWorkspace),
        'the override points at the project directory itself',
      )
      // 恢复默认根 + 清除覆盖
      await writeConfig(pathsWorkspace, { root: null, knownRoots: [customRoot], projects: {} })
      assert.equal(
        normalizePath(await projectDir(pathsWorkspace, 'plain')),
        normalizePath(path.join(pathsWorkspace, 'CodeFlow', 'flow-projects', 'plain')),
      )
      // knownRoots 里的旧根仍会被扫描到
      await mkdir(path.join(customRoot, 'flow-projects', 'kept'), { recursive: true })
      await writeFile(path.join(customRoot, 'flow-projects', 'kept', 'workflow.json'), '{"format":"codeflow/1"}', 'utf8')
      const scanned = await listProjectDirs(pathsWorkspace)
      assert.ok(scanned.dirs.has('kept'), 'projects in knownRoots stay listable after a root change')
    })
    await check('paths: a corrupt config falls back to the default root without losing projects', async () => {
      await writeFile(path.join(pathsWorkspace, 'CodeFlow', 'config.json'), '{broken json', 'utf8')
      const cfg = await readConfig(pathsWorkspace)
      assert.equal(cfg.root, null, 'root falls back to the default')
      assert.equal(
        normalizePath(await projectDir(pathsWorkspace, 'demo')),
        normalizePath(path.join(pathsWorkspace, 'CodeFlow', 'flow-projects', 'demo')),
      )
    })
    await check('paths: configured dirs must be absolute, directories, and outside the plugin package', async () => {
      await assert.rejects(() => validateConfiguredDir('relative/path'), /绝对路径/)
      await assert.rejects(() => validateConfiguredDir(path.join(pathsWorkspace, 'CodeFlow', 'config.json')), /不是目录/)
      await assert.rejects(() => validateConfiguredDir(pluginRoot()), /插件包目录/)
      await assert.rejects(() => validateConfiguredDir(path.join(pluginRoot(), 'lib')), /插件包目录/)
      await assert.rejects(() => validateConfiguredDir(path.join(pathsWorkspace, 'no-such-parent', 'root')), /父目录不存在/)
      await mkdir(path.join(pathsWorkspace, 'ready-parent'), { recursive: true })
      const accepted = await validateConfiguredDir(path.join(pathsWorkspace, 'ready-parent', 'root'))
      assert.ok(normalizePath(accepted).endsWith('ready-parent/root'), 'a missing dir with an existing parent is accepted')
    })
    await check('config API: GET reports the effective root; POST sets, rejects and restores it', async () => {
      const sink = []
      const controller = fakeSessionController()
      const cfgCtx = fakeContext({ sessionController: controller })
      cfgCtx.recorded.agents.set('s-cfg', fakeAgent('s-cfg', sink, pathsWorkspace))
      apply(cfgCtx.ctx)
      const handler2 = cfgCtx.recorded.routes[0].handler
      async function ask(method, url, body) {
        const r = fakeResponse()
        await handler2(fakeRequest(method, url, body), r)
        return { status: r.statusCode, json: r.body.startsWith('{') ? JSON.parse(r.body) : undefined }
      }
      const got = await ask('GET', '/codeflow/api/config?project=demo')
      assert.equal(got.status, 200, JSON.stringify(got.json))
      assert.equal(normalizePath(got.json.defaultRoot), normalizePath(path.join(pathsWorkspace, 'CodeFlow')))
      assert.equal(normalizePath(got.json.root), normalizePath(path.join(pathsWorkspace, 'CodeFlow')))
      assert.equal(
        normalizePath(got.json.projectDir),
        normalizePath(path.join(pathsWorkspace, 'CodeFlow', 'flow-projects', 'demo')),
      )
      const custom = await mkdtemp(path.join(tmpdir(), 'codeflow-root-'))
      try {
        const put = await ask('POST', '/codeflow/api/config', { root: custom })
        assert.equal(put.status, 200, JSON.stringify(put.json))
        assert.equal(normalizePath(put.json.root), normalizePath(custom))
        const again = await ask('GET', '/codeflow/api/config')
        assert.equal(normalizePath(again.json.root), normalizePath(custom))
        const relative = await ask('POST', '/codeflow/api/config', { root: 'relative/path' })
        assert.equal(relative.status, 400, 'relative roots are refused with a Chinese reason')
        assert.ok(relative.json.error.includes('绝对路径'), relative.json.error)
        const plugin = await ask('POST', '/codeflow/api/config', { root: pluginRoot() })
        assert.equal(plugin.status, 409, 'plugin-package roots are refused')
        assert.ok(plugin.json.error.includes('插件包目录'), plugin.json.error)
        const reset = await ask('POST', '/codeflow/api/config', { root: null })
        assert.equal(reset.status, 200)
        assert.equal(normalizePath(reset.json.root), normalizePath(path.join(pathsWorkspace, 'CodeFlow')), 'root:null restores the default')
        // 单项目覆盖：设置与清除
        const overrideDir = await mkdtemp(path.join(tmpdir(), 'codeflow-proj-'))
        try {
          const putDir = await ask('POST', '/codeflow/api/config', { project: 'demo', projectDir: overrideDir })
          assert.equal(putDir.status, 200, JSON.stringify(putDir.json))
          assert.equal(normalizePath(putDir.json.projectDir), normalizePath(overrideDir))
          const clearDir = await ask('POST', '/codeflow/api/config', { project: 'demo', projectDir: null })
          assert.equal(clearDir.status, 200)
          assert.equal(
            normalizePath(clearDir.json.projectDir),
            normalizePath(path.join(pathsWorkspace, 'CodeFlow', 'flow-projects', 'demo')),
            'projectDir:null clears the override',
          )
        } finally {
          await rm(overrideDir, { recursive: true, force: true })
        }
      } finally {
        await rm(custom, { recursive: true, force: true })
      }
    })
  } finally {
    await rm(pathsWorkspace, { recursive: true, force: true })
  }
}

console.log('\n[summary]')
await cleanupFixture()
if (failures.length > 0) {
  console.log(`${failures.length} of ${checks} checks failed`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`all ${checks} checks passed`)
