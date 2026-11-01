/**
 * 工作区解析与校验（v1.2.1，Issue #1）。
 *
 * 本模块是「项目落在哪个工作区」的唯一答案，也是全插件**唯一**允许读取
 * `workspaceRegistry` 的地方（薄适配器收敛在文件尾部；其余都是纯函数）。
 *
 * Issue #1 的两条根因都在旧的 `resolveWorkspaceDirectory`（原 lib/workspace.js）：
 *
 *   1. 它回答「哪个目录恰好存在」，而不是「用户选了哪个工作区」；
 *   2. 最后一档 `workspaceRegistry.list()[0]`——「注册表里的第一个工作区」——
 *      就是「工作区乱窜」的直接来源。
 *
 * v1.2.1 起解析只有一条链（B1，顺序固定、可单测、每一步可解释）：
 *
 *   1. binding      —— store/侧车显式记录的工作区，且它仍是已登记工作区；
 *   2. project-dir  —— 项目持久目录落在某个已登记工作区内（最长前缀）；
 *   3. session      —— 画布会话的 cwd 落在某个已登记工作区内（最长前缀）；
 *   4. 都不成立     —— `NO_WORKSPACE` 硬失败，带候选清单，绝不猜。
 *
 * 被删除的回退：`registry.list()[0]`、以及任何让 `process.cwd()` / `homedir()`
 * 参与落点决策的分支。`ensureAgentDirectory` 的父目录/家目录修复是另一件事
 * （会话目录损坏修复，与落点无关），不在本模块。
 *
 * 宿主能力的退化语义（显式、有文档，不是静默回退）：
 *
 *   - 宿主**提供** `workspaceRegistry`：所有三档都要求「已登记」，未登记的
 *     目录永远解析不出去——这是 Issue #2 的核心保证；
 *   - 宿主**不提供**该服务：「已登记」无从校验，三档退化为目录存在性校验。
 *     这保持了旧组合（无注册表的宿主/测试）按 6.4 兼容可用，且依然没有
 *     「第一个工作区」式的猜测——解析不到就是 `NO_WORKSPACE`。
 *
 * 依赖方向：core/* ← codeflow-config ← paths ← 本模块 ← sessions / http / index。
 * （workspace.js 是叶子，不反向依赖本模块。）
 *
 * @module dsh-codeflow-canvas/workspace-binding
 */
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import { defaultRoot, pluginRoot, readConfig } from './codeflow-config.js'
import { isAbsolutePath } from './core/path.js'
import { projectDir } from './paths.js'
import { cleanPathInput, isDirectory, serviceOf } from './workspace.js'

/* ------------------------------------------------------------ 平台路径比较 --- */

/**
 * 把一个路径收敛成「比较用拼写」：分隔符归一、折叠冗余段、Windows 上大小写
 * 不敏感（DSH 注册表里的 path 经宿主 `fs.realpath` 规范化，用户输入则五花
 * 八门；逐字比较在 Windows 上必然误判）。
 *
 * @param value - 任意路径拼写。
 * @param platform - 目标平台（测试可注入）。
 * @returns 比较用拼写；空输入返回空串。
 */
export function normalizeForCompare(value, platform = process.platform) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  const unified = trimmed.split('\\').join('/')
  const folded = platform === 'win32' ? unified.toLowerCase() : unified
  // 折叠重复分隔符、`.` 与 `..`（比较键层面解析；`..` 越出根时丢弃），
  // 根分隔符与盘符后补一条分隔线，保证键无歧义。
  const segments = []
  for (const segment of folded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const prefix = /^[a-z]:/.test(folded)
    ? `${folded.slice(0, 2)}/`
    : folded.startsWith('//') ? '//' : folded.startsWith('/') ? '/' : ''
  return prefix + segments.join('/')
}

/** `normalizeForCompare` 的便捷包装：两侧都归一后逐字相等。 */
function samePath(left, right, platform = process.platform) {
  const a = normalizeForCompare(left, platform)
  return a.length > 0 && a === normalizeForCompare(right, platform)
}

/**
 * 一个候选路径是否是已登记工作区（逐字相等，归一后）。
 *
 * @param registered - 已登记工作区路径（或 `{path}` 实体）数组。
 * @param candidate - 候选绝对路径。
 * @param platform - 目标平台。
 */
export function isRegistered(registered, candidate, platform = process.platform) {
  if (!Array.isArray(registered) || typeof candidate !== 'string' || candidate.length === 0) return false
  return registered.some((entry) => samePath(typeof entry === 'string' ? entry : entry?.path, candidate, platform))
}

/**
 * 包含一个候选路径的已登记工作区：取**最长前缀**匹配的那个（`/a` 与 `/a/b`
 * 都登记、候选在 `/a/b/...` 下时选 `/a/b`）。候选就是工作区根本身也算命中。
 *
 * @param registered - 已登记工作区路径数组（比较用拼写任意）。
 * @param candidate - 候选绝对路径（项目目录或会话 cwd）。
 * @param platform - 目标平台。
 * @returns 命中的已登记路径（登记表原拼写），或 `undefined`。
 */
export function longestRegisteredOf(registered, candidate, platform = process.platform) {
  if (!Array.isArray(registered) || typeof candidate !== 'string' || candidate.length === 0) return undefined
  const wanted = normalizeForCompare(candidate, platform)
  if (wanted.length === 0) return undefined
  let best
  let bestLength = -1
  for (const entry of registered) {
    const normalized = normalizeForCompare(typeof entry === 'string' ? entry : entry?.path, platform)
    if (normalized.length === 0) continue
    if (wanted !== normalized && !wanted.startsWith(`${normalized}/`)) continue
    if (normalized.length > bestLength) {
      best = typeof entry === 'string' ? entry : entry?.path
      bestLength = normalized.length
    }
  }
  return best
}

/**
 * 候选清单的稳定排序（错误信息与 `NO_WORKSPACE` 载荷用）：按比较用拼写排序，
 * 顺序确定性不依赖注册表返回顺序。
 *
 * @param registered - 已登记工作区路径（或实体）数组。
 * @param platform - 目标平台。
 */
export function sortCandidatePaths(registered, platform = process.platform) {
  if (!Array.isArray(registered)) return []
  return registered
    .map((entry) => (typeof entry === 'string' ? entry : entry?.path))
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort((left, right) => normalizeForCompare(left, platform).localeCompare(normalizeForCompare(right, platform), 'zh-CN'))
}

/* --------------------------------------------------------- B1 纯函数解析 --- */

/**
 * B1 解析链的纯核心：给定各档候选与登记表，产出工作区或硬失败。
 *
 * 所有候选都应已由调用方做过**存在性校验**（本函数无 IO）。`registryAvailable`
 * 决定校验强度：true 时三档都必须命中登记表（binding 要求逐字相等，
 * project-dir / session 允许「位于工作区内」的最长前缀）；false 时按链序取
 * 第一个非空候选（存在性已由适配器保证）。
 *
 * @param options.bound - 显式绑定的工作区（store/侧车），可能 `undefined`。
 * @param options.projectDir - 项目持久目录（若已知）。
 * @param options.sessionCwd - 画布会话 cwd（若已知）。
 * @param options.registered - 已登记工作区路径数组。
 * @param options.registryAvailable - 宿主是否提供了 `workspaceRegistry`。
 * @param options.platform - 目标平台。
 * @returns `{ workspace, source }` 或 `{ code:'NO_WORKSPACE', candidates }`。
 */
export function pickWorkspace(options = {}) {
  const {
    bound,
    projectDir,
    sessionCwd,
    registered = [],
    registryAvailable = true,
    platform = process.platform,
  } = options
  const chain = [
    ['binding', bound],
    ['project-dir', projectDir],
    ['session', sessionCwd],
  ]
  if (!registryAvailable) {
    for (const [source, value] of chain) {
      if (typeof value === 'string' && value.length > 0) return { workspace: value, source }
    }
    return { code: 'NO_WORKSPACE', candidates: [] }
  }
  for (const [source, value] of chain) {
    if (typeof value !== 'string' || value.length === 0) continue
    // binding：显式绑定必须**就是**一个已登记工作区（「仍是已登记工作区」）；
    // 命中时返回登记表原拼写（宿主 canonical），下游 join 与 workspaceId 匹配都以它为准。
    const match = source === 'binding'
      ? registered.find((entry) => samePath(typeof entry === 'string' ? entry : entry?.path, value, platform))
      : undefined
    const hit = match !== undefined
      ? (typeof match === 'string' ? match : match?.path)
      : (source === 'binding' ? undefined : longestRegisteredOf(registered, value, platform))
    if (hit !== undefined) return { workspace: hit, source }
  }
  return { code: 'NO_WORKSPACE', candidates: sortCandidatePaths(registered, platform) }
}

/** 宿主错误的首行（错误信息拼装用，绝不把多行堆栈塞给用户）。 */
export function firstLineOf(error) {
  const text = String(error?.message ?? error ?? '')
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0)
  return line ?? String(error ?? '')
}

/* ------------------------------------------------------------- 薄适配器 --- */
/* 以下函数是全插件唯一允许触碰 `workspaceRegistry` 的地方。它们的职责只有
 * 「宽容地读宿主服务并投影成稳定形状」，任何业务判断都在上面的纯函数里。 */

/** 宽容读取根 agents 列表（缺服务/形状不对时为空）。 */
function agentsRootsOf(ctx) {
  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined) return []
  try {
    const roots = typeof agents.roots === 'function' ? agents.roots() : undefined
    return Array.isArray(roots) ? roots : []
  } catch {
    return []
  }
}

/** 会话头里记录的 cwd（可能过期——投影才是后续回合真正用的那个）。 */
function headerCwdOf(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * 读 `workspaceRegistry.list()` 并投影成 `{ id, path, title }` 列表。
 *
 * @returns `{ available, workspaces, error? }`：`available:false` 表示宿主
 *   没有该服务（解析退化为存在性校验、列表接口报 `NO_WORKSPACE_SERVICE`）；
 *   `error` 表示服务在但 `list()` 抛了（列表接口报 `WORKSPACE_LIST_FAILED`）。
 */
export function registeredWorkspacesOf(ctx) {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') {
    return { available: false, workspaces: [] }
  }
  let listed
  try {
    listed = registry.list()
  } catch (error) {
    return { available: true, workspaces: [], error }
  }
  if (!Array.isArray(listed)) return { available: true, workspaces: [], error: new Error('workspaceRegistry.list() 没有返回数组') }
  const workspaces = []
  for (const entry of listed) {
    const entity = typeof entry === 'string' ? { path: entry } : entry
    if (typeof entity?.path !== 'string' || entity.path.length === 0) continue
    workspaces.push({
      ...(typeof entity.id === 'string' && entity.id.length > 0 ? { id: entity.id } : {}),
      path: entity.path,
      ...(typeof entity.title === 'string' && entity.title.length > 0 ? { title: entity.title } : {}),
    })
  }
  return { available: true, workspaces }
}

/** 已登记工作区的目录列表（`ensureAgentDirectory` 的修复候选；只读）。 */
export function registeredDirectoriesOf(ctx) {
  return registeredWorkspacesOf(ctx).workspaces.map((entry) => entry.path)
}

/**
 * 按路径找一个已登记工作区实体（归一比较 + realpath 双保险）：宿主注册表里
 * 的 path 经 `fs.realpath` 规范化，调用方拿到的拼写未必一致。
 *
 * @returns `{ id, path, title }` 或 `undefined`。
 */
export async function registeredEntityForPath(ctx, dir) {
  if (typeof dir !== 'string' || dir.length === 0) return undefined
  const registered = registeredWorkspacesOf(ctx)
  if (!registered.available) return undefined
  const spellings = new Set([normalizeForCompare(dir)])
  try {
    spellings.add(normalizeForCompare(await realpath(dir)))
  } catch {
    // realpath 失败：字面拼写仍然参与比较。
  }
  return registered.workspaces.find((entry) => spellings.has(normalizeForCompare(entry.path))) ?? undefined
}

/**
 * 画布会话 cwd 的候选序列（B1 第 3 档的输入）。
 *
 * 顺序：项目**已绑定**的专用会话最优先；其余活会话按宿主返回顺序跟随——
 * 这是冷启动（重启后面板先于任何绑定打开）的锚点。有注册表时只有落在
 * 已登记工作区内的 cwd 能命中；没有注册表时存在性校验兜底。
 *
 * @param store - 画布 store（读绑定会话 id）。
 * @param project - 项目键；`undefined` 表示面板级解析（无项目上下文）。
 */
export function sessionCwdCandidates(ctx, store, project) {
  const agents = serviceOf(ctx, 'agents')
  const workingDirectory = serviceOf(ctx, 'workingDirectory')
  const out = []
  const seen = new Set()
  const push = (value) => {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) return
    seen.add(value)
    out.push(value)
  }
  const ordered = []
  const sessionId = project !== undefined && store !== undefined && typeof store.get === 'function'
    ? store.get(project)?.sessionId
    : undefined
  if (typeof sessionId === 'string' && sessionId.length > 0 && agents !== undefined && typeof agents.get === 'function') {
    try {
      const bound = agents.get(sessionId)
      if (bound !== undefined && bound !== null) ordered.push(bound)
    } catch {
      // 绑定的会话没有活 agent：正常（冷会话由 prompt 恢复）。
    }
  }
  for (const root of agentsRootsOf(ctx)) {
    if (!ordered.includes(root)) ordered.push(root)
  }
  for (const agent of ordered) {
    if (workingDirectory !== undefined && typeof workingDirectory.get === 'function') {
      try {
        push(workingDirectory.get(agent.session))
      } catch {
        // 投影未登记：落到头部记录。
      }
    }
    push(headerCwdOf(agent))
  }
  return out
}

/* ------------------------------------------------------------- B1 解析器 --- */

/**
 * 解析一个项目的所属工作区（B1：binding → project-dir → session → 硬失败）。
 *
 * 每次调用都现场解析（无模块级缓存），结果要么带 `source` 可解释，要么带
 * 候选清单可行动。成功/失败各记一条可观测日志（B4）。
 *
 * @param ctx - 插件上下文。
 * @param store - 画布 store。
 * @param project - 项目键；`undefined` 表示面板级解析。
 * @param options.logger - Cordis logger（B4 日志）。
 * @returns `{ workspace, source }` 或 `{ code:'NO_WORKSPACE', candidates, message }`。
 */
export async function resolveProjectWorkspace(ctx, store, project, options = {}) {
  const logger = options.logger
  const key = typeof project === 'string' && project.length > 0 ? project : '(panel)'
  const registered = registeredWorkspacesOf(ctx)

  /** 候选经存在性校验后的 B1 输入。 */
  const chain = []
  const state = project !== undefined && store !== undefined && typeof store.get === 'function'
    ? store.get(project)
    : undefined
  const bound = typeof state?.cwd === 'string' && state.cwd.length > 0 ? state.cwd : undefined
  if (bound !== undefined && (await isDirectory(bound))) chain.push(['binding', bound])
  const dir = typeof state?.dir === 'string' && state.dir.length > 0 ? state.dir : undefined
  if (dir !== undefined && dir !== bound && (await isDirectory(dir))) chain.push(['project-dir', dir])
  for (const cwd of sessionCwdCandidates(ctx, store, project)) {
    if (chain.some(([, value]) => normalizeForCompare(value) === normalizeForCompare(cwd))) continue
    if (await isDirectory(cwd)) chain.push(['session', cwd])
  }

  const registeredPaths = registered.workspaces.map((entry) => entry.path)
  const picked = pickWorkspace({
    bound: chain.find(([source]) => source === 'binding')?.[1],
    projectDir: chain.find(([source]) => source === 'project-dir')?.[1],
    sessionCwd: chain.find(([source]) => source === 'session')?.[1],
    registered: registeredPaths,
    registryAvailable: registered.available,
  })

  if (picked.code === 'NO_WORKSPACE') {
    const detail = registered.error !== undefined
      ? `读取 DSH 工作区注册表失败：${firstLineOf(registered.error)}。`
      : registered.available
        ? '当前 DSH 没有已登记的工作区。'
        : ''
    const hint = registered.available && registered.error === undefined
      ? '请先在 DSH 左侧栏添加工作区，或新建一个项目以绑定工作区。'
      : '请先在 DSH 里添加该目录为工作区，或新建一个项目以绑定工作区。'
    const candidates = picked.candidates ?? []
    const message = `未能确定 CodeFlow 项目「${key}」所属的 DSH 工作区。${detail}${hint}` +
      (candidates.length > 0 ? `当前可用工作区：${candidates.join('、')}。` : '')
    logger?.warn?.(`codeflow: workspace resolve failed project=${key} code=NO_WORKSPACE candidates=[${candidates.join(', ')}]`)
    return { code: 'NO_WORKSPACE', candidates, message }
  }

  // 命中的登记路径可能已从磁盘消失（宿主 status 尚未刷新）：当它不存在时
  // 不能把不存在的目录当答案，继续按「解析失败」处理。
  if (!(await isDirectory(picked.workspace))) {
    const message = `工作区目录不再存在：${picked.workspace}。请在 DSH 里检查该工作区，或重新选择。`
    logger?.warn?.(`codeflow: workspace resolve failed project=${key} code=WORKSPACE_MISSING path=${picked.workspace}`)
    return { code: 'WORKSPACE_MISSING', candidates: sortCandidatePaths(registeredPaths), message }
  }

  logger?.info?.(`codeflow: workspace resolved project=${key} source=${picked.source} path=${picked.workspace}`)
  return { workspace: picked.workspace, source: picked.source }
}

/* ------------------------------------------------------- A2 工作区校验 --- */

/** 「目录等于或位于插件包目录内」的判断（与 sanitizeConfiguredDir 同一拒绝面）。 */
function insidePluginDir(candidate, plugin) {
  const a = normalizeForCompare(candidate)
  const b = normalizeForCompare(plugin)
  return a.length > 0 && b.length > 0 && (a === b || a.startsWith(`${b}/`))
}

/**
 * 校验 NEW 请求带来的工作区（A2，顺序固定）：
 *
 *   1. 清洗（`@`/引号/`~`/`file://`）并要求绝对路径；
 *   2. 等于/位于插件包目录内 → `WORKSPACE_IN_PLUGIN_DIR`；
 *   3. 目录不存在 / 不是目录 → `WORKSPACE_MISSING`；
 *   4. 宿主没有 `workspaceRegistry` → `NO_WORKSPACE_SERVICE`（不降级注册）；
 *   5. 规范化后与某个已登记工作区逐字相等 → 通过（返回登记表原拼写）；
 *   6. 否则 → `WORKSPACE_NOT_REGISTERED`，错误信息带可用工作区清单。
 *
 * @param ctx - 插件上下文。
 * @param raw - 用户提交的工作区路径原文。
 * @returns `{ ok:true, workspace, workspaceId? }` 或 `{ ok:false, code, message }`。
 */
export async function validateWorkspaceChoice(ctx, raw) {
  const cleaned = cleanPathInput(raw)
  if (cleaned.length === 0) {
    return { ok: false, code: 'WORKSPACE_REQUIRED', message: '请先选择一个 DSH 工作区再新建项目。' }
  }
  if (!isAbsolutePath(cleaned)) {
    return {
      ok: false,
      code: 'WORKSPACE_NOT_REGISTERED',
      message: `工作区必须是绝对路径（收到：${cleaned}）。请从下拉框选择一个已登记的 DSH 工作区。`,
    }
  }
  if (insidePluginDir(cleaned, pluginRoot())) {
    return {
      ok: false,
      code: 'WORKSPACE_IN_PLUGIN_DIR',
      message: `工作区不能在插件包目录（${pluginRoot()}）内：插件更新会被覆盖，请选择已登记的 DSH 工作区。`,
    }
  }
  let info
  try {
    info = await stat(cleaned)
  } catch {
    return { ok: false, code: 'WORKSPACE_MISSING', message: `目录不存在：${cleaned}，请重新选择工作区。` }
  }
  if (!info.isDirectory()) {
    return { ok: false, code: 'WORKSPACE_MISSING', message: `该路径不是目录：${cleaned}，请重新选择工作区。` }
  }

  const registered = registeredWorkspacesOf(ctx)
  if (!registered.available) {
    return {
      ok: false,
      code: 'NO_WORKSPACE_SERVICE',
      message: '当前 DSH 未提供工作区列表接口，无法安全确定项目落点。请先在 DSH 左侧栏把该目录添加为工作区。',
    }
  }
  if (registered.error !== undefined) {
    return {
      ok: false,
      code: 'WORKSPACE_LIST_FAILED',
      message: `读取 DSH 工作区注册表失败：${firstLineOf(registered.error)}`,
    }
  }
  const spellings = new Set([normalizeForCompare(cleaned)])
  try {
    spellings.add(normalizeForCompare(await realpath(cleaned)))
  } catch {
    // realpath 失败：字面拼写仍然参与比较。
  }
  const entity = registered.workspaces.find((entry) => spellings.has(normalizeForCompare(entry.path)))
  if (entity !== undefined) {
    return { ok: true, workspace: entity.path, ...(entity.id !== undefined ? { workspaceId: entity.id } : {}) }
  }
  const candidates = sortCandidatePaths(registered.workspaces.map((entry) => entry.path))
  const availableList = candidates.length > 0 ? `当前可用工作区：${candidates.join('、')}。` : '当前没有已登记的工作区。'
  return {
    ok: false,
    code: 'WORKSPACE_NOT_REGISTERED',
    message: `目录 ${cleaned} 不是 DSH 工作区。请先在 DSH 左侧栏把它添加为工作区，然后重试。${availableList}`,
  }
}

/* ------------------------------------------------------------ A1 工作区清单 --- */

/**
 * 组装 `GET /api/workspaces` 的载荷（A1，唯一数据源）。
 *
 * **只读**：不 `mkdir`、不 `ensureLayout`、不迁移——每个工作区只读它自己的
 * `CodeFlow/config.json`（缺失即默认根），用于对话框预览最终路径。
 * `projectName` 给出时逐个工作区附加服务端计算的 `projectDir` 预览
 * （与 `paths.projectDir` 同一实现，UI 不自己拼）。
 *
 * @param options.ctx - 插件上下文。
 * @param options.store - 画布 store（`current` 默认项取自已显式绑定的工作区）。
 * @param options.projectName - 可选项目名：为预览 `projectDir` 而传入。
 * @returns A1 载荷：`{ ok:true, current, workspaces }` 或 `{ ok:false, code, message }`。
 */
export async function collectWorkspaces(options = {}) {
  const { ctx, store, projectName } = options
  const registered = registeredWorkspacesOf(ctx)
  if (!registered.available) {
    return {
      ok: false,
      code: 'NO_WORKSPACE_SERVICE',
      message: '当前 DSH 未提供工作区列表接口，无法安全确定项目落点。',
    }
  }
  if (registered.error !== undefined) {
    return {
      ok: false,
      code: 'WORKSPACE_LIST_FAILED',
      message: `读取 DSH 工作区注册表失败：${firstLineOf(registered.error)}`,
    }
  }
  const name = typeof projectName === 'string' && projectName.trim().length > 0 ? projectName.trim() : undefined
  const workspaces = []
  for (const entity of registered.workspaces) {
    const exists = await isDirectory(entity.path)
    let cfg
    try {
      cfg = await readConfig(entity.path)
    } catch {
      cfg = undefined
    }
    const entry = {
      path: entity.path,
      name: path.basename(entity.path) || entity.path,
      root: cfg?.root ?? defaultRoot(entity.path),
      defaultRoot: defaultRoot(entity.path),
      customRoot: cfg?.root ?? null,
      exists,
      ...(entity.title !== undefined ? { title: entity.title } : {}),
    }
    if (name !== undefined) {
      try {
        entry.projectDir = await projectDir(entity.path, name)
      } catch {
        // 无法预览（配置损坏等）：字段缺省，UI 显示「—」。
      }
    }
    workspaces.push(entry)
  }
  // 默认选中项：store 里最近一次显式绑定、且仍是已登记工作区、目录仍在。
  let current
  const boundCwd = store !== undefined && typeof store.anyCwd === 'function' ? store.anyCwd() : undefined
  if (typeof boundCwd === 'string' && boundCwd.length > 0) {
    const spellings = new Set([normalizeForCompare(boundCwd)])
    try {
      spellings.add(normalizeForCompare(await realpath(boundCwd)))
    } catch {
      // 同上。
    }
    const hit = registered.workspaces.find((entry) => spellings.has(normalizeForCompare(entry.path)))
    if (hit !== undefined && (await isDirectory(hit.path))) current = hit.path
  }
  return { ok: true, current, workspaces }
}
