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
 *   POST /api/drop/finalize   物化 → 去壳 → 双图导入 → 自动耦合 → 会话
 *   POST /api/drop/abort      删除暂存目录（幂等）
 *   POST /api/drop/path       真实路径通道（宿主暴露 getPathForFile 时）
 *
 * 本模块同时持有导入的共享编排（runCouplingForProject / landImportResult /
 * finalizeDrop / backupProjectGraphs）——三个入口（/api/import、
 * /api/drop/finalize、/api/drop/path）走同一条落地流水线。
 *
 * @module dsh-codeflow-canvas/http/import-routes
 */
import { rename as renameFile, rm, stat as statFile } from 'node:fs/promises'
import path from 'node:path'

import { stripArchiveExtension, stripSingleRoot } from '../archive.js'
import { computeStale as computeCouplingStale, isFileModuleNode, metaCouplingOf, runCoupling } from '../coupling.js'
import { importProjectDual, persistDualResult } from '../duo.js'
import { createDropManager, DROP_LIMITS, resolveProjectName } from '../drop-import.js'
import { rootOf } from '../paths.js'
import { safeProjectName } from '../core/path.js'
import { cleanPathInput } from '../workspace.js'
import { sendJson, readJsonBody, readRawBody, statusOf } from './respond.js'

/**
 * @param ctx - 路由上下文。
 * @returns `{ routes, dispose }`——路由表项数组 + 清扫器停止钩子。
 */
export function createImportRoutes(ctx) {
  const { store, logger, dirOf, workspaceReady, sessionFor, ensureViewLoaded } = ctx

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

  /* -------------------------- 导入落地（三入口共用） -------------------------- */

  /**
   * 导入结果的统一落地流程（/api/import、/api/drop/finalize、/api/drop/path
   * 共用，v1.2）：写两张图 → v1.1 功能索引钩子 → v1.2 自动耦合分析（纯本地，
   * 零 token）→ 专用会话 → 组装响应载荷。耦合失败只降级为 `coupling:null`。
   */
  async function landImportResult(result, { cwd } = {}) {
    const importDir = await dirOf(cwd, result.name)
    // 双图写入 + v1.1 功能索引钩子（与 /flow-import 共用的最小序列）。
    const { writtenTasks, writtenModules, featuresSummary } = await persistDualResult(store, {
      result,
      cwd,
      dir: importDir,
      logger,
    })
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
    // 导入本身在宿主侧完成，但后续画布手势需要画布会话：现在就建好，
    // 「运行」才能少一次往返。失败只是 warning——导入的项目照常可编辑。
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

  /* ------------------------------ 拖拽落地编排 ------------------------------ */

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

  /* --------------------------------- 路由表 --------------------------------- */

  const routes = [
    {
      method: 'POST',
      path: '/api/import',
      /**
       * 确定性双图导入（v0.6.0）：宿主代码在**一个项目名下**同时产出标记驱动
       * 的任务流水线（lib/importer.js）与代码结构模块图（lib/analyst.js）。
       * 不涉及 agent。旧客户端带来的 legacy `strategy` 字段被接受但不再选择
       * 任何东西。v1.2：落地流水线（图、特征索引、自动耦合、会话）与拖拽
       * 导入共享 `landImportResult`。
       */
      async handler(req, res, { project }) {
        const body = await readJsonBody(req)
        const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
        // 绑定到可用工作区；没有工作区时图仍会渲染（在内存里）。
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
        const payload = await landImportResult(result, { cwd })
        sendJson(res, 200, payload)
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
        const cwd = await workspaceReady(undefined)
        if (cwd === undefined) {
          sendJson(res, 409, { ok: false, error: '还没有可用的 DSH 工作区，无法导入拖入的项目' })
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
          const status = statusOf(error)
          if (status === 413) await manager.abort(token).catch(() => {})
          sendJson(res, status, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      method: 'POST',
      path: '/api/drop/finalize',
      /** 拖拽上传收口：物化 → 去壳 → 双图导入 → 自动耦合 → 会话。 */
      async handler(req, res) {
        const body = (await readJsonBody(req)) ?? {}
        const payload = await finalizeDrop(body)
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
        const payload = await finalizeDrop(body)
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
