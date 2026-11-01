/**
 * 路径与命名：项目名安全化、项目桶键/目录推导、通用路径助手。
 *
 * 「项目叫什么、落在哪个目录」是全插件最基础的契约：画布内存桶键、磁盘
 * 目录名、侧车路径、撤销根目录都必须对同一个名字推导出同一个答案。这些
 * 规则原来散在 store.js（命名）和 importer.js（freeName）里，被 10+ 个
 * 模块交叉引用——把它们下沉到这里之后，`store.js ⇄ paths.js` 的 ESM 循环
 * 依赖得以斩断（paths.js 不再需要回头 import store）。
 *
 * 目录常量也定义在这里：`DEFAULT_DIR_NAME`（默认根名 `CodeFlow`）与
 * `FLOW_PROJECTS_DIR`（根下存放项目的固定段名 `flow-projects`）。paths.js
 * 负责可配置的根与覆盖，而这两个字面量本身属于命名契约。
 *
 * 依赖方向：本模块是第 0 层基础件，只 import `node:*`，不 import 任何 lib 代码。
 *
 * @module dsh-codeflow-canvas/core/path
 */
import path from 'node:path'

/* ------------------------------------------------------------ 目录常量 --- */

/** 默认根名：`<工作区>/CodeFlow`（用户可经 paths.js 配置改到别处）。 */
export const DEFAULT_DIR_NAME = 'CodeFlow'

/** 根之下存放所有项目目录的固定段名（任何自定义根都沿用这一段）。 */
export const FLOW_PROJECTS_DIR = 'flow-projects'

/* ------------------------------------------------------------ 项目命名 --- */

/** 图还没有项目名时使用的内存桶键。 */
export const UNTITLED_KEY = '__untitled__'

/**
 * 把项目名收敛成一个安全的单段目录名：汉字、ASCII 字母、数字、`-`、`_`
 * 保留，其余一律替换为 `-`；首尾连字符剥掉；最长 60 字符。
 *
 * @param name - 用户输入的项目名，可能为空。
 * @returns 非空的目录安全名称（空输入回退为 `untitled`）。
 */
export function safeProjectName(name) {
  const cleaned = String(name ?? '')
    .normalize('NFC')
    .replace(/[^\p{Script=Han}A-Za-z0-9_-]/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned.length > 0 ? cleaned : 'untitled'
}

/**
 * 项目名对应的内存桶键：正常情况下就是安全化项目名，但所有"没有可用
 * 拼写"的输入——空串、纯空白、`..` 之类的垃圾、以及字面量 `untitled`——
 * 都收敛进唯一的 `__untitled__` 桶。
 *
 * v0.5.2 之前这些输入会产生两个不同的内存桶（`untitled` 与
 * `__untitled__`），却都持久化到 `flow-projects/untitled/`，互相覆盖对方
 * 的文件（B9 现场问题）。本函数是那次修复的单一事实来源。
 *
 * @param name - 用户输入的项目名。
 * @returns 桶键（安全名或 {@link UNTITLED_KEY}）。
 */
export function projectKeyOf(name) {
  const text = typeof name === 'string' ? name.trim() : ''
  if (text.length === 0) return UNTITLED_KEY
  const safe = safeProjectName(text)
  return safe.toLowerCase() === 'untitled' ? UNTITLED_KEY : safe
}

/**
 * 桶键对应的磁盘目录名（`flow-projects/` 之下）。未命名桶保留历史拼写
 * `untitled/`，既有安装才能继续读；`projectKeyOf` 保证了任何**有名字**的
 * 项目都不可能占用同名目录。
 *
 * @param key - {@link projectKeyOf} 产出的桶键。
 */
export function projectDirOf(key) {
  return key === UNTITLED_KEY ? 'untitled' : String(key ?? 'untitled')
}

/**
 * 项目持久目录的**默认根拼写**：`<工作区>/CodeFlow/flow-projects/<目录名>`。
 *
 * 仅作为调用方没有经 `lib/paths.js` 解析可配置根时的回退；所有 HTTP/工具
 * 入口都会显式传入已解析的 `dir`。
 *
 * @param cwd - 工作区路径。
 * @param key - 项目桶键。
 */
export function projectDirPath(cwd, key) {
  return path.join(cwd, DEFAULT_DIR_NAME, FLOW_PROJECTS_DIR, projectDirOf(key))
}

/**
 * 为新项目找一个未占用的目录名：`base` → `base-flow` → `base-flow-2` → …
 *
 * @param base - 期望的基础名（应已过 {@link safeProjectName}）。
 * @param existing - 已被占用的名字集合（可迭代）。
 * @returns 第一个未占用的名字。
 */
export function freeName(base, existing) {
  const taken = new Set(existing ?? [])
  if (!taken.has(base)) return base
  for (let attempt = 1; ; attempt += 1) {
    const name = attempt === 1 ? `${base}-flow` : `${base}-flow-${attempt}`
    if (!taken.has(name)) return name
  }
}

/* ------------------------------------------------------------ 路径助手 --- */

/**
 * 包含性判断：`target` 必须解析落在 `root` 之内（不允许 `..` 越界逃逸，
 * 不允许 `root` 自身）。路径安全的关键闸门——删除/恢复/编辑匹配都靠它
 * 保证"只碰快照范围内/项目内的文件"。原 undo.js `contained` 与
 * activity.js `insidePath` 的逐字合并。
 *
 * @param root - 根目录（两侧都应是已归一的绝对路径）。
 * @param target - 待判断的目标路径。
 */
export function pathContains(root, target) {
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 宽松意义下的绝对路径判断：POSIX 绝对路径、Windows 盘符（`C:\`、`C:/`）
 * 与 UNC（`\\server\share`）都算。`path.isAbsolute` 在 POSIX 平台上不认
 * 盘符拼写，而用户输入（导入路径、配置项）恰恰常见这种形式。
 *
 * @param target - 待判断路径。
 */
export function isAbsolutePath(target) {
  return path.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('\\\\')
}

/**
 * 去掉字符串里的控制字符并修剪首尾空白（原 store.js `cleanArtifactPath`
 * 的核心原语）。交付物路径、耦合 root 等落盘字段都先过这里，保证 JSON
 * 里不会出现不可见字符。
 *
 * @param value - 任意输入。
 * @returns 清洗后的文本；超长（>1024）视为无效返回空串。
 */
export function stripControlChars(value) {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex -- 这里的目的就是剥控制字符
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
  return text.length > 0 && text.length <= 1024 ? text : ''
}

/**
 * 归一一个相对路径：`\` → `/`、去 `./` 前缀与首尾 `/`、剥控制字符
 * （原 features.js `cleanRel` 的通用化）。features.json 的持久键
 * （相对源码根、`/` 分隔）统一由它产出。
 *
 * @param value - 任意输入。
 * @returns 归一后的相对路径文本（可能为空串）。
 */
export function cleanRelPath(value) {
  return stripControlChars(value)
    .split('\\').join('/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '')
}

/**
 * 绝对路径 → 相对源码根的 rel。Windows 大小写不敏感：前缀匹配用小写比较，
 * 返回值保留原拼写。`abs` 不在 `root` 下时原样返回（调用方自行决定是否
 * 当作未匹配）。
 *
 * @param abs - 文件绝对路径（或任意路径文本）。
 * @param root - 源码根目录。
 * @returns 相对路径；`abs` 就是 `root` 时返回空串。
 */
export function relUnderRoot(abs, root) {
  const a = cleanRelPath(abs)
  const r = cleanRelPath(root)
  if (!a || !r) return a
  const lowerA = a.toLowerCase()
  const lowerR = r.toLowerCase()
  if (lowerA === lowerR) return ''
  if (lowerA.startsWith(`${lowerR}/`)) return a.slice(r.length + 1)
  return a
}

/**
 * 相对路径的"词干"：去掉目录与扩展名（`src/app/main.ts` → `main`）。
 * 符号匹配、路由名推导都用它。
 *
 * @param rel - 相对路径（`/` 分隔）。
 */
export function stemOf(rel) {
  return path.basename(String(rel ?? ''), path.extname(String(rel ?? '')))
}
