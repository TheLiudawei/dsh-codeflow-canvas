/* ================= v1.5.0：任务节点（自由要求）+ 运行后自动识别 =================
 * 「先写要求、执行完由宿主自动认出类型」的画布半边。本补丁只做四件事：
 *   1. typeOf = 「显示类型 + 结构档案」的唯一合并点：meta.cf.task===true 的
 *      节点，label/color/cat/desc/宽取识别后的真实类型，端口与控件**永远**
 *      取 TYPES.task 档案（any→any）——这是「识别后连线不错位」的根。
 *      渲染、连线、详情、复制等处一律不写 if(task)，全从这里无感获得。
 *   2. 任务徽章：未识别「任务」/ 已识别显示类型标签 / 手动锁定「手动」。
 *   3. 详情扩展（包装 openDetails，只对任务节点生效）：类型来源、识别依据
 *      （reason → 人话摘要的唯一映射表在本文件）与可编辑的「要求」文本框。
 *   4. 右键类型管理：自动识别（宿主 POST /api/node-type 重识别）/ 设置类型
 *      （手动 + 锁定）/ 清除类型（回 task）。选择器 openTypePicker 由
 *      port-canvas.mjs 锚点注入；添加入口收敛在 openTaskDialog。
 * 识别本体是宿主的纯脚本（lib/typing/*，零 LLM）；画布绝不猜类型。
 * 所有动态文本一律 esc()/textContent，禁止拼接未转义 HTML。 */

/* reason → 人话摘要（唯一映射表；「识别依据」展示只走这里，不要在别处现写文案） */
var TASK_REASON_TEXT={
  'testrun-command':'运行了测试命令，未改动文件',
  'shell-command':'运行了普通命令，未改动文件',
  'edit-existing-code':'修改了既有代码',
  'codegen-new-code':'新建了代码',
  'testgen-tests':'新增/修改了测试',
  'docgen-docs':'新增/修改了文档'
};
function taskReasonSummary(auto){
  if(!auto||typeof auto.reason!=='string')return '';
  var base=TASK_REASON_TEXT[auto.reason]||'';
  if(!base)return '';
  var c=(auto.counts&&typeof auto.counts==='object')?auto.counts:{};
  var added=Number(c.added)||0,modified=Number(c.modified)||0,deleted=Number(c.deleted)||0;
  if(auto.reason==='edit-existing-code'&&(modified+deleted)>0)return '修改了 '+(modified+deleted)+' 个文件';
  if(auto.reason==='codegen-new-code'&&added>0)return '新建了 '+added+' 个代码文件';
  if((added+modified+deleted)>0)return base+'（新增 '+added+' · 修改 '+modified+' · 删除 '+deleted+'）';
  return base;
}

/* typeOf 合并点（v1.5.0）：识别只影响外观，结构档案恒为 task。 */
typeOf=function(n){
  var display=TYPES[n&&n.type]||{label:(n&&n.type)||'未知',cat:'input',color:'#64748b',w:240,ins:[],outs:[],widgets:[]};
  var cf=n&&n.meta&&n.meta.cf;
  if(cf&&cf.task===true){
    return {label:display.label,cat:display.cat,color:display.color,w:display.w,desc:display.desc,
      ins:TYPES.task.ins,outs:TYPES.task.outs,widgets:TYPES.task.widgets};
  }
  return display;
};

/* 节点头部徽章（buildNode 注入 taskBadgeHtml(n) 调用） */
function taskBadgeHtml(n){
  var cf=n&&n.meta&&n.meta.cf;
  if(!cf||cf.task!==true)return '';
  if(cf.typeLocked===true)return '<span class="cf-taskbadge manual">手动</span>';
  if(cf.typeAuto&&cf.typeAuto.type){
    var t=TYPES[cf.typeAuto.type];
    return '<span class="cf-taskbadge auto">'+esc(t?t.label:cf.typeAuto.type)+'</span>';
  }
  return '<span class="cf-taskbadge">任务</span>';
}

/* 本地改类型（手动锁定语义；自动识别由宿主写图后经 refreshLatestSoon 采纳，
   画布绝不自己伪造识别结果——手动设置的 typeAuto 不带 reason/counts） */
function applyNodeType(n,type,how){
  if(!n||!TYPES[type])return;
  n.type=type;
  n.meta=n.meta||{};
  var cf=n.meta.cf=n.meta.cf||{};
  if(how&&how.locked)cf.typeLocked=true;
  else delete cf.typeLocked;
  cf.typeAuto={v:1,type:type,by:(how&&how.by)||'manual',at:new Date().toISOString()};
  renderNodes();redrawLinks();markSel();saveState(true);
}

/* 右键「设置类型…」：类型选择器（openTypePicker），选中即锁定 */
function setNodeType(id){
  var n=byId(id);if(!n)return;
  openTypePicker({title:'设置类型',autoLabel:'自动识别（推荐）',allowAuto:true,onPick:function(type){
    if(type==='__auto__'){autoIdentifyType(id);return;}
    applyNodeType(n,type,{by:'manual',locked:true});
    toast('已手动设置类型并锁定：自动识别不再覆盖','ok');
  }});
}

/* 右键「清除类型」：回 task，删 typeAuto/typeLocked（结构标记 meta.cf.task 保留） */
function clearNodeType(id){
  var n=byId(id);if(!n)return;
  var cf=n.meta&&n.meta.cf?n.meta.cf:null;
  if(n.type==='task'&&!(cf&&(cf.typeAuto||cf.typeLocked))){toast('已经是「任务」，无需清除');return;}
  n.type='task';
  if(cf){delete cf.typeAuto;delete cf.typeLocked;}
  renderNodes();redrawLinks();saveState(true);
  toast('已清除类型，回到「任务」','ok');
}

/* 右键「自动识别」：清锁 → 请求宿主按最近一次运行的证据重识别（零 LLM）。
   宿主没有可用证据时回 task 并提示「下次运行后自动识别」——画布不猜。 */
function autoIdentifyType(id){
  var n=byId(id);if(!n)return;
  if(!HOSTED){toast('独立模式没有宿主识别','err');return;}
  var cf=n.meta&&n.meta.cf?n.meta.cf:null;
  if(cf&&cf.typeLocked===true){delete cf.typeLocked;saveState(true);}
  toast('正在请求宿主重新识别…');
  apiPost('node-type',{project:G.project&&G.project.name,view:CURVIEW,nodeId:id,mode:'auto'}).then(function(res){
    if(res&&res.applied===true){
      refreshLatestSoon();
      var t=TYPES[res.type];
      toast('已识别为「'+(t?t.label:res.type)+'」','ok');
      return;
    }
    n.type='task';
    if(cf)delete cf.typeAuto;
    renderNodes();redrawLinks();saveState(true);
    toast('暂无可用的识别证据：下次运行后自动识别');
  }).catch(function(err){
    toast('识别失败：'+((err&&err.message)||err),'err');
  });
}

/* 详情弹窗扩展：包装 ACTIVITY_JS 的 openDetails，只对任务节点追加内容。
   失败静默降级——基础详情永远可用。 */
var openDetailsTaskBase=openDetails;
openDetails=function(id){
  openDetailsTaskBase(id);
  try{
    var n=byId(id);
    if(!n)return;
    var cf=n.meta&&n.meta.cf;
    if(!cf||cf.task!==true)return;
    var d=$('cf-dialog');
    var body=d.querySelector('.cf-dbody');
    if(!body)return;
    /* 类型行：追加来源（自动识别 / 手动设置 / 未识别） */
    var rows=body.querySelectorAll('.cf-kv');
    var typeRow=null;
    for(var i=0;i<rows.length;i++){
      var b=rows[i].querySelector('b');
      if(b&&b.textContent==='类型'){typeRow=rows[i];break;}
    }
    if(typeRow){
      var span=typeRow.querySelector('span');
      if(span){
        var src=cf.typeAuto?(cf.typeLocked===true?'手动设置':'自动识别'):'未识别（保持任务）';
        span.textContent=span.textContent+' · '+src;
      }
      /* 识别依据：reason 摘要 + 最多 3 个样例路径（宿主已限界） */
      var sum=taskReasonSummary(cf.typeAuto);
      if(sum){
        var kv=document.createElement('div');
        kv.className='cf-kv';
        var sample=(cf.typeAuto&&Array.isArray(cf.typeAuto.sample)&&cf.typeAuto.sample.length)?('：'+cf.typeAuto.sample.join('、')):'';
        kv.innerHTML='<b>识别依据</b><span></span>';
        kv.querySelector('span').textContent=sum+sample;
        typeRow.parentNode.insertBefore(kv,typeRow.nextSibling);
      }
    }
    /* 要求编辑区：params.requirement 是用户要求的唯一权威 */
    var actSec=$('cf-act-sec');
    var sec=document.createElement('div');
    sec.className='cf-sec cf-reqedit';
    sec.innerHTML='<div class="cf-sec-title">要求（识别不得改写它）</div>'
      +'<textarea class="cf-in" rows="3" id="cf-req-edit" aria-label="任务要求"></textarea>'
      +'<div class="cf-sechint">执行按当前要求真实进行；回合结束后宿主自动写入类型。</div>'
      +'<div><button type="button" class="cf-btn mini" data-act="save-req" disabled>保存要求</button></div>';
    if(actSec)actSec.parentNode.insertBefore(sec,actSec);
    else body.appendChild(sec);
    var ta=sec.querySelector('#cf-req-edit');
    ta.value=String((n.params&&n.params.requirement)||'');
    var saveBtn=d.querySelector('[data-act="save-req"]');
    var syncSave=function(){saveBtn.disabled=String(ta.value||'').trim().length===0;};
    syncSave();
    ta.addEventListener('input',syncSave);
    saveBtn.addEventListener('click',function(){
      var v=String(ta.value||'').trim();
      if(!v){toast('要求不能为空','err');return;}
      n.params=n.params||{};
      n.params.requirement=v;
      saveState(true);
      toast('要求已保存','ok');
    });
  }catch(e){/* 详情扩展失败不影响基础详情 */}
};
