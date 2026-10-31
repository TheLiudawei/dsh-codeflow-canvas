/**
 * Cross-platform path and workspace helpers.
 *
 * Two problems on macOS motivated this module, and both are path-shaped:
 *
 *   1. DSH's composer turns a picked file into an `@`-mention. A command such
 *      as `/flow-import @/Users/me/项目/app` therefore arrives with the `@`
 *      still attached; joined to the workspace it becomes
 *      `<workspace>/@/Users/me/项目/app`, which of course does not exist.
 *      `cleanPathInput` strips the mention marker, quotes, `file://` URLs and
 *      expands `~` before anything touches the filesystem.
 *
 *   2. DSH's session working directory can stop resolving while the directory
 *      is still present (mixed-script paths, stale canonical spelling). Every
 *      agent turn then fails inside prompt assembly with
 *      `working-directory: directory does not exist`. `ensureAgentDirectory`
 *      asks DSH's own working-directory service to validate/normalize the
 *      path, and, when both the current and original directories fail, walks
 *      to a parent or a registered workspace and commits that instead.
 *
 * Nothing here depends on a particular DSH version: every host service is an
 * optional capability and the plugin keeps working without it.
 *
 * @module dsh-codeflow-canvas/workspace
 */
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** How far up the tree to look for a directory DSH's fs provider accepts. */
const MAX_ANCESTOR_STEPS = 8

/** Strip one or two matching outer quotes (the composer may wrap a path). */
function unquote(value) {
  let text = value
  for (let pass = 0; pass < 2; pass += 1) {
    if (text.length < 2) break
    const first = text[0]
    if ((first !== '"' && first !== "'" && first !== '`') || text[text.length - 1] !== first) break
    text = text.slice(1, -1).trim()
  }
  return text
}

/**
 * Turn arbitrary user input into a filesystem path.
 *
 * Accepts the shapes DSH and a terminal put on the clipboard:
 * `@/abs/path`, `"~/My Project"`, `file:///Users/me/x`, `./server`.
 * Relative paths are resolved against `options.cwd` when one is supplied;
 * otherwise they are returned as-is for the caller to resolve.
 *
 * @param input - raw text from a command, dialog or mention.
 * @param options.cwd - workspace used for relative paths.
 * @param options.home - home directory override (tests).
 * @returns a normalized path, or `''` when the input is empty.
 */
export function cleanPathInput(input, options = {}) {
  let value = String(input ?? '').trim()
  if (value.length === 0) return ''

  // DSH's composer prefixes picked paths with `@`; a doubled marker sometimes
  // survives a paste. They are syntax, never part of a path. Quotes can wrap
  // either the marker or the path (`"@/x"`, `@"/x"`), so peel both repeatedly.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = value
    value = unquote(value).trim()
    while (value.startsWith('@')) value = value.slice(1).trim()
    if (value === before) break
  }

  if (/^file:\/\//i.test(value)) {
    try {
      value = fileURLToPath(value)
    } catch {
      // Leave a malformed file URL untouched so the error names what was typed.
    }
  }

  const home = typeof options.home === 'string' && options.home.length > 0 ? options.home : homedir()
  if (value === '~') value = home
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(home, value.slice(2))
  if (value.length === 0) return ''

  const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : undefined
  if (!path.isAbsolute(value) && cwd !== undefined) value = path.resolve(cwd, value)
  return path.normalize(value)
}

/**
 * Whether a path currently exists and is a directory. Never throws.
 * @param target - absolute or relative path.
 */
export async function isDirectory(target) {
  if (typeof target !== 'string' || target.length === 0) return false
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** `realpath` when possible, otherwise the input unchanged. */
async function realpathOr(target) {
  try {
    return await realpath(target)
  } catch {
    return target
  }
}

/**
 * Resolve a path that differs from disk only by Unicode normalization or case.
 *
 * macOS is usually case-insensitive and normalizes names; a path typed on one
 * machine or copied out of another tool can still differ. This walks the
 * directory tree component by component and prefers an exact match, then an
 * NFC-equal match, then a case-insensitive one.
 *
 * @returns the canonical directory, or `undefined` when no component matches.
 */
async function resolveCaseInsensitive(target) {
  const root = path.parse(target).root
  if (root.length === 0) return undefined
  const segments = target.slice(root.length).split(path.sep).filter((segment) => segment.length > 0)
  let current = root
  for (const segment of segments) {
    let entries
    try {
      entries = await readdir(current)
    } catch {
      return undefined
    }
    const wanted = segment.normalize('NFC')
    const match = entries.find((entry) => entry === segment)
      ?? entries.find((entry) => entry.normalize('NFC') === wanted)
      ?? entries.find((entry) => entry.toLowerCase() === segment.toLowerCase())
    if (match === undefined) return undefined
    current = path.join(current, match)
  }
  return (await isDirectory(current)) ? await realpathOr(current) : undefined
}

/**
 * Find an existing directory for a user-supplied path.
 *
 * Tries the path as typed, its NFC/NFD variants, and (on macOS) a
 * case-insensitive component walk. Returns the canonical path so callers can
 * quote it to the agent.
 *
 * @param target - path to resolve.
 * @returns the canonical directory, or `undefined`.
 */
export async function findDirectory(target) {
  if (typeof target !== 'string' || target.length === 0) return undefined
  const candidates = []
  const remember = (value) => {
    if (typeof value === 'string' && value.length > 0 && !candidates.includes(value)) candidates.push(value)
  }
  remember(target)
  try {
    remember(target.normalize('NFC'))
    remember(target.normalize('NFD'))
  } catch {
    // Lone surrogates cannot be normalized; the literal candidate still works.
  }
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return await realpathOr(candidate)
  }
  if (process.platform === 'darwin') return await resolveCaseInsensitive(target)
  return undefined
}

/**
 * Resolve an import target without hiding the reason it failed.
 *
 * @param input - user path, possibly an `@` mention or `~` path.
 * @param cwd - workspace for relative paths.
 * @returns a canonical absolute directory.
 * @throws when the path is missing, a file, or unreadable.
 */
export async function resolveProjectRoot(input, cwd) {
  const cleaned = cleanPathInput(input, { cwd })
  if (cleaned.length === 0) throw new Error('未提供项目路径')
  const absolute = path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd ?? process.cwd(), cleaned)
  // Keep the caller's spelling when it already works: on macOS `realpath`
  // rewrites `/var/...` to `/private/var/...`, and a symlinked project should
  // stay addressable by the name the user chose.
  if (await isDirectory(absolute)) return absolute
  const found = await findDirectory(absolute)
  if (found !== undefined) return found
  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new Error(`目录不存在：${absolute}`)
    throw new Error(`无法访问：${absolute}（${error?.code ?? error?.message ?? error}）`)
  }
  if (!info.isDirectory()) throw new Error(`不是目录：${absolute}`)
  return absolute
}

/**
 * Read an optional Cordis service without depending on one context shape.
 * @param ctx - plugin context.
 * @param name - service name.
 */
export function serviceOf(ctx, name) {
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

/** Root agents, if the host exposes them. */
function agentsOf(ctx) {
  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined) return []
  try {
    const roots = typeof agents.roots === 'function' ? agents.roots() : undefined
    return Array.isArray(roots) ? roots : []
  } catch {
    return []
  }
}

/** The directory recorded in a session header, when present. */
function headerCwd(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
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
 * Pick a durable directory for this project.
 *
 * Preference order is: the project's already-bound workspace, a live session's
 * header directory, then a directory registered with DSH's workspace
 * registry. Every candidate is checked against the native filesystem first;
 * the caller may still repair it through DSH's fs provider.
 *
 * @param ctx - plugin context.
 * @param store - canvas store.
 * @param project - project key, when the caller has one.
 * @returns an absolute existing directory, or `undefined`.
 */
export async function resolveWorkspaceDirectory(ctx, store, project) {
  if (store !== undefined && typeof store.get === 'function') {
    const state = store.get(project)
    if (typeof state?.cwd === 'string' && await isDirectory(state.cwd)) return state.cwd
  }

  const workingDirectory = serviceOf(ctx, 'workingDirectory')
  for (const agent of agentsOf(ctx)) {
    // The effective directory can differ from the immutable header after a
    // repair; the projection is the one later turns actually use.
    if (workingDirectory !== undefined && typeof workingDirectory.get === 'function') {
      try {
        const effective = workingDirectory.get(agent.session)
        if (typeof effective === 'string' && effective.length > 0 && await isDirectory(effective)) return effective
      } catch {
        // Fall back to the header.
      }
    }
    const cwd = headerCwd(agent)
    if (cwd !== undefined && await isDirectory(cwd)) return cwd
  }

  const registry = serviceOf(ctx, 'workspaceRegistry')
  if (registry !== undefined && typeof registry.list === 'function') {
    let workspaces = []
    try {
      workspaces = registry.list()
    } catch {
      workspaces = []
    }
    for (const workspace of workspaces) {
      const cwd = workspace?.path
      if (typeof cwd === 'string' && await isDirectory(cwd)) return cwd
    }
  }

  return undefined
}

/**
 * Make a live session's working directory usable again.
 *
 * `ctx.workingDirectory.ensure` is the host's own recovery path: it validates
 * the current directory and restores the original project when that one is
 * available. When both are unavailable it throws the exact
 * `working-directory: directory does not exist: "…"` error that aborts every
 * model turn. This helper then tries, in order:
 *
 *   1. the native canonical spelling of the current/original directory;
 *   2. each parent of those directories (the project stays reachable);
 *   3. every directory registered with DSH's workspace registry;
 *   4. the service's default launch directory and the user's home;
 *   5. creating a genuinely missing session directory whose parent exists.
 *
 * The first candidate `workingDirectory.set` accepts is committed and
 * reported as `repaired: true`.
 *
 * @param ctx - plugin context.
 * @param agent - the live agent whose session should be repaired.
 * @param options.signal - optional cancellation.
 * @param options.timeoutMs - bound on each host filesystem call.
 * @returns `{ cwd, previous, repaired, available, error? }`.
 */
export async function ensureAgentDirectory(ctx, agent, options = {}) {
  const session = agent?.session
  const original = headerCwd(agent)
  const workingDirectory = serviceOf(ctx, 'workingDirectory')

  // No host service to consult: leave the decision to DSH. Marking this
  // unchecked (rather than unavailable) keeps older compositions working.
  if (session === undefined || workingDirectory === undefined || typeof workingDirectory.ensure !== 'function') {
    return { cwd: original, previous: original, repaired: false, available: true, unchecked: true }
  }

  let previous = original
  if (typeof workingDirectory.get === 'function') {
    try {
      const recorded = workingDirectory.get(session)
      if (typeof recorded === 'string' && recorded.length > 0) previous = recorded
    } catch {
      // The projection may not be registered yet; the header is the fallback.
    }
  }
  const signalFor = () => options.signal ?? timeoutSignal(options.timeoutMs ?? 8000)

  try {
    const cwd = await workingDirectory.ensure(agent, signalFor())
    return {
      cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : previous,
      previous,
      repaired: cwd !== previous,
      available: true,
    }
  } catch (error) {
    const candidates = []
    const seen = new Set()
    const remember = (value) => {
      if (typeof value !== 'string' || value.length === 0) return
      const normalized = path.normalize(value)
      if (seen.has(normalized)) return
      seen.add(normalized)
      candidates.push(normalized)
    }

    // A native realpath can reconcile a spelling the host's fs provider could
    // not, and costs nothing when the path is absent.
    remember(await findDirectory(previous))
    remember(await findDirectory(original))
    for (const base of [previous, original]) {
      if (typeof base !== 'string' || base.length === 0) continue
      let dir = path.dirname(base)
      const root = path.parse(dir).root
      for (let step = 0; step < MAX_ANCESTOR_STEPS && dir !== root && dir !== path.dirname(dir); step += 1) {
        remember(await findDirectory(dir))
        dir = path.dirname(dir)
      }
    }

    const registry = serviceOf(ctx, 'workspaceRegistry')
    if (registry !== undefined && typeof registry.list === 'function') {
      try {
        for (const workspace of registry.list()) remember(await findDirectory(workspace?.path))
      } catch {
        // A registry that is still starting must not block the repair.
      }
    }

    remember(await findDirectory(workingDirectory.defaultDirectory))
    remember(await findDirectory(homedir()))

    // A deleted project root is the one missing directory it is safe to
    // recreate: only when its parent still exists, and only for the session's
    // own recorded directories.
    for (const base of [previous, original]) {
      if (typeof base !== 'string' || base.length === 0) continue
      if (await isDirectory(base)) continue
      if (!(await isDirectory(path.dirname(base)))) continue
      try {
        await mkdir(base, { recursive: true })
        remember(base)
      } catch {
        // Permission denied: another candidate may still work.
      }
    }

    for (const candidate of candidates) {
      try {
        const cwd = await workingDirectory.set(agent, candidate, signalFor())
        const repaired = cwd !== previous
        return {
          cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : candidate,
          previous,
          repaired,
          available: true,
          ...(repaired ? { error } : {}),
        }
      } catch {
        // Try the next candidate.
      }
    }

    // The agent can be cold (so `ensure`/`set` reject on lifetime checks)
    // while the directory itself is fine; let the caller queue a turn and
    // resume it. A genuinely missing directory is reported as unavailable.
    const native = await isDirectory(previous) || await isDirectory(original)
    return { cwd: previous, previous, repaired: false, available: native, error }
  }
}

/**
 * Human-facing explanation for a directory that could not be repaired.
 * @param result - the return value of {@link ensureAgentDirectory}.
 */
export function directoryErrorText(result) {
  const previous = result?.previous ?? result?.cwd ?? '（未知）'
  const detail = result?.error?.message !== undefined ? `（${result.error.message}）` : ''
  return `会话工作目录不可用：${previous}${detail}。DSH 无法启动 agent 回合；`
    + '请把 DSH 工作区改到一个存在的目录（建议纯英文路径），或重启 DSH 后重试。'
}
