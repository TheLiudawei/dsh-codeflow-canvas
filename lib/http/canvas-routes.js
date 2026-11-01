/**
 * 文档路由：`GET /codeflow/canvas`——面板 iframe 加载的画布文档。
 *
 * 画布本身是自包含片段（assets/canvas/canvas.html），本模块只负责把 boot
 * 载荷（激活图、激活视图、双视图可用性、会话绑定、主题）喂给
 * `renderCanvasPage`。文档由宿主组装、按需重载——agent 从不参与。
 *
 * @module dsh-codeflow-canvas/http/canvas-routes
 */
import { renderCanvasPage } from '../canvas-page.js'
import { migrationNotice } from '../paths.js'
import { sendHtml, sendJson } from './respond.js'
import { bootProject } from './context.js'

/**
 * @param ctx - 路由上下文（createRouteContext 的产出）。
 * @returns 路由表项数组。
 */
export function createCanvasRoutes(ctx) {
  const { store, sessionFor, dirOf, workspaceReady } = ctx
  return [
    {
      method: ['GET', 'HEAD'],
      paths: ['/canvas', '/canvas.html'],
      strict405: true,
      /**
       * 画布文档。`?boot=1` 或指名项目时执行首帧加载：解析工作区、装载最近
       * 的持久项目、绑定专用会话、附迁移横幅。`?theme=` 让首帧就是正确的
       * 配色（手工打开的 URL 缺省时交给 prefers-color-scheme）。
       */
      async handler(req, res, { url, project, theme }) {
        const wantsBoot = url.searchParams.get('boot') === '1' || project !== undefined
        let workspace
        let migration
        if (wantsBoot) {
          workspace = await workspaceReady(project)
          await bootProject(store, workspace, project, dirOf)
          // v1.0：一次性旧项目迁移只汇报一次——且仅在真的搬了东西（或有
          // 冲突/失败）时。
          migration = migrationNotice(ctx.lastMigration)
        }
        // 打开中的面板不指名项目：展示最近写入的那个，而不是空的未命名桶。
        const current = store.get(project ?? store.mostRecent())
        // 已有项目的首次打开绑定其专用会话（管理器的在途去重保证只创建一次）。
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
          // v1.0：面板打开的这个项目实际所在的持久目录。
          projectDir: current.dir ?? (workspace !== undefined ? await dirOf(workspace, project ?? current.key) : null),
          degraded: current.degraded ?? null,
          notice,
          ...(migration !== undefined ? { migration } : {}),
          theme,
          standalone: false,
        }))
      },
    },
  ]
}
