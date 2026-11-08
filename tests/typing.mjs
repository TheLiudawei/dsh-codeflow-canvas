/**
 * 任务节点自动识别（v1.5.0）的行为自检。
 *
 *   - classifyChange 的判定矩阵（任务书 §7.1 用例 1–11）：唯一规则表的
 *     每一行、优先级与「不猜」边界；
 *   - service 编排（用例 12–14）：两节点归属互不串味、未归属 diff 被忽略、
 *     锁定不写、幂等不 bump rev、reidentify 的「最近一次运行」门禁——
 *     全部用假 store/undo/activity 跑（依赖注入是架构红线）；
 *   - 撤销回滚（用例 15）：真 store + 真 undo + 临时目录——运行 → 自动识别
 *     → 撤销 → type/typeAuto/typeLocked 回到运行前，且 meta.cf 的其它键
 *     （stale）不被整块覆盖。
 *
 * 全程零 LLM、零网络：识别是纯脚本，测试只构造证据对象。
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/typing.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { classifyChange, classifyPath, isTestCommand, PRODUCIBLE_TYPES, TEST_COMMAND_RE } from '../lib/typing/classify.js'
import { createTypingService } from '../lib/typing/service.js'
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

let tempCounter = 0
async function makeTempDir(prefix) {
  tempCounter += 1
  const dir = path.join(tmpdir(), `${prefix}${process.pid}-${tempCounter}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/* --------------------------------------------- 判定矩阵（用例 1–11）----- */

const files = (added = [], modified = [], deleted = []) => ({ added, modified, deleted })
const verdict = (filesArg, tools = []) => classifyChange({ files: filesArg, tools })

console.log('\n[classify matrix]')
await check('1. 无文件、无命令 → null（保持 task）', async () => {
  assert.equal(verdict(files(), []), null)
  assert.equal(verdict(null, []), null)
  assert.equal(classifyChange({ files: null, tools: null }), null)
})
await check('2. 只有代码新增 → codegen', async () => {
  assert.deepEqual(verdict(files(['src/new.py'])), { type: 'codegen', reason: 'codegen-new-code' })
  assert.deepEqual(verdict(files(['app/main.ts', 'lib/util.go'])), { type: 'codegen', reason: 'codegen-new-code' })
})
await check('3. 代码修改 → edit', async () => {
  assert.deepEqual(verdict(files([], ['src/app.py'])), { type: 'edit', reason: 'edit-existing-code' })
})
await check('4. 代码删除 → edit（删除按修改计入）', async () => {
  assert.deepEqual(verdict(files([], [], ['src/old.js'])), { type: 'edit', reason: 'edit-existing-code' })
})
await check('5. 只有测试新增 → testgen', async () => {
  assert.deepEqual(verdict(files(['tests/test_app.py'])), { type: 'testgen', reason: 'testgen-tests' })
  assert.deepEqual(verdict(files(['src/app.test.js'])), { type: 'testgen', reason: 'testgen-tests' })
  assert.deepEqual(verdict(files(['tests/__snapshots__/x.spec.ts'])), { type: 'testgen', reason: 'testgen-tests' })
})
await check('6. 只有文档修改 → docgen', async () => {
  assert.deepEqual(verdict(files([], ['README.md'])), { type: 'docgen', reason: 'docgen-docs' })
  assert.deepEqual(verdict(files(['docs/guide.adoc'])), { type: 'docgen', reason: 'docgen-docs' })
})
await check('7. 代码修改 + 文档新增 → edit（代码优先）', async () => {
  assert.deepEqual(verdict(files(['docs/x.md'], ['src/a.py'])), { type: 'edit', reason: 'edit-existing-code' })
  // 代码新增 + 测试修改同样以代码为主（刻意的单标签策略）。
  assert.deepEqual(verdict(files(['src/b.py'], ['tests/t_test.py'])), { type: 'codegen', reason: 'codegen-new-code' })
})
await check('8. 只有测试命令 → testrun', async () => {
  assert.deepEqual(verdict(null, [{ kind: 'test', cmd: 'pytest -q' }]), { type: 'testrun', reason: 'testrun-command' })
  assert.deepEqual(verdict(files(), [{ kind: 'test', cmd: 'npm test' }]), { type: 'testrun', reason: 'testrun-command' })
})
await check('9. 只有普通命令 → shell', async () => {
  assert.deepEqual(verdict(null, [{ kind: 'shell', cmd: 'npm run build' }]), { type: 'shell', reason: 'shell-command' })
  // 测试命令无法归类时按 shell——但 isTest 判定优先于 kind 兜底（service 侧）。
})
await check('10. 命令 + 文件改动 → 以文件为准', async () => {
  assert.deepEqual(
    verdict(files([], ['src/a.py']), [{ kind: 'test', cmd: 'pytest' }]),
    { type: 'edit', reason: 'edit-existing-code' },
  )
  assert.deepEqual(
    verdict(files(['tests/t.py']), [{ kind: 'shell', cmd: 'make' }]),
    { type: 'testgen', reason: 'testgen-tests' },
  )
})
await check('11. 未知扩展名 → null（其他不参与分类）', async () => {
  assert.equal(verdict(files(['data/blob.xyz'])), null)
  assert.equal(verdict(files(['data/blob.xyz'], [], []), [{ kind: 'shell', cmd: 'ls' }]), null)
})
await check('路径分类与测试命令的边界（不猜语义）', async () => {
  assert.equal(classifyPath('tests/unit/app_test.py'), 'test')
  assert.equal(classifyPath('__tests__\\a.spec.js'), 'test')
  assert.equal(classifyPath('src/FooTest.java'), 'test')
  assert.equal(classifyPath('src/latest.java'), 'code') // 大小写敏感的驼峰约定不误伤
  assert.equal(classifyPath('docs/api.md'), 'doc')
  assert.equal(classifyPath('CHANGES.md'), 'doc')
  assert.equal(classifyPath('Makefile'), 'code')
  assert.equal(classifyPath('Dockerfile'), 'code')
  assert.equal(classifyPath('src/app.py'), 'code')
  assert.equal(classifyPath('assets/logo.png'), null)
  assert.equal(isTestCommand('python -m pytest -q'), true)
  assert.equal(isTestCommand('go test ./...'), true)
  assert.equal(isTestCommand('gradle test --tests *'), true)
  assert.equal(isTestCommand('git commit -m "fix test"'), false)
  assert.equal(isTestCommand(''), false)
  assert.deepEqual(PRODUCIBLE_TYPES, ['codegen', 'edit', 'testgen', 'docgen', 'testrun', 'shell'])
  assert.ok(TEST_COMMAND_RE instanceof RegExp)
})

/* ------------------------------------------- service 编排（用例 12–14）--- */

/** 假 store：内存图 + rev 语义与真 store 对齐（write 一次 rev+1）。 */
function fakeStore(initialGraph) {
  const state = { graph: initialGraph, rev: initialGraph.rev ?? 5, writes: [] }
  return {
    get(project, view) {
      if (view !== undefined && view !== 'tasks') return { graph: undefined, rev: 0 }
      return { graph: state.graph, rev: state.rev, view: 'tasks' }
    },
    async write(next, options) {
      state.writes.push({ graph: next, options })
      state.graph = { ...next, rev: state.rev + 1 }
      state.rev = state.rev + 1
      return { key: 'p', view: options?.view ?? 'tasks', rev: state.rev }
    },
    state,
  }
}

/** 假 undo：dryRun 返回固定 diff；listRuns 返回固定历史。 */
function fakeUndo({ diff, runs }) {
  return {
    async dryRun() {
      if (diff === undefined) return { ok: false, error: 'no snapshot' }
      return { ok: true, files: diff }
    },
    async listRuns() {
      return { runs }
    },
  }
}

/** 假 activity：只暴露 evidenceOf（service 不得访问内部结构）。 */
function fakeActivity(evidence) {
  return { evidenceOf: () => ({ writes: evidence.writes ?? [], commands: evidence.commands ?? [] }) }
}

const fakeLogger = { warn: () => {}, event: () => {} }

const taskNode = (id, extra = {}) => ({
  id,
  type: 'task',
  title: '任务',
  status: 'done',
  pos: [0, 0],
  params: { requirement: '做点事' },
  meta: { cf: { task: true } },
  ...extra,
})

console.log('\n[service attribution]')
await check('12. 两个节点分别归属，互不串味；未归属 diff 被忽略', async () => {
  const graph = {
    format: 'codeflow/1', rev: 5,
    project: { name: 'p' },
    nodes: [
      taskNode('t1'),
      taskNode('t2'),
      taskNode('t3'),
      { id: 't4', type: 'edit', title: '既有类型', status: 'done', pos: [0, 0], params: {} },
    ],
    links: [],
  }
  const store = fakeStore(graph)
  const undo = fakeUndo({ diff: files(['src/a.py', 'tests/x_test.py', 'docs/ignored.md']) })
  const activity = fakeActivity({
    writes: [
      { nodeId: 't1', rel: 'src/a.py', tool: 'write', at: 1 },
      { nodeId: 't2', rel: 'tests/x_test.py', tool: 'write', at: 2 },
    ],
    commands: [],
  })
  const typing = createTypingService({ store, undo, activity, logger: fakeLogger })
  const result = await typing.afterTurn('p', { action: 'RUN_ALL', runId: 'r1', order: ['t1', 't2', 't3'], view: 'tasks' })
  assert.equal(result.changed, 2, 't3 无证据、t4 非任务节点都不写')
  const nodes = store.state.graph.nodes
  assert.equal(nodes.find((n) => n.id === 't1').type, 'codegen')
  assert.equal(nodes.find((n) => n.id === 't2').type, 'testgen')
  assert.equal(nodes.find((n) => n.id === 't3').type, 'task', '归属不到的文件不猜')
  assert.equal(nodes.find((n) => n.id === 't4').type, 'edit', '既有类型节点不被识别改写')
  const auto = nodes.find((n) => n.id === 't1').meta.cf.typeAuto
  assert.equal(auto.by, 'host')
  assert.equal(auto.reason, 'codegen-new-code')
  assert.deepEqual(auto.counts, { added: 1, modified: 0, deleted: 0 })
  assert.deepEqual(auto.sample, ['src/a.py'])
  assert.equal(auto.v, 1)
  assert.ok(typeof auto.at === 'string')
  assert.equal(nodes.find((n) => n.id === 't1').meta.cf.task, true, '结构标记保留')
  assert.equal(store.state.writes.length, 1, '一次运行只写一次整图')
})
await check('12b. artifacts 也可以完成归属（无写工具证据时）', async () => {
  const graph = {
    format: 'codeflow/1', rev: 1,
    project: { name: 'p' },
    nodes: [taskNode('t1', { artifacts: [{ path: 'src/gen.py', kind: 'code' }] })],
    links: [],
  }
  const store = fakeStore(graph)
  const undo = fakeUndo({ diff: files(['src/gen.py', 'unclaimed.txt']) })
  const typing = createTypingService({ store, undo, activity: fakeActivity({ writes: [], commands: [] }), logger: fakeLogger })
  const result = await typing.afterTurn('p', { action: 'RUN_NODE', runId: 'r1', nodeId: 't1', view: 'tasks' })
  assert.equal(result.changed, 1)
  assert.equal(store.state.graph.nodes[0].type, 'codegen')
})
await check('12c. diff 不可得时只保留命令证据', async () => {
  const graph = { format: 'codeflow/1', rev: 1, project: { name: 'p' }, nodes: [taskNode('t1')], links: [] }
  const store = fakeStore(graph)
  const undo = fakeUndo({ diff: undefined })
  const typing = createTypingService({ store, undo, activity: fakeActivity({ writes: [{ nodeId: 't1', rel: 'src/a.py' }], commands: [{ nodeId: 't1', cmd: 'pytest -q', isTest: true, at: 1 }] }), logger: fakeLogger })
  const result = await typing.afterTurn('p', { action: 'RUN_NODE', runId: 'r1', nodeId: 't1', view: 'tasks' })
  assert.equal(result.changed, 1)
  assert.equal(store.state.graph.nodes[0].type, 'testrun', '测试命令 → testrun')
})
await check('12d. 非任务视图 / 非 RUN 动作一律跳过', async () => {
  const graph = { format: 'codeflow/1', rev: 1, project: { name: 'p' }, nodes: [taskNode('t1')], links: [] }
  const store = fakeStore(graph)
  const undo = fakeUndo({ diff: files(['src/a.py']) })
  const typing = createTypingService({ store, undo, activity: fakeActivity({ writes: [{ nodeId: 't1', rel: 'src/a.py' }], commands: [] }), logger: fakeLogger })
  assert.deepEqual(await typing.afterTurn('p', { action: 'RUN_NODE', runId: 'r1', nodeId: 't1', view: 'modules' }), { changed: 0 })
  assert.deepEqual(await typing.afterTurn('p', { action: 'SAVE', runId: 'r1', nodeId: 't1', view: 'tasks' }), { changed: 0 })
  assert.deepEqual(await typing.afterTurn('p', { action: 'RUN_NODE', nodeId: 't1', view: 'tasks' }), { changed: 0 })
  assert.equal(store.state.writes.length, 0)
})
await check('12e. 未 done / 运行失败 / skipped 的节点不写类型', async () => {
  const graph = {
    format: 'codeflow/1', rev: 1, project: { name: 'p' },
    nodes: [
      taskNode('t1', { status: 'pending' }),
      taskNode('t2', { status: 'failed' }),
      taskNode('t3', { status: 'skipped' }),
    ],
    links: [],
  }
  const store = fakeStore(graph)
  const undo = fakeUndo({ diff: files(['src/a.py']) })
  const typing = createTypingService({ store, undo, activity: fakeActivity({ writes: [{ nodeId: 't1', rel: 'src/a.py' }, { nodeId: 't2', rel: 'src/b.py' }, { nodeId: 't3', rel: 'src/c.py' }], commands: [] }), logger: fakeLogger })
  assert.deepEqual(await typing.afterTurn('p', { action: 'RUN_ALL', runId: 'r1', order: ['t1', 't2', 't3'], view: 'tasks' }), { changed: 0 })
  assert.equal(store.state.writes.length, 0)
})
await check('12f. 异常静默降级：不向调用方抛出', async () => {
  const store = fakeStore({ format: 'codeflow/1', rev: 1, project: { name: 'p' }, nodes: [taskNode('t1')], links: [] })
  const undo = { async dryRun() { throw new Error('disk exploded') }, async listRuns() { return { runs: [] } } }
  const typing = createTypingService({ store, undo, activity: fakeActivity({ writes: [], commands: [] }), logger: fakeLogger })
  assert.deepEqual(await typing.afterTurn('p', { action: 'RUN_NODE', runId: 'r1', nodeId: 't1', view: 'tasks' }), { changed: 0 })
})

console.log('\n[service lock & idempotency]')
await check('13. 锁定节点不写；同结果不 bump rev；无改动保持 task', async () => {
  const graph = {
    format: 'codeflow/1', rev: 7,
    project: { name: 'p' },
    nodes: [
      taskNode('t1', { type: 'review', meta: { cf: { task: true, typeLocked: true, typeAuto: { v: 1, type: 'review', by: 'manual', at: 't0' } } } }),
      taskNode('t2', { type: 'edit', meta: { cf: { task: true, typeAuto: { v: 1, type: 'edit', by: 'host', at: 't0', reason: 'edit-existing-code', counts: { added: 0, modified: 1, deleted: 0 }, sample: ['src/a.py'] } } } }),
      taskNode('t3'),
    ],
    links: [],
  }
  const store = fakeStore(graph)
  const undo = fakeUndo({ diff: files([], ['src/a.py']) })
  const activity = fakeActivity({ writes: [{ nodeId: 't3', rel: 'src/a.py', tool: 'write', at: 1 }], commands: [] })
  const typing = createTypingService({ store, undo, activity, logger: fakeLogger })
  const result = await typing.afterTurn('p', { action: 'RUN_ALL', runId: 'r1', order: ['t1', 't2', 't3'], view: 'tasks' })
  assert.equal(result.changed, 1, 't1 锁定跳过、t2 幂等跳过、t3 首次识别')
  const nodes = store.state.graph.nodes
  assert.equal(nodes.find((n) => n.id === 't1').type, 'review', '锁定不被覆盖')
  assert.equal(nodes.find((n) => n.id === 't2').type, 'edit')
  assert.equal(nodes.find((n) => n.id === 't2').meta.cf.typeAuto.at, 't0', '幂等：typeAuto 未被重写')
  assert.equal(store.state.rev, 8, '只有 t3 的写入 bump 了一次 rev')
  // 再跑一遍：全部幂等，rev 不动。
  const again = await typing.afterTurn('p', { action: 'RUN_ALL', runId: 'r1', order: ['t1', 't2', 't3'], view: 'tasks' })
  assert.equal(again.changed, 0)
  assert.equal(store.state.rev, 8, '重复调用 afterTurn 结果一致（不重复 bump）')
})
await check('13b. params.requirement 与 title 永不被识别改写', async () => {
  const graph = { format: 'codeflow/1', rev: 1, project: { name: 'p' }, nodes: [taskNode('t1', { title: '我的任务' })], links: [] }
  const store = fakeStore(graph)
  const undo = fakeUndo({ diff: files(['src/a.py']) })
  const typing = createTypingService({ store, undo, activity: fakeActivity({ writes: [{ nodeId: 't1', rel: 'src/a.py' }], commands: [] }), logger: fakeLogger })
  await typing.afterTurn('p', { action: 'RUN_NODE', runId: 'r1', nodeId: 't1', view: 'tasks' })
  const node = store.state.graph.nodes[0]
  assert.equal(node.title, '我的任务')
  assert.deepEqual(node.params, { requirement: '做点事' })
})

console.log('\n[reidentify guard]')
await check('14. 最近一次运行不是该节点 → applied:false', async () => {
  const graph = { format: 'codeflow/1', rev: 1, project: { name: 'p' }, nodes: [taskNode('t1'), taskNode('t2')], links: [] }
  const store = fakeStore(graph)
  const undo = fakeUndo({ diff: files(['src/a.py']), runs: [{ runId: 'r9', nodeId: 't2', view: 'tasks', status: 'complete', undoable: true }] })
  const typing = createTypingService({ store, undo, activity: fakeActivity({ writes: [{ nodeId: 't1', rel: 'src/a.py' }], commands: [] }), logger: fakeLogger })
  assert.deepEqual(await typing.reidentify('p', { view: 'tasks', nodeId: 't1' }), { applied: false })
  assert.equal(store.state.writes.length, 0)
})
await check('14b. 最近一次运行就是该节点 → 按证据立即识别', async () => {
  const graph = { format: 'codeflow/1', rev: 1, project: { name: 'p' }, nodes: [taskNode('t1')], links: [] }
  const store = fakeStore(graph)
  const undo = fakeUndo({ diff: files([], ['src/a.py']), runs: [{ runId: 'r9', nodeId: 't1', view: 'tasks', status: 'complete', undoable: true }] })
  const typing = createTypingService({ store, undo, activity: fakeActivity({ writes: [{ nodeId: 't1', rel: 'src/a.py' }], commands: [] }), logger: fakeLogger })
  const result = await typing.reidentify('p', { view: 'tasks', nodeId: 't1' })
  assert.deepEqual(result, { applied: true, type: 'edit', reason: 'edit-existing-code' })
  assert.equal(store.state.graph.nodes[0].type, 'edit')
})
await check('14c. 无证据 / 锁定 / 模块图运行 → applied:false', async () => {
  const graph = {
    format: 'codeflow/1', rev: 1, project: { name: 'p' },
    nodes: [taskNode('t1'), taskNode('t2', { meta: { cf: { task: true, typeLocked: true } } }), taskNode('t3', { status: 'pending' })],
    links: [],
  }
  const store = fakeStore(graph)
  const undo = fakeUndo({ diff: files([], ['src/a.py']), runs: [{ runId: 'r9', nodeId: 't1', view: 'tasks', status: 'complete', undoable: true }] })
  const typing = createTypingService({ store, undo, activity: fakeActivity({ writes: [], commands: [] }), logger: fakeLogger })
  assert.deepEqual(await typing.reidentify('p', { view: 'tasks', nodeId: 't1' }), { applied: false }, '无证据')
  const undoLocked = fakeUndo({ diff: files(['src/a.py']), runs: [{ runId: 'r9', nodeId: 't2', view: 'tasks', status: 'complete', undoable: true }] })
  const typing2 = createTypingService({ store, undo: undoLocked, activity: fakeActivity({ writes: [{ nodeId: 't2', rel: 'src/a.py' }], commands: [] }), logger: fakeLogger })
  assert.deepEqual(await typing2.reidentify('p', { view: 'tasks', nodeId: 't2' }), { applied: false }, '锁定')
  const undoModules = fakeUndo({ diff: files(['src/a.py']), runs: [{ runId: 'r9', nodeId: 't1', view: 'modules', status: 'complete', undoable: true }] })
  const typing3 = createTypingService({ store, undo: undoModules, activity: fakeActivity({ writes: [{ nodeId: 't1', rel: 'src/a.py' }], commands: [] }), logger: fakeLogger })
  assert.deepEqual(await typing3.reidentify('p', { view: 'tasks', nodeId: 't1' }), { applied: false }, '最近一次运行是模块图')
  const undoPending = fakeUndo({ diff: files(['src/a.py']), runs: [{ runId: 'r9', nodeId: 't3', view: 'tasks', status: 'complete', undoable: true }] })
  const typing4 = createTypingService({ store, undo: undoPending, activity: fakeActivity({ writes: [{ nodeId: 't3', rel: 'src/a.py' }], commands: [] }), logger: fakeLogger })
  assert.deepEqual(await typing4.reidentify('p', { view: 'tasks', nodeId: 't3' }), { applied: false }, '节点未 done')
})

/* ----------------------------------------- 撤销回滚（用例 15，真组件）---- */

console.log('\n[undo rolls back type/typeAuto/typeLocked]')
await check('15. 运行 → 自动识别 → 撤销 → 回到 task；其余 meta.cf 键保留', async () => {
  const workspace = await makeTempDir('codeflow-typing-ws-')
  const dir = path.join(workspace, 'CodeFlow', 'flow-projects', 'typing-demo')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src', 'app.py'), 'print("v1")\n', 'utf8')
  const store = createStore(console)
  await store.write({
    format: 'codeflow/1', rev: 0,
    project: { name: 'typing-demo', language: 'python', origin: 'new' },
    nodes: [{
      id: 't1', type: 'task', title: '任务', status: 'pending', pos: [0, 0], params: { requirement: '改代码' },
      meta: { cf: { task: true, stale: true } },
    }],
    links: [],
  }, { persist: 'now' })
  store.bindCwd('typing-demo', workspace)

  const undo = createUndoManager({ store, logger: console, limits: { ...UNDO_LIMITS } })
  const typing = createTypingService({
    store,
    undo,
    activity: fakeActivity({ writes: [{ nodeId: 't1', rel: 'src/app.py', tool: 'edit', at: 1 }], commands: [] }),
    logger: console,
  })

  const snap = await undo.beginRun('typing-demo', { action: 'RUN_NODE', nodeId: 't1', nodes: store.get('typing-demo').graph.nodes, view: 'tasks' })
  assert.equal(snap.undoable, true, snap.reason)
  try {
    // agent 真实改了文件并把节点置 done。
    await writeFile(path.join(dir, 'src', 'app.py'), 'print("v2")\n', 'utf8')
    store.patchNode('typing-demo', 't1', { status: 'done', result: '修改 1 个文件' })
    const applied = await typing.afterTurn('typing-demo', { action: 'RUN_NODE', runId: snap.runId, nodeId: 't1', view: 'tasks' })
    assert.equal(applied.changed, 1, '识别生效')
    // 与生产装配同序：识别 → finishRun（释放运行锁）→ 才能撤销。
    await undo.finishRun('typing-demo', snap.runId)
    let node = store.get('typing-demo').graph.nodes[0]
    assert.equal(node.type, 'edit')
    assert.equal(node.meta.cf.typeAuto.reason, 'edit-existing-code')
    assert.equal(node.meta.cf.task, true)
    assert.equal(node.meta.cf.stale, true, '运行前的其它 cf 键原样保留')

    // 撤销：type/typeAuto 回到运行前（task、无 typeAuto），文件一起回滚。
    const restored = await undo.restore('typing-demo', snap.runId)
    assert.equal(restored.ok, true, restored.error)
    node = store.get('typing-demo').graph.nodes[0]
    assert.equal(node.type, 'task', 'type 回到运行前')
    assert.equal(node.meta.cf.typeAuto, undefined, 'typeAuto 被移除')
    assert.equal(node.meta.cf.typeLocked, undefined, 'typeLocked 被移除')
    assert.equal(node.meta.cf.task, true, '结构标记永不删除')
    assert.equal(node.meta.cf.stale, true, '其余 meta.cf 键不被整块覆盖')
    assert.equal(node.status, 'pending', '执行状态一并回滚')
    assert.equal(node.params.requirement, '改代码', '要求文本不动')
  } finally {
    await undo.releaseRun('typing-demo')
    await rm(workspace, { recursive: true, force: true })
  }
})
await check('15b. 旧 manifest（无 type/typeState 字段）恢复时保持现状', async () => {
  const workspace = await makeTempDir('codeflow-typing-old-')
  const dir = path.join(workspace, 'CodeFlow', 'flow-projects', 'old-demo')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src', 'app.py'), 'print("v1")\n', 'utf8')
  const store = createStore(console)
  await store.write({
    format: 'codeflow/1', rev: 0,
    project: { name: 'old-demo' },
    nodes: [{ id: 't1', type: 'task', title: '任务', status: 'pending', pos: [0, 0], params: {}, meta: { cf: { task: true } } }],
    links: [],
  }, { persist: 'now' })
  store.bindCwd('old-demo', workspace)
  const undo = createUndoManager({ store, logger: console, limits: { ...UNDO_LIMITS } })
  const snap = await undo.beginRun('old-demo', { action: 'RUN_NODE', nodeId: 't1', nodes: store.get('old-demo').graph.nodes, view: 'tasks' })
  try {
    // 手工把 manifest 退化成 v1.4 时代的形状（去掉 type/typeState）。
    const manifestPath = path.join(dir, '.undo', snap.runId, 'manifest.json')
    const { readFile, writeFile: writeFileAsync } = await import('node:fs/promises')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.beforeNodes = manifest.beforeNodes.map((entry) => {
      const { type, typeState, ...legacy } = entry
      return legacy
    })
    await writeFileAsync(manifestPath, JSON.stringify(manifest), 'utf8')
    // 运行后节点被识别为 edit。
    store.patchNode('old-demo', 't1', { status: 'done' })
    const graph = store.get('old-demo').graph
    graph.nodes[0].type = 'edit'
    graph.nodes[0].meta = { cf: { task: true, typeAuto: { v: 1, type: 'edit', by: 'host', at: 'x', reason: 'edit-existing-code' } } }

    await undo.finishRun('old-demo', snap.runId)
    const restored = await undo.restore('old-demo', snap.runId)
    assert.equal(restored.ok, true, restored.error)
    const node = store.get('old-demo').graph.nodes[0]
    assert.equal(node.type, 'edit', '旧 manifest：type 保持现状（兼容）')
    assert.ok(node.meta.cf.typeAuto, '旧 manifest：typeAuto 保持现状')
    assert.equal(node.meta.cf.task, true)
    assert.equal(node.status, 'pending', '执行状态照常回滚')
  } finally {
    await undo.releaseRun('old-demo')
    await rm(workspace, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------- 输出 ------ */

console.log(`\n[summary] typing: ${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
