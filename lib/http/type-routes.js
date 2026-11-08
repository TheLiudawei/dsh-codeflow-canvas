/**
 * 类型路由组（v1.5.0）：任务节点的「自动识别」按钮专用。
 *
 *   POST /api/node-type   body `{project, view, nodeId, mode:'auto'}`
 *                         → 内部只调 typing.reidentify（lib/typing/service.js）
 *
 * 手动设置/清除类型走画布本地保存（整图经 /api/state 写回），**没有**写接口
 * ——宿主不提供「任意改类型」的面，识别与锁定的权威语义在 service 与画布
 * 各自的唯一入口。门禁（fence）、错误码约定与其它路由一致。
 *
 * @module dsh-codeflow-canvas/http/type-routes
 */
import { normalizeView } from '../graph-format.js'
import { sendJson, readJsonBody } from './respond.js'

/**
 * @param ctx - 路由上下文（`reidentify` 由 index.js 装配注入；路由不直接
 *   import service——依赖方向 L3 → 注入，不走静态 import）。
 * @returns 路由表项数组。
 */
export function createTypeRoutes(ctx) {
  const { reidentify } = ctx
  return [
    {
      method: 'POST',
      path: '/api/node-type',
      /** 按最近一次运行的证据重新识别一个任务节点（零 LLM，无新回合）。 */
      async handler(req, res, { project }) {
        const body = await readJsonBody(req)
        const target = (body !== null && typeof body === 'object' ? body.project : undefined) ?? project
        const nodeId = body !== null && typeof body === 'object' ? body.nodeId : undefined
        if (target === undefined || String(target).length === 0 || typeof nodeId !== 'string' || nodeId.length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected a project and nodeId' })
          return
        }
        if (body?.mode !== undefined && body.mode !== 'auto') {
          sendJson(res, 400, { ok: false, error: 'only mode:"auto" is supported; manual set/clear stays client-side' })
          return
        }
        if (typeof reidentify !== 'function') {
          sendJson(res, 501, { ok: false, error: '识别服务不可用' })
          return
        }
        try {
          const result = await reidentify(String(target), { view: normalizeView(body?.view), nodeId })
          if (result?.applied === true) {
            sendJson(res, 200, {
              ok: true,
              applied: true,
              nodeId,
              ...(typeof result.type === 'string' ? { type: result.type } : {}),
              ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
            })
          } else {
            sendJson(res, 200, { ok: true, applied: false, nodeId })
          }
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
  ]
}
