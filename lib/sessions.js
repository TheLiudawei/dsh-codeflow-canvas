/**
 * 画布会话管理器：每个项目一条专用的、持久绑定的 DSH 会话。
 *
 * v0.5.0 之前，画布手势被送给"碰巧是唯一活跃根的 agent"（或最近渲染过图的
 * 会话），画布因此和无关工作共享同一个会话。本模块现在是绑定的唯一写者
 * （`store.bindSession`），也是画布手势到达会话的唯一路径：
 *
 *   1. 内存里 store 的绑定优先；
 *   2. 否则采纳项目侧车 `session.json`（在项目的持久目录里，经
 *      `lib/paths.js` 解析）——冷会话也是有效绑定，因为
 *      `sessionController.prompt` 会恢复它；
 *   3. 否则，在被要求 `create` 时，以**工作区根**为 `cwd` 新建会话、改名、
 *      双侧登记。工作区本身由 `lib/workspace-binding.js` 的 B1 链解析
 *      （v1.2.1）；宿主支持 `create({ workspaceId })` 时优先用它，会话因此
 *      真正归属所选工作区（GUI 里不再落进「未分组」）。
 *
 * 创建绝不切换 DSH 的当前会话、绝不猜一个兜底会话，并且用在途 Promise 按
 * 项目去重——并发打开面板恰好只创建一条会话。
 *
 * 侧车与 `workflow.json` 同目录，但绝不参与它的 `rev`：agent 会整文件覆盖
 * 图文件，持久化的非图状态不能存在它里面。
 *
 * 已对照 DSH 0.2.1-rc.5 验证（`@deepseek-ai/dsh-api-session-controller`）：
 *
 *   controller.create({ cwd })             -> { sessionId, agentPreset? }
 *   controller.rename({ sessionId, title }) -> { title, seq }   （需要
 *                                            `sessionTitle` 宿主服务）
 *   controller.prompt({ requestId, sessionId, mode: 'queue', content }, signal)
 *                                          -> { accepted: true }
 *
 * `prompt` 会恢复冷会话并按 `requestId` 去重。失败是 RemoteError——按字符串
 * `code` 判别（`isDSHRemoteError` 是结构标记，绝非 instanceof）：
 * `session/not-found` 触发一次重建加重试；`session/writer-held` 原样上报，
 * 因为抢夺写者从来都不正确。
 *
 * @module dsh-codeflow-canvas/sessions
 */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { atomicWriteFile } from './core/fsio.js'
import { DEFAULT_DIR_NAME, FLOW_PROJECTS_DIR, projectDirOf, projectKeyOf, safeProjectName } from './core/path.js'
import { projectDir } from './paths.js'
import { textContent } from './message.js'
import {
  registeredDirectoriesOf,
  registeredEntityForPath,
  resolveProjectWorkspace,
} from './workspace-binding.js'
import {
  directoryErrorText,
  ensureAgentDirectory,
  findDirectory,
  isDirectory,
  serviceOf,
} from './workspace.js'

/** Sidecar schema version; a mismatch means "unreadable" and re-creates. */
const SIDECAR_VERSION = 1

/** How long a prompt enqueue may take before the canvas gets its error. */
const PROMPT_TIMEOUT_MS = 20_000

/** Display title for a project's canvas session. */
export function canvasSessionTitle(project) {
  const text = `CodeFlow · ${safeProjectName(project)}`
  return text.length > 60 ? text.slice(0, 60) : text
}

/**
 * 项目侧车的绝对路径。v1.0：项目位于可配置根之下（`lib/paths.js`）；调用方
 * 还没解析目录时回退默认根拼写。异步调用方（`readSidecar`/`writeSidecar`）
 * 总是传入已解析的 `dir`。
 */
export function sessionSidecarPath(cwd, project, dir) {
  // 与 store 持久化该项目 workflow.json 的目录一致——侧车必须跟随项目本身，
  // 而不是项目名的另一种拼写。目录常量统一取自 lib/core/path.js（命名契约）。
  return path.join(
    typeof dir === 'string' && dir.length > 0
      ? dir
      : path.join(cwd, DEFAULT_DIR_NAME, FLOW_PROJECTS_DIR, projectDirOf(projectKeyOf(project))),
    'session.json',
  )
}

/**
 * 提取 RemoteError 风格的失败码而不导入 DSH 内部：每个跨线失败都带一个
 * 稳定的字符串 `code`。
 */
function errorCodeOf(error) {
  const code = error?.code
  return typeof code === 'string' ? code : undefined
}

/** A timeout signal, or undefined on a runtime without `AbortSignal.timeout`. */
function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms)
    }
  } catch {
    // 旧运行时：改为不带超时调用服务。
  }
  return undefined
}

/**
 * 读一个侧车文件；凡不是当前版本记录的——缺失、损坏、版本不对、形状不对
 * ——一律返回 `undefined`。项目的持久目录经 `lib/paths.js` 解析，侧车因此
 * 跟随可配置根 / 单项目覆盖。
 */
async function readSidecar(cwd, project) {
  let dir
  try {
    dir = await projectDir(cwd, project)
  } catch {
    dir = undefined
  }
  let raw
  try {
    raw = await readFile(sessionSidecarPath(cwd, project, dir), 'utf8')
  } catch {
    return undefined
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.version !== SIDECAR_VERSION) return undefined
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return undefined
  return value
}

/**
 * 原子写一个侧车文件：`mkdir -p` 后经 `core/fsio.atomicWriteFile`
 * （临时文件 → rename），崩溃时留下的要么是旧记录要么是新记录，绝不是半个
 * 文件。项目的持久目录经 `lib/paths.js` 解析（跟随可配置根/单项目覆盖）。
 */
async function writeSidecar(cwd, project, record) {
  let dir
  try {
    dir = await projectDir(cwd, project)
  } catch {
    dir = undefined
  }
  const file = sessionSidecarPath(cwd, project, dir)
  await atomicWriteFile(file, JSON.stringify(record, null, 2))
}

/* `serviceOf`（宽容读取可选 Cordis 服务）统一取自 workspace.js——原来这里
 * 有一份逐字相同的私有副本，而 workspace.js 导出的那份反而无人使用。 */

/**
 * 创建画布会话管理器。
 *
 * @param options.ctx - 插件上下文（取 `sessionController` 与工作区解析）。
 * @param options.store - 画布 store；绑定的唯一居所。
 * @param options.logger - Cordis logger。
 * @returns 路由、工具与 deliver() 使用的管理器。
 */
export function createSessionManager({ ctx, store, logger }) {
  /** @type {Map<string, Promise<object>>} per-project creation in flight */
  const creating = new Map()

  function controllerOf() {
    try {
      return serviceOf(ctx, 'sessionController')
    } catch {
      return undefined
    }
  }

  function controllerMissing() {
    return '当前 DSH 组合没有提供 sessionController 服务：画布无法创建或寻址专用会话。' +
      '画布仍可编辑、导入和保存，但运行节点需要升级 DSH 或改用 /flow 在会话里执行。'
  }

  /**
   * 解析项目所属的工作区（v1.2.1 B1 链：binding → project-dir → session →
   * 硬失败），并校验它是真实目录。解析不出时返回带候选清单的可行动失败，
   * 绝不猜（旧的「注册表第一个工作区」回退已删除）。
   */
  async function workspaceOfEx(project) {
    const result = await resolveProjectWorkspace(ctx, store, project, { logger })
    if (result.workspace !== undefined && await isDirectory(result.workspace)) return result
    return { code: result.code ?? 'NO_WORKSPACE', candidates: result.candidates ?? [], message: result.message }
  }

  /** 解析项目所属的工作区，没有可用结果时返回 `undefined`（兼容面）。 */
  async function workspaceOf(project) {
    const resolved = await workspaceOfEx(project)
    return typeof resolved.workspace === 'string' ? resolved.workspace : undefined
  }

  /**
   * 把一个绑定收编进内存与 store，不触碰侧车。项目持久目录也在这里解析
   * （v1.0），store 读写的地方因此与侧车同处一处。
   */
  async function adopt(project, workspace, sessionId, { isNew = false, title } = {}) {
    store.bindSession(project, sessionId)
    if (workspace !== undefined) {
      let dir
      try {
        dir = await projectDir(workspace, project)
      } catch {
        dir = undefined
      }
      store.bindCwd(project, workspace, dir)
    }
    store.bindSessionInfo(project, {
      sessionId,
      isNew,
      title: title ?? canvasSessionTitle(project),
    })
    return sessionId
  }

  /**
   * 为项目新建一条画布会话并持久化绑定。调用方必须已去重；这是唯一的
   * 创建路径。
   *
   * v1.2.1（Issue #1）：宿主把会话归入工作区的机制是 `controller.create({
   * workspaceId })`——宿主内部在创建后 `workspace.attachSession(sessionId)`，
   * 会话因此出现在该工作区的分组里而不是「未分组」。已对照 DSH 0.2.x 宿主
   * 实现验证：`workspaceId` 与 `cwd` 互斥；`workspaceId` 命中时 cwd 取
   * `workspace.path`，且无名创建必定 mint 新会话（不复用用户现有会话）。
   * 宿主没有可枚举的工作区实体时，退回 `cwd` 创建（目录仍正确，只是归属
   * 分组取决于宿主的 cwd 归组逻辑）。
   */
  async function createAndBind(project, workspace) {
    const controller = controllerOf()
    if (controller === undefined || typeof controller.create !== 'function') {
      throw new Error(controllerMissing())
    }
    if (workspace === undefined) {
      throw new Error('还没有可用的 DSH 工作区，无法为项目创建专用会话：请先在 DSH 里新建一个项目（选定工作区）。')
    }
    const entity = await registeredEntityForPath(ctx, workspace)
    let created
    try {
      created = entity?.id !== undefined
        ? await controller.create({ workspaceId: entity.id })
        : await controller.create({ cwd: workspace })
    } catch (error) {
      throw new Error(`创建画布专用会话失败：${String(error?.message ?? error)}`)
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('创建画布专用会话失败：宿主没有返回 sessionId')
    }
    await adopt(project, workspace, sessionId, { isNew: true, title: canvasSessionTitle(project) })
    // 标题只影响展示；sessionTitle 服务缺失绝不能让绑定失败。
    try {
      if (typeof controller.rename === 'function') {
        await controller.rename({ sessionId, title: canvasSessionTitle(project) })
      }
    } catch (error) {
      logger?.warn?.(`codeflow: cannot rename canvas session ${sessionId}: ${String(error)}`)
    }
    try {
      await writeSidecar(workspace, project, {
        version: SIDECAR_VERSION,
        sessionId,
        title: canvasSessionTitle(project),
        workspace,
        createdAt: Date.now(),
      })
    } catch (error) {
      logger?.warn?.(`codeflow: cannot write session sidecar for ${project}: ${String(error)}`)
      store.bindSessionInfo(project, { warning: '专用会话已创建，但绑定文件写入失败：DSH 重启后可能需要重新绑定。' })
    }
    return { sessionId, created: true, workspace }
  }

  /** Run one job per project at a time; concurrent callers share the result. */
  async function once(project, jobFactory) {
    const inflight = creating.get(project)
    if (inflight !== undefined) return inflight
    const job = jobFactory()
    creating.set(project, job)
    try {
      return await job
    } finally {
      creating.delete(project)
    }
  }

  /**
   * 解析项目的画布会话，允许时新建。
   *
   * 绝不抛错：失败以 `{ error }` 返回并带可行动的消息，路由因此能降级为
   * 警告，而不是一块死画布。
   *
   * @param project - 项目键。
   * @param options.create - 没有绑定时新建会话（默认 true；不得改动状态的
   *   调用方传 `false`）。
   * @returns `{ sessionId, created, workspace }`，或 `{ error }`。
   */
  function ensure(project, options = {}) {
    const create = options.create !== false
    return once(project, async () => {
      try {
        const resolved = await workspaceOfEx(project)
        const workspace = typeof resolved.workspace === 'string' ? resolved.workspace : undefined
        const current = store.get(project)
        if (typeof current.sessionId === 'string' && current.sessionId.length > 0) {
          return { sessionId: current.sessionId, created: false, workspace }
        }
        if (workspace !== undefined) {
          const sidecar = await readSidecar(workspace, project)
          if (sidecar !== undefined && typeof sidecar.sessionId === 'string') {
            // 冷采纳：`prompt` 会恢复它，这里不做活性检查。
            await adopt(project, workspace, sidecar.sessionId, { title: sidecar.title })
            return { sessionId: sidecar.sessionId, created: false, workspace }
          }
        }
        if (!create) return { error: '画布还没有绑定专用会话。', workspace }
        if (workspace === undefined) {
          // B1 硬失败：解析不出工作区就报错（带候选清单），绝不猜一个落点。
          return { error: resolved.message ?? '未能确定项目所属的 DSH 工作区。' }
        }
        return await createAndBind(project, workspace)
      } catch (error) {
        logger?.warn?.(`codeflow: session ensure failed for ${project}: ${String(error)}`)
        return { error: String(error?.message ?? error) }
      }
    })
  }

  /**
   * Replace the binding with a brand-new session ("新建会话"): the old session
   * is left untouched in DSH's session list. Waits out an in-flight
   * ensure first so the two paths cannot interleave.
   */
  async function rebind(project) {
    const inflight = creating.get(project)
    if (inflight !== undefined) {
      try {
        await inflight
      } catch {
        // 更早一次尝试失败绝不能挡住显式的重绑。
      }
    }
    return once(project, async () => {
      try {
        const workspace = await workspaceOf(project)
        return { ...(await createAndBind(project, workspace)), created: true }
      } catch (error) {
        logger?.warn?.(`codeflow: session rebind failed for ${project}: ${String(error)}`)
        return { error: String(error?.message ?? error) }
      }
    })
  }

  /** The current binding without creating or adopting (panel display). */
  function current(project) {
    return store.get(project).sessionId
  }

  /** Forget the in-memory binding; the sidecar is left alone. */
  function forget(project) {
    store.forgetSession(project)
  }

  /**
   * 向项目的画布会话投递一条 `[CodeFlow:*]` 提示词。
   *
   * 优先走 `sessionController.prompt`（恢复冷会话、按 `requestId` 去重）。
   * `session/not-found` 失败重建会话一次并重试一次；`session/writer-held`
   * 绝不争夺。控制器缺席时插件没有正确的兜底——旧的"唯一活跃根"猜测正是
   * 本模块删除掉的东西。
   *
   * @param project - 项目键。
   * @param prompt - 完整提示词文本（`[CodeFlow:*]` 行）。
   * @param options.signal - 调用方的入队取消信号。
   * @returns 提示词被排入的会话 id。
   */
  async function deliverText(project, prompt, options = {}) {
    const text = String(prompt ?? '')
    if (text.trim().length === 0) throw new Error('refusing to deliver an empty canvas prompt')
    const bound = await ensure(project, { create: true })
    if (bound.error !== undefined) throw new Error(bound.error)
    const controller = controllerOf()
    if (controller === undefined || typeof controller.prompt !== 'function') {
      throw new Error(controllerMissing())
    }
    const deliverOnce = async (sessionId) => {
      const signal = options.signal ?? timeoutSignal(PROMPT_TIMEOUT_MS)
      await controller.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: textContent(text),
      }, signal)
      return sessionId
    }

    let sessionId = bound.sessionId
    try {
      return await deliverOnce(sessionId)
    } catch (error) {
      const code = errorCodeOf(error)
      if (code === 'session/not-found' || code === 'session/archived') {
        // 绑定的会话没了（被删/被归档）：重建一次、更新侧车、重试一次。
        // 重试两次会掩盖真实错误。
        logger?.warn?.(`codeflow: canvas session for ${project} is gone (${code}); rebuilding once`)
        const replacement = await rebind(project)
        sessionId = replacement.sessionId
        try {
          return await deliverOnce(sessionId)
        } catch (retryError) {
          if (errorCodeOf(retryError) === 'session/writer-held') {
            throw new Error('会话正被其他写入占用：请稍后重试，或在画布里新建会话。')
          }
          throw new Error(`会话已自动重建（${sessionId}），但投递仍失败：${String(retryError?.message ?? retryError)}`)
        }
      }
      if (code === 'session/writer-held') {
        throw new Error('会话正被其他写入占用：请稍后重试，或在画布里新建会话。')
      }
      throw new Error(`无法向专用会话投递：${String(error?.message ?? error)}`)
    }
  }

  /**
   * 校验（并尽量修复）画布会话将要运行在其中的工作目录。
   *
   * 活的 agent 走宿主自己的恢复路径（`ensureAgentDirectory`）；冷会话没有
   * agent 可修，所以直接用 `findDirectory` 检查工作区——只要目录存在，冷
   * 会话恢复起来毫无问题。
   *
   * @returns `{ ok, cwd, warning? }`。
   */
  async function ensureWorkspaceFor(project, sessionId) {
    const resolved = await workspaceOfEx(project)
    const workspace = typeof resolved.workspace === 'string' ? resolved.workspace : undefined
    if (workspace === undefined) {
      return {
        ok: false,
        cwd: undefined,
        warning: `${resolved.message ?? '未找到可用的 DSH 工作区：'}图谱不会落盘，agent 无法读到项目文件。`,
      }
    }
    const agents = serviceOf(ctx, 'agents')
    let agent
    try {
      agent = agents?.get?.(sessionId)
    } catch {
      agent = undefined
    }
    if (agent === undefined) {
      // 冷会话：不存在活的 agent 对象，这没关系——`prompt` 会恢复它。
      // 只有目录必须是真实的。
      const found = await findDirectory(workspace)
      if (found === undefined) {
        return { ok: false, cwd: workspace, warning: `会话工作目录不可用：${workspace}。请在 DSH 里重新打开该目录后重试。` }
      }
      return { ok: true, cwd: found }
    }
    // v1.2.1：注册表只由 workspace-binding 读取；修复候选经参数传入。
    const repair = await ensureAgentDirectory(ctx, agent, { registeredDirectories: registeredDirectoriesOf(ctx) })
    if (repair.available === false) {
      return { ok: false, cwd: repair.cwd ?? workspace, warning: `无法启动 agent：${directoryErrorText(repair)}` }
    }
    return { ok: true, cwd: repair.cwd ?? workspace }
  }

  return { ensure, rebind, current, forget, deliverText, ensureWorkspaceFor, workspaceOf, workspaceOfEx }
}
