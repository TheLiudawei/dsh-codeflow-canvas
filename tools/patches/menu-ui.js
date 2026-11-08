/* ================= v1.3.0：顶部命名菜单栏（绑定层） =================
 * 模型（lib/ui/menu.js）与渲染（lib/ui/menu-html.js，构建期已产出静态标记）
 * 之外的本层只做三件事，不写任何业务规则：
 *   1. 事件委托：点击项 → `ACTION_RUNNERS[action]()`——action key 到**现有**
 *      函数的查表，菜单项与主按钮共用同一份动作定义，绝不复制第二份 handler；
 *   2. 开/关 + 键盘 + 焦点：同一时间只开一个；Enter/Space/ArrowDown 打开，
 *      ↑/↓ 循环移动（跳过禁用项与分隔线），Home/End 到首/尾，Esc 关闭并还
 *      焦点给触发按钮，Tab 直接关闭不困焦点；
 *   3. 状态广播：setActionState(key,{disabled,hidden,title}) 把动作状态同时
 *      应用到工具栏按钮与菜单项（同一 [data-action] 选择器一次覆盖）。
 * 响应式折叠由 menu-ui.css 的媒体查询完成，展开态与折叠态面板出自同一模型。
 * 所有动态文本一律 esc()/textContent，禁止拼接未转义 HTML。 */
var MENUBAR={open:null};

/* action key → 现有函数（唯一查表处；主按钮沿用模板既有的直接绑定，
   菜单项经这里复用同一个函数——不存在第二份处理逻辑）。 */
var ACTION_RUNNERS={
  'toolbar:cf-tb-new':function(){openNewDialog();},
  'toolbar:cf-tb-import':function(){openImportDialog();},
  'toolbar:cf-tb-runall':function(){runAll();},
  'toolbar:cf-tb-undo':function(){openUndoDialog();},
  'toolbar:cf-tb-save':function(){saveProject();},
  'toolbar:cf-tb-settings':function(){openSettingsDialog();},
  'toolbar:cf-tb-coupling':function(){runCouplingAnalysis(null);},
  'toolbar:cf-tb-add':function(){openTaskDialog(null);},
  'toolbar:cf-tb-layout':function(){autoLayout();},
  'toolbar:cf-tb-fit':function(){fitView();},
  'toolbar:cf-tb-help':function(){openHelp();},
  'toolbar:cf-vtab-tasks':function(){switchView('tasks');},
  'toolbar:cf-vtab-modules':function(){switchView('modules');},
  'cards:cleanup-stale':function(){cleanupStaleCards();},
  'logs:open-viewer':function(){openLogViewer();}
};

/* 把动作状态应用到该 action 的全部呈现（工具栏按钮 + 菜单项 + 折叠面板项）。
   disabled 同步写 disabled 属性与 aria-disabled；title 同步 tooltip。 */
function setActionState(key,state){
  var els;
  try{els=document.querySelectorAll('[data-action="'+key+'"]');}catch(e){return;}
  for(var i=0;i<els.length;i++){
    var el=els[i];
    if(state.hidden!==undefined)el.hidden=!!state.hidden;
    if(state.disabled!==undefined){
      el.disabled=!!state.disabled;
      el.setAttribute('aria-disabled',state.disabled?'true':'false');
    }
    if(state.title!==undefined){
      el.setAttribute('title',state.title);
      try{el.setAttribute('data-tooltip',state.title);}catch(e2){}
    }
  }
}

function menuPopOf(group){return document.getElementById('cf-menupop-'+group);}
function menuTriggerOf(group){return document.getElementById('cf-menu-'+group);}
/* 可聚焦项：面板内 role=menuitem 且未禁用/未隐藏（分隔线天然不在其中）。 */
function menuFocusableItems(pop){
  if(!pop)return [];
  var all=pop.querySelectorAll('[role="menuitem"]');
  var out=[];
  for(var i=0;i<all.length;i++){
    var el=all[i];
    if(el.hidden||el.disabled||el.getAttribute('aria-disabled')==='true')continue;
    out.push(el);
  }
  return out;
}
function focusMenuItemAt(pop,index){
  var items=menuFocusableItems(pop);
  if(!items.length)return;
  var el=items[Math.max(0,Math.min(items.length-1,index))];
  try{el.focus({preventScroll:true});}catch(e){try{el.focus();}catch(e2){}}
}

function openMenuBar(group,focusLast){
  closeMenuBar(false);
  var pop=menuPopOf(group);
  var trigger=menuTriggerOf(group);
  if(!pop||!trigger)return;
  pop.hidden=false;
  trigger.setAttribute('aria-expanded','true');
  MENUBAR.open=group;
  var items=menuFocusableItems(pop);
  focusMenuItemAt(pop,focusLast?(items.length-1):0);
}
function closeMenuBar(refocusTrigger){
  if(MENUBAR.open===null)return false;
  var group=MENUBAR.open;
  var pop=menuPopOf(group);
  var trigger=menuTriggerOf(group);
  if(pop)pop.hidden=true;
  if(trigger)trigger.setAttribute('aria-expanded','false');
  MENUBAR.open=null;
  if(refocusTrigger&&trigger){try{trigger.focus({preventScroll:true});}catch(e){try{trigger.focus();}catch(e2){}}}
  return true;
}
/* Esc 闸门：模板的全局 Escape 分支最先问这里（插入在 closeBrowseOnEscape 之前）。 */
function closeMenuBarOnEscape(){
  if(MENUBAR.open===null)return false;
  closeMenuBar(true);
  return true;
}

function menuCurrentIndex(pop,active){
  var items=menuFocusableItems(pop);
  for(var i=0;i<items.length;i++){if(items[i]===active)return i;}
  return -1;
}
function menuStep(pop,from,delta){
  var items=menuFocusableItems(pop);
  if(!items.length)return;
  var next=from;
  for(var guard=0;guard<items.length;guard++){
    next=(next+delta+items.length)%items.length;
    break;
  }
  focusMenuItemAt(pop,next);
}

function initMenuExtras(){
  /* 触发与执行：一次捕获阶段委托（触发按钮开/关、面板项执行后关闭、
     外部点击关闭）。不 preventDefault——不干扰任何既有手势。 */
  document.addEventListener('click',function(e){
    var t=e.target;
    if(!t||!t.closest)return;
    var trigger=t.closest('[data-cf-menu]');
    if(trigger){
      var group=trigger.getAttribute('data-cf-menu');
      if(MENUBAR.open===group)closeMenuBar(true);
      else openMenuBar(group);
      return;
    }
    if(MENUBAR.open===null)return;
    var item=t.closest('[data-action]');
    if(item&&item.closest&&item.closest('.cf-menupop')){
      if(item.disabled||item.getAttribute('aria-disabled')==='true')return;
      var key=item.getAttribute('data-action');
      closeMenuBar(false);
      var runner=ACTION_RUNNERS[key];
      if(runner)runner();
      else toast('该动作暂不可用','err');
      return;
    }
    if(!t.closest('.cf-menupop')&&!t.closest('.cf-menubar'))closeMenuBar(false);
  },true);

  /* 键盘：触发按钮上 Enter/Space/↓ 开（↑ 开并聚焦末项）；面板内 ↑/↓/Home/
     End 循环移动；Tab 关闭（不 preventDefault，焦点自然离开）；捕获阶段
     stopPropagation 防止画布快捷键（Delete 等）误触。Esc 走模板全局链的
     closeMenuBarOnEscape 闸门（避免双通道重复处理）。 */
  document.addEventListener('keydown',function(e){
    var t=e.target;
    if(!t||!t.closest)return;
    var trigger=t.closest('[data-cf-menu]');
    if(trigger){
      var group=trigger.getAttribute('data-cf-menu');
      if(e.key==='Enter'||e.key===' '||e.key==='ArrowDown'){
        e.preventDefault();e.stopPropagation();openMenuBar(group);
      }else if(e.key==='ArrowUp'){
        e.preventDefault();e.stopPropagation();openMenuBar(group,true);
      }
      return;
    }
    if(MENUBAR.open===null)return;
    var pop=menuPopOf(MENUBAR.open);
    var inPop=t.closest&&t.closest('.cf-menupop');
    if(!inPop)return;
    var idx=menuCurrentIndex(pop,document.activeElement);
    if(e.key==='ArrowDown'){e.preventDefault();e.stopPropagation();menuStep(pop,idx<0?-1:idx,1);}
    else if(e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();menuStep(pop,idx<0?0:idx,-1);}
    else if(e.key==='Home'){e.preventDefault();e.stopPropagation();focusMenuItemAt(pop,0);}
    else if(e.key==='End'){e.preventDefault();e.stopPropagation();var n=menuFocusableItems(pop).length;if(n)focusMenuItemAt(pop,n-1);}
    else if(e.key==='Tab'){closeMenuBar(false);}
  },true);

  /* 滚动画布 / 面板尺寸变化时收起（面板是 CSS 定位，无需重算坐标）。 */
  document.addEventListener('pointerdown',function(e){
    if(MENUBAR.open===null)return;
    var t=e.target;
    if(t&&t.closest&&t.closest('.cf-menupop'))return;
    if(t&&t.closest&&t.closest('[data-cf-menu]'))return;
    closeMenuBar(false);
  },true);
  try{
    if(typeof ResizeObserver==='function'){
      var mbRo=new ResizeObserver(function(){closeMenuBar(false);});
      mbRo.observe($('cf-stage'));
    }
  }catch(e){}
}
