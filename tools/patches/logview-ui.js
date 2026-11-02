/* ================= v1.3.0：工作日志查看器（需求四） =================
 * 只读查看器：级别过滤（客户端过滤已取回的行，切换不重新请求）、搜索
 * （客户端大小写不敏感，只匹配 event/msg/data）、跟随尾部（贴底自动追加，
 * 上滚暂停 + 回到底部）、复制可见原始 JSONL 行、打开所在目录（501 时提示
 * 复制路径）。打开期间每 2 秒轮询（页面隐藏暂停）；关闭立即停止轮询。
 * 隐私红线：只读本地文件，无上传/分享/外发；日志内容一律 DOM API 渲染
 * （不用 innerHTML 拼接，日志里可能有 <）。 */
var LOGVIEW={open:false,timer:null,rows:[],level:'all',q:'',follow:true,fetchSeq:0};

function logviewStopPoll(){
  if(LOGVIEW.timer){clearInterval(LOGVIEW.timer);LOGVIEW.timer=null;}
}
function logviewFetch(){
  if(!LOGVIEW.open)return;
  if(document.visibilityState==='hidden')return; // 页面隐藏暂停轮询
  var seq=++LOGVIEW.fetchSeq;
  apiGet('/codeflow/api/log?tail=2000&rotated=0').then(function(res){
    if(!LOGVIEW.open||seq!==LOGVIEW.fetchSeq)return;
    if(!res||res.ok!==true)return;
    LOGVIEW.rows=Array.isArray(res.lines)?res.lines:[];
    var infoEl=$('cf-lv-file');
    if(infoEl){
      var sizeText=(res.size?(res.size/1024).toFixed(0)+' KB':'');
      infoEl.textContent='';
      infoEl.textContent='文件：'+String(res.path||'—')
        +(sizeText?' · '+sizeText:'')
        +(res.mtime?' · '+String(res.mtime).replace('T',' ').slice(0,19):'')
        +(res.truncated?' · 已截断（仅显示尾部）':'')
        +(res.invalidLines?(' · 跳过坏行 '+res.invalidLines):'');
    }
    logviewRenderRows();
  }).catch(function(){/* 轮询失败静默：下一轮再试 */});
}
function logviewStartPoll(){
  logviewStopPoll();
  LOGVIEW.timer=setInterval(logviewFetch,2000);
}
function logviewVisibleRows(){
  var q=LOGVIEW.q.trim().toLowerCase();
  var out=[];
  for(var i=0;i<LOGVIEW.rows.length;i++){
    var row=LOGVIEW.rows[i];
    if(LOGVIEW.level!=='all'&&row.level!==LOGVIEW.level)continue;
    if(q.length>0){
      var hay=(String(row.event||'')+' '+String(row.msg||'')).toLowerCase();
      var data=row.data;
      if(data!==undefined&&data!==null&&typeof data==='object'){
        for(var k in data){if(typeof data[k]==='string')hay+=' '+String(data[k]).toLowerCase();}
      }
      if(hay.indexOf(q)<0)continue;
    }
    out.push(row);
  }
  return out;
}
function logviewRenderRows(){
  var list=$('cf-lv-list');
  if(!list)return;
  list.textContent='';
  var rows=logviewVisibleRows();
  if(LOGVIEW.rows.length===0){
    var empty=document.createElement('div');
    empty.className='cf-lv-empty';
    empty.textContent='还没有日志文件，产生一次操作后再来看。';
    list.appendChild(empty);
    return;
  }
  if(rows.length===0){
    var none=document.createElement('div');
    none.className='cf-lv-empty';
    none.textContent='没有匹配的日志（调整级别过滤或搜索词）。';
    list.appendChild(none);
    return;
  }
  for(var i=0;i<rows.length;i++){
    var row=rows[i];
    var line=document.createElement('div');
    line.className='cf-lv-line lv-'+row.level;
    var time=document.createElement('span');
    time.className='cf-lv-time';
    time.textContent=String(row.ts||'').replace('T',' ').slice(11,19)||'—';
    var level=document.createElement('span');
    level.className='cf-lv-level lv-'+row.level;
    level.textContent=row.level.toUpperCase();
    var event=document.createElement('span');
    event.className='cf-lv-event';
    event.textContent=row.event;
    line.appendChild(time);
    line.appendChild(level);
    line.appendChild(event);
    if(row.msg!==undefined&&row.msg!==null&&String(row.msg).length>0){
      var msg=document.createElement('span');
      msg.className='cf-lv-msg';
      msg.textContent=String(row.msg);
      line.appendChild(msg);
    }
    if(row.data!==undefined&&row.data!==null){
      var data=document.createElement('span');
      data.className='cf-lv-data';
      var pairs=[];
      try{
        var keys=Object.keys(row.data);
        for(var j=0;j<keys.length&&j<6;j++){pairs.push(keys[j]+'='+JSON.stringify(row.data[keys[j]]));}
        if(keys.length>6)pairs.push('…');
      }catch(e){}
      data.textContent=pairs.join(' ');
      line.appendChild(data);
    }
    list.appendChild(line);
  }
  if(LOGVIEW.follow)list.scrollTop=list.scrollHeight;
}
function logviewApplyFilter(){
  var rows=logviewVisibleRows();
  var countEl=$('cf-lv-count');
  if(countEl)countEl.textContent=String(rows.length)+' / '+LOGVIEW.rows.length+' 行';
  logviewRenderRows();
}

function openLogViewer(){
  if(!HOSTED){toast('独立模式没有宿主日志','err');return;}
  LOGVIEW.open=true;
  LOGVIEW.level='all';
  LOGVIEW.q='';
  LOGVIEW.follow=true;
  var h=dHead('file-text','CodeFlow 工作日志')
    +'<div class="cf-dbody cf-lv-body">'
    +'<div class="cf-lv-fileline" id="cf-lv-file">读取中…</div>'
    +'<div class="cf-lv-bar">'
    +'<span class="cf-lv-levels" id="cf-lv-levels">'
    +'<button type="button" class="cf-btn mini" data-lv-level="all">全部</button>'
    +'<button type="button" class="cf-btn mini" data-lv-level="info">Info</button>'
    +'<button type="button" class="cf-btn mini" data-lv-level="warn">Warn</button>'
    +'<button type="button" class="cf-btn mini" data-lv-level="error">Error</button>'
    +'</span>'
    +'<input class="cf-in cf-lv-search" id="cf-lv-search" type="text" placeholder="搜索 event / msg / data…" aria-label="搜索日志">'
    +'<label class="cf-chk cf-lv-follow" style="display:flex;gap:5px;align-items:center;white-space:nowrap"><input type="checkbox" id="cf-lv-follow" checked> <span>跟随尾部</span></label>'
    +'<span class="cf-lv-count" id="cf-lv-count"></span>'
    +'</div>'
    +'<div class="cf-lv-bar">'
    +'<button type="button" class="cf-btn mini" data-lv="copy">复制可见行</button>'
    +'<button type="button" class="cf-btn mini" data-lv="reveal">打开所在目录</button>'
    +'<button type="button" class="cf-btn mini" data-lv="refresh">刷新</button>'
    +'<span class="cf-sechint" style="margin:0 0 0 auto">只读本地文件；不上传、不外发</span>'
    +'</div>'
    +'<div class="cf-lv-list" id="cf-lv-list" role="log" aria-label="日志行" tabindex="0"></div>'
    +'</div>'
    +'<div class="cf-dfoot"><button type="button" class="cf-btn" data-lv="bottom" hidden>回到底部</button>'
    +'<span style="flex:1"></span>'
    +'<button type="button" class="cf-btn cf-primary mini" data-act="close">关闭</button></div>';
  openModal(h);
  var d=$('cf-dialog');
  d.querySelector('[data-act="close"]').addEventListener('click',closeModal);
  d.querySelectorAll('[data-lv-level]').forEach(function(btn){
    btn.addEventListener('click',function(){
      LOGVIEW.level=btn.getAttribute('data-lv-level');
      d.querySelectorAll('[data-lv-level]').forEach(function(b){b.classList.toggle('cf-primary',b===btn);});
      logviewApplyFilter();
    });
  });
  d.querySelector('[data-lv-level="all"]').classList.add('cf-primary');
  var search=d.querySelector('#cf-lv-search');
  search.addEventListener('input',function(){LOGVIEW.q=String(search.value||'');logviewApplyFilter();});
  var follow=d.querySelector('#cf-lv-follow');
  follow.addEventListener('change',function(){LOGVIEW.follow=follow.checked;if(LOGVIEW.follow)logviewRenderRows();});
  d.querySelector('[data-lv="copy"]').addEventListener('click',function(){
    var rows=logviewVisibleRows();
    if(!rows.length){toast('没有可复制的日志行');return;}
    /* 复制可见行的**原始 JSONL**（一行一条，便于贴 issue）。 */
    var text=rows.map(function(row){return JSON.stringify(row);}).join('\n');
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){toast('已复制 '+rows.length+' 行原始 JSONL','ok');},function(){toast('复制失败：请手动选择复制','err');});
    }else{toast('当前环境不支持自动复制','err');}
  });
  d.querySelector('[data-lv="reveal"]').addEventListener('click',function(){
    apiPost('log/reveal',{kind:'item'}).then(function(res){
      toast('已在文件管理器中定位日志','ok');
    }).catch(function(err){
      toast((err&&err.message)||'当前宿主不支持打开目录；请复制上面的路径手动查看','err');
    });
  });
  d.querySelector('[data-lv="refresh"]').addEventListener('click',function(){logviewFetch();});
  var bottom=d.querySelector('[data-lv="bottom"]');
  bottom.addEventListener('click',function(){LOGVIEW.follow=true;follow.checked=true;logviewRenderRows();bottom.hidden=true;});
  var list=d.querySelector('#cf-lv-list');
  list.addEventListener('scroll',function(){
    var atBottom=list.scrollTop+list.clientHeight>=list.scrollHeight-24;
    if(!atBottom&&LOGVIEW.follow){LOGVIEW.follow=false;follow.checked=false;bottom.hidden=false;}
    else if(atBottom&&!LOGVIEW.follow){LOGVIEW.follow=true;follow.checked=true;bottom.hidden=true;}
  });
  /* 禁用级别按钮在「日志关闭/读取失败」时的空态文案由 fetch 结果渲染。 */
  logviewFetch();
  logviewStartPoll();
}
/* 关闭 modal（含 Esc / ✕ / 遮罩点击）立即停止轮询、清空定时器。 */
var closeModalLogviewBase=closeModal;
closeModal=function(){
  logviewStopPoll();
  LOGVIEW.open=false;
  closeModalLogviewBase();
};
