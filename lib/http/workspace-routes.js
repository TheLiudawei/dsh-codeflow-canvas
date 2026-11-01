/**
 * 工作区路由组（v1.2.1，Issue #1）：`GET /api/workspaces`。
 *
 *   GET /api/workspaces            已登记工作区清单（A1；对话框下拉的数据源）
 *   GET /api/workspaces?project=X  同上 + 每项带服务端计算的 `projectDir` 预览
 *                                  （与 `paths.projectDir` 同一实现）
 *
 * **只读契约**：本路由绝不 `mkdir`、不 `ensureLayout`、不触发旧项目迁移，
 * 不写任何文件。GET 请求产生磁盘副作用算缺陷。数据唯一来源是注入的
 * `listWorkspaces`（lib/index.js 装配 → lib/workspace-binding.collectWorkspaces，
 * 全插件唯一允许读 `workspaceRegistry` 的地方）；本文件只做参数整理与
 * 错误码映射。
 *
 * @module dsh-codeflow-canvas/http/workspace-routes
 */
import { sendJson } from './respond.js'

/**
 * @param ctx - 路由上下文。
 * @returns 路由表项数组。
 */
export function createWorkspaceRoutes(ctx) {
  const { listWorkspaces } = ctx
  return [
    {
      method: 'GET',
      path: '/api/workspaces',
      strict405: true,
      /**
       * 已登记工作区清单。宿主没有工作区接口 → 503 `NO_WORKSPACE_SERVICE`；
       * 注册表读取失败 → 500 `WORKSPACE_LIST_FAILED`（带宿主错误首行）。
       */
      async handler(req, res, { url }) {
        if (typeof listWorkspaces !== 'function') {
          sendJson(res, 503, {
            ok: false,
            code: 'NO_WORKSPACE_SERVICE',
            error: '当前 DSH 未提供工作区列表接口，无法安全确定项目落点。',
          })
          return
        }
        // 预览用的项目名：新建对话框在项目名输入变化时带来（只影响 projectDir
        // 预览字段，不影响清单本身）。
        const project = url.searchParams.get('project') ?? undefined
        const payload = await listWorkspaces(project)
        if (payload?.ok !== true) {
          const status = payload?.code === 'WORKSPACE_LIST_FAILED' ? 500 : 503
          sendJson(res, status, {
            ok: false,
            code: payload?.code ?? 'NO_WORKSPACE_SERVICE',
            error: payload?.message ?? '当前 DSH 未提供工作区列表接口，无法安全确定项目落点。',
          })
          return
        }
        sendJson(res, 200, payload)
      },
    },
  ]
}
