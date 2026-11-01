/**
 * 状态与撤销检查：中文文件名、逐视图修订号、运行前快照与 LIFO 恢复。
 *
 * macOS 上撤销失败的典型现场是：项目目录里既有中文/空格文件名，又有
 * `node_modules` 或 `.git` 这类必须排除的目录；快照范围一旦算错，要么
 * 把依赖目录整个复制一遍，要么恢复时把不该动的文件删掉。这里用一棵同时
 * 含中文名、NFD 名与排除目录的树，完整跑一遍 begin → 修改 → finish →
 * dryRun → restore。
 *
 * @module tests/mac/checks/state
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { ageFiles } from '../lib/fixtures.mjs'
import { makeGraph } from '../lib/harness.mjs'

/**
 * 运行状态与撤销检查。
 *
 * @param ctx - 套件上下文。
 */
export async function runStateChecks(ctx) {
  const { pluginRoot, runner } = ctx
  runner.group('状态、修订号与撤销（中文文件名）')

  const { createStore, projectDirPath, projectKeyOf } = await ctx.load('lib/store.js')
  const { createUndoManager } = await ctx.load('lib/undo.js')
  const logger = { warn() {}, info() {}, error() {} }

  await runner.check('ST-01', '中文项目：写盘 → 新 store 重载 → 图与视口一致', async () => {
    const workspace = await ctx.temp('state-reload-')
    const store = createStore(logger)
    const name = '状态 项目'
    const key = projectKeyOf(name)
    const dir = projectDirPath(workspace, key)
    const graph = makeGraph(name, { nodes: ['n1', 'n2', 'n3'] })
    for (const [index, node] of graph.nodes.entries()) node.result = `结果 ${index + 1}`
    const written = await store.write(graph, { persist: 'now', cwd: workspace, dir, viewport: [8, 9, 1.25] })
    if (written.persisted !== true) throw new Error('写盘失败')
    // 视口与激活视图由 flush（保存按钮）写入 view.json；自动保存只写图本身。
    const flushed = await store.flush(name, 'tasks')
    if (flushed?.persisted === false) throw new Error(`保存失败：${flushed.error}`)

    const fresh = createStore(logger)
    const loaded = await fresh.load(name, workspace, dir)
    if (loaded.results.tasks?.error !== undefined) throw new Error(`重载报错：${loaded.results.tasks.error}`)
    const state = fresh.get(name)
    if (state.graph.nodes.length !== 3) throw new Error(`重载后节点数 ${state.graph.nodes.length}`)
    if (!state.graph.nodes.every((node) => /结果/.test(node.result))) throw new Error('节点结果丢失')
    if (JSON.stringify(state.viewport) !== JSON.stringify([8, 9, 1.25])) throw new Error(`视口=${JSON.stringify(state.viewport)}`)
    return `${dir}`
  })

  await runner.check('ST-02', '逐视图修订号：写 tasks 不推进 modules，反之亦然', async () => {
    const workspace = await ctx.temp('state-rev-')
    const store = createStore(logger)
    const name = '双图 项目'
    const dir = projectDirPath(workspace, projectKeyOf(name))
    await store.write(makeGraph(name), { persist: 'now', cwd: workspace, dir, view: 'tasks' })
    await store.write(makeGraph(name, { view: 'modules' }), { persist: 'now', cwd: workspace, dir, view: 'modules' })
    const tasksRev = store.get(name, 'tasks').rev
    const modulesRev = store.get(name, 'modules').rev
    if (tasksRev !== 1 || modulesRev !== 1) throw new Error(`初始修订号 tasks=${tasksRev} modules=${modulesRev}`)
    await store.write(makeGraph(name, { nodes: ['n1', 'n2', 'n3'] }), { persist: 'now', cwd: workspace, dir, view: 'tasks' })
    if (store.get(name, 'modules').rev !== modulesRev) throw new Error('写 tasks 推进了 modules 的 rev')
    const after = await store.write(makeGraph(name, { view: 'modules', nodes: ['m1', 'm2', 'm3'] }), {
      persist: 'now', cwd: workspace, dir, view: 'modules',
    })
    if (after.rev !== 2) throw new Error(`modules rev=${after.rev}`)
    if (store.get(name, 'tasks').rev !== 2) throw new Error('写 modules 没有保持 tasks 的独立计数')
    return 'tasks 与 modules 的 rev 互不影响'
  })

  await runner.check('ST-03', '撤销：中文/空格/NFD 文件恢复，新建文件删除，排除目录不动', async () => {
    const workspace = await ctx.temp('state-undo-')
    const store = createStore(logger)
    const name = '撤销 项目'
    const key = projectKeyOf(name)
    const dir = projectDirPath(workspace, key)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await mkdir(path.join(dir, 'docs'), { recursive: true })
    await mkdir(path.join(dir, 'node_modules', 'decoy'), { recursive: true })
    await mkdir(path.join(dir, '.git'), { recursive: true })

    const nfdName = 'src/café 笔记.txt'.normalize('NFD')
    const files = {
      'src/用户模块.js': 'export const user = 1\n',
      'src/订单 处理.py': 'total = 1\n',
      [nfdName]: '咖啡\n',
      'docs/说明.md': '# 说明\n',
      'node_modules/decoy/index.js': 'module.exports = "dependency"\n',
      '.git/config': '[core]\n',
    }
    for (const [rel, contents] of Object.entries(files)) {
      await writeFile(path.join(dir, rel), contents, 'utf8')
    }
    await ageFiles(dir, Object.keys(files), 120)

    const graph = makeGraph(name, { nodes: ['n1'] })
    // 任务图的第一个节点默认是 done（makeGraph 的通用形状）；这里要验证
    // "运行前的 pending 状态被恢复"，所以先显式置空。
    for (const node of graph.nodes) {
      node.status = 'pending'
      node.result = ''
      node.detail = ''
    }
    await store.write(graph, { persist: 'now', cwd: workspace, dir, view: 'tasks' })

    const undo = createUndoManager({ store, logger })
    const snapshot = await undo.beginRun(name, { action: 'RUN_NODE', nodeId: 'n1', nodes: graph.nodes, view: 'tasks' })
    if (snapshot.undoable !== true) throw new Error(`快照不可撤销：${snapshot.reason}`)

    // 运行期间的变化：改一个、删一个、加一个，并推进节点。
    await writeFile(path.join(dir, 'src/用户模块.js'), 'export const user = 2 // 运行时修改\n', 'utf8')
    const { rm } = await import('node:fs/promises')
    await rm(path.join(dir, 'src/订单 处理.py'))
    await writeFile(path.join(dir, 'src/新文件.txt'), 'run output\n', 'utf8')
    await writeFile(path.join(dir, 'node_modules/decoy/index.js'), 'module.exports = "changed by run"\n', 'utf8')
    store.patchNode(name, 'n1', { status: 'done', result: '运行完成' }, { view: 'tasks' })
    await store.flush(name, 'tasks')
    await undo.finishRun(name, snapshot.runId)

    const preview = await undo.dryRun(name, snapshot.runId)
    if (preview.ok !== true) throw new Error(`dryRun 失败：${preview.error}`)
    if (!preview.files.added.includes('src/新文件.txt')) throw new Error(`dryRun 没有识别新增：${JSON.stringify(preview.files)}`)
    if (!preview.files.deleted.includes('src/订单 处理.py')) throw new Error('dryRun 没有识别删除')

    const restored = await undo.restore(name, snapshot.runId)
    if (restored.ok !== true) throw new Error(`恢复失败：${restored.error}`)
    if ((await readFile(path.join(dir, 'src/用户模块.js'), 'utf8')) !== files['src/用户模块.js']) {
      throw new Error('被修改的中文文件没有恢复')
    }
    if ((await readFile(path.join(dir, 'src/订单 处理.py'), 'utf8')) !== files['src/订单 处理.py']) {
      throw new Error('被删除的中文文件没有恢复')
    }
    if ((await readFile(path.join(dir, nfdName), 'utf8')) !== files[nfdName]) throw new Error('NFD 文件没有恢复')
    if (await stat(path.join(dir, 'src/新文件.txt')).catch(() => undefined) !== undefined) {
      throw new Error('运行新建的文件没有被删除')
    }
    if ((await readFile(path.join(dir, 'node_modules/decoy/index.js'), 'utf8')).includes('dependency')) {
      throw new Error('node_modules 被错误恢复（本应完全排除）')
    }
    if (store.get(name, 'tasks').graph.nodes[0].status !== 'pending') throw new Error('节点状态没有恢复')
    if (store.get(name, 'tasks').graph.nodes[0].result !== '') throw new Error('节点结果没有清空')
    const backups = (await readdir(path.join(dir, '.undo', snapshot.runId))).filter((entry) => entry.startsWith('current-'))
    if (backups.length === 0) throw new Error('撤销前没有备份当前状态')
    return `恢复 ${restored.files.modified?.length ?? 0} 改 / ${restored.files.deleted?.length ?? 0} 删 / ${restored.files.added?.length ?? 0} 增`
  })

  await runner.check('ST-04', '撤销严格 LIFO：更新的运行未撤销时拒绝旧运行', async () => {
    const workspace = await ctx.temp('state-lifo-')
    const store = createStore(logger)
    const name = 'LIFO 项目'
    const dir = projectDirPath(workspace, projectKeyOf(name))
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'a.txt'), 'a0', 'utf8')
    await store.write(makeGraph(name, { nodes: ['n1'] }), { persist: 'now', cwd: workspace, dir })
    const undo = createUndoManager({ store, logger })

    const one = await undo.beginRun(name, { action: 'RUN_NODE', nodeId: 'n1', nodes: [], view: 'tasks' })
    await writeFile(path.join(dir, 'a.txt'), 'a1', 'utf8')
    await undo.finishRun(name, one.runId)

    const two = await undo.beginRun(name, { action: 'RUN_NODE', nodeId: 'n1', nodes: [], view: 'tasks' })
    await writeFile(path.join(dir, 'a.txt'), 'a2', 'utf8')
    await undo.finishRun(name, two.runId)

    const stale = await undo.restore(name, one.runId)
    if (stale.ok !== false || stale.code !== 409) throw new Error(`旧运行没有被拒绝：${JSON.stringify(stale)}`)
    const second = await undo.restore(name, two.runId)
    if (second.ok !== true) throw new Error(`撤销最新运行失败：${second.error}`)
    const first = await undo.restore(name, one.runId)
    if (first.ok !== true) throw new Error(`撤销旧运行失败：${first.error}`)
    const content = await readFile(path.join(dir, 'a.txt'), 'utf8')
    if (content !== 'a0') throw new Error(`最终内容为 ${JSON.stringify(content)}，期望 a0`)
    return 'LIFO 顺序正确，最终回到 a0'
  })

  await runner.check('ST-05', '撤销快照不越过项目根（不会碰父目录）', async () => {
    const workspace = await ctx.temp('state-scope-')
    const store = createStore(logger)
    const name = '边界 项目'
    const dir = projectDirPath(workspace, projectKeyOf(name))
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(workspace, '父目录文件.txt'), 'do not touch', 'utf8')
    await writeFile(path.join(dir, 'inner.txt'), 'inner', 'utf8')
    await store.write(makeGraph(name, { nodes: ['n1'] }), { persist: 'now', cwd: workspace, dir })
    const undo = createUndoManager({ store, logger })
    const run = await undo.beginRun(name, { action: 'RUN_ALL', order: ['n1'], nodes: [], view: 'tasks' })
    await rmFile(path.join(dir, 'inner.txt'))
    await undo.finishRun(name, run.runId)
    const restored = await undo.restore(name, run.runId)
    if (restored.ok !== true) throw new Error(`恢复失败：${restored.error}`)
    if ((await readFile(path.join(workspace, '父目录文件.txt'), 'utf8')) !== 'do not touch') {
      throw new Error('项目根之外的文件被改动')
    }
    if ((await readFile(path.join(dir, 'inner.txt'), 'utf8')) !== 'inner') throw new Error('项目内文件没有恢复')
    return '父目录未受影响'
  })
}

/** 小助手：删除文件（避免在每个用例里重复 import）。 */
async function rmFile(file) {
  const { rm } = await import('node:fs/promises')
  await rm(file, { force: true })
}
