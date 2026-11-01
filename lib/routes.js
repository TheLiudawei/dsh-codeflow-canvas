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
 *   GET  /codeflow/api/projects    durable projects (configured root + known
 *                                  roots + legacy `flow-projects/`)
 *   POST /codeflow/api/session     create a fresh canvas session / rebind
 *   GET  /codeflow/api/activity    live reasoning/step/progress/edits (memory)
 *   GET  /codeflow/api/undo        run history (newest first, `view` tagged)
 *   POST /codeflow/api/undo        restore one run (LIFO) or preview (`dryRun`)
 *   GET  /codeflow/api/features    feature-group index (features.json, v1.1;
 *                                  `refresh=1` re-runs the deterministic
 *                                  recognition, never a model)
 *   POST /codeflow/api/features    manual feature ops (label/rename/merge/
 *                                  dissolve/rebuild) → the manual section
 *   POST /codeflow/api/features/agent  deliver [CodeFlow:FEATURES] to the
 *                                  project's canvas session (explicit click
 *                                  only — never on menu open)
 *   GET  /codeflow/api/config      project root settings (v1.0)
 *   POST /codeflow/api/config      change the root / a project's directory
 *
 * Every write goes through the store, which owns each view's `rev`.
 *
 * @module dsh-codeflow-canvas/routes
 */
import { rename as renameFile, rm, stat as statFile } from 'node:fs/promises'
import path from 'node:path'

import { stripArchiveExtension, stripSingleRoot } from './archive.js'
import { computeStale as computeCouplingStale, isFileModuleNode, metaCouplingOf, runCoupling } from './coupling.js'
import { renderCanvasPage } from './canvas-page.js'
import { importProjectDual } from './duo.js'
import { createDropManager, DROP_LIMITS, resolveProjectName } from './drop-import.js'
import {
  FEATURES_FILE,
  buildFeatureIndex,
  computeStale,
  effectiveFeatures,
  emptyIndex,
  featureIdOf,
  featureOp,
  graphRootOf,
  mapNodes,
  readFeatureIndex,
  relOf,
  summarize,
  writeFeatureIndex,
} from './features.js'
import {
  defaultRoot, ensureLayout, migrationNotice, migrateLegacy, probeWritable, projectDir, readConfig,
  rootOf, validateConfiguredDir, writeConfig,
} from './paths.js'
import { buildStarterGraph } from './starter.js'
import { normalizeView, VIEW_LABEL } from './graph-format.js'
import { safeProjectName } from './core/path.js'
import { cleanPathInput } from './workspace.js'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/codeflow'

/** Upper bound on a request body: a graph plus view state is far smaller. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * `[CodeFlow:FEATURES]` 首行 JSON 之后的硬性要求正文（v1.1）。与 RUN_* 一样：
 * agent 必须遵守，且绝不允许它借机重扫全部代码或修改图文件。
 */
const FEATURES_AGENT_REQUIREMENTS = [
  '本次识别要求（必须遵守）：',
  '1. 只针对 candidates 列出的未归属模块做功能识别；不要重扫全部代码、不要读取无关文件；',
  '2. 结合节点标题、params.path 与你已有的项目知识判断功能归属；不确定的节点宁可不标（保持未归属），不要为了好看硬归类；',
  '3. 用 codeflow_features 工具一次性写入（op="write"），不要逐条调用、不要修改图文件、不要 bump rev；',
  '4. 写入完成后回复一行摘要（识别了几个功能、多少模块仍未归属）。',
].join('\n')

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
 * Read one raw (non-JSON) request body with a hard cap — the drop upload
 * channel (`/api/drop/file`) posts file bytes directly. Same keep-alive rule
 * as {@link readJsonBody}: a body that exceeds the cap is still drained to the
 * end before the 413 goes out, or the client's next request on the socket dies
 * with ECONNRESET.
 */
async function readRawBody(req, cap) {
  const chunks = []
  let total = 0
  let oversized = false
  for await (const chunk of req) {
    total += chunk.length
    if (total > cap) {
      oversized = true
      continue
    }
    chunks.push(chunk)
  }
  return { buffer: oversized ? null : Buffer.concat(chunks), total, oversized }
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
 * Resolve a project's durable directory under a workspace (v1.0, configurable
 * root). Never throws: an unresolved directory just means the store falls back
 * to the default-root spelling.
 */
async function dirOf(cwd, projectName) {
  if (cwd === undefined) return undefined
  try {
    return await projectDir(cwd, projectName)
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
      await store.load(project, cwd, await dirOf(cwd, project))
    } catch {
      // A named project that has no file yet is simply an empty canvas.
    }
    return
  }
  if (store.mostRecent() !== undefined) return
  const projects = await store.listProjects(cwd)
  for (const entry of projects) {
    try {
      const loaded = await store.load(entry.name, cwd, entry.dir)
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
 * @param options.deliverText - session manager `deliverText(project, prompt)`
 *   (used by POST /api/features/agent; optional, absence is an actionable 409).
 * @param options.sessionInfo - current binding snapshot for the panel.
 * @param options.activityRead - the activity hub's read model.
 * @param options.undoList - run history reader.
 * @param options.undoRestore - LIFO restore (with `dryRunOnly` support).
 * @returns a node:http style handler.
 */
export function createRouter({
  store, submit, logger, fence, resolveCwd,
  ensureSession, rebindSession, deliverText, sessionInfo, activityRead,
  undoList, undoRestore, migrateWorkspace,
}) {
  const deps = { resolveCwd }

  /** The most recent legacy-migration report (boot banner + config GET). */
  let lastMigration

  /**
   * Resolve the workspace and run the v1.0 one-time legacy migration for it
   * (best-effort, at most once per workspace thanks to `paths.migrateLegacy`)
   * plus the `mkdir -p` of the default `<workspace>/CodeFlow` the product
   * decision requires. Failure never blocks the request: the workspace is
   * still returned and the reason is logged (and surfaced on the boot banner
   * through the migration report when one exists).
   */
  async function workspaceReady(project) {
    const cwd = await cwdOf(resolveCwd, project)
    if (cwd === undefined) return undefined
    if (typeof migrateWorkspace === 'function') {
      try {
        const report = await migrateWorkspace(cwd)
        if (report !== undefined && report !== null) lastMigration = report
      } catch (error) {
        logger?.warn?.(`codeflow: legacy project migration failed for ${cwd}: ${String(error)}`)
      }
    }
    try {
      await ensureLayout(cwd)
    } catch (error) {
      logger?.warn?.(`codeflow: ${String(error?.message ?? error)}`)
    }
    return cwd
  }

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
      await store.loadView(project, cwd, viewName, await dirOf(cwd, project))
    } catch {
      // Unavailable stays unavailable; the views summary reports the reason.
    }
  }

  /* ---- v1.2：耦合分析 + 拖拽导入的共享编排 ------------------------------ */

  /**
   * 拖拽暂存区管理器，按 `imports/` 根惰性创建（每个根一个：30 分钟清扫一次、
   * 插件 dispose 时停止）。惰性是为了让既有组合（测试/极简宿主）零开销。
   * @type {Map<string, ReturnType<createDropManager>>}
   */
  const dropManagers = new Map()

  async function dropManagerFor(cwd) {
    const root = await rootOf(cwd)
    let manager = dropManagers.get(root)
    if (manager === undefined) {
      manager = createDropManager({ importsRoot: path.join(root, 'imports'), logger })
      dropManagers.set(root, manager)
      manager.start()
      // 首次创建即清扫一次（等价于「apply() 时清一次」，但此刻才知道根在哪）。
      await manager.sweep().catch(() => {})
    }
    return manager
  }

  /**
   * 对一个项目跑耦合分析并把结果写回两张图（modules 全量 + tasks 只镜像
   * meta.coupling）。这是 POST /api/coupling、导入后自动分析与拖拽导入共用的
   * 唯一编排点。不带 expectedRev（最后写入者胜，任务书 §4.5）。
   */
  async function runCouplingForProject(target, { cwd, dir, nodeId } = {}) {
    await ensureViewLoaded(target, 'modules')
    const modulesState = store.get(target, 'modules')
    const hasModules = modulesState.unavailable === undefined
      && Array.isArray(modulesState.graph?.nodes)
      && modulesState.graph.nodes.some(isFileModuleNode)
    if (!hasModules) {
      const error = new Error('当前项目没有模块结构图，请先导入项目')
      error.statusCode = 400
      throw error
    }
    if (nodeId !== undefined && nodeId !== null) {
      const node = modulesState.graph.nodes.find((entry) => entry.id === nodeId)
      if (node === undefined || !isFileModuleNode(node)) {
        const error = new Error(`该节点不存在或不是文件级模块节点：${String(nodeId)}`)
        error.statusCode = 400
        throw error
      }
    }
    const resolvedDir = modulesState.dir ?? dir ?? (await dirOf(cwd, target))
    const result = await runCoupling({
      graph: modulesState.graph,
      dir: resolvedDir,
      ...(nodeId !== undefined && nodeId !== null ? { nodeIds: [nodeId] } : {}),
    })
    // 写回 modules 图：只动被分析节点的 coupling 与 meta.coupling。
    const nextNodes = modulesState.graph.nodes.map((node) => {
      if (!result.perNode.has(node.id)) return node
      const coupling = result.perNode.get(node.id)
      const clean = { ...node }
      if (coupling === null) delete clean.coupling
      else clean.coupling = coupling
      return clean
    })
    const metaCoupling = metaCouplingOf({ root: result.root, overall: result.overall })
    const nextMeta = { ...modulesState.graph.meta }
    if (metaCoupling !== undefined) nextMeta.coupling = metaCoupling
    const written = await store.write(
      { ...modulesState.graph, nodes: nextNodes, meta: nextMeta },
      { view: 'modules', persist: 'now', cwd, dir: resolvedDir },
    )
    // tasks 图镜像：只替换 meta.coupling 一个键（任务书 §3.5 双视图隔离）。
    let mirrorWarning
    try {
      await ensureViewLoaded(target, 'tasks')
      const tasksState = store.get(target, 'tasks')
      if (tasksState.unavailable === undefined && (tasksState.rev > 0 || tasksState.viewLoaded === true)) {
        const mirror = metaCouplingOf({ root: result.root, overall: result.overall, source: 'modules' })
        const tasksMeta = { ...tasksState.graph.meta }
        if (mirror !== undefined) tasksMeta.coupling = mirror
        await store.write(
          { ...tasksState.graph, meta: tasksMeta },
          { view: 'tasks', persist: 'now', cwd, dir: resolvedDir },
        )
      }
    } catch (error) {
      mirrorWarning = `耦合结果已写入模块图，但任务图镜像失败：${String(error?.message ?? error)}`
      logger?.warn?.(`codeflow: coupling mirror failed for ${target}: ${String(error)}`)
    }
    return { result, written, mirrorWarning }
  }

  /** 覆盖同名项目前把旧图文件备份为 `.bak-<ts>`（任务书 §5.6；尽力而为）。 */
  async function backupProjectGraphs(cwd, projectKey) {
    try {
      const dir = await dirOf(cwd, projectKey)
      if (dir === undefined) return
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      for (const file of ['workflow.json', 'workflow.modules.json']) {
        try {
          const info = await statFile(path.join(dir, file))
          if (!info.isFile()) continue
          await renameFile(path.join(dir, file), path.join(dir, `${file}.bak-${stamp}`))
        } catch {
          // 文件不存在或被占用：没有可备份的旧图，直接覆盖。
        }
      }
    } catch (error) {
      logger?.warn?.(`codeflow: project graph backup failed for ${projectKey}: ${String(error)}`)
    }
  }

  /**
   * 导入结果的统一落地流程（/api/import、/api/drop/finalize、/api/drop/path
   * 共用，v1.2）：写两张图 → v1.1 功能索引钩子 → v1.2 自动耦合分析（纯本地，
   * 零 token）→ 专用会话 → 组装响应载荷。耦合失败只降级为 `coupling:null`。
   */
  async function landImportResult(result, { cwd } = {}) {
    const importDir = await dirOf(cwd, result.name)
    const writtenTasks = await store.write(result.tasksGraph, { persist: 'now', cwd, dir: importDir, view: 'tasks' })
    let writtenModules
    if (result.modulesGraph !== undefined) {
      try {
        writtenModules = await store.write(result.modulesGraph, { persist: 'now', cwd, dir: importDir, view: 'modules' })
      } catch (error) {
        writtenModules = { error: String(error?.message ?? error) }
      }
    }
    // v1.1 导入钩子：两张图生成后立刻做一次功能识别并落盘（纯本地、确定性）。
    // 识别失败只降级为「没有 featuresSummary」，绝不影响导入结果。
    let featuresSummary
    if (importDir !== undefined && result.modulesGraph !== undefined) {
      try {
        const built = await buildFeatureIndex({
          root: sourceRootOf(result.modulesGraph, importDir),
          graph: result.modulesGraph,
        })
        await writeFeatureIndex(importDir, built)
        featuresSummary = summarize(built)
      } catch (error) {
        logger?.warn?.(`codeflow: feature recognition failed after import: ${String(error)}`)
      }
    }
    // v1.2 导入钩子：自动跑一次「全部」耦合分析并镜像到任务图。失败只降级。
    let coupling = null
    if (result.modulesGraph !== undefined) {
      try {
        const coupled = await runCouplingForProject(result.name, { cwd, dir: importDir })
        if (coupled.result.overall !== null) coupling = { overall: coupled.result.overall }
      } catch (error) {
        logger?.warn?.(`codeflow: auto coupling after import failed: ${String(error)}`)
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
    return {
      ok: true,
      project: writtenTasks.key,
      view: 'tasks',
      activeView: 'tasks',
      rev: writtenTasks.rev,
      summary: featuresSummary !== undefined ? `${result.summary}；${featuresSummary}` : result.summary,
      tasksSummary: result.tasksSummary,
      modulesSummary: result.modulesSummary ?? null,
      modulesAvailable: result.modulesGraph !== undefined,
      ...(featuresSummary !== undefined ? { featuresSummary } : {}),
      coupling,
      file: writtenTasks.file ?? (cwd === undefined ? null : store.filePath(writtenTasks.key, 'tasks') ?? null),
      graph: writtenTasks.graph,
      views,
      ...(writtenTasks.persisted === undefined ? {} : { persisted: writtenTasks.persisted }),
      ...(warning === undefined ? {} : { warning }),
    }
  }

  /**
   * 拖拽导入的落地编排（/api/drop/finalize 与 /api/drop/path 共用）：
   * 冲突预检（imports/<包名> + 项目名，409 时暂存区原样保留）→ 物化（移动
   * 暂存 / 解压到 imports/<包名>）→ 去壳 → 双图导入 → 特征索引 → 自动耦合
   * → 会话。除「项目名冲突」以外的失败都会清理解压目录与暂存区，绝不留半成品。
   */
  async function finalizeDrop(body = {}) {
    const viaPath = typeof body.path === 'string' && body.path.length > 0
    const kind = body.kind === 'archive' ? 'archive' : 'dir'
    const overwrite = body.overwrite === true
    const rename = body.rename === true
    const cwd = await workspaceReady(undefined)
    if (cwd === undefined) {
      const error = new Error('还没有可用的 DSH 工作区，无法导入拖入的项目')
      error.statusCode = 409
      throw error
    }
    const manager = await dropManagerFor(cwd)
    const token = viaPath ? null : String(body.token ?? '')
    const session = viaPath ? null : manager.sessionOf(token)
    if (!viaPath && session === undefined) {
      throw Object.assign(new Error('上传会话不存在或已过期，请重新拖入'), { statusCode: 400 })
    }
    if (!viaPath && session.kind !== kind) {
      throw Object.assign(new Error('上传会话类型不匹配，请重新拖入'), { statusCode: 400 })
    }
    const baseName = viaPath ? path.basename(String(body.path)) : (session.name || 'import')
    const pkgBase = safeProjectName(kind === 'archive' ? stripArchiveExtension(baseName) : baseName)
    // ---- 冲突预检 A：imports/<包名>（物化之前，暂存区原样保留）--------------
    let pkgName = null
    if (kind === 'archive' || !viaPath) {
      const resolvedPkg = await manager.resolvePkgName(pkgBase, { rename, overwrite })
      pkgName = resolvedPkg.pkgName
    }
    // ---- 冲突预检 B：项目名（用去壳前可知道的名字；暂存区不消耗）-----------
    const desiredBefore = typeof body.projectName === 'string' && body.projectName.trim().length > 0
      ? body.projectName
      : pkgName ?? pkgBase
    const existingNames = new Set(
      await store.listProjects(cwd).then((entries) => entries.map((entry) => entry.name)).catch(() => []),
    )
    for (const key of store.keys()) existingNames.add(key)
    await resolveProjectName(desiredBefore, {
      exists: (name) => Promise.resolve(existingNames.has(name)),
      rename, overwrite,
    })
    // ---- 物化 + 导入（失败清理；此后的项目名冲突不再删已解压目录）----------
    let sourceRoot
    let extractedTo = null
    let innerName = null
    try {
      if (viaPath) {
        const clean = cleanPathInput(String(body.path), { cwd })
        const info = await statFile(clean).catch(() => undefined)
        if (info === undefined) throw Object.assign(new Error(`路径不存在：${clean}`), { statusCode: 400 })
        if (kind === 'archive') {
          if (!info.isFile()) throw Object.assign(new Error('压缩包路径不是文件'), { statusCode: 400 })
          const commit = await manager.commitPathArchive(clean, pkgName)
          extractedTo = commit.target
        } else {
          if (!info.isDirectory()) throw Object.assign(new Error('文件夹路径不是目录'), { statusCode: 400 })
          sourceRoot = clean
        }
      } else if (kind === 'archive') {
        const commit = await manager.commitStagedArchive(token, pkgName)
        extractedTo = commit.target
      } else {
        extractedTo = await manager.commitDirUpload(token, pkgName)
      }
      if (extractedTo !== null) {
        const shell = await stripSingleRoot(extractedTo)
        sourceRoot = shell.sourceRoot
        innerName = shell.innerName
      }
      // 去壳后发现内层目录名：默认项目名让位给它（任务书 §5.4 去壳）。
      const desired = typeof body.projectName === 'string' && body.projectName.trim().length > 0
        ? body.projectName
        : (innerName ?? pkgName ?? pkgBase)
      const nameResolved = await resolveProjectName(desired, {
        exists: (name) => Promise.resolve(existingNames.has(name)),
        rename, overwrite,
      })
      if (overwrite && nameResolved.existed) await backupProjectGraphs(cwd, nameResolved.projectName)
      const imported = await importProjectDual({
        path: sourceRoot,
        cwd,
        maxFiles: 1000,
        maxDepth: Number(body.depth) || 4,
        fromComments: body.fromComments !== false,
        addTests: body.addTests !== false,
        projectName: nameResolved.projectName,
        existingNames: [],
      })
      const payload = await landImportResult(imported, { cwd })
      if (token !== null) await manager.cleanup(token).catch(() => {})
      return {
        ...payload,
        sourceRoot,
        ...(extractedTo !== null ? { extractedTo } : {}),
        ...(pkgName !== null ? { pkgName } : {}),
      }
    } catch (error) {
      // 半成品清理：解压目录与暂存区都删掉（项目名冲突除外——预检已在那之前
      // 拦住；去壳后才暴露的同名冲突保留目录，用户可重拖）。
      if (error?.code !== 'conflict' && extractedTo !== null && pkgName !== null) {
        await rm(path.join(manager.importsRoot, pkgName), { recursive: true, force: true }).catch(() => {})
      }
      if (token !== null) await manager.abort(token).catch(() => {})
      throw error
    }
  }

  /* ---- v1.1：功能分组索引（features.json）共享路径 ---- */

  /** 项目的源码根：图 meta.importedFrom，退回项目自身目录。 */
  function sourceRootOf(graph, fallbackDir) {
    return graphRootOf(graph) ?? fallbackDir
  }

  /**
   * 读取（必要时自动识别一次）项目的功能索引。文件缺失 → 识别并落盘；
   * 文件损坏（`_degraded`）→ 内存兜底重建，不覆盖用户手写文件；
   * `refresh=1` → 重新识别并落盘（manual 原样保留）。识别失败不影响响应。
   */
  async function featuresIndexOf(target, dir) {
    let index = await readFeatureIndex(dir)
    let degraded = index?._degraded === true
    if (index === null || degraded) {
      const root = sourceRootOf(store.get(target, 'modules').graph, dir)
      try {
        const built = await buildFeatureIndex({ root, manual: index?.manual })
        if (index === null) {
          // 首次：落盘，之后人工编辑与「重新识别」都以文件为准。
          index = await writeFeatureIndex(dir, built).catch(() => built)
        } else {
          // 损坏：内存兜底（保留 manual），不覆盖用户手写的文件。
          index = { ...built, manual: index.manual }
        }
        degraded = false
      } catch (error) {
        logger?.warn?.(`codeflow: feature recognition failed for ${target}: ${String(error)}`)
        index = index ?? emptyIndex()
        index.unavailable = String(error?.message ?? error)
      }
    }
    return { index: index ?? emptyIndex(), degraded }
  }

  /** GET/POST 响应共用的紧凑载荷（按请求的视图映射节点）。 */
  async function featuresPayload(target, viewName, index, dir, { degraded = false, extra = {} } = {}) {
    const state = store.get(target, viewName)
    const modulesState = store.get(target, 'modules')
    const root = sourceRootOf(state.graph, dir)
    const eff = effectiveFeatures(index)
    const mapped = mapNodes(eff, state.graph, { root, manual: index.manual })
    const modulesMapped = viewName === 'tasks' && (modulesState.graph?.nodes?.length ?? 0) > 0
      ? mapNodes(eff, modulesState.graph, { root: sourceRootOf(modulesState.graph, dir), manual: index.manual })
      : null
    const stale = degraded || (await computeStale(index, dir))
    return {
      ok: true,
      project: store.get(target).key,
      view: viewName,
      available: index.unavailable === undefined,
      ...(index.unavailable !== undefined ? { reason: index.unavailable } : {}),
      generatedAt: index.generatedAt ?? null,
      source: index.source ?? null,
      stale,
      features: mapped.features.map((feature) => {
        const modulesNodes = viewName === 'modules'
          ? (feature.nodes ?? [])
          : (modulesMapped?.features.find((entry) => entry.name === feature.name)?.nodes ?? [])
        return {
          id: featureIdOf(feature.name),
          name: feature.name,
          aliases: feature.aliases ?? [],
          count: (feature.nodes ?? []).length,
          nodes: feature.nodes ?? [],
          files: feature.files ?? [],
          confidence: Math.round((feature.confidence ?? 0) * 100) / 100,
          low: (feature.confidence ?? 0) < 0.5,
          modulesCount: modulesNodes.length,
          modulesNodes,
        }
      }),
      unmappedCount: (mapped.unmapped ?? []).length,
      summary: summarize(index),
      ...extra,
    }
  }

  /** The route handler, with drop-staging lifecycle hooks attached. */
  async function handle(req, res) {
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
        // showed an empty canvas even though projects existed on disk.
        const wantsBoot = url.searchParams.get('boot') === '1' || project !== undefined
        let workspace
        let migration
        if (wantsBoot) {
          workspace = await workspaceReady(project)
          await bootProject(store, workspace, project)
          // v1.0: the one-time legacy migration reports itself exactly once —
          // only when it actually moved something (or hit conflicts/failures).
          migration = migrationNotice(lastMigration)
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
          // v1.0: resolved durable directory of the project the panel opens on.
          projectDir: current.dir ?? (workspace !== undefined ? await dirOf(workspace, project ?? current.key) : null),
          degraded: current.degraded ?? null,
          notice,
          ...(migration !== undefined ? { migration } : {}),
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
            // v1.0: where this project actually lives on disk (status-bar tooltip).
            projectDir: current.dir ?? null,
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
          const writtenProject = (body.graph !== null && typeof body.graph === 'object' ? body.graph?.project?.name : undefined)
            ?? body.project ?? project
          // The durable outcome is known before answering: autosave used to be
          // debounced server-side, so a failed disk write reached the client as
          // `{"ok":true}` with no `persisted` field at all — the user believed
          // the graph was saved while only the log knew it was not.
          const written = await store.write(body.graph ?? body, {
            persist: 'now',
            view,
            viewport,
            cwd,
            dir: await dirOf(cwd, writtenProject),
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

      // ---- 功能分组索引（v1.1，零模型） ----------------------------------
      // GET  → 紧凑索引（打开「方案/构建」浮层时调用；refresh=1 重新识别）。
      // POST → manual 写操作（label/rename/merge/dissolve/rebuild）。
      // 两者都只动 features.json，绝不触碰图文件与 rev。
      if (pathname === `${ROUTE_PREFIX}/api/features` && method === 'GET') {
        const target = project ?? store.mostRecent()
        if (target === undefined || String(target).length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected a project name' })
          return
        }
        const wanted = normalizeView(url.searchParams.get('view'))
        const viewName = wanted ?? store.get(target).activeView ?? 'tasks'
        await ensureViewLoaded(target, viewName)
        await ensureViewLoaded(target, viewName === 'modules' ? 'tasks' : 'modules')
        const state = store.get(target, viewName)
        const cwd = await cwdOf(resolveCwd, target)
        const dir = state.dir ?? (await dirOf(cwd, target))
        if (dir === undefined) {
          sendJson(res, 200, {
            ok: true, project: store.get(target).key, view: viewName, available: false,
            reason: '项目未绑定工作区，无法读取或生成 features.json',
            generatedAt: null, source: null, stale: true, features: [], unmappedCount: 0,
          })
          return
        }
        const { index, degraded } = await featuresIndexOf(target, dir)
        if (url.searchParams.get('refresh') === '1') {
          // 「重新识别」：重算 auto 段并落盘（manual 原样保留）。
          try {
            const built = await buildFeatureIndex({
              root: sourceRootOf(store.get(target, 'modules').graph, dir),
              manual: index.manual,
            })
            index = { ...built, manual: index.manual }
            await writeFeatureIndex(dir, index)
          } catch (error) {
            logger?.warn?.(`codeflow: feature recognition failed for ${target}: ${String(error)}`)
            index.unavailable = String(error?.message ?? error)
          }
        }
        sendJson(res, 200, await featuresPayload(target, viewName, index, dir, { degraded }))
        return
      }
      if (pathname === `${ROUTE_PREFIX}/api/features` && method === 'POST') {
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: 'expected a JSON body' })
          return
        }
        const op = String(body.op ?? '')
        if (!['label', 'rename', 'merge', 'dissolve', 'rebuild'].includes(op)) {
          sendJson(res, 400, { ok: false, error: `unknown op "${op}"` })
          return
        }
        const target = body.project ?? project ?? store.mostRecent()
        if (target === undefined || String(target).length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected a project name' })
          return
        }
        const viewName = normalizeView(body.view) ?? store.get(target).activeView ?? 'tasks'
        await ensureViewLoaded(target, viewName)
        await ensureViewLoaded(target, 'modules')
        const cwd = await cwdOf(resolveCwd, target)
        const dir = store.get(target).dir ?? (await dirOf(cwd, target))
        if (dir === undefined) {
          sendJson(res, 409, { ok: false, error: '项目未绑定工作区，无法写入 features.json' })
          return
        }
        let index = await readFeatureIndex(dir)
        if (index === null) index = emptyIndex()
        const modulesGraph = store.get(target, 'modules').graph
        const root = sourceRootOf(modulesGraph, dir)
        try {
          const result = await featureOp({
            op, body, index, dir, root, graph: modulesGraph, logger,
          })
          index = result.index
        } catch (error) {
          const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400
          sendJson(res, status, { ok: false, error: String(error?.message ?? error) })
          return
        }
        sendJson(res, 200, await featuresPayload(target, viewName, index, dir, { extra: { op } }))
        return
      }
      // 向项目专用会话投递 [CodeFlow:FEATURES]（唯一 LLM 路径；仅显式点击触发）。
      // 不做快照、不 bump rev；会话不可用时返回可行动错误。
      if (pathname === `${ROUTE_PREFIX}/api/features/agent` && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {}
        const target = body?.project ?? project ?? store.mostRecent()
        if (target === undefined || String(target).length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected a project name' })
          return
        }
        if (typeof deliverText !== 'function') {
          sendJson(res, 409, { ok: false, error: '宿主未提供会话投递通道（sessionController 缺失），无法请求 agent 识别' })
          return
        }
        await ensureViewLoaded(target, 'modules')
        const state = store.get(target)
        const cwd = await cwdOf(resolveCwd, target)
        const dir = state.dir ?? (await dirOf(cwd, target))
        if (dir === undefined) {
          sendJson(res, 409, { ok: false, error: '项目未绑定工作区，无法生成识别请求' })
          return
        }
        const { index } = await featuresIndexOf(target, dir)
        const modulesState = store.get(target, 'modules')
        const modulesGraph = modulesState.graph
        const root = sourceRootOf(modulesGraph, dir)
        const eff = effectiveFeatures(index)
        const mapped = mapNodes(eff, (modulesGraph?.nodes?.length ?? 0) > 0 ? modulesGraph : state.graph, { root, manual: index.manual })
        const pool = (modulesGraph?.nodes?.length ?? 0) > 0 ? modulesGraph.nodes : state.graph.nodes
        const candidates = (mapped.unmapped ?? []).slice(0, 40).map((nodeId) => {
          const node = pool.find((entry) => entry?.id === nodeId)
          const rel = relOf(node?.params?.path, root)
          return {
            id: nodeId,
            title: String(node?.title ?? nodeId),
            ...(rel.length > 0 ? { path: rel } : node?.params?.path ? { path: String(node.params.path) } : {}),
          }
        })
        const payload = {
          action: 'FEATURES',
          project: store.get(target).key,
          view: 'modules',
          rev: store.get(target, 'modules').rev ?? 0,
          graphPath: store.filePath(target, 'modules') ?? store.filePath(target, 'tasks') ?? '',
          featuresPath: path.join(dir, FEATURES_FILE),
          candidates,
          reason: '用户在画布上点击了「让 agent 识别」',
        }
        try {
          const sessionId = await deliverText(String(target), `[CodeFlow:FEATURES]${JSON.stringify(payload)}\n\n${FEATURES_AGENT_REQUIREMENTS}`)
          sendJson(res, 200, {
            ok: true,
            project: store.get(target).key,
            delivered: true,
            ...(sessionId !== undefined ? { sessionId } : {}),
            candidates: candidates.length,
          })
        } catch (error) {
          sendJson(res, 409, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }

      // ---- persist without a turn ---------------------------------------
      if (pathname === `${ROUTE_PREFIX}/api/save` && method === 'POST') {
        const body = await readJsonBody(req)
        let target = body?.project ?? project ?? store.mostRecent()
        const cwd = await cwdOf(resolveCwd, target)
        const { view, viewport } = viewFieldsOf(body ?? {})
        if (body !== undefined && body !== null && typeof body === 'object' && body.graph !== undefined) {
          const named = body.graph?.project?.name
          const written = await store.write(body.graph, {
            persist: 'now',
            view,
            viewport,
            cwd,
            dir: await dirOf(cwd, named ?? target),
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
        const cwd = await workspaceReady(project)
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
        // module graph is a second file of the same project. v1.0: both files
        // go to the configured root's `flow-projects/<name>/`. v1.2: the rest
        // of the landing (graphs, feature index, auto coupling, session) is
        // shared with the drop-import routes via `landImportResult`.
        const payload = await landImportResult(result, { cwd })
        sendJson(res, 200, payload)
        return
      }

      // ---- 耦合分析（v1.2，零 LLM）----------------------------------------
      // POST /api/coupling  → 分析一个（nodeId）或全部文件级模块节点，写回
      //                       modules 图并镜像 tasks meta.coupling。
      // GET  /api/coupling  → 过期判定（mtime 探测，10s 缓存，≤300 文件）。
      if (pathname === `${ROUTE_PREFIX}/api/coupling` && method === 'POST') {
        const body = await readJsonBody(req)
        const target = (body !== null && typeof body === 'object' ? body.project : undefined) ?? project ?? store.mostRecent()
        if (target === undefined || String(target).length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected a project name' })
          return
        }
        const cwd = await workspaceReady(String(target))
        const dir = await dirOf(cwd, String(target))
        const nodeId = body !== null && typeof body === 'object' && typeof body.nodeId === 'string' && body.nodeId.length > 0
          ? body.nodeId
          : null
        const { result, written, mirrorWarning } = await runCouplingForProject(String(target), {
          cwd,
          dir,
          ...(nodeId !== null ? { nodeId } : {}),
        })
        const overall = result.overall
        const updated = [...result.perNode.entries()]
          .filter(([, coupling]) => coupling !== null)
          .map(([id, coupling]) => ({ id, level: coupling.level, score: coupling.score }))
        const warning = [
          mirrorWarning,
          result.skipped.length > 0 ? `${result.skipped.length} 个模块源文件缺失，已清除其耦合标签` : '',
        ].filter(Boolean).join('；') || null
        sendJson(res, 200, {
          ok: true,
          view: 'modules',
          rev: written.rev,
          partial: overall !== null ? overall.partial === true : true,
          overall,
          updated,
          skippedCount: result.skipped.length,
          durationMs: result.durationMs,
          warning,
        })
        return
      }
      if (pathname === `${ROUTE_PREFIX}/api/coupling` && method === 'GET') {
        const target = project ?? store.mostRecent()
        if (target === undefined || String(target).length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected a project name' })
          return
        }
        await ensureViewLoaded(String(target), 'modules')
        const state = store.get(String(target), 'modules')
        const graph = state.graph
        const meta = graph?.meta?.coupling ?? null
        if (meta === null || typeof meta !== 'object' || meta.overall === undefined) {
          sendJson(res, 200, { ok: true, overall: null, stale: { overall: false, nodes: {} }, at: null })
          return
        }
        const cacheKey = `${String(target)}|${String(meta.at ?? '')}|${Array.isArray(graph.nodes) ? graph.nodes.length : 0}`
        const stale = await computeCouplingStale({ graph, cacheKey })
        sendJson(res, 200, { ok: true, overall: meta.overall ?? null, stale, at: meta.at ?? null })
        return
      }

      // ---- 拖拽导入（v1.2，零 LLM）----------------------------------------
      // 上传通道（浏览器拿不到拖入文件的真实路径时的主路径）：
      //   begin    → 校验限额，发 token，建 .staging/<token>/
      //   file     → raw body 逐文件上传（单文件 ≤64MB，累计 ≤500MB）
      //   finalize → 物化到 imports/<包名>/ → 双图导入 → 自动耦合 → 会话
      //   abort    → 删除暂存目录（幂等）
      // 真实路径通道（宿主暴露 getPathForFile 时才用得到）：/api/drop/path。
      if (pathname === `${ROUTE_PREFIX}/api/drop/begin` && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {}
        const cwd = await workspaceReady(undefined)
        if (cwd === undefined) {
          sendJson(res, 409, { ok: false, error: '还没有可用的 DSH 工作区，无法导入拖入的项目' })
          return
        }
        const manager = await dropManagerFor(cwd)
        const result = await manager.begin(body)
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (pathname === `${ROUTE_PREFIX}/api/drop/file` && method === 'POST') {
        // 先排空请求体（超限继续读完再答 413，保住 keep-alive；照抄
        // readJsonBody 的排空注释），再做一切校验。
        const { buffer, oversized } = await readRawBody(req, DROP_LIMITS.maxFileBytes)
        const token = url.searchParams.get('token') ?? ''
        const rawRel = url.searchParams.get('path') ?? ''
        const contentType = String(req.headers['content-type'] ?? '')
        if (oversized) {
          sendJson(res, 413, { ok: false, error: '单文件超过 64 MB，已拒绝导入' })
          return
        }
        if (contentType.length > 0 && !contentType.startsWith('application/octet-stream')) {
          sendJson(res, 400, { ok: false, error: '文件上传必须使用 application/octet-stream' })
          return
        }
        const cwd = await workspaceReady(undefined)
        if (cwd === undefined) {
          sendJson(res, 409, { ok: false, error: '还没有可用的 DSH 工作区，无法导入拖入的项目' })
          return
        }
        const manager = await dropManagerFor(cwd)
        try {
          const result = await manager.writeFile(token, rawRel, buffer ?? Buffer.alloc(0))
          sendJson(res, 200, { ok: true, received: result.received })
        } catch (error) {
          const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400
          // 限额违规（413）按附录 C 清理该 token 的暂存。
          if (status === 413) await manager.abort(token).catch(() => {})
          sendJson(res, status, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }
      if (pathname === `${ROUTE_PREFIX}/api/drop/finalize` && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {}
        const payload = await finalizeDrop(body)
        sendJson(res, 200, payload)
        return
      }
      if (pathname === `${ROUTE_PREFIX}/api/drop/abort` && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {}
        const cwd = await workspaceReady(undefined)
        if (cwd !== undefined) {
          const manager = await dropManagerFor(cwd)
          await manager.abort(String(body.token ?? '')).catch(() => {})
        }
        sendJson(res, 200, { ok: true })
        return
      }
      if (pathname === `${ROUTE_PREFIX}/api/drop/path` && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {}
        const payload = await finalizeDrop(body)
        sendJson(res, 200, payload)
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
          const cwd = await workspaceReady(undefined)
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
            // v1.0: new projects land in `<root>/flow-projects/<name>/`.
            dir: await dirOf(cwd, starter.projectName),
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
          ? await store.write(body.graph, {
              persist: 'now',
              view,
              viewport,
              cwd,
              dir: await dirOf(cwd, body.project ?? body.graph?.project?.name ?? project),
              expectedRev: body.expectedRev,
            })
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
          // v1.0 A3.3: the delivery layer flips the target node to `running`
          // right after the graph write, which bumps the view's rev once more.
          // Answer with the store's *live* rev so the panel's next autosave
          // does not 409 against its own click.
          rev: store.get(body.project ?? written?.key, runView)?.rev ?? written?.rev ?? 0,
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
        // First list of a session is also the lazy migration trigger: the old
        // `<workspace>/flow-projects/` moves into `<root>/flow-projects/` once.
        const cwd = await workspaceReady(project)
        const projects = cwd === undefined ? [] : await store.listProjects(cwd)
        sendJson(res, 200, {
          ok: true,
          projects,
          ...(cwd !== undefined ? { root: await rootOf(cwd).catch(() => undefined), defaultRoot: defaultRoot(cwd) } : {}),
        })
        return
      }

      // ---- project root settings (v1.0) ----------------------------------
      // GET  → the effective root / the project's effective directory.
      // POST → change the root (or restore the default) and/or set/clear a
      //        per-project directory override. Validation mirrors the canvas
      //        contract: absolute paths only, no files, no plugin-package
      //        paths, and the target must be creatable + writable (probe file).
      if (pathname === `${ROUTE_PREFIX}/api/config` && method === 'GET') {
        const cwd = await workspaceReady(project)
        if (cwd === undefined) {
          sendJson(res, 409, { ok: false, error: '还没有可用的 DSH 工作区，无法读取 CodeFlow 设置。请先在 DSH 里打开一个项目或工作区。' })
          return
        }
        const cfg = await readConfig(cwd)
        const projectName = project ?? undefined
        const effectiveDir = projectName !== undefined ? await dirOf(cwd, projectName) : undefined
        sendJson(res, 200, {
          ok: true,
          workspace: cwd,
          defaultRoot: defaultRoot(cwd),
          root: cfg.root ?? defaultRoot(cwd),
          customRoot: cfg.root ?? null,
          project: projectName ?? null,
          projectDir: effectiveDir ?? null,
          projectOverride: projectName !== undefined ? cfg.projects?.[projectName]?.dir ?? null : undefined,
          overrides: cfg.projects ?? {},
          migrated: cfg.migratedAt ?? null,
          ...(lastMigration !== undefined ? { lastMigration } : {}),
        })
        return
      }
      if (pathname === `${ROUTE_PREFIX}/api/config` && method === 'POST') {
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: 'expected a JSON body' })
          return
        }
        const cwd = await cwdOf(resolveCwd, body.project ?? project)
        if (cwd === undefined) {
          sendJson(res, 409, { ok: false, error: '还没有可用的 DSH 工作区，无法保存 CodeFlow 设置。请先在 DSH 里打开一个项目或工作区。' })
          return
        }
        const cfg = await readConfig(cwd)
        try {
          if (body.root !== undefined) {
            if (body.root === null) {
              // 恢复默认根：旧根进 knownRoots（里面的项目仍可列出/打开）。
              if (cfg.root !== null && !cfg.knownRoots.includes(cfg.root)) cfg.knownRoots.push(cfg.root)
              cfg.root = null
            } else {
              const nextRoot = await validateConfiguredDir(body.root, { kind: '项目根目录' })
              // 根必须真能放下项目：探测它下面的 flow-projects 可建可写。
              await probeWritable(path.join(nextRoot, 'flow-projects'))
              // 改根不搬家：旧根记入 knownRoots，旧项目仍从旧位置列出。
              if (cfg.root !== null && cfg.root !== nextRoot && !cfg.knownRoots.includes(cfg.root)) {
                cfg.knownRoots.push(cfg.root)
              }
              cfg.root = nextRoot
            }
          }
          if (body.projectDir !== undefined) {
            const projectName = typeof body.project === 'string' && body.project.trim().length > 0 ? body.project.trim() : undefined
            if (projectName === undefined) {
              const error = new Error('设置项目目录时必须带上 project（项目名）。')
              error.statusCode = 400
              throw error
            }
            const key = String(projectName)
            if (body.projectDir === null) {
              delete cfg.projects[key]
            } else {
              const nextDir = await validateConfiguredDir(body.projectDir, { kind: '项目目录' })
              await probeWritable(nextDir)
              cfg.projects[key] = { dir: nextDir, updatedAt: Date.now() }
            }
          }
        } catch (error) {
          const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400
          sendJson(res, status, { ok: false, error: String(error?.message ?? error) })
          return
        }
        const saved = await writeConfig(cwd, cfg).catch((error) => {
          const failure = new Error(`配置写入失败：${String(error?.message ?? error)}`)
          failure.statusCode = 409
          throw failure
        })
        const projectName = typeof body.project === 'string' && body.project.trim().length > 0 ? body.project.trim() : undefined
        sendJson(res, 200, {
          ok: true,
          workspace: cwd,
          defaultRoot: defaultRoot(cwd),
          root: saved.root ?? defaultRoot(cwd),
          customRoot: saved.root ?? null,
          ...(projectName !== undefined ? { project: projectName, projectDir: await dirOf(cwd, projectName) } : {}),
        })
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
        // v1.2 拖拽导入的 409 conflict：客户端据此弹「覆盖 / 改名 / 取消」。
        ...(error?.code !== undefined ? { code: error.code } : {}),
        ...(error?.target !== undefined ? { target: error.target } : {}),
        ...(error?.current !== undefined ? { current: error.current } : {}),
      })
    }
  }

  /** Stop every drop-import sweeper (plugin dispose). */
  handle.dispose = () => {
    for (const manager of dropManagers.values()) manager.dispose()
    dropManagers.clear()
  }
  return handle
}
