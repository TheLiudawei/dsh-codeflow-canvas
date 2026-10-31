/**
 * The canvas document served to the panel's iframe.
 *
 * The canvas itself is one self-contained fragment (`assets/canvas/canvas.html`:
 * markup, styles, behaviour). This module wraps it in a document shell and
 * injects the boot payload the fragment expects. No agent ever assembles this
 * HTML — the panel reloads it on demand — which is why the fragment no longer
 * carries a placeholder contract or a size budget.
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
 * Serialize a value for embedding inside an inline `<script>`.
 *
 * `JSON.stringify` alone is unsafe here: a `</script>` inside any string would
 * close the element early, and a lone `<` makes the document ambiguous to
 * readers. Escaping both as JSON unicode escapes keeps the payload inert while
 * staying valid JSON.
 *
 * @param value - the boot payload.
 * @returns inert JSON text.
 */
function scriptSafeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** Inline page chrome: the iframe host owns the background, the document fills it. */
const SHELL_CSS = `
html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#0b0b0e;}
body{-webkit-font-smoothing:antialiased;}
/* 原生控件（select / input / textarea）跟随主题，而不是恒用浅色 UA 样式 */
html{color-scheme:dark;}
html[data-cf-theme="light"]{color-scheme:light;}
html[data-cf-theme="light"],html[data-cf-theme="light"] body{background:#eef1f6;}
`

/**
 * Assemble the full canvas document.
 *
 * The colour scheme is stamped onto `<html>` before the canvas script runs, so
 * the first painted frame is already correct: the canvas reads the attribute for
 * its CSS variables, and `color-scheme` fixes the native controls in its dialogs.
 * A later DSH theme change arrives by `postMessage` and only flips the attribute.
 *
 * @param boot - boot payload: current graph, revision, project, session identity, colour scheme.
 * @returns a complete HTML document.
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
