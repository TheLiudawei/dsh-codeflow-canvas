/**
 * The HTTP surface the canvas panel talks to.
 *
 * One prefix route (`/codeflow`) serves both the document and a small JSON API.
 * The browser half of this plugin is a thin iframe host, so everything the
 * canvas needs at runtime is here rather than in a client bundle:
 *
 *   GET  /codeflow/canvas          the canvas document (boot payload carries
 *                                  the canvas-session binding, the active
 *                                  view and both views' availability)
 *   GET  /codeflow/api/state       current graph of one view (`?view=`;
 *                                  default: the project's active view)
 *   POST /codeflow/api/state       canvas autosave for one view (one rev bump
 *                                  in that view; body carries `view`)
 *   POST /codeflow/api/view        switch the project's active view (no rev
 *                                  bump, no scan, no agent)
 *   POST /codeflow/api/action      a user gesture the agent must act on
 *   POST /codeflow/api/import      deterministic dual import — one scan
 *                                  produces the task pipeline AND the module
 *                                  graph, no agent turn
 *   POST /codeflow/api/save        persist the current graph(s), no agent turn
 *   GET  /codeflow/api/projects    durable projects under `flow-projects/`
 *   POST /codeflow/api/session     create a fresh canvas session / rebind
 *   GET  /codeflow/api/activity    live reasoning/step/progress/edits (memory)
 *   GET  /codeflow/api/undo        run history (newest first, `view` tagged)
 *   POST /codeflow/api/undo        restore one run (LIFO) or preview (`dryRun`)
 *
 * Every write goes through the store, which owns each view's `rev`.
 *
 * @module dsh-codeflow-canvas/routes
 */
import path from 'node:path'

import { renderCanvasPage } from './canvas-page.js'
import { importProjectDual } from './duo.js'
import { buildStarterGraph } from './starter.js'
import { normalizeView, VIEW_LABEL } from './store.js'
import { cleanPathInput } from './workspace.js'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/codeflow'

/** Upper bound on a request body: a graph plus view state is far smaller. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * Actions the canvas may hand to the agent. Import is not one: it is a purely
 * mechanical scan that `POST /codeflow/api/import` performs host-side, so the
 * panel never wakes the agent for it.
 */
const AGENT_ACTIONS = new Set(['NEW', 'RUN_NODE', 'RUN_ALL', 'SAVE'])

/**
 * Decide whether a request may be answered.
 *
 * The host transport already refuses forged authorities, but this route is
 * readable and writable by anything the browser loads, so it repeats the two
 * cheap checks that matter: a cross-site fetch, or an `Origin` that disagrees
 * with the `Host` it was sent to.
 *
 * @param req - the incoming request.
 * @returns `0` when the request is allowed, else the status to answer with.
 */
function rejectionFor(req) {
  const headers = req.headers ?? {}
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return 403
    }
    if (parsed.host.toLowerCase() !== String(headers.host ?? '').toLowerCase()) return 403
  }
  return 0
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Write one HTML response. */
function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Read and parse a JSON request body.
 * @param req - the incoming request.
 * @returns the parsed value, or `undefined` when the body is absent or invalid.
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  let oversized = false
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      // Keep draining the body (discarding the chunks) instead of answering
      // right away: responding on an unread request poisons the keep-alive
      // socket, and the client's *next* request on it dies with ECONNRESET —
      // the field report's one-off `fetch failed (status=0)`. The route is
      // loopback-only, so the unbounded-but-memoryless drain is fine.
      oversized = true
      continue
    }
    chunks.push(chunk)
  }
  if (oversized) {
    // A size problem is the client's fault, not a server fault: answer 413,
    // not the generic 500 the outer catch would produce for a plain error.
    const error = new Error(`request body too large (limit ${MAX_BODY_BYTES} bytes)`)
    error.statusCode = 413
    throw error
  }
  if (total === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Ask the host for a project's workspace, never throwing.
 * @param resolveCwd - optional async resolver supplied by the plugin entry.
 * @param project - project key, possibly undefined.
 */
async function cwdOf(resolveCwd, project) {
  if (typeof resolveCwd !== 'function') return undefined
  try {
    const cwd = await resolveCwd(project)
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * Split a write body's view hints: `view` is the view name since v0.6.0, but
 * pre-0.6.0 clients sent the viewport array as `view`. Both spellings work.
 */
function viewFieldsOf(body) {
  if (body === null || typeof body !== 'object') return {}
  const named = normalizeView(body.view)
  const legacyViewport = Array.isArray(body.view) && body.view.length === 3 ? body.view : undefined
  const viewport = Array.isArray(body.viewport) && body.viewport.length === 3 ? body.viewport : legacyViewport
  return { view: named, viewport }
}

/**
 * Load a durable project into memory for the panel's first frame.
 *
 * Only runs when asked (`?boot=1`) or when a project is named, so ordinary API
 * calls keep their previous semantics and never scan the disk unexpectedly.
 *
 * A corrupt graph file no longer boots as a silently empty canvas:
 * `store.load` quarantines the file and reports that view as `degraded`, which
 * the boot payload forwards so the panel can warn instead of inviting an
 * overwrite. Both views of a dual project are loaded here so the view switcher
 * has real counts and switching is instant.
 *
 * @param store - canvas store.
 * @param cwd - workspace, when one is known.
 * @param project - named project, when the URL carries one.
 */
async function bootProject(store, cwd, project) {
  if (cwd === undefined) return
  if (project !== undefined) {
    const current = store.get(project)
    const loadedAlready = VIEW_LOADED(current)
    if (loadedAlready) return
    try {
      await store.load(project, cwd)
    } catch {
      // A named project that has no file yet is simply an empty canvas.
    }
    return
  }
  if (store.mostRecent() !== undefined) return
  const projects = await store.listProjects(cwd)
  for (const entry of projects) {
    try {
      const loaded = await store.load(entry.name, cwd)
      // Prefer a project whose active view still loads whole; a quarantined
      // one would boot as an empty canvas, so keep looking for a healthier one.
      const activeState = store.get(entry.name, loaded.activeView)
      if (activeState?.degraded === undefined) return
    } catch {
      // Skip a project with no graph files and try the next one.
    }
  }
}

/** Has this project's active view been loaded from disk (or written) already? */
function VIEW_LOADED(current) {
  if (current === undefined) return false
  if (current.rev > 0) return true
  return current.views?.[current.activeView]?.available === true
    && (current.views?.[current.activeView]?.rev ?? 0) > 0
}

/**
 * Create the request handler for `/codeflow`.
 *
 * @param options.store - the canvas store.
 * @param options.submit - delivers a gesture to the project's canvas session.
 * @param options.logger - Cordis logger for diagnostic warnings.
 * @param options.fence - optional host gate returning `undefined` to admit a
 *   request or an HTTP status to refuse it. The web carrier protects every other
 *   route with a signed browser cookie; this one can inject prompts into a
 *   session, so it must be protected by the same gate rather than by
 *   loopback-and-Origin checks alone. A same-origin iframe carries the cookie
 *   automatically, which is why the canvas needs no token in its URL.
 * @param options.ensureSession - session manager `ensure(project, {create})`.
 * @param options.rebindSession - session manager `rebind(project)`.
 * @param options.sessionInfo - current binding snapshot for the panel.
 * @param options.activityRead - the activity hub's read model.
 * @param options.undoList - run history reader.
 * @param options.undoRestore - LIFO restore (with `dryRunOnly` support).
 * @returns a node:http style handler.
 */
export function createRouter({
  store, submit, logger, fence, resolveCwd,
  ensureSession, rebindSession, sessionInfo, activityRead,
  undoList, undoRestore,
}) {
  const deps = { resolveCwd }

  /**
   * Resolve (or create) the canvas session for a project without ever making
   * a route fail over it: a session problem degrades to `warning`, because the
   * canvas must stay editable, importable and saveable without one.
   */
  async function sessionFor(project, { create = true } = {}) {
    if (project === undefined || project === null) return { warning: undefined }
    if (typeof ensureSession !== 'function') return { warning: undefined }
    try {
      const result = await ensureSession(String(project), { create })
      if (result?.error !== undefined) return { warning: result.error }
      return { warning: undefined, sessionId: result.sessionId, created: result.created === true }
    } catch (error) {
      logger?.warn?.(`codeflow: session ensure failed for ${project}: ${String(error)}`)
      return { warning: String(error?.message ?? error) }
    }
  }

  /** Session fields shared by boot and /api/state. */
  function sessionFields(project) {
    if (typeof sessionInfo !== 'function') return { sessionTitle: null, sessionNew: false, sessionWarning: null }
    const info = sessionInfo(project) ?? {}
    return {
      sessionTitle: info.sessionTitle ?? null,
      sessionNew: info.sessionNew === true,
      sessionWarning: info.sessionWarning ?? null,
    }
  }

  /**
   * Load a view on demand: the panel may ask for the other view of a project
   * nobody has fully booted yet (e.g. right after a restart with a stale tab).
   * Missing files stay "unavailable"; corrupt files degrade that view only.
   * The attempt itself is cheap and idempotent (layout detection runs once).
   */
  async function ensureViewLoaded(project, viewName) {
    const current = store.get(project, viewName)
    if (current.rev > 0 || current.degraded !== undefined || current.viewLoaded === true) return
    const cwd = await cwdOf(resolveCwd, project)
    if (cwd === undefined) return
    try {
      await store.loadView(project, cwd, viewName)
    } catch {
      // Unavailable stays unavailable; the views summary reports the reason.
    }
  }

  return async function handle(req, res) {
    const rejection = rejectionFor(req)
    if (rejection !== 0) {
      sendJson(res, rejection, { ok: false, error: 'forbidden' })
      return
    }
    if (fence !== undefined) {
      let status
      try {
        status = fence(req)
      } catch {
        status = 401
      }
      if (status !== undefined && status !== null) {
        sendJson(res, status, { ok: false, error: 'authenticate this browser first' })
        return
      }
    }
    let url
    try {
      url = new URL(String(req.url ?? '/'), 'http://codeflow.invalid')
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad url' })
      return
    }
    const pathname = url.pathname
    const method = String(req.method ?? 'GET').toUpperCase()
    const project = url.searchParams.get('project') ?? undefined
    // The panel passes the DSH colour scheme so the first frame is already right;
    // absent (a hand-opened URL) leaves the canvas to prefers-color-scheme.
    const requestedScheme = url.searchParams.get('theme')
    const theme = requestedScheme === 'light' || requestedScheme === 'dark' ? requestedScheme : null

    try {
      // ---- the document -------------------------------------------------
      if (pathname === `${ROUTE_PREFIX}/canvas` || pathname === `${ROUTE_PREFIX}/canvas.html`) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        // The panel's first frame loads the most recent durable project from
        // the workspace. Without this, opening CodeFlow after a DSH restart
        // showed an empty canvas even though `flow-projects/` was full.
        const wantsBoot = url.searchParams.get('boot') === '1' || project !== undefined
        let workspace
        if (wantsBoot) {
          workspace = await cwdOf(resolveCwd, project)
          await bootProject(store, workspace, project)
        }
        // An opening panel names no project: show the one most recently written
        // rather than the empty untitled bucket.
        const current = store.get(project ?? store.mostRecent())
        // First open of an existing project binds its dedicated session
        // (creating it exactly once, thanks to the manager's in-flight dedupe).
        const session = wantsBoot && current.graph.nodes.length > 0
          ? await sessionFor(current.key)
          : { warning: undefined }
        const notice = wantsBoot && workspace === undefined
          ? '未找到可用的 DSH 工作区：导入请使用绝对路径；新建项目只会暂存在内存中。'
          : undefined
        sendHtml(res, 200, renderCanvasPage({
          graph: current.graph,
          rev: current.rev,
          view: current.viewport ?? null,
          viewport: current.viewport ?? null,
          activeView: current.activeView ?? 'tasks',
          views: current.views ?? { tasks: { available: false }, modules: { available: false } },
          project: project ?? current.graph?.project?.name ?? null,
          sessionId: current.sessionId ?? null,
          sessionTitle: current.sessionTitle ?? null,
          sessionNew: current.sessionNew === true,
          sessionWarning: session.warning ?? current.sessionWarning ?? null,
          workspace: workspace ?? null,
          degraded: current.degraded ?? null,
          notice,
          theme,
          standalone: false,
        }))
        return
      }

      // ---- current state ------------------------------------------------
      if (pathname === `${ROUTE_PREFIX}/api/state`) {
        if (method === 'GET') {
          const requested = normalizeView(url.searchParams.get('view'))
          const target = project ?? store.mostRecent()
          if (target === undefined) {
            sendJson(res, 200, {
              ok: true,
              project: null,
              view: requested ?? 'tasks',
              activeView: 'tasks',
              rev: 0,
              graph: null,
              viewport: null,
              views: { tasks: { available: false }, modules: { available: false } },
              sessionId: null,
              sessionTitle: null,
              sessionWarning: null,
              persistError: null,
              degraded: null,
            })
            return
          }
          const viewName = requested ?? store.get(target).activeView ?? 'tasks'
          await ensureViewLoaded(target, viewName)
          const current = store.get(target, viewName)
          if (requested !== undefined && current.unavailable !== undefined && current.rev === 0) {
            sendJson(res, 409, {
              ok: false,
              error: `${VIEW_LABEL[viewName]}视图不可用（${current.unavailable}）`,
              project: current.key,
              view: viewName,
              activeView: current.activeView,
              views: current.views,
            })
            return
          }
          sendJson(res, 200, {
            ok: true,
            project: current.key,
            view: current.view,
            activeView: current.activeView,
            rev: current.rev,
            graph: current.graph,
            viewport: current.viewport ?? null,
            views: current.views,
            sessionId: current.sessionId ?? null,
            sessionTitle: current.sessionTitle ?? null,
            sessionWarning: current.sessionWarning ?? null,
            persistError: current.persistError ?? null,
            degraded: current.degraded ?? null,
          })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined || body === null || typeof body !== 'object') {
            sendJson(res, 400, { ok: false, error: 'expected a JSON body' })
            return
          }
          const cwd = await cwdOf(resolveCwd, body.project ?? project)
          const { view, viewport } = viewFieldsOf(body)
          // The durable outcome is known before answering: autosave used to be
          // debounced server-side, so a failed disk write reached the client as
          // `{"ok":true}` with no `persisted` field at all — the user believed
          // the graph was saved while only the log knew it was not.
          const written = await store.write(body.graph ?? body, {
            persist: 'now',
            view,
            viewport,
            cwd,
            // Two windows on one project: the writer whose base revision is
            // stale is refused with 409 instead of silently clobbering.
            expectedRev: body.expectedRev,
          })
          sendJson(res, 200, {
            ok: true,
            project: written.key,
            view: written.view,
            rev: written.rev,
            ...(written.persisted === undefined ? {} : { persisted: written.persisted }),
            ...(written.error === undefined ? {} : { error: written.error }),
          })
          return
        }
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }

      // ---- switch the active view ---------------------------------------
      if (pathname === `${ROUTE_PREFIX}/api/view` && method === 'POST') {
        const body = await readJsonBody(req)
        const target = (body !== null && typeof body === 'object' ? body.project : undefined) ?? project
        const wanted = normalizeView(body?.view)
        if (wanted === undefined) {
          sendJson(res, 400, { ok: false, error: 'view must be "tasks" or "modules"' })
          return
        }
        if (target === undefined || String(target).length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected a project name' })
          return
        }
        // Switching is pure bookkeeping: no rev bump, no rescan, no agent.
        const result = await store.setActiveView(String(target), wanted)
        sendJson(res, 200, {
          ok: true,
          project: result.key,
          activeView: result.activeView,
          unchanged: result.unchanged === true,
          ...(store.get(result.key)?.viewSidecarError !== undefined
            ? { warning: `激活视图未能持久化（${store.get(result.key).viewSidecarError}）；刷新后会回到默认视图` }
            : {}),
          ...sessionFields(String(target)),
        })
        return
      }

      // ---- the canvas session -------------------------------------------
      if (pathname === `${ROUTE_PREFIX}/api/session` && method === 'POST') {
        const body = await readJsonBody(req)
        const target = (body !== null && typeof body === 'object' ? body.project : undefined) ?? project
        if (target === undefined || String(target).length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected a project name' })
          return
        }
        const wantsRebind = body !== null && typeof body === 'object' && body.action === 'rebind'
        try {
          // 新建会话 replaces the binding; the old session stays in DSH's list.
          const result = wantsRebind && typeof rebindSession === 'function'
            ? await rebindSession(String(target))
            : await sessionFor(String(target), { create: true })
          if (result?.error !== undefined) {
            sendJson(res, 409, { ok: false, error: result.error })
            return
          }
          sendJson(res, 200, {
            ok: true,
            project: String(target),
            sessionId: result?.sessionId ?? null,
            created: result?.created === true || wantsRebind,
            title: `CodeFlow · ${String(target)}`.slice(0, 60),
            ...sessionFields(String(target)),
          })
        } catch (error) {
          sendJson(res, 409, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      // ---- live activity --------------------------------------------------
      if (pathname === `${ROUTE_PREFIX}/api/activity` && method === 'GET') {
        const target = project ?? store.mostRecent()
        if (target === undefined) {
          sendJson(res, 200, { ok: true, project: null, running: false, entries: [], edits: [], progress: null })
          return
        }
        if (typeof activityRead !== 'function') {
          sendJson(res, 200, { ok: true, project: String(target), running: false, entries: [], edits: [], progress: null, degraded: '宿主未提供实时过程' })
          return
        }
        const after = url.searchParams.get('after') ?? undefined
        const nodeFilter = url.searchParams.get('nodeId') ?? undefined
        sendJson(res, 200, activityRead(String(target), { after, nodeId: nodeFilter }))
        return
      }

      // ---- run history & undo ---------------------------------------------
      if (pathname === `${ROUTE_PREFIX}/api/undo`) {
        const target = project ?? store.mostRecent()
        if (method === 'GET') {
          if (target === undefined || typeof undoList !== 'function') {
            sendJson(res, 200, { ok: true, project: target ?? null, runs: [] })
            return
          }
          const result = await undoList(String(target))
          if (result?.error !== undefined) {
            sendJson(res, 200, { ok: true, project: String(target), runs: [], warning: result.error })
            return
          }
          sendJson(res, 200, { ok: true, project: String(target), runs: result.runs ?? [] })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (target === undefined || typeof undoRestore !== 'function') {
            sendJson(res, 409, { ok: false, error: '撤销服务不可用' })
            return
          }
          const runId = String(body?.runId ?? '')
          if (runId.length === 0) {
            sendJson(res, 400, { ok: false, error: 'expected a runId' })
            return
          }
          const dryRunOnly = body?.dryRun === true
          const result = await undoRestore(String(target), runId, { dryRunOnly })
          if (result?.ok !== true) {
            sendJson(res, result?.code ?? 500, { ok: false, error: result?.error ?? '撤销失败', ...(result?.files ? { files: result.files } : {}) })
            return
          }
          sendJson(res, 200, {
            ok: true,
            runId,
            project: String(target),
            view: result.view ?? null,
            files: result.files,
            backupDir: result.backupDir ?? null,
            graphRev: result.graphRev ?? null,
          })
          return
        }
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }

      // ---- persist without a turn ---------------------------------------
      if (pathname === `${ROUTE_PREFIX}/api/save` && method === 'POST') {
        const body = await readJsonBody(req)
        let target = body?.project ?? project ?? store.mostRecent()
        const cwd = await cwdOf(resolveCwd, target)
        const { view, viewport } = viewFieldsOf(body ?? {})
        if (body !== undefined && body !== null && typeof body === 'object' && body.graph !== undefined) {
          const written = await store.write(body.graph, {
            persist: 'now',
            view,
            viewport,
            cwd,
            expectedRev: body.expectedRev,
          })
          target = written.key
        }
        const flushed = await store.flush(target, view)
        // A save that never reached the disk is a failed save: answer 507 with
        // `ok:false` instead of a 200 whose `persisted:false` only careful
        // readers noticed.
        const failed = flushed !== undefined && flushed.persisted === false
        sendJson(res, failed ? 507 : 200, {
          ok: !failed,
          project: flushed?.key ?? (typeof target === 'string' ? target : null),
          view: flushed?.view ?? null,
          rev: flushed?.rev ?? 0,
          file: flushed?.file ?? null,
          ...(flushed?.persisted === undefined ? {} : { persisted: flushed.persisted }),
          ...(flushed?.error === undefined ? {} : { error: flushed.error, warning: `保存失败：${flushed.error}` }),
        })
        return
      }

      // ---- import without a turn ----------------------------------------
      // One scan, two graphs (v0.6.0): the deterministic host code produces the
      // marker-driven task pipeline (lib/importer.js) AND the code-structure
      // module graph (lib/analyst.js) under one project name. No agent is
      // involved. A legacy `strategy` field is accepted from old clients but
      // no longer selects anything.
      if (pathname === `${ROUTE_PREFIX}/api/import` && method === 'POST') {
        const body = await readJsonBody(req)
        const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
        // Bind to a usable workspace; without one the graph still renders, in memory.
        const cwd = await cwdOf(resolveCwd, project)
        const inputPath = cleanPathInput(input.path, { cwd })
        if (inputPath.length === 0) {
          sendJson(res, 400, { ok: false, error: '未提供项目路径' })
          return
        }
        if (cwd === undefined && !path.isAbsolute(inputPath)) {
          sendJson(res, 400, {
            ok: false,
            error: '还没有可用的 DSH 工作区，无法解析相对路径。请使用绝对路径（如 /Users/you/project 或 ~/project），或先在 DSH 里打开一个项目。',
          })
          return
        }
        const existingNames = new Set(cwd === undefined ? [] : (await store.listProjects(cwd)).map((entry) => entry.name))
        for (const key of store.keys()) existingNames.add(key)
        let result
        try {
          result = await importProjectDual({
            path: inputPath,
            cwd,
            maxFiles: input.maxFiles,
            maxDepth: input.depth,
            fromComments: input.fromComments,
            addTests: input.addTests,
            existingNames,
          })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          return
        }
        // The task pipeline lands first and is what the panel shows; the
        // module graph is a second file of the same project.
        const writtenTasks = await store.write(result.tasksGraph, { persist: 'now', cwd, view: 'tasks' })
        let writtenModules
        if (result.modulesGraph !== undefined) {
          try {
            writtenModules = await store.write(result.modulesGraph, { persist: 'now', cwd, view: 'modules' })
          } catch (error) {
            writtenModules = { error: String(error?.message ?? error) }
          }
        }
        // Import is host-side, but later canvas gestures need a canvas session:
        // create it now so 运行 works without another round trip. Failure is a
        // warning — the imported project is still fully usable for editing.
        const session = await sessionFor(writtenTasks.key)
        const moduleWarning = result.modulesGraph === undefined
          ? `模块结构图未能生成：${result.modulesWarning ?? '未知原因'}（任务流水线已正常导入）`
          : writtenModules?.persisted === false
            ? `模块结构图未能写入磁盘（${writtenModules.error ?? '未知原因'}）`
            : ''
        const warning = [
          session.warning,
          writtenTasks.persisted === false ? `导入完成，但任务图谱未能写入磁盘（${writtenTasks.error ?? '未知原因'}）：当前仅保存在内存中。` : '',
          cwd === undefined ? '未找到可用的 DSH 工作区：图谱只保存在内存中。' : '',
          moduleWarning,
        ].filter(Boolean).join('；') || undefined
        const views = store.get(writtenTasks.key).views
        sendJson(res, 200, {
          ok: true,
          project: writtenTasks.key,
          view: 'tasks',
          activeView: 'tasks',
          rev: writtenTasks.rev,
          summary: result.summary,
          tasksSummary: result.tasksSummary,
          modulesSummary: result.modulesSummary ?? null,
          modulesAvailable: result.modulesGraph !== undefined,
          file: writtenTasks.file ?? (cwd === undefined ? null : store.filePath(writtenTasks.key, 'tasks') ?? null),
          graph: writtenTasks.graph,
          views,
          ...(writtenTasks.persisted === undefined ? {} : { persisted: writtenTasks.persisted }),
          ...(warning === undefined ? {} : { warning }),
        })
        return
      }

      // ---- a user gesture the agent must handle --------------------------
      if (pathname === `${ROUTE_PREFIX}/api/action` && method === 'POST') {
        const body = await readJsonBody(req)
        if (body === undefined || body === null || typeof body !== 'object') {
          sendJson(res, 400, { ok: false, error: 'expected a JSON body' })
          return
        }
        const action = String(body.action ?? '')
        if (!AGENT_ACTIONS.has(action)) {
          sendJson(res, 400, { ok: false, error: `unknown action "${action}"` })
          return
        }

        // NEW is special: the project must exist even when no session can be
        // reached. Create the durable skeleton first, bind its canvas session,
        // then hand it to the agent; a delivery failure leaves a usable project
        // rather than the old "画布还没有绑定到会话" dead end. NEW is always a
        // task-pipeline project (module graphs come from import only).
        if (action === 'NEW') {
          const cwd = await cwdOf(resolveCwd, undefined)
          const existingNames = new Set(cwd === undefined ? [] : (await store.listProjects(cwd)).map((entry) => entry.name))
          // In-memory projects may not have reached disk yet (or may live in a
          // workspace we could not resolve); never reuse their name silently.
          for (const key of store.keys()) existingNames.add(key)
          const starter = buildStarterGraph({
            name: body.name,
            brief: body.brief,
            language: body.language,
            existingNames,
          })
          const written = await store.write(starter.graph, {
            persist: cwd === undefined ? 'never' : 'now',
            cwd,
            title: starter.projectName,
            view: 'tasks',
          })
          const session = await sessionFor(starter.projectName)
          let delivered = true
          let warning
          try {
            await submit({
              action,
              body: { ...body, name: starter.projectName, project: starter.projectName },
              project: starter.projectName,
              rev: written.rev,
              view: 'tasks',
            })
          } catch (error) {
            delivered = false
            warning = `项目已创建，但 agent 未能接手：${String(error?.message ?? error)}`
            logger?.warn?.(`codeflow: cannot deliver NEW: ${String(error)}`)
          }
          warning = [
            warning,
            session.warning,
            starter.renamed ? `项目名已被占用，改用「${starter.projectName}」` : '',
            cwd === undefined ? '未找到可用的 DSH 工作区：项目只保存在内存中，重启后会丢失' : '',
            written.persisted === false ? `图谱未能写入磁盘（${written.error ?? '未知原因'}）` : '',
          ].filter(Boolean).join('；') || undefined
          sendJson(res, 200, {
            ok: true,
            project: starter.projectName,
            view: 'tasks',
            rev: written.rev,
            graph: written.graph,
            delivered,
            ...sessionFields(starter.projectName),
            ...(written.file === undefined ? {} : { file: written.file }),
            ...(written.persisted === undefined ? {} : { persisted: written.persisted }),
            ...(warning === undefined ? {} : { warning }),
          })
          return
        }

        // The canvas is authoritative: adopt its graph before telling the agent
        // anything, so the file it is pointed at is what the user is looking at.
        // A stale writer is refused like any other (NEW is exempt: it creates
        // its own project, so it has no base revision to match).
        const cwd = await cwdOf(resolveCwd, body.project ?? project)
        const { view, viewport } = viewFieldsOf(body)
        const written = body.graph !== undefined
          ? await store.write(body.graph, { persist: 'now', view, viewport, cwd, expectedRev: body.expectedRev })
          : store.get(body.project ?? project)
        const runView = written?.view ?? view ?? 'tasks'
        let submitResult
        try {
          // The delivery layer resolves the dedicated session, snapshots the
          // tree (RUN_*), and only then can it quote the workspace-absolute
          // path of that view's durable graph.
          submitResult = await submit({ action, body, project: body.project ?? written?.key, rev: written?.rev ?? 0, view: runView })
        } catch (error) {
          logger?.warn?.(`codeflow: cannot deliver action ${action}: ${String(error)}`)
          sendJson(res, 409, { ok: false, error: String(error?.message ?? error) })
          return
        }
        const snapshot = submitResult?.snapshot
        const warnings = []
        if (snapshot !== undefined && snapshot.undoable === false) {
          warnings.push(`本次运行不可撤销：${snapshot.reason ?? '快照未创建'}`)
        } else if (snapshot !== undefined && snapshot.partial === true) {
          warnings.push('部分文件未纳入快照（符号链接或超大文件），撤销范围不完整')
        }
        sendJson(res, 200, {
          ok: true,
          rev: written?.rev ?? 0,
          view: runView,
          sessionId: submitResult?.sessionId,
          ...(snapshot?.runId !== undefined ? { runId: snapshot.runId, undoable: snapshot.undoable === true } : {}),
          ...(written?.persisted === undefined ? {} : { persisted: written.persisted }),
          ...(warnings.length === 0 ? {} : { warning: warnings.join('；') }),
        })
        return
      }

      // ---- durable projects ---------------------------------------------
      if (pathname === `${ROUTE_PREFIX}/api/projects` && method === 'GET') {
        const cwd = await cwdOf(resolveCwd, project)
        const projects = cwd === undefined ? [] : await store.listProjects(cwd)
        sendJson(res, 200, { ok: true, projects })
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      // Errors may carry an HTTP status (413 oversized body, 400 non-graph
      // payload, 409 revision conflict); only genuine faults log as failures.
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
      if (status >= 500) {
        logger?.warn?.(`codeflow: ${method} ${pathname} failed: ${String(error)}`)
      }
      sendJson(res, status, {
        ok: false,
        error: String(error?.message ?? error),
        ...(Number.isInteger(error?.currentRev) ? { currentRev: error.currentRev } : {}),
        ...(error?.view !== undefined ? { view: error.view } : {}),
      })
    }
  }
}
