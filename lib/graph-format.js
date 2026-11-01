/**
 * 图格式：`codeflow/1` 信封的常量定义与纯函数清洗。
 *
 * 画布的两个视图（tasks / modules）各自持有完整、自洽的 `codeflow/1` 图；
 * 这里的函数定义"什么是一条合法的图/节点/交付物/耦合标注"，并负责把浏览器
 * 与 agent 送来的任意载荷清洗成合法形状。全部是纯函数：同样的输入永远得到
 * 同样的输出，且**缺省字段一律删除**（而非补 `undefined`），保证 v0.5.0
 * 之前的旧图经过清洗后逐字节不变。
 *
 * 本模块是纯粹的格式契约，不含任何状态与 IO；store.js 引用它并在原位
 * re-export（历史兼容面），tool/routes/undo/activity 直接从这里导入。
 *
 * 依赖方向：只依赖 `lib/core/`，不依赖任何宿主状态模块。
 *
 * @module dsh-codeflow-canvas/graph-format
 */
import { stripControlChars } from './core/path.js'

/* ============================================================ 视图常量 === */

/** 两个画布视图，按展示顺序排列。 */
export const VIEW_KEYS = Object.freeze(['tasks', 'modules'])

/** 什么都不知道时项目打开的默认视图。 */
export const DEFAULT_VIEW = 'tasks'

/** 面向用户的视图名（routes、tool 与错误文案共用）。 */
export const VIEW_LABEL = Object.freeze({ tasks: '任务流水线', modules: '模块结构图' })

/** 各视图的持久化文件名（相对项目目录）。 */
export const VIEW_FILES = Object.freeze({ tasks: 'workflow.json', modules: 'workflow.modules.json' })

/** 记忆面板当前激活视图的侧车文件名（不属于任何 rev）。 */
export const VIEW_SIDECAR_FILE = 'view.json'

/**
 * 归一用户提供的视图名；其余值返回 `undefined`。
 *
 * @param value - 任意输入。
 * @returns `'tasks'` | `'modules'` | `undefined`。
 */
export function normalizeView(value) {
  return value === 'tasks' || value === 'modules' ? value : undefined
}

/**
 * 按节点 id 的拼写反推所属视图（`t3` → tasks、`m7` → modules）。
 * 旧版 `n*` id 不携带视图信息，返回 `undefined`。
 *
 * @param nodeId - 节点 id。
 */
export function viewOfNodeId(nodeId) {
  if (typeof nodeId !== 'string') return undefined
  if (/^t\d+$/.test(nodeId)) return 'tasks'
  if (/^m\d+$/.test(nodeId)) return 'modules'
  return undefined
}

/* ======================================================== 交付物清洗 ===== */

/** 节点可能持有的状态；其余值一律收敛为 `pending`（store.patchNode 也用它校验增量补丁）。 */
export const NODE_STATUSES = new Set(['pending', 'running', 'done', 'failed', 'skipped'])

/** 每个节点 `artifacts` 数组的条目上限。 */
export const MAX_ARTIFACTS_PER_NODE = 50

/** 交付物允许声称的类别。 */
const ARTIFACT_KINDS = new Set(['code', 'doc', 'test', 'config', 'asset', 'other'])

/**
 * 清洗一条 `artifacts` 数组：丢弃非对象、空/重复路径与未知 kind，并限量。
 * 没有任何有效条目时返回 `undefined`——调用方据此删掉字段，让从未用过该
 * 字段的旧图保持逐字节不变。
 *
 * @param raw - 任意输入。
 * @returns 清洗后的数组，或 `undefined`。
 */
export function normalizeArtifacts(raw) {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (out.length >= MAX_ARTIFACTS_PER_NODE) break
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const artifactPath = stripControlChars(item.path)
    if (artifactPath === '' || seen.has(artifactPath)) continue
    seen.add(artifactPath)
    const label = typeof item.label === 'string' ? item.label.slice(0, 80).trim() : ''
    const kind = ARTIFACT_KINDS.has(item.kind) ? item.kind : 'other'
    out.push({
      path: artifactPath,
      ...(label.length > 0 ? { label } : {}),
      ...(item.kind !== undefined && ARTIFACT_KINDS.has(item.kind) ? { kind } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 清洗一条 `presented` 数组（真正递交给 `present` 的路径）。
 * 语义同 {@link normalizeArtifacts}，条目就是路径字符串。
 *
 * @param raw - 任意输入。
 * @returns 清洗后的数组，或 `undefined`。
 */
export function normalizePresented(raw) {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (out.length >= MAX_ARTIFACTS_PER_NODE) break
    const text = typeof item === 'string' ? stripControlChars(item) : ''
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out.length > 0 ? out : undefined
}

/* ====================================================== 耦合字段清洗 ===== */
/* v1.2：耦合分析的落盘字段也走"白名单 + 钳制"，未知键丢弃、数字截断，
 * 序列化后天然 ≤ 800 字节；坏形状返回 undefined 让旧图保持原样。        */

/** 节点级 `coupling.metrics` 的整数白名单（其余键一律丢弃）。 */
const COUPLING_METRIC_INTS = new Set(['fanIn', 'fanOut', 'closure', 'depth', 'sccSize', 'symbols', 'refs', 'maxFanOut', 'lines'])

/** 数值上限：写进图的 coupling 数字都夹在这里，序列化后天然 ≤ 800 字节。 */
const COUPLING_INT_CAP = 1_000_000

/** ISO 时间戳字段最多保留的字符数（ISO-8601 最长 ~30 字符，余量截断）。 */
const COUPLING_AT_CAP = 40

/**
 * 把一个数钳制为 `[0, cap]` 内的整数；非有限值返回 `undefined`。
 *
 * @param value - 任意输入。
 * @param cap - 上限（默认 {@link COUPLING_INT_CAP}）。
 */
function couplingInt(value, cap = COUPLING_INT_CAP) {
  const num = Number(value)
  if (!Number.isFinite(num)) return undefined
  return Math.min(cap, Math.max(0, Math.trunc(num)))
}

/**
 * 把一个数钳制为 `0–100` 的整数分数；非有限值返回 `undefined`。
 *
 * @param value - 任意输入。
 */
function couplingScore(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return undefined
  return Math.min(100, Math.max(0, Math.trunc(num)))
}

/**
 * 校验并截断一个可解析的 ISO 时间戳字符串；不合法返回 `undefined`。
 *
 * @param value - 任意输入。
 */
function couplingAt(value) {
  if (typeof value !== 'string') return undefined
  const text = value.slice(0, COUPLING_AT_CAP)
  return Number.isFinite(Date.parse(text)) ? text : undefined
}

/**
 * 清洗节点级 `coupling` 对象（v1.2）。未知键丢弃、数字钳制（只截断，绝不
 * 抛错）、`level` 必须是 `low|medium|high` 之一。没有任何有效内容时返回
 * `undefined`，调用方据此删掉字段，让 v1.2 之前的图保持逐字节不变。
 *
 * @param raw - 任意输入。
 * @returns 清洗后的耦合标注，或 `undefined`。
 */
export function normalizeCoupling(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const level = raw.level === 'low' || raw.level === 'medium' || raw.level === 'high' ? raw.level : undefined
  const score = couplingScore(raw.score)
  if (level === undefined || score === undefined) return undefined
  const intra = couplingScore(raw.intra) ?? 0
  const inter = couplingScore(raw.inter) ?? 0
  const at = couplingAt(raw.at)
  const metricsIn = raw.metrics !== null && typeof raw.metrics === 'object' && !Array.isArray(raw.metrics) ? raw.metrics : {}
  const metrics = {}
  for (const key of COUPLING_METRIC_INTS) {
    metrics[key] = couplingInt(metricsIn[key]) ?? 0
  }
  const density = Number(metricsIn.density)
  metrics.density = Number.isFinite(density) ? Math.round(Math.min(1, Math.max(0, density)) * 100) / 100 : 0
  metrics.parsed = metricsIn.parsed === true
  return { level, score, intra, inter, metrics, ...(at !== undefined ? { at } : {}) }
}

/**
 * 清洗图级 `meta.coupling` 对象（v1.2）：全项目判定 + tasks 视图镜像上的
 * `source:'modules'` 标记。`overall` 块必须形状合法，否则整个键丢弃；
 * modules 图自身的版本不带 `source`，镜像必须恰好携带 `'modules'`。
 *
 * @param raw - 任意输入。
 * @param options - `{ mirror }` 为 true 时校验镜像约束（tasks 视图侧）。
 * @returns 清洗后的 meta.coupling，或 `undefined`。
 */
export function normalizeMetaCoupling(raw, { mirror = false } = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const overallIn = raw.overall !== null && typeof raw.overall === 'object' && !Array.isArray(raw.overall) ? raw.overall : undefined
  if (overallIn === undefined) return undefined
  const level = overallIn.level === 'low' || overallIn.level === 'medium' || overallIn.level === 'high' ? overallIn.level : undefined
  const score = couplingScore(overallIn.score)
  if (level === undefined || score === undefined) return undefined
  const overall = {
    level,
    score,
    modules: couplingInt(overallIn.modules) ?? 0,
    analyzed: couplingInt(overallIn.analyzed) ?? 0,
    cycles: couplingInt(overallIn.cycles) ?? 0,
    partial: overallIn.partial === true,
  }
  const worstIn = overallIn.worst !== null && typeof overallIn.worst === 'object' && !Array.isArray(overallIn.worst) ? overallIn.worst : undefined
  if (worstIn !== undefined && typeof worstIn.id === 'string' && worstIn.id.length > 0) {
    overall.worst = {
      id: worstIn.id.slice(0, 64),
      title: typeof worstIn.title === 'string' ? worstIn.title.slice(0, 80) : worstIn.id.slice(0, 64),
      score: couplingScore(worstIn.score) ?? 0,
    }
  }
  const version = couplingInt(raw.version, 1_000_000)
  const root = typeof raw.root === 'string' ? stripControlChars(raw.root) : ''
  const at = couplingAt(raw.at)
  if (mirror && raw.source !== 'modules') return undefined
  if (raw.source !== undefined && raw.source !== 'modules') return undefined
  return {
    ...(Number.isFinite(version) ? { version } : { version: 1 }),
    ...(root.length > 0 ? { root } : {}),
    ...(at !== undefined ? { at } : {}),
    overall,
    // `source:'modules'` 标记这是来自模块结构图的镜像；modules 图自身没有它。
    ...(raw.source === 'modules' ? { source: 'modules' } : {}),
  }
}

/* =========================================================== 图信封 ===== */

/**
 * 把任意值收敛成合法的 `codeflow/1` 图信封，但不丢调用方的节点载荷。
 *
 * 画布是节点几何与控件值的权威，所以这里只守护信封：可识别的 `format`、
 * 整数 `rev`、以及"成员是带字符串 id 的对象"的 nodes 数组。畸形 link 直接
 * 丢弃而不修复——端点缺失的连线本来也无法渲染。
 *
 * @param raw - 来自浏览器或 agent 的候选图。
 * @returns 归一后的图；输入根本不可能是图时返回 `undefined`。
 */
export function normalizeGraph(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : []
  const sane = []
  const seen = new Set()
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    const id = typeof node.id === 'string' && node.id.length > 0 ? node.id : undefined
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const clean = {
      ...node,
      id,
      type: typeof node.type === 'string' ? node.type : 'requirement',
      title: typeof node.title === 'string' ? node.title : id,
      pos: Array.isArray(node.pos) && node.pos.length === 2 ? [Number(node.pos[0]) || 0, Number(node.pos[1]) || 0] : [0, 0],
      params: node.params !== null && typeof node.params === 'object' ? node.params : {},
      status: NODE_STATUSES.has(node.status) ? node.status : 'pending',
      result: typeof node.result === 'string' ? node.result : '',
      detail: typeof node.detail === 'string' ? node.detail : '',
    }
    // 交付字段是可选的：至少一条有效条目存活才保留，让 v0.5.0 之前的旧图
    // 保持逐字节不变。
    const artifacts = normalizeArtifacts(node.artifacts)
    if (artifacts === undefined) delete clean.artifacts
    else clean.artifacts = artifacts
    const presented = normalizePresented(node.presented)
    if (presented === undefined) delete clean.presented
    else clean.presented = presented
    // v1.2：coupling 是可选节点字段——只有通过白名单才保留，同理保旧图。
    const coupling = normalizeCoupling(node.coupling)
    if (coupling === undefined) delete clean.coupling
    else clean.coupling = coupling
    sane.push(clean)
  }
  const links = (Array.isArray(raw.links) ? raw.links : []).filter((link) => {
    if (!Array.isArray(link) || link.length < 4) return false
    return seen.has(link[0]) && seen.has(link[2])
  })
  const project = raw.project !== null && typeof raw.project === 'object' && !Array.isArray(raw.project)
    ? raw.project
    : null
  // v1.2：`meta.coupling` 走同一份白名单；浅拷贝保持键序（因而保持字节），
  // 没有 coupling 字段的 meta 原样通过。
  const metaSource = raw.meta !== null && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {}
  const meta = { ...metaSource }
  const metaCoupling = normalizeMetaCoupling(metaSource.coupling)
  if (metaCoupling === undefined) delete meta.coupling
  else meta.coupling = metaCoupling
  return {
    format: 'codeflow/1',
    rev: Number.isFinite(raw.rev) ? Math.trunc(raw.rev) : 0,
    project,
    nodes: sane,
    links,
    meta,
  }
}

/**
 * 一张空图——画布的空白起点。
 *
 * @returns 形状完整的空 `codeflow/1` 图。
 */
export function emptyGraph() {
  return { format: 'codeflow/1', rev: 0, project: null, nodes: [], links: [], meta: {} }
}
