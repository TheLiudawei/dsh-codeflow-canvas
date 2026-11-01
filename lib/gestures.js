/**
 * 画布手势投递层：把一次画布手势（NEW / RUN_NODE / RUN_ALL / SAVE）变成一条
 * `[CodeFlow:动作]` 提示词并送进项目的画布专用会话。
 *
 * 从 lib/index.js 拆出的原因：deliver 一族（拓扑序、执行要求脚注、RUN_*
 * 自包含载荷、乐观置 running、快照协调）有完整的自身语义，塞在插件入口里
 * 让「装配」与「协议」混在一处。拆出后 index.js 是纯装配，本文件是协议。
 *
 * 提示词在**这里**构造而不在路由里，因为它内嵌持久图的地址——而该地址需要
 * 会话的工作区，只有会话解析完成之后才知道。一个在 agent 首次渲染之前就被
 * 编辑过的项目，因此也能拿到可用的 `graphPath`。
 *
 * 投递永远走会话管理器（lib/sessions.js）：项目的专用会话在首次使用时创建、
 * 冷启动时恢复、绑定悬空时重建。**刻意不做**「回退到最新的活跃会话」。
 *
 * 对 RUN_NODE / RUN_ALL：提示词入队之前先给项目树拍快照（见 lib/undo.js），
 * 用户事后可以撤销整次运行。快照失败只是把本次运行降级为不可撤销并警告——
 * 绝不阻塞运行；投递失败则删掉刚建的快照，失败的手势不留 `.undo` 垃圾。
 *
 * v1.0 加固（「测试运行」空转现场报告）：RUN_* 提示词现在自包含——
 * `node`/`upstream`/`order`/`cwd`/`expect` 随消息直达，且「本次执行要求」
 * 脚注禁止跳过；提示词入队的瞬间目标节点就翻成 `running`（A3.3）；一个
 * 以目标仍为 `pending` 收场的回合会被对账成可见、可重试的失败（A3.4，
 * 对账逻辑在 index.js）。
 *
 * 依赖方向：graph-format/core ← 本模块 ← index.js（装配时注入 deps）。
 *
 * @module dsh-codeflow-canvas/gestures
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'

import { normalizeView } from './graph-format.js'

/**
 * 画布手势可以随图路径一起转发给 agent 的字段；请求体里的其余内容都是
 * 传输噪音。`view` 也转发（路由已把它解析成本次运行的视图）。
 */
const FORWARDED_FIELDS = [
  'nodeId', 'rerun', 'brief', 'language', 'autoRun', 'path', 'depth',
  'fromComments', 'addTests', 'name', 'view',
]

/** 会改变项目文件、因而值得先拍快照的动作。 */
const RUN_ACTIONS = new Set(['RUN_NODE', 'RUN_ALL'])

/**
 * 拓扑序（Kahn）。`links` 形如 `[from, fromSlot, to, toSlot]`；悬空端点忽略，
 * 同层按图内出现顺序稳定输出。画布前端已拒绝成环，这里仍留一个兜底：环上
 * 节点按原顺序补在末尾，绝不丢 id（RUN_ALL 的 order 是执行清单，不能少项）。
 * @returns 节点 id 的拓扑顺序数组。
 */
export function topoOrderOf(nodes, links) {
  const ids = (Array.isArray(nodes) ? nodes : []).map((node) => node?.id).filter((id) => typeof id === 'string')
  const set = new Set(ids)
  const indegree = new Map(ids.map((id) => [id, 0]))
  const outgoing = new Map(ids.map((id) => [id, []]))
  for (const link of Array.isArray(links) ? links : []) {
    if (!Array.isArray(link) || link.length < 4) continue
    if (!set.has(link[0]) || !set.has(link[2])) continue
    outgoing.get(link[0]).push(link[2])
    indegree.set(link[2], indegree.get(link[2]) + 1)
  }
  const queue = ids.filter((id) => indegree.get(id) === 0)
  const order = []
  while (queue.length > 0) {
    const id = queue.shift()
    order.push(id)
    for (const next of outgoing.get(id)) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id)
  return order
}

/**
 * `testrun`/`shell` 命令必须执行在的目录（v1.0 A3.1）：导入项目是它的源码树
 * （`meta.importedFrom`，存在时优先），否则是项目自身的持久目录。取不到返回
 * `undefined`——消息里就不带 `cwd`，agent 按默认语义（graphPath 上一级）执行。
 */
async function projectRootFor(store, project, runView) {
  const importedFrom = store.get(project, runView)?.graph?.meta?.importedFrom
  if (typeof importedFrom === 'string' && importedFrom.length > 0) {
    try {
      if ((await stat(importedFrom)).isDirectory()) return path.normalize(importedFrom)
    } catch {
      // importedFrom 不存在（被移动/删除）：退回项目目录。
    }
  }
  const state = store.get(project)
  if (typeof state?.dir === 'string' && state.dir.length > 0) return state.dir
  if (typeof state?.cwd === 'string' && state.cwd.length > 0) {
    try {
      return await projectDirOf(state.cwd, project)
    } catch {
      // 配置不可读：不带 cwd。
    }
  }
  return undefined
}

/** projectDir 的惰性导入（避免 gestures → paths 的静态依赖——测试注入精简 deps）。 */
async function projectDirOf(cwd, project) {
  const { projectDir } = await import('./paths.js')
  return projectDir(cwd, project)
}

/**
 * RUN_* 首行 JSON 之后的「本次执行要求」正文（v1.0 A3.1）。协议规定：取第一行
 * `]` 之后到行尾的 JSON，其后的正文是宿主附加的硬性要求（见 protocol.md）。
 */
function runRequirements(action, nodeId) {
  if (action === 'RUN_NODE') {
    return [
      '',
      '',
      '本次执行要求（必须遵守）：',
      '1. 本次必须真实执行该节点，不得以「之前已经跑过/已经通过」为理由跳过；',
      `2. 结束前必须用 codeflow_canvas mode="progress" 回填 status/result/detail（nodeId=${nodeId ?? '?'}）；`,
      '3. 未执行就结束回合，宿主会把该节点标记为失败。',
    ].join('\n')
  }
  return [
    '',
    '',
    '本次执行要求（必须遵守）：',
    '1. 本次必须真实执行 order 列出的每个节点，不得以「之前已经跑过/已经通过」为理由跳过；',
    '2. 每个节点结束前必须用 codeflow_canvas mode="progress" 回填 status/result/detail；',
    '3. 任何未执行就结束回合的节点，宿主会把它标记为失败。',
  ].join('\n')
}

/**
 * 创建手势投递器。
 *
 * @param deps - `{ ctx, store, sessions, activity, undo, currentRuns }`
 *   （由 index.js 装配注入；ctx 仅用于日志等宿主能力）。
 * @returns `async deliver(gesture)`——gesture 为
 *   `{ action, body, project, rev }`，返回 `{ sessionId, cwd, snapshot? }`。
 */
export function createGestureDispatcher(deps) {
  const { store, sessions, activity, undo, currentRuns } = deps

  /**
   * 把一次画布手势变成提示词并投递到项目的画布会话（语义详见模块头注释）。
   */
  async function deliver(gesture) {
    const project = gesture.project
    const action = gesture.action
    // 本次运行作用的视图：NEW 永远是任务流水线；RUN_* 手势携带画布当时
    // 正在展示的视图。快照、flush 出的图路径、活动追踪与 `[CodeFlow:*]`
    // 载荷全部指向它。
    const runView = action === 'NEW'
      ? 'tasks'
      : normalizeView(gesture.view) ?? normalizeView(gesture.body?.view) ?? 'tasks'

    // 值得快照的运行先拿每项目的运行锁，两次并发手势不可能交错出两个快照。
    let snapshot
    if (RUN_ACTIONS.has(action)) {
      snapshot = await undo.beginRun(project, {
        action,
        nodeId: typeof gesture.body?.nodeId === 'string' ? gesture.body.nodeId : undefined,
        nodes: store.get(project, runView)?.graph?.nodes ?? [],
        view: runView,
      })
      if (snapshot.locked === true) {
        throw new Error('该项目已有一个正在进行的运行：请等它结束，或撤销后再试。')
      }
    }

    const bound = await sessions.ensure(project, { create: true })
    if (bound.error !== undefined) {
      if (snapshot !== undefined) {
        if (snapshot.runId !== undefined) await undo.abortRun(project, snapshot.runId)
        else undo.releaseRun(project)
      }
      throw new Error(bound.error)
    }

    // 校验（并在可能时修复）提示词运行所在的工作目录。少了这一步，每个回合
    // 都会死在提示词组装的 `working-directory: directory does not exist` 上
    // ——那正是本插件曾经直接抛给用户的 macOS 故障。
    const workspaceCheck = await sessions.ensureWorkspaceFor(project, bound.sessionId)
    const cwd = workspaceCheck.cwd

    // 引用路径之前先落盘，agent 读到的才与用户看到的完全一致。
    const flushed = await store.flush(project, runView)
    const payload = { project, rev: gesture.rev, view: runView }
    if (flushed?.file !== undefined) payload.graphPath = flushed.file
    if (flushed?.persisted === false) {
      payload.warning = `图谱未能落盘：${flushed.error ?? '未知原因'}`
    } else if (workspaceCheck.ok === false && workspaceCheck.warning !== undefined) {
      payload.warning = workspaceCheck.warning
    }
    for (const field of FORWARDED_FIELDS) {
      if (gesture.body?.[field] !== undefined) payload[field] = gesture.body[field]
    }
    payload.view = runView
    if (snapshot !== undefined) payload.undoable = snapshot.undoable === true

    /**
     * v1.0 A3.1：RUN_* 请求自包含。现场证明 agent 只靠 `graphPath` 自己读图时，
     * 会以「之前已经跑过」为由只回复不执行。现在把目标节点、上游结果、执行清单
     * 与工作目录直接写进消息，让"这一回合要真实执行什么"没有歧义。
     */
    if (RUN_ACTIONS.has(action)) {
      const graph = store.get(project, runView)?.graph
      const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
      const links = Array.isArray(graph?.links) ? graph.links : []
      const byId = new Map(nodes.map((node) => [node.id, node]))
      if (action === 'RUN_NODE' && typeof gesture.body?.nodeId === 'string') {
        const node = byId.get(gesture.body.nodeId)
        if (node !== undefined) {
          payload.node = { id: node.id, type: node.type, title: node.title, params: node.params ?? {} }
          const upstreamIds = new Set(
            links.filter((link) => Array.isArray(link) && link[2] === node.id).map((link) => link[0]),
          )
          payload.upstream = nodes
            .filter((candidate) => upstreamIds.has(candidate.id))
            .map((candidate) => ({
              id: candidate.id,
              type: candidate.type,
              status: candidate.status,
              result: String(candidate.result ?? '').slice(0, 120),
            }))
          if (node.type === 'testrun' || node.type === 'shell') {
            payload.cwd = await projectRootFor(store, project, runView)
            payload.expect = node.type === 'testrun'
              ? '在 cwd 下真实执行 params.cmd，并把真实输出统计写进 result；未执行就是失败，不得跳过'
              : '在 cwd 下真实执行 params.cmd，并把关键输出写进 result；未执行就是失败，不得跳过'
          }
        }
      } else if (action === 'RUN_ALL') {
        // 只有 pending/failed 进入本次执行清单（done 复用结果，skipped 跳过）。
        payload.order = topoOrderOf(nodes, links).filter((id) => {
          const node = byId.get(id)
          return node !== undefined && (node.status === 'pending' || node.status === 'failed')
        })
        if (payload.order.some((id) => { const type = byId.get(id)?.type; return type === 'testrun' || type === 'shell' })) {
          payload.cwd = await projectRootFor(store, project, runView)
          payload.expect = 'testrun/shell 节点必须在 cwd 下真实执行命令，并把真实输出写进 result；未执行就是失败，不得跳过'
        }
      }
    }

    if (RUN_ACTIONS.has(action) && snapshot !== undefined) {
      // v1.0 A3.4: 记下本次运行是关于什么的，回合结束时若什么都没执行，
      // 就对账成可见的失败 + 重试（对账在 index.js 的 reconcileAbandonedRun）。
      currentRuns.set(project, {
        runId: snapshot.runId,
        action,
        nodeId: typeof gesture.body?.nodeId === 'string' ? gesture.body.nodeId : undefined,
        order: payload.order,
        view: runView,
      })
      activity.beginRun(project, {
        action,
        nodeId: typeof gesture.body?.nodeId === 'string' ? gesture.body.nodeId : undefined,
        sessionId: bound.sessionId,
        view: runView,
      })
    }

    const prompt = `[CodeFlow:${action}]${JSON.stringify({ action, ...payload })}`
      + (action === 'RUN_NODE' || action === 'RUN_ALL' ? runRequirements(action, payload.node?.id ?? gesture.body?.nodeId) : '')
    // 乐观置 running 的回滚记录（投递失败时用；成功路径在下方赋值）。
    let deliveryFailedUndo
    try {
      await sessions.deliverText(project, prompt)
    } catch (error) {
      // 提示词从未到达任何会话：不会有人产出结果。回滚乐观的 running 补丁、
      // 删掉快照（不留 .undo 垃圾），活动保持空闲。
      if (deliveryFailedUndo !== undefined) {
        store.patchNode(project, deliveryFailedUndo.id, { status: deliveryFailedUndo.previous }, { view: runView })
      }
      if (snapshot?.runId !== undefined) await undo.abortRun(project, snapshot.runId)
      currentRuns.delete(project)
      throw error
    }

    /**
     * v1.0 A3.3：点下去立刻有反馈。投递成功后立即把目标节点置 `running`——
     * RUN_NODE 置目标节点；RUN_ALL 只置清单里的第一个（避免整图同时转圈）。
     * `result`/`detail` 原样保留；投递失败时回滚到原状态。
     */
    const optimisticTargetId = action === 'RUN_NODE'
      ? gesture.body?.nodeId
      : (Array.isArray(payload.order) ? payload.order[0] : undefined)
    const optimisticTarget = typeof optimisticTargetId === 'string'
      ? store.get(project, runView)?.graph?.nodes?.find((entry) => entry.id === optimisticTargetId)
      : undefined
    if (optimisticTarget !== undefined && optimisticTarget.status !== 'running') {
      deliveryFailedUndo = { id: optimisticTarget.id, previous: optimisticTarget.status }
      store.patchNode(project, optimisticTarget.id, { status: 'running' }, { view: runView })
    }

    return {
      sessionId: bound.sessionId,
      cwd: typeof cwd === 'string' ? cwd : undefined,
      ...(snapshot !== undefined ? { snapshot } : {}),
    }
  }

  return deliver
}
