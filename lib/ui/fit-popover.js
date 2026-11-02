/**
 * 弹层几何（v1.3.0，需求二）——纯函数，零 import、零 DOM、零副作用。
 *
 * 二级节点列表（#cf-navpop）曾用 `60vh` 限高 + 简单夹取，面板矮时底部溢出
 * 被画布 `overflow:hidden` 裁掉，列表「拉不到底」。本函数用 stage 可用空间
 * **反推**弹层位置与最大高度，保证四边都落在 stage 内；浏览器侧不另写一份
 * 实现——`tools/port-canvas.mjs` 构建时把本函数内联进画布（单一实现）。
 *
 * @param options.stageW - stage 宽度（px）。
 * @param options.stageH - stage 高度（px）。
 * @param options.anchorRect - 触发锚点相对 stage 的矩形 `{left,top,right,bottom}`。
 * @param options.popW - 弹层宽（px）。
 * @param options.popH - 弹层内容自然高度（px，仅用于判断下方放不放下）。
 * @param options.pad - 距 stage 四边的最小间距（默认 8）。
 * @param options.gap - 与锚点的间距（默认 4）。
 * @param options.minListHeight - 极矮 stage 下列表的最低可滚高度（默认 96 ≈ 3 行）。
 * @returns `{ left, top, maxHeight, side }`；`side` 为水平摆放：`'right'`
 *   （锚点右侧）或 `'left'`（翻到锚点左侧，防超出右边界）。
 */
export function fitPopover(options = {}) {
  const stageW = Math.max(0, Number(options.stageW) || 0)
  const stageH = Math.max(0, Number(options.stageH) || 0)
  const anchor = options.anchorRect ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const popW = Math.max(0, Number(options.popW) || 0)
  const popH = Math.max(0, Number(options.popH) || 0)
  const pad = Number.isFinite(options.pad) ? options.pad : 8
  const gap = Number.isFinite(options.gap) ? options.gap : 4
  const minListHeight = Number.isFinite(options.minListHeight) ? options.minListHeight : 96
  const innerH = Math.max(0, stageH - 2 * pad)
  /* 极矮 stage：列表至少保留 minListHeight 且可滚，但不能超过 stage 内高——
     否则 top + maxHeight 会越出下边界（之前写成 Math.min(minListHeight,
     Math.max(minListHeight, innerH))，恒等于 minListHeight，等于没夹）。 */
  const minH = Math.min(minListHeight, innerH)

  /* 垂直：优先锚点下方（高度=下方空间反推）；下方放不下最小高度时翻到上方；
     上下都不够 → 从 pad 起、高度=stage 内高。top + maxHeight 恒 ≤ stageH - pad。 */
  const below = innerH - (anchor.bottom + gap - pad)
  const above = anchor.top - gap - pad
  let top
  let maxHeight
  if (below >= Math.min(popH, minH) || below >= above) {
    top = anchor.bottom + gap
    maxHeight = Math.max(minH, below)
  } else {
    maxHeight = Math.max(minH, above)
    top = Math.max(pad, anchor.top - gap - maxHeight)
  }
  /* 再夹一次：锚点贴边/越界时 above·below 可能大于 stage 内高，不夹就会
     top(pad) + maxHeight 越出下边界。 */
  maxHeight = Math.min(maxHeight, innerH)
  if (top + maxHeight > stageH - pad) top = Math.max(pad, stageH - pad - maxHeight)
  if (top < pad) top = pad

  /* 水平：默认锚点右侧；放不下 → 翻到锚点左侧；再放不下 → 贴右侧内边距。 */
  let left = anchor.right + gap
  let side = 'right'
  if (left + popW > stageW - pad) {
    left = anchor.left - gap - popW
    side = 'left'
  }
  if (left + popW > stageW - pad) left = Math.max(pad, stageW - pad - popW)
  if (left < pad) left = pad

  return { left, top, maxHeight, side }
}
