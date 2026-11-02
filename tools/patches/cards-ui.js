/* ================= v1.3.0：任务卡片持久化（画布半边，需求三） =================
 * 职责（全部经 HTTP API，绝不直接读 config.json / 图文件）：
 *   - 首次询问（默认关闭；按工作区 asked 记忆；✕ 等同「暂不开启」）；
 *   - 失效卡片标记（meta.cf.stale → 徽章「源码中已不存在」，不用大块红色）；
 *   - 运行守卫：失效卡片不参与「运行全部」（宿主 gestures 已过滤）、单节点
 *     运行在画布侧直接提示；
 *   - 「清理失效卡片…」（项目菜单；唯一删除路径，二次确认）。
 * 状态经 setActionState 广播（menu-ui.js）。合并本身在宿主 lib/cards/merge.js。 */
var CARDS={persist:false,asked:false};

function isStaleCard(n){return !!(n&&n.meta&&n.meta.cf&&n.meta.cf.stale===true);}
/* 参数漂移：只在「仍待运行」时提示——重跑后状态变成 running/done，徽章自然消失，
   不会出现「刚跑完还写着需重跑」的自相矛盾。 */
function isDriftCard(n){
  var cf=n&&n.meta&&n.meta.cf;
  if(!cf||cf.paramsDrift!==true||cf.stale===true)return false;
  return n.status===undefined||n.status==='pending';
}
function staleCardCount(){var n=0;for(var i=0;i<G.nodes.length;i++){if(isStaleCard(G.nodes[i]))n++;}return n;}

/* 状态广播：清理动作的可用性 + 失效标记重绘。 */
function updateCardsState(){
  var count=staleCardCount();
  setActionState('cards:cleanup-stale',{disabled:!(CARDS.persist&&count>0),
    title:CARDS.persist?('清理 '+count+' 张失效卡片'):'开启卡片持久化并出现失效卡片后可用'});
  applyStaleMarks();
}

function applyStaleMarks(){
  for(var i=0;i<G.nodes.length;i++){
    var n=G.nodes[i];
    var el=nodeEls[n.id];
    if(!el)continue;
    var stale=isStaleCard(n);
    var drift=isDriftCard(n);
    el.classList.toggle('cf-stale-card',stale);
    el.classList.toggle('cf-drift-card',drift);
    var head=el.querySelector('.cf-node-head');
    var badge=head?head.querySelector('.cf-stale-badge'):null;
    if(stale&&head){
      if(!badge){
        badge=document.createElement('span');
        badge.className='cf-stale-badge';
        head.appendChild(badge);
      }
      badge.textContent='源码中已不存在';
      badge.title='失效卡片：重新导入时源码里已没有对应项；不参与「运行全部」。可在「项目」菜单清理。';
    }else if(badge&&badge.parentNode){
      badge.parentNode.removeChild(badge);
    }
    /* v1.3.1：参数漂移（源码已变）——状态已退回待运行，这里给出原因。 */
    var driftBadge=head?head.querySelector('.cf-drift-badge'):null;
    if(drift&&head){
      if(!driftBadge){
        driftBadge=document.createElement('span');
        driftBadge.className='cf-drift-badge';
        head.appendChild(driftBadge);
      }
      driftBadge.textContent='源码已变，需重跑';
      driftBadge.title='该卡片的源文件在重新导入后发生了变化，之前的运行结果已过期；已退回「待运行」，可重新运行。';
    }else if(driftBadge&&driftBadge.parentNode){
      driftBadge.parentNode.removeChild(driftBadge);
    }
  }
}
var renderNodesCardsBase=renderNodes;
renderNodes=function(){renderNodesCardsBase();applyStaleMarks();};

/* 单节点运行守卫：失效卡片直接提示（宿主 gestures 也有同样守卫，双保险）。 */
var runNodeCardsBase=runNode;
runNode=function(id,rerun){
  if(isStaleCard(byId(id))){
    toast('失效卡片（源码中已不存在）不能运行；可从「项目」菜单清理，或直接删除该卡片','err');
    return;
  }
  runNodeCardsBase(id,rerun);
};

/* 清理失效卡片：二次确认、列数量；确认后从图中删除并保存。 */
function cleanupStaleCards(){
  if(!CARDS.persist){toast('先在设置里开启「重新导入时保留任务卡片」','err');return;}
  var count=staleCardCount();
  if(count===0){toast('没有失效卡片');return;}
  openConfirm('清理失效卡片','将从图中删除 '+count+' 张「源码中已不存在」的卡片（不影响磁盘文件）。确定继续？',function(){
    G.nodes=G.nodes.filter(function(n){return !isStaleCard(n);});
    sel={type:null,id:null};
    renderAll();
    saveState(true);
    updateCardsState();
    toast('已清理 '+count+' 张失效卡片','ok');
  });
}

/* 首次询问：只弹一次（asked 按工作区记忆）；默认不开启；失败不写 asked。 */
function maybeAskCardsPersist(){
  if(!HOSTED)return;
  apiGet('/codeflow/api/config').then(function(cfg){
    if(!cfg||cfg.ok!==true)return;
    CARDS.persist=cfg.cards&&cfg.cards.persist===true;
    CARDS.asked=cfg.cards&&cfg.cards.asked===true;
    updateCardsState();
    if(CARDS.asked)return;
    openCardsAskDialog();
  }).catch(function(){/* 配置读不到：画布照常可用；稍后可在设置里开启 */});
}
function saveCardsChoice(persist){
  apiPost('config',{cards:{persist:persist,asked:true}}).then(function(res){
    closeModal();
    CARDS.persist=res&&res.cards&&res.cards.persist===true;
    CARDS.asked=true;
    updateCardsState();
    if(CARDS.persist)toast('已开启：重新导入将保留任务卡片','ok');
  }).catch(function(){
    closeModal();
    toast('设置未保存，稍后可在设置里开启','err');
  });
}
function openCardsAskDialog(){
  var h=dHead('file-plus-2','把任务卡片保存在项目里？')
    +'<div class="cf-dbody">'
    +'<div class="cf-hintbox">开启后，重新导入同一项目会保留卡片的<b>运行状态、结果、画布位置</b>和你改过的标题/参数；'
    +'源码里已删除的任务会保留为「失效卡片」（不参与运行，可从「项目」菜单一键清理）。</div>'
    +'<div class="cf-hintbox">关闭时每次导入都会重建卡片（旧图自动备份为 .bak-时间）。数据只保存在本地项目目录，不上传。</div>'
    +'</div>'
    +'<div class="cf-dfoot"><button type="button" class="cf-btn" data-act="cancel">暂不开启</button>'
    +'<button type="button" class="cf-btn cf-primary" data-act="confirm">开启并继续</button></div>';
  openModal(h);
  var d=$('cf-dialog');
  d.querySelector('[data-act="cancel"]').addEventListener('click',function(){saveCardsChoice(false);});
  d.querySelector('[data-act="confirm"]').addEventListener('click',function(){saveCardsChoice(true);});
  /* 右上角 ✕ 等同「暂不开启」（任务书 §6.6）；委托的 closeModal 幂等。 */
  var x=d.querySelector('.cf-dclose');
  if(x)x.addEventListener('click',function(){saveCardsChoice(false);});
}

function initCardsExtras(){
  if(!HOSTED)return;
  maybeAskCardsPersist();
}
