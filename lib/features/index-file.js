/**
 * features.json 的形状与宽容 IO：索引清洗、读、原子写、过期判断。
 *
 * 「宽容解析」是本模块的契约：坏字段丢弃、同一文件最多警告一次、绝不抛错
 * 让菜单崩。关键字段（features/unmapped/manual）类型不对时打 `_degraded`
 * 标记，读侧据此走「识别兜底」。内部标记（`_degraded`/`unavailable`）只在
 * 内存里存在，**绝不落盘**（writeFeatureIndex 写前重新 sanitize）。
 *
 * 持久键是 files（相对源码根、`/` 分隔，经 `core/path.cleanRelPath` 归一）；
 * `nodes` 只是本次图的缓存，重建时按 files 重新映射到节点 id。
 *
 * 依赖方向：core/*、features/constants ← 本模块 ← detect / apply / map / ops。
 *
 * @module dsh-codeflow-canvas/features/index-file
 */
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteFile } from '../core/fsio.js'
import { cleanRelPath, relUnderRoot } from '../core/path.js'
import { MAX_ALIASES, MAX_EVIDENCE } from './constants.js'

/** 与 workflow.json 同目录的索引文件名。 */
export const FEATURES_FILE = 'features.json'

const warnedFiles = new Set()

/** 同一文件只警告一次（进程内）。 */
function warnOnce(file, message) {
  if (warnedFiles.has(file)) return
  warnedFiles.add(file)
  console.warn(`codeflow: ${message}`)
}

/* --------------------------------------------------------- 路径/名称清洗 --- */

/** 归一一个相对路径：`/` 分隔、去 `./` 前缀与尾 `/`（core 通用化的历史别名）。 */
export function cleanRel(value) {
  return cleanRelPath(value)
}

/** 绝对路径 → 相对源码根的 rel（Windows/POSIX 分隔符与盘符大小写都宽容）。 */
export function relOf(abs, root) {
  return relUnderRoot(abs, root)
}

/** 清洗一个功能名：非空、≤40 字符、去掉首尾空白与多余引号。 */
export function cleanFeatureName(value) {
  const text = String(value ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim()
  return text.length > 0 ? text.slice(0, 40) : ''
}

/** 功能 id：`f-` + 安全化名称（同名去重由调用方处理）。 */
export function featureIdOf(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
  return slug.length > 0 ? `f-${slug}` : 'f'
}

/* ------------------------------------------------------------------ 空值 --- */

/** 一个形状完整、空的索引（也是坏文件的回退值）。 */
export function emptyIndex() {
  return {
    version: 1,
    generatedAt: null,
    source: 'auto',
    features: [],
    unmapped: [],
    manual: emptyManual(),
  }
}

/** manual 段的标准形状（含扩展键 dissolved / excluded，见 apply.js 的说明）。 */
export function emptyManual() {
  return { labels: {}, renames: {}, aliases: {}, merged: {}, dissolved: [], excluded: {} }
}

/* ------------------------------------------------------------- 宽容解析 --- */

/** 清洗 manual 段：形状不对的键整体丢弃，值归一为字符串数组/字符串。（内部助手） */
export function sanitizeManual(raw) {
  const out = emptyManual()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const listOfNames = (value) => {
    if (!Array.isArray(value)) return null
    const list = [...new Set(value
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => cleanFeatureName(entry))
      .filter(Boolean))].slice(0, 12)
    return list.length > 0 ? list : null
  }
  const mapOfLists = (value, into) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    for (const [key, list] of Object.entries(value)) {
      const cleaned = listOfNames(list)
      if (cleaned !== null) into[cleanRel(key) || key.trim()] = cleaned
    }
  }
  const mapOfStrings = (value, into) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    for (const [key, target] of Object.entries(value)) {
      if (typeof target !== 'string' || target.trim().length === 0) continue
      into[key.trim()] = cleanFeatureName(target)
    }
  }
  mapOfLists(raw.labels, out.labels)
  mapOfLists(raw.excluded, out.excluded)
  mapOfStrings(raw.renames, out.renames)
  mapOfStrings(raw.merged, out.merged)
  mapOfStrings(raw.aliases, out.aliases)
  if (Array.isArray(raw.dissolved)) {
    out.dissolved = [...new Set(raw.dissolved
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => cleanFeatureName(entry))
      .filter(Boolean))].slice(0, 60)
  }
  return out
}

/** 清洗一个 feature 条目；无法挽回（没有名字）时返回 undefined。 */
function sanitizeFeature(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const name = cleanFeatureName(raw.name)
  if (!name) return undefined
  const files = (Array.isArray(raw.files) ? raw.files : [])
    .map((entry) => cleanRel(entry))
    .filter(Boolean)
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : [])
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 60))
    .slice(0, MAX_ALIASES)
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 80))
    .slice(0, MAX_EVIDENCE)
  const confidence = Number.isFinite(Number(raw.confidence))
    ? Math.min(1, Math.max(0, Number(raw.confidence)))
    : 0.5
  return {
    ...(typeof raw.id === 'string' && raw.id.length > 0 ? { id: raw.id } : {}),
    name,
    aliases,
    files: [...new Set(files)].slice(0, 200),
    nodes: [...new Set(nodes)],
    confidence,
    evidence,
  }
}

/**
 * 宽容清洗整份索引：坏字段丢弃；关键字段（features/manual）类型不对时打上
 * `_degraded` 标记（读侧据此走「识别兜底」，不抛错）。未知内部字段（如
 * `unavailable`）不会进入结果。
 */
export function sanitizeIndex(raw) {
  const index = emptyIndex()
  let degraded = false
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    index._degraded = true
    return index
  }
  if (typeof raw.version === 'number' && Number.isFinite(raw.version)) index.version = Math.trunc(raw.version)
  if (typeof raw.generatedAt === 'string' && raw.generatedAt.length > 0) index.generatedAt = raw.generatedAt
  if (typeof raw.source === 'string' && raw.source.length > 0) index.source = raw.source
  if (Array.isArray(raw.features)) {
    index.features = raw.features.map(sanitizeFeature).filter(Boolean)
  } else if (raw.features !== undefined) {
    degraded = true
  }
  if (Array.isArray(raw.unmapped)) {
    index.unmapped = raw.unmapped.filter((entry) => typeof entry === 'string' && entry.length > 0).slice(0, 500)
  } else if (raw.unmapped !== undefined) {
    degraded = true
  }
  if (raw.manual !== null && typeof raw.manual === 'object' && !Array.isArray(raw.manual)) {
    index.manual = sanitizeManual(raw.manual)
  } else if (raw.manual !== undefined) {
    degraded = true
  }
  index._degraded = degraded
  return index
}

/**
 * 读 `features.json`。文件不存在 → `null`（调用方决定是否自动识别）；
 * 损坏 → 空索引 + `_degraded`，同一文件最多 `console.warn` 一次，绝不抛错。
 */
export async function readFeatureIndex(dir) {
  const file = path.join(dir, FEATURES_FILE)
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    warnOnce(file, `features.json 无法解析（${String(error?.message ?? error)}），本次走识别兜底`)
    const index = emptyIndex()
    index._degraded = true
    return index
  }
  const index = sanitizeIndex(parsed)
  if (index._degraded) warnOnce(file, 'features.json 存在类型不对的字段（features/unmapped/manual），坏字段已丢弃')
  return index
}

/**
 * 原子写 `features.json`（core/fsio.atomicWriteFile：临时文件 → rename）。
 * 写入前重新 sanitize：内部标记（`_degraded`/`unavailable`）不落盘。
 */
export async function writeFeatureIndex(dir, index) {
  const clean = sanitizeIndex(index)
  clean.version = 1
  if (typeof clean.generatedAt !== 'string' || clean.generatedAt.length === 0) {
    clean.generatedAt = new Date().toISOString()
  }
  await atomicWriteFile(path.join(dir, FEATURES_FILE), JSON.stringify(clean))
  return clean
}

/** 索引是否比图文件旧（任一视图的 workflow 文件 mtime 晚于 generatedAt）。 */
export async function computeStale(index, dir) {
  if (index === null || index === undefined) return true
  const generatedAt = Date.parse(index.generatedAt ?? '')
  if (!Number.isFinite(generatedAt)) return true
  for (const fileName of ['workflow.json', 'workflow.modules.json']) {
    try {
      const info = await stat(path.join(dir, fileName))
      if (info.mtimeMs > generatedAt) return true
    } catch {
      // 该视图没有文件：不影响 stale 判断。
    }
  }
  return false
}
