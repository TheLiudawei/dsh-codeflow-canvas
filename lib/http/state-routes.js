/**
 * 状态路由组：画布的图状态读写与配套管理面。
 *
 *   GET  /api/state   一个视图的当前图（`?view=`；缺省：项目激活视图）
 *   POST /api/state   画布自动保存（只 bump 目标视图的 rev；支持 expectedRev）
 *   POST /api/view    切换激活视图（纯簿记：不 bump rev、不重扫、不唤醒 agent）
 *   POST /api/session 新建/重绑项目的画布专用会话
 *   GET  /api/activity 实时推理/步骤/进度/编辑记录（纯内存读模型）
 *   GET  /api/undo    运行历史（最新在前，带视图标记）
 *   POST /api/undo    撤销一次运行（严格 LIFO）或预检（`dryRun`）
 *   POST /api/save    无回合落盘（可选写图 + flush；失败 507）
 *
 * 每一次写都经过 store，rev 的归属权在 store（每视图独立计数）。
 *
 * @module dsh-codeflow-canvas/http/state-routes
 */
import { VIEW_LABEL, normalizeView } from '../graph-format.js'
import { sendJson, readJsonBody } from './respond.js'
import { viewFieldsOf } from './context.js'

/**
 * @param ctx - 路由上下文。
 * @returns 路由表项数组。
 */
export function createStateRoutes(ctx) {
  const { store, activityRead, undoList, undoRestore, cwdOf, dirOf, ensureViewLoaded, sessionFor, sessionFields } = ctx
  return [
    {
      method: 'GET',
      path: '/api/state',
      strict405: true,
      /** 一个视图的当前图；指名视图不可用时 409（带可用性摘要）。 */
      async handler(req, res, { url, project }) {
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
          // v1.0：项目实际在磁盘上的位置（状态栏 tooltip）。
          projectDir: current.dir ?? null,
        })
      },
    },
    {
      method: 'POST',
      path: '/api/state',
      strict405: true,
      /**
       * 画布自动保存。持久结果在应答前已知（B2）：以前是服务端防抖，一次
       * 失败的磁盘写会以 `{"ok":true}` 应答且完全没有 `persisted` 字段——
       * 用户以为图已保存，只有日志知道没有。
       */
      async handler(req, res, { project }) {
        const body = await readJsonBody(req)
        if (body === undefined || body === null || typeof body !== 'object') {
          sendJson(res, 400, { ok: false, error: 'expected a JSON body' })
          return
        }
        const cwd = await cwdOf(body.project ?? project)
        const { view, viewport } = viewFieldsOf(body)
        const writtenProject = (body.graph !== null && typeof body.graph === 'object' ? body.graph?.project?.name : undefined)
          ?? body.project ?? project
        const written = await store.write(body.graph ?? body, {
          persist: 'now',
          view,
          viewport,
          cwd,
          dir: await dirOf(cwd, writtenProject),
          // 两个窗口开同一个项目：基准修订过时的写者被 409 拒绝，而不是
          // 悄悄覆盖（B5）。
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
      },
    },
    {
      method: 'POST',
      path: '/api/view',
      /** 切换激活视图。纯簿记；侧车写失败降级为 warning。 */
      async handler(req, res, { project }) {
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
      },
    },
    {
      method: 'POST',
      path: '/api/session',
      /** 新建（或 `action:"rebind"` 重绑）项目的画布专用会话；失败 409。 */
      async handler(req, res, { project }) {
        const { rebindSession } = ctx
        const body = await readJsonBody(req)
        const target = (body !== null && typeof body === 'object' ? body.project : undefined) ?? project
        if (target === undefined || String(target).length === 0) {
          sendJson(res, 400, { ok: false, error: 'expected a project name' })
          return
        }
        const wantsRebind = body !== null && typeof body === 'object' && body.action === 'rebind'
        try {
          // 新建会话替换绑定；旧会话仍留在 DSH 的会话列表里。
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
      },
    },
    {
      method: 'GET',
      path: '/api/activity',
      /** 实时推理/步骤/进度/编辑记录（活动中心读模型；`?after`/`?nodeId` 增量）。 */
      async handler(req, res, { url, project }) {
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
      },
    },
    {
      method: 'GET',
      path: '/api/undo',
      /** 运行历史（最新在前）；撤销服务缺失时给空表而非错误。 */
      async handler(req, res, { project }) {
        const target = project ?? store.mostRecent()
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
      },
    },
    {
      method: 'POST',
      path: '/api/undo',
      /** 撤销一次运行（LIFO；`dryRun` 只预检）。结果 `ok:false` 时带原状态码。 */
      async handler(req, res, { project }) {
        const body = await readJsonBody(req)
        const target = project ?? store.mostRecent()
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
      },
    },
    {
      method: 'POST',
      path: '/api/save',
      /**
       * 无回合落盘（保存按钮）。可选先写一次图，然后 flush。
       * 从未到达磁盘的保存就是失败的保存：回答 507 + `ok:false`（B3），
       * 而不是只有细心读者才注意到的 `persisted:false` 的 200。
       */
      async handler(req, res, { project }) {
        const body = await readJsonBody(req)
        let target = body?.project ?? project ?? store.mostRecent()
        const cwd = await cwdOf(target)
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
      },
    },
  ]
}
