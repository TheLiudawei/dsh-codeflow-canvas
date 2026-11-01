/* ================= v1.1：功能分组（features.json） =================
 * 数据来源：GET/POST /codeflow/api/features（宿主读 <项目>/features.json；
 * 画布只走同源 HTTP，不读磁盘）。仅 think/build 两个分类启用分组：
 *   - 组行点击 = spotlightNodes 整组高亮（不关浮层）；成员行点击沿用 pickNavRow
 *     （关浮层 + focusNode，行为与改动前完全一致）；
 *   - 组行右键 = 重命名 / 合并到… / 解散 / 重新识别（前三个 POST /api/features
 *     后重拉，重新识别 = ?refresh=1）；
 *   - 识别不出 → 列表顶部横幅 + 「让 agent 识别」（唯一的模型路径，仅显式点击；
 *     请求中禁用防重复）。识别/拉取失败一律退化为扁平列表，绝不白屏。
 * 折叠状态只存内存（navPop.collapsed Set），默认展开第一组；未分类组固定最后、
 * 默认收起。搜索沿用 navPop.query，跨组过滤：组内 0 命中整组隐藏，组名命中保留。
 * 所有动态字符串一律 esc()/textContent，禁止拼接未转义 HTML。 */
var FEATURES={data:null,reqId:0,nodeTags:null,uncatIds:[]};
var SPOT={active:false,ids:null,label:'',box:null};

function featuresEnabledFor(cat){
  return HOSTED&&(cat==='think'||cat==='build');
}
function featuresProjectName(){
  return (G.project&&G.project.name)||null;
}
/* 打开浮层时拉取（每次打开都拉：轻量、且能吃到宿主刚写盘的结果） */
function fetchFeatures(force){
  var name=featuresProjectName();
  if(!name)return Promise.resolve(null);
  var rid=++FEATURES.reqId;
  return fetchT('/codeflow/api/features?project='+encodeURIComponent(name)+'&view='+CURVIEW+(force?'&refresh=1':''),{headers:{'accept':'application/json'},cache:'no-store'})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(p){
      if(rid===FEATURES.reqId){
        FEATURES.data=(p&&p.ok)?p:null;
        buildNodeTags();
      }
      return FEATURES.data;
    })
    .catch(function(){
      if(rid===FEATURES.reqId){FEATURES.data=null;buildNodeTags();}
      return null;
    });
}
function buildNodeTags(){
  var tags=null;
  var data=FEATURES.data;
  if(data&&Array.isArray(data.features)){
    tags={};
    data.features.forEach(function(f){
      (f.nodes||[]).forEach(function(id){
        if(!tags[id])tags[id]=[];
        if(tags[id].indexOf(f.name)<0)tags[id].push(f.name);
      });
    });
  }
  FEATURES.nodeTags=tags;
}
/* 写操作 → POST /api/features → 重拉 + 刷新浮层/详情/高亮 */
function featureOpRequest(op,body,okMsg){
  var name=featuresProjectName();
  if(!name)return;
  apiPost('features',Object.assign({op:op,project:name,view:CURVIEW},body)).then(function(res){
    if(res&&res.ok){
      if(okMsg)toast(okMsg,'ok');
      if(SPOT.active)clearSpotlight();
      refreshFeatures(false);
      return;
    }
    toast((res&&res.error)||'操作失败','err');
  }).catch(function(err){
    toast('操作失败：'+((err&&err.message)||err),'err');
  });
}
function refreshFeatures(force){
  var name=featuresProjectName();
  if(!name)return Promise.resolve(null);
  return fetchFeatures(force===true).then(function(){
    if(navPop.open&&featuresEnabledFor(navPop.cat)){renderNavPop();positionNavPop();}
    if(force===true&&SPOT.active)clearSpotlight();
    if(detailsNodeId!==null&&!$('cf-modal').hidden)openDetails(detailsNodeId);
    return FEATURES.data;
  });
}

/* ---- 浮层：打开时重置分组状态，数据到达后按需重渲染 ---- */
var openNavPopFeaturesBase=openNavPop;
openNavPop=function(cat,anchorBtn){
  FEATURES.data=null;
  FEATURES.nodeTags=null;
  FEATURES.uncatIds=[];
  navPop.collapsed=new Set();
  navPop.uncategorizedOpen=false;
  navPop.grouped=false;
  openNavPopFeaturesBase(cat,anchorBtn);
  if(featuresEnabledFor(cat)&&featuresProjectName()){
    fetchFeatures(false).then(function(){
      if(navPop.open&&navPop.cat===cat){renderNavPop();positionNavPop();}
    });
  }
};
/* 渲染分派：非 think/build 走原实现；think/build 由 features 渲染器接管 */
var renderNavPopFeaturesBase=renderNavPop;
renderNavPop=function(){
  if(!navPop.open)return;
  if(!featuresEnabledFor(navPop.cat)){navPop.grouped=false;renderNavPopFeaturesBase();return;}
  renderFeaturesNavPop();
};
var setNavActiveIdFeaturesBase=setNavActiveId;
setNavActiveId=function(id){
  if(!navPop.grouped){setNavActiveIdFeaturesBase(id);return;}
  var list=$('cf-navlist');
  navPop.active=-1;
  navPop.items.forEach(function(it,i){if(it.n.id===id)navPop.active=i;});
  Array.prototype.forEach.call(list.querySelectorAll('[data-id]'),function(row){
    var on=row.getAttribute('data-id')===id;
    row.classList.toggle('active',on);
    if(row.classList.contains('cf-navrow'))row.setAttribute('aria-selected',on?'true':'false');
  });
  scrollNavPopActive();
};
var scrollNavPopActiveFeaturesBase=scrollNavPopActive;
scrollNavPopActive=function(){
  var list=$('cf-navlist');
  var active=list.querySelector('.active');
  if(active&&active.scrollIntoView)try{active.scrollIntoView({block:'nearest'});}catch(e){}
};
var pickNavRowFeaturesBase=pickNavRow;
pickNavRow=function(id){
  if(typeof id==='string'&&id.indexOf('@group:')===0){
    spotlightGroup(id.slice('@group:'.length));
    return;
  }
  pickNavRowFeaturesBase(id);
};

/* ---- 分组渲染 ---- */
/* 与 navPopItems 同一套命中逻辑（标题/次级说明），但不过滤、不排序，
   供分组模式做「组内命中 + 组名命中」判断 */
function featureItemsOf(){
  var q=navPop.query.trim().toLowerCase();
  return navPopSource().map(function(n){
    var t=typeOf(n);
    var sub='';
    if(n.type==='module'&&n.params&&n.params.path){
      var segs=String(n.params.path).split('\\').join('/').split('/');
      sub=segs.slice(Math.max(0,segs.length-3)).join('/');
    }else{
      var st=STC[n.status]||STC.pending;
      sub=st[0]+(n.result?(' · '+n.result):'');
    }
    var title=String(n.title||t.label);
    var hitTitle=!q||title.toLowerCase().indexOf(q)>=0;
    var hitPath=!q||!sub?hitTitle:(sub.toLowerCase().indexOf(q)>=0);
    return {n:n,title:title,sub:sub,hitTitle:hitTitle,hitPath:hitPath,hit:hitTitle||hitPath};
  });
}
function renderFeaturesNavPop(){
  var list=$('cf-navlist');
  var data=FEATURES.data;
  if(!data){navPop.grouped=false;renderNavPopFeaturesBase();return;}
  var feats=Array.isArray(data.features)?data.features:[];
  if(feats.length===0){
    navPop.grouped=false;
    renderFlatWithBanner(list);
    return;
  }
  renderGrouped(list,feats);
}
/* 识别不出（features: []）：横幅 + 原扁平列表 */
function renderFlatWithBanner(list){
  var items=navPopItems();
  navPop.items=items;
  if(navPop.active>=items.length)navPop.active=items.length>0?items.length-1:-1;
  list.innerHTML='';
  var banner=featuresBannerEl();
  if(banner)list.appendChild(banner);
  if(!items.length){
    if(!banner)list.innerHTML='<div class="cf-navempty">没有匹配的节点</div>';
    scrollNavPopActive();
    return;
  }
  list.insertAdjacentHTML('beforeend',items.map(function(it,i){return navRowHtml(it,i===navPop.active);}).join(''));
  bindNavRowEvents(list);
  scrollNavPopActive();
}
function featuresBannerEl(){
  if(!HOSTED)return null;
  var data=FEATURES.data;
  if(!data||!Array.isArray(data.features)||data.features.length>0)return null;
  var wrap=document.createElement('div');
  wrap.className='cf-fempty';
  var text=document.createElement('span');
  text.textContent='未识别到功能，可让 agent 识别一次';
  var btn=document.createElement('button');
  btn.type='button';
  btn.className='cf-btn mini cf-fempty-btn';
  btn.textContent='让 agent 识别';
  btn.addEventListener('click',function(){
    if(btn.disabled)return;
    var name=featuresProjectName();
    if(!name)return;
    btn.disabled=true;
    btn.textContent='请求中…';
    apiPost('features/agent',{project:name,view:CURVIEW}).then(function(res){
      if(res&&res.ok)toast('已请求识别，结果会出现在画布会话','ok');
      else toast((res&&res.error)||'请求失败','err');
    }).catch(function(err){
      toast('请求失败：'+((err&&err.message)||err),'err');
    }).then(function(){
      btn.disabled=false;
      btn.textContent='让 agent 识别';
    });
  });
  wrap.appendChild(text);
  wrap.appendChild(btn);
  return wrap;
}
function groupRowHtml(name,count,expanded,hint,low){
  return '<div class="cf-fgroup" role="option" data-id="'+esc('@group:'+name)+'" aria-selected="false" aria-expanded="'+(expanded?'true':'false')+'">'
    +'<span class="cf-farrow" data-farrow="1" role="button" aria-label="'+esc((expanded?'收起 ':'展开 ')+name)+'">'+(expanded?'▾':'▸')+'</span>'
    +'<span class="cf-navdot" style="background:'+typeColor(navPop.cat)+'"></span>'
    +'<span class="cf-fgroup-name">'+esc(name)+'</span>'
    +'<span class="cf-fgroup-count">· '+count+'</span>'
    +(low?'<span class="cf-fgroup-low">低置信</span>':'')
    +(hint||'')+'</div>';
}
function featureMemberRowHtml(it,active){
  var html=navRowHtml(it,active);
  var names=(FEATURES.nodeTags||{})[it.n.id];
  if(names&&names.length){
    var shown=names.slice(0,2);
    var label=shown.join('/')+(names.length>2?('+'+(names.length-2)):'');
    html=html.replace(/<\/div>$/,'<span class="cf-ftag" title="'+esc(names.join('、'))+'">'+esc(label)+'</span></div>');
  }
  return html;
}
function renderGrouped(list,feats){
  var q=navPop.query.trim().toLowerCase();
  var all=featureItemsOf();
  var byIdMap={};
  all.forEach(function(it){byIdMap[it.n.id]=it;});
  var claimed={};
  var groups=[];
  feats.forEach(function(f){
    var nodesAll=(f.nodes||[]).filter(function(id){return byIdMap[id];}).map(function(id){return byIdMap[id];});
    nodesAll.forEach(function(it){claimed[it.n.id]=1;});
    var members=q?(f.name&&String(f.name).toLowerCase().indexOf(q)>=0?nodesAll:nodesAll.filter(function(it){return it.hit;})):nodesAll;
    groups.push({f:f,membersAll:nodesAll,members:members,nameHit:!!(q&&String(f.name).toLowerCase().indexOf(q)>=0)});
  });
  /* 组过滤：有命中成员、组名命中、或（任务视图零命中且模块图有货 → 切换提示） */
  var viewGroups=groups.filter(function(g){
    if(g.members.length>0)return true;
    if(g.nameHit)return true;
    if(!q&&CURVIEW==='tasks'&&(g.f.count===0)&&(g.f.modulesCount||0)>0)return true;
    return false;
  });
  var rest=all.filter(function(it){return !claimed[it.n.id]&&it.hit;});
  var rows=[];
  var html='';
  viewGroups.forEach(function(g){
    var expanded=!navPop.collapsed.has(g.f.name);
    var hint=(CURVIEW==='tasks'&&g.membersAll.length===0&&(g.f.modulesCount||0)>0)
      ?'<span class="cf-fgroup-hint">在模块结构图有 '+g.f.modulesCount+' 个模块 · 切换视图</span>':'';
    html+=groupRowHtml(g.f.name,g.membersAll.length,expanded,hint,g.f.low===true);
    /* 组行也要有 .n.id 形状：基础键盘导航（↑/↓/Enter）按 items[i].n.id 寻址 */
    rows.push({kind:'group',id:'@group:'+g.f.name,n:{id:'@group:'+g.f.name},name:g.f.name});
    if(expanded)g.members.forEach(function(it){
      html+=featureMemberRowHtml(it,rows.length===navPop.active);
      rows.push({kind:'node',it:it});
    });
  });
  /* 未分类组：固定最后，默认收起 */
  if(rest.length>0){
    var restExpanded=navPop.uncategorizedOpen===true;
    html+=groupRowHtml('未分类',rest.length,restExpanded,'',false);
    rows.push({kind:'group',id:'@group:未分类',n:{id:'@group:未分类'},name:'未分类',uncategorized:true});
    if(restExpanded)rest.forEach(function(it){
      html+=featureMemberRowHtml(it,rows.length===navPop.active);
      rows.push({kind:'node',it:it});
    });
  }
  FEATURES.uncatIds=rest.map(function(it){return it.n.id;});
  navPop.grouped=true;
  if(rows.length===0){
    list.innerHTML='<div class="cf-navempty">没有匹配的节点</div>';
    navPop.items=[];
    return;
  }
  navPop.items=rows;
  if(navPop.active<0||navPop.active>=rows.length)navPop.active=0;
  list.innerHTML=html;
  var activeId=navPop.items[navPop.active]?navPop.items[navPop.active].id:null;
  Array.prototype.forEach.call(list.querySelectorAll('[data-id]'),function(row){
    var on=row.getAttribute('data-id')===activeId;
    row.classList.toggle('active',on);
    if(row.classList.contains('cf-navrow'))row.setAttribute('aria-selected',on?'true':'false');
  });
  bindFeatureRowEvents(list);
  scrollNavPopActive();
}
function bindFeatureRowEvents(list){
  Array.prototype.forEach.call(list.querySelectorAll('.cf-fgroup'),function(row){
    var name=row.getAttribute('data-id').slice('@group:'.length);
    row.addEventListener('click',function(e){
      if(e.target&&e.target.closest&&e.target.closest('.cf-farrow'))return;
      spotlightGroup(name);
    });
    var arrow=row.querySelector('.cf-farrow');
    if(arrow)arrow.addEventListener('click',function(e){
      e.stopPropagation();
      if(name==='未分类')navPop.uncategorizedOpen=!(navPop.uncategorizedOpen===true);
      else if(navPop.collapsed.has(name))navPop.collapsed.delete(name);
      else navPop.collapsed.add(name);
      renderNavPop();
      positionNavPop();
    });
    row.addEventListener('pointermove',function(){setNavActiveId(row.getAttribute('data-id'));});
    row.addEventListener('contextmenu',function(e){
      e.preventDefault();e.stopPropagation();
      var rr=ROOT.getBoundingClientRect();
      openGroupMenu(name,e.clientX-rr.left,e.clientY-rr.top);
    });
  });
  Array.prototype.forEach.call(list.querySelectorAll('.cf-navrow'),function(row){
    row.addEventListener('click',function(){pickNavRow(row.dataset.id);});
    row.addEventListener('pointermove',function(){setNavActiveId(row.dataset.id);});
  });
}
/* 组行右键：重命名 / 合并到…（子菜单列其它功能）/ 解散 / 重新识别 */
function openGroupMenu(name,x,y){
  if(name==='未分类'){
    openMenu([{label:'重新识别',icon:'rotate-cw',act:function(){toast('正在重新识别…');refreshFeatures(true);}}],x,y);
    return;
  }
  var others=[];
  var data=FEATURES.data;
  if(data&&Array.isArray(data.features)){
    data.features.forEach(function(f){
      if(f.name!==name)others.push({label:f.name,icon:'copy',act:function(){
        featureOpRequest('merge',{from:name,to:f.name},'已把「'+name+'」合并到「'+f.name+'」');
      }});
    });
  }
  var items=[
    {label:'重命名…',icon:'pencil',act:function(){
      openPrompt('重命名功能','功能名称',name,function(v){
        if(v&&v!==name)featureOpRequest('rename',{from:name,to:v},'已重命名为「'+v+'」');
      });
    }},
  ];
  if(others.length>0)items.push({label:'合并到…',icon:'copy',sub:others});
  else items.push({label:'合并到…（没有其它功能）',icon:'copy',act:function(){toast('没有其它功能可合并');}});
  items.push({label:'解散',icon:'trash-2',danger:true,act:function(){
    featureOpRequest('dissolve',{feature:name},'已解散「'+name+'」');
  }});
  items.push({sep:true});
  items.push({label:'重新识别',icon:'rotate-cw',act:function(){toast('正在重新识别…');refreshFeatures(true);}});
  openMenu(items,x,y);
}

/* ---- 整组高亮（spotlight）：不动 focusNode 的 1.8s 逻辑（不同 class、不同状态） ---- */
function spotBBox(){
  var minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9,any=false;
  G.nodes.forEach(function(n){
    if(!SPOT.ids||!SPOT.ids[n.id])return;
    var el=nodeEls[n.id];
    var w=el?el.offsetWidth:(typeOf(n).w||240),h=el?el.offsetHeight:130;
    minx=Math.min(minx,n.pos[0]);miny=Math.min(miny,n.pos[1]);
    maxx=Math.max(maxx,n.pos[0]+w);maxy=Math.max(maxy,n.pos[1]+h);
    any=true;
  });
  return any?{minx:minx,miny:miny,maxx:maxx,maxy:maxy}:null;
}
function applySpotClasses(){
  if(!SPOT.active)return;
  G.nodes.forEach(function(n){
    var el=nodeEls[n.id];
    if(el)el.classList.toggle('cf-spot',!!SPOT.ids[n.id]);
  });
}
function applySpotLinkClasses(){
  Array.prototype.forEach.call($('cf-links').querySelectorAll('.cf-linksvg'),function(svg){
    var on=SPOT.active&&SPOT.ids&&SPOT.ids[svg.getAttribute('data-from')]&&SPOT.ids[svg.getAttribute('data-to')];
    var vis=svg.querySelector('.cf-link');
    if(vis)vis.classList.toggle('cf-spot-link',!!on);
  });
}
function ensureSpotBox(){
  if(SPOT.box&&SPOT.box.isConnected)return SPOT.box;
  var box=document.createElement('div');
  box.className='cf-spotbox';
  var label=document.createElement('span');
  label.className='cf-spotbox-label';
  box.appendChild(label);
  $('cf-stage').appendChild(box);
  SPOT.box=box;
  return box;
}
function removeSpotBox(){
  if(SPOT.box&&SPOT.box.parentNode)SPOT.box.parentNode.removeChild(SPOT.box);
  SPOT.box=null;
}
/* 虚线框挂在 stage 上，坐标=节点包围盒+padding 换算到屏幕；随 pan/zoom 重算 */
function layoutSpotBox(){
  if(!SPOT.active){removeSpotBox();return;}
  var box=spotBBox();
  if(!box){removeSpotBox();return;}
  var pad=80;
  var sx=view.x+(box.minx-pad)*view.k;
  var sy=view.y+(box.miny-pad)*view.k;
  var sw=((box.maxx-box.minx)+pad*2)*view.k;
  var sh=((box.maxy-box.miny)+pad*2)*view.k;
  var el=ensureSpotBox();
  el.style.left=sx+'px';
  el.style.top=sy+'px';
  el.style.width=Math.max(24,sw)+'px';
  el.style.height=Math.max(24,sh)+'px';
  var label=el.querySelector('.cf-spotbox-label');
  if(label)label.textContent=SPOT.label;
}
function spotlightNodes(ids,label){
  clearSpotlight();
  var set={};
  (ids||[]).forEach(function(id){set[id]=1;});
  SPOT.active=true;
  SPOT.ids=set;
  SPOT.label=String(label||'');
  ROOT.classList.add('cf-spotlight');
  applySpotClasses();
  var box=spotBBox();
  if(box){
    /* 缩放到包围盒：padding 80，k clamp [0.4, 1.2]，复用 animateView */
    var pad=80;
    var bw=Math.max(60,(box.maxx-box.minx)+pad*2),bh=Math.max(60,(box.maxy-box.miny)+pad*2);
    var cx=(box.minx+box.maxx)/2,cy=(box.miny+box.maxy)/2;
    var r=stageRect();
    var k=Math.max(0.4,Math.min(1.2,Math.min((r.width-40)/bw,(r.height-40)/bh)));
    animateView(r.width/2-cx*k,r.height/2-cy*k,k,340);
  }
  layoutSpotBox();
}
function clearSpotlight(){
  if(!SPOT.active)return;
  SPOT.active=false;
  SPOT.ids=null;
  SPOT.label='';
  ROOT.classList.remove('cf-spotlight');
  G.nodes.forEach(function(n){
    var el=nodeEls[n.id];
    if(el)el.classList.remove('cf-spot');
  });
  Array.prototype.forEach.call($('cf-links').querySelectorAll('.cf-linksvg'),function(svg){
    var vis=svg.querySelector('.cf-link');
    if(vis)vis.classList.remove('cf-spot-link');
  });
  removeSpotBox();
}
/* 组点击 → 整组高亮；任务视图零命中且模块图有货 → 切换后自动高亮 */
function spotlightGroup(name){
  if(name==='未分类'){
    var uncat=(FEATURES.uncatIds||[]).filter(function(id){return byId(id);});
    if(uncat.length>0)spotlightNodes(uncat,name);
    else toast('未分类组没有可高亮的节点');
    return;
  }
  var data=FEATURES.data;
  if(!data)return;
  var f=null;
  (data.features||[]).forEach(function(entry){if(entry.name===name)f=entry;});
  if(!f)return;
  var ids=(f.nodes||[]).filter(function(id){return byId(id);});
  if(ids.length===0&&CURVIEW==='tasks'&&(f.modulesCount||0)>0){switchAndSpot(name);return;}
  if(ids.length===0){toast('「'+name+'」在当前视图没有可高亮的节点');return;}
  spotlightNodes(ids,name);
}
function switchAndSpot(name){
  if(!HOSTED)return;
  toast('「'+name+'」在任务视图未命中：正在切换到模块结构图…');
  var after=function(){
    fetchFeatures(false).then(function(){
      var data=FEATURES.data;
      if(!data)return;
      var f=null;
      (data.features||[]).forEach(function(entry){if(entry.name===name)f=entry;});
      if(!f)return;
      var ids=(f.nodes||[]).filter(function(id){return byId(id);});
      if(ids.length>0)spotlightNodes(ids,name);
    });
  };
  try{
    var p=doSwitchView('modules');
    if(p&&typeof p.then==='function')p.then(after,after);
    else after();
  }catch(e){after();}
}
/* 清除时机：Esc / 画布空白按下 / 切换视图 / 删除节点 / 重新分组（重新点击即替换） */
window.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&SPOT.active)clearSpotlight();
});
stage.addEventListener('pointerdown',function(e){
  if(!SPOT.active||e.button===2)return;
  var t=e.target;
  if(t&&t.closest){
    if(t.closest('.cf-node')||t.closest('.cf-link-hit')||t.closest('.cf-mini')||t.closest('.cf-zoomer')
      ||t.closest('.cf-menu')||t.closest('.cf-modal')||t.closest('.cf-banner')||t.closest('.cf-navpop')
      ||t.closest('.cf-nav')||t.closest('.cf-monitor')||t.closest('.cf-spotbox'))return;
  }
  clearSpotlight();
},true);
var switchViewFeaturesBase=switchView;
switchView=function(next){
  if(SPOT.active)clearSpotlight();
  return switchViewFeaturesBase(next);
};
var deleteSelFeaturesBase=deleteSel;
deleteSel=function(){
  var had=SPOT.active;
  var result=deleteSelFeaturesBase();
  if(had)clearSpotlight();
  return result;
};
/* 重渲染后恢复高亮 class / 虚线框（renderNodes/redrawLinks/applyView 链式包装） */
var renderNodesFeaturesBase=renderNodes;
renderNodes=function(){
  renderNodesFeaturesBase();
  applySpotClasses();
};
var redrawLinksFeaturesBase=redrawLinks;
redrawLinks=function(){
  redrawLinksFeaturesBase();
  applySpotLinkClasses();
  layoutSpotBox();
};
var applyViewFeaturesBase=applyView;
applyView=function(){
  applyViewFeaturesBase();
  layoutSpotBox();
};

/* ---- 详情弹窗：功能归属 chips（可增删，改动即 POST /api/features {op:'label'}） ---- */
var openDetailsFeaturesBase=openDetails;
openDetails=function(id){
  openDetailsFeaturesBase(id);
  if(!HOSTED)return;
  var n=byId(id);
  if(!n||!featuresProjectName())return;
  fetchFeatures(false).then(function(){
    if($('cf-modal').hidden||detailsNodeId!==id)return;
    injectFeatureChips(id);
  });
};
function injectFeatureChips(id){
  var d=$('cf-dialog');
  if(!d)return;
  var dbody=d.querySelector('.cf-dbody');
  if(!dbody)return;
  var old=dbody.querySelector('[data-frole="feature-row"]');
  if(old&&old.parentNode)old.parentNode.removeChild(old);
  var names=[];
  var data=FEATURES.data;
  if(data&&Array.isArray(data.features)){
    data.features.forEach(function(f){
      if((f.nodes||[]).indexOf(id)>=0)names.push(f.name);
    });
  }
  var row=document.createElement('div');
  row.className='cf-kv';
  row.setAttribute('data-frole','feature-row');
  var b=document.createElement('b');
  b.textContent='功能归属';
  row.appendChild(b);
  var span=document.createElement('span');
  var chips=document.createElement('div');
  chips.className='cf-fchips';
  names.slice(0,6).forEach(function(name){
    var chip=document.createElement('span');
    chip.className='cf-fchip';
    var label=document.createElement('span');
    label.textContent=name;
    var x=document.createElement('button');
    x.type='button';
    x.className='cf-fchip-x';
    x.textContent='×';
    x.setAttribute('aria-label','移除 '+name);
    x.addEventListener('click',function(){
      featureOpRequest('label',{nodeId:id,feature:name,remove:true},'已移除「'+name+'」归属');
    });
    chip.appendChild(label);
    chip.appendChild(x);
    chips.appendChild(chip);
  });
  var add=document.createElement('button');
  add.type='button';
  add.className='cf-fchip-add';
  add.textContent='+';
  add.setAttribute('aria-label','添加功能归属');
  add.addEventListener('click',function(){
    openPrompt('添加功能归属','功能名称','',function(v){
      featureOpRequest('label',{nodeId:id,feature:v},'已添加「'+v+'」归属');
    });
  });
  chips.appendChild(add);
  span.appendChild(chips);
  row.appendChild(span);
  var firstSec=dbody.querySelector('.cf-sec');
  if(firstSec)dbody.insertBefore(row,firstSec);
  else dbody.appendChild(row);
}
