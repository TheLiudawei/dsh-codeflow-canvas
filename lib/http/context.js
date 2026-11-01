/**
 * 路由上下文：createRouter 的 13 个注入依赖 + 全部路由组共享的助手，收敛在
 * 一个对象里。每个路由组模块（state-routes / import-routes / features-routes /
 * project-routes / canvas-routes）接收它，声明式地返回自己的路由表——
 * 「哪个 handler 用了哪些依赖」由此变成显式导入，替代原先 1400 行闭包里的
 * 隐式共享。
 *
 * 这里放的都是与具体路由无关的横切能力：
 *
 *   - 工作区解析（cwdOf / workspaceReady，含一次性旧项目迁移 + 目录骨架）
 *   - 项目目录解析（dirOf，永不抛错）
 *   - 视图字段的兼容拆分（viewFieldsOf：新 `view` 名 vs 旧视口数组）
 *   - 首帧加载（bootProject：命名项目或最近项目，跳过已隔离的）
 *   - 会话降级（sessionFor / sessionFields：会话问题绝不 fail 一个路由）
 *   - 双视图惰性加载（ensureViewLoaded）
 *
 * 依赖方向：respond/store/graph-format/core ← 本模块 ← 各路由组。
 *
 * @module dsh-codeflow-canvas/http/context
 */
import path from 'node:path'

import { ensureLayout, projectDir, rootOf } from '../paths.js'
import { normalizeView } from '../graph-format.js'

/**
 * 组装路由上下文。
 *
 * @param options - createRouter 的 13 个注入依赖（store / submit / logger /
 *   fence / resolveCwd / ensureSession / rebindSession / deliverText /
 *   sessionInfo / activityRead / undoList / undoRestore / migrateWorkspace）。
 * @returns 上下文对象（含 `options` 原样透传）。
 */
export function createRouteContext(options) {
  const { store, logger, resolveCwd, migrateWorkspace } = options

  /** 最近一次旧项目迁移报告（boot banner + config GET 消费）。 */
  let lastMigration

  /**
   * 向宿主询问一个项目的工作区，绝不抛错。
   * @param project - 项目键，可能为 undefined。
   */
  const cwdOf = async (project) => {
    if (typeof resolveCwd !== 'function') return undefined
    try {
      const cwd = await resolveCwd(project)
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 解析项目在某个工作区下的持久目录（v1.0，可配置根）。永不抛错：
   * 解析不出目录只意味着 store 回退默认根拼写。
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
   * 解析工作区并为它跑 v1.0 的一次性旧项目迁移（尽力而为，每个工作区至多
   * 一次——`paths.migrateLegacy` 自带幂等），外加产品决策要求的默认
   * `<工作区>/CodeFlow` 的 `mkdir -p`。失败绝不阻塞请求：照常返回工作区，
   * 原因进日志（有迁移报告时还会走上 boot 横幅）。
   */
  async function workspaceReady(project) {
    const cwd = await cwdOf(project)
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
   * 解析（或创建）项目的画布会话，绝不因此让路由失败：会话问题降级为
   * `warning`——没有会话，画布也必须能编辑、导入、保存。
   */
  async function sessionFor(project, { create = true } = {}) {
    const { ensureSession } = options
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

  /** boot 与 /api/state 共用的会话展示字段。 */
  function sessionFields(project) {
    const { sessionInfo } = options
    if (typeof sessionInfo !== 'function') return { sessionTitle: null, sessionNew: false, sessionWarning: null }
    const info = sessionInfo(project) ?? {}
    return {
      sessionTitle: info.sessionTitle ?? null,
      sessionNew: info.sessionNew === true,
      sessionWarning: info.sessionWarning ?? null,
    }
  }

  /**
   * 按需加载一个视图：面板可能在项目尚未完整 boot 时就要另一视图（比如
   * 重启后还开着的旧标签页）。缺文件保持"不可用"；坏文件只降级该视图。
   * 尝试本身廉价且幂等（布局探测只跑一次）。
   */
  async function ensureViewLoaded(project, viewName) {
    const current = store.get(project, viewName)
    if (current.rev > 0 || current.degraded !== undefined || current.viewLoaded === true) return
    const cwd = await cwdOf(project)
    if (cwd === undefined) return
    try {
      await store.loadView(project, cwd, viewName, await dirOf(cwd, project))
    } catch {
      // 不可用的保持不可用；views 摘要会给出原因。
    }
  }

  /** 拖拽暂存根（dropManagerFor 惰性建管理器时用）。 */
  const importsRootOf = async (cwd) => path.join(await rootOf(cwd), 'imports')

  return {
    ...options,
    logger,
    store,
    cwdOf,
    dirOf,
    workspaceReady,
    sessionFor,
    sessionFields,
    ensureViewLoaded,
    importsRootOf,
    /** 迁移报告的读取器（config GET / boot 用）。 */
    get lastMigration() {
      return lastMigration
    },
  }
}

/**
 * 拆分一个写请求体里的视图提示：v0.6.0 起 `view` 是视图名，但更早的客户端
 * 把视口数组放在 `view` 里。两种拼写都接受。
 */
export function viewFieldsOf(body) {
  if (body === null || typeof body !== 'object') return {}
  const named = normalizeView(body.view)
  const legacyViewport = Array.isArray(body.view) && body.view.length === 3 ? body.view : undefined
  const viewport = Array.isArray(body.viewport) && body.viewport.length === 3 ? body.viewport : legacyViewport
  return { view: named, viewport }
}

/**
 * 为面板首帧把一个持久项目加载进内存。
 *
 * 只在被要求时运行（`?boot=1` 或指名项目），普通 API 调用保持既有语义、
 * 绝不意外扫盘。损坏的图文件不再以"安静空画布"的形态 boot：store.load 会
 * 隔离该文件并把该视图上报为 `degraded`，boot 载荷转发给面板用于警告，
 * 而不是邀请覆盖。双视图项目的两个视图都在这里加载，视图切换器才有真实
 * 计数、切换才是瞬时的。
 */
export async function bootProject(store, cwd, project, dirOfFn) {
  if (cwd === undefined) return
  if (project !== undefined) {
    const current = store.get(project)
    if (viewLoaded(current)) return
    try {
      await store.load(project, cwd, await dirOfFn(cwd, project))
    } catch {
      // 指名的项目还没有文件：就是一张空画布。
    }
    return
  }
  if (store.mostRecent() !== undefined) return
  const projects = await store.listProjects(cwd)
  for (const entry of projects) {
    try {
      const loaded = await store.load(entry.name, cwd, entry.dir)
      // 优先选激活视图能完整加载的项目；被隔离的项目会 boot 成空画布，
      // 继续找下一个更健康的。
      const activeState = store.get(entry.name, loaded.activeView)
      if (activeState?.degraded === undefined) return
    } catch {
      // 没有图文件的项目跳过，试下一个。
    }
  }
}

/** 项目的激活视图是否已经从磁盘加载（或被写过）过？ */
export function viewLoaded(current) {
  if (current === undefined) return false
  if (current.rev > 0) return true
  return current.views?.[current.activeView]?.available === true
    && (current.views?.[current.activeView]?.rev ?? 0) > 0
}
