/**
 * 画布状态存储：每个项目的画布能展示的图，以及 `<根>/flow-projects/<项目>/`
 * 下的持久副本（v1.0 起根默认为 `<工作区>/CodeFlow`，可按工作区/按项目配置
 * ——路径拼装统一由 `lib/paths.js` 完成，命名规则在 `lib/core/path.js`）。
 *
 * 自 v0.6.0 起一个项目持有**两个独立视图**，各自是完整自洽的 `codeflow/1`
 * 图，各有独立的修订号：
 *
 *   tasks   → `workflow.json`          （任务流水线；历史文件）
 *   modules → `workflow.modules.json`  （模块结构图）
 *
 * 旧项目零迁移兼容：
 *
 *   - 只有 `workflow.json` 且 `meta.strategy !== 'modules'` → tasks 视图；
 *   - 只有 `workflow.json` 且 `meta.strategy === 'modules'` → 该文件**就是**
 *     modules 视图的持久副本（绝不重命名或复制——重命名会让 v0.6.0 之前
 *     安装的项目的画布绑定变成孤儿），tasks 视图不可用；
 *   - 两个文件都在 → 双视图。
 *
 * store 是唯一写者。两侧都经过它：浏览器面板经 HTTP 推送编辑、agent 经
 * `codeflow_canvas` 工具回填，每次被接受的写只把**目标视图**的 `rev` 恰好
 * 加一——写一个视图绝不会扰动另一个。读取方只在看到"不是自己写的 rev"
 * 时才采纳新图，这正是面板与 agent 互不覆盖的机制。
 *
 * 路径解析（v1.0）：store 在内存里为每个项目持有 `state.dir`——项目的
 * **实际**持久目录，由调用方经 `lib/paths.js` 解析后显式传入
 * （`write`/`load`/`loadView`/`bindCwd` 都接受 `dir`）。调用方没有解析时
 * （headless 组合、测试），回退到默认根拼写
 * `<cwd>/CodeFlow/flow-projects/<项目>/`，所有内部读取方照常工作。rev
 * 语义、expectedRev 冲突检测、原子写与损坏隔离完全不受目录来源影响。
 *
 * 本文件原来还承载图格式清洗（normalize* 系列）、项目命名与原子写；重构后
 * 它们分别下沉到 `lib/graph-format.js`、`lib/core/path.js`、
 * `lib/core/fsio.js`，这里保留 re-export 作为历史兼容面（tests 与既有调用方
 * 仍从本模块导入），正文只负责状态管理本身。
 *
 * 依赖方向：core/* 与 graph-format（第 0/2 层）← 本模块 ← index/routes/
 * tool/sessions/undo/activity（经导入或注入）。对 paths.js 只保留单向依赖
 * （`listProjectDirs`，项目列表扫描用），`store ⇄ paths` 的历史循环就此斩断。
 *
 * @module dsh-codeflow-canvas/store
 */
import { readFile, rename, stat as statFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { atomicWriteFile } from './core/fsio.js'
import { projectDirPath, projectKeyOf, UNTITLED_KEY } from './core/path.js'
import {
  DEFAULT_VIEW,
  NODE_STATUSES,
  VIEW_FILES,
  VIEW_KEYS,
  VIEW_LABEL,
  VIEW_SIDECAR_FILE,
  emptyGraph,
  normalizeArtifacts,
  normalizeGraph,
  normalizePresented,
  normalizeView,
  viewOfNodeId,
} from './graph-format.js'
import { listProjectDirs } from './paths.js'

/* -------------------------------------------------- 历史兼容面 re-export --- */
/* 下列符号原来定义在本文件；重构后属于图格式/命名/IO 契约，定义在更底层。
 * 保留导出，tests 与既有调用方继续从 store.js 导入即可，无需任何改动。 */

export { atomicWriteFile } from './core/fsio.js'
export { UNTITLED_KEY, projectDirOf, projectDirPath, projectKeyOf, safeProjectName } from './core/path.js'
export {
  DEFAULT_VIEW,
  MAX_ARTIFACTS_PER_NODE,
  VIEW_FILES,
  VIEW_KEYS,
  VIEW_LABEL,
  VIEW_SIDECAR_FILE,
  emptyGraph,
  normalizeArtifacts,
  normalizeCoupling,
  normalizeGraph,
  normalizeMetaCoupling,
  normalizePresented,
  normalizeView,
  viewOfNodeId,
} from './graph-format.js'

/* ============================================================== 正文 ==== */

/**
 * Create the shared canvas store.
 * @param logger - a Cordis logger used for non-fatal persistence failures.
 * @returns the store handle used by the routes and the tool.
 */
export function createStore(logger) {
  /**
   * @type {Map<string, {
   *   key: string, cwd?: string, title?: string, updatedAt: number,
   *   sessionId?: string, sessionTitle?: string, sessionNew?: boolean, sessionWarning?: string,
   *   activeView: 'tasks'|'modules',
   *   availableViews: Set<'tasks'|'modules'>,
   *   legacyModules: boolean, layoutChecked: boolean,
   *   viewSidecarError?: string,
   *   views: { tasks?: ViewState, modules?: ViewState },
   * }>}
   * where `ViewState = { graph, rev, persistedRev?, persistError?, degraded?, viewport?,
   *                      persistTimer?, persistChain?, verifiedDisk }`.
   */
  const states = new Map()

  /** Project key for a graph: the safe project name, or the untitled bucket. */
  const keyOf = (graph) => projectKeyOf(graph?.project?.name)

  const ensureProject = (key) => {
    let state = states.get(key)
    if (state === undefined) {
      state = {
        key,
        updatedAt: 0,
        cwd: undefined,
        // The project's resolved durable directory (v1.0, `lib/paths.js`).
        // `undefined` until a caller resolves it; every file lookup then falls
        // back to the default-root spelling of `cwd`.
        dir: undefined,
        activeView: DEFAULT_VIEW,
        availableViews: new Set(),
        legacyModules: false,
        layoutChecked: false,
        views: {},
      }
      states.set(key, state)
    }
    return state
  }

  const ensureView = (state, viewName) => {
    let viewState = state.views[viewName]
    if (viewState === undefined) {
      viewState = { graph: emptyGraph(), rev: 0, verifiedDisk: false }
      state.views[viewName] = viewState
    }
    return viewState
  }

  /** Accept only a three-number viewport, the shape the canvas writes. */
  const sanitizeView = (view) => {
    if (!Array.isArray(view) || view.length !== 3) return undefined
    const numbers = view.map(Number)
    if (!numbers.every((value) => Number.isFinite(value))) return undefined
    return [numbers[0], numbers[1], numbers[2]]
  }

  /**
   * The project's durable directory: the caller-resolved `state.dir` when one
   * was passed in (custom root / project override), otherwise the default-root
   * spelling under `cwd`. `undefined` when no workspace is bound at all.
   */
  const durableDirOf = (key, state) => {
    if (typeof state.dir === 'string' && state.dir.length > 0) return state.dir
    if (typeof state.cwd !== 'string' || state.cwd.length === 0) return undefined
    return projectDirPath(state.cwd, key)
  }

  /**
   * Resolve the durable file of one view. The legacy single-module project
   * keeps `workflow.json` as the modules file — never renamed, so the
   * pre-0.6.0 binding between canvas edits and that file survives the upgrade.
   */
  const viewFileOf = (key, state, viewName) => {
    const dir = durableDirOf(key, state)
    if (dir === undefined) return undefined
    if (viewName === 'modules') {
      return state.legacyModules ? path.join(dir, VIEW_FILES.tasks) : path.join(dir, VIEW_FILES.modules)
    }
    return path.join(dir, VIEW_FILES.tasks)
  }

  const fileExists = async (file) => {
    try {
      return (await statFile(file)).isFile()
    } catch {
      return false
    }
  }

  /**
   * One-time per-process scan of the project directory that decides which
   * views exist and whether this is a legacy single-module project. Runs
   * before any read or write that needs a file path, so a v0.5.x project
   * loaded fresh is classified correctly before the first write can land.
   */
  const detectLayout = async (key, state) => {
    if (state.layoutChecked) return
    const dir = durableDirOf(key, state)
    if (dir === undefined) return
    state.layoutChecked = true
    const wfFile = path.join(dir, VIEW_FILES.tasks)
    const modFile = path.join(dir, VIEW_FILES.modules)
    const hasModules = await fileExists(modFile)
    const hasWorkflow = await fileExists(wfFile)
    if (hasModules) {
      // A side-by-side modules file always wins: workflow.json is the tasks
      // view, even if its meta still says 'modules' from an odd history.
      state.legacyModules = false
      if (hasWorkflow) state.availableViews.add('tasks')
      state.availableViews.add('modules')
      return
    }
    if (!hasWorkflow) return
    let strategy
    try {
      const parsed = JSON.parse(await readFile(wfFile, 'utf8'))
      strategy = parsed && typeof parsed === 'object' ? parsed?.meta?.strategy : undefined
    } catch {
      // Corrupt: treated as the tasks file; `load` will quarantine it and the
      // degraded flag — not the layout — records the damage.
      strategy = undefined
    }
    if (strategy === 'modules') {
      state.legacyModules = true
      state.availableViews.add('modules')
    } else {
      state.availableViews.add('tasks')
    }
  }

  /**
   * Move a corrupt workflow file aside before anything can overwrite it, and
   * remember why. The rename preserves every byte of the damaged original —
   * this is the difference between "canvas reset" and "data gone". Damage is
   * recorded on the owning view, so a broken modules file never blocks the
   * tasks view.
   */
  const quarantineCorrupt = async (viewState, file, reason) => {
    if (viewState.degraded !== undefined) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)
    const target = `${file}.bad-${stamp}-${randomBytes(2).toString('hex')}`
    let moved = false
    try {
      await rename(file, target)
      moved = true
    } catch {
      // Windows locks or a read-only directory: leave the file in place; the
      // following write attempt will surface the real error.
    }
    viewState.degraded = {
      at: Date.now(),
      file,
      reason,
      ...(moved ? { quarantinedTo: target } : {}),
    }
    logger?.warn?.(`codeflow: ${file} is corrupt (${reason})${moved ? `; quarantined to ${target}` : ''}`)
  }

  /**
   * First durable write to a file this process has never validated: read it and
   * move a corrupt original aside before it can be clobbered. This is the
   * backstop for {@link loadViewInternal}: a save against a project nobody ever
   * booted would otherwise overwrite the damaged file irreversibly.
   */
  const verifyBeforeFirstWrite = async (viewState, file) => {
    if (viewState.verifiedDisk === true) return
    viewState.verifiedDisk = true
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return // missing or unreadable (EISDIR, EPERM): nothing readable to protect here
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      await quarantineCorrupt(viewState, file, `JSON 解析失败：${String(error?.message ?? error)}`)
      return
    }
    if (normalizeGraph(parsed) === undefined) {
      await quarantineCorrupt(viewState, file, '内容不是 codeflow/1 图')
    }
  }

  /**
   * Write the durable copy of one view. Failures are reported but never
   * thrown: the canvas must keep working even when the workspace is read-only.
   */
  const persistNow = async (key, state, viewName) => {
    const viewState = ensureView(state, viewName)
    const file = viewFileOf(key, state, viewName)
    if (file === undefined) {
      viewState.persistError = '未绑定工作区'
      return { ok: false, file: undefined, error: viewState.persistError }
    }
    const body = JSON.stringify({ ...viewState.graph, rev: viewState.rev })
    try {
      await verifyBeforeFirstWrite(viewState, file)
      await atomicWriteFile(file, body)
      viewState.persistedRev = viewState.rev
      viewState.persistError = undefined
      return { ok: true, file }
    } catch (error) {
      viewState.persistError = String(error?.message ?? error)
      logger?.warn?.(`codeflow: cannot write ${file}: ${String(error)}`)
      return { ok: false, file, error: viewState.persistError }
    }
  }

  /**
   * One disk write at a time per project **and view**. Two overlapping writes
   * used to race at the rename step: the older revision could land *after*
   * the newer one. A failed earlier write never blocks the next one.
   */
  const enqueuePersist = (state, viewName, job) => {
    const viewState = ensureView(state, viewName)
    const previous = viewState.persistChain ?? Promise.resolve()
    const result = previous.then(job, job)
    viewState.persistChain = result.then(() => {}, () => {})
    return result
  }

  /** Debounced persistence used by agent progress patches (which arrive in bursts). */
  const persistSoon = (state, viewName) => {
    const viewState = ensureView(state, viewName)
    if (viewState.persistTimer !== undefined) clearTimeout(viewState.persistTimer)
    // No `unref()`: a timer the process is allowed to forget is also a timer
    // that can be dropped on exit — that is how the last edit before quitting
    // used to be lost. The pending write is flushed again on plugin dispose.
    viewState.persistTimer = setTimeout(() => {
      viewState.persistTimer = undefined
      enqueuePersist(state, viewName, () => persistNow(state.key, state, viewName))
    }, 600)
  }

  const cancelPersistTimer = (viewState) => {
    if (viewState.persistTimer !== undefined) {
      clearTimeout(viewState.persistTimer)
      viewState.persistTimer = undefined
    }
  }

  /** Availability/health summary the panel and boot payload consume. */
  const unavailableReasonOf = (state, viewName) => {
    if (state.availableViews.has(viewName)) return undefined
    if (state.legacyModules) {
      return viewName === 'tasks'
        ? '旧版单模块图项目：workflow.json 即模块结构图，无任务视图'
        : undefined
    }
    return `该视图未生成（项目中没有 ${VIEW_FILES[viewName]}）`
  }

  const viewsSummaryOf = (state) => {
    const out = {}
    for (const viewName of VIEW_KEYS) {
      const viewState = state?.views?.[viewName]
      const available = state !== undefined && state.availableViews.has(viewName)
      out[viewName] = {
        available,
        ...(viewState !== undefined
          ? { rev: viewState.rev, nodes: viewState.graph.nodes.length }
          : { rev: null, nodes: null }),
        ...(viewState?.degraded !== undefined ? { degradedReason: viewState.degraded.reason } : {}),
        ...(state !== undefined && !available ? { reason: unavailableReasonOf(state, viewName) } : {}),
      }
    }
    return out
  }

  /** Absolute path of the active-view sidecar for a project. */
  const viewSidecarPathOf = (key, state) => {
    const dir = durableDirOf(key, state)
    if (dir === undefined) return undefined
    return path.join(dir, VIEW_SIDECAR_FILE)
  }

  /** Collect the persisted form of the sidecar: active view + known viewports. */
  const viewSidecarBodyOf = (state) => {
    const viewports = {}
    for (const viewName of VIEW_KEYS) {
      const viewport = state.views[viewName]?.viewport
      if (viewport !== undefined) viewports[viewName] = viewport
    }
    return {
      version: 1,
      activeView: state.activeView,
      ...(Object.keys(viewports).length > 0 ? { viewports } : {}),
      updatedAt: Date.now(),
    }
  }

  const writeViewSidecar = async (key, state) => {
    const file = viewSidecarPathOf(key, state)
    if (file === undefined) return
    try {
      await atomicWriteFile(file, JSON.stringify(viewSidecarBodyOf(state)))
      state.viewSidecarError = undefined
    } catch (error) {
      // The sidecar is a convenience: its failure must never touch the graphs.
      state.viewSidecarError = String(error?.message ?? error)
      logger?.warn?.(`codeflow: cannot write ${file}: ${state.viewSidecarError}`)
    }
  }

  const adoptViewSidecar = async (key, state) => {
    const file = viewSidecarPathOf(key, state)
    if (file === undefined) return
    let parsed
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return // missing or corrupt: the default active view stands
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const wanted = normalizeView(parsed.activeView)
    if (wanted !== undefined && wanted !== state.activeView && state.availableViews.has(wanted)) {
      state.activeView = wanted
    }
    // Viewports ride along (they are not part of any rev): remembered for the
    // views already in memory and stashed for views loaded later.
    if (parsed.viewports !== null && typeof parsed.viewports === 'object' && !Array.isArray(parsed.viewports)) {
      for (const viewName of VIEW_KEYS) {
        const viewport = sanitizeView(parsed.viewports[viewName])
        if (viewport === undefined) continue
        const viewState = state.views[viewName]
        if (viewState !== undefined) {
          if (viewState.viewport === undefined) viewState.viewport = viewport
        } else if (state.availableViews.has(viewName)) {
          state.pendingViewports ??= {}
          state.pendingViewports[viewName] = viewport
        }
      }
    }
  }

  /** Load one view's durable file into memory. Shared by load/loadView. */
  const loadViewInternal = async (key, state, viewName) => {
    if (!state.availableViews.has(viewName)) {
      const error = new Error(`codeflow: ${VIEW_LABEL[viewName]}视图未生成（项目中没有对应的图文件）`)
      error.statusCode = 409
      throw error
    }
    const file = viewFileOf(key, state, viewName)
    if (file === undefined) {
      const error = new Error(`codeflow: 无法定位 ${VIEW_LABEL[viewName]}视图的文件（项目未绑定工作区）`)
      error.statusCode = 409
      throw error
    }
    const viewState = ensureView(state, viewName)
    const raw = await readFile(file, 'utf8')
    viewState.verifiedDisk = true
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      await quarantineCorrupt(viewState, file, `JSON 解析失败：${String(error?.message ?? error)}`)
      return { key, view: viewName, graph: viewState.graph, rev: viewState.rev, degraded: viewState.degraded }
    }
    const graph = normalizeGraph(parsed)
    if (graph === undefined) {
      await quarantineCorrupt(viewState, file, '内容不是 codeflow/1 图')
      return { key, view: viewName, graph: viewState.graph, rev: viewState.rev, degraded: viewState.degraded }
    }
    viewState.graph = graph
    viewState.rev = graph.rev
    viewState.persistedRev = graph.rev
    viewState.persistError = undefined
    viewState.degraded = undefined
    viewState.loadedOnce = true
    if (viewState.viewport === undefined && state.pendingViewports?.[viewName] !== undefined) {
      viewState.viewport = state.pendingViewports[viewName]
    }
    state.updatedAt = Date.now()
    return { key, view: viewName, graph, rev: viewState.rev }
  }

  return {
    /**
     * Snapshot one project (or one of its views) for a reader; never exposes
     * internal timer fields. `view` names the resolved view (default: the
     * project's active view); `views` summarizes both views' availability.
     * Session fields describe the project's *canvas* session (see
     * `lib/sessions.js`).
     */
    get(project, viewName) {
      const key = projectKeyOf(project)
      const state = states.get(key)
      if (state === undefined) {
        return {
          key,
          view: normalizeView(viewName) ?? DEFAULT_VIEW,
          activeView: DEFAULT_VIEW,
          graph: emptyGraph(),
          rev: 0,
          viewport: undefined,
          unavailable: '项目未加载',
          views: viewsSummaryOf(undefined),
          sessionId: undefined,
          title: undefined,
          cwd: undefined,
          sessionTitle: undefined,
          sessionNew: undefined,
          sessionWarning: undefined,
          persistError: undefined,
          degraded: undefined,
        }
      }
      const resolved = normalizeView(viewName) ?? state.activeView ?? DEFAULT_VIEW
      const viewState = state.views[resolved]
      return {
        key,
        view: resolved,
        activeView: state.activeView,
        graph: viewState?.graph ?? emptyGraph(),
        rev: viewState?.rev ?? 0,
        viewport: viewState?.viewport,
        viewLoaded: viewState?.loadedOnce === true,
        unavailable: unavailableReasonOf(state, resolved),
        views: viewsSummaryOf(state),
        sessionId: state.sessionId,
        title: state.title,
        cwd: state.cwd,
        // The resolved durable directory when known, else the default-root
        // spelling of the bound workspace (v1.0: surfaced so the panel, the
        // undo manager and the run payload all quote the same place).
        dir: state.dir ?? (typeof state.cwd === 'string' && state.cwd.length > 0 ? projectDirPath(state.cwd, key) : undefined),
        sessionTitle: state.sessionTitle,
        sessionNew: state.sessionNew,
        sessionWarning: state.sessionWarning,
        persistError: viewState?.persistError,
        degraded: viewState?.degraded,
        viewSidecarError: state.viewSidecarError,
      }
    },

    /** Which projects currently have live state, for the panel's project switcher. */
    keys() {
      return [...states.keys()]
    },

    /**
     * The project the panel should show when it opens without naming one.
     *
     * Without this the panel would land on the untitled bucket every time, so a
     * user who just wants "the canvas" would see a blank slate even though a
     * project exists. Preference is the most recently written project that
     * actually holds nodes; the untitled bucket only wins when it is all there is.
     *
     * @returns the project key, or `undefined` when nothing has been rendered.
     */
    mostRecent() {
      let best
      let bestAt = -1
      let fallback
      let fallbackAt = -1
      const nodeCountOf = (state) => VIEW_KEYS.reduce((sum, viewName) => sum + (state.views[viewName]?.graph.nodes.length ?? 0), 0)
      for (const [key, state] of states) {
        const at = state.updatedAt ?? 0
        if (key === UNTITLED_KEY) {
          if (at > fallbackAt) {
            fallback = key
            fallbackAt = at
          }
          continue
        }
        if (nodeCountOf(state) === 0) continue
        if (at > bestAt) {
          best = key
          bestAt = at
        }
      }
      if (best !== undefined) return best
      return fallbackAt > 0 ? fallback : undefined
    },

    /**
     * Remember which canvas session owns a project without touching the graph.
     *
     * Only the session manager (`lib/sessions.js`) may call this: tool renders
     * and gestures no longer grab the binding by virtue of being the caller.
     */
    bindSession(project, sessionId) {
      const key = projectKeyOf(project)
      const state = ensureProject(key)
      state.sessionId = sessionId
      if (sessionId !== undefined) state.sessionWarning = undefined
    },

    /**
     * Attach display metadata for the canvas session. `isNew` is consumed by
     * the panel to show the one-time "已创建独立会话" banner, `warning` is the
     * actionable reason a binding could not be established.
     */
    bindSessionInfo(project, info = {}) {
      const key = projectKeyOf(project)
      const state = ensureProject(key)
      if (info.sessionId !== undefined) state.sessionId = info.sessionId
      if (info.title !== undefined) state.sessionTitle = info.title
      if (info.isNew !== undefined) state.sessionNew = info.isNew === true
      if (info.warning !== undefined) state.sessionWarning = info.warning
      if (info.sessionId !== undefined && info.warning === undefined) state.sessionWarning = undefined
    },

    /** Drop the in-memory canvas-session binding for a project. */
    forgetSession(project) {
      const key = projectKeyOf(project)
      const state = ensureProject(key)
      state.sessionId = undefined
      state.sessionTitle = undefined
      state.sessionNew = false
    },

    /**
     * Patch one node's execution fields in place and bump the target view's
     * `rev`.
     *
     * The `codeflow_canvas` progress mode uses this so the agent never has to
     * re-render a whole graph for a status flip. Only the whitelisted fields
     * are touched; `pos`, `params`, `title` and links are unreachable here.
     * `percent` is deliberately *not* a graph field: it lives in the activity
     * hub (memory only), which is where the panel reads progress from.
     *
     * Without an explicit `view` the node is located by run-view hints the
     * caller may pass, then by id shape (`t*`/`m*`), then across both views —
     * a node id must be found before it is patched, so a guess can never hit
     * the wrong graph silently.
     *
     * @returns `{ key, view, rev, node, applied }`, or `undefined` when the
     *   project or node does not exist.
     */
    patchNode(project, nodeId, patch, options = {}) {
      const key = projectKeyOf(project)
      const state = states.get(key)
      if (state === undefined) return undefined
      let viewName = normalizeView(options.view)
      if (viewName === undefined) {
        const candidates = []
        const hinted = normalizeView(options.runView) ?? viewOfNodeId(nodeId)
        if (hinted !== undefined) candidates.push(hinted)
        candidates.push(state.activeView ?? DEFAULT_VIEW)
        for (const v of VIEW_KEYS) if (!candidates.includes(v)) candidates.push(v)
        viewName = candidates.find((v) => state.views[v]?.graph.nodes.some((node) => node.id === nodeId))
        if (viewName === undefined) return undefined
      }
      const viewState = state.views[viewName]
      if (viewState === undefined || viewState.graph.nodes.length === 0) return undefined
      const node = viewState.graph.nodes.find((entry) => entry.id === nodeId)
      if (node === undefined) return undefined
      const applied = {}
      if (patch !== null && typeof patch === 'object') {
        if (patch.status !== undefined && NODE_STATUSES.has(patch.status)) {
          node.status = patch.status
          applied.status = patch.status
        }
        if (patch.result !== undefined) {
          node.result = typeof patch.result === 'string' ? patch.result.slice(0, 400) : ''
          applied.result = node.result
        }
        if (patch.detail !== undefined) {
          node.detail = typeof patch.detail === 'string' ? patch.detail.slice(0, 2000) : ''
          applied.detail = node.detail
        }
        const artifacts = normalizeArtifacts(patch.artifacts)
        if (artifacts !== undefined) node.artifacts = artifacts
        else if (patch.artifacts !== undefined) delete node.artifacts
        const presented = normalizePresented(patch.presented)
        if (presented !== undefined) node.presented = presented
        else if (patch.presented !== undefined) delete node.presented
      }
      viewState.rev += 1
      state.updatedAt = Date.now()
      viewState.graph = { ...viewState.graph, rev: viewState.rev }
      persistSoon(state, viewName)
      return { key, view: viewName, rev: viewState.rev, node, applied }
    },

    /**
     * Remember the workspace a project belongs to (and, v1.0, its resolved
     * durable directory), so its workflow files can be located.
     */
    bindCwd(project, cwd, dir) {
      const key = projectKeyOf(project)
      if (typeof cwd !== 'string' || cwd.length === 0) return
      const state = ensureProject(key)
      const nextDir = typeof dir === 'string' && dir.length > 0 ? dir : (state.dir !== undefined && state.cwd === cwd ? state.dir : undefined)
      if (state.cwd !== cwd || state.dir !== nextDir) {
        state.cwd = cwd
        state.dir = nextDir
        // A new workspace (or a new directory for it) means new files: the
        // layout knowledge is stale.
        state.layoutChecked = false
        state.legacyModules = false
        state.availableViews.clear()
      }
    },

    /** Remember (or replace) the resolved durable directory of a project. */
    bindDir(project, dir) {
      if (typeof dir !== 'string' || dir.length === 0) return
      const state = ensureProject(projectKeyOf(project))
      if (state.dir !== dir) {
        state.dir = dir
        state.layoutChecked = false
        state.legacyModules = false
        state.availableViews.clear()
      }
    },

    /** Absolute durable file path of one view (default: active view), or `undefined`. */
    filePath(project, viewName) {
      const key = projectKeyOf(project)
      const state = states.get(key)
      if (state === undefined) return undefined
      const resolved = normalizeView(viewName) ?? state.activeView ?? DEFAULT_VIEW
      return viewFileOf(key, state, resolved)
    },

    /** The file name (not path) of one view's durable copy. */
    viewFileName(viewName) {
      return VIEW_FILES[normalizeView(viewName) ?? DEFAULT_VIEW]
    },

    /**
     * The first workspace any project is bound to.
     *
     * The panel asks for a project list without naming a project, so it has no
     * key to look up; every project of one session shares a workspace, which
     * makes any bound one representative.
     */
    anyCwd() {
      for (const state of states.values()) {
        if (typeof state.cwd === 'string' && state.cwd.length > 0) return state.cwd
      }
      return undefined
    },

    /**
     * Accept one write for one view and bump that view's `rev`.
     *
     * @param rawGraph - the incoming graph.
     * @param options.cwd - workspace/title to attach to the state.
     * @param options.view - `tasks` | `modules`; when absent, inferred from
     *   `meta.strategy`, then the project's active view.
     * @param options.viewport - `[x,y,k]` viewport for that view (the legacy
     *   `view: [x,y,k]` array form is still accepted).
     * @param options.persist - `now` writes the durable copy immediately,
     *   `soon` debounces it, `never` keeps it in memory only.
     * @param options.expectedRev - when given, the write is accepted only if
     *   the *target view's* revision still matches; otherwise a 409-class
     *   conflict error carrying `currentRev` is thrown, so a stale window
     *   cannot silently clobber a graph another writer already advanced.
     * @returns the accepted graph, its view and its new revision.
     */
    async write(rawGraph, options = {}) {
      const graph = normalizeGraph(rawGraph)
      if (graph === undefined) {
        const error = new Error('codeflow: payload is not a graph')
        error.statusCode = 400
        throw error
      }
      const key = keyOf(graph)
      const state = ensureProject(key)
      const nextDir = typeof options.dir === 'string' && options.dir.length > 0 ? options.dir
        : (options.cwd !== state.cwd ? undefined : state.dir)
      if (
        (typeof options.cwd === 'string' && options.cwd.length > 0 && options.cwd !== state.cwd)
        || (nextDir !== undefined && nextDir !== state.dir)
      ) {
        state.cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : state.cwd
        state.dir = nextDir
        state.layoutChecked = false
        state.legacyModules = false
        state.availableViews.clear()
      }
      if (options.title !== undefined) state.title = options.title
      await detectLayout(key, state)

      let viewName = normalizeView(options.view)
      if (viewName === undefined && graph.meta !== null && graph.meta?.strategy === 'modules') viewName = 'modules'
      if (viewName === undefined) viewName = state.activeView ?? DEFAULT_VIEW
      if (viewName === 'tasks' && state.legacyModules) {
        const error = new Error('codeflow: 该项目是旧版单模块图项目（workflow.json 即模块结构图），不支持任务视图')
        error.statusCode = 409
        throw error
      }
      // v1.2 双视图隔离：任务图的节点绝不携带模块耦合标签（整体结论只镜像在
      // meta.coupling）。有该字段的节点被就地清洗；没有时图保持字节不变。
      if (viewName === 'tasks' && graph.nodes.some((node) => node.coupling !== undefined)) {
        graph.nodes = graph.nodes.map((node) => {
          if (node.coupling === undefined) return node
          const cleaned = { ...node }
          delete cleaned.coupling
          return cleaned
        })
      }

      const viewState = ensureView(state, viewName)
      if (options.expectedRev !== undefined && Number.isFinite(Number(options.expectedRev))) {
        const expected = Number(options.expectedRev)
        if (viewState.rev !== expected) {
          const error = new Error(`codeflow: revision conflict (${VIEW_LABEL[viewName]}视图 canvas is at rev ${viewState.rev}, writer expected ${expected})`)
          error.statusCode = 409
          error.currentRev = viewState.rev
          error.expectedRev = expected
          error.view = viewName
          throw error
        }
      }
      // No session binding here: canvas-session ownership is owned exclusively
      // by the session manager (`lib/sessions.js`), never by whoever happens to
      // write a graph.
      const nextViewport = sanitizeView(options.viewport) ?? sanitizeView(options.view)
      if (nextViewport !== undefined) viewState.viewport = nextViewport
      viewState.rev += 1
      state.updatedAt = Date.now()
      viewState.graph = { ...graph, rev: viewState.rev }
      state.availableViews.add(viewName)
      // A write that created the project's only view must become the active
      // one, or the panel would boot onto an unavailable active view.
      if (!state.availableViews.has(state.activeView)) state.activeView = viewName
      // Snapshot BEFORE awaiting the persist: a concurrent write advances the
      // state while this one waits for the disk, and reading `state.rev` after
      // the await would answer with somebody else's revision (caught live: ten
      // overlapping autosaves all reported the final rev).
      const snapshot = { key, view: viewName, graph: viewState.graph, rev: viewState.rev }
      let persisted
      if (options.persist === 'now') {
        persisted = await enqueuePersist(state, viewName, () => persistNow(key, state, viewName))
      } else if (options.persist !== 'never') {
        persistSoon(state, viewName)
      }
      return {
        ...snapshot,
        ...(persisted === undefined ? {} : {
          persisted: persisted.ok,
          file: persisted.file,
          ...(persisted.error === undefined ? {} : { error: persisted.error }),
        }),
      }
    },

    /**
     * Force the durable copy of one view (default: every loaded view of the
     * project — the panel's Save button saves both views of a dual project).
     */
    async flush(project, viewName) {
      const key = projectKeyOf(project)
      const state = states.get(key)
      if (state === undefined) return undefined
      const explicit = normalizeView(viewName)
      const targets = explicit !== undefined
        ? [explicit]
        : VIEW_KEYS.filter((v) => state.views[v] !== undefined)
      if (targets.length === 0) {
        // Nothing loaded yet: persist the active view as-is (v0.5.2 parity —
        // a bare save on a fresh project still produced its workflow.json).
        const fallback = state.activeView ?? DEFAULT_VIEW
        const persisted = await enqueuePersist(state, fallback, () => persistNow(key, state, fallback))
        return {
          key,
          view: fallback,
          rev: persisted.ok ? (state.views[fallback].persistedRev ?? state.views[fallback].rev) : state.views[fallback].rev,
          file: persisted.file ?? viewFileOf(key, state, fallback),
          persisted: persisted.ok,
          ...(persisted.error === undefined ? {} : { error: persisted.error }),
        }
      }
      let firstError
      let allOk = true
      for (const target of targets) {
        const result = await enqueuePersist(state, target, () => persistNow(key, state, target))
        if (!result.ok) {
          allOk = false
          firstError ??= result.error
        }
      }
      // The save button is also where viewport persistence rides along: it is
      // never worth its own write, and a flush already proves the disk works.
      await writeViewSidecar(key, state).catch(() => {})
      const primary = explicit ?? state.activeView ?? targets[0]
      const primaryState = ensureView(state, primary)
      return {
        key,
        view: primary,
        // The rev that actually reached the disk, not whatever the live state
        // has advanced to while this flush waited in the write queue.
        rev: allOk ? (primaryState.persistedRev ?? primaryState.rev) : primaryState.rev,
        file: viewFileOf(key, state, primary),
        persisted: allOk,
        views: Object.fromEntries(targets.map((v) => {
          const vs = state.views[v]
          return [v, { rev: vs.persistedRev ?? vs.rev, file: viewFileOf(key, state, v) }]
        })),
        ...(firstError === undefined ? {} : { error: firstError }),
      }
    },

    /**
     * Write every project and view with unsaved changes right now (plugin
     * dispose). Pending debounce timers are cancelled — their writes happen
     * here instead — so quitting right after an edit can no longer drop the
     * last 600 ms of either view.
     */
    async flushAll() {
      const jobs = []
      for (const state of states.values()) {
        for (const viewName of VIEW_KEYS) {
          const viewState = state.views[viewName]
          if (viewState === undefined) continue
          cancelPersistTimer(viewState)
          if (viewState.rev > 0 && viewState.persistedRev !== viewState.rev) {
            jobs.push(enqueuePersist(state, viewName, () => persistNow(state.key, state, viewName)))
          }
        }
        if (state.activeView !== undefined && typeof state.cwd === 'string' && state.availableViews.size > 0) {
          // Dispose is the last chance to remember the active view + viewports.
          jobs.push(writeViewSidecar(state.key, state).catch(() => {}))
        }
      }
      await Promise.all(jobs)
    },

    /**
     * Load a project from disk: classify the directory layout, then read every
     * view that has a durable file. A file that exists but cannot be parsed as
     * a graph is *quarantined* (renamed to `<file>.bad-<timestamp>`) and
     * reported as that view's `degraded` instead of being served as an empty
     * canvas. Missing files are simply "this view is unavailable" — callers
     * treat a project with no files at all as "no project yet".
     *
     * @returns `{ key, activeView, views, results }`.
     */
    async load(project, cwd, dir) {
      const key = projectKeyOf(project)
      const state = ensureProject(key)
      const nextDir = typeof dir === 'string' && dir.length > 0 ? dir : (cwd !== state.cwd ? undefined : state.dir)
      if ((typeof cwd === 'string' && cwd.length > 0 && cwd !== state.cwd) || (nextDir !== undefined && nextDir !== state.dir)) {
        if (typeof cwd === 'string' && cwd.length > 0) state.cwd = cwd
        state.dir = nextDir
        state.layoutChecked = false
        state.legacyModules = false
        state.availableViews.clear()
      }
      await detectLayout(key, state)
      const results = {}
      for (const viewName of VIEW_KEYS) {
        if (!state.availableViews.has(viewName)) continue
        try {
          results[viewName] = await loadViewInternal(key, state, viewName)
        } catch (error) {
          results[viewName] = { key, view: viewName, error: String(error?.message ?? error) }
        }
      }
      if (!state.availableViews.has(state.activeView) && state.availableViews.size > 0) {
        state.activeView = state.availableViews.has('tasks') ? 'tasks' : [...state.availableViews][0]
      }
      await adoptViewSidecar(key, state)
      return { key, activeView: state.activeView, views: viewsSummaryOf(state), results }
    },

    /**
     * Load exactly one view's durable file (the `codeflow_canvas` `load`
     * channel). A view without a file fails with an actionable error; a corrupt
     * file is quarantined into that view only.
     */
    async loadView(project, cwd, viewName, dir) {
      const key = projectKeyOf(project)
      const state = ensureProject(key)
      const resolved = normalizeView(viewName) ?? state.activeView ?? DEFAULT_VIEW
      const nextDir = typeof dir === 'string' && dir.length > 0 ? dir : (cwd !== state.cwd ? undefined : state.dir)
      if ((typeof cwd === 'string' && cwd.length > 0 && cwd !== state.cwd) || (nextDir !== undefined && nextDir !== state.dir)) {
        if (typeof cwd === 'string' && cwd.length > 0) state.cwd = cwd
        state.dir = nextDir
        state.layoutChecked = false
        state.legacyModules = false
        state.availableViews.clear()
      }
      await detectLayout(key, state)
      return loadViewInternal(key, state, resolved)
    },

    /**
     * Switch the project's active view and persist the choice in `view.json`.
     * Switching never bumps a graph rev, never rescans, never calls the agent.
     */
    async setActiveView(project, viewName) {
      const key = projectKeyOf(project)
      const state = states.get(key)
      const wanted = normalizeView(viewName)
      if (wanted === undefined) {
        const error = new Error('codeflow: view must be "tasks" or "modules"')
        error.statusCode = 400
        throw error
      }
      if (state === undefined) {
        const error = new Error('codeflow: 项目未加载，无法切换视图')
        error.statusCode = 409
        throw error
      }
      if (!state.availableViews.has(wanted)) {
        const error = new Error(`codeflow: ${VIEW_LABEL[wanted]}视图不可用（${unavailableReasonOf(state, wanted) ?? '未生成'}）`)
        error.statusCode = 409
        error.view = state.activeView
        throw error
      }
      if (state.activeView === wanted) {
        return { key, activeView: state.activeView, unchanged: true }
      }
      state.activeView = wanted
      await writeViewSidecar(key, state)
      return { key, activeView: state.activeView }
    },

    /**
     * Every project that has a durable workflow file, newest first, with a
     * per-view availability summary.
     *
     * v1.0: candidates come from `lib/paths.listProjectDirs` — the configured
     * root, every known root, per-project overrides and the legacy
     * `<workspace>/flow-projects/` (pre-migration or conflict-kept projects
     * keep showing up). Dedupe favors overrides, then the current root.
     *
     * @param cwd - workspace root (the config home and legacy-scan base).
     */
    async listProjects(cwd) {
      let scanned
      try {
        scanned = await listProjectDirs(cwd)
      } catch {
        return []
      }
      const found = []
      for (const [name, dir] of scanned.dirs) {
        const tasksFile = path.join(dir, VIEW_FILES.tasks)
        const modulesFile = path.join(dir, VIEW_FILES.modules)
        const hasTasks = await fileExists(tasksFile)
        const hasModules = await fileExists(modulesFile)
        if (!hasTasks && !hasModules) continue
        // A lone workflow.json whose meta says 'modules' is a legacy single-
        // module project: its file belongs to the modules view.
        let legacyModules = false
        if (hasTasks && !hasModules) {
          try {
            const parsed = JSON.parse(await readFile(tasksFile, 'utf8'))
            legacyModules = parsed?.meta?.strategy === 'modules'
          } catch {
            // Corrupt: counted as a tasks project; load will quarantine.
          }
        }
        const primary = hasTasks ? tasksFile : modulesFile
        try {
          const stat = await statFile(primary)
          // The `untitled/` directory is the untitled bucket's durable home, so
          // its live state is registered under the bucket key, not the dirname.
          const live = states.get(name === 'untitled' ? UNTITLED_KEY : name)
          const activeGraph = live?.views?.[live.activeView ?? DEFAULT_VIEW]?.graph
          const graph = activeGraph
          found.push({
            name,
            dir,
            file: primary,
            updatedAt: stat.mtimeMs,
            rev: graph?.rev ?? 0,
            nodes: graph?.nodes?.length ?? 0,
            done: graph?.nodes?.filter((node) => node.status === 'done').length ?? 0,
            title: live?.title,
            views: {
              tasks: hasTasks && !legacyModules,
              modules: hasModules || legacyModules,
            },
          })
        } catch {
          // Unreadable primary file: not a project we can serve.
        }
      }
      found.sort((left, right) => right.updatedAt - left.updatedAt)
      return found
    },
  }
}
