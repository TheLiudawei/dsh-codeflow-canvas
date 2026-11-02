/**
 * 需求一 · A 层：画布可点击控件的静态清单/接线审计（v1.2.2）。
 *
 * 零 npm 依赖、零 DOM、零网络：只对生成物 `assets/canvas/canvas.html` 与
 * 清单 `lib/ui/actions.js` 做文本级审计。它证明的是「没有漏绑」——每个
 * 控件都被登记、至少有一条绑定证据（直接绑定 / 模式表 / 事件委托 /
 * 选择器工厂）、启用状态有代码路径、菜单项都有 act 或非空 sub；
 * 「点了真的有反应」由 B 层（canvas-selftest.js）与 C 层（手工清单）负责。
 *
 * 审计规则（任务书 §6.4）：
 *   1. 清单完整性：静态按钮 id ⇄ 清单双向覆盖、data-act/data-b/data-run
 *      字面量都有清单项、菜单项都有 act/sub；
 *   2. 绑定存在性：直接绑定 / 循环绑定的模式表 / 事件委托 / 动态工厂；
 *      禁止空 handler；
 *   3. 启用状态：HTML 里 disabled/hidden 的控件必须有解除路径；
 *      `#cf-tb-coupling` 有专项断言（handler、running/modulesAvailable 引用、
 *      不存在无条件 disabled=true）；
 *   4. allowlist 只许平台相关/产品决定条目，过期条目报错；
 *   5. 快照：`tests/buttons/inventory.json` 是 surface→key 的稳定集合，
 *      清单增删必须同步快照；
 *   6. 生成物新鲜度：补丁/清单比生成物新 → 先跑 tools/port-canvas.mjs。
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/buttons.mjs
 */
import assert from 'node:assert/strict'
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CANVAS_ACTIONS, ENABLE_MARKERS } from '../lib/ui/actions.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// LF 归一：Windows 检出是 CRLF，而断言里有多处跨行原文标记。
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8').then((text) => text.replace(/\r\n/g, '\n'))

let passed = 0
const ok = (name) => { passed += 1; console.log('  ok ', name) }

/** 审计发现：按类别聚合，最后统一打印与落盘。 */
const findings = []
const finding = (category, entry, reason, hint) => {
  findings.push({ category, surface: entry?.surface ?? null, key: entry?.key ?? null, label: entry?.label ?? null, reason, hint })
}

/* ------------------------------------------------------------ 语料加载 --- */

const canvas = await read('assets/canvas/canvas.html')
const sources = {
  'tools/port-canvas.mjs': await read('tools/port-canvas.mjs'),
  'tools/patches/coupling-ui.js': await read('tools/patches/coupling-ui.js'),
  'tools/patches/drop-ui.js': await read('tools/patches/drop-ui.js'),
  'tools/patches/browse-ui.js': await read('tools/patches/browse-ui.js'),
  'tools/patches/features-ui.js': await read('tools/patches/features-ui.js'),
  'tools/patches/log-ui.js': await read('tools/patches/log-ui.js').catch(() => ''),
  'tools/patches/menu-ui.js': await read('tools/patches/menu-ui.js'),
  'tools/patches/cards-ui.js': await read('tools/patches/cards-ui.js'),
  'tools/patches/logview-ui.js': await read('tools/patches/logview-ui.js'),
  'lib/ui/actions.js': await read('lib/ui/actions.js'),
  'lib/ui/menu.js': await read('lib/ui/menu.js'),
  'lib/ui/menu-html.js': await read('lib/ui/menu-html.js'),
  'lib/ui/fit-popover.js': await read('lib/ui/fit-popover.js'),
}
const corpus = canvas

/* ------------------------------------------------------- 0. 生成物新鲜度 --- */

{
  const canvasStat = await stat(path.join(ROOT, 'assets/canvas/canvas.html'))
  const stale = []
  for (const rel of ['tools/port-canvas.mjs', 'tools/upstream/canvas-template.html', 'lib/ui/actions.js',
    'lib/ui/menu.js', 'lib/ui/menu-html.js', 'lib/ui/fit-popover.js',
    'tools/patches/coupling-ui.js', 'tools/patches/drop-ui.js', 'tools/patches/browse-ui.js',
    'tools/patches/features-ui.js', 'tools/patches/log-ui.js', 'tools/patches/menu-ui.js', 'tools/patches/menu-ui.css', 'tools/patches/cards-ui.js', 'tools/patches/logview-ui.js', 'tools/patches/logview-ui.css', 'tools/theme-light.css']) {
    try {
      const info = await stat(path.join(ROOT, rel))
      if (info.mtimeMs > canvasStat.mtimeMs) stale.push(rel)
    } catch { /* 补丁文件可能尚不存在（log-ui.js 在接入前）——跳过 */ }
  }
  if (stale.length > 0) {
    finding('stale-canvas', null,
      `生成物比源码旧：${stale.join('、')}`,
      '先运行 ELECTRON_RUN_AS_NODE=1 <DSH.exe> tools/port-canvas.mjs 重新生成画布，再跑本审计')
  } else {
    ok('生成物新鲜：canvas.html 不旧于任何补丁/清单/生成器')
  }
}

/* -------------------------------------------------------- 证据扫描助手 --- */

/** `needle` 每次出现后 `window` 字符内是否匹配 `pattern`。 */
function nearAfter(hay, needle, pattern, window = 320) {
  if (!needle) return false
  const re = new RegExp(pattern)
  let at = hay.indexOf(needle)
  while (at >= 0) {
    if (re.test(hay.slice(at + needle.length, at + needle.length + window))) return true
    at = hay.indexOf(needle, at + 1)
  }
  return false
}

/** 字符串感知的平衡块提取：`src[at]` 必须是 `{`/`[`/`(`。 */
function balanced(src, at) {
  const open = src[at]
  const close = open === '{' ? '}' : open === '[' ? ']' : ')'
  let depth = 0
  let inStr = null
  let i = at
  while (i < src.length) {
    const ch = src[i]
    if (inStr) {
      if (ch === '\\') { i += 2; continue }
      if (ch === inStr) inStr = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; i += 1; continue }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return src.slice(at, i + 1)
    }
    i += 1
  }
  return null
}

/** 提取 `updateCouplingButton` 这类函数声明体（函数声明或 var 赋值）。 */
function functionBody(name) {
  const decl = corpus.indexOf(`function ${name}(`)
  if (decl >= 0) {
    const at = corpus.indexOf('{', decl)
    return balanced(corpus, at)
  }
  return null
}

/** 静态 id 的直接绑定证据：`$('<id>')` / `cfBindToolbar('<id>'` 后近处出现 click 监听。 */
function directIdBinding(id) {
  return nearAfter(corpus, `$('${id}')`, `\\.addEventListener\\('click'`, 260)
    || nearAfter(corpus, `$("${id}")`, `\\.addEventListener\\("click"`, 260)
    || nearAfter(corpus, `getElementById('${id}')`, `\\.addEventListener\\('click'`, 260)
    || corpus.includes(`cfBindToolbar('${id}'`) // v1.3.0 守卫绑定助手
}

/** 动态选择器的绑定证据：(a) querySelector(All) 工厂；(b) className/class 创建点。 */
function selectorBinding(sel) {
  const q = nearAfter(corpus, `querySelectorAll('${sel}')`, `\\.addEventListener\\('click'`, 420)
    || nearAfter(corpus, `querySelector('${sel}')`, `\\.addEventListener\\('click'`, 420)
  if (q) return 'querySelector'
  if (sel.startsWith('.')) {
    const cls = sel.slice(1)
    /* class 可能拼在类列表里（'cf-btn mini cf-fempty-btn'）或带动态后缀
       （'cf-navbtn'+active），按裸类名 + 近处 click 监听识别工厂。 */
    if (nearAfter(corpus, cls, `\\.addEventListener\\('click'`, 700)) return 'factory'
  }
  return null
}

/* ----------------------------------------------------- 模式表与委托注册 --- */
/* 循环绑定的动态 id 无法按字面 id 找证据；模式表写明覆盖哪些 id、为什么安全。
   事件委托同理：注册点是一段固定源码，改名/删除即审计失败。 */
const PATTERN_TABLE = [
  {
    name: 'view-tabs',
    match: /^cf-vtab-(tasks|modules)$/,
    reason: "VIEW_JS 里 ['tasks','modules'].forEach(function(v){ var b=$('cf-vtab-'+v); b.addEventListener('click',…) }) 按 id 循环绑定；两个 tab 一一对应",
    marker: "$('cf-vtab-'+v)",
  },
]

const DELEGATE_TABLE = {
  'dialog-close': {
    reason: '#cf-dialog 上的一次事件委托统一兜底 close/cancel（各对话框自己的直接绑定保留，二者幂等）',
    markers: ['[data-act="close"],[data-act="cancel"]'],
  },
  'menu-bar': {
    reason: 'menu-ui.js 的一次捕获委托处理所有菜单触发按钮（[data-cf-menu] 开/关 + aria-expanded 同步）',
    markers: ["closest('[data-cf-menu]')", 'aria-expanded'],
  },
  'menu-action': {
    reason: 'menu-ui.js 的委托把 [data-action] 项交给 ACTION_RUNNERS 查表，复用与主按钮相同的函数（无第二份 handler）',
    markers: ["closest('[data-action]')", 'var ACTION_RUNNERS={'],
  },
  'node-dblclick': {
    reason: '模板把 stage 的 dblclick 委托给 onDbl，onDbl 内 .cf-node 命中即 openDetails(id)',
    markers: ["stage.addEventListener('dblclick',onDbl)", 'openDetails(id)'],
  },
  'node-contextmenu': {
    reason: 'ROOT 的 contextmenu 委托给 onCtx，onCtx 按 target 分派 openNodeMenu/openLinkMenu/openCanvasMenu',
    markers: ["ROOT.addEventListener('contextmenu',onCtx)", 'function onCtx('],
  },
  'link-contextmenu': {
    reason: '同 node-contextmenu：onCtx 对 .cf-link-hit 分派 openLinkMenu',
    markers: ["ROOT.addEventListener('contextmenu',onCtx)", 'function onCtx('],
  },
  'canvas-contextmenu': {
    reason: '同 node-contextmenu：onCtx 对空白处分派 openCanvasMenu',
    markers: ["ROOT.addEventListener('contextmenu',onCtx)", 'function onCtx('],
  },
}

/* -------------------------------------------------------- 1. 清单完整性 --- */

const byKey = new Map()
for (const entry of CANVAS_ACTIONS) {
  if (byKey.has(entry.key)) finding('duplicate-key', entry, '清单 key 重复', '每个控件只能有一个清单项')
  byKey.set(entry.key, entry)
}
if (byKey.size === CANVAS_ACTIONS.length) ok(`清单 key 唯一（${CANVAS_ACTIONS.length} 项）`)

for (const entry of CANVAS_ACTIONS) {
  /* 菜单项以 key+handler 定位（openMenu 数组逐项验证 act/sub），豁免 id/selector。 */
  if (!entry.id && !entry.selector && !String(entry.surface ?? '').startsWith('menu:')) {
    finding('missing-manifest', entry, '既没有 id 也没有 selector', '补 id（静态）或 selector（动态）')
  }
  if (!['always', 'hosted', 'modules', 'notRunning', 'bothViews', 'issue', 'session', 'staleCards'].includes(entry.enabledWhen)) {
    finding('missing-manifest', entry, `enabledWhen 非法：${entry.enabledWhen}`, 'always|hosted|modules|notRunning|bothViews|issue|session|staleCards')
  }
  if (!/^(auto|manual):/.test(String(entry.test ?? ''))) finding('missing-manifest', entry, 'test 字段必须是 auto:/manual: 前缀', '归属 tests/buttons.mjs 或 MANUAL-CHECKLIST.md')
}

/* 生成物里提取全部静态按钮 id。 */
const htmlButtonIds = [...canvas.matchAll(/<button[^>]*?\bid="([^"]+)"/g)].map((m) => m[1])
/* 清单侧登记了 id 的条目（无论 dynamic 与否——dynamic 只表示控件由模板生成，
   id 字面量仍在生成物文本里）。 */
const manifestStaticIds = CANVAS_ACTIONS.filter((e) => e.id).map((e) => e.id)

const unmapped = htmlButtonIds.filter((id) => !manifestStaticIds.includes(id))
for (const id of unmapped) {
  finding('missing-manifest', { surface: 'unknown', key: `??:${id}` }, `生成物里的静态按钮 <button id="${id}"> 未登记进清单`, '在 lib/ui/actions.js 补一条清单项')
}
if (unmapped.length === 0) ok(`静态按钮 id 全部登记（${htmlButtonIds.length} 个）`)

const phantom = manifestStaticIds.filter((id) => !htmlButtonIds.includes(id))
for (const id of phantom) {
  finding('missing-manifest', byKey.get(manifestStaticIds.find((k) => k === id)) ?? null,
    `清单里的静态 id ${id} 在生成物中不存在（可能是 dynamic 漏标或控件已删除）`, '核对生成物后修正清单')
}
if (phantom.length === 0) ok('清单静态 id 全部存在于生成物')

/* 每个 <button> 标签至少带 id / data-act / data-b / data-run / data-crumb / data-farrow / data-action / data-lv 之一。 */
const bareButtons = [...canvas.matchAll(/<button[^>]*>/g)]
  .map((m) => m[0])
  .filter((tag) => !/\b(id|data-act|data-b|data-run|data-crumb|data-farrow|data-action|data-lv|data-lv-level)=/.test(tag))
if (bareButtons.length > 0) {
  finding('missing-manifest', null, `${bareButtons.length} 个 <button> 标签没有任何可寻址属性（id/data-act/data-b/…）`,
    `例如：${bareButtons[0].slice(0, 90)}`)
} else {
  ok('没有不可寻址的 <button> 标签')
}

/* data-act / data-b / data-run 字面量 ⇄ 清单双向覆盖。 */
for (const [attr, selPrefix] of [['data-act', '[data-act="'], ['data-b', '[data-b="'], ['data-run', '[data-run']]) {
  const selectorLiterals = new Set([...canvas.matchAll(new RegExp(`querySelector(All)?\\('${selPrefix.replace(/[.[\]]/g, (c) => `\\${c}`)}([^"\\]]*)`, 'g'))].map((m) => m[2]))
  const literalRe = attr === 'data-run' ? /data-run=/g : new RegExp(`${attr}="([^"]+)"`, 'g')
  const literals = new Set()
  for (const m of canvas.matchAll(literalRe)) {
    const text = m[0]
    if (text.includes('querySelector(')) continue // 选择器本身不算字面量
    if (attr !== 'data-run') {
      // 只接受真实 act token；带引号/加号的片段是 JS 里的选择器拼接
      // （如 log-ui 的 '[data-act="'+act+'"]'），不是 HTML 字面量。
      if (!/^[a-z0-9-]+$/.test(m[1])) continue
    }
    literals.add(attr === 'data-run' ? '*' : m[1])
  }
  /* 清单选择器必须**精确**是 `[data-act="X"]` 形状——`[data-action=…]` 以
     `[data-act` 开头但不能算进来（data-action 有自己的覆盖检查）。 */
  const exactSelRe = attr === 'data-run' ? /^\[data-run\]$/ : new RegExp(`^\\[${attr}="([^"]*)"\\]$`)
  const coveredSelectors = new Set(CANVAS_ACTIONS.map((e) => exactSelRe.exec(e.selector ?? '')?.[0]).filter(Boolean))
  for (const lit of literals) {
    const sel = attr === 'data-run' ? '[data-run]' : `[${attr}="${lit}"]`
    if (!coveredSelectors.has(sel)) {
      finding('missing-manifest', { surface: 'dialog', key: `??:${attr}=${lit}` }, `${attr}="${lit}" 字面量没有对应清单项`, '在 lib/ui/actions.js 登记')
    }
  }
  for (const sel of coveredSelectors) {
    const inner = sel.slice(sel.indexOf('"') + 1, sel.endsWith('"]') ? -2 : undefined)
    const want = attr === 'data-run' ? 'data-run=' : `${attr}="${inner}"`
    if (!canvas.includes(want)) {
      finding('missing-manifest', byKey.get([...byKey.values()].find((e) => e.selector === sel)?.key) ?? null,
        `清单选择器 ${sel} 在生成物中没有 ${want} 字面量`, '控件已删除则清理清单')
    }
  }
  if (literals.size > 0 || coveredSelectors.size > 0) ok(`${attr} 字面量与清单互相覆盖（字面量 ${literals.size} / 清单 ${coveredSelectors.size}）`)
}

/* data-action 字面量（菜单项）⇄ CANVAS_ACTIONS key 双向覆盖：菜单项只允许
   引用既有 action key（单一事实来源）；清单里的 [data-action] 选择器必须
   真实出现在生成物中。JS 拼接片段（如 '[data-action="'+key+'"]'）不是
   字面量，按 token 形状过滤。 */
{
  const keys = new Set(CANVAS_ACTIONS.map((e) => e.key))
  const used = new Set([...canvas.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]).filter((k) => /^[a-z0-9:_-]+$/.test(k)))
  const unknown = [...used].filter((k) => !keys.has(k))
  for (const k of unknown) finding('missing-manifest', { surface: 'menu', key: k }, `data-action="${k}" 不在 CANVAS_ACTIONS`, '菜单项只能引用既有 action key；新动作先登记清单')
  for (const entry of CANVAS_ACTIONS) {
    const m = /^\[data-action="([^"]+)"\]$/.exec(entry.selector ?? '')
    if (m && !canvas.includes(`data-action="${m[1]}"`)) {
      finding('missing-manifest', entry, `清单选择器 ${entry.selector} 在生成物中不存在`, '菜单模型删除了该项则同步清理清单')
    }
  }
  if (unknown.length === 0) ok(`data-action 字面量全部引用清单 key（${used.size} 个）`)
}

/* -------------------------------------------------------- 2. 绑定存在性 --- */

function evidenceFor(entry) {
  const bind = entry.bind ?? 'direct'
  if (bind.startsWith('pattern:')) {
    const re = new RegExp(`^(?:${bind.slice(8)})$`)
    const target = entry.id ?? entry.selector ?? ''
    const hit = PATTERN_TABLE.find((p) => p.match.test(target) === true && re.test(target))
    if (hit && corpus.includes(hit.marker)) return `pattern:${hit.name}`
    return null
  }
  if (bind.startsWith('delegate:')) {
    const d = DELEGATE_TABLE[bind.slice(9)]
    if (!d) return null
    return d.markers.every((m) => corpus.includes(m)) ? `delegate:${bind.slice(9)}` : null
  }
  if (bind === 'markers') {
    return Array.isArray(entry.markers) && entry.markers.length > 0 && entry.markers.every((mk) => corpus.includes(mk))
      ? 'markers' : null
  }
  /* 菜单项的「绑定」就是 act 引用的全局函数真实存在（逐项 act/sub 由菜单扫描器验证）。 */
  if (String(entry.surface ?? '').startsWith('menu:')) {
    const h = entry.handler
    return typeof h === 'string' && !h.startsWith('local:') && corpus.includes(`function ${h}(`) ? 'menu-act' : null
  }
  if (entry.id && directIdBinding(entry.id)) return 'direct'
  if (entry.selector) return selectorBinding(entry.selector)
  return null
}

const bindingRows = []
for (const entry of CANVAS_ACTIONS) {
  const evidence = evidenceFor(entry)
  bindingRows.push({ key: entry.key, surface: entry.surface, label: entry.label, binding: evidence, enabledWhen: entry.enabledWhen, test: entry.test })
  if (!evidence) {
    finding('missing-binding', entry,
      `找不到绑定证据（bind=${entry.bind ?? 'direct'}）`,
      entry.dynamic
        ? `确认 ${entry.selector ?? entry.id} 的工厂/委托代码还在，且 selector 拼写一致`
        : `在初始化处补 \$('${entry.id}').addEventListener('click', …)，或改用清单驱动的统一绑定`)
  }
}
const boundCount = bindingRows.filter((r) => r.binding).length
if (boundCount === CANVAS_ACTIONS.length) ok(`全部 ${boundCount} 个控件都有绑定证据`)

/* 空 handler：addEventListener('click', function(){}) / () => {} / 只有 return。 */
const emptyHandlerPatterns = [
  [/addEventListener\('click',\s*function\s*\([^)]*\)\s*\{\s*\}/, "addEventListener('click', function(){})"],
  [/addEventListener\('click',\s*function\s*\([^)]*\)\s*\{\s*return\s*;?\s*\}/, "addEventListener('click', function(){return;})"],
  [/addEventListener\('click',\s*\([^)]*\)\s*=>\s*\{\s*\}/, "addEventListener('click', () => {})"],
  [/act\s*:\s*function\s*\([^)]*\)\s*\{\s*\}/, 'act:function(){}'],
]
for (const [re, label] of emptyHandlerPatterns) {
  const at = corpus.search(re)
  if (at >= 0) finding('empty-handler', { surface: corpus.slice(Math.max(0, at - 60), at).match(/[\w-]+(?::[\w-]+)?/)?.[0] ?? null, key: null }, `空 handler：${label}`, '空监听等于死按钮；删除或实现它')
}
const hasEmptyHandler = findings.some((f) => f.category === 'empty-handler')
if (!hasEmptyHandler) ok('没有空 handler')

/* 全局 handler 必须真实存在（local:* 只要求绑定存在，见上面的证据扫描）。 */
for (const entry of CANVAS_ACTIONS) {
  const h = entry.handler
  if (typeof h !== 'string' || h.startsWith('local:')) continue
  const exists = corpus.includes(`function ${h}(`) || new RegExp(`\\b${h}\\s*=\\s*function`).test(corpus)
  if (!exists) finding('missing-manifest', entry, `handler ${h} 在画布源码中不存在`, '不要为了过测试编造全局函数；局部 handler 写成 local:<surface>:<动作>')
}
if (!findings.some((f) => f.category === 'missing-manifest' && f.reason.includes('在画布源码中不存在'))) ok('全局 handler 全部真实存在')

/* 未定义符号调用（v1.2.2 现场事故回归）：runCouplingAnalysis 曾调用不存在的
   fetchCouplingStale，ReferenceError 让「分析成功后的刷新链」在用户面前报
   「耦合分析失败」。启发式（刻意不 lexer 全文——画布里的正则字面量含引号，
   字符串剥离会失步）：只扫 <script> 块的**原文**，找「调用位」标识符
   （`\bname\s*(`，前置不是 `.`、不是 `function` 定义位），凡整个语料只出现
   1 次的调用位名字 ≈ 拼写错误——真实函数必然「定义 + 调用」≥ 2 次；
   字符串/正则内容在此语料里不产生 `name(` 形状。 */
{
  const KEYWORDS = new Set(['function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'var', 'let', 'const', 'void', 'this', 'throw', 'try', 'catch', 'finally', 'with', 'debugger', 'yield', 'async', 'await'])
  const GLOBALS = new Set(['window', 'document', 'Math', 'JSON', 'Date', 'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Error', 'TypeError', 'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'AbortSignal', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'console', 'Blob', 'URL', 'Event', 'KeyboardEvent', 'CustomEvent', 'getComputedStyle', 'matchMedia', 'Symbol', 'Map', 'Set', 'RegExp', 'structuredClone', 'queueMicrotask', 'alert',
    /* CSS 函数名：出现在 transform/filter 等字符串中部（如 'px) scale('），
       结构上无法与真实调用区分，按已知 CSS 函数放行。 */
    'translate', 'translateX', 'translateY', 'translate3d', 'scale', 'scaleX', 'scaleY', 'scale3d', 'rotate', 'rotateX', 'rotateY', 'matrix', 'calc', 'min', 'max', 'clamp', 'linear-gradient', 'radial-gradient', 'rgba', 'rgb', 'hsla', 'hsl', 'url', 'blur', 'brightness', 'contrast', 'saturate', 'grayscale', 'var', 'env'])
  const scripts = [...corpus.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
  const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g
  const counts = new Map()
  let cm
  while ((cm = callRe.exec(scripts))) {
    const name = cm[1]
    if (KEYWORDS.has(name)) continue
    if (cm.index > 0 && scripts[cm.index - 1] === '.') continue // 成员调用
    if (cm.index > 0 && (scripts[cm.index - 1] === '"' || scripts[cm.index - 1] === "'" || scripts[cm.index - 1] === '`')) continue // 字符串内容开头（如 transform 的 'translate('）
    if (/\bfunction\s*$/.test(scripts.slice(Math.max(0, cm.index - 32), cm.index))) continue // 定义位（死代码另行观察）
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const totalToken = (name) => (scripts.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')) ?? []).length
  const ghosts = []
  for (const [name] of counts) {
    if (GLOBALS.has(name)) continue
    if (totalToken(name) === 1) ghosts.push(name)
  }
  for (const name of ghosts) {
    finding('undefined-symbol', { surface: 'canvas', key: name },
      `符号 ${name} 被调用但在画布 JS 中从未定义（全语料只出现一次）`,
      '大概率是拼写错误（现场事故：fetchCouplingStale → refreshCouplingStale）；核对真实函数名后修正调用')
  }
  if (ghosts.length === 0) ok('未定义符号调用：无（所有调用位符号在语料中出现 ≥2 次）')
}

/* --------------------------------------------------------- 3. 菜单审计 --- */

/** 调用实参列表的**第一个顶层实参**（逗号感知：`items,x,y` → `items`）。 */
function firstCallArg(argList) {
  let depth = 0
  let inStr = null
  for (let i = 0; i < argList.length; i += 1) {
    const ch = argList[i]
    if (inStr) {
      if (ch === '\\') { i += 1; continue }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) return argList.slice(0, i)
  }
  return argList
}

/** openMenu 的数组实参（直接数组或回溯变量声明），加上该变量的 push/splice 增补。 */
function menuArraysOf(src) {
  const found = []
  const callRe = /openMenu\s*\(/g
  let m
  while ((m = callRe.exec(src))) {
    /* 跳过函数定义本身（function openMenu(items,x,y,level){…}）。 */
    if (src.slice(m.index - 9, m.index) === 'function ') continue
    const openParen = src.indexOf('(', m.index)
    const call = balanced(src, openParen)
    if (!call) continue
    const inner = call.slice(1, -1)
    const arg = firstCallArg(inner).trim()
    let text = null
    let varName = null
    if (arg.startsWith('[')) {
      text = balanced(src, openParen + 1 + inner.indexOf('['))
    } else if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
      varName = arg
      /* 只认变量**声明**（var/let/const items=[…]）；navPop.items=[] 这类成员
         赋值不是菜单字面量，不能让它们劫持回溯。 */
      const declRe = new RegExp(`(?:var|let|const)\\s+${arg}\\s*=\\s*\\[`, 'g')
      let decl
      let last = -1
      while ((decl = declRe.exec(src))) {
        if (decl.index < openParen && decl.index > last) last = decl.index
      }
      if (last >= 0) text = balanced(src, src.indexOf('[', last))
    }
    if (text) found.push({ at: m.index, text, varName })
  }
  return found
}

/** 数组文本里的全部对象字面量（含嵌套 sub 数组里的项）。 */
function objectsIn(text) {
  const out = []
  let i = 0
  let inStr = null
  while (i < text.length) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') { i += 1; continue }
      if (ch === inStr) inStr = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; i += 1; continue }
    if (ch === '{') {
      const blk = balanced(text, i)
      if (blk) { out.push(blk); i += blk.length; continue }
    }
    i += 1
  }
  return out
}

let menuItemCount = 0
let menuBad = 0
for (const menu of menuArraysOf(corpus)) {
  const objs = objectsIn(menu.text)
  /* 该菜单变量的 push/splice 增补（items.splice(3,0,{…})、items.push({…})）。 */
  if (menu.varName) {
    const pushRe = new RegExp(`${menu.varName}\\.(?:push|splice|unshift)\\s*\\([^)]*\\{`, 'g')
    let p
    while ((p = pushRe.exec(corpus))) {
      const blk = balanced(corpus, corpus.indexOf('{', p.index + p[0].length - 1))
      if (blk) objs.push(blk)
    }
  }
  for (const obj of objs) {
    if (!/(^|[^\w:])label\s*:/.test(obj)) continue
    menuItemCount += 1
    const hasSep = /(^|[^\w])sep\s*:\s*true/.test(obj)
    const hasAct = /(^|[^\w])act\s*:\s*[^,\s}]/.test(obj)
    const subMatch = /(^|[^\w])sub\s*:\s*([^,}][^,}]*)/.exec(obj)
    const hasSub = subMatch !== null
    if (!hasSep && !hasAct && !hasSub) {
      menuBad += 1
      const lbl = /label\s*:\s*'([^']*)'/.exec(obj)?.[1] ?? '?'
      finding('menu-item', { surface: 'menu', key: `menu:${lbl}` }, `菜单项「${lbl}」既没有 act 也没有 sub（对象：${obj.slice(0, 120)}）`, 'openMenu 的每一项都必须有动作或子菜单')
      continue
    }
    /* sub 指向变量时：验证该变量的项带 act——push 进去的、或 .map 产出的，
       或存在 length>0 守卫（空 sub 的分支必须有 act 兜底）。 */
    if (subMatch) {
      const subExpr = subMatch[2].trim()
      const ident = /^([A-Za-z_$][\w$]*)$/.exec(subExpr)?.[1]
      if (ident) {
        const pushedWithAct = new RegExp(`${ident}\\.push\\s*\\(\\s*\\{[^}]*act\\s*:`, 'g').test(corpus)
        const mapped = new RegExp(`${ident}\\s*=\\s*[^;\\n]{0,80}\\.map\\s*\\(`).test(corpus)
        const guarded = corpus.includes(`${ident}.length>0`) || corpus.includes(`${ident}.length > 0`)
        if (!pushedWithAct && !mapped && !guarded) {
          menuBad += 1
          finding('menu-item', { surface: 'menu', key: `menu:sub:${ident}` }, `子菜单变量 ${ident} 找不到带 act 的项或非空守卫`, '空 sub 会渲染出点不动的子菜单')
        }
      }
    }
  }
}
if (menuBad === 0) ok(`openMenu 全部 ${menuItemCount} 个菜单项都有 act 或非空 sub`)
else finding('menu-item', null, `${menuBad} 个菜单项缺 act/sub`, '见上方逐项输出')

/* -------------------------------------------------------- 4. 启用状态 --- */

/* 生成物静态 HTML 里 disabled/hidden 的控件清单。 */
const htmlStates = new Map()
for (const m of canvas.matchAll(/<button[^>]*?\bid="([^"]+)"[^>]*>/g)) {
  const tag = m[0]
  const id = m[1]
  if (/\sdisabled(?=[\s>])/.test(tag)) htmlStates.set(id, 'disabled')
  else if (/\shidden(?=[\s>])/.test(tag)) htmlStates.set(id, 'hidden')
}

for (const [id, state] of htmlStates) {
  const entry = CANVAS_ACTIONS.find((e) => e.id === id)
  if (!entry) continue // 未登记的已在 §1 报过
  const marker = ENABLE_MARKERS[entry.key]
  if (!marker) {
    finding('permanently-disabled', entry, `HTML 里 ${state}，但清单没有给出解除状态的源码证据`, '在 lib/ui/actions.js 的 ENABLE_MARKERS 登记')
    continue
  }
  if (marker.function) {
    const body = functionBody(marker.function)
    if (!body) {
      finding('permanently-disabled', entry, `找不到 ${marker.function}() 函数体`, '启用逻辑被改名/删除了')
      continue
    }
    const missingRefs = (marker.mustReference ?? []).filter((r) => !body.includes(r))
    if (missingRefs.length > 0) {
      finding('permanently-disabled', entry, `${marker.function}() 未引用 ${missingRefs.join('、')}`, '启用条件不完整')
    }
    if (marker.disabledIsConditional && /\bdisabled\s*=\s*true\b/.test(body)) {
      finding('permanently-disabled', entry, `${marker.function}() 里存在无条件 disabled=true`, '只能由条件表达式置 disabled')
    }
  }
  if (marker.marker && !corpus.includes(marker.marker)) {
    finding('permanently-disabled', entry, `解除 ${state} 的标记 ${JSON.stringify(marker.marker)} 不在源码中`, '确认隐藏控件的显示路径还在')
  }
}
if (!findings.some((f) => f.category === 'permanently-disabled')) ok('disabled/hidden 控件都有解除状态的代码路径')

/* 专项断言：耦合分析入口（v1.3.0：并入「运行」菜单，经 setActionState 广播状态）。 */
{
  const entry = CANVAS_ACTIONS.find((e) => e.key === 'toolbar:cf-tb-coupling')
  if (!entry) finding('missing-manifest', { surface: 'menu', key: 'toolbar:cf-tb-coupling' }, '耦合分析没有清单项', '必须显式登记')
  else {
    if (entry.handler !== 'runCouplingAnalysis') finding('missing-binding', entry, `handler 必须是 runCouplingAnalysis，实际 ${entry.handler}`, '任务书 §4.2')
    if (!canvas.includes('data-action="toolbar:cf-tb-coupling"')) {
      finding('missing-binding', entry, '生成物中没有耦合分析的菜单项（data-action）', '检查 lib/ui/menu.js 的运行菜单模型')
    } else ok('耦合分析入口存在于菜单（data-action）')
    if (!corpus.includes("'toolbar:cf-tb-coupling':function(){runCouplingAnalysis(null);}")) {
      finding('missing-binding', entry, 'ACTION_RUNNERS 缺少耦合分析的查表项（菜单项与主按钮必须复用同一函数）', 'menu-ui.js 的 ACTION_RUNNERS 补该 key')
    } else ok('ACTION_RUNNERS 复用 runCouplingAnalysis（无第二份 handler）')
    const body = functionBody('updateCouplingButton')
    if (body && body.includes('COUPLING.running') && body.includes('modulesAvailable()') && body.includes('setActionState')) {
      ok('updateCouplingButton() 引用 COUPLING.running / modulesAvailable() 并经 setActionState 广播')
    } else if (body) {
      finding('permanently-disabled', entry, 'updateCouplingButton() 未同时引用 COUPLING.running / modulesAvailable() / setActionState', '任务书 §4.3 状态同步')
    }
    /* 无条件置灰只允许出现在请求进行中的临时禁用（有恢复路径）；
       耦合入口的更新函数里绝不允许 disabled=true 字面量。 */
    const uncond = body ? /\bdisabled\s*=\s*true\b/.test(body) : false
    if (uncond) finding('permanently-disabled', entry, 'updateCouplingButton() 里存在无条件 disabled=true', '只能按条件置灰')
  }
  /* 专项断言：菜单触发按钮的 ARIA（生成物静态标记）。 */
  const triggerIds = ['cf-menu-project', 'cf-menu-run', 'cf-menu-view', 'cf-menu-help', 'cf-menu-compact']
  const missingAria = triggerIds.filter((id) => {
    const tag = canvas.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))
    return !tag || !tag[0].includes('aria-haspopup="menu"') || !tag[0].includes('aria-expanded="false"')
  })
  if (missingAria.length === 0) ok('菜单触发按钮全部带 aria-haspopup + aria-expanded')
  else finding('missing-manifest', { surface: 'menu', key: missingAria.join(',') }, `触发按钮缺 ARIA 属性：${missingAria.join('、')}`, 'menu-html.js 渲染时补齐')
  /* 专项断言：#cf-session 的处理结论（v1.2.2：绑到 openSessionDialog）。 */
  const session = CANVAS_ACTIONS.find((e) => e.key === 'status:cf-session')
  if (session && directIdBinding('cf-session') && corpus.includes('function openSessionDialog(')) {
    ok('#cf-session 已绑定 openSessionDialog（不再是可聚焦但无动作的假按钮）')
  } else if (session) {
    finding('missing-binding', session, 'cf-session 无 click 绑定', '绑到 openSessionDialog，或降级为 role=status 的非按钮')
  }
  /* 专项断言：#cf-tb-undo / #cf-tb-settings 的处理结论。 */
  if (directIdBinding('cf-tb-undo') && functionBody('updateUndoButton')) ok('#cf-tb-undo 已绑定 openUndoDialog 且启用条件由 updateUndoButton 维护')
  else finding('missing-binding', CANVAS_ACTIONS.find((e) => e.key === 'toolbar:cf-tb-undo'), 'cf-tb-undo 无绑定或启用逻辑缺失', 'initCanvasExtras 补绑定')
  if (directIdBinding('cf-tb-settings')) ok('#cf-tb-settings 已绑定 openSettingsDialog')
  else finding('missing-binding', CANVAS_ACTIONS.find((e) => e.key === 'toolbar:cf-tb-settings'), 'cf-tb-settings 无绑定', 'initCanvasExtras 补绑定')
}

/* --------------------------------------------------------- 5. allowlist --- */

const FORBIDDEN_SURFACES = ['toolbar', 'empty', 'zoom', 'banner']
let allowlist = { entries: [] }
try {
  allowlist = JSON.parse(await read('tests/buttons/allowlist.json'))
} catch (error) {
  finding('allowlist', null, `tests/buttons/allowlist.json 无法解析：${error.message}`, '保持 JSON 合法')
}
const allowEntries = Array.isArray(allowlist.entries) ? allowlist.entries : []
for (const item of allowEntries) {
  for (const field of ['key', 'reason', 'owner', 'reviewedAt']) {
    if (!item[field]) finding('allowlist', { key: item.key }, `allowlist 条目缺 ${field}`, '每条都必须有 key/reason/owner/reviewedAt')
  }
  const entry = byKey.get(item.key)
  if (!entry) {
    finding('allowlist', { key: item.key }, 'allowlist 条目的 key 不在清单里（过期）', '删除该条目')
    continue
  }
  if (FORBIDDEN_SURFACES.includes(entry.surface) || entry.key.startsWith('dialog:')) {
    finding('allowlist', entry, `面 ${entry.surface} 不允许进 allowlist（必须真实绑定）`, '任务书 §6.4 规则 4')
  }
  if (evidenceFor(entry)) {
    finding('allowlisted-but-fixable', entry, 'allowlist 条目已经有绑定证据（过期条目）', '从 allowlist 删除并让审计直接覆盖')
  }
}
if (allowEntries.length === 0) ok('allowlist 为空（没有需要豁免的控件）')

/* ----------------------------------------------------------- 6. 快照 ----- */

const snapshotPath = path.join(ROOT, 'tests/buttons/inventory.json')
const surfaces = {}
for (const entry of CANVAS_ACTIONS) {
  surfaces[entry.surface] = surfaces[entry.surface] ?? []
  surfaces[entry.surface].push(entry.key)
}
for (const k of Object.keys(surfaces)) surfaces[k].sort()
let snapshotOk = true
try {
  const prev = JSON.parse(await readFile(snapshotPath, 'utf8'))
  const prevSurfaces = prev.surfaces ?? {}
  const keys = new Set([...Object.keys(prevSurfaces), ...Object.keys(surfaces)])
  for (const s of keys) {
    const before = prevSurfaces[s] ?? []
    const now = surfaces[s] ?? []
    for (const gone of before.filter((x) => !now.includes(x))) {
      snapshotOk = false
      finding('stale-manifest', { surface: s, key: gone }, '清单项被删除（快照里还有）', '恢复清单项，或同步 tests/buttons/inventory.json')
    }
    for (const added of now.filter((x) => !before.includes(x))) {
      snapshotOk = false
      finding('stale-manifest', { surface: s, key: added }, '新增控件未同步快照', '确认登记无误后，更新 tests/buttons/inventory.json')
    }
  }
} catch {
  await mkdir(path.join(ROOT, 'tests/buttons'), { recursive: true })
  await writeFile(snapshotPath, JSON.stringify({ note: 'surface -> key[] 稳定快照；清单增删必须同步本文件（tests/buttons.mjs §6）', surfaces }, null, 2) + '\n', 'utf8')
  console.log('  …   已生成 tests/buttons/inventory.json 快照（首次运行）')
}
if (snapshotOk) ok('清单与快照一致')

/* ------------------------------------------------------------ 输出 ------- */

console.log('\n[surface | key | binding | enabledWhen | test]')
for (const row of bindingRows) {
  console.log(`  ${row.surface.padEnd(14)} ${row.key.padEnd(34)} ${(row.binding ?? 'MISSING').padEnd(22)} ${row.enabledWhen.padEnd(11)} ${row.test}`)
}

if (findings.length > 0) {
  console.log('\n[failures]')
  const byCategory = new Map()
  for (const f of findings) {
    byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1)
    console.log(`  ✗ [${f.category}] ${f.surface ?? ''}${f.key ? ` ${f.key}` : ''} — ${f.reason}`)
    console.log(`      ↳ 修复：${f.hint}`)
  }
  console.log(`\n  分类统计：${[...byCategory].map(([k, v]) => `${k}=${v}`).join('、')}`)
  try {
    const reportPath = path.join(tmpdir(), `codeflow-buttons-report-${process.pid}.json`)
    await writeFile(reportPath, JSON.stringify({ findings, bindingRows }, null, 2), 'utf8')
    console.log(`  报告已写：${reportPath}`)
  } catch { /* 报告落盘失败不影响退出码语义 */ }
  console.log(`\n[summary] ${passed} checks passed, ${findings.length} finding(s)`)
  process.exit(1)
}
console.log(`\n[summary] all ${passed} checks passed`)
