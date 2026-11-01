/**
 * dsh-codeflow-canvas — host half.
 *
 * The plugin contributes four things, all of which need the Host process:
 *
 *   1. a skill provider  — the `codeflow-canvas` orchestration document;
 *   2. three commands    — `/flow`, `/flow-new`, `/flow-import`;
 *   3. two tools         — `codeflow_canvas` (render a graph) and
 *                          `codeflow_features` (feature-group index, v1.1);
 *   4. an HTTP surface   — the panel document plus the graph API.
 *
 * The browser half (`lib/client.js`) only contributes the panel and its sidebar
 * entry; it stays deliberately thin so the canvas itself can keep its own
 * document, styles and input handling without touching the shell's.
 *
 * Since v0.5.0 two more pieces live here:
 *
 *   - the session manager (`lib/sessions.js`): every project gets one
 *     dedicated, durably bound canvas session; canvas gestures are delivered
 *     only there — the "single live root" guess is gone;
 *   - the activity hub (`lib/activity.js`) and the undo manager
 *     (`lib/undo.js`): runs become observable (reasoning/step/progress) and
 *     revertible (pre-run snapshot), respectively.
 *
 * @module dsh-codeflow-canvas
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'

import { registerCommands } from './commands.js'
import { createActivityHub } from './activity.js'
import { registerFeaturesTool } from './features-tool.js'
import { migrateLegacy, projectDir, setPathsLogger } from './paths.js'
import { createRouter, ROUTE_PREFIX } from './routes.js'
import { createSessionManager } from './sessions.js'
import { registerSkill } from './skill.js'
import { createStore } from './store.js'
import { normalizeView, VIEW_KEYS } from './graph-format.js'
import { registerTool } from './tool.js'
import { createUndoManager } from './undo.js'

/** Cordis plugin identity. */
export const name = 'codeflow-canvas'

/** Services this plugin cannot work without. */
export const inject = ['skills', 'commands', 'tools']

/** Resolve a logger without depending on a particular Cordis shape. */
function loggerOf(ctx) {
  const logger = ctx?.logger
  if (logger !== undefined && typeof logger.warn === 'function') return logger
  return console
}

/**
 * Fields a canvas gesture may forward to the agent alongside the graph path.
 * Everything else in the request body is transport noise. `view` is forwarded
 * too (the route already resolved it to the run's view).
 */
const FORWARDED_FIELDS = [
  'nodeId', 'rerun', 'brief', 'language', 'autoRun', 'path', 'depth',
  'fromComments', 'addTests', 'name', 'view',
]

/** Actions that change project files, and therefore warrant a snapshot. */
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
      return await projectDir(state.cwd, project)
    } catch {
      // 配置不可读：不带 cwd。
    }
  }
  return undefined
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
 * Turn a canvas gesture into a prompt and deliver it to the project's canvas
 * session.
 *
 * The prompt is built *here*, not in the route, because it embeds the address
 * of the durable graph — and that address needs the session's workspace, which
 * is only known once the session is resolved. A project whose canvas was
 * edited before any agent ever rendered it therefore still gets a usable
 * `graphPath`.
 *
 * Delivery always goes through the session manager (`lib/sessions.js`): the
 * project's dedicated session is created on first use, resumed when cold, and
 * rebuilt when the binding dangles. There is deliberately no fallback to "the
 * newest live session".
 *
 * For `RUN_NODE` / `RUN_ALL` the project tree is snapshotted before the prompt
 * is queued (see `lib/undo.js`), so the user can revert the run afterwards. A
 * snapshot failure downgrades the run's undoability with a warning — it never
 * blocks the run — and a delivery failure deletes the just-made snapshot so
 * failed gestures leave no `.undo` litter.
 *
 * v1.0 hardening (the「测试运行」空转 field report): RUN_* prompts are now
 * self-contained — `node`/`upstream`/`order`/`cwd`/`expect` ride along and a
 * 「本次执行要求」footer forbids skipping — the target node flips to `running`
 * the moment the prompt is queued (A3.3), and a turn that ends with the target
 * still `pending` is reconciled into a visible, retryable failure (A3.4).
 *
 * @param deps - `{ ctx, store, sessions, activity, undo, currentRuns }`.
 * @param gesture - `{ action, body, project, rev }`.
 * @returns `{ sessionId, cwd, snapshot? }`.
 */
async function deliver(deps, gesture) {
  const { ctx, store, sessions, activity, undo, currentRuns } = deps
  const project = gesture.project
  const action = gesture.action
  // The view this run works on: NEW is always a task pipeline; RUN_* gestures
  // carry the view the canvas was showing. The snapshot, the flushed graph
  // path, the activity tracking and the `[CodeFlow:*]` payload all target it.
  const runView = action === 'NEW'
    ? 'tasks'
    : normalizeView(gesture.view) ?? normalizeView(gesture.body?.view) ?? 'tasks'

  // A snapshot-worthy run acquires the per-project run lock first, so two
  // concurrent gestures cannot interleave two snapshots.
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

  // Validate (and when live, repair) the working directory the prompt runs in.
  // Without this every turn dies in prompt assembly with `working-directory:
  // directory does not exist`, which is the macOS failure this plugin used to
  // hand straight to the user.
  const workspaceCheck = await sessions.ensureWorkspaceFor(project, bound.sessionId)
  const cwd = workspaceCheck.cwd

  // Persist before quoting the path, so the agent reads exactly what the user sees.
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
  let optimisticNode
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
    // v1.0 A3.4: remember what this run was about, so a turn that ends without
    // executing anything can be reconciled into a visible failure + retry.
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
  try {
    await sessions.deliverText(project, prompt)
  } catch (error) {
    // The prompt never reached a session: nobody will produce results. Roll
    // the optimistic "running" patch back, delete the snapshot (no .undo
    // litter) and leave activity idle.
    if (optimisticNode !== undefined) {
      store.patchNode(project, optimisticNode.id, { status: optimisticNode.previous }, { view: runView })
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
    optimisticNode = { id: optimisticTarget.id, previous: optimisticTarget.status }
    store.patchNode(project, optimisticTarget.id, { status: 'running' }, { view: runView })
  }

  return {
    sessionId: bound.sessionId,
    cwd: typeof cwd === 'string' ? cwd : undefined,
    ...(snapshot !== undefined ? { snapshot } : {}),
  }
}

/**
 * Cordis plugin body.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const logger = loggerOf(ctx)
  setPathsLogger(logger)
  const store = createStore(logger)

  // Last-write safety: pending debounced canvas writes are flushed when the
  // plugin goes away. Without this, quitting DSH within the 600 ms debounce
  // window silently dropped the newest edit.
  ctx.effect(() => () => {
    return store.flushAll().catch((error) => logger?.warn?.(`codeflow: flush on dispose failed: ${String(error)}`))
  }, 'codeflow-canvas: flush pending canvas writes on dispose')

  registerSkill(ctx)
  registerCommands(ctx, store)

  const sessions = createSessionManager({ ctx, store, logger })
  const activity = createActivityHub({ store, logger })
  /** project key -> the snapshot-worthy run currently in flight (its manifest
   *  plus the payload bits the end-of-turn reconciliation needs, v1.0 A3.4). */
  const currentRuns = new Map()
  const undo = createUndoManager({
    store,
    logger,
    onRestored: (project) => activity.clear(project),
  })

  /**
   * v1.0 A3.4：回合结束对账。专用会话的回合结束了，但本次运行的目标节点没有
   * 任何执行痕迹——正是字段报告里"agent 只回复不执行"的现场。把它翻成明确的
   * `failed`（可行动的原因），并在活动读模型里记一条 issue，画布据此显示横幅
   * + 「重试」按钮。
   *
   * 判定：目标节点仍是 `pending`（乐观置 running 没发生，如 RUN_ALL 的后续节点），
   * 或仍是 `running` 且本回合**从未收到过任何 progress**（A3.3 已把它置 running，
   * activity hub 的滞留兜底会先把它置成通用的"未收到结果"——这里用可行动的
   * 原因覆盖）。agent 报过 progress（`run.progressed`）说明它真的动了手，那是
   * 普通滞留失败，不覆盖、不记 issue。
   *
   * 必须发生在 `undo.finishRun` 之前：对账产生的 patch 也是本次运行的一部分。
   */
  function reconcileAbandonedRun(project, run) {
    const viewName = normalizeView(run.view) ?? 'tasks'
    const nodes = store.get(project, viewName)?.graph?.nodes ?? []
    const byId = new Map(nodes.map((node) => [node.id, node]))
    let target
    if (run.action === 'RUN_NODE') {
      target = byId.get(run.nodeId)
    } else {
      for (const id of Array.isArray(run.order) ? run.order : []) {
        const node = byId.get(id)
        if (node !== undefined && node.status === 'pending') {
          target = node
          break
        }
      }
    }
    if (target === undefined) return
    const untouched = target.status === 'pending'
      || (target.status === 'running' && run.progressed !== true)
    if (!untouched) return
    store.patchNode(project, target.id, {
      status: 'failed',
      result: 'agent 未执行该节点',
      detail: '回合结束但节点没有任何进度；可能会话未加载画布技能或模型跳过了执行。可点「重试」重发本次运行。',
    }, { view: viewName })
    activity.noteIssue?.(project, {
      at: Date.now(),
      nodeId: target.id,
      text: `节点「${target.title || target.id}」未被执行：回合结束但没有任何进度。可能会话未加载画布技能，或模型跳过了执行；点「重试」重发本次运行。`,
      retry: true,
    })
    logger?.warn?.(`codeflow: run of ${project} ended without executing node ${target.id}; marked failed (retryable)`)
  }

  /** Any real progress during a run marks it as "the agent actually worked" —
   * such runs keep the generic straggler failure and never get the retry issue. */
  const noteProgressBase = activity.noteProgress
  activity.noteProgress = (project, patch) => {
    const run = currentRuns.get(project)
    if (run !== undefined) run.progressed = true
    return noteProgressBase(project, patch)
  }

  activity.options.onTurnEnd = (project) => {
    const run = currentRuns.get(project)
    if (run !== undefined) {
      try {
        reconcileAbandonedRun(project, run)
      } catch (error) {
        logger?.warn?.(`codeflow: run reconciliation failed: ${String(error)}`)
      }
      undo.finishRun(project, run.runId).catch((error) => logger?.warn?.(`codeflow: finishRun failed: ${String(error)}`))
      currentRuns.delete(project)
    }
  }
  activity.options.onPresented = (project, files) => {
    // Confirm delivery: record the paths `present` really committed on the
    // deliver node the run is working on (or the newest finished one). The
    // run's view is checked first, then the other — deliverables always belong
    // to the graph the running session was pointed at.
    const runView = activity.currentViewOf !== undefined ? activity.currentViewOf(project) : 'tasks'
    const candidates = [runView, ...VIEW_KEYS.filter((viewName) => viewName !== runView)]
    for (const viewName of candidates) {
      const graph = store.get(project, viewName)?.graph
      const deliverNode = graph?.nodes?.find((node) => node.type === 'deliver' && node.status === 'running')
        ?? graph?.nodes?.find((node) => node.type === 'deliver' && node.status === 'done')
      if (deliverNode === undefined) continue
      const merged = [...(deliverNode.presented ?? []), ...files]
      store.patchNode(project, deliverNode.id, { presented: merged }, { view: viewName })
      return
    }
  }
  // Subscribe with the plugin fiber so the listeners die with the plugin.
  activity.attach(ctx)

  registerTool(ctx, store, {
    activity,
    sessions,
  })
  // v1.1：codeflow_features — 功能分组索引的零成本查询/写入通道（不触碰图与 rev）。
  registerFeaturesTool(ctx, store, { logger })

  // The canvas panel needs an HTTP carrier. Keeping it optional means the rest
  // of the plugin (skill, commands, tool) still works in a headless session.
  ctx.inject(['webServer'], (webCtx) => {
    // Delegate to the carrier's own browser gate: this route can inject prompts
    // into a session, so it must be exactly as protected as the rest of the GUI
    // (a signed, authority-bound cookie that a same-origin iframe carries for
    // free). The service is looked up per request because `webServer` may become
    // available before `connection`.
    let warned = false
    const fence = (req) => {
      const connection = ctx.get('connection')
      if (typeof connection?.requestRejection !== 'function') {
        if (!warned) {
          warned = true
          logger.warn?.('codeflow: connection.requestRejection is unavailable; the canvas routes fall back to loopback + same-origin checks only')
        }
        return undefined
      }
      return connection.requestRejection(req)
    }
    const handler = createRouter({
      store,
      logger,
      fence,
      submit: (gesture) => deliver({ ctx, store, sessions, activity, undo, currentRuns }, gesture),
      resolveCwd: (project) => resolveWorkspaceOf(project),
      // v1.1：「让 agent 识别」把 [CodeFlow:FEATURES] 投递到项目专用会话。
      deliverText: (project, text) => sessions.deliverText(project, text),
      // v1.0（需求 C）：旧 flow-projects/ 的自动迁移。幂等、只搬一次，
      // 失败保留旧目录；routes 在 boot / 列项目 / 新建 / 导入前触发它。
      migrateWorkspace: (workspace) => migrateLegacy(workspace),
      ensureSession: (project, options) => sessions.ensure(project, options),
      rebindSession: (project) => sessions.rebind(project),
      sessionInfo: (project) => ({
        sessionId: sessions.current(project) ?? store.get(project)?.sessionId ?? null,
        sessionTitle: store.get(project)?.sessionTitle ?? null,
        sessionNew: store.get(project)?.sessionNew === true,
        sessionWarning: store.get(project)?.sessionWarning ?? null,
      }),
      activityRead: (project, query) => activity.activity(project, query),
      undoList: (project) => undo.listRuns(project),
      undoRestore: (project, runId, options) => undo.restore(project, runId, options),
      undoDryRun: (project, runId) => undo.dryRun(project, runId),
      repairSession: undefined,
    })
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'codeflow-canvas: http surface',
    )
    // v1.2：拖拽导入暂存区的 30 分钟清扫定时器随插件 dispose 一起停止。
    webCtx.effect(
      () => () => {
        try {
          handler.dispose?.()
        } catch (error) {
          logger?.warn?.(`codeflow: drop staging dispose failed: ${String(error)}`)
        }
      },
      'codeflow-canvas: dispose drop-import staging sweepers',
    )
  })

  /** Workspace resolution that never throws, for the HTTP layer. */
  async function resolveWorkspaceOf(project) {
    try {
      return await sessions.workspaceOf(project)
    } catch {
      return undefined
    }
  }
}
