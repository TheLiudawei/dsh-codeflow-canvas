/* ================= v1.2：模块耦合分析（屎山程度） =================
 * 全部走宿主 HTTP（POST/GET /codeflow/api/coupling），零 agent、零 token。
 *   - 节点徽章：文件级 module 节点头部状态徽章左侧的小胶囊 + 右缘 3px 色条；
 *   - 左上角卡片：整体「屎山程度 · 低|中|高」+ 统计行 + 部分/过期角标；
 *   - 入口：节点右键「分析耦合」/ 空白右键「分析全部耦合」/ 工具栏按钮；
 *   - 任务视图：只显示卡片（meta.coupling 镜像）并标注「来自模块结构图」，
 *     绝不给任务节点打标签；
 *   - 过期：GET /api/coupling 的 stale 只做渲染叠加（灰化/虚线），不写图。
 * 所有动态文本一律 esc()/textContent，禁止拼接未转义 HTML。 */
var COUPLING={stale:null,staleKey:'',staleProject:'',running:false,card:null};

function couplingLevelText(level){return level==='high'?'高':level==='medium'?'中':'低';}
function couplingLevelColor(level){return level==='high'?'#ef4444':level==='medium'?'#eab308':'#22c55e';}
/* 与宿主 lib/coupling.js 的 isFileModuleNode 同一判定：type=module 且 symbol 为空 */
function canAnalyzeCouplingNode(n){
  return !!(n&&n.type==='module'&&n.params&&typeof n.params.path==='string'&&n.params.path.length>0
    &&(n.params.symbol===undefined||n.params.symbol===null||n.params.symbol===''));
}
function couplingProjectName(){return (G.project&&G.project.name)||null;}
function modulesAvailable(){
  return !!(HOSTED&&VIEWMETA&&VIEWMETA.modules&&VIEWMETA.modules.available);
}
function couplingMetaOf(){var m=G.meta&&G.meta.coupling;return (m&&m.overall)?m:null;}

/* ---- 强制刷新：宿主刚写完图、rev 与本地相同，常规采纳会被 rev 门槛挡住。
   仅在同步代码里短暂下调 syncRev（不落任何异步间隙），绝不手动改 G 绕过 rev。 */
var adoptServerStateCouplingBase=adoptServerState;
adoptServerState=function(payload,force){
  if(force===true&&payload&&typeof payload.rev==='number'&&payload.view===CURVIEW){
    var saved=syncRev;
    syncRev=payload.rev-1;
    var changed=false;
    try{changed=adoptServerStateCouplingBase(payload);}finally{if(!changed)syncRev=saved;}
    if(changed)refreshCouplingStale(false);
    return changed;
  }
  return adoptServerStateCouplingBase(payload);
};
var refreshLatestSoonCouplingBase=refreshLatestSoon;
refreshLatestSoon=function(force){
  if(force!==true){refreshLatestSoonCouplingBase();return;}
  var name=couplingProjectName();
  if(!name)return;
  var q='?project='+encodeURIComponent(name)+'&view='+CURVIEW;
  fetchT('/codeflow/api/state'+q,{headers:{'accept':'application/json'},cache:'no-store'})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(p){if(p)adoptServerState(p,true);})
    .catch(function(){});
};

/* ---- 分析入口（节点右键 / 空白右键 / 工具栏共用） ----
   入队写队列与 pending autosave 串行（避免旧图覆盖耦合结果），但**不走
   queueWrite 的 syncRev 更新**：coupling 响应的 rev 属于 modules 视图，任务
   视图下点击若照抄会让下一次任务图 autosave 携带错误 expectedRev 撞 409。
   正确的 syncRev 由随后的 refreshLatestSoon(true) 按当前视图的拉取结果回填。 */
function queueWriteNoRev(kind,buildBody){
  var run=writeChain.then(function(){return apiPost(kind,buildBody());});
  writeChain=run.then(function(){},function(){});
  return run;
}
function runCouplingAnalysis(nodeId){
  if(!HOSTED){toast('耦合分析需要宿主环境','err');return;}
  var name=couplingProjectName();
  if(!name){toast('先打开一个项目','err');return;}
  if(!modulesAvailable()){toast('当前项目没有模块结构图，请先导入项目','err');return;}
  if(COUPLING.running){toast('耦合分析正在进行中，请稍候…');return;}
  COUPLING.running=true;
  updateCouplingButton();
  toast(nodeId?('正在分析「'+(((byId(nodeId)||{}).title)||nodeId)+'」的耦合…'):'正在分析全部模块的耦合…');
  queueWriteNoRev('coupling',function(){return {project:name,nodeId:nodeId||null};})
    .then(function(res){
      COUPLING.running=false;
      updateCouplingButton();
      refreshLatestSoon(true);
      fetchCouplingStale(true);
      renderCouplingCard();
      if(res&&res.warning)toast(res.warning,'err');
      if(res&&res.overall)toast('耦合分析完成：屎山程度 '+couplingLevelText(res.overall.level)+'（'+((res.durationMs==null)?'<1':res.durationMs)+'ms）','ok');
    })
    .catch(function(err){
      COUPLING.running=false;
      updateCouplingButton();
      if(err&&err.status===409)syncConflict(err);
      else toast('耦合分析失败：'+((err&&err.message)||err),'err');
    });
}

/* ---- 过期信息（GET /api/coupling：mtime 探测在宿主侧，10s 缓存） ---- */
function refreshCouplingStale(force){
  if(!HOSTED)return;
  var name=couplingProjectName();
  if(!name)return;
  var meta=couplingMetaOf();
  var key=(meta&&meta.at)?String(meta.at):'';
  if(force!==true&&COUPLING.stale&&COUPLING.staleKey===key&&COUPLING.staleProject===name)return;
  apiGet('/codeflow/api/coupling?project='+encodeURIComponent(name)+'&view=modules')
    .then(function(p){
      if(!p||p.ok===false)return;
      COUPLING.stale=p.stale||{overall:false,nodes:{}};
      COUPLING.staleKey=key;
      COUPLING.staleProject=name;
      renderCouplingCard();
      applyCouplingMarks();
    })
    .catch(function(){});
}

/* ---- 节点徽章 + 右缘色条（只增删 class/子元素，不为高亮整图重渲染） ---- */
function applyCouplingMarks(){
  var meta=couplingMetaOf();
  var stale=(COUPLING.stale&&COUPLING.stale.nodes)||{};
  for(var i=0;i<G.nodes.length;i++){
    var n=G.nodes[i];
    var el=nodeEls[n.id];
    if(!el)continue;
    var edge=el.querySelector('.cf-coupling-edge');
    var head=el.querySelector('.cf-node-head');
    var badge=head?head.querySelector('.cf-coupling-badge'):null;
    var usable=CURVIEW==='modules'&&canAnalyzeCouplingNode(n)&&n.coupling&&n.coupling.level;
    if(!usable){
      if(edge&&edge.parentNode)edge.parentNode.removeChild(edge);
      if(badge&&badge.parentNode)badge.parentNode.removeChild(badge);
      el.classList.remove('cf-coupling-stale');
      continue;
    }
    var level=n.coupling.level==='high'?'high':n.coupling.level==='medium'?'medium':'low';
    var isStale=stale[n.id]===true;
    el.classList.toggle('cf-coupling-stale',isStale);
    if(!edge){
      edge=document.createElement('div');
      edge.className='cf-coupling-edge';
      el.appendChild(edge);
    }
    edge.setAttribute('data-level',level);
    edge.classList.toggle('stale',isStale);
    if(head&&!badge){
      badge=document.createElement('span');
      badge.className='cf-coupling-badge';
      var statusBadge=head.querySelector('.cf-badge');
      if(statusBadge)head.insertBefore(badge,statusBadge);
      else head.appendChild(badge);
    }
    if(badge){
      badge.setAttribute('data-level',level);
      badge.classList.toggle('stale',isStale);
      badge.textContent='耦合 · '+couplingLevelText(level);
    }
  }
}

/* ---- 左上角卡片 ---- */
function ensureCouplingCard(){
  if(COUPLING.card&&COUPLING.card.isConnected)return COUPLING.card;
  var card=document.createElement('div');
  card.className='cf-coupling-card';
  card.id='cf-coupling-card';
  card.hidden=true;
  card.innerHTML='<div class="cf-coupling-line1"><span class="cf-coupling-dot"></span>'
    +'<span class="cf-coupling-title"></span><span class="cf-coupling-extra"></span></div>'
    +'<div class="cf-coupling-line2"></div>';
  card.addEventListener('click',openCouplingDetails);
  $('cf-stage').appendChild(card);
  COUPLING.card=card;
  return card;
}
function renderCouplingCard(){
  var card=ensureCouplingCard();
  var meta=couplingMetaOf();
  var btn=$('cf-tb-coupling');
  if(!meta){
    card.hidden=true;
    if(btn)btn.disabled=COUPLING.running||!modulesAvailable();
    return;
  }
  var overall=meta.overall;
  var level=overall.level==='high'?'high':overall.level==='medium'?'medium':'low';
  var staleOverall=COUPLING.stale&&COUPLING.stale.overall===true;
  card.hidden=false;
  card.classList.toggle('stale',staleOverall===true);
  card.querySelector('.cf-coupling-dot').style.background=couplingLevelColor(level);
  card.querySelector('.cf-coupling-title').textContent='屎山程度 · '+couplingLevelText(level);
  var extras=[];
  if(staleOverall===true)extras.push('可能过期');
  if(overall.partial===true)extras.push('已分析 '+overall.analyzed+'/'+overall.modules);
  card.querySelector('.cf-coupling-extra').textContent=extras.length>0?('· '+extras.join(' · ')):'';
  var parts=['模块 '+overall.modules,'环 '+overall.cycles];
  /* 平均分只在模块视图能逐节点取到；任务视图显示「来自模块结构图」 */
  var restricted=0,analyzedNodes=0;
  if(CURVIEW==='modules'){
    var sum=0,count=0;
    for(var i=0;i<G.nodes.length;i++){
      var n=G.nodes[i];
      if(!canAnalyzeCouplingNode(n)||!n.coupling)continue;
      analyzedNodes+=1;
      if(n.coupling.metrics&&n.coupling.metrics.parsed===false)restricted+=1;
      sum+=n.coupling.score;count+=1;
    }
    if(count>0)parts=['模块 '+overall.modules,'平均 '+Math.round(sum/count),'环 '+overall.cycles];
    if(analyzedNodes>0&&restricted*3>=analyzedNodes*2)parts.push('多数文件解析受限');
  }else{
    parts.push('来自模块结构图');
  }
  card.querySelector('.cf-coupling-line2').textContent=parts.join(' · ');
  if(btn)btn.disabled=COUPLING.running||!modulesAvailable();
}

/* ---- 工具栏按钮状态 ---- */
function updateCouplingButton(){
  var btn=$('cf-tb-coupling');
  if(!btn)return;
  if(!HOSTED){btn.hidden=true;return;}
  btn.hidden=false;
  var available=modulesAvailable();
  btn.disabled=COUPLING.running||!available;
  btn.setAttribute('data-tooltip',!available
    ?'当前项目没有模块结构图，请先导入项目'
    :'耦合分析：全部模块的耦合程度与整体「屎山程度」（纯宿主执行，不唤醒 agent、不消耗 token）');
}

/* ---- 详情弹窗：整体结论 + 模块表格（分数降序）+ 根目录/时间/受限数 ---- */
function openCouplingDetails(){
  var meta=couplingMetaOf();
  if(!meta){toast('还没有耦合分析结果，请先「分析全部耦合」','err');return;}
  var overall=meta.overall;
  var stale=(COUPLING.stale&&COUPLING.stale.nodes)||{};
  var rows=[];
  var restricted=0;
  if(CURVIEW==='modules'){
    for(var i=0;i<G.nodes.length;i++){
      var n=G.nodes[i];
      if(!canAnalyzeCouplingNode(n)||!n.coupling)continue;
      var m=n.coupling.metrics||{};
      if(m.parsed===false)restricted+=1;
      rows.push({id:n.id,title:n.title||n.id,level:n.coupling.level,score:n.coupling.score,
        fanIn:m.fanIn,fanOut:m.fanOut,scc:m.sccSize,refs:m.refs,symbols:m.symbols,parsed:m.parsed!==false});
    }
    rows.sort(function(a,b){return b.score-a.score||String(a.id).localeCompare(String(b.id));});
  }
  var h=dHead('activity','耦合分析 · 屎山程度 '+couplingLevelText(overall.level))
    +'<div class="cf-dbody">'
    +'<div class="cf-kv"><b>整体</b><span style="color:'+couplingLevelColor(overall.level)+'">'
    +esc(couplingLevelText(overall.level))+'（分数 '+overall.score+'）</span></div>'
    +'<div class="cf-kv"><b>规模</b><span>模块 '+overall.modules+' · 已分析 '+overall.analyzed
    +(overall.partial===true?'（部分结果）':'')+' · 环 '+overall.cycles+'</span></div>'
    +(CURVIEW!=='modules'?'<div class="cf-hintbox">以下逐模块明细来自模块结构图，请切换到模块结构图查看。</div>':'');
  if(CURVIEW==='modules'&&rows.length>0){
    h+='<div class="cf-sec"><div class="cf-sec-title">模块明细（按分数降序）</div>'
      +'<table class="cf-coupling-table"><thead><tr><th>模块</th><th>等级</th><th>分数</th>'
      +'<th>扇入 Ca</th><th>扇出 Ce</th><th>环</th><th>内部引用/符号</th></tr></thead><tbody>';
    rows.forEach(function(r){
      h+='<tr><td>'+esc(r.title)+'</td>'
        +'<td><span class="cf-coupling-level" data-level="'+r.level+'">'+esc(couplingLevelText(r.level))+'</span></td>'
        +'<td>'+r.score+'</td><td class="dim">'+r.fanIn+'</td><td class="dim">'+r.fanOut+'</td>'
        +'<td class="dim">'+r.scc+'</td><td class="dim">'+r.refs+' / '+r.symbols+(r.parsed?'':' · 解析受限')+'</td></tr>';
    });
    h+='</tbody></table></div>';
  }else if(CURVIEW==='modules'){
    h+='<div class="cf-sechint">模块图里还没有任何分析结果。</div>';
  }
  h+='<div class="cf-sec"><div class="cf-sechint">'
    +'根目录：'+esc(meta.root||'—')+'<br>分析时间：'+esc(meta.at||'—')
    +(restricted>0?('<br>解析受限的文件：'+restricted+' 个（按行数/体积给弱结论）'):'')
    +((COUPLING.stale&&COUPLING.stale.overall===true)?'<br><span style="color:#f87171">结果可能已过期：源文件在分析后被修改过，建议重新分析。</span>':'')
    +'</div></div>';
  h+='</div>'
    +'<div class="cf-dfoot" style="flex-wrap:wrap">'
    +(modulesAvailable()?'<button type="button" class="cf-btn mini" data-act="rerun">重新分析</button>':'')
    +'<span style="flex:1"></span>'
    +'<button type="button" class="cf-btn cf-primary mini" data-act="close">关闭</button></div>';
  openModal(h);
  var d=$('cf-dialog');
  d.querySelector('[data-act="close"]').addEventListener('click',closeModal);
  var rerun=d.querySelector('[data-act="rerun"]');
  if(rerun)rerun.addEventListener('click',function(){closeModal();runCouplingAnalysis(null);});
}

/* ---- 渲染挂钩与初始化 ---- */
var renderChromeCouplingBase=renderChrome;
renderChrome=function(){renderChromeCouplingBase();renderCouplingCard();updateCouplingButton();};
var renderNodesCouplingBase=renderNodes;
renderNodes=function(){renderNodesCouplingBase();applyCouplingMarks();};
function initCouplingExtras(){
  if(!HOSTED){
    var btn=$('cf-tb-coupling');
    if(btn)btn.hidden=true;
    return;
  }
  ensureCouplingCard();
  renderCouplingCard();
  applyCouplingMarks();
  refreshCouplingStale(false);
}
