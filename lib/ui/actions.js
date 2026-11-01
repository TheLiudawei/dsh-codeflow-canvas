/**
 * 画布可点击控件的**数据清单**（v1.2.2，需求一）——单一事实来源。
 *
 * 本模块只描述「画布上有哪些可点击控件、属于哪个面（surface）、点击后预期
 * 触发什么动作、何时启用、归属哪一层测试」，**不 import 任何东西**（纯数据，
 * 架构红线的 L 数据层）。两个消费方：
 *
 *   - `tools/port-canvas.mjs`：生成画布时把本清单序列化进
 *     `window.__CF_ACTION_MANIFEST__`（只读调试信息，浏览器自检脚本用）；
 *   - `tests/buttons.mjs`：静态清单/接线审计——每个静态按钮 id 必须在清单里
 *     登记且只登记一次；清单里每个静态 id 必须真的存在于生成物；每个控件
 *     至少有一条绑定证据（直接绑定 / 模式表 / 事件委托 / 选择器工厂）。
 *
 * 字段约定：
 *
 *   - `key`      全局唯一，形如 `<surface>:<id|语义名>`；
 *   - `id`       静态 HTML 里的元素 id（与 `selector` 至少有一个）；
 *   - `selector` 动态控件的选择器（运行时由模板/菜单工厂生成）；
 *   - `handler`  预期动作：全局函数名（审计会验证 `function <name>(` 真实
 *                存在），或 `local:<surface>:<动作>`（对话框内的局部匿名
 *                handler，审计只要求绑定存在，不要求全局同名函数）；
 *   - `bind`     绑定证据的类别：`direct`（默认，按 id/selector 找
 *                addEventListener）| `pattern:<regex>`（循环绑定的动态 id，
 *                模式表在 tests/buttons.mjs 里声明并给出理由）|
 *                `delegate:<名称>`（事件委托，委托注册点登记在测试里）；
 *   - `dynamic`  true = 控件由运行时模板/菜单生成，静态 HTML 里没有同名 id；
 *   - `enabledWhen` 启用条件：always | hosted | modules | notRunning |
 *                bothViews | issue；非 always 的值必须能在源码里指出
 *                启用/禁用逻辑（enable 标记）或有 allowlist/手工行；
 *   - `test`     归属：`auto:*`（tests/buttons.mjs 直接断言）或
 *                `manual:*`（MANUAL-CHECKLIST.md 逐项验收）。
 *
 * @module dsh-codeflow-canvas/ui/actions
 */

export const CANVAS_ACTIONS = [
  /* ------------------------------ 工具栏（11 按钮 + 2 视图 tab） ---------- */
  { key: 'toolbar:cf-tb-new', id: 'cf-tb-new', surface: 'toolbar', label: '新建项目', handler: 'openNewDialog', enabledWhen: 'always', test: 'manual:toolbar-new' },
  { key: 'toolbar:cf-tb-import', id: 'cf-tb-import', surface: 'toolbar', label: '导入项目', handler: 'openImportDialog', enabledWhen: 'always', test: 'manual:toolbar-import' },
  { key: 'toolbar:cf-tb-add', id: 'cf-tb-add', surface: 'toolbar', label: '添加节点', handler: 'local:toolbar:add-node', enabledWhen: 'always', test: 'manual:toolbar-add' },
  { key: 'toolbar:cf-tb-runall', id: 'cf-tb-runall', surface: 'toolbar', label: '运行全部', handler: 'runAll', enabledWhen: 'always', test: 'manual:toolbar-runall' },
  { key: 'toolbar:cf-tb-undo', id: 'cf-tb-undo', surface: 'toolbar', label: '撤销运行', handler: 'openUndoDialog', enabledWhen: 'notRunning', test: 'auto:undo-button' },
  { key: 'toolbar:cf-tb-coupling', id: 'cf-tb-coupling', surface: 'toolbar', label: '耦合分析', handler: 'runCouplingAnalysis', enabledWhen: 'modules', test: 'auto:coupling-button' },
  { key: 'toolbar:cf-tb-layout', id: 'cf-tb-layout', surface: 'toolbar', label: '整理布局', handler: 'autoLayout', enabledWhen: 'always', test: 'manual:toolbar-layout' },
  { key: 'toolbar:cf-tb-fit', id: 'cf-tb-fit', surface: 'toolbar', label: '适应视图', handler: 'fitView', enabledWhen: 'always', test: 'manual:toolbar-fit' },
  { key: 'toolbar:cf-tb-settings', id: 'cf-tb-settings', surface: 'toolbar', label: '设置', handler: 'openSettingsDialog', enabledWhen: 'hosted', test: 'manual:toolbar-settings' },
  { key: 'toolbar:cf-tb-save', id: 'cf-tb-save', surface: 'toolbar', label: '保存', handler: 'saveProject', enabledWhen: 'always', test: 'manual:toolbar-save' },
  { key: 'toolbar:cf-tb-help', id: 'cf-tb-help', surface: 'toolbar', label: '帮助', handler: 'openHelp', enabledWhen: 'always', test: 'manual:toolbar-help' },
  { key: 'toolbar:cf-vtab-tasks', id: 'cf-vtab-tasks', surface: 'toolbar', label: '任务流水线 tab', handler: 'switchView', enabledWhen: 'bothViews', bind: 'pattern:cf-vtab-(tasks|modules)', test: 'auto:view-tabs' },
  { key: 'toolbar:cf-vtab-modules', id: 'cf-vtab-modules', surface: 'toolbar', label: '模块结构图 tab', handler: 'switchView', enabledWhen: 'bothViews', bind: 'pattern:cf-vtab-(tasks|modules)', test: 'auto:view-tabs' },

  /* ------------------------------ 状态栏 ---------------------------------- */
  { key: 'status:cf-session', id: 'cf-session', surface: 'status', label: '会话入口（打开会话详情）', handler: 'openSessionDialog', enabledWhen: 'hosted', test: 'auto:session-chip' },
  { key: 'status:cf-projname', id: 'cf-projname', surface: 'status', label: '项目名（点击重命名）', handler: 'local:status:rename-project', enabledWhen: 'always', test: 'manual:projname' },

  /* ------------------------------ 横幅 ------------------------------------ */
  { key: 'banner:cf-banner-retry', id: 'cf-banner-retry', surface: 'banner', label: '重试（重发本次运行）', handler: 'local:banner:retry-run', enabledWhen: 'issue', test: 'manual:banner-retry' },
  { key: 'banner:cf-banner-x', id: 'cf-banner-x', surface: 'banner', label: '关闭横幅', handler: 'local:banner:close', enabledWhen: 'always', test: 'auto:banner-close' },

  /* ------------------------------ 空态 ------------------------------------ */
  { key: 'empty:cf-empty-new', id: 'cf-empty-new', surface: 'empty', label: '新建项目', handler: 'openNewDialog', enabledWhen: 'always', test: 'manual:empty-new' },
  { key: 'empty:cf-empty-import', id: 'cf-empty-import', surface: 'empty', label: '导入项目', handler: 'openImportDialog', enabledWhen: 'always', test: 'manual:empty-import' },

  /* ------------------------------ 缩放三键 -------------------------------- */
  { key: 'zoom:cf-z-in', id: 'cf-z-in', surface: 'zoom', label: '放大', handler: 'local:zoom:in', enabledWhen: 'always', test: 'manual:zoom-in' },
  { key: 'zoom:cf-z-out', id: 'cf-z-out', surface: 'zoom', label: '缩小', handler: 'local:zoom:out', enabledWhen: 'always', test: 'manual:zoom-out' },
  { key: 'zoom:cf-z-fit', id: 'cf-z-fit', surface: 'zoom', label: '缩放到全部节点', handler: 'fitView', enabledWhen: 'always', test: 'manual:zoom-fit' },

  /* ------------------------------ 画布导航 -------------------------------- */
  { key: 'nav:cf-navbtn', selector: '.cf-navbtn', surface: 'nav', label: '分类定位按钮（循环生成）', handler: 'local:nav:focus-category', dynamic: true, enabledWhen: 'always', test: 'auto:nav-buttons' },
  { key: 'navpop:cf-navrow', selector: '.cf-navrow', surface: 'navpop', label: '二级浮层节点行（循环生成）', handler: 'local:navpop:pick-row', dynamic: true, enabledWhen: 'always', test: 'auto:navpop-rows' },

  /* ------------------------------ 画布与节点面 ---------------------------- */
  { key: 'node:dblclick-details', selector: '.cf-node', surface: 'node', label: '双击节点查看详情（ROOT 委托 onDbl）', handler: 'openDetails', dynamic: true, bind: 'delegate:node-dblclick', enabledWhen: 'always', test: 'manual:node-details' },
  { key: 'node:contextmenu', selector: '.cf-node', surface: 'node', label: '节点右键菜单（ROOT 委托）', handler: 'openNodeMenu', dynamic: true, bind: 'delegate:node-contextmenu', enabledWhen: 'always', test: 'manual:node-menu' },
  { key: 'link:contextmenu', selector: '.cf-link-hit', surface: 'link', label: '连线右键菜单（ROOT 委托）', handler: 'openLinkMenu', dynamic: true, bind: 'delegate:link-contextmenu', enabledWhen: 'always', test: 'manual:link-menu' },
  { key: 'canvas:contextmenu', selector: '#codeflow-canvas', surface: 'canvas', label: '空白右键菜单（ROOT 委托）', handler: 'openCanvasMenu', dynamic: true, bind: 'delegate:canvas-contextmenu', enabledWhen: 'always', test: 'manual:canvas-menu' },
  { key: 'monitor:cf-monitor-head', selector: '.cf-monitor-head', surface: 'monitor', label: '执行监视器标题（折叠/展开）', handler: 'local:monitor:collapse', dynamic: true, enabledWhen: 'always', test: 'auto:monitor-collapse' },
  { key: 'card:cf-coupling-card', selector: '.cf-coupling-card', surface: 'card', label: '耦合卡片（打开详情）', handler: 'openCouplingDetails', dynamic: true, enabledWhen: 'always', test: 'auto:coupling-card' },
  { key: 'detail:cf-think-bottom', selector: '.cf-think-bottom', surface: 'detail', label: '思考流「回到底部」', handler: 'local:detail:scroll-bottom', dynamic: true, enabledWhen: 'always', test: 'auto:think-bottom' },

  /* ------------------------------ 对话框：公共骨架 ------------------------ */
  /* dHead 的关闭按钮 + 各对话框的「取消」：#cf-dialog 上的一次事件委托统一
     兜底（每个对话框自己的直接绑定保留，二者幂等）。 */
  { key: 'dialog:common:close', selector: '[data-act="close"]', surface: 'dialog', label: '关闭对话框（dHead ✕ / 关闭 / 开始使用）', handler: 'closeModal', dynamic: true, bind: 'delegate:dialog-close', enabledWhen: 'always', test: 'auto:dialog-close' },
  { key: 'dialog:common:cancel', selector: '[data-act="cancel"]', surface: 'dialog', label: '取消（撤销/新建/设置/拖拽等）', handler: 'closeModal', dynamic: true, bind: 'delegate:dialog-close', enabledWhen: 'always', test: 'auto:dialog-cancel' },
  { key: 'dialog:new:submit', selector: '[data-act="submit"]', surface: 'dialog:new', label: '生成初版', handler: 'local:dialog:new-submit', dynamic: true, enabledWhen: 'always', test: 'manual:new-submit' },
  { key: 'dialog:import:submit', selector: '[data-act="submit"]', surface: 'dialog:import', label: '开始导入', handler: 'local:dialog:import-submit', dynamic: true, enabledWhen: 'always', test: 'manual:import-submit' },
  { key: 'dialog:import:browse', selector: '[data-act="browse"]', surface: 'dialog:import', label: '浏览…（目录选择器）', handler: 'openBrowsePicker', dynamic: true, enabledWhen: 'always', test: 'manual:import-browse' },
  { key: 'dialog:confirm:submit', selector: '[data-act="submit"]', surface: 'dialog:confirm', label: '确定（openConfirm：清空画布/新建会话等）', handler: 'local:dialog:confirm-ok', dynamic: true, enabledWhen: 'always', test: 'manual:confirm-ok' },
  { key: 'dialog:prompt:submit', selector: '[data-act="submit"]', surface: 'dialog:prompt', label: '确定（openPrompt：重命名等）', handler: 'local:dialog:prompt-ok', dynamic: true, enabledWhen: 'always', test: 'manual:prompt-ok' },
  { key: 'dialog:add:row', selector: '.cf-trow', surface: 'dialog:add', label: '节点类型行（点击添加）', handler: 'local:dialog:add-pick', dynamic: true, enabledWhen: 'always', test: 'manual:add-row' },
  { key: 'dialog:details:session', selector: '[data-act="session"]', surface: 'dialog:details', label: '在会话中查看完整过程', handler: 'openSessionDialog', dynamic: true, enabledWhen: 'hosted', test: 'manual:details-session' },
  { key: 'dialog:coupling:rerun', selector: '[data-act="rerun"]', surface: 'dialog:coupling', label: '重新分析（耦合详情）', handler: 'runCouplingAnalysis', dynamic: true, enabledWhen: 'modules', test: 'auto:coupling-rerun' },
  { key: 'dialog:session:open', selector: '[data-act="open"]', surface: 'dialog:session', label: '打开会话', handler: 'requestOpenSession', dynamic: true, enabledWhen: 'session', test: 'manual:session-open' },
  { key: 'dialog:session:copy', selector: '[data-act="copy"]', surface: 'dialog:session', label: '复制会话 ID', handler: 'copyText', dynamic: true, enabledWhen: 'session', test: 'manual:session-copy' },
  { key: 'dialog:session:new', selector: '[data-act="new"]', surface: 'dialog:session', label: '新建会话', handler: 'rebindSession', dynamic: true, enabledWhen: 'always', test: 'manual:session-new' },
  { key: 'dialog:undo:restore', selector: '[data-run]', surface: 'dialog:undo', label: '撤销这次运行（预检行）', handler: 'confirmUndo', dynamic: true, enabledWhen: 'notRunning', test: 'manual:undo-restore' },
  { key: 'dialog:undoconfirm:confirm', selector: '[data-act="confirm"]', surface: 'dialog:undoconfirm', label: '撤销（预检确认框）', handler: 'local:dialog:undo-confirm', dynamic: true, enabledWhen: 'always', test: 'manual:undo-confirm' },
  { key: 'dialog:settings:save', selector: '[data-act="save"]', surface: 'dialog:settings', label: '保存设置', handler: 'local:dialog:settings-save', dynamic: true, enabledWhen: 'always', test: 'manual:settings-save' },
  { key: 'dialog:settings:reset-root', selector: '[data-act="reset-root"]', surface: 'dialog:settings', label: '恢复默认根目录', handler: 'local:dialog:settings-reset-root', dynamic: true, enabledWhen: 'always', test: 'manual:settings-reset-root' },
  { key: 'dialog:settings:reset-dir', selector: '[data-act="reset-dir"]', surface: 'dialog:settings', label: '恢复默认项目目录', handler: 'local:dialog:settings-reset-dir', dynamic: true, enabledWhen: 'always', test: 'manual:settings-reset-dir' },
  { key: 'dialog:drop:import', selector: '[data-act="import"]', surface: 'dialog:drop', label: '导入（拖拽确认框）', handler: 'local:dialog:drop-import', dynamic: true, enabledWhen: 'always', test: 'manual:drop-import' },
  { key: 'dialog:dropconflict:rename', selector: '[data-act="rename"]', surface: 'dialog:dropconflict', label: '改名（冲突框）', handler: 'local:dialog:conflict-rename', dynamic: true, enabledWhen: 'always', test: 'manual:conflict-rename' },
  { key: 'dialog:dropconflict:overwrite', selector: '[data-act="overwrite"]', surface: 'dialog:dropconflict', label: '覆盖（冲突框）', handler: 'local:dialog:conflict-overwrite', dynamic: true, enabledWhen: 'always', test: 'manual:conflict-overwrite' },

  /* ------------------------------ 目录浏览器（browse-ui.js） -------------- */
  { key: 'browse:roots', selector: '[data-b="roots"]', surface: 'browse', label: '根目录', handler: 'browseLoadRoots', dynamic: true, enabledWhen: 'always', test: 'manual:browse-roots' },
  { key: 'browse:up', selector: '[data-b="up"]', surface: 'browse', label: '上一级', handler: 'browseGoUp', dynamic: true, enabledWhen: 'always', test: 'manual:browse-up' },
  { key: 'browse:cancel', selector: '[data-b="cancel"]', surface: 'browse', label: '取消', handler: 'closeBrowsePicker', dynamic: true, enabledWhen: 'always', test: 'manual:browse-cancel' },
  { key: 'browse:pick', id: 'cf-browse-pick', selector: '[data-b="pick"]', surface: 'browse', label: '选择此目录', handler: 'browsePick', dynamic: true, enabledWhen: 'always', test: 'manual:browse-pick' },
  { key: 'browse:retry', selector: '[data-b="retry"]', surface: 'browse', label: '重试（读取失败后）', handler: 'local:browse:retry', dynamic: true, enabledWhen: 'always', test: 'manual:browse-retry' },
  { key: 'browse:row', selector: '.cf-browse-row', surface: 'browse', label: '目录行（单击选中 / 双击进入）', handler: 'local:browse:select-row', dynamic: true, enabledWhen: 'always', test: 'manual:browse-row' },
  /* 面包屑按 data-crumb 属性绑定（行内 class 拼接，不用 querySelector('.cf-browse-crumb')），
     用显式 markers 给出绑定证据。 */
  { key: 'browse:crumb', selector: '.cf-browse-crumb', surface: 'browse', label: '面包屑回跳', handler: 'local:browse:crumb', dynamic: true, bind: 'markers', markers: ["querySelectorAll('[data-crumb]')"], enabledWhen: 'always', test: 'manual:browse-crumb' },

  /* ------------------------------ 功能分组（features-ui.js） -------------- */
  /* 注意：.cf-fchip 本体是只读 span（展示归属名），可点击的是其中的
     .cf-fchip-x 移除按钮与 .cf-fchip-add 添加按钮——不要把容器登记成控件。 */
  { key: 'features:chip-x', selector: '.cf-fchip-x', surface: 'features', label: 'chip 移除节点', handler: 'local:features:chip-remove', dynamic: true, enabledWhen: 'always', test: 'manual:features-chip-x' },
  { key: 'features:chip-add', selector: '.cf-fchip-add', surface: 'features', label: '把选中节点加入分组', handler: 'local:features:chip-add', dynamic: true, enabledWhen: 'always', test: 'manual:features-chip-add' },
  { key: 'features:group-row', selector: '.cf-fgroup', surface: 'features', label: '分组行（点击整组高亮 / 右键组菜单）', handler: 'spotlightGroup', dynamic: true, enabledWhen: 'always', test: 'manual:features-group-row' },
  { key: 'features:farrow', selector: '.cf-farrow', surface: 'features', label: '分组展开/收起箭头', handler: 'local:features:toggle-group', dynamic: true, enabledWhen: 'always', test: 'manual:features-farrow' },
  { key: 'features:empty-btn', selector: '.cf-fempty-btn', surface: 'features', label: '让 agent 识别（空分组横幅）', handler: 'local:features:recognize', dynamic: true, enabledWhen: 'hosted', test: 'manual:features-empty-btn' },

  /* ------------------------------ 代表性菜单项 ---------------------------- */
  /* openMenu 的每一项由 tests/buttons.mjs 的菜单扫描器逐项验证
     （sep 不算控件；其余必须有 act 或非空 sub），这里只登记关键入口便于
     手工清单与浏览器自检引用。 */
  { key: 'menu:canvas:new-project', surface: 'menu:canvas', label: '新建项目…', handler: 'openNewDialog', dynamic: true, enabledWhen: 'always', test: 'manual:menu-canvas-new' },
  { key: 'menu:canvas:import', surface: 'menu:canvas', label: '导入项目…', handler: 'openImportDialog', dynamic: true, enabledWhen: 'always', test: 'manual:menu-canvas-import' },
  { key: 'menu:canvas:analyze-all-coupling', surface: 'menu:canvas', label: '分析全部耦合', handler: 'runCouplingAnalysis', dynamic: true, enabledWhen: 'modules', test: 'manual:menu-canvas-coupling' },
  { key: 'menu:node:run', surface: 'menu:node', label: '运行此节点（含上游）', handler: 'runNode', dynamic: true, enabledWhen: 'always', test: 'manual:menu-node-run' },
  { key: 'menu:node:rerun', surface: 'menu:node', label: '重跑此节点', handler: 'runNode', dynamic: true, enabledWhen: 'always', test: 'manual:menu-node-rerun' },
  { key: 'menu:node:analyze-coupling', surface: 'menu:node', label: '分析耦合', handler: 'runCouplingAnalysis', dynamic: true, enabledWhen: 'modules', test: 'manual:menu-node-coupling' },
  { key: 'menu:node:delete', surface: 'menu:node', label: '删除节点', handler: 'deleteSel', dynamic: true, enabledWhen: 'always', test: 'manual:menu-node-delete' },
  { key: 'menu:link:delete', surface: 'menu:link', label: '删除连线', handler: 'deleteSel', dynamic: true, enabledWhen: 'always', test: 'manual:menu-link-delete' },
  { key: 'menu:features:refresh', surface: 'menu:features', label: '重新识别（功能分组）', handler: 'refreshFeatures', dynamic: true, enabledWhen: 'always', test: 'manual:menu-features-refresh' },
]

/** 静态 id 的启用状态标记：生成物 HTML 里带 disabled/hidden 的控件必须给出
 *  「满足条件时移除 disabled/hidden」的源码证据（tests/buttons.mjs 逐条验证）。 */
export const ENABLE_MARKERS = {
  'toolbar:cf-tb-coupling': {
    function: 'updateCouplingButton',
    mustReference: ['COUPLING.running', 'modulesAvailable()'],
    disabledIsConditional: true,
  },
  'toolbar:cf-tb-undo': {
    function: 'updateUndoButton',
    mustReference: ['ACT.running', 'hasRunningNodes()'],
    disabledIsConditional: true,
  },
  'toolbar:cf-tb-settings': { marker: 'settingsBtn.hidden=false' },
  'status:cf-session': { marker: 'el.hidden=false' },
  'banner:cf-banner-retry': { marker: 'btn.hidden=' },
  'toolbar:cf-vtab-tasks': { marker: 'wrap.hidden=false' },
  'toolbar:cf-vtab-modules': { marker: 'wrap.hidden=false' },
}
