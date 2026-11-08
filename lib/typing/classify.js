/**
 * 类型判定规则（v1.5.0）——「这次运行实际改了什么 → 既有节点类型」的**唯一**
 * 规则表。纯函数：零 IO、零依赖（连 core 都不碰），输入是普通对象，输出只有
 * `{ type, reason }` 或 `null`（保持 `task`）。
 *
 * 分层：L1 领域（tests/architecture.mjs 显式登记）。上层（lib/typing/service.js
 * 的编排、lib/activity.js 的命令证据）都从这里取规则与正则——**其它任何文件
 * 不得再出现「什么改动算什么类型」的分类分支**。
 *
 * 刻意不做的事（硬要求，不是优化项）：
 *   - 不解析 `params.requirement`、不解析 `result`/`detail` 的自然语言——
 *     不做任何语义/关键词猜测；
 *   - 不把画布 16 类清单搬进来——只导出它真能产出的 6 个类型常量；
 *   - 未知扩展名一律「其他」，不参与分类（宁缺毋滥）。
 *
 * @module dsh-codeflow-canvas/typing/classify
 */

/** 识别只产出这 6 类（有证据才写；其余情况保持 `task`）。 */
export const PRODUCIBLE_TYPES = Object.freeze(['codegen', 'edit', 'testgen', 'docgen', 'testrun', 'shell'])

/**
 * 测试命令判定（唯一正则；lib/activity.js 的命令证据用它算 `isTest`，
 * 不在活动层再写第二套）。覆盖 pytest/unittest/jest/vitest/mocha/go test/
 * cargo test/npm·pnpm·yarn·mvn·gradle test/ctest 及常见等价形式。
 */
export const TEST_COMMAND_RE = new RegExp(
  '(?:^|[\\s"\'&|(])('
  + 'python3?\\s+-m\\s+pytest|python3?\\s+-m\\s+unittest|pytest|py\\.test|unittest(?!\\.mock)'
  + '|jest|vitest|mocha|karma|jasmine|tap\\s|ava\\s'
  + '|go\\s+test|cargo\\s+test|ctest|tox\\b|nose2?\\b|phpunit|rspec|behat'
  + '|dotnet\\s+test|mix\\s+test|stack\\s+test|cabal\\s+test|make\\s+test|ninja\\s+test'
  + '|npm\\s+(?:run\\s+)?[\\w:./@-]*test|pnpm\\s+(?:run\\s+)?[\\w:./@-]*test'
  + '|yarn\\s+(?:run\\s+)?[\\w:./@-]*test|bun\\s+(?:run\\s+)?[\\w:./@-]*test'
  + '|mvn\\s+[\\w:./-]*test|gradle(?:w)?\\s+[\\w:./-]*test'
  + ')(?:[\\s"\'&|)]|$)',
  'i',
)

/** 一条命令是否像测试命令（`classify.js` 导出，供 activity 与测试直接调用）。 */
export function isTestCommand(cmd) {
  const text = String(cmd ?? '')
  if (text.length === 0) return false
  return TEST_COMMAND_RE.test(text)
}

/* ------------------------------------------------------- 路径分类 ------- */

/** 测试目录段：tests/、test/、__tests__/、spec/。 */
const TEST_DIR_RE = /(?:^|\/)(?:tests?|__tests__|spec)\//
/** 测试文件名：test_*.py、*_test.py|go|rb|…（前/后缀下划线约定）。 */
const TEST_FILE_NAME_RE = /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rb|php)$/i
/** *.test.js / *.spec.ts 一类（jest/vitest/karma 命名）。 */
const TEST_DOT_SUFFIX_RE = /(?:^|\/)[^/]*\.(?:test|spec)\.(?:js|mjs|cjs|ts|tsx|jsx)$/i
/** JVM/C# 驼峰约定：Test*.java、FooTest.java、*Tests.cs……（大小写敏感防误伤 latest.java）。 */
const TEST_CAMEL_RE = /(?:^|\/)(?:Test[A-Za-z0-9_]*|[^/]*[a-z0-9](?:Test|Tests))\.(?:java|kt|kts|cs|swift)$/

/** 文档目录段：docs/、doc/、documentation/。 */
const DOC_DIR_RE = /(?:^|\/)(?:docs?|documentation)\//
/** 文档文件名：README*、CHANGELOG*、LICENSE*… 与 *.md|markdown|mdx|rst|adoc。 */
const DOC_FILE_RE = /(?:^|\/)(?:readme|changelog|license|licence|contributing|authors|notice|about|code_of_conduct)[^/]*$|(?:^|\/)[^/]*\.(?:md|markdown|mdx|rst|adoc)$/i

/** 已知源码/配置扩展名（spec 清单 + 仓库现有代码里常见的等价物）。 */
const CODE_EXTENSIONS = new Set([
  'py', 'pyw', 'pyi', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'mts', 'cts',
  'java', 'kt', 'kts', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cxx', 'hxx', 'cs',
  'rb', 'php', 'swift', 'm', 'mm', 'scala', 'dart', 'lua', 'pl', 'pm', 'r', 'jl',
  'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'hs', 'vim', 'vue', 'svelte', 'astro',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties',
  'xml', 'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl',
  'gradle', 'cmake', 'mk', 'proto', 'graphql', 'tf', 'hcl',
])

/** 无扩展名的已知源码/构建文件名。 */
const CODE_BASENAMES = new Set([
  'makefile', 'dockerfile', 'rakefile', 'gemfile', 'brewfile', 'vagrantfile', 'justfile', 'meson.build',
])

/**
 * 项目内相对路径 → `'test' | 'doc' | 'code' | null`。
 * 顺序即优先级：测试 > 文档 > 代码；`null` = 其他（未知扩展名），不参与分类。
 * 删除的文件也走同一判定（调用方把删除按「修改」计入对应类别）。
 *
 * @param {string} rel - 项目内相对路径（`/` 分隔；`\` 会被归一）。
 * @returns {'test'|'doc'|'code'|null}
 */
export function classifyPath(rel) {
  const text = String(rel ?? '').split('\\').join('/')
  if (text.length === 0) return null
  if (TEST_DIR_RE.test(text) || TEST_FILE_NAME_RE.test(text) || TEST_DOT_SUFFIX_RE.test(text) || TEST_CAMEL_RE.test(text)) return 'test'
  if (DOC_DIR_RE.test(text) || DOC_FILE_RE.test(text)) return 'doc'
  const name = text.slice(text.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (dot < 0 && CODE_BASENAMES.has(name.toLowerCase())) return 'code'
  return null
}

/* ------------------------------------------------------- 规则表 --------- */

/**
 * 判定输入的内部汇总。
 * `changed` 桶 = modified + deleted（删除按「修改」计入对应类别）。
 * @typedef {{hasFiles: boolean, hasTestCommand: boolean, hasShellCommand: boolean,
 *   codeAdded: number, codeChanged: number, testAdded: number, testChanged: number,
 *   docAdded: number, docChanged: number, unknown: number}} EvidenceShape
 */

/** 把 files/tools 证据收敛成规则表能读的形状（唯一入口，规则表只读这里）。 */
function summarize(evidence) {
  const files = evidence !== null && typeof evidence === 'object' ? evidence.files : null
  const tools = evidence !== null && typeof evidence === 'object' && Array.isArray(evidence.tools) ? evidence.tools : []
  const shape = {
    hasFiles: false,
    hasTestCommand: false,
    hasShellCommand: false,
    codeAdded: 0,
    codeChanged: 0,
    testAdded: 0,
    testChanged: 0,
    docAdded: 0,
    docChanged: 0,
    unknown: 0,
  }
  const addAll = (list, bucket) => {
    for (const rel of Array.isArray(list) ? list : []) {
      const category = classifyPath(rel)
      if (category === null) {
        shape.unknown += 1
        continue
      }
      shape[`${category}${bucket}`] += 1
    }
  }
  if (files !== null && typeof files === 'object') {
    addAll(files.added, 'Added')
    addAll(files.modified, 'Changed')
    addAll(files.deleted, 'Changed')
    shape.hasFiles = (Array.isArray(files.added) && files.added.length > 0)
      || (Array.isArray(files.modified) && files.modified.length > 0)
      || (Array.isArray(files.deleted) && files.deleted.length > 0)
  }
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue
    if (tool.kind === 'test') shape.hasTestCommand = true
    else if (tool.kind === 'shell') shape.hasShellCommand = true
  }
  return shape
}

/**
 * 有序声明式规则表：首个命中即返回。**所有**「什么改动算什么类型」的判断
 * 只写在这一张表里（对照任务书附录 C 的目标形态）。
 */
const RULES = Object.freeze([
  { when: (e) => !e.hasFiles && e.hasTestCommand, type: 'testrun', reason: 'testrun-command' },
  { when: (e) => !e.hasFiles && e.hasShellCommand, type: 'shell', reason: 'shell-command' },
  { when: (e) => e.codeChanged > 0, type: 'edit', reason: 'edit-existing-code' },
  { when: (e) => e.codeAdded > 0, type: 'codegen', reason: 'codegen-new-code' },
  { when: (e) => e.testAdded + e.testChanged > 0, type: 'testgen', reason: 'testgen-tests' },
  { when: (e) => e.docAdded + e.docChanged > 0, type: 'docgen', reason: 'docgen-docs' },
])

/**
 * 证据 → 类型。
 *
 * @param {{
 *   files: { added: string[], modified: string[], deleted: string[] } | null,
 *   tools: Array<{ kind: 'write'|'test'|'shell', paths?: string[], cmd?: string }>
 * }} evidence - `files` 为 null/不可得时只保留命令证据；路径都是项目内相对路径。
 * @returns {{ type: string, reason: string } | null} `null` = 保持 `task`。
 */
export function classifyChange(evidence) {
  const shape = summarize(evidence)
  for (const rule of RULES) {
    if (rule.when(shape)) return { type: rule.type, reason: rule.reason }
  }
  return null
}
