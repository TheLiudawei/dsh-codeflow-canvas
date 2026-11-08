/**
 * HTTP 路由层：`/codeflow` 前缀的文档与 JSON API 的**装配与分发**。
 *
 * 具体的 handler 都在 `lib/http/` 的路由组里，本文件只做四件事：
 *
 *   1. 组装路由上下文（`createRouteContext`：13 个注入依赖 + 横切助手）；
 *   2. 收集各路由组的路由表并做路径/方法匹配（方法不匹配答 405）；
 *   3. 统一错误边界（`error.statusCode` 惯例：413 超限 / 400 非图载荷 /
 *      409 修订冲突原样透出；只有真正的故障才按失败记日志）；
 *   4. 聚合 dispose（拖拽暂存清扫器随插件卸载停止）。
 *
 * 路由组的划分（各自独立、互不感知）：
 *
 *   canvas-routes.js    画布文档（boot 载荷 + 主题）
 *   state-routes.js     图状态：state / view / session / activity / undo / save
 *   import-routes.js    v1.2：import / coupling / drop\*（+ 共享落地编排）
 *   features-routes.js  v1.1：features / features/agent
 *   project-routes.js   action / projects / config
 *   workspace-routes.js v1.2.1：workspaces（只读清单，Issue #1）
 *   browse-routes.js    v1.2.1：browse（只读目录浏览，需求 C）
 *
 * 路由清单与语义详见各分组模块的文档头；注入依赖（store/submit/sessions/…）
 * 的含义见 {@link createRouter} 的参数注释。
 *
 * @module dsh-codeflow-canvas/routes
 */
import { rejectionFor, sendJson } from './http/respond.js'
import { createRouteContext } from './http/context.js'
import { createCanvasRoutes } from './http/canvas-routes.js'
import { createStateRoutes } from './http/state-routes.js'
import { createImportRoutes } from './http/import-routes.js'
import { createFeaturesRoutes } from './http/features-routes.js'
import { createProjectRoutes } from './http/project-routes.js'
import { createBrowseRoutes } from './http/browse-routes.js'
import { createWorkspaceRoutes } from './http/workspace-routes.js'
import { createTypeRoutes } from './http/type-routes.js'
import { createLogRoutes } from './http/log-routes.js'

/** 本插件占用的路由前缀。 */
export const ROUTE_PREFIX = '/codeflow'

/** 4xx 也值得记日志的路由（导入/耦合/拖拽/日志上报——可行动错误，用户拿得到）。 */
const INTERESTING_4XX_RE = /\/api\/(?:import|coupling|drop\/|log)$/

/** http.request 的取样规则：变更类路由 + 慢请求；状态轮询与日志上报除外。 */
function shouldLogRequest(pathname, method, status, durationMs) {
  if (pathname === `${ROUTE_PREFIX}/api/log`) return false
  if (pathname === `${ROUTE_PREFIX}/api/state`) return false
  if (durationMs > 2000) return true
  if (method === 'GET' || method === 'HEAD') return false
  return status < 400
}

/**
 * 创建 `/codeflow` 的请求 handler。
 *
 * @param options.store - 画布 store（图状态的唯一写者）。
 * @param options.submit - 把一个画布手势投递给项目的画布会话（lib/gestures.js）。
 * @param options.logger - Cordis logger，诊断警告用。
 * @param options.fence - 可选宿主门禁：返回 `undefined` 放行请求，或返回一个
 *   HTTP 状态码拒绝。web 载体用签名的浏览器 cookie 保护其它所有路由；本路由
 *   能向会话注入提示词，所以必须受同一道门禁保护，而不能只靠 loopback 与
 *   Origin 检查。同源 iframe 自动携带 cookie——这正是画布 URL 里不需要令牌
 *   的原因。
 * @param options.ensureSession - 会话管理器 `ensure(project, {create})`。
 * @param options.rebindSession - 会话管理器 `rebind(project)`。
 * @param options.deliverText - 会话管理器 `deliverText(project, prompt)`
 *   （POST /api/features/agent 用；缺失时该路由给可行动的 409）。
 * @param options.sessionInfo - 当前面板用的绑定快照。
 * @param options.activityRead - 活动中心的读模型。
 * @param options.undoList - 运行历史读取器。
 * @param options.undoRestore - LIFO 恢复（支持 `dryRunOnly`）。
 * @param options.migrateWorkspace - v1.0 旧项目一次性迁移（幂等）。
 * @returns node:http 风格的 handler（附 `dispose()`）。
 */
export function createRouter(options) {
  const { logger } = options
  const ctx = createRouteContext(options)

  /* 收集各路由组的表项，归一成 `{ methods:Set, pathname, handler }` 列表。 */
  const importGroup = createImportRoutes(ctx)
  const logGroup = createLogRoutes(ctx)
  const entries = []
  for (const entry of [
    ...createCanvasRoutes(ctx),
    ...createStateRoutes(ctx),
    ...importGroup.routes,
    ...createFeaturesRoutes(ctx),
    ...createProjectRoutes(ctx),
    // v1.2.1：只读工作区清单（A1）与只读目录浏览（C2）。
    ...createWorkspaceRoutes(ctx),
    ...createBrowseRoutes(ctx),
    // v1.5.0：任务节点「自动识别」（POST /api/node-type，内部走 typing.reidentify）。
    ...createTypeRoutes(ctx),
    // v1.2.2：画布日志上报（ui.action/ui.error/ui.selftest 白名单）。
    ...logGroup.routes,
  ]) {
    const methods = new Set(Array.isArray(entry.method) ? entry.method : [entry.method])
    for (const pathname of Array.isArray(entry.paths) ? entry.paths : [entry.path]) {
      entries.push({ methods, pathname: `${ROUTE_PREFIX}${pathname}`, handler: entry.handler, strict405: entry.strict405 === true })
    }
  }

  /** 各组 dispose 的聚合（当前只有 import 组持有清扫器）。 */
  const disposables = [importGroup.dispose]

  /**
   * 请求入口：门禁 → 解析 URL → 表匹配（路径命中但方法不符 → 405）→
   * handler → 统一错误边界。
   */
  async function handle(req, res) {
    const rejection = rejectionFor(req)
    if (rejection !== 0) {
      sendJson(res, rejection, { ok: false, error: 'forbidden' })
      return
    }
    if (options.fence !== undefined) {
      let status
      try {
        status = options.fence(req)
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
    // 面板把 DSH 的配色随请求带来，首帧就是正确的主题；缺失（手工打开的
    // URL）时画布交给 prefers-color-scheme。
    const requestedScheme = url.searchParams.get('theme')
    const theme = requestedScheme === 'light' || requestedScheme === 'dark' ? requestedScheme : null

    let methodMismatchOnStrict = false
    const startedAt = Date.now()
    try {
      for (const entry of entries) {
        if (entry.pathname !== pathname) continue
        if (!entry.methods.has(method)) {
          // 方法不匹配的应答跟随**原实现**：只有画布文档与 /api/state 显式
          // 回 405，其余路由一律落空到 404（validate 对此有回归断言）。
          if (entry.strict405) methodMismatchOnStrict = true
          continue
        }
        await entry.handler(req, res, { url, method, project, theme })
        // v1.2.2：http.request——只记有意义的变更类路由与慢请求（>2s）。
        // GET /api/state 的 1.8s 轮询与 POST /api/state 的常规 autosave 不记
        // （409/落盘失败由错误边界与 store 各自记 http.error / log.host）；
        // /api/log 自身永不记（防日志风暴）。
        const durationMs = Date.now() - startedAt
        if (shouldLogRequest(pathname, method, res.statusCode, durationMs)) {
          logger?.event?.('http.request', {
            level: 'debug',
            data: { method, path: pathname, ...(project !== undefined ? { project } : {}), status: res.statusCode, durationMs },
          })
        }
        return
      }
      sendJson(res, methodMismatchOnStrict ? 405 : 404, {
        ok: false,
        error: methodMismatchOnStrict ? 'method not allowed' : 'not found',
      })
    } catch (error) {
      // 错误可能携带 HTTP 状态（413 超限、400 非图载荷、409 修订冲突）；
      // 只有真正的故障才按失败记日志。
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
      const durationMs = Date.now() - startedAt
      if (status >= 500) {
        logger?.warn?.(`codeflow: ${method} ${pathname} failed: ${String(error)}`)
      }
      // v1.2.2：http.error——5xx 必记（带 err.stack）；4xx 只记导入/耦合/拖拽/
      // 日志路由的 400/409/413，避免普通校验噪声。
      if (status >= 500 || (status >= 400 && INTERESTING_4XX_RE.test(pathname) && (status === 400 || status === 409 || status === 413))) {
        logger?.event?.('http.error', {
          level: status >= 500 ? 'error' : 'warn',
          data: { method, path: pathname, ...(project !== undefined ? { project } : {}), status, durationMs },
          ...(status >= 500 ? { err: error } : {}),
        })
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

  /** 停止全部拖拽暂存清扫器（插件 dispose）。 */
  handle.dispose = () => {
    for (const dispose of disposables) dispose()
  }
  return handle
}
