/* ================= v1.2：拖拽导入（文件夹 / 压缩包） =================
 * 上传通道是主路径（iframe 里拿不到拖入项的真实路径）：webkitGetAsEntry 递归
 * 收文件 → 本地预检（数量/大小，不合法直接 toast）→ 确认框 → begin/file/finalize。
 * 真实路径通道只在宿主暴露 getPathForFile 时生效（薄分支，有则用）。
 * 独立模式（!HOSTED）下拖拽禁用，drop 时 toast 提示。所有动态文本一律 esc()。 */
var DROP={overlay:null,depth:0,busy:false,cancelled:false,token:null};

function dropArchiveKind(name){
  return /\.(zip|tar|tar\.gz|tgz|7z|rar)$/i.test(String(name||''))?'archive':null;
}
function fmtBytes(n){
  if(typeof n!=='number'||!(n>=0))return '0 B';
  if(n<1024)return n+' B';
  if(n<1024*1024)return (n/1024).toFixed(1)+' KB';
  return (n/1024/1024).toFixed(1)+' MB';
}
/* 5.2 来源探测：File.path 已从 Electron 移除，逐个桥接探测，全失败返回 '' */
function pathOfDropped(file){
  try{if(file&&typeof file.path==='string'&&file.path)return file.path;}catch(e){}
  var hosts=[window.__DSH_ELECTRON__,window.dsh,window.electron,window.webUtils];
  for(var i=0;i<hosts.length;i++){
    try{
      var host=hosts[i];
      if(host&&typeof host.getPathForFile==='function'){
        var p=host.getPathForFile(file);
        if(typeof p==='string'&&p)return p;
      }
    }catch(e){}
  }
  return '';
}

/* ---- 拖拽事件：dragenter 计数防抖，overlay pointer-events:none 不拦截 ---- */
function ensureDropOverlay(){
  if(DROP.overlay&&DROP.overlay.isConnected)return DROP.overlay;
  var el=document.createElement('div');
  el.className='cf-drop-overlay';
  el.textContent='松开导入项目（文件夹 / zip / tar / tar.gz / 7z / rar）';
  ROOT.appendChild(el);
  DROP.overlay=el;
  return el;
}
function showDropOverlay(show){
  var el=show?ensureDropOverlay():DROP.overlay;
  if(el)el.hidden=!show;
}
window.addEventListener('drop',function(e){
  if(e&&e.preventDefault)e.preventDefault();
});
function initDropExtras(){
  ROOT.addEventListener('dragenter',function(e){
    if(e&&e.preventDefault)e.preventDefault();
    DROP.depth+=1;
    showDropOverlay(true);
  });
  ROOT.addEventListener('dragover',function(e){
    if(e&&e.preventDefault)e.preventDefault();
    if(e.dataTransfer)e.dataTransfer.dropEffect='copy';
    showDropOverlay(true);
  });
  ROOT.addEventListener('dragleave',function(e){
    DROP.depth=Math.max(0,DROP.depth-1);
    if(DROP.depth===0)showDropOverlay(false);
  });
  ROOT.addEventListener('drop',function(e){
    if(e&&e.preventDefault)e.preventDefault();
    DROP.depth=0;
    showDropOverlay(false);
    if(e&&e.stopPropagation)e.stopPropagation();
    onDropImport(e);
  });
  window.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&DROP.overlay&&!DROP.overlay.hidden){showDropOverlay(false);DROP.depth=0;}
  });
}

/* ---- drop 分派：只处理第一个条目，其余提示忽略 ---- */
function onDropImport(e){
  if(DROP.busy){toast('正在导入上一个条目，请先等它完成','err');return;}
  var items=(e.dataTransfer&&e.dataTransfer.items)||[];
  var extra=items.length>1?('已忽略其余 '+(items.length-1)+' 个条目'):'';
  if(!items.length){
    toast('请拖入文件夹或压缩包（zip / tar / tar.gz / 7z / rar）','err');
    return;
  }
  var item=items[0];
  var entry=null;
  try{entry=(typeof item.webkitGetAsEntry==='function')?item.webkitGetAsEntry():null;}catch(err){entry=null;}
  if(!HOSTED){
    toast('拖拽导入需要宿主环境','err');
    return;
  }
  if(entry&&entry.isDirectory){
    startDropDirectory(entry,extra);
    return;
  }
  var file=null;
  try{file=(typeof item.getAsFile==='function')?item.getAsFile():null;}catch(err){file=null;}
  if(file&&dropArchiveKind(file.name)){
    startDropArchiveFile(file,extra);
    return;
  }
  if(entry&&entry.isFile){
    toast('请拖入文件夹或压缩包（zip / tar / tar.gz / 7z / rar）'+(extra?('；'+extra):''),'err');
    return;
  }
  toast('请拖入文件夹或压缩包（zip / tar / tar.gz / 7z / rar）','err');
}

/* ---- 目录条目递归（webkitGetAsEntry；空目录跳过，路径 / 分隔） ---- */
function walkDropEntry(entry,prefix,out,state){
  return new Promise(function(resolve){
    if(!entry)return resolve();
    if(entry.isFile){
      entry.file(function(file){
        if(DROP.cancelled)return resolve();
        out.push({rel:prefix+entry.name,file:file});
        state.bytes+=file.size||0;
        resolve();
      },function(){resolve();});
      return;
    }
    if(!entry.isDirectory)return resolve();
    var reader;
    try{reader=entry.createReader();}catch(err){return resolve();}
    var readBatch=function(){
      try{
        reader.readEntries(function(batch){
          if(!batch.length)return resolve();
          var chain=Promise.resolve();
          batch.forEach(function(child){
            chain=chain.then(function(){return walkDropEntry(child,prefix+entry.name+'/',out,state);});
          });
          chain.then(readBatch,function(){resolve();});
        },function(){resolve();});
      }catch(err){resolve();}
    };
    readBatch();
  });
}

/* ---- 目录流：预检 → 确认 → 上传 → finalize ---- */
function startDropDirectory(entry,extra){
  if(!entry)return;
  toast('正在统计文件夹内容…');
  var out=[],state={bytes:0};
  DROP.cancelled=false;
  walkDropEntry(entry,'',out,state).then(function(){
    if(DROP.cancelled)return;
    if(out.length===0){toast('该文件夹是空的，没有可导入的文件','err');return;}
    if(out.length>1000){toast('文件数超过 1000，已拒绝导入','err');return;}
    if(state.bytes>500*1024*1024){toast('解压后超过 500 MB，已拒绝导入','err');return;}
    if(extra)toast(extra);
    openDropConfirm({
      kind:'dir',name:entry.name,files:out.length,bytes:state.bytes,
      upload:function(opts){uploadDirectory(out,state,opts);},
    });
  });
}

/* ---- 压缩包流（单文件）：确认 → 上传本体 → finalize ---- */
function startDropArchiveFile(file,extra){
  if(file.size>500*1024*1024){toast('压缩包超过 500 MB，已拒绝导入','err');return;}
  if(extra)toast(extra);
  DROP.cancelled=false;
  openDropConfirm({
    kind:'archive',name:file.name,files:null,bytes:file.size,
    upload:function(opts){uploadArchive(file,opts);},
  });
}

/* ---- 确认框：类型/名称/文件数/大小 + 项目名/深度/注释任务/补测试/记住 ---- */
function openDropConfirm(info){
  var saved={};
  try{saved=JSON.parse(localStorage.getItem('cf-drop-opts')||'{}')||{};}catch(e){}
  var depth=typeof saved.depth==='number'?saved.depth:4;
  var fromComments=saved.fromComments!==false;
  var addTests=saved.addTests!==false;
  var baseName=info.kind==='archive'?String(info.name).replace(/\.(zip|tar\.gz|tgz|tar|7z|rar)$/i,''):String(info.name);
  var kindText=info.kind==='archive'?'压缩包':'文件夹';
  var targetText=info.kind==='archive'
    ?('将解压到：<b>CodeFlow/imports/'+esc(baseName)+'/</b>')
    :('将复制到：<b>CodeFlow/imports/'+esc(baseName)+'/</b>');
  var h=dHead('upload','导入项目')
    +'<div class="cf-dbody">'
    +'<div class="cf-drop-row"><b>类型</b><span>'+esc(kindText)+'</span></div>'
    +'<div class="cf-drop-row"><b>名称</b><span>'+esc(info.name)+'</span></div>'
    +'<div class="cf-drop-row"><b>文件数</b><span>'+(info.files==null?'—（解压后统计）':info.files)+'</span></div>'
    +'<div class="cf-drop-row"><b>大小</b><span>'+fmtBytes(info.bytes)+'</span></div>'
    +'<div class="cf-drop-row"><b>目标</b><span>'+targetText+'</span></div>'
    +'<div class="cf-setrow"><label for="cf-drop-name">项目名</label>'
    +'<input class="cf-in" id="cf-drop-name" type="text" spellcheck="false" value="'+esc(baseName)+'"></div>'
    +'<div class="cf-setrow"><label for="cf-drop-depth">递归深度</label>'
    +'<select class="cf-in" id="cf-drop-depth">'
    +[2,4,6,10].map(function(n){return '<option value="'+n+'"'+(n===depth?' selected':'')+'>'+n+'</option>';}).join('')
    +'</select></div>'
    +'<div class="cf-setrow"><label class="cf-chk" style="gap:6px;display:flex;align-items:center"><input type="checkbox" id="cf-drop-comments"'+(fromComments?' checked':'')+'> <span>从注释生成任务节点</span></label></div>'
    +'<div class="cf-setrow"><label class="cf-chk" style="gap:6px;display:flex;align-items:center"><input type="checkbox" id="cf-drop-tests"'+(addTests?' checked':'')+'> <span>未发现测试时补测试节点</span></label></div>'
    +'<div class="cf-setrow"><label class="cf-chk" style="gap:6px;display:flex;align-items:center"><input type="checkbox" id="cf-drop-remember"> <span>记住这些选项</span></label></div>'
    +'<div class="cf-sechint" style="color:#f87171;min-height:14px" id="cf-drop-err"></div>'
    +'</div>'
    +'<div class="cf-dfoot"><button type="button" class="cf-btn" data-act="cancel">取消</button>'
    +'<span style="flex:1"></span>'
    +'<button type="button" class="cf-btn cf-primary" data-act="import">导入</button></div>';
  openModal(h);
  var d=$('cf-dialog');
  var closeBtn=d.querySelector('[data-act="cancel"]');
  var importBtn=d.querySelector('[data-act="import"]');
  closeBtn.addEventListener('click',closeModal);
  importBtn.addEventListener('click',function(){
    var nameEl=d.querySelector('#cf-drop-name');
    var depthEl=d.querySelector('#cf-drop-depth');
    var commentsEl=d.querySelector('#cf-drop-comments');
    var testsEl=d.querySelector('#cf-drop-tests');
    var rememberEl=d.querySelector('#cf-drop-remember');
    var errEl=d.querySelector('#cf-drop-err');
    var opts={
      name:String((nameEl&&nameEl.value)||'').trim()||baseName,
      depth:Number(depthEl&&depthEl.value)||4,
      fromComments:commentsEl?commentsEl.checked:true,
      addTests:testsEl?testsEl.checked:true,
    };
    if(rememberEl&&rememberEl.checked){
      try{localStorage.setItem('cf-drop-opts',JSON.stringify({depth:opts.depth,fromComments:opts.fromComments,addTests:opts.addTests}));}catch(e){}
    }
    closeModal();
    info.upload(opts);
  });
}

/* ---- 进度弹窗：阶段文案 + 进度条 + 取消（仅上传阶段可取消） ---- */
function openDropProgress(){
  var h=dHead('upload','导入项目')
    +'<div class="cf-dbody">'
    +'<div class="cf-kv"><b>状态</b><span id="cf-drop-stage">正在准备…</span></div>'
    +'<div class="cf-drop-progress"><i id="cf-drop-bar"></i></div>'
    +'<div class="cf-sechint" id="cf-drop-detail"></div>'
    +'</div>'
    +'<div class="cf-dfoot"><button type="button" class="cf-btn" data-act="cancel">取消</button>'
    +'<span style="flex:1"></span>'
    +'<span class="cf-sechint">导入由宿主确定性执行，不唤醒 agent</span></div>';
  openModal(h);
  var d=$('cf-dialog');
  var cancel=d.querySelector('[data-act="cancel"]');
  cancel.addEventListener('click',function(){
    DROP.cancelled=true;
    if(DROP.token)dropAbort(DROP.token);
    closeModal();
    toast('已取消导入，暂存区已清理');
  });
}
function dropStage(stage,detail,percent){
  if($('cf-modal').hidden)return;
  var stageEl=$('cf-drop-stage');
  var barEl=$('cf-drop-bar');
  var detailEl=$('cf-drop-detail');
  if(stageEl)stageEl.textContent=stage;
  if(detailEl)detailEl.textContent=detail||'';
  if(barEl)barEl.style.width=(percent==null?0:Math.max(0,Math.min(100,percent)))+'%';
  var cancel=$('cf-dialog').querySelector('[data-act="cancel"]');
  if(cancel&&stage==='正在分析…')cancel.disabled=true;
}
function dropAbort(token){
  apiPost('drop/abort',{token:token}).catch(function(){});
}

/* ---- 上传通道：begin → 逐文件 POST（octet-stream）→ finalize ---- */
function uploadDirectory(out,state,opts){
  if(!HOSTED){toast('拖拽导入需要宿主环境','err');return;}
  DROP.busy=true;
  DROP.token=null;
  openDropProgress();
  dropStage('正在准备…','共 '+out.length+' 个文件 · '+fmtBytes(state.bytes));
  apiPost('drop/begin',{kind:'dir',name:opts.name,files:out.length,bytes:state.bytes})
    .then(function(res){
      if(!res||!res.token)throw new Error((res&&res.error)||'无法创建上传会话');
      DROP.token=res.token;
      var sent=0,sentBytes=0;
      var chain=Promise.resolve();
      out.forEach(function(entry){
        chain=chain.then(function(){
          if(DROP.cancelled)throw Object.assign(new Error('已取消'),{cancelled:true});
          dropStage('正在上传 '+sent+'/'+out.length+' · '+fmtBytes(sentBytes)+' / '+fmtBytes(state.bytes),
            entry.rel,out.length>0?(sent/out.length*100):0);
          return fetchT('/codeflow/api/drop/file?token='+encodeURIComponent(res.token)
            +'&path='+encodeURIComponent(entry.rel),
            {method:'POST',headers:{'content-type':'application/octet-stream'},cache:'no-store',body:entry.file},120000)
            .then(function(r){return parseResp(r);})
            .then(function(){
              sent+=1;
              sentBytes+=entry.file.size||0;
            });
        });
      });
      return chain.then(function(){
        if(DROP.cancelled)throw Object.assign(new Error('已取消'),{cancelled:true});
        dropStage('正在分析…','正在生成任务流水线与模块结构图（宿主本地执行）');
        return apiPost('drop/finalize',{token:res.token,kind:'dir',projectName:opts.name,
          depth:opts.depth,fromComments:opts.fromComments,addTests:opts.addTests});
      });
    })
    .then(function(res){finishDropImport(res,opts,'folder');})
    .catch(function(err){
      var staleToken=DROP.token;
      DROP.busy=false;
      DROP.token=null;
      if($('cf-modal')&&!$('cf-modal').hidden)closeModal();
      if(err&&err.cancelled)return;
      if(err&&err.status===409&&err.data&&err.data.code==='conflict'){
        openDropConflict(err.data,function(decide){
          if(staleToken)dropAbort(staleToken);
          if(decide.action==='retry')uploadDirectory(out,state,Object.assign({},opts,decide.body));
        });
        return;
      }
      if(staleToken)dropAbort(staleToken);
      toast('导入失败：'+((err&&err.message)||err),'err');
    });
}
function uploadArchive(file,opts){
  if(!HOSTED){toast('拖拽导入需要宿主环境','err');return;}
  DROP.busy=true;
  DROP.token=null;
  openDropProgress();
  dropStage('正在准备…',file.name+' · '+fmtBytes(file.size));
  apiPost('drop/begin',{kind:'archive',name:file.name,files:1,bytes:file.size})
    .then(function(res){
      if(!res||!res.token)throw new Error((res&&res.error)||'无法创建上传会话');
      DROP.token=res.token;
      dropStage('正在上传 0/1 · 0 B / '+fmtBytes(file.size),file.name,0);
      return fetchT('/codeflow/api/drop/file?token='+encodeURIComponent(res.token)
        +'&path='+encodeURIComponent(file.name),
        {method:'POST',headers:{'content-type':'application/octet-stream'},cache:'no-store',body:file},300000)
        .then(function(r){return parseResp(r);})
        .then(function(){
          if(DROP.cancelled)throw Object.assign(new Error('已取消'),{cancelled:true});
          dropStage('正在解压…','宿主正在解压 '+file.name+'（zip/tar 本地解析；7z/rar 用系统工具）');
          return apiPost('drop/finalize',{token:res.token,kind:'archive',projectName:opts.name,
            depth:opts.depth,fromComments:opts.fromComments,addTests:opts.addTests});
        });
    })
    .then(function(res){finishDropImport(res,opts,'archive');})
    .catch(function(err){
      var staleToken=DROP.token;
      DROP.busy=false;
      DROP.token=null;
      if($('cf-modal')&&!$('cf-modal').hidden)closeModal();
      if(err&&err.cancelled)return;
      if(err&&err.status===409&&err.data&&err.data.code==='conflict'){
        openDropConflict(err.data,function(decide){
          if(staleToken)dropAbort(staleToken);
          if(decide.action==='retry')uploadArchive(file,Object.assign({},opts,decide.body));
        });
        return;
      }
      if(staleToken)dropAbort(staleToken);
      toast('导入失败：'+((err&&err.message)||err),'err');
    });
}

/* ---- 409 冲突：覆盖 / 改名 / 取消 ---- */
function openDropConflict(conflict,retry){
  var what=conflict.target==='dir'?('CodeFlow/imports/ 下已存在同名目录'):('已存在同名项目');
  var h=dHead('alert-triangle','项目名冲突')
    +'<div class="cf-dbody">'
    +'<div class="cf-hintbox">'+esc(what)+'：<b>'+esc(conflict.current||'')+'</b></div>'
    +'<div class="cf-sechint">覆盖会先备份旧图文件（.bak-时间戳）再重新导入；改名会自动加 -2/-3 后缀。</div>'
    +'</div>'
    +'<div class="cf-dfoot">'
    +'<button type="button" class="cf-btn" data-act="cancel">取消</button>'
    +'<span style="flex:1"></span>'
    +'<button type="button" class="cf-btn" data-act="rename">改名</button>'
    +'<button type="button" class="cf-btn cf-danger" data-act="overwrite">覆盖</button>'
    +'</div>';
  openModal(h);
  var d=$('cf-dialog');
  d.querySelector('[data-act="cancel"]').addEventListener('click',function(){closeModal();retry({action:'cancel'});});
  d.querySelector('[data-act="rename"]').addEventListener('click',function(){closeModal();retry({action:'retry',body:{rename:true}});});
  d.querySelector('[data-act="overwrite"]').addEventListener('click',function(){closeModal();retry({action:'retry',body:{overwrite:true}});});
}

/* ---- 完成：关弹窗 → 打开新项目（任务视图）→ toast 摘要 ---- */
function finishDropImport(res,opts,kindLabel){
  DROP.busy=false;
  DROP.token=null;
  if($('cf-modal')&&!$('cf-modal').hidden)closeModal();
  if(!res||res.ok!==true){
    toast('导入失败：'+((res&&res.error)||'未知错误'),'err');
    return;
  }
  CURVIEW='tasks';
  if(res.views)VIEWMETA=res.views;
  if(res.graph&&valid(res.graph)){
    syncRev=typeof res.rev==='number'?res.rev:syncRev;
    G=clone(res.graph);
    if(!G.meta)G.meta={};
    sel={type:null,id:null};
    renderAll();
    applyView();
    if(G.nodes.length)requestAnimationFrame(function(){fitView();});
    renderViewTabs();
  }
  apiPost('view',{project:res.project,view:'tasks'}).catch(function(){});
  refreshCouplingStale(true);
  var overall=(res.coupling&&res.coupling.overall)||null;
  var summary='已导入'+(kindLabel==='archive'?'（解压）':'')+' · 模块 '+(overall?overall.modules:'—')
    +(overall?(' · 屎山程度 '+couplingLevelText(overall.level)):'');
  if(res.warning)showBanner('导入完成，但有一些提醒：'+res.warning);
  else toast(summary,'ok');
  if(res.modulesAvailable===false)showBanner('模块结构图未能生成：目录里几乎没有源码；任务流水线已正常导入。');
}

/* ---- 真实路径通道（薄分支）：宿主桥接可用且拿到路径时，就地导入 ---- */
function dropViaPath(path,kind,opts){
  return apiPost('drop/path',Object.assign({path:path,kind:kind,depth:opts.depth,
    fromComments:opts.fromComments,addTests:opts.addTests},opts.rename?{rename:true}:{},opts.overwrite?{overwrite:true}:{},opts.projectName?{projectName:opts.projectName}:{}));
}
