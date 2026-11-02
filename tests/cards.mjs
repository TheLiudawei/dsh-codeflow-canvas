/**
 * 任务卡片持久化（v1.3.0，需求三）——任务书 §6.8 用例：
 *
 *   - cardKeyOf：路径分隔符/大小写/符号；源锚点；手工节点标题修改后 key 不变；
 *   - mergeCards：全匹配/新增/失效/标题保留/params 保留 + drift/类型隔离/
 *     id 冲突改名/输入不可变/确定性；
 *   - 配置：默认值、坏类型回退、未知字段保留、POST /api/config 校验；
 *   - e2e：开启持久化 → 两次导入合并（状态/位置/标题保留）；关闭 → 覆盖；
 *     meta.cf / meta.cards 经 store 落盘不被清洗。
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/cards.mjs
 */
import './_log-off.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)

const { cardKeyOf, normalizePathKey, hashKey } = await load('lib/cards/identity.js')
const { mergeCards } = await load('lib/cards/merge.js')
const { readConfig, writeConfig } = await load('lib/codeflow-config.js')
const { createRouter } = await load('lib/routes.js')
const { createStore } = await load('lib/store.js')
const { createGestureDispatcher } = await load('lib/gestures.js')
const { createActivityHub } = await load('lib/activity.js')
const { createUndoManager } = await load('lib/undo.js')

let passed = 0
const ok = (name) => { passed += 1; console.log('  ok ', name) }
const NOW = '2026-11-02T08:00:00.000Z'
const now = () => NOW

const node = (over = {}) => ({
  id: 't1', type: 'edit', title: '修复登录', pos: [0, 0],
  params: { instruction: 'src/auth.py:12 修复空指针' },
  status: 'pending', result: '', detail: '',
  ...over,
})

/* --------------------------------------------------------- 1. cardKeyOf -- */
{
  assert.equal(cardKeyOf(node()), 'task:edit:src/auth.py:12', 'instruction 里的 文件:行')
  assert.equal(cardKeyOf(node({ params: { instruction: 'FIXME 处理空输入' } })), `task:edit:marker:FIXME:${hashKey('FIXME 处理空输入')}`, '标记锚点')
  assert.equal(cardKeyOf(node({ params: { path: 'src\\auth.py', instruction: '' } })), 'task:edit:src/auth.py', 'params.path 锚点（分隔符归一）')
  assert.equal(cardKeyOf(node({ params: {}, title: '  修复  登录 ' })), `task:edit:title:${hashKey('修复 登录')}`, '标题哈希兜底（空白折叠）')
  assert.equal(cardKeyOf(node({ type: 'module', params: { path: 'Src\\A.py', symbol: 'main' } }, ), undefined), undefined ?? cardKeyOf({ type: 'module', params: { path: 'Src\\A.py', symbol: 'main' } }, { platform: 'win32' }), '占位')
  assert.equal(cardKeyOf({ type: 'module', params: { path: 'Src\\A.py', symbol: 'main' } }, { platform: 'win32' }), 'module:src/a.py:main', 'module：win32 大小写不敏感 + 分隔符')
  assert.equal(cardKeyOf({ type: 'module', params: { path: 'Src/A.py', symbol: 'main' } }, { platform: 'linux' }), 'module:Src/A.py:main', 'module：POSIX 区分大小写')
  assert.equal(cardKeyOf({ type: 'scan' }), 'flow:scan')
  assert.equal(cardKeyOf({ type: 'comments' }), 'flow:comments')
  const manual = { type: 'requirement', title: '需求一', meta: { cf: { key: 'manual:keep-me' } } }
  assert.equal(cardKeyOf(manual), 'manual:keep-me', 'meta.cf.key 直接返回')
  manual.title = '改成别的名字'
  assert.equal(cardKeyOf(manual), 'manual:keep-me', '手工节点改标题后 key 不变')
  ok('cardKeyOf：锚点/归一化/持久化 key 规则')
}

/* --------------------------------------------------------- 2. mergeCards - */
{
  /* 完全相同 → 全匹配，字段保留。 */
  const oldGraph = { format: 'codeflow/1', rev: 5, project: { name: 'p' }, nodes: [
    node({ id: 't1', status: 'done', result: 'ok', detail: 'd', pos: [10, 20], title: '修复登录', meta: { cf: { key: 'task:edit:src/auth.py:12', importedTitle: '修复登录', importedParamsHash: hashKey('{"instruction":"src/auth.py:12 修复空指针"}'), stale: false, mergedAt: '2026-01-01T00:00:00.000Z' } } }),
  ], links: [], meta: {} }
  const newGraph = { format: 'codeflow/1', rev: 0, project: { name: 'p' }, nodes: [
    node({ id: 'n1', title: '修复登录 v2' }),
  ], links: [], meta: {} }
  const r1 = mergeCards({ existingGraph: oldGraph, importedGraph: newGraph, now })
  assert.equal(r1.stats.matched, 1)
  assert.equal(r1.stats.added, 0)
  assert.equal(r1.stats.keptStale, 0)
  assert.equal(r1.graph.nodes[0].id, 'n1', 'id 以新图为准')
  assert.equal(r1.graph.nodes[0].status, 'done')
  assert.equal(r1.graph.nodes[0].result, 'ok')
  assert.deepEqual(r1.graph.nodes[0].pos, [10, 20])
  assert.equal(r1.graph.nodes[0].title, '修复登录 v2', '旧标题未改过（=导入快照）→ 采用新导入标题')
  assert.equal(r1.graph.meta.cards.schema, 1)
  assert.equal(r1.graph.meta.cards.persist, true)
  /* 标题被用户改过 → 保留用户标题。 */
  const r2 = mergeCards({
    existingGraph: { ...oldGraph, nodes: [{ ...oldGraph.nodes[0], title: '我改过的标题' }] },
    importedGraph: newGraph, now,
  })
  assert.equal(r2.graph.nodes[0].title, '我改过的标题', '用户标题保留')
  ok('mergeCards：全匹配字段保留 + 用户标题保留')
}
{
  /* 新增 / 删除（失效）/ 类型隔离 / id 冲突改名 / 输入不可变 / 确定性。
     每个节点有独立源锚点，避免 key 撞车干扰匹配语义。 */
  const oldGraph = { format: 'codeflow/1', rev: 2, project: { name: 'p' }, nodes: [
    node({ id: 'a', title: '任务A', params: { instruction: 'src/a.py:1 任务A' } }),
    node({ id: 'b', type: 'review', title: '审查B', status: 'done', result: 'r', params: { instruction: 'src/b.py:1 审查B' } }),
    node({ id: 'gone', type: 'edit', title: '已删除', status: 'done', params: { instruction: 'src/g.py:1 已删除' } }),
    node({ id: 'was-running', type: 'deliver', title: '运行中', status: 'running', result: '半截', params: { instruction: 'src/w.py:1 运行中' } }),
  ], links: [['a', 0, 'gone', 0]], meta: {} }
  const newGraph = { format: 'codeflow/1', rev: 0, project: { name: 'p' }, nodes: [
    node({ id: 'n1', title: '任务A', params: { instruction: 'src/a.py:1 任务A' } }),
    node({ id: 'n2', type: 'review', title: '审查B', params: { instruction: 'src/b.py:1 审查B' } }),
    node({ id: 'gone', type: 'review', title: '新扫描占位（与旧失效 id 冲突）', params: { instruction: 'src/g.py:2 占位' } }),
  ], links: [['n1', 0, 'n2', 0]], meta: {} }
  const snapshot = JSON.stringify(newGraph)
  const r = mergeCards({ existingGraph: oldGraph, importedGraph: newGraph, now })
  assert.deepEqual(r.stats, { matched: 2, added: 1, keptStale: 2, paramsDrift: 0 })
  assert.equal(JSON.stringify(newGraph), snapshot, '输入未被修改')
  const ids = r.graph.nodes.map((n) => n.id)
  assert.equal(ids.length, new Set(ids).size, 'id 唯一')
  const stale = r.graph.nodes.filter((n) => n.meta?.cf?.stale === true)
  assert.equal(stale.length, 2, '两张失效卡片')
  assert.ok(stale.every((n) => n.links === undefined), '失效卡片不保留旧 links')
  assert.ok(stale.some((n) => n.id === 'gone-stale-1'), 'id 与新图冲突 → 改名 -stale-1')
  const running = stale.find((n) => n.id === 'was-running')
  assert.equal(running.status, 'failed', '旧 running → failed')
  assert.ok(String(running.result).includes('重新导入时该卡片未完成'), '中断提示写入 result')
  assert.deepEqual(r.graph.links, [['n1', 0, 'n2', 0]], 'links 以新图为准')
  const added = r.graph.nodes.find((n) => n.id === 'gone' && n.meta?.cf?.stale !== true)
  assert.equal(added.meta.cf.importedTitle, '新扫描占位（与旧失效 id 冲突）', '新增节点写入导入快照')
  const r2 = mergeCards({ existingGraph: oldGraph, importedGraph: newGraph, now })
  assert.equal(JSON.stringify(r2.graph), JSON.stringify(r.graph), '两次合并逐字节一致')
  /* 类型不同但标题相同 → 不匹配（类型隔离）。 */
  const iso = mergeCards({
    existingGraph: { nodes: [node({ id: 'old', type: 'review', title: '同名', params: { instruction: 'src/x.py:1' } })], links: [], meta: {} },
    importedGraph: { nodes: [node({ id: 'new', type: 'edit', title: '同名', params: { instruction: 'src/x.py:1' } })], links: [], meta: {} },
    now,
  })
  assert.deepEqual(iso.stats, { matched: 0, added: 1, keptStale: 1, paramsDrift: 0 }, '类型隔离：不把进度贴错类型')
  ok('mergeCards：新增/失效/类型隔离/id 改名/不可变/确定性')
}
{
  /* params 保留 + drift；用户改过的 params 不被新扫描覆盖。 */
  const oldHash = hashKey('{"instruction":"src/auth.py:12 修复空指针"}')
  const oldGraph = { nodes: [
    node({ id: 'a', status: 'done', meta: { cf: { key: 'task:edit:src/auth.py:12', importedTitle: '修复登录', importedParamsHash: oldHash, stale: false, mergedAt: '2026-01-01T00:00:00.000Z' } } }),
  ], links: [], meta: {} }
  /* 新扫描的 params 变了（源码侧变化）。 */
  const newGraph = { nodes: [node({ id: 'n1', params: { instruction: 'src/auth.py:40 修复空指针' } })], links: [], meta: {} }
  const r = mergeCards({ existingGraph: oldGraph, importedGraph: newGraph, now })
  assert.equal(r.stats.paramsDrift, 1, '源码侧变化 → paramsDrift')
  assert.equal(r.graph.nodes[0].params.instruction, 'src/auth.py:12 修复空指针', '保留用户现有 params')
  assert.equal(r.graph.nodes[0].meta.cf.paramsDrift, true)
  assert.equal(r.graph.nodes[0].meta.cf.importedParamsHash, hashKey('{"instruction":"src/auth.py:40 修复空指针"}'), '导入快照取自新扫描')
  /* 用户改过 params（旧 params ≠ 旧导入哈希）→ 同样保留用户值。 */
  const modified = mergeCards({
    existingGraph: { nodes: [node({ id: 'a', params: { instruction: '我手改的指令' }, meta: { cf: { key: 'task:edit:src/auth.py:12', importedTitle: '修复登录', importedParamsHash: oldHash } } })], links: [], meta: {} },
    importedGraph: { nodes: [node({ id: 'n1' })], links: [], meta: {} },
    now,
  })
  assert.equal(modified.graph.nodes[0].params.instruction, '我手改的指令', '用户 params 修改保留')
  ok('mergeCards：params 保留 + paramsDrift')
}

/* ------------------------------------------------------------ 3. 配置 --- */
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-cards-cfg-'))
  /* 默认值。 */
  const empty = await readConfig(workspace)
  assert.deepEqual(empty.cards, { persist: false, asked: false })
  /* 写入 + 回读 + 未知字段保留（writeConfig 合并 extra——读-改-写绝不丢字段）。 */
  await writeConfig(workspace, { ...empty, cards: { persist: true, asked: true }, extra: { futureField: { a: 1 } } })
  const reread = JSON.parse(await readFile(path.join(workspace, 'CodeFlow', 'config.json'), 'utf8'))
  assert.deepEqual(reread.futureField, { a: 1 }, '未知字段写盘保留')
  assert.equal(reread.cards.persist, true)
  /* 坏类型回退（文件里同时带未知字段，验证读-改-写不丢）。 */
  await writeFile(path.join(workspace, 'CodeFlow', 'config.json'), JSON.stringify({ cards: { persist: 'yes', asked: 1 }, root: null, futureField: { a: 1 } }))
  const bad = await readConfig(workspace)
  assert.deepEqual(bad.cards, { persist: false, asked: false }, '非布尔逐项回退默认')
  /* 读-改-写不丢未知字段。 */
  const merged = await readConfig(workspace)
  merged.extra.futureField = { a: 2 }
  await writeConfig(workspace, merged)
  const final = JSON.parse(await readFile(path.join(workspace, 'CodeFlow', 'config.json'), 'utf8'))
  assert.deepEqual(final.futureField, { a: 2 }, '读-改-写保留未知字段')
  await rm(workspace, { recursive: true, force: true })
  ok('配置：默认值/坏类型回退/未知字段读-改-写保留')
}

/* --------------------------------------------------- 4. 路由与 e2e ------ */
{
  const workspace = await mkdtemp(path.join(tmpdir(), 'codeflow-cards-e2e-'))
  const store = createStore(console)
  /* 真实 gestures 投递层（含失效卡片守卫与乐观置 running），只把会话/快照
     依赖换成最小假件。 */
  const sessions = {
    workspaceOf: async () => workspace,
    workspaceOfEx: async () => ({ workspace }),
    current: () => 's-cards',
    ensure: async () => ({ sessionId: 's-cards' }),
    ensureWorkspaceFor: async () => workspace,
    deliverText: async () => ({ delivered: true }),
  }
  const activity = createActivityHub({ store, logger: console })
  const undo = createUndoManager({ store, logger: console, onRestored: () => {} })
  const currentRuns = new Map()
  const deliver = createGestureDispatcher({
    ctx: { logger: console, on: () => () => {}, get: () => undefined },
    store, sessions, activity, undo, currentRuns,
  })
  const handler = createRouter({
    store,
    logger: console,
    resolveCwd: async () => workspace,
    ensureSession: async () => ({ sessionId: 's-cards', created: false }),
    submit: (gesture) => deliver(gesture),
  })
  const call = async (method, url, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    const req = Object.assign(Readable.from(chunks), { method, url, headers: { host: '127.0.0.1:19387' } })
    const res = {
      statusCode: 0, headers: {}, body: '',
      writeHead(status, h) { this.statusCode = status; this.headers = h ?? {} },
      end(chunk) { if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) },
    }
    await handler(req, res)
    let json = null
    try { json = JSON.parse(res.body) } catch { /* ignore */ }
    return { status: res.statusCode, json, body: res.body }
  }
  /* GET /api/config 带 cards；POST 校验布尔。 */
  const cfg0 = await call('GET', '/codeflow/api/config')
  assert.equal(cfg0.status, 200)
  assert.deepEqual(cfg0.json.cards, { persist: false, asked: false }, '默认 cards 随 GET 返回')
  const badPost = await call('POST', '/codeflow/api/config', { cards: { persist: 'yes' } })
  assert.equal(badPost.status, 400, '非布尔 persist → 400')
  const badPost2 = await call('POST', '/codeflow/api/config', { cards: [] })
  assert.equal(badPost2.status, 400, 'cards 数组 → 400')
  const goodPost = await call('POST', '/codeflow/api/config', { cards: { persist: true, asked: true } })
  assert.equal(goodPost.status, 200)
  assert.equal(goodPost.json.cards.persist, true)
  const onDisk = JSON.parse(await readFile(path.join(workspace, 'CodeFlow', 'config.json'), 'utf8'))
  assert.equal(onDisk.cards.asked, true, 'asked 按工作区落盘')

  /* e2e：开启持久化 → 两次导入合并。 */
  const sourceRoot = path.join(workspace, 'src-proj')
  await mkdir(path.join(sourceRoot, 'src'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'src', 'a.py'), 'def a():\n    pass  # TODO 修复\n')
  await writeFile(path.join(sourceRoot, 'src', 'b.py'), 'def b():\n    return 1\n')
  const first = await call('POST', '/codeflow/api/drop/path', { path: sourceRoot, kind: 'dir', depth: 4 })
  assert.equal(first.status, 200, first.body.slice(0, 200))
  const projectName = first.json.project
  assert.equal(first.json.cards, undefined, '首次导入（无旧图）不报合并')
  /* 用户改状态/位置/标题。 */
  const tasks = first.json.graph
  tasks.nodes[0].status = 'done'
  tasks.nodes[0].result = '已完成过'
  tasks.nodes[0].pos = [123, 456]
  await call('POST', '/codeflow/api/state', { graph: tasks, view: 'tasks', project: projectName })
  const second = await call('POST', '/codeflow/api/drop/path', { path: sourceRoot, kind: 'dir', depth: 4, overwrite: true, projectName })
  assert.equal(second.status, 200, second.body.slice(0, 300))
  assert.equal(second.json.cards?.merged, true, '第二次导入触发合并')
  assert.equal(second.json.cards?.matched >= 1, true, `matched=${second.json.cards?.matched}`)
  const mergedNodes = second.json.graph.nodes
  assert.ok(mergedNodes.some((n) => n.status === 'done' && n.result === '已完成过'), '状态/结果保留')
  assert.ok(mergedNodes.some((n) => n.meta?.cf?.mergedAt !== undefined && n.meta?.cf?.stale === false), 'meta.cf 写入')
  assert.deepEqual(second.json.graph.meta?.cards?.schema, 1, 'meta.cards 写入')
  /* 失效卡片 + 运行守卫：手工构造 stale 节点 → RUN_ALL 排除、RUN_NODE 400。 */
  {
    const guardGraph = { format: 'codeflow/1', rev: 0, project: { name: projectName },
      nodes: [
        { id: 'live', type: 'edit', title: '活卡片', pos: [0, 0], params: { instruction: 'src/b.py:1' }, status: 'pending', result: '', detail: '', meta: { cf: { key: 'task:edit:src/b.py:1', importedTitle: '活卡片', stale: false, mergedAt: '2026-01-01T00:00:00.000Z' } } },
        { id: 'dead', type: 'edit', title: '失效卡片', pos: [300, 0], params: { instruction: 'src/gone.py:1' }, status: 'done', result: '', detail: '', meta: { cf: { key: 'task:edit:src/gone.py:1', importedTitle: '失效卡片', stale: true, mergedAt: '2026-01-01T00:00:00.000Z' } } },
      ],
      links: [], meta: {} }
    await call('POST', '/codeflow/api/state', { graph: guardGraph, view: 'tasks', project: projectName })
    const runAll = await call('POST', '/codeflow/api/action', { action: 'RUN_ALL', graph: guardGraph, view: 'tasks', title: '运行全部' })
    assert.equal(runAll.status, 200, runAll.body.slice(0, 200))
    /* 提交的手势经 submit 记录？——直接验证：RUN_ALL 之后 order 不含 stale。
       （deliver 层把 order 写进提示词与 currentRuns；这里用节点状态侧面验证：
       stale 卡片保持 done，live 卡片被置 running。） */
    const state = await call('GET', `/codeflow/api/state?project=${encodeURIComponent(projectName)}&view=tasks`)
    const byId = new Map(state.json.graph.nodes.map((n) => [n.id, n]))
    assert.equal(byId.get('dead').status, 'done', '失效卡片不参与运行（状态不变）')
    assert.equal(byId.get('live').status, 'running', '活卡片进入运行')
    /* 假会话没有真实回合结束事件（finishRun 链在 index.js 装配）：手动收尾
       本次运行并清理 currentRuns，否则下一次 RUN_NODE 撞 undo 运行锁 409。 */
    const pendingRun = currentRuns.get(projectName)
    if (pendingRun !== undefined) {
      await undo.finishRun(projectName, pendingRun.runId).catch(() => {})
      currentRuns.delete(projectName)
    }
    const runStale = await call('POST', '/codeflow/api/action', { action: 'RUN_NODE', graph: guardGraph, view: 'tasks', nodeId: 'dead', title: '运行节点' })
    /* 手势投递层的失败按既有契约映射为 409（含可行动错误文本）。 */
    assert.equal(runStale.status, 409, `失效卡片单节点运行被拒（实际 ${runStale.status}）`)
    assert.ok(String(runStale.json?.error ?? '').includes('失效卡片'), '错误可行动')
  }
  /* meta.cf 经 store 落盘不被清洗（此时磁盘上还是合并后的图）。 */
  const projDir = path.join(workspace, 'CodeFlow', 'flow-projects', projectName)
  const mergedOnDisk = JSON.parse(await readFile(path.join(projDir, 'workflow.json'), 'utf8'))
  assert.ok(Array.isArray(mergedOnDisk.nodes) && mergedOnDisk.nodes.some((n) => n.meta?.cf?.importedTitle !== undefined), '落盘图的 meta.cf 完整（normalizeGraph 不清洗）')
  /* 关闭持久化 → 覆盖（无合并），旧图有 .bak。 */
  await call('POST', '/codeflow/api/config', { cards: { persist: false } })
  const fourth = await call('POST', '/codeflow/api/drop/path', { path: sourceRoot, kind: 'dir', depth: 4, overwrite: true, projectName })
  assert.equal(fourth.status, 200)
  assert.equal(fourth.json.cards, undefined, '关闭持久化不合并')
  const backups = (await import('node:fs/promises')).readdir
  const files = await backups(projDir)
  assert.ok(files.some((f) => f.startsWith('workflow.json.bak-')), '覆盖前有 .bak 备份')
  await rm(workspace, { recursive: true, force: true }).catch(() => {})
  ok('e2e：开启合并 / 失效卡片运行守卫 / 关闭覆盖 + .bak / meta.cf 落盘')
}

console.log(`\n[summary] cards: ${passed} checks passed`)
