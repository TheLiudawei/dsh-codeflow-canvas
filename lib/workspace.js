/**
 * 跨平台路径与工作区助手。
 *
 * 两个 macOS 现场问题催生了本模块，而且都是路径形状的：
 *
 *   1. DSH 的输入框把选中的文件变成 `@` 提及。`/flow-import
 *      @/Users/me/项目/app` 到达时 `@` 还挂在参数上；拼到工作区后面就成了
 *      `<工作区>/@/Users/me/项目/app`——当然不存在。`cleanPathInput` 在任何
 *      东西碰文件系统之前剥掉提及标记、引号、`file://` URL 并展开 `~`。
 *
 *   2. DSH 会话的工作目录可能停止解析而目录明明还在（混合脚本路径、过期的
 *      规范拼写）。之后每个 agent 回合都死在提示词组装的
 *      `working-directory: directory does not exist` 上。`ensureAgentDirectory`
 *      请 DSH 自己的 working-directory 服务校验/规整路径；当当前目录与原始
 *      目录都失败时，逐级走到父目录或已注册的工作区并提交过去。
 *
 * 这里没有任何东西依赖特定 DSH 版本：每个宿主服务都是可选能力，插件在
 * 缺失时照常工作。
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
 * 把任意用户输入变成一个文件系统路径。
 *
 * 接受 DSH 与终端放进剪贴板的各种形状：`@/abs/path`、`"~/My Project"`、
 * `file:///Users/me/x`、`./server`。相对路径在给了 `options.cwd` 时相对它
 * 解析；否则原样返回，交给调用方解析。
 *
 * @param input - 来自命令、对话框或提及的原始文本。
 * @param options.cwd - 相对路径使用的工作区。
 * @param options.home - 主目录覆盖（测试用）。
 * @returns 归一后的路径；输入为空时 `''`。
 */
export function cleanPathInput(input, options = {}) {
  let value = String(input ?? '').trim()
  if (value.length === 0) return ''

  // DSH 的输入框给选中的路径加 `@` 前缀；粘贴后有时会留下成对的标记。
  // 它们是语法，绝不是路径的一部分。引号可能包住标记（`"@/x"`）也可能包住
  // 路径（`@"/x"`），所以两种都要反复剥。
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
      // 畸形的 file URL 原样保留——错误信息才能如实指向用户输入的东西。
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
 * 路径当前是否存在且是目录。绝不抛错。
 * @param target - 绝对或相对路径。
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
 * 解析一个只差 Unicode 规范化形式或大小写的路径。
 *
 * macOS 通常大小写不敏感并对名字做规范化；但在一台机器上敲出、或从另一台
 * 工具复制出来的路径仍可能对不上。这里逐级走目录树：先精确匹配，其次
 * NFC 等价，再次大小写不敏感。
 *
 * @returns 规范目录；任何一级都对不上时 `undefined`。
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
 * 为用户输入的路径找一个真实存在的目录。
 *
 * 依次尝试：原样拼写、NFC/NFD 变体、（macOS 上）大小写不敏感的逐级匹配。
 * 返回规范路径，调用方才能放心地把它引用给 agent。
 *
 * @param target - 待解析路径。
 * @returns 规范目录，或 `undefined`。
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
    // 孤立代理对无法规范化；字面候选仍然可用。
  }
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return await realpathOr(candidate)
  }
  if (process.platform === 'darwin') return await resolveCaseInsensitive(target)
  return undefined
}

/**
 * 解析导入目标，并且不隐藏失败原因。
 *
 * @param input - 用户路径（可能是 `@` 提及或 `~` 路径）。
 * @param cwd - 相对路径使用的工作区。
 * @returns 规范的绝对目录。
 * @throws 路径缺失、是文件或不可读时。
 */
export async function resolveProjectRoot(input, cwd) {
  const cleaned = cleanPathInput(input, { cwd })
  if (cleaned.length === 0) throw new Error('未提供项目路径')
  const absolute = path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd ?? process.cwd(), cleaned)
  // 原拼写能用就保留它：macOS 的 `realpath` 会把 `/var/...` 改写成
  // `/private/var/...`，而符号链接过的项目应当继续能以用户选的名字被
  // 访问。
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
 * 宽容读取一个可选的 Cordis 服务，不绑定某一种上下文形状。
 * @param ctx - 插件上下文。
 * @param name - 服务名。
 */
export function serviceOf(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== undefined) return viaGet
  } catch {
    // 落到属性形式再试一次。
  }
  try {
    return ctx[name]
  } catch {
    return undefined
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
    // 旧运行时：改为不带超时调用服务。
  }
  return undefined
}

/**
 * 为项目挑一个持久目录的旧实现已删除（v1.2.1，Issue #1）。
 *
 * 它的「活会话 cwd → 注册表第一个工作区」回退链正是工作区「乱窜」的来源：
 * 旧链回答「哪个目录恰好存在」，而不是「用户选了哪个工作区」。v1.2.1 起
 * 解析只走 `lib/workspace-binding.js` 的 B1 链（binding → project-dir →
 * session → 硬失败，绝不猜），本模块不再保留第二份逻辑。
 */

/**
 * 让活会话的工作目录重新可用。
 *
 * `ctx.workingDirectory.ensure` 是宿主自己的恢复路径：它校验当前目录，原始
 * 项目目录可用时恢复它。两者都不可用时，它抛出那个会让每个模型回合流产的
 * `working-directory: directory does not exist: "…"`。本助手随后按序尝试：
 *
 *   1. 当前/原始目录的原生规范拼写；
 *   2. 这些目录的每一级父目录（项目保持可达）；
 *   3. DSH 工作区注册表里登记的每个目录（由调用方经
 *      `options.registeredDirectories` 传入——本模块不再自己读注册表）；
 *   4. 服务的默认启动目录与用户主目录；
 *   5. 父目录存在时，创建真正缺失的会话目录。
 *
 * 第一个被 `workingDirectory.set` 接受的候选被提交，并以 `repaired: true`
 * 上报。
 *
 * @param ctx - 插件上下文。
 * @param agent - 需要修复其会话的活 agent。
 * @param options.signal - 可选取消信号。
 * @param options.timeoutMs - 每次宿主文件系统调用的时限。
 * @param options.registeredDirectories - 已登记工作区目录（lib/workspace-binding.js
 *   的 `registeredDirectoriesOf(ctx)` 产出；v1.2.1 起注册表只由该模块读取）。
 * @returns `{ cwd, previous, repaired, available, error? }`。
 */
export async function ensureAgentDirectory(ctx, agent, options = {}) {
  const session = agent?.session
  const original = headerCwd(agent)
  const workingDirectory = serviceOf(ctx, 'workingDirectory')

  // 没有宿主服务可问：把决定权留给 DSH。标记为"未检查"（而不是"不可用"）
  // 才能让旧组合继续工作。
  if (session === undefined || workingDirectory === undefined || typeof workingDirectory.ensure !== 'function') {
    return { cwd: original, previous: original, repaired: false, available: true, unchecked: true }
  }

  let previous = original
  if (typeof workingDirectory.get === 'function') {
    try {
      const recorded = workingDirectory.get(session)
      if (typeof recorded === 'string' && recorded.length > 0) previous = recorded
    } catch {
      // 投影可能还没登记；头部记录是回退。
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

    // 原生 realpath 能 reconciliation 宿主 fs provider 对付不了的拼写；
    // 路径不存在时它也没有任何代价。
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

    const registeredDirectories = Array.isArray(options.registeredDirectories) ? options.registeredDirectories : []
    for (const workspace of registeredDirectories) remember(await findDirectory(workspace))

    remember(await findDirectory(workingDirectory.defaultDirectory))
    remember(await findDirectory(homedir()))

    // 被删除的项目根是唯一可以安全重建的缺失目录：仅当其父目录仍存在，
    // 且仅限会话自己记录过的目录。
    for (const base of [previous, original]) {
      if (typeof base !== 'string' || base.length === 0) continue
      if (await isDirectory(base)) continue
      if (!(await isDirectory(path.dirname(base)))) continue
      try {
        await mkdir(base, { recursive: true })
        remember(base)
      } catch {
        // 权限被拒：别的候选可能仍然可行。
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
        // 试下一个候选。
      }
    }

    // agent 可能已冷（`ensure`/`set` 因生命周期检查而拒绝），而目录本身
    // 好好的；让调用方排队一个回合把它唤醒。真正缺失的目录按"不可用"
    // 上报。
    const native = await isDirectory(previous) || await isDirectory(original)
    return { cwd: previous, previous, repaired: false, available: native, error }
  }
}

/**
 * 面向用户的、目录修复失败时的解释文案。
 * @param result - {@link ensureAgentDirectory} 的返回值。
 */
export function directoryErrorText(result) {
  const previous = result?.previous ?? result?.cwd ?? '（未知）'
  const detail = result?.error?.message !== undefined ? `（${result.error.message}）` : ''
  return `会话工作目录不可用：${previous}${detail}。DSH 无法启动 agent 回合；`
    + '请把 DSH 工作区改到一个存在的目录（建议纯英文路径），或重启 DSH 后重试。'
}
