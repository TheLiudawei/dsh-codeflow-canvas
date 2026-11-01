/* ================= v1.2.2：工作与报错日志（浏览器半边） =================
 * 画布是同源 iframe：浏览器侧异常、按钮失败、fetch 失败此前没有落盘通道。
 * 本补丁给画布加**一个**捕获阶段 click 监听 + 全局 error/rejection 钩子 +
 * 批量上报器（POST /codeflow/api/log，服务端白名单 + 限流）。
 *
 * 红线（任务书 §8.4）：
 *   - 不记录表单值、路径输入、提示词、图 JSON；project 名可以记录；
 *   - 控件标识只取 id/data-act/aria-label/文本（≤80 字符）；
 *   - data-cf-nolog="1" 的控件跳过；同一控件 300ms 内重复点击只记一次；
 *   - 队列 ≤200 条，500ms 或 20 条触发一次上报；序列化超 48 KiB 拆批；
 *     keepalive:true；失败静默丢弃并累计 dropped——绝不 toast、绝不重试风暴；
 *   - 页面卸载时 sendBeacon/fetch(keepalive) 冲一次；失败不阻塞卸载；
 *   - 日志关闭（CODEFLOW_LOG=off）时客户端照发、服务端丢弃；画布不读环境变量。
 * 所有动态文本一律 esc()，本补丁不渲染任何 UI。 */
var CFLOG={queue:[],dropped:0,timer:null,lastClick:{key:'',at:0},sending:false};

function cflogProject(){return (G&&G.project&&G.project.name)||null;}
function cflogControlOf(el){
  if(!el)return null;
  var label=(el.id?('#'+el.id):(el.getAttribute('data-act')?('@'+el.getAttribute('data-act')):''))
    ||el.getAttribute('aria-label')||String(el.textContent||'').trim();
  return String(label).slice(0,80)||'unnamed';
}
function cflogSurfaceOf(el){
  try{
    var mf=window.__CF_ACTION_MANIFEST__;
    if(Array.isArray(mf)){
      for(var i=0;i<mf.length;i++){
        var e=mf[i];
        if(e.id&&el.id===e.id)return e.surface;
        var act=el.getAttribute&&(el.getAttribute('data-act')||el.getAttribute('data-b'));
        if(e.selector&&act&&e.selector===('[data-act="'+act+'"]'))return e.surface;
      }
    }
  }catch(e){}
  return el&&el.closest&&el.closest('.cf-modal')?'dialog':(el&&el.closest&&el.closest('.cf-menu')?'menu':'canvas');
}
function cflogNow(){try{return Date.now();}catch(e){return 0;}}

function cflogPush(entry){
  if(CFLOG.queue.length>=200){CFLOG.dropped+=1;return;}
  CFLOG.queue.push(entry);
  if(CFLOG.queue.length>=20)cflogFlush();
  else if(!CFLOG.timer)CFLOG.timer=setTimeout(cflogFlush,500);
}

/* 点击后 0–300ms 内出现 modal/menu/toast 算「有可观察效果」（简化 outcome）。 */
function cflogOutcomeProbe(){
  var before={modal:!$('cf-modal').hidden,menus:document.querySelectorAll('.cf-menu').length,toasts:document.querySelectorAll('.cf-toast').length};
  return function(){
    var after={modal:!$('cf-modal').hidden,menus:document.querySelectorAll('.cf-menu').length,toasts:document.querySelectorAll('.cf-toast').length};
    var changed=before.modal!==after.modal||after.menus>before.menus||after.toasts>before.toasts;
    return changed?'ok':'noop';
  };
}

function cflogClick(e){
  var t=e.target;
  if(!t||!t.closest)return;
  var el=t.closest('button,[role="button"],[data-act],[data-cf-log]');
  if(!el)return;
  if(el.getAttribute&&el.getAttribute('data-cf-nolog')==='1')return;
  var control=cflogControlOf(el);
  var now=cflogNow();
  if(control===CFLOG.lastClick.key&&now-CFLOG.lastClick.at<300)return; // 双击去抖
  CFLOG.lastClick={key:control,at:now};
  var probe=cflogOutcomeProbe();
  setTimeout(function(){
    cflogPush({event:'ui.action',level:'info',data:{
      control:control,surface:cflogSurfaceOf(el),outcome:probe(),
      project:cflogProject(),view:CURVIEW,
    }});
  },0);
}

function cflogError(message,stack,extra){
  cflogPush({event:'ui.error',level:'error',data:Object.assign({
    control:null,message:String(message||'').slice(0,200),
    stack:typeof stack==='string'?String(stack).slice(0,600):undefined,
    project:cflogProject(),view:CURVIEW,
  },extra||{})});
  if(CFLOG.queue.length>=20)cflogFlush();
}

function cflogSerialize(){
  var batches=[[]],size=0;
  for(var i=0;i<CFLOG.queue.length;i++){
    var text='';
    try{text=JSON.stringify({events:[CFLOG.queue[i]]})||'';}catch(e){continue;}
    if(size+text.length>48*1024&&batches[batches.length-1].length>0){batches.push([]);size=0;}
    batches[batches.length-1].push(CFLOG.queue[i]);
    size+=text.length;
  }
  return batches;
}

function cflogFlush(){
  if(CFLOG.timer){clearTimeout(CFLOG.timer);CFLOG.timer=null;}
  if(CFLOG.sending)return;
  if(!CFLOG.queue.length)return;
  var batches=cflogSerialize();
  var first=batches.shift()||[];
  var rest=CFLOG.queue.slice(first.length);
  CFLOG.queue=rest;
  CFLOG.sending=true;
  var done=function(){CFLOG.sending=false;if(CFLOG.queue.length>=20)cflogFlush();};
  fetchT('/codeflow/api/log',{method:'POST',headers:{'content-type':'application/json'},cache:'no-store',keepalive:true,
    body:JSON.stringify({events:first})})
    .then(function(){done();})
    .catch(function(){CFLOG.dropped+=first.length;done();}); // 失败静默：不重试、不 toast
}

function initLogExtras(){
  /* 一个捕获阶段 click 监听（委托，不改任何既有控件）。 */
  document.addEventListener('click',cflogClick,true);
  window.addEventListener('error',function(e){
    cflogError(e&&e.message,e&&e.error&&e.error.stack,{source:e&&e.filename?String(e.filename).slice(-80):undefined,line:e&&e.lineno});
  });
  window.addEventListener('unhandledrejection',function(e){
    var r=e&&e.reason;
    cflogError((r&&(r.message||r))||'unhandled rejection',r&&r.stack,{source:'unhandledrejection'});
  });
  /* 页面卸载冲一次；失败不阻塞卸载。 */
  window.addEventListener('pagehide',function(){
    if(!CFLOG.queue.length)return;
    var batches=cflogSerialize();
    CFLOG.queue=[];
    for(var i=0;i<batches.length;i++){
      var body=JSON.stringify({events:batches[i]});
      try{
        if(navigator.sendBeacon&&navigator.sendBeacon('/codeflow/api/log',new Blob([body],{type:'application/json'})))continue;
      }catch(e){}
      try{fetch('/codeflow/api/log',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,body:body}).catch(function(){});}catch(e){}
    }
  });
}
