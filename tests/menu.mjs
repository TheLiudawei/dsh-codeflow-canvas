/**
 * 命名菜单（v1.3.0，需求一）——纯模型 / 静态审计，不需要 DOM。
 *
 * 覆盖任务书 §4.6：
 *   - 菜单 id / label 唯一非空；每组至少 2 个有效项（帮助菜单单项豁免）；
 *   - 每个菜单项的 action key 存在于 CANVAS_ACTIONS；handler 在生成物真实存在；
 *   - 分隔线不在首/尾、不连续；
 *   - 响应式折叠与展开态出自**同一模型**（断言没有第二份硬编码列表）；
 *   - 生成物中触发按钮有 aria-haspopup/aria-expanded、面板有 role="menu"；
 *   - 工具栏 CSS 不允许 flex-wrap:wrap。
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron> tests/menu.mjs
 */
import './_log-off.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFile(path.join(pluginRoot, rel), 'utf8')
const load = (rel) => import(pathToFileURL(path.join(pluginRoot, rel)).href)

const { MENU_MODEL, validateMenuModel } = await load('lib/ui/menu.js')
const { renderMenuBar } = await load('lib/ui/menu-html.js')
const { CANVAS_ACTIONS } = await load('lib/ui/actions.js')

let passed = 0
const ok = (name) => { passed += 1; console.log('  ok ', name) }

/* ------------------------------------------------------------ 模型 ----- */
{
  const errors = validateMenuModel(MENU_MODEL, CANVAS_ACTIONS)
  assert.deepEqual(errors, [], `菜单模型校验失败：${errors.join('；')}`)
  const ids = MENU_MODEL.map((g) => g.id)
  assert.equal(new Set(ids).size, ids.length, '菜单组 id 唯一')
  for (const group of MENU_MODEL) {
    assert.ok(group.label, `菜单组 ${group.id} 有 label`)
    const items = group.items.filter((i) => !i.sep)
    assert.ok(items.length >= 1, `菜单组 ${group.id} 至少一个有效项`)
    for (const item of items) {
      assert.ok(item.label, `菜单组 ${group.id} 项有 label`)
      assert.ok(CANVAS_ACTIONS.some((e) => e.key === item.action), `action key ${item.action} 在清单中`)
    }
  }
  ok(`菜单模型：${MENU_MODEL.length} 组，全部 action key 引用 CANVAS_ACTIONS`)
}
{
  /* 分隔线位置规则（首/尾/连续）——validateMenuModel 已含，这里独立断言一次
     以防未来有人绕过共享校验。 */
  for (const group of MENU_MODEL) {
    assert.ok(!group.items[0]?.sep, `${group.id} 不以分隔线开头`)
    assert.ok(!group.items[group.items.length - 1]?.sep, `${group.id} 不以分隔线结尾`)
    for (let i = 1; i < group.items.length; i += 1) {
      assert.ok(!(group.items[i].sep && group.items[i - 1].sep), `${group.id} 无连续分隔线`)
    }
  }
  ok('分隔线：不在首/尾、不连续')
}
{
  /* handler 真实存在：菜单项引用的 action key 对应的清单 handler 必须在
     生成物/补丁里可找到（local: 的由委托表兜底）。 */
  const corpus = (await read('assets/canvas/canvas.html')) + (await read('tools/patches/menu-ui.js'))
  const byKey = new Map(CANVAS_ACTIONS.map((e) => [e.key, e]))
  for (const group of MENU_MODEL) {
    for (const item of group.items.filter((i) => !i.sep)) {
      const entry = byKey.get(item.action)
      assert.ok(entry, `${item.action} 在清单里`)
      if (typeof entry.handler === 'string' && !entry.handler.startsWith('local:')) {
        assert.ok(corpus.includes(`function ${entry.handler}(`), `${item.action} 的 handler ${entry.handler} 真实存在`)
      }
    }
  }
  ok('菜单项 handler 全部真实存在')
}

/* ---------------------------------------------------- 渲染（同源折叠） -- */
{
  const html = renderMenuBar(MENU_MODEL)
  /* 展开态部分 = compact 触发按钮之前；折叠面板项必须与展开项的并集一致
     （同一模型渲染两次——断言没有第二份硬编码列表）。 */
  const compactAt = html.indexOf('cf-menu-compact')
  const expandedHtml = html.slice(0, compactAt)
  const compactHtml = html.slice(compactAt)
  const groupsFlat = MENU_MODEL.flatMap((g) => g.items.filter((i) => !i.sep).map((i) => i.action))
  const expandedItems = [...expandedHtml.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1])
  const compactItems = [...compactHtml.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(expandedItems, groupsFlat, '展开面板项与模型一致')
  assert.deepEqual(compactItems, groupsFlat, '折叠面板与展开面板出自同一模型')
  assert.ok(html.includes('aria-haspopup="menu"') && html.includes('aria-expanded="false"'), '触发按钮带 ARIA')
  assert.ok(html.includes('role="menu"'), '面板带 role=menu')
  assert.ok(html.includes('role="separator"'), '分隔线带 role=separator')
  /* 渲染确定性：同一模型两次渲染逐字节一致。 */
  assert.equal(renderMenuBar(MENU_MODEL), html, '渲染是纯函数且确定性')
  ok('渲染：展开/折叠同源、ARIA 完整、渲染确定')
}

/* ------------------------------------------------------- 生成物静态 ---- */
{
  const canvas = await read('assets/canvas/canvas.html')
  const menuCss = await read('tools/patches/menu-ui.css')
  for (const id of ['cf-menu-project', 'cf-menu-run', 'cf-menu-view', 'cf-menu-help', 'cf-menu-compact']) {
    assert.ok(canvas.includes(`id="${id}"`), `生成物包含触发按钮 ${id}`)
  }
  for (const group of MENU_MODEL) {
    assert.ok(canvas.includes(`id="cf-menupop-${group.id}"`), `生成物包含面板 cf-menupop-${group.id}`)
    const tag = canvas.match(new RegExp(`<button[^>]*id="cf-menu-${group.id}"[^>]*>`))
    assert.ok(tag && tag[0].includes('aria-haspopup="menu"') && tag[0].includes('aria-expanded="false"'), `${group.id} 触发按钮 ARIA 完整`)
    const pop = canvas.match(new RegExp(`<div class="cf-menupop" id="cf-menupop-${group.id}"[^>]*>`))
    assert.ok(pop && pop[0].includes('role="menu"'), `${group.id} 面板 role=menu`)
  }
  /* 主按钮 id 保留（mac 套件/既有断言依赖）。 */
  for (const id of ['cf-tb-new', 'cf-tb-import', 'cf-tb-runall', 'cf-tb-undo', 'cf-tb-save', 'cf-tb-settings', 'cf-vtab-tasks', 'cf-vtab-modules']) {
    assert.ok(canvas.includes(`id="${id}"`), `保留主按钮 id ${id}`)
  }
  /* 顶栏不允许 wrap（menu-ui.css 的 nowrap 覆盖必须存在，且模板的 wrap 被
     覆盖——patch CSS 在模板样式之后，同特异性后者胜出）。 */
  assert.ok(menuCss.includes('flex-wrap:nowrap'), 'menu-ui.css 显式 nowrap')
  const tbWrapRule = /\.cf-tb\{[^}]*flex-wrap:wrap/
  assert.ok(!tbWrapRule.test(menuCss), 'menu-ui.css 的 .cf-tb 规则不含 wrap')
  ok('生成物：菜单标记静态可审计，主按钮 id 保留，顶栏 nowrap')
}
{
  /* 顶栏由生成器渲染注入：canvas.html 里应能找到 renderMenuBar 的产物特征
     （菜单栏 nav + 至少一个 menuitem），且生成器确实 import 了模型。 */
  const canvas = await read('assets/canvas/canvas.html')
  assert.ok(canvas.includes('<nav class="cf-menubar"'), '生成物含菜单栏容器')
  assert.ok(canvas.includes('class="cf-menuitem" role="menuitem"'), '生成物含 menuitem')
  const generator = await read('tools/port-canvas.mjs')
  assert.ok(generator.includes("from '../lib/ui/menu.js'") && generator.includes('renderMenuBar(MENU_MODEL)'), '生成器消费同一模型（无第二份菜单列表）')
  ok('生成器与模型同源（构建期渲染）')
}

/* ---------------------------------------------------- navpop 几何（需求二） */

{
  const { fitPopover } = await load('lib/ui/fit-popover.js')
  const anchor = { left: 10, top: 40, right: 210, bottom: 70 }
  /* 正常：下方展开，top+maxHeight 恒在 stage 内。 */
  {
    const fit = fitPopover({ stageW: 1200, stageH: 900, anchorRect: anchor, popW: 300, popH: 500, pad: 8, gap: 4 })
    assert.equal(fit.side, 'right')
    assert.equal(fit.top, anchor.bottom + 4)
    assert.ok(fit.top >= 8 && fit.top + fit.maxHeight <= 900 - 8, `四边落在 stage 内：top=${fit.top} h=${fit.maxHeight}`)
    assert.ok(fit.left + 300 <= 1200 - 8, '右边界不越界')
  }
  /* 高度反推：maxHeight = stage 底边距 - top。 */
  {
    const fit = fitPopover({ stageW: 1200, stageH: 300, anchorRect: { left: 10, top: 40, right: 210, bottom: 70 }, popW: 300, popH: 5000 })
    assert.equal(fit.maxHeight, 300 - 8 - (70 + 4), '高度按可用空间反推')
    assert.ok(fit.top + fit.maxHeight <= 300 - 8)
  }
  /* 下方放不下最小高度 → 翻上方（垂直）。 */
  {
    const fit = fitPopover({ stageW: 1200, stageH: 120, anchorRect: { left: 10, top: 100, right: 210, bottom: 112 }, popW: 300, popH: 5000 })
    assert.ok(fit.top + fit.maxHeight <= 120 - 8, `翻上方后仍在界内：top=${fit.top} h=${fit.maxHeight}`)
    assert.ok(fit.maxHeight >= 96, '至少保留约 3 行可滚高度')
  }
  /* 极矮 stage（<320）：列表至少 3 行高度可滚。 */
  {
    const fit = fitPopover({ stageW: 800, stageH: 200, anchorRect: { left: 10, top: 90, right: 210, bottom: 100 }, popW: 300, popH: 5000, minListHeight: 96 })
    assert.ok(fit.maxHeight >= 96, `极矮 stage 保留最小高度：${fit.maxHeight}`)
    assert.ok(fit.top >= 8 && fit.top + fit.maxHeight <= 200, '仍完整落在 stage 内')
  }
  /* 水平翻转：右侧放不下 → 锚点左侧。 */
  {
    const fit = fitPopover({ stageW: 400, stageH: 900, anchorRect: { left: 350, top: 40, right: 390, bottom: 70 }, popW: 300, popH: 200 })
    assert.equal(fit.side, 'left')
    assert.ok(fit.left >= 8 && fit.left + 300 <= 400 - 8, `水平不越界：left=${fit.left}`)
  }
  /* 输入不被修改、结果确定。 */
  {
    const input = { stageW: 800, stageH: 600, anchorRect: { left: 10, top: 40, right: 210, bottom: 70 }, popW: 300, popH: 300 }
    const a = fitPopover(input)
    const b = fitPopover(input)
    assert.deepEqual(a, b, '两次结果一致')
    assert.deepEqual(input.anchorRect, { left: 10, top: 40, right: 210, bottom: 70 }, '输入未被修改')
  }
  ok('fitPopover：下方/翻转/极矮/水平翻转/确定性/不可变 全过')
}
{
  /* 生成物静态断言：列表弹性滚动、无 60vh、内联的几何函数存在。 */
  const canvas = await read('assets/canvas/canvas.html')
  assert.ok(canvas.includes('.cf-navlist{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0;overflow-y:auto;'), '.cf-navlist 弹性滚动 + min-height:0')
  assert.ok(!/\.cf-navlist\{[^}]*60vh/.test(canvas), '.cf-navlist 不允许 60vh')
  assert.ok(!/\.cf-navpop\{[^}]*60vh/.test(canvas), '.cf-navpop 不允许 60vh')
  assert.ok(canvas.includes('var fitPopover='), 'fitPopover 已内联（单一实现）')
  assert.ok(canvas.includes('overscroll-behavior:contain'), '列表滚动不外溢')
  assert.ok(canvas.includes("max-height:calc(100% - 80px)"), '左侧分类栏可滚')
  ok('生成物：navpop 弹性滚动 + 几何函数内联 + 分类栏可滚')
}

console.log(`\n[summary] menu: ${passed} checks passed`)
