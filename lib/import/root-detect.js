/**
 * 项目根目录解析（v1.2.2，需求二）——「空壳导入」修复的纯逻辑半边。
 *
 * 术语（任务书 §7.1，与测试名一一对应）：
 *
 *   - 常规文件/real file：普通文件，排除元数据（.DS_Store / Thumbs.db /
 *     desktop.ini / __MACOSX / ~$*）。符号链接与 Junction 不算文件、不跟随。
 *   - 弱文件/weak file：README*、LICENSE*、CHANGELOG* 等——只证明「目录里有
 *     点东西」，不能证明「这就是项目根」。
 *   - 强直接文件/strong direct file：当前层的常规文件，排除弱文件与元数据。
 *     根下出现强直接文件时停止去壳（outer/main.py + outer/proj/package.json
 *     必须根=outer，绝不下钻）。
 *   - 有内容目录/content-bearing dir：递归（有界）至少含一个常规文件。
 *   - 空壳/empty shell：只含目录、没有任何常规文件的子树。
 *   - 项目标记/project marker：.git、package.json、pyproject.toml、Cargo.toml…
 *     （README、LICENSE 不算——很多外壳里也有）。
 *   - 源码目录/SOURCE_DIRS：src/lib/app/…/源码/代码——项目内部目录，
 *     **不能**因为它是唯一子目录就上卷（proj/src 必须保留 proj）。
 *   - 外壳名/SHELL_NAMES：新建文件夹/extract/download/repo/… 以及 *-main/-master。
 *
 * 已确认的产品决策（写进测试名的硬约束）：
 *
 *   1. 正常项目 `proj/src/main.py`（proj 根下没有文件、没有标记）必须保留
 *      `proj`——禁止「无文件 + 唯一子目录就无限下钻」。
 *   2. 只有信号足够明确才去壳：子目录带项目标记；或子目录名是明显外壳名/
 *      与父同名/父是外壳名；或压缩包/上传目录的最外层按既有语义剥**一层**。
 *   3. 单链外壳但信号不足 → `ambiguous:true`，调用方 400 `SHELL_AMBIGUOUS`，
 *      绝不猜；空壳（没有任何常规文件）→ `hasContent:false`，调用方 400。
 *   4. 多个内容子目录（多项目父目录）不 400：保留当前根，`multiProject:true`。
 *
 * 依赖方向：本模块是 L0——只允许 `node:path` 与注入的 `{ readdir, lstat }`；
 * 禁止 import store/http/duo/importer/coupling。
 *
 * @module dsh-codeflow-canvas/import/root-detect
 */
import path from 'node:path'

/* ------------------------------------------------------------ 词汇表 ----- */

/** 元数据文件/目录：永远不算「内容」。 */
export const METADATA_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
export const METADATA_DIR_NAMES = new Set(['__MACOSX'])

/** Office 临时文件（~$xxx.docx）形状。 */
export function isOfficeTemp(name) {
  return /^~\$/.test(name)
}

/** 元数据条目（文件或目录名）。 */
export function isMetadataName(name) {
  return METADATA_NAMES.has(name) || METADATA_DIR_NAMES.has(name) || isOfficeTemp(name)
}

/** 弱文件名（README*、LICENSE*、CHANGELOG* 等）：证明有东西，不证明是根。 */
export function isWeakFileName(name) {
  if (METADATA_NAMES.has(name)) return true
  return /^(?:README|LICEN[CS]E|CHANGELOG|CONTRIBUTING|COPYING|NOTICE)(?:\..*)?$/i.test(name)
    || name === '.gitignore' || name === '.gitattributes' || name === '.editorconfig'
}

/** 项目标记（当前目录**直接**子项命中即算；README/LICENSE 这类弱文件不算）。 */
export function isProjectMarkerName(name) {
  if (name === '.git' || name === 'package.json' || name === 'pnpm-workspace.yaml'
    || name === 'package-lock.json' || name === 'yarn.lock'
    || name === 'pyproject.toml' || name === 'setup.py' || name === 'setup.cfg'
    || name === 'requirements.txt' || name === 'Pipfile'
    || name === 'Cargo.toml' || name === 'go.mod'
    || name === 'pom.xml' || name === 'build.gradle' || name === 'settings.gradle' || name === 'gradlew'
    || name === 'Gemfile' || name === 'composer.json'
    || name === 'CMakeLists.txt' || name === 'mix.exs' || name === 'pubspec.yaml'
    || name === 'Package.swift' || name === 'Makefile') return true
  return /\.(?:sln|csproj)$/i.test(name)
}

/** 项目内部目录名（出现它们 = 已经在项目里面，不能上卷）。 */
export const SOURCE_DIRS = new Set([
  'src', 'lib', 'app', 'source', 'pkg', 'internal', 'cmd',
  'test', 'tests', 'spec', 'e2e', 'unit', 'integration',
  'docs', 'doc', 'assets', 'public', 'static', 'scripts',
  'config', 'configs', 'include', 'java', 'python', 'web',
  'server', 'client', 'frontend', 'backend', 'packages', 'apps',
  'modules', 'bin', 'build', 'dist', 'tools', 'examples', 'samples',
  'resources', 'templates', 'migrations', 'models', 'views',
  'controllers', 'routes', 'services', 'utils', 'helpers',
  'components', 'pages', 'hooks', 'api', 'core', 'common', 'shared',
  'types', 'data', 'db', 'database', 'sql', 'proto', 'schemas',
  'locales', 'i18n', 'images', 'img', 'media',
  '源码', '代码',
])

/** 明显外壳名：只用于启发式，可测试、可导出、可解释。 */
export const SHELL_NAME_RULES = [
  /^新建文件夹/,
  /^新文件夹$/,
  /^项目$/,
  /^(?:extract|extracted|archive|download|downloads|upload|uploads|workspace|project|projects|repo|repository|code|files|content|tmp|temp)$/i,
  /-(?:main|master)$/i,
]

/** 目录名是否是明显外壳名。 */
export function isShellName(name) {
  const text = String(name ?? '')
  if (text.length === 0) return false
  return SHELL_NAME_RULES.some((re) => re.test(text))
}

/** 判定遍历时要忽略的目录（构建产物/依赖/元数据——它们不算「内容」）。 */
export const IGNORED_DIRS = new Set([
  '__MACOSX', 'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', 'vendor', 'target',
  '.venv', 'venv', '__pycache__', '.idea', '.vscode',
])

/* ------------------------------------------------------------ 默认上限 --- */

export const ROOT_DETECT_LIMITS = Object.freeze({
  maxUnwrap: 8,
  maxDepth: 12,
  maxFiles: 200,
})

/* ------------------------------------------------------------ 探测器 ----- */

/**
 * 创建一个根目录探测器。
 *
 * @param options.readdir - `fs.promises.readdir` 形状（`withFileTypes: true`）。
 * @param options.lstat - `fs.promises.lstat` 形状（下钻前复核目录本体；
 *   绝不 `stat`——Junction/symlink 一律当链接跳过，不跟随）。
 * @param options.limits - 上限覆盖（测试用）。
 * @returns 探测器（纯逻辑方法集）。
 */
export function createRootDetector(options = {}) {
  const readdir = options.readdir ?? (async () => [])
  const lstat = options.lstat ?? (async () => undefined)
  const limits = { ...ROOT_DETECT_LIMITS, ...(options.limits ?? {}) }

  /** 带符号链接防御的子项列举：跳过符号链接/Junction 条目。 */
  async function listEntries(dir) {
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue
      out.push({
        name: dirent.name,
        path: path.join(dir, dirent.name),
        isDirectory: dirent.isDirectory(),
        isFile: dirent.isFile(),
      })
    }
    return out
  }

  /** 下钻前的目录本体复核：lstat（不跟随）确认它是目录且不是链接。 */
  async function isRealDirectory(dir) {
    try {
      const info = await lstat(dir)
      return info !== undefined && info.isDirectory() === true && info.isSymbolicLink() !== true
    } catch {
      return false
    }
  }

  /**
   * 递归（有界）「目录里有没有常规文件」。忽略元数据与 IGNORED_DIRS；
   * 超限按「没找到」处理并记 truncated。
   */
  async function hasRealFile(dir, state) {
    const st = state ?? { files: 0, depth: 0, truncated: false }
    if (st.depth > limits.maxDepth) { st.truncated = true; return false }
    if (!(await isRealDirectory(dir))) return false
    const entries = await listEntries(dir)
    for (const entry of entries) {
      st.files += 1
      if (st.files > limits.maxFiles) { st.truncated = true; return false }
      if (isMetadataName(entry.name)) continue
      if (entry.isFile) return true
      if (entry.isDirectory && !IGNORED_DIRS.has(entry.name)) {
        st.depth += 1
        const found = await hasRealFile(entry.path, st)
        st.depth -= 1
        if (found) return true
      }
    }
    return false
  }

  /** 当前层（不递归）的直接常规文件里有没有「强」文件。 */
  async function hasStrongDirectFile(dir) {
    const entries = await listEntries(dir)
    for (const entry of entries) {
      if (entry.isFile && !isMetadataName(entry.name) && !isWeakFileName(entry.name)) return true
    }
    return false
  }

  /** 当前层**直接子项**是否命中项目标记（不递归——防 outer 被深处标记误判）。 */
  async function isProjectRoot(dir) {
    const entries = await listEntries(dir)
    for (const entry of entries) {
      if (isProjectMarkerName(entry.name)) return true
    }
    return false
  }

  /** 内容子目录（忽略元数据/空壳/IGNORED_DIRS；共享一个有界状态）。 */
  async function contentChildDirs(dir, state) {
    const entries = await listEntries(dir)
    const out = []
    for (const entry of entries) {
      if (!entry.isDirectory) continue
      if (isMetadataName(entry.name) || IGNORED_DIRS.has(entry.name)) continue
      if (await hasRealFile(entry.path, state)) out.push(entry)
    }
    return out
  }

  /**
   * 沿「唯一内容子目录」链向下找第一个带项目标记的目录。
   * 停止条件：多个内容子目录 / 当前层有强直接文件 / 唯一子目录是 SOURCE_DIRS /
   * 超过 maxUnwrap。找不到返回 `null`（绝不跨过强文件层，绝不钻进 src/lib）。
   */
  async function findMarkerRoot(start, state) {
    let current = start
    let steps = 0
    for (;;) {
      if (await isProjectRoot(current)) return { root: current, steps }
      if (steps >= limits.maxUnwrap) { state.truncated = true; return null }
      if (await hasStrongDirectFile(current)) return null
      const children = await contentChildDirs(current, state)
      if (children.length !== 1) return null
      const child = children[0]
      if (SOURCE_DIRS.has(child.name)) return null
      current = child.path
      steps += 1
    }
  }

  /**
   * 主入口：解析 `start` 的真实项目根。
   *
   * @param start - 绝对目录路径。
   * @param options.mode - `'archive'`（压缩包解压/上传目录）或 `'path'`（用户路径导入）。
   * @returns `{ root, unwrappedDepth, ignoredEmptyDirs, ambiguous, ambiguousCandidates,
   *   multiProject, reason, truncated, hasContent }`。
   */
  async function detectProjectRoot(start, { mode = 'path' } = {}) {
    const result = {
      root: start,
      unwrappedDepth: 0,
      ignoredEmptyDirs: 0,
      ambiguous: false,
      ambiguousCandidates: [],
      multiProject: false,
      reason: 'root',
      truncated: false,
      hasContent: true,
    }
    if (typeof start !== 'string' || start.length === 0) {
      result.hasContent = false
      result.reason = 'invalid-start'
      return result
    }
    // 盘符根/文件系统根绝不能当项目根。
    if (path.parse(start).root === start) {
      result.hasContent = false
      result.reason = 'fs-root'
      return result
    }
    const state = { files: 0, depth: 0, truncated: false }
    const syncTruncated = () => { if (state.truncated) result.truncated = true }

    if (!(await hasRealFile(start, state))) {
      syncTruncated()
      result.hasContent = false
      result.reason = 'empty-shell'
      return result
    }

    let current = start

    if (mode === 'archive') {
      /* 最外层**一次**既有语义（stripSingleRoot 的兼容面）：本层没有任何常规
         文件（README 也算文件——否则 `README + src/` 会被误剥），且忽略元数据/
         空壳后恰好一个内容子目录 → 下钻一层。只一层：多层的处理交给决策链
         （标记/外壳名），绝不「无文件 + 唯一目录」就无限下钻。 */
      const direct = await listEntries(current)
      const directHasFile = direct.some((e) => e.isFile && !isMetadataName(e.name))
      if (!directHasFile) {
        const children = await contentChildDirs(current, state)
        syncTruncated()
        if (children.length === 1) {
          current = children[0].path
          result.unwrappedDepth += 1
          result.ignoredEmptyDirs += Math.max(0, direct.filter((e) => e.isDirectory).length - 1)
        }
      }
    }

    /* 决策链（两条模式共用）。 */
    for (;;) {
      syncTruncated()
      if (result.unwrappedDepth > limits.maxUnwrap * 3) { // 病态保险，正常到不了
        result.truncated = true
        result.root = current
        result.reason = 'depth-limit'
        result.ambiguous = true
        return result
      }
      // 1. 项目标记 → 停
      if (await isProjectRoot(current)) { result.root = current; result.reason = 'marker'; return result }
      // 2. 强直接文件 → 停（根下已有强文件，不能再当外壳）
      if (await hasStrongDirectFile(current)) { result.root = current; result.reason = 'strong-file'; return result }
      // 3. 沿唯一内容子目录链找标记（能处理中间层无标记的多层壳）
      const found = await findMarkerRoot(current, state)
      syncTruncated()
      if (found) {
        result.root = found.root
        result.unwrappedDepth += found.steps
        result.reason = 'marker-below'
        return result
      }
      // 4. 唯一内容子目录的形状决定去留
      const children = await contentChildDirs(current, state)
      syncTruncated()
      if (children.length > 1) {
        // 多项目父目录：保留当前根，不猜。
        result.root = current
        result.multiProject = true
        result.reason = 'multi-project'
        return result
      }
      if (children.length === 0) {
        // 只剩文件/弱文件：当前就是根。
        result.root = current
        result.reason = 'leaf'
        return result
      }
      const child = children[0]
      if (SOURCE_DIRS.has(child.name)) {
        // proj/src 的关键保护：源码目录不是外壳，根保留在 proj（两种模式一致）。
        result.root = current
        result.reason = 'source-dir-child'
        return result
      }
      const childIsShell = isShellName(child.name)
      const sameName = child.name === path.basename(current)
      const currentIsShell = isShellName(path.basename(current))
      if (childIsShell || sameName || currentIsShell) {
        current = child.path
        result.unwrappedDepth += 1
        continue
      }
      // 信号不足：不猜，交给调用方 400。
      result.ambiguous = true
      result.ambiguousCandidates = [child.path]
      result.reason = result.truncated ? 'depth-limit' : 'ambiguous'
      result.root = current
      return result
    }
  }

  return {
    detectProjectRoot,
    findMarkerRoot,
    hasRealFile,
    hasStrongDirectFile,
    isProjectRoot,
    contentChildDirs,
    listEntries,
    limits,
  }
}

/* ------------------------------------------------------- 默认实例 -------- */
/* node:fs/promises 直接可用；测试/宿主注入自己的 fs 时用 createRootDetector。 */
import { lstat as defaultLstat, readdir as defaultReaddir } from 'node:fs/promises'

const defaultDetector = createRootDetector({ readdir: defaultReaddir, lstat: defaultLstat })

/** 便捷入口：见 {@link createRootDetector.detectProjectRoot}。 */
export function detectProjectRoot(start, options) {
  return defaultDetector.detectProjectRoot(start, options)
}

/** 便捷入口：递归（有界）「有没有常规文件」（元数据不算）。 */
export function hasRealFile(dir) {
  return defaultDetector.hasRealFile(dir, { files: 0, depth: 0, truncated: false })
}
