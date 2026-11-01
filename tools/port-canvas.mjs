/**
 * Port the ZCode canvas fragment to the DSH panel document.
 *
 * `tools/upstream/canvas-template.html` is the untouched v0.2.2 fragment kept as
 * the reference implementation: a complete node editor whose only ZCode
 * dependencies are the `window.zcode` bridge and a placeholder the agent used to
 * substitute. This script rewrites exactly those seams and nothing else, so the
 * editor behaviour stays byte-identical and every deviation is listed here
 * rather than scattered across a hand-edited copy.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 <electron|node> tools/port-canvas.mjs
 * Out: assets/canvas/canvas.html
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('upstream/canvas-template.html', import.meta.url))
const OUT = fileURLToPath(new URL('../assets/canvas/canvas.html', import.meta.url))

const replacements = []

/**
 * Replace the text between two markers (exclusive of `endMarker`).
 * @returns the rewritten text.
 */
function replaceRange(src, startMarker, endMarker, replacement, label) {
  const start = src.indexOf(startMarker)
  if (start < 0) throw new Error(`${label}: start marker not found: ${JSON.stringify(startMarker.slice(0, 60))}`)
  const end = src.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`${label}: end marker not found: ${JSON.stringify(endMarker.slice(0, 60))}`)
  replacements.push(`${label} (${end - start} chars -> ${replacement.length})`)
  return src.slice(0, start) + replacement + src.slice(end)
}

/** Replace one exact occurrence. */
function replaceOnce(src, needle, replacement, label) {
  const at = src.indexOf(needle)
  if (at < 0) throw new Error(`${label}: not found: ${JSON.stringify(needle.slice(0, 80))}`)
  if (src.indexOf(needle, at + 1) >= 0) throw new Error(`${label}: occurrences > 1`)
  replacements.push(`${label} (${needle.length} -> ${replacement.length})`)
  return src.slice(0, at) + replacement + src.slice(at + needle.length)
}

let text = readFileSync(SRC, 'utf8')

/* ---------------------------------------------------------------- header --- */
/* replaceRange 保留 endMarker（src.slice(end) 从 '-->' 开始），所以 replacement
   绝不能再自带一个 '-->'：v0.6.x 的替换结尾多写了一个终止符，生成物第 6 行变成
   '-->-->'，浏览器把多余的 '-->' 当正文文本渲染出一条 ~22px 的空隙（v1.0 B）。 */
text = replaceRange(text, '<!--', '-->', `<!--
  CodeFlow 画布（DSH 面板文档）
  本文件由 tools/port-canvas.mjs 从 ZCode 版 canvas-template.html 生成，
  只改动了与宿主的接线（数据来源、消息通道、图标、高度），编辑器行为保持不变。
  请勿手工修改：改上游模板或改本脚本，然后重新生成。
`, 'header comment')

/* ------------------------------------------------------- undo toolbar btn --- */
/* 撤销运行：宿主每次画布运行前对项目源码树做快照，撤销恢复文件与节点状态（lib/undo.js） */
text = replaceOnce(
  text,
  '<button type="button" class="cf-tbtn cf-accent" id="cf-tb-runall" data-tooltip="按拓扑顺序执行所有待运行节点"><i data-lucide="play"></i>运行全部</button>',
  '<button type="button" class="cf-tbtn cf-accent" id="cf-tb-runall" data-tooltip="按拓扑顺序执行所有待运行节点"><i data-lucide="play"></i>运行全部</button>\n'
  + '    <button type="button" class="cf-tbtn" id="cf-tb-undo" data-tooltip="撤销最近一次画布运行：恢复文件与节点状态（也可 Ctrl+Alt+Z）" aria-label="撤销运行" disabled><i data-lucide="undo-2"></i>撤销运行</button>',
  'toolbar undo button',
)

/* ------------------------------------------------------------ view tabs --- */
/* 双视图切换：任务流水线（workflow.json）/ 模块结构图（workflow.modules.json）。
   只在两个视图都可用时显示；切出视图的编辑活动用小圆点提示。 */
text = replaceOnce(
  text,
  '<span class="cf-tsep"></span>\n    <button type="button" class="cf-tbtn cf-accent" id="cf-tb-runall"',
  '<span class="cf-tsep"></span>\n'
  + '    <div class="cf-viewtabs" id="cf-viewtabs" role="tablist" aria-label="画布视图切换" hidden>\n'
  + '      <button type="button" class="cf-viewtab" id="cf-vtab-tasks" role="tab" aria-selected="true" tabindex="0" data-tooltip="任务流水线视图（workflow.json）"><span class="cf-vtab-name">任务流水线</span><span class="cf-vtab-count">0</span><span class="cf-vtab-dot" hidden title="该视图有模块正在被修改"></span></button>\n'
  + '      <button type="button" class="cf-viewtab" id="cf-vtab-modules" role="tab" aria-selected="false" tabindex="-1" data-tooltip="模块结构图视图（workflow.modules.json）"><span class="cf-vtab-name">模块结构图</span><span class="cf-vtab-count">0</span><span class="cf-vtab-dot" hidden title="该视图有模块正在被修改"></span></button>\n'
  + '    </div>\n'
  + '    <button type="button" class="cf-tbtn cf-accent" id="cf-tb-runall"',
  'toolbar view tabs',
)

/* -------------------------------------------------- settings + tooltip --- */
/* v1.0：设置入口（齿轮 → 设置弹窗：项目根目录/项目目录），独立预览隐藏；
   保存按钮的 tooltip 同步改为 CodeFlow/flow-projects/（需求 C 的文案） */
text = replaceOnce(
  text,
  '<button type="button" class="cf-tbtn" id="cf-tb-save" data-tooltip="把工作流图保存到 flow-projects/ 目录"><i data-lucide="save"></i>保存</button>',
  '<button type="button" class="cf-tbtn" id="cf-tb-settings" data-tooltip="CodeFlow 设置：项目根目录与项目目录" aria-label="设置" hidden><i data-lucide="settings"></i>设置</button>\n'
  + '    <button type="button" class="cf-tbtn" id="cf-tb-save" data-tooltip="把工作流图保存到 CodeFlow/flow-projects/ 目录"><i data-lucide="save"></i>保存</button>',
  'toolbar settings button + save tooltip',
)

/* ------------------------------------------------- banner retry button --- */
/* v1.0（A3.4）：宿主对账出的「agent 未执行该节点」issue → 横幅 + 一键重试 */
text = replaceOnce(
  text,
  '<div class="cf-banner" id="cf-banner" hidden>\n'
  + '    <span class="cf-spin">◐</span><span id="cf-banner-text"></span>\n'
  + '    <button type="button" class="cf-banner-x" id="cf-banner-x" aria-label="关闭">✕</button>',
  '<div class="cf-banner" id="cf-banner" hidden>\n'
  + '    <span class="cf-spin">◐</span><span id="cf-banner-text"></span>\n'
  + '    <button type="button" class="cf-banner-retry" id="cf-banner-retry" hidden>重试</button>\n'
  + '    <button type="button" class="cf-banner-x" id="cf-banner-x" aria-label="关闭">✕</button>',
  'banner retry button',
)

/* ------------------------------------------------- session status entry --- */
/* 画布专用会话入口：显示绑定标题，点开弹窗（打开/复制 ID/新建会话） */
text = replaceOnce(
  text,
  '<span id="cf-saved">已暂存</span>\n    <span id="cf-mode" class="cf-modetag" hidden>独立模式</span>',
  '<span id="cf-saved">已暂存</span>\n'
  + '    <button type="button" class="cf-sbtn" id="cf-session" hidden data-tooltip="画布专用会话：画布里的运行只在该会话执行"></button>\n'
  + '    <span id="cf-mode" class="cf-modetag" hidden>独立模式</span>',
  'status bar session entry',
)

/* ------------------------------------------------ coupling toolbar btn --- */
/* v1.2 耦合分析：工具栏按钮 = 「分析全部耦合」。宿主始终分析模块图，任务视图
   点击同样执行（只刷卡片）。无模块图/运行中时置灰（coupling-ui.js 维护状态）。 */
text = replaceOnce(
  text,
  '<button type="button" class="cf-tbtn" id="cf-tb-undo" data-tooltip="撤销最近一次画布运行：恢复文件与节点状态（也可 Ctrl+Alt+Z）" aria-label="撤销运行" disabled><i data-lucide="undo-2"></i>撤销运行</button>',
  '<button type="button" class="cf-tbtn" id="cf-tb-undo" data-tooltip="撤销最近一次画布运行：恢复文件与节点状态（也可 Ctrl+Alt+Z）" aria-label="撤销运行" disabled><i data-lucide="undo-2"></i>撤销运行</button>\n'
  + '    <button type="button" class="cf-tbtn" id="cf-tb-coupling" data-tooltip="耦合分析：全部模块的耦合程度与整体「屎山程度」（纯宿主执行，不唤醒 agent）" aria-label="耦合分析" disabled><i data-lucide="activity"></i>耦合分析</button>',
  'toolbar coupling button',
)

/* ---------------------------------------------- coupling context menus --- */
/* v1.2 右键入口：文件级模块节点 → 「分析耦合」；空白画布 → 「分析全部耦合」。
   canAnalyzeCouplingNode/runCouplingAnalysis 定义在 coupling-ui.js（同 IIFE 提升）。 */
text = replaceOnce(
  text,
  "    {label:'删除节点',icon:'trash-2',danger:true,act:function(){sel={type:'node',id:id};deleteSel();}}\n"
  + '  ];\n'
  + '  openMenu(items,x,y);\n'
  + '}',
  "    {label:'删除节点',icon:'trash-2',danger:true,act:function(){sel={type:'node',id:id};deleteSel();}}\n"
  + '  ];\n'
  + "  /* v1.2：文件级模块节点 → 单节点耦合分析（符号子节点不显示该菜单项） */\n"
  + "  if(canAnalyzeCouplingNode(n)){items.splice(3,0,{label:'分析耦合',icon:'activity',act:function(){runCouplingAnalysis(id);}});}\n"
  + '  openMenu(items,x,y);\n'
  + '}',
  'node menu coupling entry',
)
text = replaceOnce(
  text,
  "    {label:'导入项目…',icon:'folder-open',act:function(){openImportDialog();}},",
  "    {label:'导入项目…',icon:'folder-open',act:function(){openImportDialog();}},\n"
  + "    {label:'分析全部耦合',icon:'activity',act:function(){runCouplingAnalysis(null);}},",
  'canvas menu analyze-all entry',
)

/* ----------------------------------------------------- nav pop container --- */
/* 二级导航浮层：分类下 ≥2 个节点时弹出，可按名称搜索、按 ↑/↓ 选择、Enter 定位 */
text = replaceOnce(
  text,
  '<div class="cf-nav" id="cf-nav" role="tablist" aria-label="功能模块导航"></div>',
  '<div class="cf-nav" id="cf-nav" role="tablist" aria-label="功能模块导航"></div>\n'
  + '    <div class="cf-navpop" id="cf-navpop" hidden>\n'
  + '      <input class="cf-in cf-navsearch" id="cf-navsearch" type="text" placeholder="搜索模块名称…" aria-label="搜索节点名称">\n'
  + '      <div class="cf-navlist" id="cf-navlist" role="listbox" aria-label="节点列表"></div>\n'
  + '    </div>',
  'nav pop container',
)

/* ----------------------------------------------------------------- sizes --- */
text = replaceOnce(
  text,
  'position:relative; display:flex; flex-direction:column; height:780px;',
  'position:relative; display:flex; flex-direction:column; height:100%; min-height:0;',
  'root height fills the panel',
)

/* -------------------------------------------------------------- prologue --- */
text = replaceOnce(
  text,
  "var EMBED=__CF_GRAPH_JSON__;\nvar ZC=(typeof window.zcode==='object'&&window.zcode)?window.zcode:null;",
  [
    "/* 宿主注入的启动数据：{graph, rev, view, project, sessionId, sessionTitle, workspace, notice} */",
    "var BOOT=(typeof window.__CF_BOOT__==='object'&&window.__CF_BOOT__!==null)?window.__CF_BOOT__:null;",
    "var HOSTED=!!BOOT;",
    "var EMBED=HOSTED?BOOT.graph:null;",
    "/* 与宿主交换图的版本号：只采纳比自己已知版本更新的服务端状态，避免覆盖本地正在编辑的内容 */",
    "var syncRev=(HOSTED&&typeof BOOT.rev==='number')?BOOT.rev:-1;",
  ].join('\n'),
  'bridge prologue',
)

/* ------------------------------------------------------------------ boot --- */
text = replaceRange(text, 'function boot(){', 'function renderAll(){', `function boot(){
  var src=EMBED;
  /* 独立打开（无宿主）时才回落到浏览器本地暂存；面板里以宿主状态为准 */
  if(!valid(src)&&!HOSTED){
    try{
      var ls=JSON.parse(localStorage.getItem('cf-canvas-standalone')||'null');
      if(ls&&valid(ls.graph)){src=ls.graph;var v2=ls.view;if(Array.isArray(v2)&&v2.length===3){view={x:v2[0],y:v2[1],k:v2[2]};}}
    }catch(e){}
  }
  if(!valid(src)){src={format:'codeflow/1',rev:0,project:null,nodes:[],links:[],meta:{}};}
  G=clone(src);
  if(!G.meta)G.meta={};
  /* 启动视口：BOOT.viewport（v0.6.0 命名）优先，兼容旧 BOOT.view 数组 */
  var bootViewport=(HOSTED&&Array.isArray(BOOT.viewport)&&BOOT.viewport.length===3)?BOOT.viewport
    :((HOSTED&&Array.isArray(BOOT.view)&&BOOT.view.length===3)?BOOT.view:null);
  if(bootViewport){view={x:bootViewport[0],y:bootViewport[1],k:bootViewport[2]};}
  /* 清洗连线：丢弃引用缺失节点/越界端口的连线；输入端口只保留最后一条入线 */
  G.links=G.links.filter(function(l){
    if(!Array.isArray(l)||l.length<4)return false;
    var f=byId(l[0]),t=byId(l[2]);
    if(!f||!t)return false;
    return (typeOf(f).outs||[])[l[1]]&&(typeOf(t).ins||[])[l[3]];
  });
  (function(){var seen={},out=[];for(var i=G.links.length-1;i>=0;i--){var k=G.links[i][2]+'_'+G.links[i][3];if(seen[k])continue;seen[k]=1;out.push(G.links[i]);}out.reverse();G.links=out;})();
  /* 主题先定下来再首绘：内联写入的状态色（徽章/小地图）在 renderAll 时就会被读到 */
  applyTheme((HOSTED&&typeof BOOT.theme==='string')?BOOT.theme:systemScheme(),{silent:true});
  renderAll();
  applyView();
  if(G.nodes.length&&!bootViewport){requestAnimationFrame(function(){fitView();});}
  if(!HOSTED){$('cf-mode').hidden=false;}
  if(HOSTED){startSync();}else{saveState();}
  if(HOSTED&&BOOT.notice)showBanner(BOOT.notice);
}
`, 'boot()')

/* ----------------------------------------------------------------- icons --- */
text = replaceOnce(
  text,
  "function refreshIcons(){try{if(window.lucide&&window.lucide.createIcons)window.lucide.createIcons({attrs:{width:15,height:15}});}catch(e){}}",
  `/* 宿主不提供图标库：用内联 SVG 自绘，选择器与尺寸规则和原来一致（.cf-tbtn svg 等） */
var ICONS={
  'play':'<polygon points="6 3.5 19.5 12 6 20.5"/>',
  'plus':'<path d="M12 5v14M5 12h14"/>',
  'copy':'<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  'trash-2':'<path d="M3 6h18"/><path d="M19 6l-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  'info':'<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  'alert-triangle':'<path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  'folder-open':'<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  'file-plus-2':'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 12v6M9 15h6"/>',
  'pencil':'<path d="M17.5 3.5a2.5 2.5 0 0 1 3 3L7 20l-4 1 1-4z"/>',
  'layout-list':'<rect x="3" y="4" width="6" height="7" rx="1"/><rect x="3" y="14" width="6" height="7" rx="1"/><path d="M13 6h8M13 12h8M13 18h8"/>',
  'maximize':'<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  'zoom-in':'<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5 16 16M11 8v6M8 11h6"/>',
  'zoom-out':'<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5 16 16M8 11h6"/>',
  'rotate-cw':'<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  'save':'<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  'shapes':'<path d="M8.5 2.8 13 10H4z"/><rect x="3" y="13.5" width="9" height="8" rx="1.2"/><circle cx="17.5" cy="17.5" r="4.2"/>',
  'unlink':'<path d="M18.5 13.5a4 4 0 0 0 0-5.7l-2.6-2.6a4 4 0 0 0-5.7 0l-1.3 1.3"/><path d="M5.5 10.5a4 4 0 0 0 0 5.7l2.6 2.6a4 4 0 0 0 5.7 0l1.3-1.3"/><path d="M4 4l2.5 2.5M17.5 17.5 20 20"/>',
  'undo-2':'<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  'settings':'<circle cx="12" cy="12" r="3.1"/><path d="M12 2.9v2.5M12 18.6v2.5M2.9 12h2.5M18.6 12h2.5M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>',
  'activity':'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  'upload':'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>'
};
function refreshIcons(){
  var pending=ROOT.querySelectorAll('[data-lucide]');
  for(var i=0;i<pending.length;i++){
    var el=pending[i],name=el.getAttribute('data-lucide'),body=ICONS[name];
    el.removeAttribute('data-lucide');
    if(!body)continue;
    el.innerHTML='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+body+'</svg>';
  }
}`,
  'icon shim',
)

/* ------------------------------------------------------- standalone hint --- */
text = replaceOnce(
  text,
  '当前页面未连接 ZCode 会话（独立打开）。将文本粘贴到 ZCode 对话框即可获得相同结果。',
  '当前页面没有连接 DSH 会话（独立打开）。把这段文本粘贴到 DSH 对话框即可获得相同结果。',
  'standalone dialog wording',
)

/* ----------------------------------------------------------- save project --- */
text = replaceRange(text, 'function saveProject(){', '\n/* ================= 消息发送 ================= */', `function saveProject(){
  if(!G.project||!G.project.name){
    openPrompt('保存项目','项目名称','my-project',function(v){
      G.project=G.project||{};
      G.project.name=v;
      renderChrome();
      persistProject();
    });
    return;
  }
  persistProject();
}
/* 保存由宿主直接落盘（无需 agent 参与）：点一下就有文件。
   失败时宿主回 507 + ok:false，这里走 catch 而不是误报成功 */
function persistProject(){
  if(!HOSTED){
    try{localStorage.setItem('cf-canvas-standalone',JSON.stringify({graph:G,view:[view.x,view.y,view.k]}));}catch(e){}
    toast('已保存到本机浏览器');
    return;
  }
  clearTimeout(saveTimer);
  queueWrite('save',function(){
    var body={project:G.project&&G.project.name,graph:G,view:CURVIEW,viewport:[view.x,view.y,view.k]};
    if(syncRev>=0)body.expectedRev=syncRev;
    return body;
  })
    .then(function(res){
      if(res&&res.persisted===false){toast(res.warning||'保存失败：图谱未能写入磁盘','err');return;}
      toast(res&&res.file?('已保存 '+res.file):'已保存项目');
      $('cf-saved').textContent='已暂存';
    })
    .catch(function(err){
      if(err&&err.status===409)syncConflict(err);
      else toast('保存失败：'+((err&&err.message)||err),'err');
    });
}
`, 'saveProject')

/* ------------------------------------------------------------ v1.0 copy --- */
/* 需求 C：项目目录迁到 CodeFlow/flow-projects/，画布里的说明文案同步 */
text = replaceOnce(
  text,
  `+'<div class="cf-hintbox">agent 将根据需求在 <b>flow-projects/&lt;项目名&gt;/</b> 下生成项目初版，并在画布上生成任务流水线。</div>'`,
  `+'<div class="cf-hintbox">agent 将根据需求在 <b>CodeFlow/flow-projects/&lt;项目名&gt;/</b> 下生成项目初版，并在画布上生成任务流水线；可在「设置」里自定义根目录。</div>'`,
  'new-project hint copy',
)
text = replaceOnce(
  text,
  '「保存项目」会让 agent 把工作流图写入 <b>flow-projects/&lt;项目&gt;/workflow.json</b>。',
  '「保存项目」会让宿主把工作流图写入 <b>CodeFlow/flow-projects/&lt;项目&gt;/workflow.json</b>（可在「设置」里改根目录）。',
  'help dialog copy',
)

/* ------------------------------------------------------ import dialog --- */
/* 导入不再唤醒 agent，也不再二选一：目录扫描由宿主 lib/duo.js 确定性完成，
   一次生成任务流水线与模块结构图两张图，导入后在画布上随时切换 */
text = replaceOnce(
  text,
  "agent 将扫描目录：自动识别主语言、按各语言注释语法提取 TODO/FIXME 等标记，生成「扫描 → 注释解析 → 任务节点 → 审查 → 交付」工作流。最多读取 1000 个文件。",
  '宿主直接扫描目录（无需 agent，秒级完成）：同时生成任务流水线与模块结构图，导入后可随时切换查看与运行。最多读取 1000 个文件。',
  'import dialog hint',
)
text = replaceOnce(
  text,
  `sendMessage('IMPORT',{
      path:path,
      depth:depth,
      fromComments:fromComments,
      addTests:addTests
    },'CodeFlow · 导入项目');`,
  `importProject({
      path:path,
      depth:depth,
      fromComments:fromComments,
      addTests:addTests
    });`,
  'import dialog submit',
)

text = replaceOnce(
  text,
  `+fld('项目路径','<input class="cf-in" data-f="path" placeholder="绝对路径或工作区相对路径，如 D:\\\\code\\\\legacy-app 或 ./server">')`,
  `+fld('项目路径','<input class="cf-in" data-f="path" placeholder="绝对路径（如 /Users/you/project、~/project）或工作区相对路径（./server）；@ 选中的路径也可直接粘贴">')`,
  'import dialog path placeholder',
)

/* ------------------------------------------------ module navigation+pop --- */
/* v0.6.0：分类点击 → 1 个节点直接定位；≥2 弹出可搜索二级浮层；聚焦单个节点；
   浮层支持标题/路径搜索、↑/↓/Enter 键盘导航、Esc/外点关闭 */
text = replaceRange(text, 'function renderNav(){', '/* ================= 连线渲染 ================= */', `function renderNav(){
  var nav=$('cf-nav');
  nav.innerHTML='';
  CATS.forEach(function(c){
    var cnt=0;
    G.nodes.forEach(function(n){if(typeOf(n).cat===c[0])cnt++;});
    var b=document.createElement('button');
    b.type='button';
    b.className='cf-navbtn'+(navActive===c[0]?' active':'');
    b.setAttribute('role','tab');
    b.setAttribute('aria-selected',navActive===c[0]?'true':'false');
    b.disabled=cnt===0;
    b.title=cnt?('定位'+c[1]+'类节点（'+cnt+'）'):('画布上暂无'+c[1]+'类节点');
    b.innerHTML='<span class="cf-navdot" style="background:'+typeColor(c[0])+'"></span>'
      +'<span class="cf-navlabel">'+esc(c[1])+'</span><span class="cf-navcount">'+cnt+'</span>';
    if(cnt)b.addEventListener('click',function(){onCategoryClick(c[0],b);});
    nav.appendChild(b);
  });
  decorateNavDots();
}
/* 分类点击：0 个不响应（按钮已禁用）；1 个直接定位（少一次点击）；≥2 弹浮层 */
function onCategoryClick(cat,btn){
  var ns=G.nodes.filter(function(n){return typeOf(n).cat===cat;});
  if(!ns.length)return;
  if(navPop.open&&navPop.cat===cat){closeNavPop();return;}
  if(ns.length===1){
    closeNavPop();
    navActive=cat;renderNav();
    focusNode(ns[0].id,btn);
    return;
  }
  openNavPop(cat,btn);
}
/* 定位单个节点：缩放/平移到它（≈1.0–1.2 倍、居中、带动画），高亮约 1.8s，
   其余节点变暗；同时设为选中态，焦点交还触发按钮 */
function focusNode(id,anchorBtn){
  var n=byId(id);if(!n)return;
  sel={type:'node',id:id};markSel();redrawLinks();
  var el=nodeEls[id];
  var w=el?el.offsetWidth:(typeOf(n).w||240),h=el?el.offsetHeight:130;
  var cx=n.pos[0]+w/2,cy=n.pos[1]+h/2;
  var r=stageRect();
  var k=Math.max(0.5,Math.min(1.2,Math.max(view.k,1.05)));
  animateView(r.width/2-cx*k,r.height/2-cy*k,k,340);
  ROOT.classList.add('cf-focusing');
  G.nodes.forEach(function(nn){var e2=nodeEls[nn.id];if(e2)e2.classList.toggle('cf-hit',nn.id===id);});
  if(focusTimer)clearTimeout(focusTimer);
  focusTimer=setTimeout(function(){
    ROOT.classList.remove('cf-focusing');
    G.nodes.forEach(function(nn){var e2=nodeEls[nn.id];if(e2)e2.classList.remove('cf-hit');});
  },1800);
  if(anchorBtn&&anchorBtn.isConnected){try{anchorBtn.focus({preventScroll:true});}catch(e){}}
}
function clearNavActive(){
  if(!navActive)return;
  navActive=null;renderNav();
}
/* ---- 二级浮层：可搜索的节点列表 ---- */
var navPop={open:false,cat:null,query:'',items:[],active:-1,anchor:null};
function openNavPop(cat,anchorBtn){
  var ns=G.nodes.filter(function(n){return typeOf(n).cat===cat;});
  if(ns.length<2)return;
  navPop.open=true;navPop.cat=cat;navPop.query='';navPop.active=0;navPop.anchor=anchorBtn||null;
  navActive=cat;renderNav();
  var pop=$('cf-navpop');
  pop.hidden=false;
  $('cf-navsearch').value='';
  renderNavPop();
  positionNavPop();
  try{$('cf-navsearch').focus();}catch(e){}
}
function positionNavPop(){
  var pop=$('cf-navpop');
  var rr=ROOT.getBoundingClientRect();
  var ref=(navPop.anchor&&navPop.anchor.isConnected)?navPop.anchor:$('cf-nav');
  var br=ref.getBoundingClientRect();
  var left=br.right-rr.left+6;
  var top=br.top-rr.top;
  pop.style.left=left+'px';
  pop.style.top=top+'px';
  var ph=pop.offsetHeight,pw=pop.offsetWidth;
  if(top+ph>rr.height-6)pop.style.top=Math.max(4,rr.height-ph-6)+'px';
  if(left+pw>rr.width-6)pop.style.left=Math.max(4,br.left-rr.left-pw-6)+'px';
}
/* 列表行：类型色点 + 标题 + 次级说明（模块相对路径 / 任务状态摘要）+ 编辑标签。
   默认按标题 zh-CN 排序；搜索命中标题的排在命中路径的前面 */
function navPopSource(){
  return G.nodes.filter(function(n){return typeOf(n).cat===navPop.cat;});
}
function navPopItems(){
  var q=navPop.query.trim().toLowerCase();
  var items=navPopSource().map(function(n){
    var t=typeOf(n);
    var sub='';
    if(n.type==='module'&&n.params&&n.params.path){
      var segs=String(n.params.path).split('\\\\').join('/').split('/');
      sub=segs.slice(Math.max(0,segs.length-3)).join('/');
    }else{
      var st=STC[n.status]||STC.pending;
      sub=st[0]+(n.result?(' · '+n.result):'');
    }
    var title=String(n.title||t.label);
    var hitTitle=!q||title.toLowerCase().indexOf(q)>=0;
    var hitPath=!q||!sub?hitTitle:(sub.toLowerCase().indexOf(q)>=0);
    return {n:n,title:title,sub:sub,hitTitle:hitTitle,hitPath:hitPath};
  }).filter(function(it){return it.hitTitle||it.hitPath;});
  items.sort(function(a,b){
    if(a.hitTitle!==b.hitTitle)return a.hitTitle?-1:1;
    return a.title.localeCompare(b.title,'zh-CN')||String(a.sub).localeCompare(String(b.sub),'zh-CN');
  });
  return items;
}
function renderNavPop(){
  var list=$('cf-navlist');
  var items=navPopItems();
  navPop.items=items;
  if(navPop.active>=items.length)navPop.active=items.length>0?items.length-1:-1;
  if(!items.length){list.innerHTML='<div class="cf-navempty">没有匹配的节点</div>';return;}
  list.innerHTML=items.map(function(it,i){return navRowHtml(it,i===navPop.active);}).join('');
  bindNavRowEvents(list);
  scrollNavPopActive();
}
/* 单行结构（v1.1 抽取：features 分组渲染复用同一行结构与事件绑定） */
function navRowHtml(it,active){
  var st=(EDIT_BY_VIEW[CURVIEW]||{})[it.n.id];
  var tag=st?(st.state==='editing'?'<span class="cf-edittag">修改中</span>':st.state==='error'?'<span class="cf-edittag err">修改失败</span>':'<span class="cf-edittag">已修改</span>'):'';
  return '<div class="cf-navrow'+(active?' active':'')+'" role="option" data-id="'+esc(it.n.id)+'" aria-selected="'+(active?'true':'false')+'">'
    +'<span class="cf-navdot" style="background:'+typeColor(typeOf(it.n).cat)+'"></span>'
    +'<span class="cf-navrow-main"><span class="cf-navrow-title">'+esc(it.title)+'</span>'
    +(it.sub?'<span class="cf-navrow-sub" title="'+esc(it.sub)+'">'+esc(it.sub)+'</span>':'')+'</span>'
    +tag+'</div>';
}
function bindNavRowEvents(list){
  Array.prototype.forEach.call(list.querySelectorAll('.cf-navrow'),function(row){
    row.addEventListener('click',function(){pickNavRow(row.dataset.id);});
    row.addEventListener('pointermove',function(){setNavActiveId(row.dataset.id);});
  });
}
function scrollNavPopActive(){
  var list=$('cf-navlist');
  var active=list.querySelector('.cf-navrow.active');
  if(active&&active.scrollIntoView)try{active.scrollIntoView({block:'nearest'});}catch(e){}
}
function setNavActiveId(id){
  var list=$('cf-navlist');
  navPop.active=-1;
  navPop.items.forEach(function(it,i){if(it.n.id===id)navPop.active=i;});
  Array.prototype.forEach.call(list.querySelectorAll('.cf-navrow'),function(row){
    var on=row.dataset.id===id;
    row.classList.toggle('active',on);
    row.setAttribute('aria-selected',on?'true':'false');
  });
  scrollNavPopActive();
}
function pickNavRow(id){
  var it=null;
  navPop.items.forEach(function(entry){if(entry.n.id===id)it=entry;});
  if(!it)return;
  var anchor=navPop.anchor;
  closeNavPop();
  focusNode(id,anchor);
}
function closeNavPop(){
  if(!navPop.open)return;
  var cat=navPop.cat;
  var anchor=navPop.anchor;
  navPop.open=false;navPop.cat=null;navPop.items=[];navPop.active=-1;
  $('cf-navpop').hidden=true;
  navPop.anchor=null;
  var hadActive=navActive;
  if(navActive){navActive=null;renderNav();}
  /* 焦点交还触发按钮（可访问性）：renderNav 已重建按钮，按分类序号找回 */
  var btn=(anchor&&anchor.isConnected)?anchor:(function(){
    if(!hadActive||!cat)return null;
    var idx=-1;
    CATS.forEach(function(c,i){if(c[0]===cat)idx=i;});
    return idx>=0?$('cf-nav').children[idx]:null;
  })();
  if(btn){try{btn.focus({preventScroll:true});}catch(e){}}
}
/* 画布开始拖拽/缩放时收起浮层（由 onDown/onWheel 调用；指向浮层内部时不关） */
function closeNavPopOnCanvas(e){
  if(!navPop.open)return;
  var t=e&&e.target;
  if(t&&t.closest&&t.closest('.cf-navpop'))return;
  if(t&&t.closest&&t.closest('.cf-nav'))return;
  closeNavPop();
}
$('cf-navsearch').addEventListener('input',function(e){
  if(!navPop.open)return;
  navPop.query=String(e.target.value||'');
  navPop.active=0;
  renderNavPop();
});
/* 浮层内键盘：↑/↓ 移动、Enter 选中、Esc 关闭；按键不进入画布快捷键 */
$('cf-navsearch').addEventListener('keydown',function(e){
  if(!navPop.open)return;
  if(e.key==='ArrowDown'){
    e.preventDefault();
    if(navPop.items.length){var nx=Math.min(navPop.items.length-1,navPop.active+1);setNavActiveId(navPop.items[nx].n.id);}
  }else if(e.key==='ArrowUp'){
    e.preventDefault();
    if(navPop.items.length){var pv=Math.max(0,navPop.active-1);setNavActiveId(navPop.items[pv].n.id);}
  }else if(e.key==='Enter'){
    e.preventDefault();
    if(navPop.items.length)pickNavRow(navPop.items[Math.max(0,navPop.active)].n.id);
  }else if(e.key==='Escape'){
    e.preventDefault();
    closeNavPop();
  }
  e.stopPropagation();
});
/* 图刷新后浮层仍在打开：列表重算但保留 query；节点失效/分类消失时关闭 */
var renderAllNavBase=renderAll;
renderAll=function(){
  renderAllNavBase();
  if(navPop.open){
    var still=navPop.cat&&navPopSource().length>=2;
    if(!still){closeNavPop();return;}
    renderNavPop();
    positionNavPop();
  }
};
document.addEventListener('pointerdown',function(e){
  if(navPop.open&&!e.target.closest('.cf-navpop')&&!e.target.closest('.cf-nav'))closeNavPop();
},true);

/* ================= 连线渲染 ================= */`, 'module navigation + secondary list')

/* ------------------------------------------- interaction hooks for pop --- */
/* 二级浮层的关闭时机：拖拽/缩放开始、Esc；浮层自身不参与画布手势 */
text = replaceOnce(
  text,
  `function onDown(e){
  if(e.button===2)return;
  cancelAnim();
  closeMenus();
  var tgt=e.target;
  if(tgt.closest('.cf-nav'))return;`,
  `function onDown(e){
  if(e.button===2)return;
  cancelAnim();
  closeMenus();
  closeNavPopOnCanvas(e);
  var tgt=e.target;
  if(tgt.closest('.cf-nav')||tgt.closest('.cf-navpop'))return;`,
  'onDown closes nav pop',
)
text = replaceOnce(
  text,
  `function onWheel(e){
  if(e.target.closest('.cf-modal'))return;
  if(mode!=='idle')return;
  e.preventDefault();
  cancelAnim();clearNavActive();`,
  `function onWheel(e){
  if(e.target.closest('.cf-modal')||e.target.closest('.cf-navpop'))return;
  if(mode!=='idle')return;
  e.preventDefault();
  cancelAnim();clearNavActive();
  closeNavPopOnCanvas(e);`,
  'onWheel closes nav pop',
)
text = replaceOnce(
  text,
  "if(e.key==='Escape'){closeMenus();closeModal();return;}",
  "if(e.key==='Escape'){closeNavPop();closeMenus();closeModal();return;}",
  'Escape closes nav pop',
)
text = replaceOnce(
  text,
  "function isBg(t){return !t.closest('.cf-node')&&!t.closest('.cf-link-hit')&&!t.closest('.cf-mini')&&!t.closest('.cf-zoomer')&&!t.closest('.cf-menu')&&!t.closest('.cf-modal')&&!t.closest('.cf-banner');}",
  "function isBg(t){return !t.closest('.cf-node')&&!t.closest('.cf-link-hit')&&!t.closest('.cf-mini')&&!t.closest('.cf-zoomer')&&!t.closest('.cf-menu')&&!t.closest('.cf-modal')&&!t.closest('.cf-banner')&&!t.closest('.cf-navpop');}",
  'isBg excludes nav pop',
)

/* ------------------------------------------------- link svg dataset hooks --- */
/* v1.1 整组高亮：每条连线的小 SVG 记录两端节点 id，spotlight 据此给
   「两端都在组内」的连线加 .cf-spot-link（加粗/提亮）。 */
text = replaceOnce(
  text,
  `    var svg=document.createElementNS(NS,'svg');
    svg.setAttribute('class','cf-linksvg');`,
  `    var svg=document.createElementNS(NS,'svg');
    svg.setAttribute('class','cf-linksvg');
    svg.setAttribute('data-from',l[0]);
    svg.setAttribute('data-to',l[2]);`,
  'link svg dataset hooks',
)

/* ----------------------------------------------------- nextId prefixes --- */
/* v0.6.0：新节点 id 按当前视图取前缀（任务 t…、模块 m…），两张图各自计数，
   旧图遗留的 n… id 仍是合法 id，只是不再新增 */
text = replaceOnce(
  text,
  `function nextId(){
  var seq=G.seq||0,max=seq;
  G.nodes.forEach(function(n){var m=/^n(\\d+)$/.exec(n.id);if(m)max=Math.max(max,Number(m[1]));});
  max++;G.seq=max;return 'n'+max;
}`,
  `function nextId(){
  var prefix=(CURVIEW==='modules')?'m':'t';
  var re=new RegExp('^'+prefix+'(\\\\d+)$');
  var max=0;
  G.nodes.forEach(function(n){var m=re.exec(n.id);if(m)max=Math.max(max,Number(m[1]));});
  return prefix+(max+1);
}`,
  'nextId view prefix',
)
/* 模块说明节点：宿主分析代码块结构（lib/analyst.js）生成的节点类型 */
text = replaceOnce(
  text,
  `  comments:{label:'注释解析',cat:'think',color:'#8b5cf6',w:250,desc:'提取 TODO/FIXME 与文件头注释',
    ins:[['文件清单','file']],outs:[['任务清单','json']],
    widgets:[['markers','select','关注标记','TODO,FIXME',['TODO','TODO,FIXME','全部(含NOTE,HACK)']],['makeTasks','bool','生成任务节点',true]]},`,
  `  comments:{label:'注释解析',cat:'think',color:'#8b5cf6',w:250,desc:'提取 TODO/FIXME 与文件头注释',
    ins:[['文件清单','file']],outs:[['任务清单','json']],
    widgets:[['markers','select','关注标记','TODO,FIXME',['TODO','TODO,FIXME','全部(含NOTE,HACK)']],['makeTasks','bool','生成任务节点',true]]},
  module:{label:'模块说明',cat:'think',color:'#8b5cf6',w:260,desc:'读源码文件，输出职责与结构说明',
    ins:[['依赖','any']],outs:[['模块说明','text']],
    widgets:[['path','text','文件路径',''],['symbol','text','聚焦符号(可选)','']]},`,
  'module node type',
)

/* ------------------------------------------------------- message channel --- */
text = replaceRange(text, 'function sendMessage(action,payload,title){', 'function showBanner(text){', `/* ================= 与宿主通信 ================= */
/* 面板跑在 iframe 里，与宿主同源，直接走 /codeflow/api/*（详见 lib/routes.js） */
/* 所有请求带超时：宿主卡住时手势不再永远悬挂（也是偶发 status=0 fetch failed 的兜底） */
function fetchT(path,opts,ms){
  var o=opts||{};
  try{
    if(typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout==='function')o.signal=AbortSignal.timeout(ms||15000);
  }catch(e){}
  return fetch(path,o);
}
function parseResp(r){
  return r.text().then(function(raw){
    var data=null;
    try{data=raw?JSON.parse(raw):null;}catch(e){}
    if(!r.ok){
      var err=new Error((data&&data.error)||('HTTP '+r.status));
      err.status=r.status;err.data=data;
      throw err;
    }
    return data||{};
  });
}
function apiPost(kind,body){
  return fetchT('/codeflow/api/'+kind,{
    method:'POST',
    headers:{'content-type':'application/json'},
    cache:'no-store',
    body:JSON.stringify(body)
  }).then(function(r){return parseResp(r);});
}
/* 写操作（autosave/save/action/import）全部串行 + 携带 expectedRev：
   expectedRev 在真正发送那一刻才读取，前一笔写完更新 syncRev 后才发下一笔，
   否则「保存按钮 + 待触发的 autosave」会用过期 rev 互相顶出 409。
   body 一律带 view=CURVIEW：写操作只作用于当前视图，绝不波及另一张图 */
var writeChain=Promise.resolve();
function queueWrite(kind,buildBody){
  var run=writeChain.then(function(){return apiPost(kind,buildBody());});
  writeChain=run.then(function(res){
    if(res&&typeof res.rev==='number')syncRev=res.rev;
  },function(){});
  return run;
}
/* 冲突（409）：另一窗口先写入了。不覆盖本地，也不悄悄抬高 syncRev——
   那等于绕过冲突检测；提示用户，最新内容由轮询/手动刷新采纳 */
function syncConflict(err){
  var cur=(err&&err.data&&err.data.currentRev)!=null?err.data.currentRev:'?';
  $('cf-saved').textContent='同步冲突';
  toast('画布刚被其他窗口修改（服务端 rev '+cur+'），本次写入被拒绝；请确认最新内容后再编辑','err');
  refreshLatestSoon();
}
function refreshLatestSoon(){
  var q=G.project&&G.project.name?('?project='+encodeURIComponent(G.project.name)+'&view='+CURVIEW):'';
  fetchT('/codeflow/api/state'+q,{headers:{'accept':'application/json'},cache:'no-store'})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(p){if(p)adoptServerState(p);})
    .catch(function(){});
}
var lastPersistToast=0;
function persistFailToast(msg){
  var now=Date.now();
  if(now-lastPersistToast<30000)return;
  lastPersistToast=now;
  toast('自动暂存未能落盘：'+msg,'err');
}
/* 采纳服务端更新的图（agent 回填）。只接受更新 rev 的**本视图**状态：
   payload.view 指明它属于哪个视图，别的视图的回填不进入当前画布；
   且不打断正在进行的手势/输入 */
function adoptServerState(payload){
  if(!payload||!valid(payload.graph))return false;
  if(typeof payload.rev!=='number'||payload.rev<=syncRev)return false;
  if(typeof payload.view==='string'&&payload.view!==CURVIEW)return false;
  if(mode!=='idle')return false;
  var el=document.activeElement;
  if(el&&ROOT.contains(el)&&/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))return false;
  syncRev=payload.rev;
  if(Array.isArray(payload.viewport)&&payload.viewport.length===3){view={x:payload.viewport[0],y:payload.viewport[1],k:payload.viewport[2]};}
  G=clone(payload.graph);
  if(!G.meta)G.meta={};
  renderAll();
  applyView();
  return true;
}
var syncTimer=null,syncFailures=0,degradedNotified=null;
function startSync(){
  if(syncTimer)return;
  syncTimer=setInterval(function(){
    if(document.hidden)return;
    var q=G.project&&G.project.name?('?project='+encodeURIComponent(G.project.name)+'&view='+CURVIEW):'';
    fetchT('/codeflow/api/state'+q,{headers:{'accept':'application/json'},cache:'no-store'})
      .then(function(r){return r.ok?r.json():null;})
      .then(function(p){
        syncFailures=0;
        if(!p)return;
        /* 损坏文件被隔离后，服务端会一直带 degraded：每个 rev 只提醒一次 */
        if(p.degraded&&degradedNotified!==p.rev){
          degradedNotified=p.rev;
          showBanner('警告：当前视图的图文件已损坏（'+((p.degraded&&p.degraded.reason)||'未知原因')+'）'
            +(p.degraded.quarantinedTo?('，坏文件已隔离为 '+p.degraded.quarantinedTo):'')
            +'；画布已重置，请重新编辑后保存。');
        }
        adoptServerState(p);
      })
      .catch(function(){
        syncFailures++;
        /* 连续失败才提示：单次网络抖动不值得打断用户 */
        if(syncFailures===3)showBanner('与宿主的连接中断，正在自动重试…（编辑仍在本地，恢复后继续同步）');
      });
  },1800);
}
/* 导入项目由宿主直接完成（/api/import → lib/duo.js 同时生成两张图）：
   不经过 agent，返回的任务流水线立即上画布，模块图切换即可见 */
function importProject(payload){
  if(!HOSTED){
    var obj0={action:'IMPORT',rev:G.rev||0};
    Object.keys(payload).forEach(function(k){obj0[k]=payload[k];});
    openCopyDialog('[CodeFlow:IMPORT]'+JSON.stringify(obj0));
    return;
  }
  queueWrite('import',function(){return payload;}).then(function(res){
    if(res&&res.graph&&valid(res.graph)){
      CURVIEW='tasks';
      if(res.views)VIEWMETA=res.views;
      G=clone(res.graph);
      if(!G.meta)G.meta={};
      sel={type:null,id:null};
      renderAll();
      applyView();
      if(G.nodes.length)requestAnimationFrame(function(){fitView();});
      renderViewTabs();
      if(res.warning)toast(res.warning,'err');
      else toast('导入完成：'+(res.summary||res.project||''));
    }else{
      toast('导入失败：'+((res&&(res.error||res.warning))||'未知错误'),'err');
    }
  }).catch(function(err){
    if(err&&err.status===409)syncConflict(err);
    else toast('导入失败：'+((err&&err.message)||err),'err');
  });
}
function sendMessage(action,payload,title){
  if(!HOSTED){
    var obj0={action:action,rev:G.rev||0};
    Object.keys(payload).forEach(function(k){obj0[k]=payload[k];});
    openCopyDialog('[CodeFlow:'+action+']'+JSON.stringify(obj0));
    return;
  }
  queueWrite('action',function(){
    /* body 在真正发送时构建：graph/expectedRev/viewport 都取当下值；
       view 告诉宿主本次运行作用于哪个视图（graphPath 也会指向对应文件） */
    var body={action:action,title:title,graph:G,view:CURVIEW,viewport:[view.x,view.y,view.k]};
    if(action!=='NEW'&&syncRev>=0)body.expectedRev=syncRev;
    if(payload.nodeId!=null)body.nodeId=payload.nodeId;
    if(payload.rerun!=null)body.rerun=payload.rerun;
    if(payload.brief!=null)body.brief=payload.brief;
    if(payload.autoRun!=null)body.autoRun=payload.autoRun;
    if(payload.path!=null)body.path=payload.path;
    if(payload.depth!=null)body.depth=payload.depth;
    if(payload.fromComments!=null)body.fromComments=payload.fromComments;
    if(payload.addTests!=null)body.addTests=payload.addTests;
    if(payload.project){
      if(payload.project.name)body.name=payload.project.name;
      if(payload.project.language)body.language=payload.project.language;
    }
    return body;
  }).then(function(res){
    /* 新建项目时宿主先写一张骨架图再交给 agent；立即采纳，避免界面还停在旧项目 */
    if(res&&res.graph&&valid(res.graph)){
      G=clone(res.graph);
      if(!G.meta)G.meta={};
      renderAll();
      applyView();
      if(G.nodes.length)requestAnimationFrame(function(){fitView();});
    }
    if(res&&res.delivered===false){
      showBanner((res.warning||'项目已创建，但 agent 未能接手')+'。画布仍可编辑、导入和保存。');
    }else{
      showBanner('已请求 agent：'+title+' — 执行完成后画布会自动回填');
    }
    if(res&&res.warning)toast(res.warning,'err');
  }).catch(function(err){
    if(err&&err.status===409)syncConflict(err);
    else toast('请求失败：'+((err&&err.message)||err),'err');
  });
}
`, 'message channel')

/* ------------------------------------------------------------- autosave --- */
text = replaceRange(text, 'function saveState(sooner){', '\n/* ================= 控件事件 ================= */', `function saveState(sooner){
  clearTimeout(saveTimer);
  saveTimer=setTimeout(function(){
    if(!HOSTED){
      try{localStorage.setItem('cf-canvas-standalone',JSON.stringify({graph:G,view:[view.x,view.y,view.k]}));}catch(e){}
      $('cf-saved').textContent='已暂存';
      return;
    }
    /* 宿主现在即时落盘并在响应里带 persisted/error：写失败不再被吞 */
    queueWrite('state',function(){
      var body={graph:G,view:CURVIEW,viewport:[view.x,view.y,view.k]};
      if(syncRev>=0)body.expectedRev=syncRev;
      return body;
    })
      .then(function(res){
        $('cf-saved').textContent=(res&&res.persisted===false)?'暂存失败（未落盘）':'已暂存';
        if(res&&res.persisted===false)persistFailToast((res&&res.error)||'图谱未能写入磁盘');
      })
      .catch(function(err){
        if(err&&err.status===409){syncConflict(err);}
        else{$('cf-saved').textContent='暂存失败';persistFailToast((err&&err.message)||'网络错误');}
      });
  },sooner?250:700);
}
`, 'autosave')

/* --------------------------------------------------------------- theming --- */
/* 两套调色板：表面/边框/文字由 CSS 变量承担（浅色规则见 tools/theme-light.css），
   内联写进 style 的颜色只能由 JS 换掉 —— 状态徽章与详情弹窗直接读 STC，
   小地图用 canvas 2D 画，都必须在切换后重绘一次。 */
const THEME_JS = `
/* ================= 深/浅色主题（由 port-canvas.mjs 追加） ================= */
var PALETTE={
  dark:{
    miniBg:'rgba(18,18,24,.92)', miniLink:'rgba(99,99,111,.7)', miniView:'rgba(124,140,255,.8)',
    stc:{pending:['待运行','#8a8a98'],running:['运行中','#3b82f6'],done:['完成','#22c55e'],failed:['失败','#ef4444'],skipped:['已跳过','#a16207']}
  },
  light:{
    miniBg:'rgba(248,249,251,.96)', miniLink:'rgba(139,147,163,.85)', miniView:'rgba(79,91,213,.85)',
    stc:{pending:['待运行','#6b7280'],running:['运行中','#1d4ed8'],done:['完成','#15803d'],failed:['失败','#dc2626'],skipped:['已跳过','#a16207']}
  }
};
var cfTheme='dark';
var MINI=PALETTE.dark;
function systemScheme(){
  try{if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)return 'dark';}catch(e){}
  return 'light';
}
/* silent=true 只换调色板与属性，不重绘（供 boot 首绘前调用） */
function applyTheme(next,opts){
  cfTheme=(next==='light')?'light':'dark';
  MINI=PALETTE[cfTheme];
  STC=MINI.stc;
  document.documentElement.setAttribute('data-cf-theme',cfTheme);
  if(!(opts&&opts.silent))renderAll();
}
/* 面板父窗口在 DSH 主题变化时推消息；不动 iframe.src，避免重载丢掉视图与选中态 */
window.addEventListener('message',function(e){
  var d=e&&e.data;
  if(d&&d.type==='codeflow:theme'&&d.scheme)applyTheme(d.scheme);
});
`
text = replaceOnce(
  text,
  "var SGLYPH={pending:'○',running:'◐',done:'✓',failed:'✗',skipped:'–'};",
  "var SGLYPH={pending:'○',running:'◐',done:'✓',failed:'✗',skipped:'–'};\n" + THEME_JS,
  'theme palette + applyTheme',
)

/* 小地图用 canvas 2D，颜色写死在 JS 里，改成读调色板 */
text = replaceOnce(
  text,
  "ctx.fillStyle='rgba(18,18,24,.92)';ctx.fillRect(0,0,W,H);",
  'ctx.fillStyle=MINI.miniBg;ctx.fillRect(0,0,W,H);',
  'minimap background follows the theme',
)
text = replaceOnce(
  text,
  "var stroke=ctx.strokeStyle;ctx.strokeStyle='rgba(99,99,111,.7)';ctx.lineWidth=1;",
  'var stroke=ctx.strokeStyle;ctx.strokeStyle=MINI.miniLink;ctx.lineWidth=1;',
  'minimap links follow the theme',
)
text = replaceOnce(
  text,
  "ctx.strokeStyle='rgba(124,140,255,.8)';\n  ctx.strokeRect(",
  'ctx.strokeStyle=MINI.miniView;\n  ctx.strokeRect(',
  'minimap viewport follows the theme',
)

/* ------------------------------------------------- new-component styles --- */
/* v0.5.0 新增组件的深色基线（浅色覆盖在 theme-light.css，选择器一一对应） */
const EXTRA_CSS = `
/* ---- v0.5.0：会话入口 / 节点活动行 / 执行监视器 / 执行过程 / 撤销 ---- */
.cf-sbtn{background:none;border:1px solid var(--cf-border);color:var(--cf-dim);font-size:11px;padding:2px 8px;border-radius:12px;cursor:pointer;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cf-sbtn:hover{border-color:var(--cf-border2);color:var(--cf-text);}
.cf-sbtn.has{color:var(--cf-text);border-color:var(--cf-border2);}
.cf-node-act{display:flex;align-items:center;gap:6px;margin:0 8px 7px;padding:3px 8px;font-size:10.5px;color:var(--cf-dim);background:#16161d;border-radius:6px;height:21px;overflow:hidden;}
.cf-act-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.cf-act-meta{flex:0 0 auto;color:#6d6d7c;font-size:10px;}
.cf-node-act.err{color:#f87171;}
.cf-act-spin{display:inline-block;animation:cf-rot 1.1s linear infinite;font-size:10px;flex:0 0 auto;}
.cf-monitor{position:absolute;top:10px;right:10px;z-index:8;width:284px;background:rgba(24,24,31,.94);border:1px solid var(--cf-border);border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.4);font-size:11.5px;color:var(--cf-dim);overflow:hidden;}
.cf-monitor-head{display:flex;align-items:center;gap:6px;padding:6px 10px;color:var(--cf-text);cursor:pointer;user-select:none;}
.cf-monitor-head .cf-mtitle{flex:1;font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cf-monitor-head .cf-fold{color:var(--cf-dim);font-size:10px;flex:0 0 auto;}
.cf-monitor-body{padding:0 10px 8px;display:flex;flex-direction:column;gap:4px;}
.cf-monitor.collapsed .cf-monitor-body{display:none;}
.cf-mrow{display:flex;gap:6px;min-width:0;align-items:baseline;}
.cf-mrow b{flex:0 0 auto;color:var(--cf-text);font-weight:500;}
.cf-mline{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.cf-mbar{height:4px;border-radius:2px;background:#2a2a38;position:relative;overflow:hidden;flex:1;}
.cf-mbar>i{position:absolute;left:0;top:0;bottom:0;background:var(--cf-accent);border-radius:2px;width:0;}
.cf-mbar.indeterminate>i{width:30%;animation:cf-slide 1.4s ease-in-out infinite;}
@keyframes cf-slide{0%{left:-30%}100%{left:100%}}
.cf-sec{margin-top:10px;}
.cf-sec-title{font-size:11.5px;color:var(--cf-dim);margin:0 0 5px;font-weight:600;}
.cf-sechint{font-size:10.5px;color:#6d6d7c;margin:0 0 6px;}
.cf-think{max-height:210px;overflow:auto;background:#16161d;border:1px solid var(--cf-border);border-radius:8px;padding:7px 9px;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--cf-text);position:relative;}
.cf-think.degraded{color:var(--cf-dim);font-style:italic;}
.cf-think-bottom{position:absolute;right:8px;bottom:8px;}
.cf-steps{display:flex;flex-direction:column;gap:3px;max-height:150px;overflow:auto;}
.cf-step{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--cf-dim);padding:3px 8px;background:#16161d;border-radius:6px;}
.cf-step .cf-stname{color:var(--cf-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.cf-step .cf-stst{margin-left:auto;flex:0 0 auto;font-size:10px;}
.cf-step.ok .cf-stst{color:#4ade80;}
.cf-step.error .cf-stst{color:#f87171;}
.cf-step.running .cf-stst{color:#60a5fa;}
.cf-artlist{display:flex;flex-direction:column;gap:3px;}
.cf-art{display:flex;align-items:baseline;gap:7px;font-size:11.5px;padding:4px 8px;background:#16161d;border-radius:6px;}
.cf-art .cf-artpath{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;word-break:break-all;color:var(--cf-text);}
.cf-art .cf-artlabel{color:var(--cf-dim);font-size:10.5px;flex:0 0 auto;}
.cf-art .cf-artkind{margin-left:auto;flex:0 0 auto;font-size:10px;color:#6d6d7c;}
.cf-undolist{display:flex;flex-direction:column;gap:6px;}
.cf-undorow{display:flex;align-items:center;gap:9px;padding:8px 10px;border:1px solid var(--cf-border);border-radius:8px;background:var(--cf-panel);}
.cf-undorow .cf-uinfo{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
.cf-undorow .cf-uline1{font-size:12px;color:var(--cf-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cf-undorow .cf-uline2{font-size:10.5px;color:var(--cf-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cf-ustate{font-size:10.5px;padding:1px 7px;border-radius:20px;border:1px solid var(--cf-border2);color:var(--cf-dim);flex:0 0 auto;white-space:nowrap;}
.cf-ustate.ok{color:#4ade80;border-color:rgba(34,197,94,.5);}
.cf-ustate.warn{color:#d29922;border-color:rgba(210,153,34,.4);}
.cf-ustate.dim{opacity:.75;}
.cf-btn.mini{padding:4px 10px;font-size:11.5px;}
.cf-progress-num{font-variant-numeric:tabular-nums;}
/* ---- v0.6.0：视图切换 / 二级导航浮层 / 编辑高亮 ---- */
.cf-viewtabs{display:inline-flex;align-items:center;gap:2px;border:1px solid var(--cf-border);border-radius:9px;padding:2px;background:var(--cf-panel2);}
.cf-viewtab{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:7px;border:1px solid transparent;background:none;color:var(--cf-dim);font-size:12px;cursor:pointer;white-space:nowrap;}
.cf-viewtab:hover{color:var(--cf-text);}
.cf-viewtab.active{background:rgba(124,140,255,.18);border-color:rgba(124,140,255,.45);color:#b9c2ff;}
.cf-viewtab .cf-vtab-count{font-size:10px;font-variant-numeric:tabular-nums;color:var(--cf-dim);}
.cf-viewtab.active .cf-vtab-count{color:#b9c2ff;}
.cf-vtab-dot{width:6px;height:6px;border-radius:50%;background:#f59e0b;flex:0 0 6px;}
.cf-navpop{position:absolute;z-index:12;width:300px;max-width:calc(100% - 20px);background:#20202a;border:1px solid var(--cf-border2);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.55);padding:7px;display:flex;flex-direction:column;gap:6px;}
.cf-navsearch{flex:0 0 auto;}
.cf-navlist{display:flex;flex-direction:column;gap:2px;max-height:60vh;overflow:auto;min-height:30px;}
.cf-navrow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent;}
.cf-navrow:hover,.cf-navrow.active{background:rgba(124,140,255,.14);border-color:rgba(124,140,255,.35);}
.cf-navrow .cf-navrow-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;}
.cf-navrow .cf-navrow-title{font-size:12px;color:var(--cf-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cf-navrow .cf-navrow-sub{font-size:10.5px;color:var(--cf-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cf-navempty{font-size:11.5px;color:var(--cf-dim);padding:8px;text-align:center;}
.cf-edittag{font-size:10px;padding:0 6px;border-radius:10px;border:1px solid rgba(245,158,11,.5);color:#fbbf24;flex:0 0 auto;white-space:nowrap;}
.cf-edittag.err{border-color:rgba(239,68,68,.5);color:#f87171;}
.cf-editbadge{font-size:9.5px;padding:0 6px;border-radius:8px;background:rgba(245,158,11,.18);border:1px solid rgba(245,158,11,.55);color:#fbbf24;flex:0 0 auto;white-space:nowrap;}
.cf-editbadge.err{background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.55);color:#f87171;}
.cf-node.cf-editing{border-color:#f59e0b !important;animation:cf-editpulse 1.6s ease-in-out infinite;}
@keyframes cf-editpulse{0%,100%{box-shadow:0 0 0 3px rgba(245,158,11,.35),0 4px 16px rgba(0,0,0,.45);}50%{box-shadow:0 0 0 7px rgba(245,158,11,.10),0 4px 16px rgba(0,0,0,.45);}}
.cf-node.cf-edited{border-color:rgba(245,158,11,.7);}
.cf-node.cf-edited .cf-node-head::after{content:'';width:7px;height:7px;border-radius:50%;background:#f59e0b;flex:0 0 7px;margin-left:2px;}
.cf-node.cf-edit-err{border-color:rgba(239,68,68,.8);}
.cf-node.cf-edit-related{border-style:dashed;border-color:rgba(245,158,11,.6);}
.cf-naveditdot{width:6px;height:6px;border-radius:50%;background:#f59e0b;flex:0 0 6px;}
@media (prefers-reduced-motion: reduce){.cf-node.cf-editing{animation:none;box-shadow:0 0 0 3px rgba(245,158,11,.35),0 4px 16px rgba(0,0,0,.45);}}
/* ---- v1.0：设置弹窗 / 横幅重试按钮 ---- */
.cf-setrow{margin-top:9px;display:flex;flex-direction:column;gap:4px;}
.cf-setrow label{font-size:11.5px;color:var(--cf-dim);}
.cf-setline{display:flex;gap:6px;align-items:center;}
.cf-setline .cf-in{flex:1;min-width:0;}
.cf-banner-retry{background:none;border:1px solid #c3cbff;color:#c3cbff;border-radius:10px;font-size:11px;padding:1px 10px;cursor:pointer;flex:0 0 auto;white-space:nowrap;}
.cf-banner-retry:hover{background:rgba(124,140,255,.18);}
`

/* ------------------------------------------------ canvas extras script --- */
/* v0.5.0 行为层：专用会话入口、实时执行过程（思考流/步骤/进度）、执行监视器、
   撤销运行。注入在 IIFE 尾部、boot() 之前，闭包访问 G/byId/renderAll 等内部绑定；
   对 renderChrome/renderNodes/isBg/sendMessage/adoptServerState 做定点包装，
   不改编辑器既有行为。所有动态文本一律 esc()/textContent，禁止拼接 innerHTML。 */
const ACTIVITY_JS = `
/* ================= v0.5.0：会话 / 执行过程 / 撤销 ================= */
var SESSION={id:(HOSTED&&BOOT.sessionId)||null,title:(HOSTED&&BOOT.sessionTitle)||null,warning:(HOSTED&&BOOT.sessionWarning)||null};
var ACT={running:false,seq:0,entries:[],byNode:{},progress:null,action:null,nodeId:null,startedAt:null,lastAt:0,deliverToasted:false};
var actTimer=null,actInflight=false,actIdleTimer=null,detailsNodeId=null,monitorEl=null;

function fmtMs(ms){
  if(typeof ms!=='number'||!(ms>=0))return '';
  var s=Math.floor(ms/1000);
  if(s<60)return s+'s';
  return Math.floor(s/60)+'m'+String(s%60).padStart(2,'0')+'s';
}
function fmtWhen(t){
  try{var d=new Date(t);return d.toLocaleString();}catch(e){return '';}
}
/* 与 apiPost 共用超时与错误结构（fetchT/parseResp 定义在与宿主通信一节，函数声明提升可用） */
function apiGet(path){
  return fetchT(path,{headers:{'accept':'application/json'},cache:'no-store'}).then(function(r){
    return parseResp(r);
  });
}
function hasRunningNodes(){
  for(var i=0;i<G.nodes.length;i++){if(G.nodes[i].status==='running')return true;}
  return false;
}
/* ---- 定点包装：状态栏 & 背景判定 & 消息发送 & 服务端采纳 ---- */
var renderChromeBase=renderChrome;
renderChrome=function(){renderChromeBase();renderSessionChip();updateUndoButton();renderViewTabs();};
var renderNodesBase=renderNodes;
renderNodes=function(){renderNodesBase();decorateNodes();applyEditMarks();};
var isBgBase=isBg;
isBg=function(t){if(t&&t.closest&&t.closest('.cf-monitor'))return false;return isBgBase(t);};
var onDblBase=onDbl;
onDbl=function(e){if(e.target&&e.target.closest&&e.target.closest('.cf-monitor'))return;onDblBase(e);};
var sendMessageBase=sendMessage;
sendMessage=function(action,payload,title){
  var r=sendMessageBase(action,payload,title);
  if(HOSTED&&(action==='RUN_NODE'||action==='RUN_ALL')){ACT.running=true;startActivitySync();}
  return r;
};
var adoptServerStateBase=adoptServerState;
adoptServerState=function(payload){
  var changed=adoptServerStateBase(payload);
  if(payload&&payload.sessionTitle!==undefined&&payload.sessionTitle!==SESSION.title){SESSION.title=payload.sessionTitle;renderSessionChip();}
  if(payload&&payload.sessionWarning)SESSION.warning=payload.sessionWarning;
  if(changed&&hasRunningNodes())startActivitySync();
  if(changed)refreshUndoButtonSoon();
  return changed;
};

/* ---- 专用会话入口 ---- */
function renderSessionChip(){
  var el=$('cf-session');if(!el)return;
  if(!HOSTED){el.hidden=true;return;}
  el.hidden=false;
  el.textContent=SESSION.title?('专用会话 · '+SESSION.title):'会话未绑定';
  el.classList.toggle('has',!!SESSION.id);
}
function openSessionDialog(){
  if(!HOSTED)return;
  var id=SESSION.id||'';
  var h=dHead('info','画布专用会话')
    +'<div class="cf-dbody">'
    +'<div class="cf-hintbox">画布中的运行只在该项目的专用会话执行；其他会话不会收到运行消息。</div>'
    +'<div class="cf-kv"><b>标题</b><span>'+esc(SESSION.title||'（未命名）')+'</span></div>'
    +'<div class="cf-kv"><b>会话 ID</b><span class="cf-artpath">'+esc(id?shortId(id):'（尚未绑定）')+'</span></div>'
    +(SESSION.warning?'<div class="cf-hintbox" style="margin-top:8px;color:#f87171">'+esc(SESSION.warning)+'</div>':'')
    +'</div>'
    +'<div class="cf-dfoot" style="flex-wrap:wrap">'
    +'<button type="button" class="cf-btn mini" data-act="open"'+(id?'':' disabled')+'>打开会话</button>'
    +'<button type="button" class="cf-btn mini" data-act="copy"'+(id?'':' disabled')+'>复制会话 ID</button>'
    +'<button type="button" class="cf-btn mini" data-act="new">新建会话</button>'
    +'<span style="flex:1"></span>'
    +'<button type="button" class="cf-btn mini" data-act="close">关闭</button>'
    +'</div>';
  openModal(h);
  var d=$('cf-dialog');
  d.querySelector('[data-act="close"]').addEventListener('click',closeModal);
  var openBtn=d.querySelector('[data-act="open"]');
  if(openBtn)openBtn.addEventListener('click',function(){requestOpenSession(id);});
  var copyBtn=d.querySelector('[data-act="copy"]');
  if(copyBtn)copyBtn.addEventListener('click',function(){copyText(id,'会话 ID 已复制');});
  var newBtn=d.querySelector('[data-act="new"]');
  if(newBtn)newBtn.addEventListener('click',function(){
    var go=function(){rebindSession();};
    if(ACT.running||hasRunningNodes()){
      openConfirm('新建会话','当前有节点正在运行。新建会话会清空执行过程显示，但不会中断已在进行的回合。确定继续？',go);
    }else{go();}
  });
}
function shortId(id){return id.length>18?id.slice(0,18)+'…':id;}
function copyText(text,okMsg){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){toast(okMsg,'ok');},function(){toast('复制失败：请手动选择复制','err');});
  }else{toast('当前环境不支持自动复制','err');}
}
function requestOpenSession(sessionId){
  /* 优先走宿主客户端的会话导航；没有公开 API 时退化为复制 ID（不猜 URL） */
  window.parent.postMessage({type:'codeflow:open-session',sessionId:sessionId},'*');
  toast('已请求打开会话');
}
function rebindSession(){
  if(!HOSTED)return;
  apiPost('session',{project:(G.project&&G.project.name)||'',action:'rebind'}).then(function(res){
    if(res&&res.sessionId){
      SESSION.id=res.sessionId;
      SESSION.title=res.title||res.sessionTitle||SESSION.title;
      SESSION.warning=null;
      renderSessionChip();
      activityResetLocal();
      showBanner('已新建专用会话「'+(SESSION.title||shortId(SESSION.id))+'」；画布中的运行只在该会话执行。');
      toast('已新建画布会话','ok');
    }
  }).catch(function(err){toast('新建会话失败：'+((err&&err.message)||err),'err');});
}
window.addEventListener('message',function(e){
  var d=e&&e.data;if(!d)return;
  if(d.type==='codeflow:session-opened'){toast('已在 DSH 中打开该会话','ok');}
  else if(d.type==='codeflow:session-open-failed'){
    if(d.copied)toast('无法直接跳转：会话 ID 已复制，可在左侧会话列表按标题查找');
    else toast('无法直接跳转：请在左侧会话列表按标题「'+(SESSION.title||'CodeFlow')+'」查找','err');
  }
});

/* ---- 节点活动行 + 交付徽标 ---- */
function nodeStats(id){
  var list=ACT.byNode[id]||[];
  var steps=0,last='',err='',reasoning='';
  for(var i=list.length-1;i>=0;i--){
    var en=list[i];
    if(en.kind==='tool'||en.kind==='step')steps++;
    if(!last&&(en.kind==='step'||en.kind==='tool'||en.kind==='status'))last=en.text;
    if(!err&&(en.kind==='status')&&/失败|错误|无法/.test(en.text))err=en.text;
    if(!reasoning&&en.kind==='reasoning')reasoning=en.text;
  }
  var node=byId(id);
  if(!last&&node&&node.status==='failed'&&node.detail)err=node.detail.split('\\n')[0];
  if(!last&&node&&node.status==='running')last='执行中…';
  return {steps:steps,last:last,err:err,reasoning:reasoning};
}
function decorateNodes(){
  if(!G.nodes.length)return;
  for(var i=0;i<G.nodes.length;i++){paintNodeExtras(G.nodes[i].id);}
  refreshIcons();
}
function paintNodeExtras(id){
  var el=nodeEl(id);if(!el)return;
  var n=byId(id);if(!n)return;
  var line=el.querySelector('.cf-node-act');
  var stats=nodeStats(id);
  var artifacts=Array.isArray(n.artifacts)?n.artifacts:[];
  var wantDeliverBadge=n.type==='deliver'&&n.status==='done'&&artifacts.length>0;
  var terminal=n.status==='done'||n.status==='failed';
  var need=!!(stats.last||stats.err||wantDeliverBadge||(stats.steps>0&&terminal));
  if(!need){if(line)line.parentNode.removeChild(line);return;}
  if(!line){
    line=document.createElement('div');
    line.className='cf-node-act';
    el.appendChild(line);
  }
  line.classList.toggle('err',!!stats.err);
  var html='';
  if(n.status==='running')html+='<span class="cf-act-spin">◐</span>';
  var txt=stats.err||stats.last||'';
  /* v0.6.0：节点活动行追加真实编辑摘要（agent 正在改/刚改过哪个文件） */
  var ed=(EDIT_BY_VIEW[CURVIEW]||{})[id];
  if(ed&&ed.rel&&(ed.state==='editing'||Date.now()-ed.at<EDIT_MARK_MS)){
    txt=(txt?txt+' · ':'')+(ed.state==='editing'?'修改中 ':'修改 ')+ed.rel;
  }
  if(wantDeliverBadge)txt=(txt?txt+' · ':'')+(stats.steps>0?stats.steps+' 步 · ':'')+artifacts.length+' 个交付物'+(Array.isArray(n.presented)&&n.presented.length?(' · 已提交 '+n.presented.length+' 个卡片'):'');
  else if(n.status==='done'&&stats.steps>0&&!stats.err)txt=(txt?txt+' · ':'')+stats.steps+' 步'+(ACT.progress&&ACT.progress.elapsedMs?(' · '+fmtMs(ACT.progress.elapsedMs)):'');
  html+='<span class="cf-act-text">'+esc(txt)+'</span>';
  if(n.status==='running'){
    var meta=[];
    if(stats.steps>0)meta.push(stats.steps+' 步');
    if(ACT.progress&&ACT.progress.elapsedMs)meta.push(fmtMs(ACT.progress.elapsedMs));
    if(meta.length)html+='<span class="cf-act-meta">'+esc(meta.join(' · '))+'</span>';
  }
  line.innerHTML=html;
}
/* 活动数据到来时只更新受影响节点的一行 + 监视器，不触发 renderAll */
function updateNodeLine(id){
  paintNodeExtras(id);
  if(detailsNodeId===id)refreshDetailsActivity();
  renderMonitor();
}

/* ---- Activity 轮询 ---- */
function activityResetLocal(){
  ACT.running=false;ACT.seq=0;ACT.entries=[];ACT.byNode={};ACT.progress=null;ACT.action=null;ACT.nodeId=null;ACT.startedAt=null;ACT.deliverToasted=false;ACT.issueAt=0;
  decorateNodes();renderMonitor();stopActivitySync();
}
function startActivitySync(){
  if(!HOSTED||actTimer)return;
  actTimer=setInterval(pollActivity,850);
  pollActivity();
}
function stopActivitySync(){
  if(actTimer){clearInterval(actTimer);actTimer=null;}
}
function pollActivity(){
  if(!HOSTED||actInflight||document.hidden)return;
  var name=G.project&&G.project.name;if(!name)return;
  actInflight=true;
  apiGet('/codeflow/api/activity?project='+encodeURIComponent(name)+'&after='+ACT.seq)
    .then(function(p){actInflight=false;applyActivity(p);})
    .catch(function(){actInflight=false;});
}
function applyActivity(p){
  if(!p||p.ok===false)return;
  if(p.reset){ACT.entries=[];ACT.byNode={};ACT.seq=0;ACT.deliverToasted=false;}
  var seen=ACT.seq;
  (p.entries||[]).forEach(function(en){
    if(typeof en.seq!=='number'||en.seq<=seen)return;
    seen=Math.max(seen,en.seq);
    var e={seq:en.seq,time:en.time,kind:en.kind,text:String(en.text||''),name:en.name,status:en.status,ms:en.ms,truncated:en.truncated};
    var nid=en.nodeId||p.nodeId||ACT.nodeId;
    if(nid){
      e.nodeId=nid;
      (ACT.byNode[nid]=ACT.byNode[nid]||[]).push(e);
      if(ACT.byNode[nid].length>200)ACT.byNode[nid].splice(0,ACT.byNode[nid].length-200);
      updateNodeLine(nid);
    }
    ACT.entries.push(e);
    if(ACT.entries.length>600)ACT.entries.splice(0,ACT.entries.length-600);
    var presented=/已提交 (\\d+) 个交付卡片/.exec(e.kind==='status'?e.text:'');
    if(presented&&!ACT.deliverToasted){
      ACT.deliverToasted=true;
      toast('已提交 '+presented[1]+' 个交付卡片到专用会话，点会话卡片可在右侧栏预览','ok');
    }
  });
  ACT.seq=Math.max(ACT.seq,typeof p.seq==='number'?p.seq:seen);
  /* v0.6.0：真实编辑状态（宿主从写文件工具调用中提取）→ 节点高亮/侧边栏圆点 */
  applyEditData(p.edits);
  /* v1.0：项目实际落盘目录（状态栏 tooltip 用）；宿主对账出的 issue → 横幅+重试 */
  if(typeof p.projectDir==='string'&&p.projectDir){PROJECT_DIR=p.projectDir;updateProjectDirTip();}
  if(p.issue&&p.issue.text&&p.issue.at!==ACT.issueAt){
    ACT.issueAt=p.issue.at;
    showIssue(p.issue);
    if(typeof p.issue.nodeId==='string'&&p.issue.nodeId)updateNodeLine(p.issue.nodeId);
  }
  var wasRunning=ACT.running;
  ACT.running=!!p.running;
  ACT.action=p.action||ACT.action;
  ACT.nodeId=p.nodeId||ACT.nodeId;
  ACT.startedAt=p.startedAt||ACT.startedAt;
  ACT.progress=p.progress||null;
  ACT.lastAt=Date.now();
  renderMonitor();
  if(detailsNodeId)refreshDetailsActivity();
  if(wasRunning&&!ACT.running&&!hasRunningNodes()){
    /* 运行结束：显示最终摘要，几秒后收起轮询 */
    stopActivitySync();
    var pr=ACT.progress;
    var summary=pr?('运行结束：'+pr.done+'/'+pr.total+' 完成'+(pr.failed?('，'+pr.failed+' 失败'):'')):'运行结束';
    showBanner(summary);
    updateUndoButton();
    setTimeout(function(){if(!ACT.running&&monitorEl)monitorEl.remove();monitorEl=null;},20000);
  }
}
document.addEventListener('visibilitychange',function(){
  if(!document.hidden&&(ACT.running||hasRunningNodes())){pollActivity();if(!actTimer)startActivitySync();}
});

/* ---- 执行监视器 ---- */
function renderMonitor(){
  if(!HOSTED){return;}
  var show=ACT.running||hasRunningNodes()||(ACT.lastAt&&Date.now()-ACT.lastAt<20000);
  if(!show){
    if(monitorEl){monitorEl.remove();monitorEl=null;}
    return;
  }
  if(!monitorEl){
    monitorEl=document.createElement('div');
    monitorEl.className='cf-monitor';
    monitorEl.innerHTML='<div class="cf-monitor-head"><span class="cf-act-spin">◐</span><span class="cf-mtitle">执行中</span><span class="cf-fold">▾</span></div><div class="cf-monitor-body"></div>';
    monitorEl.querySelector('.cf-monitor-head').addEventListener('click',function(){
      monitorEl.classList.toggle('collapsed');
      try{localStorage.setItem('cf-monitor-collapsed',monitorEl.classList.contains('collapsed')?'1':'0');}catch(e){}
    });
    $('cf-stage').appendChild(monitorEl);
    try{if(localStorage.getItem('cf-monitor-collapsed')==='1')monitorEl.classList.add('collapsed');}catch(e){}
  }
  var body=monitorEl.querySelector('.cf-monitor-body');
  var pr=ACT.progress||{};
  var done=typeof pr.done==='number'?pr.done:0,total=typeof pr.total==='number'?pr.total:G.nodes.length;
  var current=pr.current?byId(pr.current):null;
  var curTitle=current?(current.title||typeOf(current).label):'—';
  var latestReasoning='';
  for(var i=ACT.entries.length-1;i>=0;i--){if(ACT.entries[i].kind==='reasoning'){latestReasoning=ACT.entries[i].text;}}
  if(latestReasoning.length>110)latestReasoning=latestReasoning.slice(-110);
  var percent=(typeof pr.percent==='number')?pr.percent:null;
  var bar=percent===null
    ?'<div class="cf-mrow"><div class="cf-mbar indeterminate"><i></i></div></div>'
    :'<div class="cf-mrow"><div class="cf-mbar"><i style="width:'+Math.max(0,Math.min(100,percent))+'%"></i></div><span class="cf-progress-num">'+percent+'%</span></div>';
  var head=monitorEl.querySelector('.cf-mtitle');
  head.textContent=ACT.running?('执行中 '+done+'/'+total):('执行结束 '+done+'/'+total);
  body.innerHTML=bar
    +'<div class="cf-mrow"><b>当前</b><span class="cf-mline">'+esc(curTitle)+'</span></div>'
    +'<div class="cf-mrow"><b>耗时</b><span class="cf-mline">'+esc(fmtMs(pr.elapsedMs)||'—')+(pr.steps?(' · '+pr.steps+' 步'):'')+'</span></div>'
    +(latestReasoning?'<div class="cf-mrow"><b>思考</b><span class="cf-mline" title="'+esc(latestReasoning)+'">'+esc(latestReasoning)+'</span></div>':'')
    +'<div class="cf-mrow"><b>会话</b><span class="cf-mline">'+esc(SESSION.title||'未绑定')+'</span></div>';
}

/* ---- 详情弹窗：执行过程 + 交付物 ---- */
var openDetailsBase=openDetails;
function artifactKindIcon(kind){
  return kind==='code'?'{ }':kind==='doc'?'§':kind==='test'?'✓':kind==='config'?'⚙':kind==='asset'?'▣':'·';
}
/* 重定义详情弹窗：原有键值行 + 交付物区 + 执行过程区（赋值覆盖，不重声明） */
openDetails=function(id){
  var n=byId(id);if(!n)return;
  var t=typeOf(n),st=STC[n.status]||STC.pending;
  var ups=[],downs=[];
  G.links.forEach(function(l){
    if(l[2]===id){var u=byId(l[0]);if(u)ups.push(u.title||typeOf(u).label);}
    if(l[0]===id){var dn=byId(l[2]);if(dn)downs.push(dn.title||typeOf(dn).label);}
  });
  var h=dHead('info',(n.title||t.label)+' · 详情')
    +'<div class="cf-dbody">'
    +'<div class="cf-kv"><b>类型</b><span>'+esc(t.label)+'（'+esc(n.type)+'）</span></div>'
    +'<div class="cf-kv"><b>状态</b><span style="color:'+st[1]+'">'+SGLYPH[n.status]+' '+st[0]+'</span></div>'
    +'<div class="cf-kv"><b>说明</b><span>'+esc(t.desc)+'</span></div>';
  Object.keys(n.params||{}).forEach(function(k){
    var v=String(n.params[k]);if(v.length>160)v=v.slice(0,160)+'…';
    if(v)h+='<div class="cf-kv"><b>'+esc(k)+'</b><span>'+esc(v)+'</span></div>';
  });
  if(n.result)h+='<div class="cf-kv"><b>结果</b><span>'+esc(n.result)+'</span></div>';
  if(n.detail)h+='<div class="cf-kv"><b>详情</b><span>'+esc(n.detail)+'</span></div>';
  h+='<div class="cf-kv"><b>上游</b><span>'+(ups.length?esc(ups.join('、')):'—')+'</span></div>';
  h+='<div class="cf-kv"><b>下游</b><span>'+(downs.length?esc(downs.join('、')):'—')+'</span></div>';
  /* 交付物（只读清单；预览与“打开/在文件夹显示”用会话里的原生交付卡片） */
  var artifacts=Array.isArray(n.artifacts)?n.artifacts:[];
  if(n.type==='deliver'||artifacts.length>0){
    h+='<div class="cf-sec"><div class="cf-sec-title">交付物'+(artifacts.length?('（'+artifacts.length+'）'):'')+'</div>';
    if(n.type==='deliver')h+='<div class="cf-sechint">点击会话中的交付卡片可在右侧栏预览，原生控件可打开或在文件夹中显示。</div>';
    if(artifacts.length===0)h+='<div class="cf-sechint">未记录交付物</div>';
    else{
      h+='<div class="cf-artlist">';
      artifacts.forEach(function(a){
        h+='<div class="cf-art"><span class="cf-artkind">'+esc(artifactKindIcon(a.kind))+'</span>'
          +'<span class="cf-artpath">'+esc(a.path)+'</span>'
          +(a.label?'<span class="cf-artlabel">'+esc(a.label)+'</span>':'')
          +(a.kind?'<span class="cf-artkind">'+esc(a.kind)+'</span>':'')
          +'</div>';
      });
      h+='</div>';
      if(n.type==='deliver'&&Array.isArray(n.presented)&&n.presented.length)h+='<div class="cf-sechint" style="margin-top:5px">已提交 '+n.presented.length+' 个交付卡片到专用会话。</div>';
    }
    h+='</div>';
  }
  /* 执行过程 */
  h+='<div class="cf-sec" id="cf-act-sec"><div class="cf-sec-title">执行过程</div><div id="cf-act-detail"></div></div>';
  h+='</div>'
    +'<div class="cf-dfoot" style="flex-wrap:wrap">'
    +(HOSTED?'<button type="button" class="cf-btn mini" data-act="session">在会话中查看完整过程</button>':'')
    +'<span style="flex:1"></span>'
    +'<button type="button" class="cf-btn cf-primary mini" data-act="close">关闭</button></div>';
  openModal(h);
  var d=$('cf-dialog');
  d.querySelector('[data-act="close"]').addEventListener('click',closeModal);
  var sessBtn=d.querySelector('[data-act="session"]');
  if(sessBtn)sessBtn.addEventListener('click',openSessionDialog);
  detailsNodeId=id;
  refreshDetailsActivity();
}
function refreshDetailsActivity(){
  if(detailsNodeId===null||$('cf-modal').hidden)return;
  var box=$('cf-act-detail');if(!box)return;
  var n=byId(detailsNodeId);
  var pr=ACT.progress||{};
  var stats=nodeStats(detailsNodeId);
  var list=ACT.byNode[detailsNodeId]||[];
  var h='';
  h+='<div class="cf-mrow" style="margin-bottom:6px"><b class="cf-progress-num">'+(typeof pr.done==='number'?(pr.done+'/'+pr.total):'—')+'</b>'
    +(pr.percent!=null?('<span class="cf-progress-num">'+pr.percent+'%</span>'):'<span>无确定进度</span>')
    +(pr.elapsedMs?('<span>· 已用 '+esc(fmtMs(pr.elapsedMs))+'</span>'):'')
    +(stats.steps?('<span>· '+stats.steps+' 步</span>'):'')+'</div>';
  if(!list.length){
    h+='<div class="cf-sechint">'+(HOSTED?'宿主未提供实时过程':'独立模式没有执行过程')+'</div>';
    box.innerHTML=h;return;
  }
  var reasonings=list.filter(function(e){return e.kind==='reasoning'||e.kind==='text';});
  var steps=list.filter(function(e){return e.kind==='tool'||e.kind==='step';});
  if(reasonings.length){
    h+='<div class="cf-think" tabindex="0">';
    reasonings.forEach(function(e){h+=esc(e.text)+(e.truncated?'\\n…（已截断）':'')+'\\n\\n';});
    h+='</div>';
  }else{
    h+='<div class="cf-think degraded">思考内容不可用，以下为执行步骤</div>';
  }
  if(steps.length){
    h+='<div class="cf-steps" style="margin-top:6px">';
    steps.slice(-40).forEach(function(e){
      var cls=e.status==='error'?' error':(e.status==='running'?' running':(e.status==='ok'?' ok':''));
      h+='<div class="cf-step'+cls+'"><span class="cf-stname" title="'+esc(e.text)+'">'+esc(e.text)+'</span>'
        +'<span class="cf-stst">'+esc((e.status==='ok'?'完成':e.status==='error'?'出错':e.status==='running'?'运行中':'')+(e.ms?(' · '+fmtMs(e.ms)):''))+'</span></div>';
    });
    h+='</div>';
  }
  box.innerHTML=h;
  var think=box.querySelector('.cf-think');
  if(think&&!think.classList.contains('degraded')){
    think.scrollTop=think.scrollHeight;
    /* 用户向上滚动时暂停跟随，出现“回到底部” */
    var follow=true;
    think.addEventListener('scroll',function(){
      follow=think.scrollTop+think.clientHeight>=think.scrollHeight-24;
      var btn=think.querySelector('.cf-think-bottom');
      if(btn)btn.remove();
      if(!follow){
        var b=document.createElement('button');
        b.type='button';b.className='cf-btn mini cf-think-bottom';b.textContent='回到底部';
        b.addEventListener('click',function(ev){ev.stopPropagation();think.scrollTop=think.scrollHeight;b.remove();follow=true;});
        think.appendChild(b);
      }
    });
  }
}
var closeModalBase=closeModal;
closeModal=function(){detailsNodeId=null;closeModalBase();};

/* ---- 撤销运行 ---- */
var undoBtnTimer=null;
function refreshUndoButtonSoon(){
  if(undoBtnTimer)return;
  undoBtnTimer=setTimeout(function(){undoBtnTimer=null;updateUndoButton();},400);
}
function updateUndoButton(){
  var btn=$('cf-tb-undo');if(!btn)return;
  if(!HOSTED){btn.hidden=true;return;}
  /* 保险：若最后一次轮询落在回合结束事件之前，ACT.running 可能滞留为 true
     （撤销按钮会一直禁用）。图里已无运行节点且活动数据已停更 2.5s 以上时，
     补一次轮询向宿主收敛状态；pollActivity 自带 inflight 防抖。 */
  if(ACT.running&&!hasRunningNodes()&&ACT.lastAt&&Date.now()-ACT.lastAt>2500){
    pollActivity();
  }
  btn.disabled=ACT.running||hasRunningNodes();
  btn.setAttribute('data-tooltip',btn.disabled?'运行中不能撤销':'撤销最近一次画布运行：恢复文件与节点状态（也可 Ctrl+Alt+Z）');
}
function openUndoDialog(){
  if(!HOSTED){toast('独立模式没有撤销功能','err');return;}
  var name=G.project&&G.project.name;
  if(!name){toast('先打开一个项目','err');return;}
  apiGet('/codeflow/api/undo?project='+encodeURIComponent(name)).then(function(res){
    renderUndoDialog(res||{});
  }).catch(function(err){toast('读取运行历史失败：'+((err&&err.message)||err),'err');});
}
function undoStateLabel(run,isLatest){
  if(run.undoable)return isLatest?['可撤销','ok']:['可撤销（先撤销更新的）','dim'];
  if(run.status==='undone')return['已撤销','dim'];
  if(run.status==='undo-failed')return['撤销失败','warn'];
  if(run.status==='interrupted')return['部分可撤销','warn'];
  return['不可撤销','warn'];
}
function renderUndoDialog(res){
  var runs=res.runs||[];
  var h=dHead('undo-2','运行历史（撤销）')
    +'<div class="cf-dbody">'
    +'<div class="cf-hintbox">撤销会把项目文件恢复到该次运行之前，并恢复当时各节点的执行状态；'
    +'只能按时间倒序逐次撤销，当前状态会先自动备份到 <b>.undo/&lt;运行ID&gt;/current-*</b>。'
    +'项目根之外的写入（如 shell 写到别处）不在恢复范围内。</div>';
  if(res.warning)h+='<div class="cf-hintbox" style="color:#f87171">'+esc(res.warning)+'</div>';
  if(!runs.length)h+='<div class="cf-sechint">还没有可撤销的运行。</div>';
  else{
    h+='<div class="cf-undolist">';
    runs.forEach(function(run,i){
      var label=undoStateLabel(run,i===0);
      var act=run.action==='RUN_ALL'?'运行全部':('运行节点'+(run.nodeId?(' '+(((byId(run.nodeId)||{}).title)||run.nodeId)):''));
      /* v0.6.0：历史标注该次运行作用的视图（文件快照是项目级的，跨视图 LIFO） */
      var viewTag=run.view==='modules'?'模块图':'任务图';
      h+='<div class="cf-undorow"'+(i>0?' title="只能撤销最近一次未撤销的运行：请先撤销更新的运行"':'')+'><div class="cf-uinfo">'
        +'<span class="cf-uline1">'+esc(fmtWhen(run.startedAt))+' · '+esc(act)+' · '+esc(viewTag)+'</span>'
        +'<span class="cf-uline2">'+(run.fileCount||0)+' 个文件'+(run.partial?' · 部分文件未纳入快照':'')+'</span>'
        +'</div><span class="cf-ustate '+label[1]+'">'+esc(label[0])+'</span>'
        +((i===0&&run.undoable&&!ACT.running&&!hasRunningNodes())?'<button type="button" class="cf-btn mini" data-run="'+esc(run.runId)+'">撤销这次运行</button>':'')
        +'</div>';
    });
    h+='</div>';
  }
  h+='</div><div class="cf-dfoot"><button type="button" class="cf-btn cf-primary" data-act="close">关闭</button></div>';
  openModal(h);
  var d=$('cf-dialog');
  d.querySelector('[data-act="close"]').addEventListener('click',closeModal);
  d.querySelectorAll('[data-run]').forEach(function(btn){
    btn.addEventListener('click',function(){confirmUndo(btn.getAttribute('data-run'));});
  });
}
function confirmUndo(runId){
  apiPost('undo',{project:G.project&&G.project.name,runId:runId,dryRun:true}).then(function(dry){
    if(!dry||dry.ok!==true){toast((dry&&dry.error)||'无法撤销','err');return;}
    var f=dry.files||{};
    var added=(f.added||[]).length,modified=(f.modified||[]).length,deleted=(f.deleted||[]).length;
    var h=dHead('alert-triangle','确认撤销这次运行？')
      +'<div class="cf-dbody">'
      +'<div class="cf-kv"><b>恢复到</b><span>'+esc(fmtWhen(Date.now()))+'（该次运行开始前）</span></div>'
      +'<div class="cf-kv"><b>文件变化</b><span class="cf-progress-num">新增 '+added+' 个（将删除） · 修改 '+modified+' 个（将覆盖） · 删除 '+deleted+' 个（将恢复）</span></div>'
      +'<div class="cf-hintbox" style="margin-top:8px">当前状态会先自动备份到 <b>.undo/'+esc(runId)+'/current-*</b>；'
      +'运行后你对同一文件的手动修改也会被覆盖；已提交的交付卡片可能因文件回滚而失效。</div>'
      +'</div>'
      +'<div class="cf-dfoot"><button type="button" class="cf-btn" data-act="close">取消</button>'
      +'<button type="button" class="cf-btn cf-danger" data-act="confirm">撤销</button></div>';
    openModal(h);
    var d=$('cf-dialog');
    d.querySelector('[data-act="close"]').addEventListener('click',closeModal);
    d.querySelector('[data-act="confirm"]').addEventListener('click',function(){
      closeModal();
      apiPost('undo',{project:G.project&&G.project.name,runId:runId}).then(function(res){
        activityResetLocal();
        var backup=res.backupDir||'.undo';
        showBanner('已撤销这次运行：文件与节点状态已恢复，撤销前状态备份在 '+backup+'。');
        toast('撤销成功','ok');
        refreshUndoButtonSoon();
      }).catch(function(err){toast('撤销失败：'+((err&&err.message)||err),'err');});
    });
  }).catch(function(err){toast('撤销预检失败：'+((err&&err.message)||err),'err');});
}
window.addEventListener('keydown',function(e){
  if(e.ctrlKey&&e.altKey&&(e.key==='z'||e.key==='Z')){e.preventDefault();openUndoDialog();}
});

/* ---- 启动挂钩 ---- */
function initCanvasExtras(){
  if(!HOSTED)return;
  renderSessionChip();
  updateProjectDirTip();
  /* 撤销按钮的 click 绑定（v0.5.2 起只有 Ctrl+Alt+Z 生效，按钮本身漏绑了） */
  var undoBtn=$('cf-tb-undo');
  if(undoBtn)undoBtn.addEventListener('click',openUndoDialog);
  /* v1.0：设置入口只在宿主模式显示（独立预览隐藏） */
  var settingsBtn=$('cf-tb-settings');
  if(settingsBtn){
    settingsBtn.hidden=false;
    settingsBtn.addEventListener('click',openSettingsDialog);
  }
  /* 双视图切换控件：两个视图都可用才显示（单视图项目不出现点不动的 tab） */
  renderViewTabs();
  applyEditMarks();
  /* 损坏文件被隔离：第一优先级告知，比会话横幅更重要 */
  var bannerShown=false;
  if(BOOT.degraded){
    showBanner('警告：当前视图的图文件已损坏（'+(BOOT.degraded.reason||'未知原因')+'）'
      +(BOOT.degraded.quarantinedTo?('，坏文件已隔离为 '+BOOT.degraded.quarantinedTo):'')
      +'；画布已重置，请重新编辑后保存。');
    bannerShown=true;
  }
  else if(BOOT.sessionNew){showBanner('已为「'+((G.project&&G.project.name)||'项目')+'」创建独立会话；画布中的运行只在该会话执行。');bannerShown=true;}
  else if(SESSION.warning){showBanner(SESSION.warning);bannerShown=true;}
  /* v1.0（需求 C）：一次性迁移汇总（moved/conflicts/failed 都要点名） */
  if(!bannerShown&&BOOT.migration)showBanner(BOOT.migration);
  if(hasRunningNodes())startActivitySync();
}
`

/* --------------------------------------------- view switching + edits --- */
/* v0.6.0：双视图状态。CURVIEW 是当前画布显示的视图；切换 = flush 写队列 →
   拉取目标视图状态 → 整图替换 + 恢复视口，绝不重扫/重分析/唤醒 agent。
   EDIT_BY_VIEW 按视图记录宿主报来的真实文件编辑，用于高亮与切换点提示。 */
const VIEW_JS = `
/* ================= v0.6.0：双视图 / 编辑高亮 ================= */
var CURVIEW=(HOSTED&&BOOT.activeView==='modules')?'modules':'tasks';
var VIEWMETA=(HOSTED&&BOOT.views)||null;
var VIEWPORTS={};
if(HOSTED&&Array.isArray(BOOT.viewport)&&BOOT.viewport.length===3)VIEWPORTS[CURVIEW]=BOOT.viewport.slice();
else if(HOSTED&&Array.isArray(BOOT.view)&&BOOT.view.length===3)VIEWPORTS[CURVIEW]=BOOT.view.slice();
var switchingView=false;
var EDIT_MARK_MS=15000;
var EDIT_BY_VIEW={tasks:{},modules:{}};
var editMarkTimer=null;

function viewsAvailable(){
  return !!(HOSTED&&VIEWMETA&&VIEWMETA.tasks&&VIEWMETA.tasks.available&&VIEWMETA.modules&&VIEWMETA.modules.available);
}
function renderViewTabs(){
  var wrap=$('cf-viewtabs');
  if(!wrap)return;
  if(!viewsAvailable()){wrap.hidden=true;return;}
  wrap.hidden=false;
  ['tasks','modules'].forEach(function(v){
    var b=$('cf-vtab-'+v);
    if(!b)return;
    var meta=(VIEWMETA&&VIEWMETA[v])||{};
    var cnt=(v===CURVIEW)?G.nodes.length:(typeof meta.nodes==='number'?meta.nodes:0);
    var cntEl=b.querySelector('.cf-vtab-count');
    if(cntEl)cntEl.textContent=cnt;
    b.classList.toggle('active',CURVIEW===v);
    b.setAttribute('aria-selected',CURVIEW===v?'true':'false');
    b.setAttribute('tabindex',CURVIEW===v?'0':'-1');
    var dot=b.querySelector('.cf-vtab-dot');
    if(dot)dot.hidden=!otherViewHasEdits(v);
  });
}
function otherViewHasEdits(v){
  var now=Date.now();
  var table=EDIT_BY_VIEW[v]||{};
  for(var id in table){
    var st=table[id];
    if(st.state==='editing'||(st.state!=='error'&&now-st.at<EDIT_MARK_MS))return true;
  }
  return false;
}
/* 宿主 /api/activity 的 edits → 本地编辑表（按视图分组，nodeId 已由宿主匹配好） */
function applyEditData(edits){
  var now=Date.now();
  var changed=false;
  (edits||[]).forEach(function(ed){
    if(!ed)return;
    var views=ed.nodeIds||{};
    ['tasks','modules'].forEach(function(v){
      var list=views[v]||[];
      for(var i=0;i<list.length;i++){
        EDIT_BY_VIEW[v][list[i]]={state:ed.state,at:ed.at,rel:ed.rel||''};
        changed=true;
      }
    });
  });
  ['tasks','modules'].forEach(function(v){
    var table=EDIT_BY_VIEW[v];
    for(var id in table){
      var st=table[id];
      if(st.state!=='editing'&&now-st.at>EDIT_MARK_MS*4)delete table[id];
    }
  });
  if(changed)applyEditMarks();
}
/* 只按 nodeId 增删 class/徽章，绝不为了高亮整图重渲染（避免打断拖拽/输入） */
function applyEditMarks(){
  var now=Date.now();
  var nextExpiry=Infinity;
  var table=EDIT_BY_VIEW[CURVIEW]||{};
  for(var id in table){
    var st=table[id];
    var live=st.state==='editing';
    var recent=!live&&(now-st.at)<EDIT_MARK_MS;
    if(!live&&recent)nextExpiry=Math.min(nextExpiry,st.at+EDIT_MARK_MS);
    var el=nodeEl(id);
    if(!el)continue;
    var primary=CURVIEW==='modules';
    el.classList.toggle('cf-edit-related',!primary&&(live||recent)&&st.state!=='error');
    el.classList.toggle('cf-editing',primary&&live);
    el.classList.toggle('cf-edited',primary&&!live&&recent&&st.state!=='error');
    el.classList.toggle('cf-edit-err',primary&&!live&&recent&&st.state==='error');
    var head=el.querySelector('.cf-node-head');
    var badge=head?head.querySelector('.cf-editbadge'):null;
    if(primary&&head&&(live||recent)){
      if(!badge){badge=document.createElement('span');badge.className='cf-editbadge';head.appendChild(badge);}
      badge.textContent=live?'修改中':(st.state==='error'?'修改失败':'已修改');
      badge.classList.toggle('err',!live&&st.state==='error');
    }else if(badge&&badge.parentNode){badge.parentNode.removeChild(badge);}
  }
  if(editMarkTimer){clearTimeout(editMarkTimer);editMarkTimer=null;}
  if(nextExpiry!==Infinity)editMarkTimer=setTimeout(applyEditMarks,Math.max(300,nextExpiry-now+50));
  renderViewTabs();
  decorateNavDots();
}
/* 分类按钮上的小圆点：该分类下有最近被修改的节点 */
function decorateNavDots(){
  var nav=$('cf-nav');
  if(!nav)return;
  var now=Date.now();
  var table=EDIT_BY_VIEW[CURVIEW]||{};
  CATS.forEach(function(c,i){
    var btn=nav.children[i];
    if(!btn)return;
    var has=G.nodes.some(function(n){
      if(typeOf(n).cat!==c[0])return false;
      var st=table[n.id];
      return st&&(st.state==='editing'||(st.state!=='error'&&now-st.at<EDIT_MARK_MS));
    });
    var dot=btn.querySelector('.cf-naveditdot');
    if(has&&!dot){dot=document.createElement('span');dot.className='cf-naveditdot';btn.appendChild(dot);}
    else if(!has&&dot&&dot.parentNode)dot.parentNode.removeChild(dot);
  });
}
/* 切换视图：flush 写队列 → 拉目标视图 → 换图 + 恢复视口；失败留在原视图 */
function switchView(next){
  if(next===CURVIEW)return;
  void doSwitchView(next);
}
async function doSwitchView(next){
  if(!HOSTED||switchingView)return;
  var name=G.project&&G.project.name;
  if(!name){toast('先打开一个项目','err');return;}
  switchingView=true;
  try{
    closeNavPop();closeMenus();
    /* 1. 等待待发送的写队列，避免丢编辑 */
    try{await writeChain;}catch(e){}
    /* 2. 请求目标视图状态 */
    var res=await apiGet('/codeflow/api/state?project='+encodeURIComponent(name)+'&view='+next);
    if(!res||!valid(res.graph))throw new Error((res&&res.error)||'目标视图不可用');
    /* 3. 记住当前视图视口 → 整图替换 */
    VIEWPORTS[CURVIEW]=[view.x,view.y,view.k];
    CURVIEW=next;
    syncRev=typeof res.rev==='number'?res.rev:syncRev;
    if(res.views)VIEWMETA=res.views;
    if(Array.isArray(res.viewport)&&res.viewport.length===3)VIEWPORTS[next]=res.viewport.slice();
    G=clone(res.graph);
    if(!G.meta)G.meta={};
    sel={type:null,id:null};mode='idle';drag=null;navActive=null;
    renderAll();
    /* 4. 恢复该视图上次的缩放/平移（持久化值优先，其次本会话记住的） */
    var vp=VIEWPORTS[next];
    if(vp&&vp.length===3){view={x:vp[0],y:vp[1],k:vp[2]};applyView();}
    else if(G.nodes.length){requestAnimationFrame(function(){fitView();});}
    else{applyView();}
    /* 5. 持久化激活视图（不 bump rev、不扫描、不唤醒 agent） */
    apiPost('view',{project:name,view:next}).catch(function(){});
    applyEditMarks();
    renderViewTabs();
    toast(next==='modules'?'已切换到模块结构图':'已切换到任务流水线');
  }catch(err){
    toast('切换视图失败：'+((err&&err.message)||err),'err');
  }finally{
    switchingView=false;
  }
}
/* 分段控件：点击切换 + 左右键切换（可访问性） */
['tasks','modules'].forEach(function(v){
  var b=$('cf-vtab-'+v);
  if(b)b.addEventListener('click',function(){switchView(v);});
});
var viewTabsWrap=$('cf-viewtabs');
if(viewTabsWrap)viewTabsWrap.addEventListener('keydown',function(e){
  if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;
  if(!viewsAvailable())return;
  e.preventDefault();
  var next=CURVIEW==='tasks'?'modules':'tasks';
  switchView(next);
  var b=$('cf-vtab-'+next);
  if(b)try{b.focus();}catch(e2){}
});
`

/* --------------------------------------- settings + issue retry (v1.0) --- */
/* v1.0：① 宿主对账出的 issue（agent 没执行节点）→ 横幅 + 一键重试（rerun=true）；
   ② 工具栏齿轮 → 设置弹窗（项目根目录 / 当前项目目录，GET/POST /api/config）；
   ③ 状态栏「已暂存」的 tooltip 显示项目实际落盘目录。独立预览（!HOSTED）下
   重试按钮与设置入口都不可见。 */
const SETTINGS_JS = `
/* ================= v1.0：issue 重试 / 设置 / 项目目录 tooltip ================= */
var PROJECT_DIR=(HOSTED&&BOOT.projectDir)||null;
function updateProjectDirTip(){
  var el=$('cf-saved');if(!el)return;
  if(PROJECT_DIR){el.title=PROJECT_DIR;try{el.setAttribute('data-tooltip',PROJECT_DIR);}catch(e){}}
}
/* 普通 banner 不带重试；issue banner 由 showIssue 显示（包一层 showBanner 统一收起按钮） */
var showBannerBase=showBanner;
showBanner=function(text){
  var btn=$('cf-banner-retry');
  if(btn)btn.hidden=true;
  ACT.lastIssue=null;
  showBannerBase(text);
};
function showIssue(issue){
  ACT.lastIssue=issue||null;
  showBannerBase((issue&&issue.text)||'');
  var btn=$('cf-banner-retry');
  if(btn)btn.hidden=!(issue&&issue.nodeId);
}
$('cf-banner-retry').addEventListener('click',function(){
  var id=(ACT.lastIssue&&ACT.lastIssue.nodeId)||null;
  var btn=$('cf-banner-retry');
  if(btn)btn.hidden=true;
  if(id){toast('正在重发本次运行…');runNode(id,true);}
});
/* ---- 设置弹窗：项目根目录（全局默认根）+ 当前项目目录（单项目覆盖） ---- */
function openSettingsDialog(){
  if(!HOSTED)return;
  var name=(G.project&&G.project.name)||'';
  apiGet('/codeflow/api/config'+(name?('?project='+encodeURIComponent(name)):''))
    .then(function(cfg){renderSettingsDialog(cfg||{});})
    .catch(function(err){toast('读取设置失败：'+((err&&err.message)||err),'err');});
}
function renderSettingsDialog(cfg){
  var name=cfg.project||((G.project&&G.project.name)||'');
  var h=dHead('settings','CodeFlow 设置')
    +'<div class="cf-dbody">'
    +'<div class="cf-kv"><b>工作区</b><span class="cf-artpath">'+esc(cfg.workspace||'—')+'</span></div>'
    +'<div class="cf-kv"><b>默认根</b><span class="cf-artpath">'+esc(cfg.defaultRoot||'—')+'</span></div>'
    +'<div class="cf-setrow"><label for="cf-set-root">项目根目录（空 = 用默认根；项目仍写在 根/flow-projects/&lt;项目名&gt;/）</label>'
    +'<div class="cf-setline"><input class="cf-in" id="cf-set-root" type="text" spellcheck="false" placeholder="'+esc(cfg.defaultRoot||'')+'" value="'+esc(cfg.customRoot||'')+'">'
    +'<button type="button" class="cf-btn mini" data-act="reset-root">恢复默认</button></div></div>'
    +(name?'<div class="cf-setrow"><label for="cf-set-dir">当前项目目录（'+esc(name)+'；空 = 用根目录）</label>'
    +'<div class="cf-setline"><input class="cf-in" id="cf-set-dir" type="text" spellcheck="false" placeholder="（用根目录下的 flow-projects/'+esc(name)+'）" value="'+esc(cfg.projectOverride||'')+'">'
    +'<button type="button" class="cf-btn mini" data-act="reset-dir">恢复默认</button></div></div>':'')
    +'<div class="cf-hintbox">修改只影响后续新建/解析；已有项目不会自动搬家。旧根里的项目仍可在项目列表中打开。</div>'
    +'<div class="cf-sechint" id="cf-set-err" style="color:#f87171;min-height:14px"></div>'
    +'</div>'
    +'<div class="cf-dfoot"><button type="button" class="cf-btn" data-act="cancel">取消</button>'
    +'<span style="flex:1"></span>'
    +'<button type="button" class="cf-btn cf-primary" data-act="save">保存</button></div>';
  openModal(h);
  var d=$('cf-dialog');
  d.querySelector('[data-act="close"]').addEventListener('click',closeModal);
  d.querySelector('[data-act="cancel"]').addEventListener('click',closeModal);
  var rootInput=d.querySelector('#cf-set-root');
  var dirInput=d.querySelector('#cf-set-dir');
  var errEl=d.querySelector('#cf-set-err');
  var resetRoot=d.querySelector('[data-act="reset-root"]');
  if(resetRoot)resetRoot.addEventListener('click',function(){rootInput.value='';});
  var resetDir=d.querySelector('[data-act="reset-dir"]');
  if(resetDir)resetDir.addEventListener('click',function(){dirInput.value='';});
  d.querySelector('[data-act="save"]').addEventListener('click',function(){
    var saveBtn=d.querySelector('[data-act="save"]');
    saveBtn.disabled=true;
    errEl.textContent='保存中…';
    var body={};
    var rootValue=rootInput.value.trim();
    body.root=rootValue.length>0?rootValue:null;
    if(name&&dirInput){
      var dirValue=dirInput.value.trim();
      body.project=name;
      body.projectDir=dirValue.length>0?dirValue:null;
    }
    apiPost('config',body).then(function(saved){
      closeModal();
      if(saved&&saved.projectDir){PROJECT_DIR=saved.projectDir;updateProjectDirTip();}
      toast('设置已保存：项目根 = '+((saved&&saved.root)||'默认'),'ok');
    }).catch(function(err){
      saveBtn.disabled=false;
      errEl.textContent='保存失败：'+((err&&err.message)||String(err));
    });
  });
}
`

/* ------------------------------------------------- features (v1.1) --- */
/* 功能分组 / 整组高亮 / 功能归属 chips：行为与样式都放在 tools/patches/ 下，
   由此处注入（上游模板保持不动）。生成天然幂等：每次都从模板重新打补丁。 */
const FEATURES_CSS = readFileSync(new URL('patches/features-ui.css', import.meta.url), 'utf8').trim()
const FEATURES_JS = readFileSync(new URL('patches/features-ui.js', import.meta.url), 'utf8').trim()
if (!FEATURES_CSS.includes('.cf-fgroup{') || !FEATURES_CSS.includes('html[data-cf-theme="light"] .cf-fgroup')) {
  throw new Error('features-ui.css: expected group rows with a light override')
}
if (!FEATURES_JS.includes('function spotlightNodes(') || !FEATURES_JS.includes('function renderGrouped(')) {
  throw new Error('features-ui.js: expected spotlightNodes and renderGrouped')
}

/* --------------------------------------------------- coupling/drop (v1.2) --- */
/* 模块耦合分析（卡片/徽章/菜单/工具栏）+ 拖拽导入（遮罩/确认/进度/上传）。
   与 features 同一机制：patch 文件由本脚本注入，浅色覆盖带属性前缀，深浅
   三色（绿/黄/红）都要过 tests/contrast.mjs 的 AA 审计。 */
const COUPLING_CSS = readFileSync(new URL('patches/coupling-ui.css', import.meta.url), 'utf8').trim()
const COUPLING_JS = readFileSync(new URL('patches/coupling-ui.js', import.meta.url), 'utf8').trim()
const DROP_JS = readFileSync(new URL('patches/drop-ui.js', import.meta.url), 'utf8').trim()
if (!COUPLING_CSS.includes('.cf-coupling-card{') || !COUPLING_CSS.includes('html[data-cf-theme="light"] .cf-coupling-card')) {
  throw new Error('coupling-ui.css: expected the coupling card with a light override')
}
if (!COUPLING_CSS.includes('#22c55e') || !COUPLING_CSS.includes('#eab308') || !COUPLING_CSS.includes('#ef4444')) {
  throw new Error('coupling-ui.css: expected the fixed 低/中/高 palette (#22c55e/#eab308/#ef4444)')
}
if (!COUPLING_JS.includes('function runCouplingAnalysis(') || !COUPLING_JS.includes('function renderCouplingCard(')) {
  throw new Error('coupling-ui.js: expected runCouplingAnalysis and renderCouplingCard')
}
if (!DROP_JS.includes('function openDropConfirm(') || !DROP_JS.includes('function onDropImport(')) {
  throw new Error('drop-ui.js: expected onDropImport and openDropConfirm')
}
if (!DROP_JS.includes('drop/begin') || !DROP_JS.includes('drop/finalize') || !DROP_JS.includes('drop/abort')) {
  throw new Error('drop-ui.js: expected the begin/finalize/abort upload protocol')
}

/* 浅色覆盖层：追加到样式表末尾，靠 html[data-cf-theme="light"] 前缀胜出，深色规则不动。
   FEATURES_CSS 排在它之前：浅色作用域审计从浅色主题注释开始切片，功能样式的
   深色基线不会被误判为「未加前缀的浅色规则」。 */
const LIGHT_CSS = readFileSync(new URL('theme-light.css', import.meta.url), 'utf8').trim()
if (!LIGHT_CSS.includes('html[data-cf-theme="light"] #codeflow-canvas')) {
  throw new Error('theme-light.css: expected the light variable block')
}
text = replaceOnce(text, '</style>', `\n${FEATURES_CSS}\n\n${COUPLING_CSS}\n\n${EXTRA_CSS}\n${LIGHT_CSS}\n</style>`, 'features + coupling + light theme stylesheet')

/* ---------------------------------------------------- inject extras tail --- */
/* 行为层注入点：boot() 之前定义（可包装已提升的函数声明），boot() 之后初始化挂钩。
   VIEW_JS 在前（视图状态是编辑高亮/切换的前提），ACTIVITY_JS 在后，SETTINGS_JS
   再后（它包装 showBanner 并引用 ACT/runNode 等既有绑定），FEATURES_JS 之后是
   COUPLING_JS（包装 adoptServerState/refreshLatestSoon/renderChrome/renderNodes，
   并提供右键菜单引用的 canAnalyzeCouplingNode/runCouplingAnalysis）与 DROP_JS
   （拖拽导入，依赖 coupling 的 refreshCouplingStale 与 toast/openModal 等）。 */
text = replaceOnce(
  text,
  '\nboot();\n})();',
  '\n' + VIEW_JS + '\n' + ACTIVITY_JS + '\n' + SETTINGS_JS + '\n' + FEATURES_JS + '\n' + COUPLING_JS + '\n' + DROP_JS + '\nboot();\ninitCanvasExtras();\ninitCouplingExtras();\ninitDropExtras();\n})();',
  'canvas extras script',
)

/* ------------------------------------------------------------------ write --- */
if (text.includes('__CF_GRAPH_JSON__')) throw new Error('placeholder survived the port')
if (/window\.zcode/.test(text)) throw new Error('legacy zcode bridge survived the port')
/* v1.0（缺陷 B）生成自检：头部注释只允许一个终止符，且注释结束后第一个元素必须是
   画布根节点。多出来的 '-->' 会被浏览器当成正文文本节点渲染成一条空隙（v0.6.x
   的顶部空隙正是它），这里直接抛错，防止再犯。 */
if (text.includes('-->-->')) {
  throw new Error('duplicated comment terminator in the generated canvas (-->-->)')
}
if (!text.startsWith('<!--')) {
  throw new Error('generated canvas must start with the header comment')
}
const headerEnd = text.indexOf('-->')
if (headerEnd < 0) throw new Error('header comment is never closed')
const firstElement = text.slice(headerEnd + 3).replace(/^\s*/, '')
if (!firstElement.startsWith('<div id="codeflow-canvas"')) {
  throw new Error(`first element after the header comment must be the canvas div, got: ${JSON.stringify(firstElement.slice(0, 40))}`)
}
writeFileSync(OUT, text, 'utf8')

console.log(`ported ${SRC}\n     -> ${OUT} (${text.length} chars)`)
for (const line of replacements) console.log(`  · ${line}`)
