/**
 * dsh-codeflow-canvas — host half.
 *
 * The plugin contributes four things, all of which need the Host process:
 *
 *   1. a skill provider  — the `codeflow-canvas` orchestration document;
 *   2. three commands    — `/flow`, `/flow-new`, `/flow-import`;
 *   3. one tool          — `codeflow_canvas`, the agent's way to render a graph;
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
import { registerCommands } from './commands.js'
import { createActivityHub } from './activity.js'
import { createRouter, ROUTE_PREFIX } from './routes.js'
import { createSessionManager } from './sessions.js'
import { registerSkill } from './skill.js'
import { createStore, normalizeView, VIEW_KEYS } from './store.js'
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

  if (RUN_ACTIONS.has(action) && snapshot !== undefined) {
    currentRuns.set(project, snapshot.runId)
    activity.beginRun(project, {
      action,
      nodeId: typeof gesture.body?.nodeId === 'string' ? gesture.body.nodeId : undefined,
      sessionId: bound.sessionId,
      view: runView,
    })
  }

  const prompt = `[CodeFlow:${action}]${JSON.stringify({ action, ...payload })}`
  try {
    await sessions.deliverText(project, prompt)
  } catch (error) {
    // The prompt never reached a session: nobody will produce results, so the
    // snapshot is deleted (no .undo litter) and activity stays idle.
    if (snapshot?.runId !== undefined) await undo.abortRun(project, snapshot.runId)
    currentRuns.delete(project)
    throw error
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
  /** project key -> the snapshot-worthy run currently in flight. */
  const currentRuns = new Map()
  const undo = createUndoManager({
    store,
    logger,
    onRestored: (project) => activity.clear(project),
  })
  activity.options.onTurnEnd = (project) => {
    const runId = currentRuns.get(project)
    if (runId !== undefined) {
      undo.finishRun(project, runId).catch((error) => logger?.warn?.(`codeflow: finishRun failed: ${String(error)}`))
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
