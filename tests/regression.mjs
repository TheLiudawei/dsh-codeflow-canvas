/**
 * Regression tests for the v0.5.2 fixes (实测报告 B2–B9 及其关联问题).
 *
 * Each check pins one incident from the field report:
 *
 *   B2  autosave write failures were invisible to the client → the POST
 *       /codeflow/api/state response now carries `persisted`/`error` and the
 *       write happens before answering;
 *   B3  /api/save answered 200 + ok:true even when nothing reached the disk →
 *       507 + ok:false now;
 *   B4  a corrupt workflow.json was served as an empty canvas and the next
 *       save destroyed it → the file is quarantined (`*.bad-<ts>`) and every
 *       read path reports `degraded`;
 *   B5  last-write-wins between two windows → `expectedRev` conflicts answer
 *       409 + `currentRev`;
 *   B6  oversized bodies answered 500 → 413;
 *   B7  non-graph payloads answered 500 → 400;
 *   B8  non-atomic writes + an unref'd debounce timer → atomic writes,
 *       serialized per project, flushed on dispose;
 *   B9  two "untitled" buckets (`..` → key `untitled`, `" "` → key
 *       `__untitled__`) shared one directory → a single bucket now.
 *
 * Everything runs against a fake HTTP pair and real temp directories.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/regression.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { createRouter } from '../lib/routes.js'
import {
  createStore,
  projectKeyOf,
  safeProjectName,
  UNTITLED_KEY,
} from '../lib/store.js'
import { createUndoManager } from '../lib/undo.js'
import { registerTool } from '../lib/tool.js'
import { sessionSidecarPath } from '../lib/sessions.js'

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

/** A minimal fake Cordis context, enough to register the tool. */
function fakeToolContext() {
  const recorded = { tools: [] }
  const ctx = {
    logger: console,
    tools: {
      register(definition) {
        recorded.tools.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, recorded }
}

/** A valid one-node graph for a named project. */
function graphFor(name, extras = {}) {
  return {
    format: 'codeflow/1',
    rev: 0,
    project: { name, language: 'python', origin: 'new' },
    nodes: [{ id: 'n1', type: 'requirement', title: '需求', pos: [0, 0], params: {}, status: 'pending', result: '', detail: '' }],
    links: [],
    meta: {},
    ...extras,
  }
}

/** Create a fresh temp workspace directory. */
async function makeWorkspace(prefix = 'codeflow-reg-') {
  return mkdtemp(path.join(tmpdir(), prefix))
}

/** Build a router whose workspace resolution always answers `workspace`. */
function buildRouter(store, workspace, { submits } = {}) {
  return createRouter({
    store,
    logger: console,
    resolveCwd: async () => workspace,
    submit: async (gesture) => {
      if (submits) submits.push(gesture)
      return { sessionId: 'sess-test' }
    },
    ensureSession: async () => ({ sessionId: 'sess-test', created: false }),
  })
}

/** Call a router handler and parse the JSON body. */
async function call(handler, method, url, body) {
  const res = fakeResponse()
  await handler(fakeRequest(method, url, body), res)
  return { status: res.statusCode, text: res.body, json: res.body.startsWith('{') ? JSON.parse(res.body) : undefined }
}

/** The durable workflow file path for a project directory name. */
const workflowFile = (workspace, dir) => path.join(workspace, 'flow-projects', dir, 'workflow.json')

/** Compare host paths regardless of the separator the platform uses. */
const normalizePath = (value) => String(value ?? '').split('\\').join('/')

/** List `*.bad-*` quarantine files in a project directory (empty when none). */
async function quarantineFiles(workspace, dir) {
  try {
    const entries = await readdir(path.join(workspace, 'flow-projects', dir))
    return entries.filter((name) => name.startsWith('workflow.json.bad-'))
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------- main --- */

console.log('\n[B9 one untitled bucket]')
await check('every unusable project name collapses into the single bucket key', () => {
  assert.equal(projectKeyOf('..'), UNTITLED_KEY)
  assert.equal(projectKeyOf('   '), UNTITLED_KEY)
  assert.equal(projectKeyOf(''), UNTITLED_KEY)
  assert.equal(projectKeyOf(undefined), UNTITLED_KEY)
  assert.equal(projectKeyOf(null), UNTITLED_KEY)
  assert.equal(projectKeyOf('untitled'), UNTITLED_KEY, 'the literal name is reserved for the bucket')
  assert.equal(projectKeyOf('UNTITLED'), UNTITLED_KEY, 'Windows directories are case-insensitive')
  assert.equal(projectKeyOf('todo-cli'), 'todo-cli')
  assert.equal(projectKeyOf('待办 工具'), '待办-工具')
  assert.equal(projectKeyOf('__untitled__'), UNTITLED_KEY, 'the key maps to itself')
  // The public sanitizer keeps its documented shape (tests/validate.mjs pins it).
  assert.equal(safeProjectName(''), 'untitled')
})
await check('junk names and the bucket share one durable directory', async () => {
  const workspace = await makeWorkspace('codeflow-b9-')
  try {
    const store = createStore(console)
    const first = await store.write(graphFor('..'), { persist: 'now', cwd: workspace })
    assert.equal(first.key, UNTITLED_KEY)
    assert.ok(normalizePath(first.file).endsWith('/flow-projects/untitled/workflow.json'), first.file)
    // Writing through a different unusable spelling reaches the same state.
    const second = await store.write(graphFor('   '), { persist: 'now', cwd: workspace })
    assert.equal(second.key, UNTITLED_KEY)
    assert.equal(second.rev, first.rev + 1)
    assert.equal(store.get('untitled').rev, second.rev, 'the literal name reads the same bucket')
    const onDisk = JSON.parse(await readFile(workflowFile(workspace, 'untitled'), 'utf8'))
    assert.equal(onDisk.rev, second.rev)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('sidecar and undo roots follow the same directory mapping', async () => {
  const workspace = await makeWorkspace('codeflow-b9b-')
  try {
    assert.equal(sessionSidecarPath(workspace, '..'), path.join(workspace, 'flow-projects', 'untitled', 'session.json'))
    assert.equal(sessionSidecarPath(workspace, 'real-project'), path.join(workspace, 'flow-projects', 'real-project', 'session.json'))
    const store = createStore(console)
    store.bindCwd('..', workspace)
    const undo = createUndoManager({ store, logger: console })
    const resolved = await undo.resolveRoot('..')
    assert.equal(resolved.root, path.join(workspace, 'flow-projects', 'untitled'))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

console.log('\n[B5 revision conflicts]')
await check('store.write refuses a stale expectedRev with a 409-shaped error', async () => {
  const store = createStore(console)
  const first = await store.write(graphFor('conflict'), { persist: 'never', expectedRev: 0 })
  assert.equal(first.rev, 1)
  await assert.rejects(
    () => store.write(graphFor('conflict'), { persist: 'never', expectedRev: 0 }),
    (error) => {
      assert.equal(error.statusCode, 409)
      assert.equal(error.currentRev, 1)
      return true
    },
  )
  const second = await store.write(graphFor('conflict'), { persist: 'never', expectedRev: 1 })
  assert.equal(second.rev, 2)
  // No expectedRev at all keeps the old last-write-wins behaviour for writers
  // that cannot know a base (the agent's fill-backs, undo restores).
  const third = await store.write(graphFor('conflict'), { persist: 'never' })
  assert.equal(third.rev, 3)
})
await check('a stale autosave answers 409 with the current revision', async () => {
  const workspace = await makeWorkspace('codeflow-b5-')
  try {
    const store = createStore(console)
    const handler = buildRouter(store, workspace)
    await call(handler, 'POST', '/codeflow/api/state', { graph: graphFor('http-conflict') })
    const current = await call(handler, 'GET', '/codeflow/api/state?project=http-conflict')
    assert.equal(current.json.rev, 1)
    const stale = await call(handler, 'POST', '/codeflow/api/state', {
      graph: graphFor('http-conflict'),
      expectedRev: 0,
    })
    assert.equal(stale.status, 409, stale.text)
    assert.equal(stale.json.ok, false)
    assert.equal(stale.json.currentRev, 1)
    const fresh = await call(handler, 'POST', '/codeflow/api/state', {
      graph: graphFor('http-conflict'),
      expectedRev: 1,
    })
    assert.equal(fresh.status, 200)
    assert.equal(fresh.json.rev, 2)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('a stale run gesture is refused before the agent is woken', async () => {
  const workspace = await makeWorkspace('codeflow-b5b-')
  try {
    const store = createStore(console)
    const submits = []
    const handler = buildRouter(store, workspace, { submits })
    const stale = await call(handler, 'POST', '/codeflow/api/action', {
      action: 'RUN_NODE',
      graph: graphFor('run-conflict'),
      nodeId: 'n1',
      expectedRev: 42,
    })
    assert.equal(stale.status, 409, stale.text)
    assert.deepEqual(submits, [], 'the gesture must not reach the agent')
    const okRun = await call(handler, 'POST', '/codeflow/api/action', {
      action: 'RUN_NODE',
      graph: graphFor('run-conflict'),
      nodeId: 'n1',
      expectedRev: 0,
    })
    assert.equal(okRun.status, 200, okRun.text)
    assert.equal(submits.length, 1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

console.log('\n[B7 non-graph payloads / B6 oversized bodies]')
await check('a non-graph payload answers 400, not 500', async () => {
  const workspace = await makeWorkspace('codeflow-b7-')
  try {
    const handler = buildRouter(createStore(console), workspace)
    const response = await call(handler, 'POST', '/codeflow/api/state', { graph: 5 })
    assert.equal(response.status, 400, response.text)
    assert.equal(response.json.ok, false)
    const text = await call(handler, 'POST', '/codeflow/api/state', { graph: 'nope' })
    assert.equal(text.status, 400)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('an oversized body answers 413, not 500', async () => {
  const workspace = await makeWorkspace('codeflow-b6-')
  try {
    const handler = buildRouter(createStore(console), workspace)
    const huge = { graph: graphFor('big', { nodes: [{ id: 'n1', type: 'requirement', params: { pad: 'x'.repeat(5 * 1024 * 1024) } }] }) }
    const response = await call(handler, 'POST', '/codeflow/api/state', huge)
    assert.equal(response.status, 413, response.text)
    assert.equal(response.json.ok, false)
    assert.ok(response.json.error.includes('too large'), response.json.error)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

console.log('\n[B2 autosave reports the durable outcome]')
await check('autosave persists before answering and reports persisted:true', async () => {
  const workspace = await makeWorkspace('codeflow-b2-')
  try {
    const store = createStore(console)
    const handler = buildRouter(store, workspace)
    const response = await call(handler, 'POST', '/codeflow/api/state', { graph: graphFor('autosave-demo') })
    assert.equal(response.status, 200, response.text)
    assert.equal(response.json.ok, true)
    assert.equal(response.json.persisted, true, 'the response must carry the durable outcome')
    assert.equal(response.json.error, undefined)
    const file = workflowFile(workspace, 'autosave-demo')
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(onDisk.rev, response.json.rev, 'the file landed before the answer was sent')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('a failing disk write is visible in the autosave response', async () => {
  const workspace = await makeWorkspace('codeflow-b2b-')
  try {
    const store = createStore(console)
    const handler = buildRouter(store, workspace)
    const first = await call(handler, 'POST', '/codeflow/api/state', { graph: graphFor('readonly-demo') })
    assert.equal(first.json.persisted, true)
    // Replace the durable copy with a directory: both the replace-rename and
    // the fallback write must fail on every platform (EISDIR/EPERM), which is
    // the portable version of the field report's `chmod 444` scenario.
    const file = workflowFile(workspace, 'readonly-demo')
    await rm(file)
    await mkdir(file)
    try {
      const second = await call(handler, 'POST', '/codeflow/api/state', { graph: graphFor('readonly-demo') })
      assert.equal(second.status, 200, 'autosave itself stays 200 — it is a background save')
      assert.equal(second.json.ok, true)
      assert.equal(second.json.persisted, false, 'the client must learn the write failed')
      assert.equal(typeof second.json.error, 'string')
      assert.ok(second.json.error.length > 0)
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('GET /api/state surfaces the last persist error', async () => {
  const workspace = await makeWorkspace('codeflow-b2c-')
  try {
    const store = createStore(console)
    const handler = buildRouter(store, workspace)
    await call(handler, 'POST', '/codeflow/api/state', { graph: graphFor('persist-err') })
    const file = workflowFile(workspace, 'persist-err')
    await rm(file)
    await mkdir(file)
    try {
      await call(handler, 'POST', '/codeflow/api/state', { graph: graphFor('persist-err') })
      const state = await call(handler, 'GET', '/codeflow/api/state?project=persist-err')
      assert.equal(state.status, 200)
      assert.equal(typeof state.json.persistError, 'string', 'the poller can show the failure')
      assert.equal(state.json.degraded, null)
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

console.log('\n[B3 /api/save answers 507 on failure]')
await check('a successful save answers 200 + ok:true + persisted:true', async () => {
  const workspace = await makeWorkspace('codeflow-b3-')
  try {
    const handler = buildRouter(createStore(console), workspace)
    const response = await call(handler, 'POST', '/codeflow/api/save', { graph: graphFor('save-ok') })
    assert.equal(response.status, 200, response.text)
    assert.equal(response.json.ok, true)
    assert.equal(response.json.persisted, true)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('a save that cannot reach the disk answers 507 + ok:false', async () => {
  const workspace = await makeWorkspace('codeflow-b3b-')
  try {
    const store = createStore(console)
    const handler = buildRouter(store, workspace)
    await call(handler, 'POST', '/codeflow/api/save', { graph: graphFor('save-fail') })
    const file = workflowFile(workspace, 'save-fail')
    await rm(file)
    await mkdir(file)
    try {
      const response = await call(handler, 'POST', '/codeflow/api/save', { graph: graphFor('save-fail') })
      assert.equal(response.status, 507, response.text)
      assert.equal(response.json.ok, false)
      assert.equal(response.json.persisted, false)
      assert.equal(typeof response.json.error, 'string')
    } finally {
      await rm(file, { recursive: true, force: true })
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

console.log('\n[B4 corrupt files are quarantined, never served as empty]')
await check('store.load quarantines a half-written file and reports degraded', async () => {
  const workspace = await makeWorkspace('codeflow-b4-')
  try {
    const dir = path.join(workspace, 'flow-projects', 'corrupt-demo')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'workflow.json')
    await writeFile(file, '{"graph":', 'utf8') // exactly the field report's truncation
    const store = createStore(console)
    const loaded = await store.load('corrupt-demo', workspace)
    assert.notEqual(loaded.results.tasks.degraded, undefined, 'degraded, not thrown')
    assert.ok(loaded.results.tasks.degraded.reason.includes('JSON'), loaded.results.tasks.degraded.reason)
    assert.equal(store.get('corrupt-demo').degraded.reason, loaded.results.tasks.degraded.reason)
    await assert.rejects(() => stat(file), 'the damaged file no longer sits at workflow.json')
    const quarantined = await quarantineFiles(workspace, 'corrupt-demo')
    assert.equal(quarantined.length, 1, 'exactly one quarantine copy')
    assert.equal(await readFile(path.join(dir, quarantined[0]), 'utf8'), '{"graph":', 'every byte preserved')
    // A fresh load of a valid file clears the degraded flag.
    await writeFile(file, JSON.stringify(graphFor('corrupt-demo')), 'utf8')
    const again = await store.load('corrupt-demo', workspace)
    assert.equal(again.results.tasks.degraded, undefined)
    assert.equal(store.get('corrupt-demo').degraded, undefined)
    assert.equal(store.get('corrupt-demo').rev, 0, 'the loaded rev becomes the live rev')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('valid JSON that is not a graph is quarantined too', async () => {
  const workspace = await makeWorkspace('codeflow-b4b-')
  try {
    const dir = path.join(workspace, 'flow-projects', 'notagraph')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'workflow.json')
    await writeFile(file, '[1,2,3]', 'utf8')
    const store = createStore(console)
    const loaded = await store.load('notagraph', workspace)
    assert.ok(loaded.results.tasks.degraded.reason.includes('codeflow/1'), loaded.results.tasks.degraded.reason)
    assert.equal((await quarantineFiles(workspace, 'notagraph')).length, 1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('the boot payload and /api/state both carry degraded', async () => {
  const workspace = await makeWorkspace('codeflow-b4c-')
  try {
    const dir = path.join(workspace, 'flow-projects', 'boot-degraded')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'workflow.json'), '{broken', 'utf8')
    const handler = buildRouter(createStore(console), workspace)
    const page = await call(handler, 'GET', '/codeflow/canvas?boot=1&project=boot-degraded')
    assert.equal(page.status, 200)
    const boot = JSON.parse(/window\.__CF_BOOT__=([\s\S]*?);<\/script>/.exec(page.text)[1])
    assert.notEqual(boot.degraded, null, 'the first frame already knows')
    assert.ok(boot.degraded.reason.includes('JSON'), boot.degraded.reason)
    const state = await call(handler, 'GET', '/codeflow/api/state?project=boot-degraded')
    assert.equal(state.status, 200)
    assert.notEqual(state.json.degraded, null)
    assert.equal(state.json.rev, 0)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('a save against a never-loaded corrupt file quarantines first (backstop)', async () => {
  const workspace = await makeWorkspace('codeflow-b4d-')
  try {
    const dir = path.join(workspace, 'flow-projects', 'backstop-demo')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'workflow.json')
    await writeFile(file, '{"half":', 'utf8')
    // A brand-new store: nobody ever loaded this project, yet the save must
    // not destroy the damaged original.
    const handler = buildRouter(createStore(console), workspace)
    const response = await call(handler, 'POST', '/codeflow/api/save', { graph: graphFor('backstop-demo') })
    assert.equal(response.status, 200, response.text)
    assert.equal(response.json.persisted, true)
    const quarantined = await quarantineFiles(workspace, 'backstop-demo')
    assert.equal(quarantined.length, 1, 'the original bytes survived')
    assert.equal(await readFile(path.join(dir, quarantined[0]), 'utf8'), '{"half":')
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(onDisk.format, 'codeflow/1')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('the tool refuses mode="load" on a quarantined file and warns on read', async () => {
  const workspace = await makeWorkspace('codeflow-b4e-')
  try {
    const dir = path.join(workspace, 'flow-projects', 'tool-load')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'workflow.json'), '{"nope":', 'utf8')
    const store = createStore(console)
    store.bindCwd('tool-load', workspace)
    const { ctx, recorded } = fakeToolContext()
    registerTool(ctx, store)
    const tool = recorded.tools[0]
    await assert.rejects(
      () => tool.execute({ mode: 'load', project: 'tool-load' }, {}),
      (error) => {
        assert.match(error.message, /load/)
        assert.match(error.message, /损坏/)
        return true
      },
    )
    assert.equal((await quarantineFiles(workspace, 'tool-load')).length, 1, 'quarantined, not overwritten')
    await store.write(graphFor('tool-load'), { persist: 'now', cwd: workspace })
    const read = await tool.execute({ mode: 'read', project: 'tool-load' }, {})
    assert.equal(read.graph.nodes.length, 1)
    assert.equal(read.warning, undefined, 'a healthy read carries no warning')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

console.log('\n[B8 atomic, serialized, flushed writes]')
await check('concurrent flushes serialize and the file always ends at the newest rev', async () => {
  const workspace = await makeWorkspace('codeflow-b8-')
  try {
    const store = createStore(console)
    const written = await store.write(graphFor('serial'), { persist: 'now', cwd: workspace })
    const flushes = await Promise.all(Array.from({ length: 10 }, () => store.flush('serial')))
    assert.ok(flushes.every((entry) => entry.persisted === true))
    const onDisk = JSON.parse(await readFile(workflowFile(workspace, 'serial'), 'utf8'))
    assert.equal(onDisk.rev, store.get('serial').rev, 'no older revision landed last')
    assert.equal(onDisk.rev, written.rev, 'flush does not bump rev')
    const entries = await readdir(path.join(workspace, 'flow-projects', 'serial'))
    assert.deepEqual(entries.filter((name) => name.includes('.tmp')), [], 'no temp file left behind')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('flushAll drains the debounce queue (dispose safety)', async () => {
  const workspace = await makeWorkspace('codeflow-b8b-')
  try {
    const store = createStore(console)
    await store.write(graphFor('drain'), { persist: 'now', cwd: workspace })
    store.patchNode('drain', 'n1', { status: 'done', result: '生成 3 个文件' })
    // The patch persisted `soon`: the durable copy is one rev behind right now.
    const before = JSON.parse(await readFile(workflowFile(workspace, 'drain'), 'utf8'))
    const live = store.get('drain')
    assert.notEqual(before.rev, live.rev, 'precondition: the debounce has not fired yet')
    await store.flushAll()
    const after = JSON.parse(await readFile(workflowFile(workspace, 'drain'), 'utf8'))
    assert.equal(after.rev, live.rev, 'flushAll caught the pending write')
    assert.equal(after.nodes[0].status, 'done')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('the store no longer unrefs its debounce timer', () => {
  // Structural guard: an unref'd timer is one the exit path may silently drop.
  const source = readFileSync(fileURLToPath(new URL('../lib/store.js', import.meta.url)), 'utf8')
  assert.ok(!source.includes('.unref'), 'store.js must not unref persistence timers')
  assert.ok(source.includes('atomicWriteFile'), 'persistence goes through the atomic writer')
})
await check('overlapping writes each answer with their own revision and graph', async () => {
  // Caught live against a real server: `rev` used to be read from the shared
  // state after the await, so N overlapping writes all reported the final rev.
  const workspace = await makeWorkspace('codeflow-snap-')
  try {
    const store = createStore(console)
    const writes = await Promise.all(Array.from({ length: 8 }, () =>
      store.write(graphFor('snapshot'), { persist: 'now', cwd: workspace })))
    const revs = writes.map((w) => w.rev).sort((left, right) => left - right)
    assert.deepEqual(revs, [1, 2, 3, 4, 5, 6, 7, 8])
    for (const w of writes) assert.equal(w.graph.rev, w.rev, 'each answer carries its own graph snapshot')
    assert.equal(new Set(writes.map((w) => w.graph)).size, 8, 'no two answers share a graph object')
    const onDisk = JSON.parse(await readFile(workflowFile(workspace, 'snapshot'), 'utf8'))
    assert.equal(onDisk.rev, 8, 'the durable copy ends at the newest rev')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

console.log('\n[summary]')
if (failures.length > 0) {
  console.log(`${failures.length} of ${checks} checks failed`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`all ${checks} checks passed`)
