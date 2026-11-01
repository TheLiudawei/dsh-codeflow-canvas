/**
 * 提供给面板 iframe 的画布文档。
 *
 * 画布本身是一个自包含片段（`assets/canvas/canvas.html`：标记、样式、行为）。
 * 本模块把它包进文档外壳，并注入片段期望的 boot 载荷。这份 HTML 从不由
 * agent 组装——面板按需重载——因此片段不再携带占位符契约或体积预算。
 *
 * @module dsh-codeflow-canvas/canvas-page
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FRAGMENT_URL = new URL('../assets/canvas/canvas.html', import.meta.url)

/** The fragment, read once at activation: it ships with the package and never changes at runtime. */
let fragmentCache

/** Read (and memoize) the canvas fragment. */
export function canvasFragment() {
  if (fragmentCache === undefined) fragmentCache = readFileSync(fileURLToPath(FRAGMENT_URL), 'utf8')
  return fragmentCache
}

/**
 * 把一个值序列化成可嵌入内联 `<script>` 的文本。
 *
 * 单纯 `JSON.stringify` 在这里不安全：任何字符串里出现 `</script>` 都会提前
 * 闭合元素，孤立 `<` 会让文档对读取者产生歧义。把两者都转成 JSON unicode
 * 转义，载荷保持惰性的同时仍是合法 JSON。
 *
 * @param value - boot 载荷。
 * @returns 惰性 JSON 文本。
 */
function scriptSafeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** Inline page chrome: the iframe host owns the background, the document fills it.
 * 嵌入模式额外把画布根节点的 1px 外框与 14px 圆角去掉（v1.0 缺陷 B）：面板里画布
 * 必须四边贴满 iframe；独立预览（直接打开 canvas.html）没有这层 SHELL_CSS，
 * 卡片外观原样保留。选择器带 `html body>` 前缀以压过片段内的 `#codeflow-canvas`。 */
const SHELL_CSS = `
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#0b0b0e;}
body{-webkit-font-smoothing:antialiased;}
html body>div#codeflow-canvas{border:0;border-radius:0;width:100%;height:100%;}
/* 原生控件（select / input / textarea）跟随主题，而不是恒用浅色 UA 样式 */
html{color-scheme:dark;}
html[data-cf-theme="light"]{color-scheme:light;}
html[data-cf-theme="light"],html[data-cf-theme="light"] body{background:#eef1f6;}
`

/**
 * 组装完整的画布文档。
 *
 * 配色在画布脚本运行之前就盖在 `<html>` 上，第一帧就是对的：画布读该属性
 * 取 CSS 变量，`color-scheme` 修好对话框里的原生控件。之后 DSH 主题变化经
 * `postMessage` 到达，只翻转属性——绝不重载 iframe。
 *
 * @param boot - boot 载荷：当前图、修订号、项目、会话标识、配色。
 * @returns 完整 HTML 文档。
 */
export function renderCanvasPage(boot) {
  const scheme = boot?.theme === 'light' || boot?.theme === 'dark' ? boot.theme : undefined
  return [
    '<!doctype html>',
    `<html lang="zh-CN"${scheme === undefined ? '' : ` data-cf-theme="${scheme}"`}>`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>CodeFlow 画布</title>',
    `<style>${SHELL_CSS}</style>`,
    '</head>',
    '<body>',
    `<script>window.__CF_BOOT__=${scriptSafeJson(boot)};</script>`,
    canvasFragment(),
    '</body>',
    '</html>',
  ].join('\n')
}
