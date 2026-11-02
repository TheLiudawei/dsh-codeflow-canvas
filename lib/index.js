/**
 * dsh-codeflow-canvas — 插件宿主入口（纯装配）。
 *
 * 本插件向宿主贡献四样东西，全部需要 Host 进程：
 *
 *   1. 一个技能提供者  —— `codeflow-canvas` 编排文档；
 *   2. 三个命令        —— `/flow`、`/flow-new`、`/flow-import`；
 *   3. 两个工具        —— `codeflow_canvas`（渲染/回读图）与
 *                          `codeflow_features`（功能分组索引，v1.1）；
 *   4. 一个 HTTP 面    —— 面板文档 + 图 API（lib/routes.js + lib/http/*）。
 *
 * 浏览器半边（lib/client.js）只贡献面板与侧边栏入口；它刻意保持轻薄，
 * 画布自持文档、样式与输入处理，不触碰外壳的。
 *
 * 自 v0.5.0 起还有三块：
 *
 *   - 会话管理器（lib/sessions.js）：每个项目一条专用的、持久绑定的画布
 *     会话；画布手势只投递到那里——"猜测唯一活跃根"已成历史；
 *   - 活动中心（lib/activity.js）与撤销管理器（lib/undo.js）：运行变得
 *     可观测（推理/步骤/进度）与可回退（运行前快照）；
 *   - 手势投递层（lib/gestures.js）：`[CodeFlow:*]` 协议与运行协调。
 *
 * 本文件只负责把组件**接在一起**：创建 store、订阅回合结束对账、把会话/
 * 活动/撤销的依赖以薄 lambda 注入路由。任何一行协议细节都不在这里。
 *
 * @module dsh-codeflow-canvas
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { normalizeView, VIEW_KEYS } from './graph-format.js'
import { createActivityHub } from './activity.js'
import { browseDirectory as browseDirectoryPath } from './browse.js'
import { registerCommands } from './commands.js'
import { createGestureDispatcher, topoOrderOf } from './gestures.js'
import { registerFeaturesTool } from './features-tool.js'
import { createFileLogger, createCompositeLogger } from './logging/file-logger.js'
import { readLogTail } from './logging/reader.js'
import { createReveal } from './logging/reveal.js'
import { migrateLegacy, setPathsLogger } from './paths.js'
import { createRouter, ROUTE_PREFIX } from './routes.js'
import { createSessionManager } from './sessions.js'
import { registerSkill } from './skill.js'
import { createStore } from './store.js'
import { registerTool } from './tool.js'
import { createUndoManager } from './undo.js'
import { collectWorkspaces, validateWorkspaceChoice } from './workspace-binding.js'

/** Cordis 插件标识。 */
export const name = 'codeflow-canvas'

/** 本插件缺了就无法工作的宿主服务。 */
export const inject = ['skills', 'commands', 'tools']

/** 拓扑序助手（历史导出面；实现在 lib/gestures.js）。 */
export { topoOrderOf }

/** 解析 logger 而不绑定某个特定的 Cordis 形状。 */
function loggerOf(ctx) {
  const logger = ctx?.logger
  if (logger !== undefined && typeof logger.warn === 'function') return logger
  return console
}

/* ------------------------------------------------ 文件日志（v1.2.2）------ */

/** 启动期一次性的同步可写探测（探测文件即建即删）。 */
function writableProbe(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.codeflow-log-probe')
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/**
 * 决定文件日志的位置与开关（任务书 §8.1）：
 *
 *   - `CODEFLOW_LOG=off` → 完全关闭（测试默认）；
 *   - `CODEFLOW_LOG_FILE` → 覆盖路径（测试用临时文件）；
 *   - 默认：插件根 `codeflow.log`（安装目录 = 仓库 Junction，同一份文件）；
 *   - 安装目录不可写 → 退回 `%LOCALAPPDATA%\dsh-codeflow-canvas\codeflow.log`
 *     并返回 `fallback:true`（apply() 里补一条 `log.fallback` + warn）；
 *     回退也失败 → 只走宿主 logger，插件照常工作。
 */
function resolveFileLogger() {
  if (String(process.env.CODEFLOW_LOG ?? '').toLowerCase() === 'off') {
    return { fileLogger: undefined, fallback: false, disabled: true }
  }
  const override = process.env.CODEFLOW_LOG_FILE
  if (override) return { file: override, fallback: false, disabled: false }
  const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
  const candidates = [
    { file: path.join(pluginRoot, 'codeflow.log'), dir: pluginRoot },
    { file: path.join(localAppData, 'dsh-codeflow-canvas', 'codeflow.log'), dir: path.join(localAppData, 'dsh-codeflow-canvas') },
  ]
  for (const candidate of candidates) {
    if (writableProbe(candidate.dir)) return { file: candidate.file, fallback: candidate.dir !== pluginRoot, disabled: false }
  }
  return { file: undefined, fallback: false, disabled: false }
}

/** 插件版本（package.json 是唯一事实来源）。 */
const PLUGIN_VERSION = createRequire(import.meta.url)('../package.json').version

/** 探测宿主 shell 能力（reveal 用；没有就是 undefined → 501 降级）。 */
function hostShellOf(ctx) {
  try {
    const shell = typeof ctx?.get === 'function' ? ctx.get('shell') : undefined
    if (shell !== undefined && shell !== null && typeof shell === 'object') return shell
  } catch { /* 无该服务 */ }
  try {
    if (ctx?.shell !== undefined && ctx?.shell !== null && typeof ctx.shell === 'object') return ctx.shell
  } catch { /* 无该属性 */ }
  return undefined
}

/**
 * 组装插件级 logger：宿主 logger + 文件 logger（`CODEFLOW_LOG=off` 时纯宿主）。
 * 启动即写 `plugin.start`；安装目录不可写时退回 LOCALAPPDATA 并记
 * `log.fallback`。初始化失败绝不阻断插件启动。
 */
function createPluginLogger(hostLogger) {
  try {
    const resolved = resolveFileLogger()
    const fileLogger = resolved.disabled || !resolved.file ? undefined : createFileLogger({ file: resolved.file, hostLogger })
    const logger = createCompositeLogger(hostLogger, fileLogger)
    if (fileLogger) {
      if (resolved.fallback) {
        logger.warn('codeflow: 插件安装目录不可写，文件日志已退回到 %LOCALAPPDATA%\\dsh-codeflow-canvas\\codeflow.log')
        logger.event('log.fallback', { data: { file: resolved.file } })
      }
      logger.event('plugin.start', {
        msg: `codeflow-canvas ${PLUGIN_VERSION}`,
        data: { node: process.versions.node, platform: process.platform, file: resolved.file },
      })
    }
    return { logger, fileLogger }
  } catch {
    return { logger: createCompositeLogger(hostLogger, undefined), fileLogger: undefined }
  }
}

/**
 * Cordis 插件主体。
 *
 * v1.2.2：apply 主体包一层错误边界——`plugin.fatal` 记录后**重新抛出**，
 * 不吞掉启动失败（宿主需要看见）。
 *
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  const hostLogger = loggerOf(ctx)
  const { logger, fileLogger } = createPluginLogger(hostLogger)
  try {
    applyInner(ctx, logger, fileLogger)
  } catch (error) {
    try {
      logger?.event?.('plugin.fatal', { level: 'error', msg: String(error?.message ?? error), err: error })
    } catch { /* 连 fatal 都写不进去时只走宿主 */ }
    throw error
  }
}

/**
 * apply 的装配体（只接线，不写业务规则）。
 * @param ctx - 插件上下文。
 * @param logger - 组合 logger（宿主 + 文件）。
 * @param fileLogger - 文件 logger（可能为 undefined：日志关闭/不可写）。
 */
function applyInner(ctx, logger, fileLogger) {
  setPathsLogger(logger)
  const store = createStore(logger)

  // v1.2.2：dispose 顺序契约（宿主按 LIFO 销毁；本 effect **最先注册 → 最后
  // 执行**）：store.flushAll()（冲刷挂起写）→ plugin.stop（最后的告警还写得
  // 进文件）→ log.close()（冲刷并停写）。少了 flush，在 600ms 防抖窗口内退出
  // DSH 会悄悄丢掉最新一次编辑；顺序颠倒会让 flush 的告警写不进已关闭的日志。
  ctx.effect(() => () => {
    return (async () => {
      try {
        await store.flushAll()
      } catch (error) {
        logger?.warn?.(`codeflow: flush on dispose failed: ${String(error)}`)
      }
      try {
        logger?.event?.('plugin.stop', { msg: '插件卸载，日志关闭', data: { graceful: true } })
        await fileLogger?.close?.()
      } catch { /* 关闭失败不影响卸载 */ }
    })()
  }, 'codeflow-canvas: flush writes → plugin.stop → close file log on dispose')

  registerSkill(ctx)
  registerCommands(ctx, store)

  const sessions = createSessionManager({ ctx, store, logger })
  const activity = createActivityHub({ store, logger })
  /** 项目键 → 正在途中的快照级运行（清单 + 回合对账需要的载荷位，v1.0 A3.4）。 */
  const currentRuns = new Map()
  const undo = createUndoManager({
    store,
    logger,
    onRestored: (project) => activity.clear(project),
  })

  /* ------------------------------------------- 回合对账（v1.0 A3.4）--- */

  /**
   * 回合结束对账。专用会话的回合结束了，但本次运行的目标节点没有任何执行
   * 痕迹——正是字段报告里"agent 只回复不执行"的现场。把它翻成明确的
   * `failed`（可行动的原因），并在活动读模型里记一条 issue，画布据此显示
   * 横幅 + 「重试」按钮。
   *
   * 判定：目标节点仍是 `pending`（乐观置 running 没发生，如 RUN_ALL 的后续
   * 节点），或仍是 `running` 且本回合**从未收到过任何 progress**（A3.3 已把
   * 它置 running，activity hub 的滞留兜底会先把它置成通用的"未收到结果"
   * ——这里用可行动的原因覆盖）。agent 报过 progress（`run.progressed`）说明
   * 它真的动了手，那是普通滞留失败，不覆盖、不记 issue。
   *
   * 必须发生在 `undo.finishRun` 之前：对账产生的 patch 也是本次运行的一部分。
   */
  function reconcileAbandonedRun(project, run) {
    const viewName = normalizeView(run.view) ?? 'tasks'
    const nodes = store.get(project, viewName)?.graph?.nodes ?? []
    const byId = new Map(nodes.map((node) => [node.id, node]))
    let target
    if (run.action === 'RUN_NODE') {
      target = byId.get(run.nodeId)
    } else {
      for (const id of Array.isArray(run.order) ? run.order : []) {
        const node = byId.get(id)
        if (node !== undefined && node.status === 'pending') {
          target = node
          break
        }
      }
    }
    if (target === undefined) return
    const untouched = target.status === 'pending'
      || (target.status === 'running' && run.progressed !== true)
    if (!untouched) return
    store.patchNode(project, target.id, {
      status: 'failed',
      result: 'agent 未执行该节点',
      detail: '回合结束但节点没有任何进度；可能会话未加载画布技能或模型跳过了执行。可点「重试」重发本次运行。',
    }, { view: viewName })
    activity.noteIssue?.(project, {
      at: Date.now(),
      nodeId: target.id,
      text: `节点「${target.title || target.id}」未被执行：回合结束但没有任何进度。可能会话未加载画布技能，或模型跳过了执行；点「重试」重发本次运行。`,
      retry: true,
    })
    logger?.warn?.(`codeflow: run of ${project} ended without executing node ${target.id}; marked failed (retryable)`)
  }

  /** 运行期间任何真实 progress 都标记"agent 真的动手了"——这类运行保留通用的
   * 滞留失败，永远不产生重试 issue。 */
  const noteProgressBase = activity.noteProgress
  activity.noteProgress = (project, patch) => {
    const run = currentRuns.get(project)
    if (run !== undefined) run.progressed = true
    return noteProgressBase(project, patch)
  }

  /* ------------------------------------------- 活动中心的生命周期钩子 --- */

  activity.options.onTurnEnd = (project) => {
    const run = currentRuns.get(project)
    if (run !== undefined) {
      try {
        reconcileAbandonedRun(project, run)
      } catch (error) {
        logger?.warn?.(`codeflow: run reconciliation failed: ${String(error)}`)
      }
      undo.finishRun(project, run.runId).catch((error) => logger?.warn?.(`codeflow: finishRun failed: ${String(error)}`))
      currentRuns.delete(project)
    }
  }
  activity.options.onPresented = (project, files) => {
    // 确认交付：把 `present` 真正提交的路径合并回本次运行正在处理的 deliver
    // 节点（或最近完成的那个）。先查运行的视图，再查另一个——交付物永远
    // 属于运行中的会话被指向的那张图。
    const runView = activity.currentViewOf !== undefined ? activity.currentViewOf(project) : 'tasks'
    const candidates = [runView, ...VIEW_KEYS.filter((viewName) => viewName !== runView)]
    for (const viewName of candidates) {
      const graph = store.get(project, viewName)?.graph
      const deliverNode = graph?.nodes?.find((node) => node.type === 'deliver' && node.status === 'running')
        ?? graph?.nodes?.find((node) => node.type === 'deliver' && node.status === 'done')
      if (deliverNode === undefined) continue
      const merged = [...(deliverNode.presented ?? []), ...files]
      store.patchNode(project, deliverNode.id, { presented: merged }, { view: viewName })
      return
    }
  }
  // 以插件 fiber 订阅，监听器随插件一起消亡。
  activity.attach(ctx)

  /* ------------------------------------------------------- 工具注册 --- */

  registerTool(ctx, store, {
    activity,
    sessions,
  })
  // v1.1：codeflow_features — 功能分组索引的零成本查询/写入通道（不触碰图与 rev）。
  registerFeaturesTool(ctx, store, { logger })

  /* ------------------------------------------------------- HTTP 装配 --- */

  // 画布面板需要一个 HTTP 载体。保持可选意味着插件的其余部分（技能、命令、
  // 工具）在无界面的会话里照常工作。
  ctx.inject(['webServer'], (webCtx) => {
    // 委托给载体自己的浏览器门禁：这条路由能向会话注入提示词，所以必须与
    // 其余 GUI 一样受保护（签名的、绑定权限的 cookie；同源 iframe 免费携带）。
    // 服务按请求查找，因为 `webServer` 可能先于 `connection` 可用。
    let warned = false
    const fence = (req) => {
      const connection = ctx.get('connection')
      if (typeof connection?.requestRejection !== 'function') {
        if (!warned) {
          warned = true
          logger.warn?.('codeflow: connection.requestRejection is unavailable; the canvas routes fall back to loopback + same-origin checks only')
        }
        return undefined
      }
      return connection.requestRejection(req)
    }
    const deliver = createGestureDispatcher({ ctx, store, sessions, activity, undo, currentRuns })
    // v1.3.0（需求四）：日志读取与「打开所在目录」。文件路径绑定 fileLogger.path
    // 后**整体注入**——路由与请求都无法传任意路径。
    const logFilePath = fileLogger?.path ?? null
    const revealPath = createReveal({ hostShell: hostShellOf(ctx), spawn, allowedFile: logFilePath ?? undefined })
    const handler = createRouter({
      store,
      logger,
      fence,
      readLogTail: (options) => readLogTail({
        ...(options ?? {}),
        file: logFilePath,
        ...(logFilePath ? { rotatedPath: `${logFilePath}.1` } : {}),
      }),
      revealPath,
      submit: (gesture) => deliver(gesture),
      resolveCwd: (project) => resolveWorkspaceOf(project),
      // v1.2.1（B4）：同上，但带解析来源（binding / project-dir / session），
      // /api/config 的 `workspaceSource` 字段由此而来。
      resolveCwdEx: (project) => sessions.workspaceOfEx(project),
      // v1.2.1（A1）：只读工作区清单。数据与校验都收敛在 workspace-binding
      // （全插件唯一读 `workspaceRegistry` 的地方）；这里只做装配。
      listWorkspaces: (projectName) => collectWorkspaces({ ctx, store, projectName }),
      // v1.2.1（A2）：NEW 的工作区硬校验（在产生任何副作用之前）。
      validateWorkspace: (raw) => validateWorkspaceChoice(ctx, raw),
      // v1.2.1（C2）：只读目录浏览（lib/browse.js，纯函数 + fs 适配）。
      browseDirectory: (raw) => browseDirectoryPath(raw),
      // v1.1：「让 agent 识别」把 [CodeFlow:FEATURES] 投递到项目专用会话。
      deliverText: (project, text) => sessions.deliverText(project, text),
      // v1.0（需求 C）：旧 flow-projects/ 的自动迁移。幂等、只搬一次，
      // 失败保留旧目录；routes 在 boot / 列项目 / 新建 / 导入前触发它。
      migrateWorkspace: (workspace) => migrateLegacy(workspace),
      ensureSession: (project, options) => sessions.ensure(project, options),
      rebindSession: (project) => sessions.rebind(project),
      sessionInfo: (project) => ({
        sessionId: sessions.current(project) ?? store.get(project)?.sessionId ?? null,
        sessionTitle: store.get(project)?.sessionTitle ?? null,
        sessionNew: store.get(project)?.sessionNew === true,
        sessionWarning: store.get(project)?.sessionWarning ?? null,
      }),
      activityRead: (project, query) => activity.activity(project, query),
      undoList: (project) => undo.listRuns(project),
      undoRestore: (project, runId, options) => undo.restore(project, runId, options),
      undoDryRun: (project, runId) => undo.dryRun(project, runId),
      repairSession: undefined,
    })
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'codeflow-canvas: http surface',
    )
    // v1.2：拖拽导入暂存区的 30 分钟清扫定时器随插件 dispose 一起停止。
    webCtx.effect(
      () => () => {
        try {
          handler.dispose?.()
        } catch (error) {
          logger?.warn?.(`codeflow: drop staging dispose failed: ${String(error)}`)
        }
      },
      'codeflow-canvas: dispose drop-import staging sweepers',
    )
  })

  /** HTTP 层用的工作区解析，永不抛错。 */
  async function resolveWorkspaceOf(project) {
    try {
      return await sessions.workspaceOf(project)
    } catch {
      return undefined
    }
  }
}
