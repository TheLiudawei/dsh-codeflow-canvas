/* ================= v1.2.1：导入目录树选择器 =================
 * 手感参照 DSH 输入框的 @ 弹层：打开即聚焦、键盘全程可操作（↑/↓ 选择、
 * Enter 进入、Backspace 上一级、Esc 关闭）、逐级浏览（不是扁平下拉、不是
 * 系统对话框）。数据只来自只读的 GET /codeflow/api/browse（宿主侧不跟链接、
 * 只列目录、单次 500 项、5s 超时）；画布不读磁盘、不自己拼路径——父目录、
 * 规范化路径都以服务端返回为准。
 * 打开时以路径输入框当前值为初始目录；非法/为空则从根清单开始。回填后
 * 不自动提交导入；所有动态文本一律 esc()。 */
var BROWSE={open:false,overlay:null,dir:null,parent:null,entries:[],truncated:false,
  filter:'',active:-1,loading:false,error:null,rootsMode:false,input:null,anchor:null,pending:null,note:null};

function browseFetch(path){
  var q=path?('?path='+encodeURIComponent(path)):'';
  return apiGet('/codeflow/api/browse'+q);
}

/* ---- 打开 / 关闭 ---- */
function ensureBrowseOverlay(){
  if(BROWSE.overlay&&BROWSE.overlay.isConnected)return BROWSE.overlay;
  var el=document.createElement('div');
  el.className='cf-browse';
  el.setAttribute('role','dialog');
  el.setAttribute('aria-label','选择目录');
  el.innerHTML='<div class="cf-browse-card">'
    +'<div class="cf-browse-head">'
    +'<span class="cf-browse-title"><i data-lucide="folder-open"></i>选择目录</span>'
    +'<button type="button" class="cf-btn mini" data-b="roots" title="回到根清单（盘符 / 主目录 / 工作区）">根目录</button>'
    +'<button type="button" class="cf-btn mini" data-b="up" title="上一级（Backspace）">上一级</button>'
    +'</div>'
    +'<div class="cf-browse-crumbs" id="cf-browse-crumbs"></div>'
    +'<input class="cf-in cf-browse-filter" id="cf-browse-filter" type="text" placeholder="过滤当前层级的子目录…" aria-label="过滤子目录">'
    +'<div class="cf-browse-list" id="cf-browse-list" role="listbox" aria-label="子目录列表"></div>'
    +'<div class="cf-browse-status" id="cf-browse-status"></div>'
    +'<div class="cf-dfoot" style="padding-top:8px">'
    +'<button type="button" class="cf-btn" data-b="cancel">取消</button>'
    +'<span style="flex:1"></span>'
    +'<button type="button" class="cf-btn cf-primary" data-b="pick" id="cf-browse-pick">选择此目录</button>'
    +'</div></div>';
  ROOT.appendChild(el);
  BROWSE.overlay=el;
  el.addEventListener('keydown',function(e){
    if(!BROWSE.open)return;
    onBrowseKeydown(e);
    e.stopPropagation();
  });
  el.addEventListener('pointerdown',function(e){e.stopPropagation();},true);
  el.querySelector('[data-b="cancel"]').addEventListener('click',function(){closeBrowsePicker();});
  el.querySelector('[data-b="up"]').addEventListener('click',function(){browseGoUp();});
  el.querySelector('[data-b="roots"]').addEventListener('click',function(){browseLoadRoots();});
  el.querySelector('[data-b="pick"]').addEventListener('click',function(){browsePick();});
  $('cf-browse-filter').addEventListener('input',function(e){
    BROWSE.filter=String(e.target.value||'');
    BROWSE.active=0;
    browseRenderList();
  });
  return el;
}
function openBrowsePicker(input){
  BROWSE.input=input||null;
  BROWSE.open=true;
  BROWSE.filter='';
  BROWSE.error=null;
  BROWSE.active=-1;
  var el=ensureBrowseOverlay();
  el.hidden=false;
  var initial=String((input&&input.value)||'').trim();
  if(initial){
    browseLoad(initial,true);
  }else{
    browseLoadRoots();
  }
  try{$('cf-browse-filter').focus();}catch(e){}
}
function closeBrowsePicker(){
  if(!BROWSE.open)return;
  BROWSE.open=false;
  if(BROWSE.overlay)BROWSE.overlay.hidden=true;
  BROWSE.entries=[];BROWSE.active=-1;BROWSE.error=null;BROWSE.rootsMode=false;
  var input=BROWSE.input;
  BROWSE.input=null;
  if(input){try{input.focus({preventScroll:true});}catch(e){}}
}
/* Esc 闸门：模板的全局 Escape 处理会关掉整个导入对话框；浏览弹层打开时
   必须只关自己。port-canvas 已把模板的 Escape 分支改为先问这里。 */
function closeBrowseOnEscape(){
  if(!BROWSE.open)return false;
  closeBrowsePicker();
  return true;
}

/* ---- 数据加载 ---- */
function browseSetLoading(target){
  BROWSE.loading=true;BROWSE.error=null;
  BROWSE.pending=target;
  browseRenderStatus();
  browseRenderList();
  browseRenderCrumbs();
}
function browseLoad(path,allowRootsFallback){
  browseSetLoading(path);
  browseFetch(path).then(function(res){
    BROWSE.loading=false;
    if(!res||res.ok!==true){
      var message=(res&&res.error)||('读取失败（HTTP '+(res&&res.status||'')+'）');
      if(allowRootsFallback){BROWSE.error=null;enterBrowseRoots(res,message);}
      else browseFail(message,res);
      return;
    }
    if(res.roots===true||res.path===null){
      BROWSE.rootsMode=true;BROWSE.dir=null;BROWSE.parent=null;
    }else{
      BROWSE.rootsMode=false;BROWSE.dir=res.path;BROWSE.parent=res.parent;
    }
    BROWSE.entries=res.entries||[];
    BROWSE.truncated=res.truncated===true;
    BROWSE.filter='';BROWSE.active=-1;BROWSE.error=null;BROWSE.note=null;
    var box=$('cf-browse-filter');
    if(box){box.value='';box.placeholder='过滤当前层级的子目录…';}
    browseRenderAll();
  }).catch(function(err){
    BROWSE.loading=false;
    var message=(err&&err.message)||String(err);
    if(allowRootsFallback){enterBrowseRoots(null,message);return;}
    browseFail(message,null);
  });
}
/* 初始值非法/为空 → 从根清单开始（C1）；原错误作为一条提示展示，不关弹窗 */
function enterBrowseRoots(res,message){
  browseLoadRoots(message?('打开「'+String(BROWSE.pending||'').slice(0,80)+'」失败：'+message+'；已回到根清单。'):null);
  BROWSE.pending=null;
}
function browseLoadRoots(note){
  BROWSE.pending=null;
  browseSetLoading(null);
  browseFetch('').then(function(res){
    BROWSE.loading=false;
    if(!res||res.ok!==true){browseFail((res&&res.error)||'读取根清单失败',res);return;}
    BROWSE.rootsMode=true;BROWSE.dir=null;BROWSE.parent=null;
    BROWSE.entries=res.entries||[];
    BROWSE.truncated=res.truncated===true;
    BROWSE.filter='';BROWSE.active=-1;BROWSE.error=null;BROWSE.note=note||null;
    var box=$('cf-browse-filter');
    if(box){box.value='';box.placeholder='过滤根位置…';}
    browseRenderAll();
  }).catch(function(err){BROWSE.loading=false;browseFail((err&&err.message)||String(err),null);});
}
function browseFail(message,res){
  BROWSE.error=message;
  if(res&&res.code==='BROWSE_TIMEOUT')BROWSE.error=message+'（网络位置可能已断开）';
  browseRenderStatus();
  browseRenderList();
}
function browseEnter(entry){
  if(!entry||typeof entry.path!=='string')return;
  browseLoad(entry.path,false);
}
function browseGoUp(){
  if(BROWSE.rootsMode)return;
  if(BROWSE.loading)return;
  if(typeof BROWSE.parent==='string'&&BROWSE.parent.length>0){browseLoad(BROWSE.parent,false);}
  else browseLoadRoots();
}

/* ---- 渲染 ---- */
function browseRenderAll(){
  browseRenderCrumbs();
  browseRenderList();
  browseRenderStatus();
}
function browseVisibleEntries(){
  var q=BROWSE.filter.trim().toLowerCase();
  if(!q)return BROWSE.entries;
  return BROWSE.entries.filter(function(entry){return String(entry.name||'').toLowerCase().indexOf(q)>=0;});
}
function browseRenderCrumbs(){
  var box=$('cf-browse-crumbs');
  if(!box)return;
  if(BROWSE.loading&&BROWSE.pending){box.innerHTML='<span class="cf-browse-crumb-dim">正在打开…</span>';return;}
  if(BROWSE.rootsMode){box.innerHTML='<span class="cf-browse-crumb-dim">选择一个根位置进入</span>';return;}
  if(!BROWSE.dir){box.innerHTML='';return;}
  var crumbs=browseCrumbsOf(BROWSE.dir);
  var html='';
  crumbs.forEach(function(crumb,i){
    var last=i===crumbs.length-1;
    html+='<button type="button" class="cf-browse-crumb'+(last?' current':'')+'" data-crumb="'+esc(crumb.path)+'"'
      +(last?' disabled':'')+' title="'+esc(crumb.path)+'">'+esc(crumb.name)+'</button>';
    if(!last)html+='<span class="cf-browse-sep">›</span>';
  });
  box.innerHTML=html;
  Array.prototype.forEach.call(box.querySelectorAll('[data-crumb]'),function(btn){
    btn.addEventListener('click',function(){
      if(BROWSE.loading)return;
      browseLoad(btn.getAttribute('data-crumb'),false);
    });
  });
}
/* 面包屑拆解只用于**展示**；点击回跳发出的是服务端先前给出的完整路径 */
function browseCrumbsOf(dir){
  var sep=dir.indexOf('\\')>=0?'\\':'/';
  var parts=dir.split(sep).filter(function(part){return part.length>0;});
  var crumbs=[];
  var acc=dir.startsWith('\\\\')?'\\\\':(sep==='\\'&&/^[a-zA-Z]:/.test(dir)?'':'/');
  if(dir.startsWith('\\\\')){
    acc='\\\\'+parts[0];
    crumbs.push({name:'\\\\'+parts[0],path:acc});
    parts=parts.slice(1);
  }else if(sep==='\\'&&/^[a-zA-Z]:/.test(dir)){
    acc=dir.slice(0,2);
    crumbs.push({name:acc,path:acc+'\\'});
  }
  for(var i=0;i<parts.length;i++){
    acc=acc===undefined||acc===''?sep+parts[i]:(acc.endsWith(sep)?acc+parts[i]:acc+sep+parts[i]);
    crumbs.push({name:parts[i],path:acc});
  }
  return crumbs;
}
function browseFolderGlyph(){
  var body=(typeof ICONS!=='undefined'&&ICONS['folder-open'])||'<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>';
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+body+'</svg>';
}
function browseRenderList(){
  var list=$('cf-browse-list');
  if(!list)return;
  if(BROWSE.loading){list.innerHTML='<div class="cf-browse-empty"><span class="cf-act-spin">◐</span> 正在读取…</div>';return;}
  if(BROWSE.error){list.innerHTML='';return;}
  var items=browseVisibleEntries();
  if(BROWSE.active>=items.length)BROWSE.active=items.length>0?items.length-1:-1;
  if(!items.length){
    list.innerHTML='<div class="cf-browse-empty">'+(BROWSE.filter?'没有匹配的项':'没有子目录（仍可选择当前目录）')+'</div>';
    browseRenderPickButton(items);
    return;
  }
  var html='';
  items.forEach(function(entry,i){
    html+='<div class="cf-browse-row'+(i===BROWSE.active?' active':'')+'" role="option" data-i="'+i+'" aria-selected="'+(i===BROWSE.active?'true':'false')+'" tabindex="-1">'
      +'<span class="cf-browse-glyph">'+browseFolderGlyph()+'</span>'
      +'<span class="cf-browse-name" title="'+esc(entry.path)+'">'+esc(entry.name)+'</span>'
      +(entry.kind==='root'?'<span class="cf-browse-kind">根位置</span>':'')
      +'</div>';
  });
  if(BROWSE.truncated)html+='<div class="cf-browse-truncated">仅显示前 '+BROWSE.entries.length+' 项；请用过滤框缩小范围或进入更深的层级</div>';
  list.innerHTML=html;
  Array.prototype.forEach.call(list.querySelectorAll('.cf-browse-row'),function(row){
    var index=Number(row.getAttribute('data-i'));
    row.addEventListener('click',function(){browseSelectIndex(index);});
    row.addEventListener('dblclick',function(){
      var entry=browseVisibleEntries()[index];
      browseEnter(entry);
    });
  });
  browseRenderPickButton(items);
  scrollBrowseActive();
}
function browseRenderPickButton(items){
  var btn=$('cf-browse-pick');
  if(!btn)return;
  var selected=(items||browseVisibleEntries())[BROWSE.active];
  if(BROWSE.rootsMode){
    btn.disabled=!selected;
    btn.textContent=selected?('选择 '+selected.name):'选择此目录';
  }else{
    btn.disabled=false;
    btn.textContent=selected?('选择 '+selected.name):'选择此目录';
  }
}
function browseSelectIndex(index){
  BROWSE.active=index;
  Array.prototype.forEach.call($('cf-browse-list').querySelectorAll('.cf-browse-row'),function(row,i){
    row.classList.toggle('active',i===index);
    row.setAttribute('aria-selected',i===index?'true':'false');
  });
  browseRenderPickButton();
  scrollBrowseActive();
}
function scrollBrowseActive(){
  var active=$('cf-browse-list').querySelector('.cf-browse-row.active');
  if(active&&active.scrollIntoView)try{active.scrollIntoView({block:'nearest'});}catch(e){}
}
function browseRenderStatus(){
  var box=$('cf-browse-status');
  if(!box)return;
  if(BROWSE.loading){box.innerHTML='';return;}
  var html='';
  if(BROWSE.note)html+='<span class="cf-browse-note">'+esc(BROWSE.note)+'</span>';
  if(BROWSE.error){
    html+='<span class="cf-browse-error">'+esc(BROWSE.error)+'</span>'
      +'<button type="button" class="cf-btn mini" data-b="retry">重试</button>';
    box.innerHTML=html;
    box.querySelector('[data-b="retry"]').addEventListener('click',function(){
      BROWSE.error=null;
      if(BROWSE.rootsMode)browseLoadRoots();
      else if(BROWSE.dir)browseLoad(BROWSE.dir,false);
      else browseLoadRoots();
    });
    return;
  }
  if(BROWSE.rootsMode)html+='<span class="cf-browse-hint">进入一个根位置后，再选择具体目录</span>';
  else if(BROWSE.dir)html+='<span class="cf-browse-hint" title="'+esc(BROWSE.dir)+'">当前：'+esc(BROWSE.dir)+'</span>';
  box.innerHTML=html;
}

/* ---- 键盘 ---- */
function onBrowseKeydown(e){
  if(e.key==='ArrowDown'){
    e.preventDefault();
    var items=browseVisibleEntries();
    if(items.length){var nx=Math.min(items.length-1,BROWSE.active+1);browseSelectIndex(nx);}
  }else if(e.key==='ArrowUp'){
    e.preventDefault();
    var list=browseVisibleEntries();
    if(list.length){var pv=Math.max(0,BROWSE.active-1);browseSelectIndex(pv);}
  }else if(e.key==='Enter'){
    e.preventDefault();
    var entry=browseVisibleEntries()[Math.max(0,BROWSE.active)];
    if(entry)browseEnter(entry);
  }else if(e.key==='Backspace'){
    e.preventDefault();
    browseGoUp();
  }
}

/* ---- 回填（不自动提交） ---- */
function browsePick(){
  var items=browseVisibleEntries();
  var selected=items[BROWSE.active];
  var value=BROWSE.rootsMode?(selected?selected.path:null):(selected?selected.path:BROWSE.dir);
  if(typeof value!=='string'||value.length===0)return;
  var input=BROWSE.input;
  closeBrowsePicker();
  if(input){
    input.value=value;
    try{input.dispatchEvent(new Event('input',{bubbles:true}));}catch(e){}
  }
}
