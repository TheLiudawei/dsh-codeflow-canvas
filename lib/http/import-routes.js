/**
 * 导入路由组：确定性双图导入、耦合分析与拖拽导入（全部零 LLM）。
 *
 *   POST /api/import          确定性双图导入——一次扫描同时产出任务流水线与
 *                             模块结构图，不唤醒 agent
 *   POST /api/coupling        耦合分析：一个（nodeId）或全部文件级模块节点，
 *                             写回 modules 图并镜像 tasks 的 meta.coupling
 *   GET  /api/coupling        过期判定（mtime 探测，10s 缓存，≤300 文件）
 *   POST /api/drop/begin      拖拽上传：校验限额，发 token，建暂存目录
 *   POST /api/drop/file       拖拽上传：raw body 逐文件上传（≤64MB/文件）
 *   POST /api/drop/finalize   物化 → 根解析 → 双图导入 → 自动耦合 → 会话
 *   POST /api/drop/abort      删除暂存目录（幂等）
 *   POST /api/drop/path       真实路径通道（宿主暴露 getPathForFile 时）
 *
 * v1.2.2 重构：共享编排（landImportResult / finalizeDrop /
 * backupProjectGraphs）迁到 `lib/import/pipeline.js`（L2，不接触 req/res）；
 * 本模块只做 HTTP 解析、状态码与响应组装，并把 pipeline 需要的依赖注入进去。
 * `runCouplingForProject` 仍在这里（依赖 ctx.ensureViewLoaded），经注入交给
 * pipeline 复用。
 *
 * @module dsh-codeflow-canvas/http/import-routes
 */
import { stat as statFile } from 'node:fs/promises'
import path from 'node:path'

import { readConfig } from '../codeflow-config.js'
import { computeStale as computeCouplingStale, isFileModuleNode, metaCouplingOf, runCoupling } from '../coupling.js'
import { importProjectDual, persistDualResult } from '../duo.js'
import { createDropManager, DROP_LIMITS } from '../drop-import.js'
import { rootOf } from '../paths.js'
import { createImportPipeline } from '../import/pipeline.js'
import { detectProjectRoot } from '../import/root-detect.js'
import { cleanPathInput } from '../workspace.js'
import { sendJson, readJsonBody, readRawBody, statusOf } from './respond.js'

/**
 * @param ctx - 路由上下文。
 * @returns `{ routes, dispose }`——路由表项数组 + 清扫器停止钩子。
 */
export function createImportRoutes(ctx) {
  const { store, logger, dirOf, workspaceReady, sessionFor, ensureViewLoaded, cwdExOf } = ctx

  /* ---------- 拖拽暂存区管理器（按 imports/ 根惰性创建） ---------- */

  /**
   * 每个 `imports/` 根一个管理器（30 分钟清扫一次、插件 dispose 时停止）。
   * 惰性是为了让既有组合（测试/极简宿主）零开销。
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
   * 解析「图文件落点」的工作区（v1.2.1，C3）：走 B1 的解析器
   * （binding → project-dir → session → 硬失败），解析不出就在**扫描之前**
   * 抛出可行动错误——绝不先扫一遍再失败，也绝不猜一个落点。源码目录可以是
   * 磁盘上任意已存在目录：工作区只决定图文件落点，不决定可导入范围。
   *
   * @param project - 面板当前展示的项目（导入对话框/拖拽会随请求带来）。
   * @returns 已解析并 `ensureLayout` 的工作区。
   */
  async function workspaceForImport(project) {
    const cwd = await workspaceReady(project)
    if (cwd !== undefined) return cwd
    const resolved = await cwdExOf(project)
    const error = new Error(resolved?.message
      ?? '还没有可用的 DSH 工作区，无法确定 CodeFlow 项目文件的落点。请先在 DSH 左侧栏添加工作区，或先新建一个项目（选定工作区）。')
    error.statusCode = 409
    error.code = 'NO_WORKSPACE'
    throw error
  }

  /* -------------------------- 耦合分析编排（v1.2） -------------------------- */

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
    const couplingStartedAt = Date.now()
    logger?.event?.('coupling.start', { data: { project: target, nodeId: nodeId ?? null } })
    let couplingResult
    try {
      couplingResult = await runCoupling({
        graph: modulesState.graph,
        dir: resolvedDir,
        ...(nodeId !== undefined && nodeId !== null ? { nodeIds: [nodeId] } : {}),
      })
    } catch (error) {
      logger?.event?.('coupling.fail', {
        level: 'error',
        data: { project: target, nodeId: nodeId ?? null, durationMs: Date.now() - couplingStartedAt },
        err: error,
      })
      throw error
    }
    const result = couplingResult
    logger?.event?.('coupling.done', {
      data: {
        project: target,
        nodeId: nodeId ?? null,
        modules: result.overall?.modules,
        durationMs: result.durationMs ?? Date.now() - couplingStartedAt,
        partial: result.overall?.partial === true,
      },
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

  /* -------------------------- 导入落地流水线（v1.2.2） ---------------------- */

  const pipeline = createImportPipeline({
    store,
    dirOf,
    workspaceForImport,
    importProjectDual,
    persistDualResult,
    runCouplingForProject,
    sessionFor,
    dropManagerFor,
    logger,
    // v1.3.0（需求三）：卡片持久化。旧任务图内存优先（用户刚改过的不能丢），
    // 其次磁盘——经 store 的公开能力（loadView/filePath）读取，不拼路径。
    cardsPersistFor: async (workspace) => {
      try {
        const cfg = await readConfig(workspace)
        return cfg?.cards?.persist === true
      } catch {
        return false
      }
    },
    readExistingTasks: async (projectName, workspace) => {
      const key = String(projectName)
      const memory = store.get(key, 'tasks')
      if (memory && (memory.rev > 0 || memory.viewLoaded === true)
        && memory.graph && Array.isArray(memory.graph.nodes) && memory.graph.nodes.length > 0) {
        return { graph: memory.graph, source: 'memory' }
      }
      const dir = await dirOf(workspace, key)
      if (dir === undefined) return undefined
      try {
        await store.loadView(key, workspace, 'tasks', dir)
      } catch {
        return undefined // 没有旧图文件：没有可合并的对象
      }
      const loaded = store.get(key, 'tasks')
      if (loaded && loaded.graph && Array.isArray(loaded.graph.nodes) && loaded.graph.nodes.length > 0
        && loaded.unavailable === undefined) {
        return { graph: loaded.graph, source: 'disk' }
      }
      return undefined
    },
  })

  /* --------------------------------- 路由表 --------------------------------- */

  const routes = [
    {
      method: 'POST',
      path: '/api/import',
      /**
       * 确定性双图导入（v0.6.0）：宿主代码在**一个项目名下**同时产出标记驱动
       * 的任务流水线（lib/importer.js）与代码结构模块图（lib/analyst.js）。
       * 不涉及 agent。旧客户端带来的 legacy `strategy` 字段被接受但不再选择
       * 任何东西。v1.2.2：导入根经 `detectProjectRoot(mode:'path')` 保守解析
       * （外壳套外壳找到真实项目根；`proj/src` 保留 `proj`；空壳/歧义 400）。
       */
      async handler(req, res, { project }) {
        const body = await readJsonBody(req)
        const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
        const inputPath = cleanPathInput(input.path)
        if (inputPath.length === 0) {
          sendJson(res, 400, { ok: false, error: '未提供项目路径' })
          return
        }
        // v1.2.1（C3）：先解析落点工作区（画布当前展示的项目 → 最近项目），
        // 解析不出就**在扫描之前**报错；源码目录可以是任意已存在目录，
        // 工作区只决定图文件落点。
        const target = (typeof input.project === 'string' && input.project.trim().length > 0)
          ? input.project.trim()
          : (project ?? store.mostRecent())
        let cwd
        try {
          cwd = await workspaceForImport(target === undefined ? undefined : String(target))
        } catch (error) {
          sendJson(res, statusOf(error), { ok: false, code: error.code ?? 'NO_WORKSPACE', error: String(error?.message ?? error) })
          return
        }
        const resolvedPath = path.isAbsolute(inputPath) ? inputPath : cleanPathInput(inputPath, { cwd })
        logger?.event?.('import.start', { data: { channel: 'dialog', pkg: path.basename(resolvedPath) } })
        const info = await statFile(resolvedPath).catch(() => undefined)
        if (info === undefined) {
          // 与 lib/workspace.js resolveProjectRoot 的旧消息保持一致（既有断言）。
          logger?.event?.('import.fail', { data: { channel: 'dialog', code: 'PATH_MISSING' } })
          sendJson(res, 400, { ok: false, error: `目录不存在：${resolvedPath}` })
          return
        }
        if (!info.isDirectory()) {
          sendJson(res, 400, { ok: false, error: '不是目录：路径导入需要指向一个项目文件夹' })
          return
        }
        // v1.2.2：保守根解析（空壳/歧义/多项目父目录的判定与三条拖拽通道一致）。
        const detection = await detectProjectRoot(resolvedPath, { mode: 'path' })
        logger?.event?.('import.root', {
          data: {
            requested: resolvedPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/'),
            resolved: String(detection.root).split(/[\\/]/).filter(Boolean).slice(-2).join('/'),
            unwrappedDepth: detection.unwrappedDepth,
            ignoredEmptyDirs: detection.ignoredEmptyDirs,
            ambiguous: detection.ambiguous,
            multiProject: detection.multiProject,
            reason: detection.reason,
          },
        })
        if (!detection.hasContent) {
          sendJson(res, 400, { ok: false, code: 'EMPTY_SHELL', error: '该目录中没有可识别的文件（只有空目录），已拒绝导入' })
          return
        }
        if (detection.ambiguous) {
          sendJson(res, 400, {
            ok: false,
            code: 'SHELL_AMBIGUOUS',
            error: '无法确定项目根：该目录下只有子目录且没有项目标记。请直接选择具体的项目目录（含 package.json / pyproject.toml / .git 等标记）再导入。',
            ...(detection.ambiguousCandidates.length ? { candidates: detection.ambiguousCandidates } : {}),
          })
          return
        }
        const existingNames = new Set((await store.listProjects(cwd)).map((entry) => entry.name))
        for (const key of store.keys()) existingNames.add(key)
        let result
        try {
          result = await importProjectDual({
            path: detection.root,
            cwd,
            maxFiles: input.maxFiles,
            maxDepth: input.depth,
            fromComments: input.fromComments,
            addTests: input.addTests,
            existingNames,
          })
        } catch (error) {
          logger?.event?.('import.fail', { data: { channel: 'dialog', code: 'SCAN_FAILED' } })
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
          return
        }
        const payload = await pipeline.landImportResult(result, { cwd })
        logger?.event?.('import.done', { data: { project: payload.project, channel: 'dialog', modulesAvailable: payload.modulesAvailable === true } })
        sendJson(res, 200, {
          ...payload,
          unwrappedDepth: detection.unwrappedDepth,
          ignoredEmptyDirs: detection.ignoredEmptyDirs,
          ...(detection.multiProject === true ? { multiProject: true } : {}),
        })
      },
    },
    {
      method: 'POST',
      path: '/api/coupling',
      /** 耦合分析（零 LLM）：分析并写回，附 overall/updated/skipped/warning。 */
      async handler(req, res, { project }) {
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
      },
    },
    {
      method: 'GET',
      path: '/api/coupling',
      /** 过期判定：存档 meta.coupling 的 mtime 探测（10s 缓存），从不自动重算。 */
      async handler(req, res, { project }) {
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
      },
    },
    {
      method: 'POST',
      path: '/api/drop/begin',
      /** 拖拽上传开始：校验限额、发 token、建 `.staging/<token>/`。 */
      async handler(req, res) {
        const body = (await readJsonBody(req)) ?? {}
        let cwd
        try {
          cwd = await workspaceForImport(store.mostRecent())
        } catch (error) {
          sendJson(res, statusOf(error), { ok: false, code: error.code ?? 'NO_WORKSPACE', error: String(error?.message ?? error) })
          return
        }
        const manager = await dropManagerFor(cwd)
        const result = await manager.begin(body)
        sendJson(res, 200, { ok: true, ...result })
      },
    },
    {
      method: 'POST',
      path: '/api/drop/file',
      /**
       * 拖拽上传的单文件通道。先排空请求体（超限继续读完再答 413，保住
       * keep-alive），再做一切校验；限额违规（413）按附录 C 清理该 token。
       */
      async handler(req, res, { url }) {
        const { buffer, oversized } = await readRawBody(req, DROP_LIMITS.maxFileBytes)
        const token = url.searchParams.get('token') ?? ''
        const rawRel = url.searchParams.get('path') ?? ''
        const contentType = String(req.headers['content-type'] ?? '')
        if (oversized) {
          sendJson(res, 413, { ok: false, error: `单文件超过 ${Math.round(DROP_LIMITS.maxFileBytes / (1024 * 1024))} MB，已拒绝导入` })
          return
        }
        if (contentType.length > 0 && !contentType.startsWith('application/octet-stream')) {
          sendJson(res, 400, { ok: false, error: '文件上传必须使用 application/octet-stream' })
          return
        }
        const cwd = await workspaceReady(undefined)
        if (cwd === undefined) {
          // 理论上不可达（begin 已硬失败过一次）；保持防御性 409。
          sendJson(res, 409, { ok: false, error: '还没有可用的 DSH 工作区，无法导入拖入的项目' })
          return
        }
        const manager = await dropManagerFor(cwd)
        try {
          const result = await manager.writeFile(token, rawRel, buffer ?? Buffer.alloc(0))
          sendJson(res, 200, { ok: true, received: result.received })
        } catch (error) {
          const status = statusOf(error)
          if (status === 413) await manager.abort(token).catch(() => {})
          sendJson(res, status, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      method: 'POST',
      path: '/api/drop/finalize',
      /** 拖拽上传收口：物化 → 根解析 → 双图导入 → 自动耦合 → 会话。 */
      async handler(req, res) {
        const body = (await readJsonBody(req)) ?? {}
        const payload = await pipeline.finalizeDrop(body)
        sendJson(res, 200, payload)
      },
    },
    {
      method: 'POST',
      path: '/api/drop/abort',
      /** 删除暂存目录（幂等）；没有工作区时也算成功。 */
      async handler(req, res) {
        const body = (await readJsonBody(req)) ?? {}
        const cwd = await workspaceReady(undefined)
        if (cwd !== undefined) {
          const manager = await dropManagerFor(cwd)
          await manager.abort(String(body.token ?? '')).catch(() => {})
        }
        sendJson(res, 200, { ok: true })
      },
    },
    {
      method: 'POST',
      path: '/api/drop/path',
      /** 真实路径通道（宿主暴露 getPathForFile 时）：与 finalize 同一落地。 */
      async handler(req, res) {
        const body = (await readJsonBody(req)) ?? {}
        const payload = await pipeline.finalizeDrop(body)
        sendJson(res, 200, payload)
      },
    },
  ]

  /** 停止本组的全部清扫器（插件 dispose）。 */
  function dispose() {
    for (const manager of dropManagers.values()) manager.dispose()
    dropManagers.clear()
  }

  return { routes, dispose }
}
