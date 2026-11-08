/**
 * 顶部命名菜单的**模型**（v1.3.0，需求一）——纯数据，单一事实来源。
 *
 * 菜单结构只有一个定义处：`lib/ui/menu.js`（本文件）。渲染
 * （`lib/ui/menu-html.js`，构建时产出静态标记）与绑定
 * （`tools/patches/menu-ui.js`，事件委托 + `action key → 现有函数` 查表）
 * 都消费同一份模型；展开态与 `< 720px` 的折叠态（☰ 分组面板）也由同一份
 * 模型渲染——**不存在第二份硬编码菜单列表**，`tests/menu.mjs` 会断言这点。
 *
 * 约定：
 *
 *   - `id`：菜单组标识（触发按钮 `cf-menu-<id>`、面板 `cf-menupop-<id>`）；
 *   - `items[].action`：**必须**是 `lib/ui/actions.js` 里的 CANVAS_ACTIONS
 *     key——菜单项与主按钮指向同一 action，只有一份动作定义、一份处理逻辑；
 *   - `items[].sep`：分隔线（不得出现在首/尾、不得连续——tests/menu.mjs 断言）；
 *   - `items[].icon`：`ICONS` 内联 SVG 映射的键，不引外部图标库。
 *
 * 依赖方向：只 import `./actions.js`（模型 → 清单），零 DOM / 零宿主。
 *
 * @module dsh-codeflow-canvas/ui/menu
 */
import { CANVAS_ACTIONS } from './actions.js'

/** 顶部命名菜单（顺序即渲染顺序）。 */
export const MENU_MODEL = [
  {
    id: 'project',
    label: '项目',
    items: [
      { action: 'toolbar:cf-tb-new', label: '新建项目…', icon: 'file-plus-2' },
      { action: 'toolbar:cf-tb-import', label: '导入项目…', icon: 'folder-open' },
      { action: 'toolbar:cf-tb-save', label: '保存项目', icon: 'save' },
      { sep: true },
      { action: 'toolbar:cf-tb-settings', label: '项目设置…', icon: 'settings' },
      { action: 'cards:cleanup-stale', label: '清理失效卡片…', icon: 'trash-2' },
    ],
  },
  {
    id: 'run',
    label: '运行',
    items: [
      { action: 'toolbar:cf-tb-runall', label: '运行全部', icon: 'play' },
      { action: 'toolbar:cf-tb-undo', label: '撤销运行…', icon: 'undo-2' },
      { sep: true },
      { action: 'toolbar:cf-tb-coupling', label: '耦合分析', icon: 'activity' },
    ],
  },
  {
    id: 'view',
    label: '视图',
    items: [
      { action: 'toolbar:cf-vtab-tasks', label: '任务流水线', icon: 'list' },
      { action: 'toolbar:cf-vtab-modules', label: '模块结构图', icon: 'shapes' },
      { sep: true },
      { action: 'toolbar:cf-tb-add', label: '添加任务…', icon: 'plus' },
      { action: 'toolbar:cf-tb-layout', label: '整理布局', icon: 'layout-list' },
      { action: 'toolbar:cf-tb-fit', label: '适应视图', icon: 'maximize' },
    ],
  },
  {
    id: 'help',
    label: '帮助',
    items: [
      { action: 'toolbar:cf-tb-help', label: '使用帮助', icon: 'info' },
      { action: 'logs:open-viewer', label: '查看工作日志…', icon: 'file-text' },
    ],
  },
]

/** 校验模型与清单的一致性（生成器与 tests/menu.mjs 共用的同一份判定）。 */
export function validateMenuModel(model = MENU_MODEL, actions = CANVAS_ACTIONS) {
  const errors = []
  const keys = new Set(actions.map((entry) => entry.key))
  const groupIds = new Set()
  model.forEach((group, gi) => {
    if (!group.id || groupIds.has(group.id)) errors.push(`菜单组 #${gi} 的 id 缺失或重复：${JSON.stringify(group.id)}`)
    groupIds.add(group.id)
    if (!group.label) errors.push(`菜单组 ${group.id} 缺 label`)
    const valid = group.items.filter((item) => !item.sep)
    if (valid.length < 2 && group.id !== 'help') errors.push(`菜单组 ${group.id} 有效项不足 2 个`)
    if (group.items.length === 0) errors.push(`菜单组 ${group.id} 为空`)
    if (group.items[0]?.sep) errors.push(`菜单组 ${group.id} 以分隔线开头`)
    if (group.items[group.items.length - 1]?.sep) errors.push(`菜单组 ${group.id} 以分隔线结尾`)
    group.items.forEach((item, ii) => {
      if (item.sep) {
        if (group.items[ii + 1]?.sep) errors.push(`菜单组 ${group.id} 出现连续分隔线（位置 ${ii}）`)
        return
      }
      if (!item.label) errors.push(`菜单组 ${group.id} 项 ${ii} 缺 label`)
      if (!keys.has(item.action)) errors.push(`菜单组 ${group.id} 项「${item.label}」的 action ${item.action} 不在 CANVAS_ACTIONS`)
    })
  })
  return errors
}
