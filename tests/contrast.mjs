/**
 * WCAG 2.1 contrast audit for the canvas's light palette.
 *
 * Light mode fails in one specific way: text that read fine on a dark surface
 * drops below AA on a light one. Colour *choice* is a matter of taste, but
 * readability is checkable, so this module computes the actual ratios for every
 * pairing where the canvas paints text — including status badges, whose
 * background is the per-type node-head tint and therefore varies by node.
 *
 * Exported as a function so `tests/validate.mjs` can assert it as one check.
 *
 * @module dsh-codeflow-canvas/tests/contrast
 */

/** Parse `#rgb` / `#rrggbb` into an `[r, g, b]` triple. */
function hex(value) {
  const h = value.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
}

/** Linearize one sRGB channel per WCAG 2.1. */
function linear(channel) {
  const s = channel / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** Relative luminance of an `[r, g, b]` triple. */
function luminance(rgb) {
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2])
}

/** Contrast ratio between two colours (order-independent). */
function ratio(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Composite `colour` at `alpha` over `backdrop`. */
function composite(color, alpha, backdrop) {
  return color.map((channel, index) => Math.round(alpha * channel + (1 - alpha) * backdrop[index]))
}

/** AA for normal-size text; the canvas is almost all 10–13px. */
const AA = 4.5

/** Surfaces and label colours asserted by the light palette. */
const SURFACE = {
  panel: '#ffffff',
  stage: '#f5f7fa',
  chrome: '#eef1f6',
  text: '#1b1f27',
  dim: '#5d6673',
  accent: '#4f5bd5',
  accentHover: '#5b67dd',
  accentText: '#3b46b8',
  danger: '#d92d20',
  dangerText: '#b42318',
  okText: '#15803d',
}

/**
 * Compute every light-mode text pairing worth protecting.
 *
 * @param canvasText - the generated canvas document.
 * @returns rows of `{ label, value, target, ok }`.
 */
export function auditLightContrast(canvasText) {
  const rows = []
  const add = (label, fg, bg, target = AA) => {
    const value = ratio(fg, bg)
    rows.push({ label, value, target, ok: value >= target })
  }

  const panel = hex(SURFACE.panel)
  const stage = hex(SURFACE.stage)
  const text = hex(SURFACE.text)
  const dim = hex(SURFACE.dim)

  for (const [name, bg] of [['panel', panel], ['stage', stage], ['chrome', hex(SURFACE.chrome)]]) {
    add(`text on ${name}`, text, bg)
    add(`dim on ${name}`, dim, bg)
  }

  add('primary label on accent', hex('#ffffff'), hex(SURFACE.accent))
  add('primary label on accent hover', hex('#ffffff'), hex(SURFACE.accentHover))
  add('accent-soft label', hex(SURFACE.accentText), composite(hex(SURFACE.accent), 0.10, panel))
  add('danger button label', hex(SURFACE.dangerText), composite(hex(SURFACE.danger), 0.08, panel))
  add('toast error text', hex(SURFACE.dangerText), panel)
  add('toast ok text', hex(SURFACE.okText), panel)
  add('banner text', hex(SURFACE.accentText), composite(hex(SURFACE.accent), 0.10, panel))
  add('menu danger item', hex(SURFACE.dangerText), panel)
  add('empty-state hint', hex('#6b7280'), composite(hex('#ffffff'), 0.72, stage))

  // Status badges. Their text colour is inline (PALETTE.light.stc); their
  // background is the node-head tint unless the light sheet gives them a chip.
  const chipDeclared = /html\[data-cf-theme="light"\]\s*\.cf-badge\{[^}]*background:#ffffff/.test(canvasText)
  const headTint = 0.20
  const typeColors = new Map()
  for (const match of canvasText.matchAll(/\{label:'[^']*',cat:'([a-z]+)',color:'(#[0-9a-f]{6})'/g)) {
    if (!typeColors.has(match[1])) typeColors.set(match[1], match[2])
  }
  const stcBlock = /light:\{[^}]*stc:\{([^}]*)\}/.exec(canvasText)
  const statuses = [...(stcBlock?.[1] ?? '').matchAll(/(pending|running|done|failed|skipped):\['[^']*','(#[0-9a-f]{6})'\]/g)]
    .map((match) => [match[1], match[2]])

  if (statuses.length !== 5 || typeColors.size === 0) {
    rows.push({ label: 'badge pairing inputs (palette parsed)', value: 0, target: 1, ok: false })
    return rows
  }

  for (const [category, typeColor] of typeColors) {
    const backdrop = chipDeclared
      ? hex('#ffffff')
      : composite(hex(typeColor), headTint, hex('#ffffff'))
    for (const [status, statusColor] of statuses) {
      add(`badge ${status} on ${category}${chipDeclared ? ' chip' : ' tint'}`, hex(statusColor), backdrop)
    }
  }

  return rows
}

/** The worst failing row, or the lowest passing one, for reporting. */
export function summarizeContrast(rows) {
  const failing = rows.filter((row) => !row.ok)
  const lowest = rows.reduce((worst, row) => (row.value < worst.value ? row : worst), rows[0])
  return { failing, lowest, total: rows.length }
}
