/**
 * 导入落地编排（v1.2.2，需求二）——三条导入通道共享的 `finalizeDrop` /
 * `landImportResult`，从 `lib/http/import-routes.js` 抽出的**无 HTTP 半边**。
 *
 * 依赖方向（架构红线）：本模块是 L2 编排——
 *
 *   - 允许 import：L0/L1 领域模块（root-detect / archive / drop-import /
 *     workspace / core/*）与 `node:*`；
 *   - 禁止 import：`node:http`、`lib/http/*`；**不出现 `req`/`res`**；
 *   - L2+ 能力全部经 `deps` 注入：store / dirOf / workspaceForImport /
 *     importProjectDual / persistDualResult / runCouplingForProject /
 *     sessionFor / dropManagerFor / logger。
 *
 * v1.2.2 的行为变化（任务书 §7.4）：三条通道的 `sourceRoot` 都经
 * `detectProjectRoot` 解析——
 *
 *   - 路径目录（`mode:'path'`）：只在「无强直接文件 + 信号明确」时去壳；
 *     `proj/src` 保留 `proj`；空目录 400；单链无标记外壳 400
 *     `SHELL_AMBIGUOUS`（绝不删用户源目录）；
 *   - 压缩包/上传目录（`mode:'archive'`）：最外层按既有语义剥一层，再走同一
 *     决策链；空壳/歧义 400 并清理 `imports/<pkgName>/` 与暂存区。
 *
 * @module dsh-codeflow-canvas/import/pipeline
 */
import { rename as renameFile, rm, stat as statFile } from 'node:fs/promises'
import path from 'node:path'

import { stripArchiveExtension } from '../archive.js'
import { safeProjectName } from '../core/path.js'
import { resolveProjectName } from '../drop-import.js'
import { cleanPathInput } from '../workspace.js'
import { detectProjectRoot } from './root-detect.js'

/** `SHELL_AMBIGUOUS` 的可行动错误（客户端 toast 直接可用）。 */
function shellAmbiguous(message, candidates) {
  const error = new Error(message)
  error.statusCode = 400
  error.code = 'SHELL_AMBIGUOUS'
  error.candidates = candidates
  return error
}

/**
 * 创建导入流水线。
 *
 * @param deps.store - 画布 store（图状态的唯一写者）。
 * @param deps.dirOf - `(cwd, projectName) => dir`，项目持久目录解析。
 * @param deps.workspaceForImport - 解析落点工作区（解析不出抛可行动错误）。
 * @param deps.importProjectDual - 双图导入（lib/duo.js）。
 * @param deps.persistDualResult - 双图持久化 + 功能索引钩子（lib/duo.js）。
 * @param deps.runCouplingForProject - 导入后自动耦合（import-routes 编排）。
 * @param deps.sessionFor - 会话降级助手（lib/http/context.js）。
 * @param deps.dropManagerFor - 拖拽暂存管理器工厂。
 * @param deps.logger - 组合 logger（宿主 + 文件日志；可选 `event()`）。
 * @returns `{ finalizeDrop, landImportResult, backupProjectGraphs }`。
 */
export function createImportPipeline(deps) {
  const {
    store, dirOf, workspaceForImport, importProjectDual, persistDualResult,
    runCouplingForProject, sessionFor, dropManagerFor, logger,
  } = deps

  /** 事件日志（无 `event()` 的宿主 logger 降级为 no-op——绝不刷测试控制台）。 */
  const logEvent = (event, data) => {
    try {
      if (typeof logger?.event === 'function') logger.event(event, { data })
    } catch { /* 日志绝不打断导入 */ }
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

  /**
   * 导入结果的统一落地流程（/api/import、/api/drop/finalize、/api/drop/path
   * 共用）：写两张图 → v1.1 功能索引钩子 → v1.2 自动耦合分析（纯本地，
   * 零 token）→ 专用会话 → 组装响应载荷。耦合失败只降级为 `coupling:null`。
   */
  async function landImportResult(result, { cwd } = {}) {
    const importDir = await dirOf(cwd, result.name)
    logEvent('import.persist', { project: result.name, phase: 'begin' })
    // 双图写入 + v1.1 功能索引钩子（与 /flow-import 共用的最小序列）。
    const { writtenTasks, writtenModules, featuresSummary } = await persistDualResult(store, {
      result,
      cwd,
      dir: importDir,
      logger,
    })
    logEvent('import.persist', {
      project: result.name,
      phase: 'done',
      tasksPersisted: writtenTasks?.persisted !== false,
      modulesWritten: writtenModules !== undefined,
      features: featuresSummary !== undefined,
    })
    // v1.2 导入钩子：自动跑一次「全部」耦合分析并镜像到任务图。失败只降级。
    let coupling = null
    if (result.modulesGraph !== undefined) {
      const startedAt = Date.now()
      try {
        const coupled = await runCouplingForProject(result.name, { cwd, dir: importDir })
        if (coupled.result.overall !== null) coupling = { overall: coupled.result.overall }
        logEvent('import.coupling', { project: result.name, durationMs: Date.now() - startedAt, ok: true })
      } catch (error) {
        logEvent('import.coupling', { project: result.name, durationMs: Date.now() - startedAt, ok: false })
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

  /**
   * 拖拽/路径导入的落地编排（/api/drop/finalize 与 /api/drop/path 共用）：
   * 冲突预检（imports/<包名> + 项目名，409 时暂存区原样保留）→ 物化（移动
   * 暂存 / 解压到 imports/<包名>）→ 根解析 → 双图导入 → 特征索引 → 自动耦合
   * → 会话。除「项目名冲突」以外的失败都会清理解压目录与暂存区，绝不留
   * 半成品；路径导入失败绝不删用户源目录。
   */
  async function finalizeDrop(body = {}) {
    const viaPath = typeof body.path === 'string' && body.path.length > 0
    const kind = body.kind === 'archive' ? 'archive' : 'dir'
    const overwrite = body.overwrite === true
    const rename = body.rename === true
    const startedAt = Date.now()
    // v1.2.1：落点走 B1 解析器——优先画布当前展示的项目，其次最近项目；
    // 解析不出就在物化/上传之前硬失败。
    const target = typeof body.project === 'string' && body.project.trim().length > 0
      ? body.project.trim()
      : store.mostRecent()
    const cwd = await workspaceForImport(target === undefined ? undefined : String(target))
    const manager = await dropManagerFor(cwd)
    const token = viaPath ? null : String(body.token ?? '')
    const session = viaPath ? null : manager.sessionOf(token)
    if (!viaPath && session === undefined) {
      throw Object.assign(new Error('上传会话不存在或已过期，请重新拖入'), { statusCode: 400 })
    }
    if (!viaPath && session.kind !== kind) {
      throw Object.assign(new Error('上传会话类型不匹配，请重新拖入'), { statusCode: 400 })
    }
    const channel = viaPath ? (kind === 'archive' ? 'path-archive' : 'path-dir') : (kind === 'archive' ? 'upload-archive' : 'upload-dir')
    const baseName = viaPath ? path.basename(String(body.path)) : (session.name || 'import')
    const pkgBase = safeProjectName(kind === 'archive' ? stripArchiveExtension(baseName) : baseName)
    logEvent('import.start', { channel, pkg: pkgBase, files: session?.files, bytes: session?.bytes })
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
    // ---- 物化 + 根解析 + 导入（失败清理；此后的项目名冲突不再删已解压目录）--
    let sourceRoot
    let extractedTo = null
    let innerName = null
    let rootInfo = null
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
          // 路径目录：保守去壳（mode:'path'）——无强直接文件 + 信号明确才下钻。
          rootInfo = await detectProjectRoot(clean, { mode: 'path' })
          logEvent('import.root', {
            requested: tailPath(clean),
            resolved: tailPath(rootInfo.root),
            unwrappedDepth: rootInfo.unwrappedDepth,
            ignoredEmptyDirs: rootInfo.ignoredEmptyDirs,
            ambiguous: rootInfo.ambiguous,
            multiProject: rootInfo.multiProject,
            reason: rootInfo.reason,
          })
          if (!rootInfo.hasContent) {
            throw Object.assign(new Error('该目录中没有可识别的文件（只有空目录），已拒绝导入'), { statusCode: 400, code: 'EMPTY_SHELL' })
          }
          if (rootInfo.ambiguous) {
            throw shellAmbiguous(
              `无法确定项目根：${tailPath(clean)} 下只有 ${tailPath(rootInfo.ambiguousCandidates[0] ?? '')} 等子目录，且没有项目标记。`
              + '请直接选择具体的项目目录（含 package.json / pyproject.toml / .git 等标记）再导入。',
              rootInfo.ambiguousCandidates,
            )
          }
          sourceRoot = rootInfo.root
        }
      } else if (kind === 'archive') {
        const commit = await manager.commitStagedArchive(token, pkgName)
        extractedTo = commit.target
      } else {
        extractedTo = await manager.commitDirUpload(token, pkgName)
      }
      if (extractedTo !== null) {
        // 压缩包/上传目录：最外层按既有语义剥一层，再走保守决策链。
        rootInfo = await detectProjectRoot(extractedTo, { mode: 'archive' })
        logEvent('import.root', {
          requested: tailPath(extractedTo),
          resolved: tailPath(rootInfo.root),
          unwrappedDepth: rootInfo.unwrappedDepth,
          ignoredEmptyDirs: rootInfo.ignoredEmptyDirs,
          ambiguous: rootInfo.ambiguous,
          multiProject: rootInfo.multiProject,
          reason: rootInfo.reason,
        })
        if (!rootInfo.hasContent) {
          throw Object.assign(new Error('解压后没有任何可识别的文件（只有空目录/元数据），已拒绝导入'), { statusCode: 400, code: 'EMPTY_SHELL' })
        }
        if (rootInfo.ambiguous) {
          throw shellAmbiguous(
            '无法确定压缩包里的项目根：解压目录下没有项目标记，也没有明显的外壳名信号。'
            + '请解压后拖入具体的项目目录（含 package.json / pyproject.toml / .git 等标记）。',
            rootInfo.ambiguousCandidates,
          )
        }
        sourceRoot = rootInfo.root
        innerName = rootInfo.root !== extractedTo ? path.basename(rootInfo.root) : null
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
      logEvent('import.done', {
        project: payload.project,
        channel,
        durationMs: Date.now() - startedAt,
        modulesAvailable: payload.modulesAvailable === true,
      })
      return {
        ...payload,
        sourceRoot,
        ...(extractedTo !== null ? { extractedTo } : {}),
        ...(pkgName !== null ? { pkgName } : {}),
        // v1.2.2：根解析的可观测字段（测试与日志用）。
        unwrappedDepth: rootInfo?.unwrappedDepth,
        ignoredEmptyDirs: rootInfo?.ignoredEmptyDirs,
        multiProject: rootInfo?.multiProject === true ? true : undefined,
      }
    } catch (error) {
      logEvent('import.fail', {
        channel,
        durationMs: Date.now() - startedAt,
        code: error?.code,
        message: String(error?.message ?? error).slice(0, 200),
      })
      // 半成品清理：解压目录与暂存区都删掉（项目名冲突除外——预检已在那之前
      // 拦住；去壳后才暴露的同名冲突保留目录，用户可重拖）。路径导入绝不删
      // 用户源目录：只有 imports/<pkgName>（物化产物）会被清理。
      if (error?.code !== 'conflict' && extractedTo !== null && pkgName !== null) {
        await rm(path.join(manager.importsRoot, pkgName), { recursive: true, force: true }).catch(() => {})
      }
      if (token !== null) await manager.abort(token).catch(() => {})
      throw error
    }
  }

  return { finalizeDrop, landImportResult, backupProjectGraphs }
}

/** 绝对路径截尾：只保留最后两段（日志与错误消息用，避免泄露完整目录结构）。 */
function tailPath(value) {
  const text = String(value ?? '')
  if (text.length === 0) return ''
  const segments = text.split(/[\\/]/).filter(Boolean)
  return segments.length <= 2 ? text : `…/${segments.slice(-2).join('/')}`
}
