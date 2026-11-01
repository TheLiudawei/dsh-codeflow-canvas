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

/* createStore 是一个闭包工厂：内存状态（states Map）与文件打交道的一切
 * 助手都闭包在它里面。这里不强拆——拆出去的每个助手都得把 states/logger
 * 当参数传来传去，内聚性换不来可读性。分区如下：
 *
 *   ① 状态与项目/视图基础   ensureProject / ensureView / sanitizeView /
 *                           durableDirOf / viewFileOf / fileExists
 *   ② 布局检测与损坏隔离     detectLayout / quarantineCorrupt / verifyBeforeFirstWrite
 *   ③ 持久化管线            persistNow / enqueuePersist / persistSoon / cancelPersistTimer
 *   ④ 视图侧车              viewSidecarPathOf / viewSidecarBodyOf / writeViewSidecar / adoptViewSidecar
 *   ⑤ 单视图加载            loadViewInternal
 *   ⑥ 对外 API              get / keys / mostRecent / bindSession* / patchNode /
 *                           bindCwd / write / flush* / load* / setActiveView / listProjects
 */

/**
 * 创建共享画布 store（整个插件唯一的图状态写者）。
 * @param logger - Cordis logger；非致命的持久化失败记到这里。
 * @returns routes 与 tool 使用的 store 句柄。
 */
export function createStore(logger) {
  /* ------------------------------------------------ ① 状态与基础助手 --- */

  /**
   * 内存状态表：桶键 → 项目状态。
   *
   * 项目状态字段：`key`、`cwd`（绑定工作区）、`dir`（v1.0 已解析的持久目录，
   * 未解析前为 undefined）、`title`、`updatedAt`；会话绑定四件套
   * `sessionId/sessionTitle/sessionNew/sessionWarning`；`activeView` 与
   * `availableViews`（哪些视图有磁盘文件）；`legacyModules`（旧版单模块项目）
   * 与 `layoutChecked`（布局是否已探测）；`viewSidecarError`；以及每个视图的
   * `views[tasks|modules]`。
   *
   * 视图状态（ViewState）：`graph`（codeflow/1 图）、`rev`（内存修订号）、
   * `persistedRev`（已落盘的修订号）、`persistError`、`degraded`（损坏隔离
   * 记录）、`viewport`、`persistTimer`/`persistChain`（防抖与写队列）、
   * `verifiedDisk`（首次写前是否已验证磁盘内容）、`loadedOnce`。
   *
   * @type {Map<string, Object>}
   */
  const states = new Map()

  /** 图 → 项目桶键：安全化项目名，或未命名桶。 */
  const keyOf = (graph) => projectKeyOf(graph?.project?.name)

  /** 取出（或懒创建）一个项目的内存状态。 */
  const ensureProject = (key) => {
    let state = states.get(key)
    if (state === undefined) {
      state = {
        key,
        updatedAt: 0,
        cwd: undefined,
        // 项目的持久目录（v1.0，由调用方经 lib/paths.js 解析后传入）。
        // 未解析前为 undefined；此时一切文件定位回退到 cwd 的默认根拼写。
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

  /** 取出（或以空图懒创建）一个视图状态。 */
  const ensureView = (state, viewName) => {
    let viewState = state.views[viewName]
    if (viewState === undefined) {
      viewState = { graph: emptyGraph(), rev: 0, verifiedDisk: false }
      state.views[viewName] = viewState
    }
    return viewState
  }

  /** 只接受画布写入的三数字视口 `[x, y, k]`，其余一律判无效。 */
  const sanitizeView = (view) => {
    if (!Array.isArray(view) || view.length !== 3) return undefined
    const numbers = view.map(Number)
    if (!numbers.every((value) => Number.isFinite(value))) return undefined
    return [numbers[0], numbers[1], numbers[2]]
  }

  /**
   * 项目的持久目录：调用方解析过就用 `state.dir`（自定义根/单项目覆盖），
   * 否则回退 `cwd` 下的默认根拼写；完全没绑定工作区时 `undefined`。
   */
  const durableDirOf = (key, state) => {
    if (typeof state.dir === 'string' && state.dir.length > 0) return state.dir
    if (typeof state.cwd !== 'string' || state.cwd.length === 0) return undefined
    return projectDirPath(state.cwd, key)
  }

  /**
   * 解析一个视图的持久文件路径。旧版单模块项目的 modules 视图仍指向
   * `workflow.json`——绝不重命名，v0.6.0 之前"画布编辑 ↔ 该文件"的绑定
   * 才能在升级后继续存活。
   */
  const viewFileOf = (key, state, viewName) => {
    const dir = durableDirOf(key, state)
    if (dir === undefined) return undefined
    if (viewName === 'modules') {
      return state.legacyModules ? path.join(dir, VIEW_FILES.tasks) : path.join(dir, VIEW_FILES.modules)
    }
    return path.join(dir, VIEW_FILES.tasks)
  }

  /** 路径是否是一个真实存在的普通文件。 */
  const fileExists = async (file) => {
    try {
      return (await statFile(file)).isFile()
    } catch {
      return false
    }
  }

  /* -------------------------------------------- ② 布局检测与损坏隔离 --- */

  /**
   * 每进程一次的目录布局探测：判定有哪些视图、是否旧版单模块项目。
   * 在任何需要文件路径的读/写之前运行——刚加载的 v0.5.x 项目必须先被正确
   * 分类，第一次写才有落点。
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
      // 两个文件并存的永远是双视图：workflow.json 归 tasks 视图——即便它的
      // meta 因历史原因还写着 'modules'。
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
      // 损坏：当作 tasks 文件处理；load 会做隔离检疫，degraded 标记——
      // 而不是布局判定——负责记录损伤。
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
   * 把损坏的图文件挪到一边（改名留档），别让任何写入覆盖它，并记录原因。
   * rename 保留损坏原文的每一个字节——这正是"画布被重置"与"数据还在"
   * 的区别（B4 修复）。损伤只记在所属视图上：坏掉的模块图绝不拖累任务图。
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
      // Windows 文件锁或只读目录：文件留在原地；接下来的写入会暴露真实错误。
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
   * 本进程从未验证过的文件在第一次持久写之前：先读它，把损坏的原文挪开，
   * 防止被覆盖。这是 {@link loadViewInternal} 的兜底——对一个从未被 boot 过
   * 的项目直接保存，否则会不可逆地覆盖坏文件。
   */
  const verifyBeforeFirstWrite = async (viewState, file) => {
    if (viewState.verifiedDisk === true) return
    viewState.verifiedDisk = true
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return // 缺失或不可读（EISDIR、EPERM）：没有可保护的内容
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

  /* ------------------------------------------------------ ③ 持久化管线 --- */

  /**
   * 把一个视图的持久副本写到磁盘。失败只报告、绝不抛出：工作区只读时
   * 画布也必须能继续交互。
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
   * 每项目**每视图**同时只允许一个磁盘写在途。两次重叠的写曾在 rename 处
   * 竞态：旧修订可能**晚于**新修订落盘。更早一次写失败也绝不阻塞下一次。
   */
  const enqueuePersist = (state, viewName, job) => {
    const viewState = ensureView(state, viewName)
    const previous = viewState.persistChain ?? Promise.resolve()
    const result = previous.then(job, job)
    viewState.persistChain = result.then(() => {}, () => {})
    return result
  }

  /** 防抖持久化：agent 的 progress 增量回补往往成串到达，600ms 合并成一次写。 */
  const persistSoon = (state, viewName) => {
    const viewState = ensureView(state, viewName)
    if (viewState.persistTimer !== undefined) clearTimeout(viewState.persistTimer)
    // 绝不 `unref()`：允许进程遗忘的计时器同样可能在退出时被丢掉——退出前
    // 的最后一次编辑就是这么丢的。挂起的写会在插件 dispose 时再补一次。
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

  /* -------------------------------------------------------- ④ 视图侧车 --- */

  /** 面板与 boot 载荷消费的可用性/健康摘要。 */
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

  /** 项目激活视图侧车（view.json）的绝对路径。 */
  const viewSidecarPathOf = (key, state) => {
    const dir = durableDirOf(key, state)
    if (dir === undefined) return undefined
    return path.join(dir, VIEW_SIDECAR_FILE)
  }

  /** 侧车的持久化形态：激活视图 + 已知视口。 */
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
      // 侧车只是便利设施：它写失败绝不能牵连图本身。
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
      return // 缺失或损坏：维持默认激活视图
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const wanted = normalizeView(parsed.activeView)
    if (wanted !== undefined && wanted !== state.activeView && state.availableViews.has(wanted)) {
      state.activeView = wanted
    }
    // 视口搭车恢复（不属于任何 rev）：已在内存的视图直接记下，尚未加载的
    // 视图先存起来等加载时认领。
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

  /* ------------------------------------------------------ ⑤ 单视图加载 --- */

  /** 把一个视图的持久文件读进内存；load 与 loadView 共用。 */
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

  /* -------------------------------------------------------- ⑥ 对外 API --- */
  /* 读：get / keys / mostRecent —— 面板轮询与启动决策的数据源。           */

  return {
    /**
     * 给读取方一个项目（或其某个视图）的快照；内部计时器字段绝不外露。
     * `view` 指定解析后的视图（缺省：项目激活视图）；`views` 汇总两个视图
     * 的可用性。会话字段描述项目的**画布专用会话**（见 lib/sessions.js）。
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
        // 已解析的持久目录（未知时回退绑定工作区的默认根拼写）。v1.0 起对外
        // 暴露：面板、undo 管理器与运行载荷引用的是同一个地方。
        dir: state.dir ?? (typeof state.cwd === 'string' && state.cwd.length > 0 ? projectDirPath(state.cwd, key) : undefined),
        sessionTitle: state.sessionTitle,
        sessionNew: state.sessionNew,
        sessionWarning: state.sessionWarning,
        persistError: viewState?.persistError,
        degraded: viewState?.degraded,
        viewSidecarError: state.viewSidecarError,
      }
    },

    /** 当前有内存状态的项目键列表（面板项目切换器用）。 */
    keys() {
      return [...states.keys()]
    },

    /**
     * 面板打开却没有指名项目时应当展示的项目。
     *
     * 没有这个方法，面板每次都会落在未命名桶上——用户只是想"打开画布"，
     * 却看到一个空白画布，哪怕项目明明存在。优先取最近写入、且真的持有
     * 节点的项目；未命名桶只在别无选择时胜出。
     *
     * @returns 项目键；什么都没渲染过时 `undefined`。
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

    /* --------------------------------------- 会话绑定（唯一写者约束）--- */

    /**
     * 记住哪个画布会话拥有一个项目，不触碰图。
     *
     * 只有会话管理器（lib/sessions.js）可以调用它：工具渲染与画布手势
     * 不再因为"自己是调用方"就能抢走绑定。
     */
    bindSession(project, sessionId) {
      const key = projectKeyOf(project)
      const state = ensureProject(key)
      state.sessionId = sessionId
      if (sessionId !== undefined) state.sessionWarning = undefined
    },

    /**
     * 附上画布会话的展示元数据。`isNew` 供面板显示一次性的"已创建独立会话"
     * 横幅；`warning` 是绑定未能建立时的可行动原因。
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

    /** 丢弃一个项目的内存画布会话绑定。 */
    forgetSession(project) {
      const key = projectKeyOf(project)
      const state = ensureProject(key)
      state.sessionId = undefined
      state.sessionTitle = undefined
      state.sessionNew = false
    },

    /* ---------------------------------------------- 节点增量（progress）--- */

    /**
     * 就地修补一个节点的执行字段，并给目标视图的 `rev` 加一。
     *
     * `codeflow_canvas` 的 progress 模式用它：agent 翻转一个状态不必重渲染
     * 整张图。只触碰白名单字段；`pos`、`params`、`title` 与连线在这里不可达。
     * `percent` 刻意**不是**图字段：它活在活动中心（纯内存），面板从那里读
     * 进度——图文件里永远不落百分比。
     *
     * 未显式给 `view` 时按序定位节点：调用方的运行视图提示 → id 拼写
     * （`t*`/`m*`）→ 两个视图逐一遍历。节点 id 必须先被找到才能被修补，
     * 猜测绝不可能悄悄命中错误的图。
     *
     * @returns `{ key, view, rev, node, applied }`；项目或节点不存在时
     *   `undefined`。
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

    /* ---------------------------------------------------- 工作区绑定 --- */

    /**
     * 记住项目属于哪个工作区（v1.0 起还有已解析的持久目录），它的
     * workflow 文件才能被定位。
     */
    bindCwd(project, cwd, dir) {
      const key = projectKeyOf(project)
      if (typeof cwd !== 'string' || cwd.length === 0) return
      const state = ensureProject(key)
      const nextDir = typeof dir === 'string' && dir.length > 0 ? dir : (state.dir !== undefined && state.cwd === cwd ? state.dir : undefined)
      if (state.cwd !== cwd || state.dir !== nextDir) {
        state.cwd = cwd
        state.dir = nextDir
        // 新工作区（或它的新目录）意味着新文件：布局知识过期。
        state.layoutChecked = false
        state.legacyModules = false
        state.availableViews.clear()
      }
    },

    /** 记住（或替换）一个项目已解析的持久目录。 */
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

    /** 一个视图持久副本的绝对路径（缺省：激活视图）；定位不到返回 `undefined`。 */
    filePath(project, viewName) {
      const key = projectKeyOf(project)
      const state = states.get(key)
      if (state === undefined) return undefined
      const resolved = normalizeView(viewName) ?? state.activeView ?? DEFAULT_VIEW
      return viewFileOf(key, state, resolved)
    },

    /** 一个视图持久副本的文件名（不是路径）。 */
    viewFileName(viewName) {
      return VIEW_FILES[normalizeView(viewName) ?? DEFAULT_VIEW]
    },

    /**
     * 任意一个项目绑定的第一个工作区。
     *
     * 面板请求项目列表时不指名项目，没有键可查；同一会话的所有项目共享
     * 一个工作区，任取一个绑定项都有代表性。
     */
    anyCwd() {
      for (const state of states.values()) {
        if (typeof state.cwd === 'string' && state.cwd.length > 0) return state.cwd
      }
      return undefined
    },

    /* --------------------------------------------------------- 写入 --- */

    /**
     * 接受对一个视图的一次写入，并给**该视图**的 `rev` 加一。
     *
     * @param rawGraph - 传入的图。
     * @param options.cwd - 附着到状态的工作区/标题。
     * @param options.view - `tasks` | `modules`；缺省时先看 `meta.strategy`，
     *   再看项目激活视图。
     * @param options.viewport - 该视图的 `[x,y,k]` 视口（旧的 `view: [x,y,k]`
     *   数组形式仍被接受）。
     * @param options.persist - `now` 立即写持久副本；`soon` 防抖；`never`
     *   只留内存。
     * @param options.expectedRev - 给出时，只有**目标视图**的修订号仍然匹配
     *   才接受写入；否则抛出携带 `currentRev` 的 409 冲突错误——过时的窗口
     *   不能悄悄覆盖另一个写者已推进的图（B5 修复）。
     * @returns 被接受的图、所属视图与新修订号。
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
      // 这里绝不绑定会话：画布会话的归属权只属于会话管理器（lib/sessions.js），
      // 谁恰好写了一次图都不行。
      const nextViewport = sanitizeView(options.viewport) ?? sanitizeView(options.view)
      if (nextViewport !== undefined) viewState.viewport = nextViewport
      viewState.rev += 1
      state.updatedAt = Date.now()
      viewState.graph = { ...graph, rev: viewState.rev }
      state.availableViews.add(viewName)
      // 创建了项目唯一视图的那次写必须让它成为激活视图，否则面板会 boot 到
      // 一个不可用的激活视图上。
      if (!state.availableViews.has(state.activeView)) state.activeView = viewName
      // 在 await 持久化**之前**拍快照：并发的写会在本次等磁盘时推进状态，
      // await 之后再读 state.rev 就会答成别人的修订号（真实事故：十次重叠
      // 的自动保存全部报了最终 rev）。
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

    /* ------------------------------------------------- 落盘（flush）--- */

    /**
     * 强制落盘一个视图的持久副本（缺省：项目所有已加载的视图——面板的
     * 保存按钮对双视图项目两个都存）。
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
        // 什么都还没加载：把激活视图原样落盘（v0.5.2 对齐——对全新项目的
        // 一次裸保存也要能产出 workflow.json）。
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
      // 保存按钮也是视口持久化搭车的地方：它永远不值得单独一次写，而
      // flush 成功本身就证明了磁盘可用。
      await writeViewSidecar(key, state).catch(() => {})
      const primary = explicit ?? state.activeView ?? targets[0]
      const primaryState = ensureView(state, primary)
      return {
        key,
        view: primary,
        // 报"真正到达磁盘的 rev"，不是本次 flush 在写队列里等待期间活状态
        // 又推进到了什么值。
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
     * 立即落盘所有有未保存变更的项目与视图（插件 dispose 兜底）。挂起的
     * 防抖计时器被取消——它们的写改在这里发生——编辑后立刻退出 DSH 也
     * 不会再丢掉任一视图的最后 600 毫秒。
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
          // dispose 是记住激活视图 + 视口的最后机会。
          jobs.push(writeViewSidecar(state.key, state).catch(() => {}))
        }
      }
      await Promise.all(jobs)
    },

    /* ------------------------------------------------- 加载（load）--- */

    /**
     * 从磁盘加载一个项目：先判定目录布局，再读每一个有持久文件的视图。
     * 存在但解析不出图的文件会被**隔离检疫**（改名为 `<file>.bad-<时间戳>`）
     * 并作为所属视图的 `degraded` 上报，而不是被端上一张空画布。文件缺失
     * 只是"该视图不可用"——一个文件都没有的项目被调用方当作"还没有项目"。
     *
     * @returns `{ key, activeView, views, results }`。
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
     * 只加载一个视图的持久文件（`codeflow_canvas` 的 `load` 通道）。
     * 没有文件的视图报可行动的错误；损坏的文件只隔离该视图。
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
     * 切换项目激活视图并把选择持久化进 `view.json`。切换绝不 bump 图 rev、
     * 绝不重扫、绝不唤醒 agent。
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

    /* --------------------------------------------- 项目列表（listProjects）--- */

    /**
     * 每一个有持久 workflow 文件的项目，按最新优先，附各视图可用性摘要。
     *
     * v1.0：候选来自 `lib/paths.listProjectDirs`——配置的根、每个已知根、
     * 单项目覆盖、以及旧版 `<工作区>/flow-projects/`（迁移前或冲突保留的
     * 项目继续可见）。去重时覆盖优先于当前根。
     *
     * @param cwd - 工作区根（配置文件的安家处 + 旧目录扫描的基准）。
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
        // 孤零零一个 meta.strategy === 'modules' 的 workflow.json 是旧版
        // 单模块项目：它的文件属于 modules 视图。
        let legacyModules = false
        if (hasTasks && !hasModules) {
          try {
            const parsed = JSON.parse(await readFile(tasksFile, 'utf8'))
            legacyModules = parsed?.meta?.strategy === 'modules'
          } catch {
            // 损坏：仍按 tasks 项目计数；load 会做隔离检疫。
          }
        }
        const primary = hasTasks ? tasksFile : modulesFile
        try {
          const stat = await statFile(primary)
          // `untitled/` 目录是未命名桶的持久之家，所以它的活状态登记在
          // 桶键（而不是目录名）之下。
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
          // 主文件读不了：这不是我们能服务的项目。
        }
      }
      found.sort((left, right) => right.updatedAt - left.updatedAt)
      return found
    },
  }
}
