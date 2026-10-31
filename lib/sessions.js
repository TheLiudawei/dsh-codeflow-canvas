/**
 * The canvas-session manager: one dedicated, durably bound DSH session per
 * project.
 *
 * Before v0.5.0 a canvas gesture went to whichever agent happened to be the
 * single live root (or the last session that rendered a graph), which made the
 * canvas share a conversation with unrelated work. This module is now the only
 * writer of the binding (`store.bindSession`), and the only path a canvas
 * gesture takes to a session:
 *
 *   1. the in-memory store binding wins;
 *   2. otherwise the project sidecar `session.json` (inside the project's
 *      durable directory, resolved through `lib/paths.js`) is adopted — a cold
 *      session is a valid binding, because `sessionController.prompt` resumes it;
 *   3. otherwise, when `create` is requested, a new session is made with the
 *      *workspace root* as `cwd`, renamed, and recorded on both sides.
 *
 * Creation never switches DSH's current conversation, never guesses a fallback
 * session, and is de-duplicated per project with an in-flight Promise so
 * concurrent panel opens create exactly one session.
 *
 * The sidecar lives next to `workflow.json` but never joins its `rev`: agents
 * overwrite the whole graph file, so durable non-graph state must not be
 * stored inside it.
 *
 * Verified against DSH 0.2.1-rc.5 (`@deepseek-ai/dsh-api-session-controller`):
 *
 *   controller.create({ cwd })             -> { sessionId, agentPreset? }
 *   controller.rename({ sessionId, title }) -> { title, seq }   (needs the
 *                                            `sessionTitle` Host service)
 *   controller.prompt({ requestId, sessionId, mode: 'queue', content }, signal)
 *                                          -> { accepted: true }
 *
 * `prompt` resumes cold sessions and deduplicates by `requestId`. Failures are
 * `RemoteError`s — discriminate by the string `code` (`isDSHRemoteError` is a
 * structural marker, never instanceof): `session/not-found` triggers one
 * rebuild-and-retry here, `session/writer-held` is surfaced verbatim because
 * stealing the writer is never correct.
 *
 * @module dsh-codeflow-canvas/sessions
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { projectDir } from './paths.js'
import { projectDirOf, projectKeyOf, safeProjectName } from './store.js'
import { textContent } from './message.js'
import { directoryErrorText, ensureAgentDirectory, findDirectory, isDirectory, resolveWorkspaceDirectory } from './workspace.js'

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
 * Absolute sidecar path for a project. v1.0: the project lives under the
 * configurable root (`lib/paths.js`); when the caller has not resolved the
 * directory yet, this falls back to the default-root spelling. The async
 * callers (`readSidecar`/`writeSidecar`) always pass the resolved `dir`.
 */
export function sessionSidecarPath(cwd, project, dir) {
  // Same directory the store persists this project's workflow.json into — the
  // sidecar must follow the project, not a parallel spelling of its name.
  return path.join(
    typeof dir === 'string' && dir.length > 0
      ? dir
      : path.join(cwd, 'CodeFlow', 'flow-projects', projectDirOf(projectKeyOf(project))),
    'session.json',
  )
}

/**
 * Extract a RemoteError-style failure code without importing DSH internals:
 * every cross-wire failure carries a stable string `code`.
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
    // Older runtimes: call the service without a timeout instead.
  }
  return undefined
}

/**
 * Read one sidecar file, returning `undefined` for anything that is not a
 * current-version record: missing, corrupt, wrong version, or shape-invalid.
 * The project's durable directory is resolved through `lib/paths.js` so the
 * sidecar follows a configurable root / per-project override.
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
 * Atomically write one sidecar: `mkdir -p`, then temp file + rename, so a
 * crash mid-write leaves either the old or the new record, never a half file.
 * The project's durable directory is resolved through `lib/paths.js`.
 */
async function writeSidecar(cwd, project, record) {
  let dir
  try {
    dir = await projectDir(cwd, project)
  } catch {
    dir = undefined
  }
  const file = sessionSidecarPath(cwd, project, dir)
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  const body = JSON.stringify(record, null, 2)
  await writeFile(temp, body, 'utf8')
  try {
    await rename(temp, file)
  } catch {
    // Some filesystems refuse cross-handle renames; a direct write is still
    // far better than failing the binding over a metadata optimization.
    try {
      await writeFile(file, body, 'utf8')
    } finally {
      await rmQuiet(temp)
    }
  }
}

/** Delete a temp file without letting cleanup mask the real error. */
async function rmQuiet(file) {
  const { rm } = await import('node:fs/promises')
  try {
    await rm(file, { force: true })
  } catch {
    // Best effort: a leftover .tmp next to session.json is harmless.
  }
}

/** Read an optional Cordis service without depending on one context shape. */
function serviceOf(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== undefined) return viaGet
  } catch {
    // Fall through to the property form.
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * Create the canvas-session manager.
 *
 * @param options.ctx - plugin context (for `sessionController` and workspace
 *   resolution).
 * @param options.store - the canvas store; the only place bindings live.
 * @param options.logger - Cordis logger.
 * @returns the manager used by the routes, the tool and `deliver()`.
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
   * Resolve the workspace a project belongs to, then validate it as a real
   * directory. Returns `undefined` when nothing usable exists.
   */
  async function workspaceOf(project) {
    const workspace = await resolveWorkspaceDirectory(ctx, store, project)
    if (typeof workspace === 'string' && await isDirectory(workspace)) return workspace
    return undefined
  }

  /**
   * Adopt a binding into memory + store without touching the sidecar.
   * The project's durable directory is resolved here too (v1.0), so the store
   * reads/writes the same place the sidecar lives.
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
   * Create one fresh canvas session for a project and persist the binding.
   * Caller must have de-duplicated; this is the single creation path.
   */
  async function createAndBind(project, workspace) {
    const controller = controllerOf()
    if (controller === undefined || typeof controller.create !== 'function') {
      throw new Error(controllerMissing())
    }
    if (workspace === undefined) {
      throw new Error('还没有可用的 DSH 工作区，无法为项目创建专用会话：请先在 DSH 里打开一个项目或工作区。')
    }
    let created
    try {
      created = await controller.create({ cwd: workspace })
    } catch (error) {
      throw new Error(`创建画布专用会话失败：${String(error?.message ?? error)}`)
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('创建画布专用会话失败：宿主没有返回 sessionId')
    }
    await adopt(project, workspace, sessionId, { isNew: true, title: canvasSessionTitle(project) })
    // Title is display-only; a missing sessionTitle service must not fail the binding.
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
   * Resolve the project's canvas session, creating one when allowed.
   *
   * Never throws: failures come back as `{ error }` with an actionable
   * message, so a route can degrade to a warning instead of a dead canvas.
   *
   * @param project - project key.
   * @param options.create - create a session when none is bound (default true;
   *   callers that must not mutate state pass `false`).
   * @returns `{ sessionId, created, workspace }`, or `{ error }`.
   */
  function ensure(project, options = {}) {
    const create = options.create !== false
    return once(project, async () => {
      try {
        const workspace = await workspaceOf(project)
        const current = store.get(project)
        if (typeof current.sessionId === 'string' && current.sessionId.length > 0) {
          return { sessionId: current.sessionId, created: false, workspace }
        }
        if (workspace !== undefined) {
          const sidecar = await readSidecar(workspace, project)
          if (sidecar !== undefined && typeof sidecar.sessionId === 'string') {
            // Cold adoption: `prompt` resumes it, so no liveness check here.
            await adopt(project, workspace, sidecar.sessionId, { title: sidecar.title })
            return { sessionId: sidecar.sessionId, created: false, workspace }
          }
        }
        if (!create) return { error: '画布还没有绑定专用会话。', workspace }
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
        // The earlier attempt failing must not block the explicit rebind.
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
   * Deliver one `[CodeFlow:*]` prompt to the project's canvas session.
   *
   * Prefers `sessionController.prompt` (resumes cold sessions, dedupes by
   * `requestId`). A `session/not-found` failure rebuilds the session once and
   * retries once; `session/writer-held` is never fought over. When the
   * controller is absent the plugin has no correct fallback — the old
   * "single live root" guess is exactly what this module removed.
   *
   * @param project - project key.
   * @param prompt - full prompt text (the `[CodeFlow:*]` line).
   * @param options.signal - caller cancellation for the enqueue.
   * @returns the session id the prompt was queued into.
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
        // The bound session is gone (deleted/archived): rebuild once, update
        // the sidecar, and retry once. Retrying twice would mask real errors.
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
   * Validate (and when possible repair) the working directory the canvas
   * session will run in.
   *
   * A live agent goes through the host's own recovery path
   * (`ensureAgentDirectory`); a cold session has no agent to repair, so the
   * workspace itself is checked with `findDirectory` — cold sessions resume
   * fine as long as the directory exists.
   *
   * @returns `{ ok, cwd, warning? }`.
   */
  async function ensureWorkspaceFor(project, sessionId) {
    const workspace = await workspaceOf(project)
    if (workspace === undefined) {
      return { ok: false, cwd: undefined, warning: '未找到可用的 DSH 工作区：图谱不会落盘，agent 无法读到项目文件。' }
    }
    const agents = serviceOf(ctx, 'agents')
    let agent
    try {
      agent = agents?.get?.(sessionId)
    } catch {
      agent = undefined
    }
    if (agent === undefined) {
      // Cold session: no live agent object exists, and that is fine — `prompt`
      // resumes it. Only the directory must be real.
      const found = await findDirectory(workspace)
      if (found === undefined) {
        return { ok: false, cwd: workspace, warning: `会话工作目录不可用：${workspace}。请在 DSH 里重新打开该目录后重试。` }
      }
      return { ok: true, cwd: found }
    }
    const repair = await ensureAgentDirectory(ctx, agent)
    if (repair.available === false) {
      return { ok: false, cwd: repair.cwd ?? workspace, warning: `无法启动 agent：${directoryErrorText(repair)}` }
    }
    return { ok: true, cwd: repair.cwd ?? workspace }
  }

  return { ensure, rebind, current, forget, deliverText, ensureWorkspaceFor, workspaceOf }
}
