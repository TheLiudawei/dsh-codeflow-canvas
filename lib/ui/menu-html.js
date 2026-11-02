/**
 * 顶部命名菜单的**纯渲染**（v1.3.0，需求一）——模型 → HTML 字符串。
 *
 * 不碰 DOM、不查宿主、不发请求；由 `tools/port-canvas.mjs` 在**生成时**调用，
 * 把展开态（四个命名菜单）与折叠态（☰ 分组面板）一起渲染成生成物里的静态
 * 可审计标记。折叠态与展开态由**同一份模型、同一个函数**渲染（单一事实来源，
 * `tests/menu.mjs` 断言两者出自同一模型）。
 *
 * 事件绑定不在这里：面板项的 `data-action` 由 `tools/patches/menu-ui.js` 的
 * 事件委托 + action 查表接管。
 *
 * 依赖方向：只 import `./menu.js`（渲染 → 模型），零 DOM / 零宿主。
 *
 * @module dsh-codeflow-canvas/ui/menu-html
 */
import { MENU_MODEL } from './menu.js'

/** 模型标签是静态受信数据，仍做 HTML 转义（防未来把动态文本塞进模型）。 */
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

/** 单个菜单项 / 分隔线 → HTML。 */
function menuItemHtml(item) {
  if (item.sep) return '<div class="cf-menusep" role="separator" aria-hidden="true"></div>'
  return '<button type="button" class="cf-menuitem" role="menuitem" data-action="' + escapeHtml(item.action) + '"'
    + (item.icon ? ' data-icon="' + escapeHtml(item.icon) + '"' : '')
    + '><i data-lucide="' + escapeHtml(item.icon ?? '') + '"></i>'
    + '<span class="cf-menuitem-label">' + escapeHtml(item.label) + '</span></button>'
}

/** 一个命名菜单组：触发按钮 + 从其下方展开的面板（默认 hidden）。 */
function menuGroupHtml(group) {
  return '<div class="cf-menu-group">'
    + '<button type="button" class="cf-mbtn" id="cf-menu-' + escapeHtml(group.id) + '" data-cf-menu="' + escapeHtml(group.id) + '"'
    + ' aria-haspopup="menu" aria-expanded="false">' + escapeHtml(group.label) + '<i data-lucide="chevron-down"></i></button>'
    + '<div class="cf-menupop" id="cf-menupop-' + escapeHtml(group.id) + '" role="menu" aria-label="' + escapeHtml(group.label) + '" hidden>'
    + group.items.map(menuItemHtml).join('')
    + '</div></div>'
}

/**
 * 渲染整条菜单栏：展开态四组 + 折叠态（☰ 与全量分组面板）。
 * 两组标记出自同一份模型——展开/折叠只是同一数据的两种呈现。
 *
 * @param model - 菜单模型（默认 {@link MENU_MODEL}）。
 * @returns HTML 字符串（由生成器嵌入 `<nav class="cf-menubar">`）。
 */
export function renderMenuBar(model = MENU_MODEL) {
  const expanded = model.map(menuGroupHtml).join('')
  const compactItems = model.map((group) => '<div class="cf-menugroup-title">' + escapeHtml(group.label) + '</div>'
    + group.items.map(menuItemHtml).join('')).join('')
  return expanded
    + '<button type="button" class="cf-mbtn cf-menu-compact" id="cf-menu-compact" data-cf-menu="compact"'
    + ' aria-haspopup="menu" aria-expanded="false" aria-label="菜单"><i data-lucide="menu"></i></button>'
    + '<div class="cf-menupop cf-menupop-compact" id="cf-menupop-compact" role="menu" aria-label="菜单" hidden>'
    + compactItems + '</div>'
}
