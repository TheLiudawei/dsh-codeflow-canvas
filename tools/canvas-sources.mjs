/**
 * 画布生成物（assets/canvas/canvas.html）的**输入清单与源哈希**。
 *
 * v1.3.1：`tests/buttons.mjs` 原先用 mtime 判断「生成物是否比源码旧」。mtime 在
 * 全新检出（CI / 刚 clone）里完全不代表新旧——git 按目录顺序写文件，补丁目录写在
 * assets 之后，于是 canvas.html 恒比某些源码「旧」，检查稳定误报。改成内容哈希：
 *
 *   - 本模块是输入清单的单一事实来源；
 *   - `tools/port-canvas.mjs` 生成时把哈希写进画布头部注释；
 *   - `tests/buttons.mjs` 重新计算并逐字比对，与文件时间无关。
 *
 * 新增/删除生成器输入时**只改这里**，否则生成器与审计会各说各话。
 *
 * @module dsh-codeflow-canvas/canvas-sources
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（本文件在 tools/ 下）。 */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 相对仓库根、按固定顺序参与哈希的输入文件。 */
export const CANVAS_SOURCES = [
  'tools/port-canvas.mjs',
  'tools/upstream/canvas-template.html',
  'tools/theme-light.css',
  'lib/ui/actions.js',
  'lib/ui/menu.js',
  'lib/ui/menu-html.js',
  'lib/ui/fit-popover.js',
  'tools/patches/browse-ui.css',
  'tools/patches/browse-ui.js',
  'tools/patches/cards-ui.css',
  'tools/patches/cards-ui.js',
  'tools/patches/coupling-ui.css',
  'tools/patches/coupling-ui.js',
  'tools/patches/drop-ui.js',
  'tools/patches/features-ui.css',
  'tools/patches/features-ui.js',
  'tools/patches/log-ui.js',
  'tools/patches/logview-ui.css',
  'tools/patches/logview-ui.js',
  'tools/patches/menu-ui.css',
  'tools/patches/menu-ui.js',
  'tools/patches/task-node-ui.css',
  'tools/patches/task-node-ui.js',
]

/** 画布头部注释里的哈希标记，例如 `源哈希：a1b2c3d4e5f60718`。 */
export const SOURCE_HASH_MARKER = '源哈希：'

/**
 * 计算输入源哈希（sha256 前 16 位十六进制）。
 *
 * @param {string} [root] - 仓库根；默认取本文件位置推出的仓库根。
 * @returns {string}
 */
export function canvasSourceHash(root = REPO_ROOT) {
  const hash = createHash('sha256')
  for (const rel of CANVAS_SOURCES) {
    hash.update(rel)
    hash.update('\0')
    hash.update(readFileSync(path.join(root, ...rel.split('/')), 'utf8'))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * 从画布文本里取出生成时写入的源哈希。
 *
 * @param {string} canvasText
 * @returns {string|null}
 */
export function readSourceHash(canvasText) {
  const match = new RegExp(`${SOURCE_HASH_MARKER}([0-9a-f]{16})`).exec(canvasText)
  return match ? match[1] : null
}
