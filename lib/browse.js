/**
 * 只读目录浏览（v1.2.1，需求 C）：导入对话框目录树选择器的服务端底层。
 *
 * 分层：`lib/http/browse-routes.js`（薄路由，只做参数校验与错误码映射）←
 * 本模块（纯函数 + fs 适配）。本模块**只读**：绝不 `mkdir`、绝不迁移、绝不
 * 写文件、绝不跟随符号链接、绝不返回文件内容——导入选的是目录，不是文件
 * 管理器（C4 安全边界）。
 *
 * 硬边界：
 *
 *   - 只列目录（不返回文件名、大小、内容）；
 *   - `.` 开头的隐藏项默认跳过；
 *   - 符号链接 / Windows junction 一律不进入、不列出（`Dirent.isSymbolicLink()`
 *     + 逐项 `lstat` 复核；Windows reparse point 家族里 Node 能可靠识别的就是
 *     这两类，其余 reparse tag 无法在不引原生模块的前提下枚举——已知限制）；
 *   - 单次最多 {@link BROWSE_LIMIT} 项，超出置 `truncated:true`；
 *   - 慢盘（UNC / 网络盘）受 {@link BROWSE_TIMEOUT_MS} 超时保护，不阻塞事件循环；
 *   - 输入必须是可以直接使用的绝对路径；含 `..`、NUL、相对拼写的输入一律
 *     明确报错，绝不静默改写用户的意图。
 *
 * @module dsh-codeflow-canvas/browse
 */
import { lstat as lstatFile, readdir, stat as statFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 单次列目录的条目上限（超出 `truncated:true`，UI 提示「仅显示前 N 项」）。 */
export const BROWSE_LIMIT = 500

/** 列目录的时限（UNC / 掉线的网络盘也能及时应答）。 */
export const BROWSE_TIMEOUT_MS = 5000

/** 单个盘符探测的时限（离线的网络盘符不能拖住根清单）。 */
const DRIVE_PROBE_TIMEOUT_MS = 800

/** 带状态码的浏览错误：browse-routes 原样映射成 HTTP 应答。 */
function browseError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

/* ------------------------------------------------------------- 路径纯函数 --- */

/**
 * 跨平台的「父目录」：根目录 → `null`；`C:\a\b` → `C:\a`；`/a` → `/`；
 * 尾分隔符不产生空段。不靠字符串切片——`path.dirname` + `path.parse`。
 *
 * @param absPath - 绝对路径。
 * @returns 父目录；已是根时 `null`。
 */
export function parentOf(absPath) {
  if (typeof absPath !== 'string' || absPath.trim().length === 0) return null
  // 输入用正斜杠拼写时结果也用正斜杠（`/a/b` → `/a`、`/a` → `/`、`C:/a` → `C:/`）；
  // 反斜杠输入维持反斜杠。结果剥掉尾部分隔符（UNC 的 dirname 会带一条）。
  const forward = !absPath.includes('\\')
  const restyle = (value) => (forward ? value.split('\\').join('/') : value)
  const normalized = path.normalize(absPath)
  const root = path.parse(normalized).root
  if (root.length === 0 || normalized === root) return null
  const dir = path.dirname(normalized)
  if (dir === normalized) return null
  if (dir !== root) {
    const stripped = dir.replace(/[\\/]+$/, '') || dir
    return restyle(stripped)
  }
  // dir === root：根本身。盘符根保持 'C:\'；UNC 根剥掉尾分隔符
  // （'\\srv\share\' → '\\srv\share'，仍是可直接浏览的共享根）。
  let result = root
  if (/^[\\/]{2}/.test(root)) result = root.replace(/[\\/]+$/, '') || root
  return restyle(result)
}

/**
 * 根清单（C2）：Windows 存在的盘符、POSIX `/`、用户主目录、已登记工作区。
 * 顺序稳定（盘符 → 主目录 → 工作区），按比较用拼写去重。
 *
 * 本函数是纯函数：`driveRoots` / `workspaces` 由适配器探测后传入。
 *
 * @param options.platform - 目标平台（测试可注入）。
 * @param options.driveRoots - 已存在的盘符根（如 `['C:\\']`）。
 * @param options.home - 用户主目录（缺省取 `os.homedir()`）。
 * @param options.workspaces - 已登记工作区路径（或 `{path,title}` 实体）。
 * @returns `[{ name, path, kind:'root' }]`。
 */
export function listRoots(options = {}) {
  const {
    platform = process.platform,
    driveRoots = [],
    home = homedir(),
    workspaces = [],
  } = options
  const out = []
  const seen = new Set()
  const push = (name, value) => {
    if (typeof value !== 'string' || value.length === 0) return
    const key = `${platform}:${value.split('\\').join('/').toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ name, path: value, kind: 'root' })
  }
  if (platform === 'win32') {
    for (const drive of driveRoots) {
      const text = typeof drive === 'string' ? drive : drive?.path
      if (typeof text !== 'string' || text.length === 0) continue
      const letter = text.slice(0, 1).toUpperCase()
      push(/^[A-Z]:$/.test(letter + ':') ? `${letter}:` : text, text)
    }
  } else {
    push('/', '/')
  }
  if (typeof home === 'string' && home.length > 0) push('主目录', home)
  for (const workspace of workspaces) {
    const entity = typeof workspace === 'string' ? { path: workspace } : workspace
    if (entity === null || typeof entity !== 'object') continue
    if (typeof entity.path !== 'string' || entity.path.length === 0) continue
    push(typeof entity.title === 'string' && entity.title.length > 0 ? entity.title : path.basename(entity.path) || entity.path, entity.path)
  }
  return out
}

/**
 * 目录名排序：`localeCompare('zh-CN')`，大小写不敏感；同拼写时回退原比较，
 * 保证排序是全序（稳定、可复现）。
 */
function compareNames(left, right) {
  const a = String(left)
  const b = String(right)
  return a.toLowerCase().localeCompare(b.toLowerCase(), 'zh-CN') || a.localeCompare(b, 'zh-CN')
}

/**
 * 过滤、排序并截断一个目录的子目录（C2）：
 *
 *   - 只留目录（`Dirent.isDirectory()`）；
 *   - 符号链接不进入（`Dirent.isSymbolicLink()`）；
 *   - `.` 开头的隐藏项默认跳过；
 *   - 按名称 zh-CN 大小写不敏感排序；
 *   - 超过 `limit` 截断并置 `truncated:true`。
 *
 * 纯函数：dirents 由适配器用 `readdir(withFileTypes)` 取得。
 *
 * @param dirents - `fs.Dirent` 数组。
 * @param options.dir - 当前目录绝对路径（拼每个条目的 `path`）。
 * @param options.limit - 条目上限（默认 {@link BROWSE_LIMIT}）。
 * @returns `{ entries: [{ name, path, kind:'dir' }], truncated }`。
 */
export function pickEntries(dirents, options = {}) {
  const { dir, limit = BROWSE_LIMIT } = options
  const entries = []
  for (const dirent of Array.isArray(dirents) ? dirents : []) {
    if (dirent === null || typeof dirent !== 'object') continue
    const name = typeof dirent.name === 'string' ? dirent.name : undefined
    if (name === undefined || name.length === 0) continue
    if (name.startsWith('.')) continue
    if (!dirent.isDirectory()) continue
    if (dirent.isSymbolicLink()) continue
    entries.push({
      name,
      path: typeof dir === 'string' && dir.length > 0 ? path.join(dir, name) : name,
      kind: 'dir',
    })
  }
  entries.sort((left, right) => compareNames(left.name, right.name))
  const truncated = entries.length > limit
  return { entries: truncated ? entries.slice(0, limit) : entries, truncated }
}

/**
 * 规范化一个浏览输入（C2）：剥 `@`/引号/`~`/`file://` 后必须是绝对路径，
 * 不得包含 `..` 或 NUL。返回规范化的绝对路径；输入非法时抛带 `code` 的错误。
 *
 * @param raw - 用户输入（导入对话框路径框的当前值）。
 * @param options.home - `~` 展开用的主目录（测试可注入）。
 * @returns 规范化的绝对路径。
 */
export function normalizeBrowseInput(raw, options = {}) {
  let value = String(raw ?? '').trim()
  if (value.length === 0) {
    throw browseError('BROWSE_BAD_PATH', '路径为空。', 400)
  }
  // 与导入路径同一套清洗（@/引号/~/file://）；不给 cwd——浏览只收绝对路径。
  value = cleanForBrowse(value, options.home)
  if (value.length === 0) {
    throw browseError('BROWSE_BAD_PATH', '路径为空。', 400)
  }
  if (value.includes('\0')) {
    throw browseError('BROWSE_BAD_PATH', '路径包含非法字符（NUL）。', 400)
  }
  const absolute = path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
  if (!absolute) {
    throw browseError('BROWSE_BAD_PATH', `必须是绝对路径（收到：${value}）。浏览器只接受完整路径；相对路径请在导入对话框里直接填写。`, 400)
  }
  // `..` 在 normalize 之前拒绝：Windows 上 path.normalize 会直接解析掉它，
  // 「C:\a\..\b」就在用户不知不觉间变成了另一个位置——明确报错而不是改写意图。
  const rawSegments = value.split(/[\\/]/).filter((segment) => segment.length > 0)
  if (rawSegments.includes('..')) {
    throw browseError('BROWSE_BAD_PATH', `路径包含 ".."（收到：${value}）。请直接填写目标目录的完整路径。`, 400)
  }
  const normalized = path.normalize(value)
  return normalized
}

/** 浏览输入的清洗（@/引号/`~` 展开/file:// URL）；独立小实现避免循环依赖。 */
function cleanForBrowse(value, home) {
  let text = value
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text
    if (text.length >= 2) {
      const first = text[0]
      if ((first === '"' || first === "'" || first === '`') && text[text.length - 1] === first) {
        text = text.slice(1, -1).trim()
      }
    }
    while (text.startsWith('@')) text = text.slice(1).trim()
    if (text === before) break
  }
  if (/^file:\/\//i.test(text)) {
    try {
      text = fileURLToPath(text)
    } catch {
      // 畸形 file URL 原样保留，交给后面的校验报错。
    }
  }
  const base = typeof home === 'string' && home.length > 0 ? home : homedir()
  if (text === '~') text = base
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(base, text.slice(2))
  return text.trim()
}

/* --------------------------------------------------------------- fs 适配 --- */

/** 带时限地跑一个 promise；超时抛 `BROWSE_TIMEOUT`（导出供测试直接覆盖时序）。 */
export async function withTimeout(job, ms) {
  let timer
  try {
    return await Promise.race([
      job,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(browseError('BROWSE_TIMEOUT', `读取目录超时（${Math.round(ms / 1000)}s）：慢速磁盘或离线的网络位置。`, 504)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 把 fs 错误翻译成浏览错误码（C2 错误映射表；导出供测试逐码断言）。
 */
export function mapFsError(error, target) {
  if (error?.code === 'BROWSE_TIMEOUT') return error
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
    return browseError('BROWSE_NOT_FOUND', `路径不存在：${target}`, 404)
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return browseError('BROWSE_FORBIDDEN', `没有权限读取：${target}`, 403)
  }
  return browseError('BROWSE_FAILED', `无法读取目录 ${target}（${error?.code ?? error?.message ?? error}）`, 500)
}

/**
 * 列一个目录的子目录（fs 适配，只读）。
 *
 * 流程：`lstat` 校验目标（不存在 → 404；是文件 → 400；无权限 → 403）→
 * `readdir(withFileTypes)`（5s 超时）→ 逐项 `lstat` 复核符号链接（scandir 在
 * 个别平台上对 junction 的判定不可靠，这里双保险）→ {@link pickEntries}。
 *
 * @param dir - 绝对目录路径（应已过 {@link normalizeBrowseInput}）。
 * @param options.timeoutMs - 超时（默认 {@link BROWSE_TIMEOUT_MS}）。
 * @param options.limit - 条目上限（默认 {@link BROWSE_LIMIT}）。
 * @returns `{ ok:true, path, parent, entries, truncated }`。
 */
export async function readDirectoryEntries(dir, options = {}) {
  const target = path.normalize(String(dir))
  const timeoutMs = options.timeoutMs ?? BROWSE_TIMEOUT_MS
  const limit = options.limit ?? BROWSE_LIMIT

  let info
  try {
    info = await withTimeout(lstatFile(target), timeoutMs)
  } catch (error) {
    throw mapFsError(error, target)
  }
  if (!info.isDirectory()) {
    throw browseError('BROWSE_NOT_DIRECTORY', `该路径不是目录：${target}`, 400)
  }

  let dirents
  try {
    dirents = await withTimeout(readdir(target, { withFileTypes: true }), timeoutMs)
  } catch (error) {
    throw mapFsError(error, target)
  }

  // 符号链接 / junction 双保险：scandir 的 Dirent 判定之外再 lstat 一次。
  const verified = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue
    try {
      const detailed = await withTimeout(lstatFile(path.join(target, dirent.name)), timeoutMs)
      if (detailed.isSymbolicLink()) continue
    } catch {
      // 判定不了的一律不列（宁可少列，不可误入）。
      continue
    }
    verified.push(dirent)
  }

  const picked = pickEntries(verified, { dir: target, limit })
  return {
    ok: true,
    path: target,
    parent: parentOf(target),
    entries: picked.entries,
    truncated: picked.truncated,
  }
}

/**
 * 探测 Windows 上真实存在的盘符（A:–Z:；适配器部分——需要 stat IO）。
 * 每个盘符独立限时，离线的网络盘符不会拖住整张根清单。
 *
 * @returns 已存在的盘符根列表（`['C:\\', ...]`，升序）。
 */
export async function existingDriveRoots(options = {}) {
  if (process.platform !== 'win32' && options.platform !== 'win32') return []
  const probes = []
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    const root = `${letter}:\\`
    probes.push(
      withTimeout(statFile(root), options.probeTimeoutMs ?? DRIVE_PROBE_TIMEOUT_MS)
        .then((info) => (info.isDirectory() ? root : undefined))
        .catch(() => undefined),
    )
  }
  const settled = await Promise.all(probes)
  return settled.filter((value) => value !== undefined)
}

/**
 * 浏览的入口适配：`path` 为空 → 根清单；否则列目录。
 *
 * @param rawPath - 用户输入（可为空）。
 * @param options.home - 主目录覆盖（测试用）。
 * @param options.workspaces - 已登记工作区（`collectWorkspaces` 的清单，只读复用）。
 * @returns 根清单或目录清单（都是 C2 的响应形状）。
 */
export async function browseDirectory(rawPath, options = {}) {
  const input = String(rawPath ?? '').trim()
  if (input.length === 0) {
    const driveRoots = await existingDriveRoots({ platform: options.platform })
    const home = typeof options.home === 'string' && options.home.length > 0 ? options.home : homedir()
    const entries = listRoots({
      platform: options.platform,
      driveRoots,
      home,
      workspaces: options.workspaces ?? [],
    })
    return { ok: true, path: null, parent: null, entries, truncated: false, roots: true }
  }
  const target = normalizeBrowseInput(input, { home: options.home })
  return readDirectoryEntries(target, { timeoutMs: options.timeoutMs, limit: options.limit })
}
