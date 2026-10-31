/**
 * Behavioural self-check for the run-snapshot undo manager (`lib/undo.js`).
 *
 * Everything runs against real temporary directories and a real store, so the
 * snapshot/restore mechanics are exercised for real:
 *
 *   - snapshot scope: exclusions, symlink skipping, limits, partial marking;
 *   - restore: file add/modify/delete reversal, directory pruning, backups;
 *   - LIFO: newest-only, no skipping a failed snapshot, undone lockout;
 *   - node state: execution fields roll back, geometry/params never touched;
 *   - reconcile: interrupted marking, orphan cleanup, quota pruning;
 *   - safety: path containment, project mismatch, run lock.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/undo.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createStore } from '../lib/store.js'
import { createUndoManager, UNDO_LIMITS } from '../lib/undo.js'

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

/** A throwaway workspace with `CodeFlow/flow-projects/<name>/` already populated. */
async function makeProject(name, files) {
  const workspace = await rm_mkdtemp('codeflow-undo-ws-')
  const dir = path.join(workspace, 'CodeFlow', 'flow-projects', name)
  await mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), content, 'utf8')
  }
  return { workspace, dir }
}

let tempCounter = 0
async function rm_mkdtemp(prefix) {
  tempCounter += 1
  const dir = path.join(tmpdir(), `${prefix}${process.pid}-${tempCounter}`)
  await mkdir(dir, { recursive: true })
  return dir
}

const store = createStore(console)
let restoredProjects = []

const undo = createUndoManager({
  store,
  logger: console,
  limits: { ...UNDO_LIMITS, maxFiles: 200, maxBytes: 4 * 1024 * 1024, keepRuns: 2 },
  onRestored: (project) => restoredProjects.push(project),
})

/** Register a project in the store with a graph of N nodes. */
async function seedGraph(project, nodes) {
  await store.write({
    format: 'codeflow/1', rev: 0,
    project: { name: project, language: 'python', origin: 'new' },
    nodes,
    links: [],
  }, { persist: 'now', cwd: undefined })
  // The store needs a workspace so undo can resolve the project root.
  return store
}

async function bindWorkspace(project, workspace) {
  store.bindCwd(project, workspace)
}

console.log('\n[snapshot scope]')
{
  const { workspace, dir } = await makeProject('snap-demo', {
    'src/main.py': 'print("v1")\n',
    'docs/readme.md': '# demo\n',
    'workflow.json': '{"format":"codeflow/1"}',
    'session.json': '{"version":1}',
  })
  await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8')
  await mkdir(path.join(dir, '.git'), { recursive: true })
  await writeFile(path.join(dir, '.git', 'HEAD'), 'ref', 'utf8')
  await seedGraph('snap-demo', [{ id: 'n1', type: 'codegen', status: 'pending', pos: [1, 2], params: { dir: 'src' } }])
  await bindWorkspace('snap-demo', workspace)

  await check('excludes .git/node_modules and metadata from the snapshot', async () => {
    const snap = await undo.beginRun('snap-demo', { action: 'RUN_ALL', nodes: store.get('snap-demo').graph.nodes })
    assert.equal(snap.undoable, true, snap.reason)
    assert.equal(snap.fileCount, 2, 'only src/main.py and docs/readme.md')
    const manifest = JSON.parse(await readFile(path.join(dir, '.undo', snap.runId, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.beforeNodes.map((node) => node.id), ['n1'])
    assert.equal(manifest.action, 'RUN_ALL')
    assert.ok(manifest.runId.startsWith('20'), 'runId starts with the timestamp')
    await undo.releaseRun('snap-demo')
  })
  await rm(path.join(workspace), { recursive: true, force: true })
}

console.log('\n[restore + node fields]')
{
  const { workspace, dir } = await makeProject('restore-demo', {
    'src/main.py': 'print("v1")\n',
    'src/util.py': 'x = 1\n',
  })
  await seedGraph('restore-demo', [
    { id: 'n1', type: 'codegen', status: 'pending', result: '', detail: '', pos: [10, 20], params: { dir: 'src' }, title: '生成' },
    { id: 'n2', type: 'deliver', status: 'pending', result: '', detail: '', pos: [330, 20], params: {} },
  ])
  await bindWorkspace('restore-demo', workspace)
  let runId
  await check('files and node execution state roll back; geometry never does', async () => {
    const snap = await undo.beginRun('restore-demo', { action: 'RUN_NODE', nodeId: 'n1', nodes: store.get('restore-demo').graph.nodes })
    runId = snap.runId
    // The "agent" works: modifies one file, adds one, deletes one, then fills results.
    await writeFile(path.join(dir, 'src', 'main.py'), 'print("v2")\n', 'utf8')
    await writeFile(path.join(dir, 'src', 'new.py'), 'print("new")\n', 'utf8')
    await rm(path.join(dir, 'src', 'util.py'))
    // The user also rearranged the graph while running.
    const graph = store.get('restore-demo').graph
    graph.nodes[0].status = 'done'
    graph.nodes[0].result = '生成 2 个文件'
    graph.nodes[0].detail = 'src/main.py、src/new.py'
    graph.nodes[0].pos = [500, 500]
    graph.nodes[0].params = { dir: 'elsewhere' }
    graph.nodes[0].title = '生成（改名）'
    graph.nodes.push({ id: 'n3', type: 'review', status: 'pending', pos: [660, 20], params: {} })
    await store.write(graph, { persist: 'now' })
    await undo.finishRun('restore-demo', runId)

    const result = await undo.restore('restore-demo', runId)
    assert.equal(result.ok, true, result.error)
    assert.equal(await readFile(path.join(dir, 'src', 'main.py'), 'utf8'), 'print("v1")\n', 'modified file restored')
    assert.equal(await readFile(path.join(dir, 'src', 'util.py'), 'utf8'), 'x = 1\n', 'deleted file restored')
    let addedGone = false
    try { await readFile(path.join(dir, 'src', 'new.py'), 'utf8') } catch { addedGone = true }
    assert.ok(addedGone, 'added file removed')
    const nodes = store.get('restore-demo').graph.nodes
    const n1 = nodes.find((node) => node.id === 'n1')
    assert.equal(n1.status, 'pending', 'status rolled back')
    assert.equal(n1.result, '', 'result rolled back')
    assert.equal(n1.detail, '', 'detail rolled back')
    assert.deepEqual(n1.pos, [500, 500], 'pos stays where the user put it')
    assert.deepEqual(n1.params, { dir: 'elsewhere' }, 'params stay')
    assert.equal(n1.title, '生成（改名）', 'title stays')
    assert.ok(nodes.some((node) => node.id === 'n3'), 'nodes added after the run stay')
    const backup = await readFile(path.join(dir, '.undo', runId, result.backupDir, 'src', 'main.py'), 'utf8')
    assert.equal(backup, 'print("v2")\n', 'the pre-undo state is backed up')
    assert.ok(restoredProjects.includes('restore-demo'), 'onRestored fired')
    assert.deepEqual(result.files.modified, ['src/main.py'])
    assert.deepEqual(result.files.added, ['src/new.py'])
    assert.deepEqual(result.files.deleted, ['src/util.py'])
  })
  await check('an undone run is locked out of a second restore', async () => {
    const second = await undo.restore('restore-demo', runId)
    assert.equal(second.ok, false)
    assert.equal(second.code, 409)
  })
  await rm(workspace, { recursive: true, force: true })
}

console.log('\n[LIFO]')
{
  const { workspace, dir } = await makeProject('lifo-demo', { 'a.txt': 'one\n' })
  await seedGraph('lifo-demo', [{ id: 'n1', type: 'write', status: 'pending', result: '', detail: '' }])
  await bindWorkspace('lifo-demo', workspace)
  const run1 = await undo.beginRun('lifo-demo', { action: 'RUN_ALL', nodes: [] })
  await undo.finishRun('lifo-demo', run1.runId)
  await writeFile(path.join(dir, 'a.txt'), 'two\n', 'utf8')
  const run2 = await undo.beginRun('lifo-demo', { action: 'RUN_ALL', nodes: [] })
  await undo.finishRun('lifo-demo', run2.runId)
  await writeFile(path.join(dir, 'a.txt'), 'three\n', 'utf8')

  await check('only the newest run can be undone first', async () => {
    const early = await undo.restore('lifo-demo', run1.runId)
    assert.equal(early.ok, false)
    assert.equal(early.code, 409)
    assert.ok(early.error.includes('先撤销更新的运行'), early.error)
    const latest = await undo.restore('lifo-demo', run2.runId)
    assert.equal(latest.ok, true, latest.error)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'two\n', 'rolled back to run 2 start')
    const thenFirst = await undo.restore('lifo-demo', run1.runId)
    assert.equal(thenFirst.ok, true, thenFirst.error)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'one\n', 'then run 1 start')
  })
  await check('concurrent runs are refused while one is active', async () => {
    const busy = await undo.beginRun('lifo-demo', { action: 'RUN_ALL', nodes: [] })
    const second = await undo.beginRun('lifo-demo', { action: 'RUN_ALL', nodes: [] })
    assert.equal(second.undoable, false)
    assert.equal(second.locked, true)
    await undo.releaseRun('lifo-demo')
    assert.notEqual(busy.runId, undefined)
  })
  await rm(workspace, { recursive: true, force: true })
}

console.log('\n[failed snapshot blocks skip-ahead]')
{
  const { workspace, dir } = await makeProject('block-demo', { 'a.txt': 'x\n' })
  await seedGraph('block-demo', [{ id: 'n1', type: 'write', status: 'pending', result: '', detail: '' }])
  await bindWorkspace('block-demo', workspace)
  const good = await undo.beginRun('block-demo', { action: 'RUN_ALL', nodes: [] })
  await undo.finishRun('block-demo', good.runId)
  await writeFile(path.join(dir, 'a.txt'), 'y\n', 'utf8')
  await check('an over-limit tree cannot be skipped to reach the older run', async () => {
    // Fill the tree beyond the (small) test limit so the next snapshot aborts.
    const many = path.join(dir, 'big')
    await mkdir(many, { recursive: true })
    for (let i = 0; i < 250; i += 1) {
      await writeFile(path.join(many, `f${i}.txt`), `content ${i}\n`, 'utf8')
    }
    const failed = await undo.beginRun('block-demo', { action: 'RUN_ALL', nodes: [] })
    assert.equal(failed.undoable, false, 'snapshot aborted over the file cap')
    assert.ok(failed.reason.includes('上限'), failed.reason)
    await undo.releaseRun('block-demo')
    const skip = await undo.restore('block-demo', good.runId)
    assert.equal(skip.ok, false)
    assert.equal(skip.code, 409)
    assert.ok(skip.error.includes('无法安全撤销更早的运行'), skip.error)
  })
  await rm(workspace, { recursive: true, force: true })
}

console.log('\n[partial snapshots + symlinks]')
{
  const { workspace, dir } = await makeProject('partial-demo', { 'a.txt': 'x\n' })
  await seedGraph('partial-demo', [{ id: 'n1', type: 'write', status: 'pending', result: '', detail: '' }])
  await bindWorkspace('partial-demo', workspace)
  await check('a symlink is skipped and marks the snapshot partial', async () => {
    try {
      await symlink(path.join(dir, 'a.txt'), path.join(dir, 'link.txt'), 'file')
    } catch {
      // Windows without privileges: skip the platform-specific assertion.
      console.log('  skip  (symlink unsupported on this host)')
      await rm(workspace, { recursive: true, force: true })
      return
    }
    const snap = await undo.beginRun('partial-demo', { action: 'RUN_ALL', nodes: [] })
    assert.equal(snap.undoable, true)
    assert.equal(snap.partial, true, 'the skipped symlink marks the run partial')
    assert.ok(snap.skipped.includes('link.txt'), snap.skipped.join(','))
    await undo.finishRun('partial-demo', snap.runId)
    await rm(workspace, { recursive: true, force: true })
  })
  await rm(workspace, { recursive: true, force: true })
}

console.log('\n[excluded dirs survive restore]')
{
  const { workspace, dir } = await makeProject('exclude-demo', { 'a.txt': 'v1\n' })
  await seedGraph('exclude-demo', [{ id: 'n1', type: 'write', status: 'pending', result: '', detail: '' }])
  await bindWorkspace('exclude-demo', workspace)
  await check('files created inside node_modules/dist/.git are never deleted by undo', async () => {
    const snap = await undo.beginRun('exclude-demo', { action: 'RUN_ALL', nodes: [] })
    await undo.finishRun('exclude-demo', snap.runId)
    // The agent writes into excluded directories.
    await mkdir(path.join(dir, 'node_modules', 'left-pad'), { recursive: true })
    await writeFile(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1', 'utf8')
    await mkdir(path.join(dir, 'dist'), { recursive: true })
    await writeFile(path.join(dir, 'dist', 'bundle.js'), '// built', 'utf8')
    await mkdir(path.join(dir, '.git'), { recursive: true })
    await writeFile(path.join(dir, '.git', 'index'), 'blob', 'utf8')
    const result = await undo.restore('exclude-demo', snap.runId)
    assert.equal(result.ok, true, result.error)
    assert.equal(await readFile(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'utf8'), 'module.exports=1', 'node_modules untouched')
    assert.equal(await readFile(path.join(dir, 'dist', 'bundle.js'), 'utf8'), '// built', 'dist untouched')
    assert.equal(await readFile(path.join(dir, '.git', 'index'), 'utf8'), 'blob', '.git untouched')
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'v1\n', 'the tracked file rolled back')
    assert.equal(result.files.added.length, 0, 'excluded files never appear as "added"')
  })
  await rm(workspace, { recursive: true, force: true })
}

console.log('\n[reconcile + quota]')
{
  const { workspace, dir } = await makeProject('reconcile-demo', { 'a.txt': 'x\n' })
  await seedGraph('reconcile-demo', [{ id: 'n1', type: 'write', status: 'pending', result: '', detail: '' }])
  await bindWorkspace('reconcile-demo', workspace)
  let firstRunId = null
  await check('orphan run dirs are removed and unfinished runs become interrupted', async () => {
    const snap1 = await undo.beginRun('reconcile-demo', { action: 'RUN_ALL', nodes: [] })
    firstRunId = snap1.runId
    await undo.finishRun('reconcile-demo', snap1.runId)
    const snap2 = await undo.beginRun('reconcile-demo', { action: 'RUN_ALL', nodes: [] })
    // Simulate a crash mid-snapshot: no manifest yet.
    const orphan = path.join(dir, '.undo', '20990101T000000-dead00')
    await mkdir(path.join(orphan, 'before'), { recursive: true })
    await writeFile(path.join(orphan, 'before', 'junk.txt'), 'junk', 'utf8')
    // Simulate a crash mid-run: manifest complete, no finishedAt. It stamps
    // itself as the newest run so the quota cannot prune it before the assert.
    const crashed = path.join(dir, '.undo', '20980101T000000-beef00')
    await mkdir(path.join(crashed, 'before'), { recursive: true })
    await writeFile(path.join(crashed, 'before', 'a.txt'), 'x\n', 'utf8')
    await writeFile(path.join(crashed, 'manifest.json'), JSON.stringify({
      version: 1, runId: '20980101T000000-beef00', project: 'reconcile-demo', action: 'RUN_ALL',
      nodeId: null, root: dir, startedAt: Date.now(), status: 'complete', undoable: true, partial: false,
      fileCount: 1, bytes: 2, beforeNodes: [],
    }), 'utf8')
    const list = await undo.listRuns('reconcile-demo')
    let orphanGone = false
    try { await readFile(path.join(orphan, 'before', 'junk.txt'), 'utf8') } catch { orphanGone = true }
    assert.ok(orphanGone, 'the orphan directory was cleaned up')
    const crashedRow = list.runs.find((run) => run.runId === '20980101T000000-beef00')
    assert.equal(crashedRow.status, 'interrupted', 'complete-without-finishedAt becomes interrupted')
    assert.equal(crashedRow.undoable, true, 'interrupted runs stay undoable')
    await undo.releaseRun('reconcile-demo')
  })
  await check('quota prunes oldest beyond the cap but never the newest undoable', async () => {
    // keepRuns=2 in this suite: two more runs push the earliest one out.
    for (let i = 0; i < 2; i += 1) {
      const snap = await undo.beginRun('reconcile-demo', { action: 'RUN_ALL', nodes: [] })
      await undo.finishRun('reconcile-demo', snap.runId)
      await writeFile(path.join(dir, 'a.txt'), `gen ${i}\n`, 'utf8')
    }
    const list = await undo.listRuns('reconcile-demo')
    assert.ok(list.runs.length <= 2, `runs pruned to the cap, got ${list.runs.length}`)
    assert.ok(!list.runs.some((run) => run.runId === firstRunId), 'the earliest run was pruned first')
    // The newest undoable survives even beyond the cap.
    const snap = await undo.beginRun('reconcile-demo', { action: 'RUN_ALL', nodes: [] })
    await undo.finishRun('reconcile-demo', snap.runId)
    const latest = await undo.listRuns('reconcile-demo')
    assert.equal(latest.runs[0].runId, snap.runId)
    assert.equal(latest.runs[0].undoable, true)
    await undo.releaseRun('reconcile-demo')
  })
  await rm(workspace, { recursive: true, force: true })
}

console.log('\n[safety]')
{
  const { workspace, dir } = await makeProject('safe-demo', { 'a.txt': 'x\n' })
  await seedGraph('safe-demo', [{ id: 'n1', type: 'write', status: 'pending', result: '', detail: '' }])
  await bindWorkspace('safe-demo', workspace)
  await check('a snapshot from another project cannot be restored onto this one', async () => {
    const other = await makeProject('safe-other', { 'b.txt': 'y\n' })
    await seedGraph('safe-other', [{ id: 'n1', type: 'write', status: 'pending', result: '', detail: '' }])
    await bindWorkspace('safe-other', other.workspace)
    const snap = await undo.beginRun('safe-other', { action: 'RUN_ALL', nodes: [] })
    await undo.finishRun('safe-other', snap.runId)
    // Point safe-demo's manifest at the other project by name only: the
    // manifest root records safe-other, and project mismatch is refused.
    const cross = await undo.restore('safe-demo', snap.runId)
    assert.equal(cross.ok, false)
    await undo.releaseRun('safe-other')
    await rm(other.workspace, { recursive: true, force: true })
  })
  await check('undo refuses when there is nothing to undo', async () => {
    const empty = await undo.restore('safe-demo', '20990101T000000-cafe00')
    assert.equal(empty.ok, false)
  })
  await check('an imported project snapshots its meta.importedFrom root', async () => {
    const source = await rm_mkdtemp('codeflow-undo-import-')
    await writeFile(path.join(source, 'lib.py'), 'print(1)\n', 'utf8')
    await store.write({
      format: 'codeflow/1', rev: 0,
      project: { name: 'imported-demo', origin: 'import' },
      nodes: [{ id: 'n1', type: 'edit', status: 'pending', result: '', detail: '' }],
      links: [],
      meta: { importedFrom: source },
    }, { persist: 'never' })
    const snap = await undo.beginRun('imported-demo', { action: 'RUN_ALL', nodes: store.get('imported-demo').graph.nodes })
    assert.equal(snap.undoable, true, snap.reason)
    assert.equal(snap.fileCount, 1)
    assert.equal(snap.root, path.normalize(source), 'the import root is the snapshot root')
    await undo.finishRun('imported-demo', snap.runId)
    await rm(source, { recursive: true, force: true })
  })
  await rm(workspace, { recursive: true, force: true })
}

console.log('\n[cross-view restore]')
{
  const { workspace, dir } = await makeProject('dualview-demo', { 'src/m.py': 'print("v1")\n' })
  await seedGraph('dualview-demo', [
    { id: 't1', type: 'edit', status: 'pending', result: '', detail: '', pos: [0, 0], params: {} },
  ])
  await bindWorkspace('dualview-demo', workspace)
  // The same project also holds a modules view (independent graph + rev).
  await store.write({
    format: 'codeflow/1', rev: 0,
    project: { name: 'dualview-demo', origin: 'import' },
    nodes: [{ id: 'm1', type: 'module', status: 'pending', result: '', detail: '', pos: [0, 0], params: { path: path.join(dir, 'src', 'm.py'), symbol: '' } }],
    links: [],
    meta: { importedFrom: dir, strategy: 'modules' },
  }, { persist: 'now', cwd: workspace, view: 'modules' })

  await check('undoing a modules run restores module nodes but never the tasks view', async () => {
    const modulesNodes = store.get('dualview-demo', 'modules').graph.nodes
    const snap = await undo.beginRun('dualview-demo', { action: 'RUN_NODE', nodeId: 'm1', nodes: modulesNodes, view: 'modules' })
    assert.equal(snap.undoable, true, snap.reason)
    assert.equal(snap.view, 'modules')
    // The "agent" works: edits the file and fills the module node.
    await writeFile(path.join(dir, 'src', 'm.py'), 'print("v2")\n', 'utf8')
    const graph = store.get('dualview-demo', 'modules').graph
    graph.nodes[0].status = 'done'
    graph.nodes[0].result = '职责确认'
    await store.write(graph, { persist: 'now', view: 'modules' })
    // Meanwhile the tasks view moved on independently.
    const tasksGraph = store.get('dualview-demo', 'tasks').graph
    tasksGraph.nodes[0].status = 'done'
    tasksGraph.nodes[0].result = '任务侧的修改'
    await store.write(tasksGraph, { persist: 'now', view: 'tasks' })
    const tasksRevBefore = store.get('dualview-demo', 'tasks').rev
    await undo.finishRun('dualview-demo', snap.runId)

    const result = await undo.restore('dualview-demo', snap.runId)
    assert.equal(result.ok, true, result.error)
    assert.equal(await readFile(path.join(dir, 'src', 'm.py'), 'utf8'), 'print("v1")\n', 'file rolled back')
    const modulesAfter = store.get('dualview-demo', 'modules').graph.nodes[0]
    assert.equal(modulesAfter.status, 'pending', 'module node rolled back')
    assert.equal(modulesAfter.result, '')
    const tasksAfter = store.get('dualview-demo', 'tasks').graph.nodes[0]
    assert.equal(tasksAfter.status, 'done', 'the tasks node is untouched')
    assert.equal(tasksAfter.result, '任务侧的修改')
    assert.equal(store.get('dualview-demo', 'tasks').rev >= tasksRevBefore, true, 'the tasks rev never regresses')
    const manifest = JSON.parse(await readFile(path.join(dir, '.undo', snap.runId, 'manifest.json'), 'utf8'))
    assert.equal(manifest.view, 'modules')
    assert.ok(restoredProjects.includes('dualview-demo'))
  })
  await check('LIFO stays global across views (a tasks run locks out older restores)', async () => {
    // A NEW run on the tasks view: it becomes the newest run in the shared LIFO.
    const snap = await undo.beginRun('dualview-demo', { action: 'RUN_NODE', nodeId: 't1', nodes: store.get('dualview-demo', 'tasks').graph.nodes, view: 'tasks' })
    await undo.finishRun('dualview-demo', snap.runId)
    // The just-undone modules run can no longer be restored, and it blocks nothing:
    // the newest run (tasks) is the only candidate.
    const list = await undo.listRuns('dualview-demo')
    assert.equal(list.runs[0].view, 'tasks', 'the history is view-tagged')
    const second = await undo.restore('dualview-demo', list.runs[0].runId)
    assert.equal(second.ok, true, second.error)
  })
  await rm(workspace, { recursive: true, force: true })
}

/* v1.0：项目根走 CodeFlow 根（lib/paths.js 解析），.undo 跟着项目目录走。 */
await check('resolveRoot resolves through the CodeFlow root; .undo lives inside the project dir', async () => {
  const { workspace, dir } = await makeProject('paths-demo', {
    'workflow.json': '{"format":"codeflow/1","rev":0,"project":{"name":"paths-demo"},"nodes":[],"links":[]}',
    'src/app.py': 'print("hi")\n',
  })
  try {
    store.bindCwd('paths-demo', workspace)
    const scoped = createUndoManager({ store, logger: console })
    const resolved = await scoped.resolveRoot('paths-demo')
    assert.equal(resolved.kind, 'project')
    assert.equal(
      String(resolved.root).split(path.sep).join('/'),
      String(path.join(workspace, 'CodeFlow', 'flow-projects', 'paths-demo')).split(path.sep).join('/'),
      'the snapshot root is the project dir under CodeFlow/flow-projects/',
    )
    const snap = await scoped.beginRun('paths-demo', { action: 'RUN_ALL', nodes: [] })
    assert.equal(snap.undoable, true, JSON.stringify(snap))
    assert.ok(snap.root.startsWith(dir), '.undo is created inside the project directory')
    await scoped.abortRun('paths-demo', snap.runId)
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }
})

console.log('\n[summary]')
undo.reset()
if (failures.length > 0) {
  console.log(`${failures.length} of ${checks} checks failed`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log(`all ${checks} checks passed`)
