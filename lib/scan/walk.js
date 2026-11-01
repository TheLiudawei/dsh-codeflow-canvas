/**
 * 目录扫描：跳过清单、语言识别表与有界目录遍历。
 *
 * 这是"确定性导入"家族（任务流水线 importer、模块结构 analyst、功能归属
 * features、耦合分析 coupling）共用的地基：四家都要回答"这个目录里有哪些
 * 源码文件、各是什么语言"。原来这张表和 `walk` 长在 importer.js 里，其余
 * 三家反过来 import 导入模块——本模块把它们归位为独立一层。
 *
 * 预算语义：扫描永远有界（文件数、目录深度双上限），超限先保源码扩展名
 * 文件（source-first），其余只填补剩余预算。`walk` 绝不抛错：无权限目录、
 * 消失的条目都安静跳过——一次导入不该被一个坏目录打断。
 *
 * 依赖方向：只依赖 `node:*`（第 1 层，可依赖 core，但这里连 core 都不需要）。
 *
 * @module dsh-codeflow-canvas/scan/walk
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'

/* ------------------------------------------------------------ 跳过清单 --- */

/** 扫描永不进入的目录：`.undo` 是运行备份、其余是依赖/产物/IDE 元数据。 */
export const SKIP_DIRS = new Set([
  '.git', '.undo', 'node_modules', 'venv', '.venv', 'env', '__pycache__', 'dist',
  'build', 'out', '.idea', '.vscode', 'vendor', 'target', 'bin', 'obj',
])

/** 计数但永不读取的扩展名（二进制 / 媒体 / 压缩包）。 */
export const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns',
  'pdf', 'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'bz2', 'xz',
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'wav', 'flac', 'ogg',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dll', 'so', 'dylib', 'class', 'jar', 'pyc', 'pyd', 'wasm',
  'db', 'sqlite', 'sqlite3', 'psd', 'bin', 'dat',
])

/** 语言 → 扩展名，镜像 import-analysis.md §2。 */
export const LANG_EXTS = new Map([
  ['python', ['py', 'pyw']],
  ['javascript', ['js', 'mjs', 'cjs', 'jsx']],
  ['typescript', ['ts', 'tsx']],
  ['java', ['java']],
  ['go', ['go']],
  ['rust', ['rs']],
  ['c/cpp', ['c', 'h', 'cpp', 'hpp', 'cc']],
  ['csharp', ['cs']],
  ['ruby', ['rb']],
  ['php', ['php']],
  ['swift', ['swift']],
  ['kotlin', ['kt']],
  ['html/css', ['html', 'htm', 'css', 'scss', 'vue']],
  ['shell', ['sh', 'bash', 'ps1']],
])

/** 扩展名（小写）→ 语言，由 {@link LANG_EXTS} 派生。 */
export const EXT_LANG = new Map()
for (const [language, extensions] of LANG_EXTS) {
  for (const extension of extensions) EXT_LANG.set(extension, language)
}

/** 锁文件及其同类：永不读取，只计数。 */
export const LOCK_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
  'Pipfile.lock', 'poetry.lock', 'Cargo.lock', 'composer.lock', 'go.sum', 'Gemfile.lock',
])

/** 语言键的短展示标签（结果行与模块节点标题共用）。 */
const SHORT_LABEL = new Map([
  ['python', 'Python'], ['javascript', 'JS'], ['typescript', 'TS'], ['java', 'Java'],
  ['go', 'Go'], ['rust', 'Rust'], ['c/cpp', 'C/C++'], ['csharp', 'C#'], ['ruby', 'Ruby'],
  ['php', 'PHP'], ['swift', 'Swift'], ['kotlin', 'Kotlin'], ['html/css', 'HTML/CSS'],
  ['shell', 'Shell'], ['unknown', '未知'],
])

/* 扫描预算（文件数/深度上限与缺省值）是**各消费方自己的策略**：导入默认
 * 200 文件/4 层、耦合分析默认 1000 文件/6 层——由调用方在 walk 的参数上
 * 自行钳制，这里不设统一助手，避免把策略差异藏进参数里。 */

/**
 * 语言键的短展示标签；未知语言原样返回。
 *
 * @param language - 语言键（`LANG_EXTS` 的键或 `'unknown'`）。
 */
export function shortLabel(language) {
  return SHORT_LABEL.get(language) ?? language
}

/**
 * 判断一个相对路径是否像测试文件（文件名或路径段命中 test/spec 惯例）。
 * 导入流程用它决定要不要补 `testgen` 节点；语言统计用它算 hasTests。
 *
 * @param rel - `/` 分隔的相对路径。
 */
export function looksLikeTest(rel) {
  const base = rel.split('/').pop() ?? ''
  if (/(^|[.\-_])(test|spec)[.\-_]/i.test(base) || /^test_/i.test(base)) return true
  return rel.split('/').some((segment) => /^(tests?|__tests__)$/i.test(segment))
}

/**
 * 有界目录遍历：按跳过清单与深度/文件预算列出候选文件。
 *
 * 源码扩展名文件进 `sources` 桶、其余进 `others` 桶；两个桶都越过预算
 * 一截才停（保证末尾的 source-first 重排总有足够候选）。返回时先取源码
 * 再用 others 填满预算。
 *
 * @param root - 要扫描的根目录（绝对路径）。
 * @param options - `{ maxDepth }` 目录深度上限（1 = 只看根下一层）；
 *   `{ maxFiles }` 文件预算。
 * @returns `{ files, truncated }`；`files` 是
 *   `{ rel, abs, ext, language }`（二进制/锁文件的 `language` 为 `undefined`）。
 */
export async function walk(root, { maxDepth, maxFiles }) {
  const sources = []
  const others = []
  let overflow = false

  /** 有界深度优先；`depth` 1 = 根的直接子层。 */
  async function visit(dir, depth) {
    if (overflow && sources.length > maxFiles && others.length > maxFiles) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.endsWith('.egg-info')) continue
        if (depth < maxDepth) await visit(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).slice(1).toLowerCase()
      const rel = path.relative(root, abs).split(path.sep).join('/')
      const isSkip = BINARY_EXTS.has(ext) || LOCK_FILES.has(entry.name) || /\.min\.[cm]?js$/.test(entry.name)
      const language = isSkip ? undefined : EXT_LANG.get(ext)
      const bucket = language !== undefined ? sources : others
      // 两个桶都明显越过预算才停：末尾的 source-first 重排才有得挑。
      if (bucket.length >= maxFiles + maxFiles) { overflow = true; continue }
      bucket.push({ rel, abs, ext, language })
    }
  }

  await visit(root, 1)
  const files = sources.slice(0, maxFiles)
  for (const file of others) {
    if (files.length >= maxFiles) { overflow = true; break }
    files.push(file)
  }
  return { files, truncated: overflow || sources.length > maxFiles || files.length >= maxFiles && others.length > 0 }
}

/**
 * 统计扫描出的文件清单：按语言计数、识别测试文件。
 *
 * @param files - {@link walk} 产出的文件数组。
 * @returns `{ languages, primary, statRows, binaryCount, otherCount, hasTests }`。
 */
export function languageStats(files) {
  const languages = new Map()
  let binaryCount = 0
  let otherCount = 0
  let hasTests = false
  for (const file of files) {
    if (file.language === undefined) { binaryCount += 1; continue }
    if (EXT_LANG.get(file.ext) !== undefined) languages.set(file.language, (languages.get(file.language) ?? 0) + 1)
    else otherCount += 1
    if (looksLikeTest(file.rel)) hasTests = true
  }
  const statRows = [...languages.entries()].sort((left, right) => right[1] - left[1])
  return { languages, primary: statRows[0]?.[0] ?? 'unknown', statRows, binaryCount, otherCount, hasTests }
}
