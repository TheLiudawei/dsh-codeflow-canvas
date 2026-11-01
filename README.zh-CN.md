# dsh-codeflow-canvas

ComfyUI 风格的编程工作流画布，DSH 版。
**节点 = agent 可执行的开发任务，连线 = 依赖与数据流。** 你在画布上编排，agent 在工作区真实执行并把结果回填。

[English](README.md) | 简体中文

本包是 ZCode 插件 `codeflow-canvas` v0.2.2 的迁移版（**v0.6.0**）：画布编辑器本身沿用原实现，
与宿主的接线全部重写以适配 DSH。v0.5.0 新增：**原生交付卡片（present）、每项目专用会话、
实时执行过程（思考流/步骤/进度）、按次运行的撤销快照**。
v0.5.1 修复：整图回填改为**首选"改图文件 + `codeflow_canvas` `mode:"load"`"**，
整图 JSON 不再经由工具参数搬运（超长嵌套 JSON 会触发模型工具调用
`tool input is invalid JSON` → 整回合 `MALFORMED_RESPONSE`，且该错误不在宿主默认重试码表内）。
v0.6.0 新增：**双视图（导入一次同时生成任务流水线与模块结构图，工具栏随时切换）、
agent 修改代码时高亮所属模块（依据真实写文件工具调用）、左侧导航可搜索的二级列表**。
v1.0.1 修复与升级：**「测试运行」真实执行（自包含运行请求 + 回合结束对账 + 一键重试）、
画布四边贴满面板、项目迁入 `<工作区>/CodeFlow/`（根目录可自定义，旧数据自动迁移）**。
v1.2.0 新增：**模块耦合分析（文件级模块打低/中/高耦合标签、左上角整体「屎山程度」卡片、
全部纯宿主计算零 token）与拖拽导入（把文件夹/压缩包拖进画布即导入，zip/tar 纯 Node 解析、
7z/rar 用系统工具降级）**。

## 它长什么样

左侧栏多一个 **CodeFlow（⬡）** 图标，点开是整屏画布：

- **双视图**：导入一次同时生成任务流水线（`workflow.json`）与模块结构图（`workflow.modules.json`），
  工具栏分段控件 `[ 任务流水线 12 ] [ 模块结构图 28 ]` 随时切换——不重扫、不重分析、不唤醒 agent，
  两个视图的节点、坐标、运行状态、rev 完全独立；单视图项目自动隐藏切换控件
- **修改高亮**：agent 真实编辑了哪个文件（从 edit/write/ops_replace/apply_patch 等写文件工具调用的参数
  中提取路径，绝不从对话文本猜测），模块视图就高亮对应文件级模块（修改中=琥珀脉冲，完成=15 秒静态标记），
  任务视图的相关任务加虚线标记，活动行显示"修改 src/foo.ts"
- **右键空白画布**：新建项目（agent 按需求生成初版代码 + 流水线）、导入项目（一次扫描同时生成两张图）、
  添加节点（16 种，可搜索）、整理布局、适应视图、运行全部、撤销运行、保存、清空、帮助
- **节点交互**：拖动、连线（端口类型校验：text/json/code/report/file/any）、右键运行/重跑/详情/复制/重命名/删除、
  参数编辑（改动自动重置下游）、双击看详情、Delete 删除选中
- **执行过程可见**：运行时节点卡片上有一行"当前动作/思考摘录 + 步骤数 + 耗时"；右上角出现可折叠的
  执行监视器（整体 N/M、当前节点、最新一行思考）；详情弹窗里有完整"执行过程"（思考流 + 工具时间线），
  拿不到真实 reasoning 时自动降级为步骤摘要，**绝不伪造**
- **原生交付**：`deliver` 节点运行时收集上游真实产出、写 `docs/DELIVERY.md`、调用 DSH 原生 `present`
  工具——会话里出现交付卡片，点卡片在右侧栏预览，原生控件可打开默认程序 / 在文件夹中显示；
  画布只列交付物清单，不做内嵌预览器
- **专用会话**：每个项目一个持久绑定的画布会话（标题 `CodeFlow · <项目>`），画布的运行只进该会话；
  状态栏显示入口，点击可打开/复制 ID/新建；不自动切换 DSH 当前会话
- **撤销运行**：每次运行前自动快照项目源码树；工具栏"撤销运行"可整次回退（文件 + 节点状态），
  撤销前自动备份当前状态，DSH 重启后仍可撤销，只能 LIFO
- **模块导航**：左侧一排模块选项卡（输入/方案/构建/执行/质检/输出），带实时计数；
  分类下 ≥2 个节点时点击弹出**可搜索的二级浮层**（按模块名/路径过滤、↑/↓/Enter 键盘导航、
  选中后缩放定位并高亮），只有 1 个节点时直接定位
- **持久化**：画布编辑自动落盘到 `<工作区>/CodeFlow/flow-projects/<项目名>/workflow.json`（任务流水线）与
  `workflow.modules.json`（模块结构图）；激活视图记忆在 `view.json`，重启后回到上次的视图与缩放。
  项目根目录可在画布工具栏 ⚙ 设置里自定义（全局根 + 单项目覆盖），旧 `flow-projects/` 数据
  首次启动自动迁移到新根
- **深/浅色**：跟随 DSH 当前主题（切换时画布即时同步，不重载、不丢视图）

## 安装

```bash
# 本地目录安装（不需要构建）
dsh plugin --profile desktop add link:<本目录绝对路径>
```

或在「设置 → 插件」里安装本地目录。装完 **重启 DSH**（Host 半侧不参与热重载），刷新页面。

> 装完怎么确认激活了？`curl http://127.0.0.1:<端口>/codeflow/canvas` 应返回 200 的 HTML；
> 404 且 `profiles/<profile>` 下 grep 不到 `codeflow` 说明插件没装进该 profile —— 重新执行
> 上面的 `dsh plugin --profile <名字> add link:<路径>` 并重启（实测报告 B1 即为此情况，不是代码问题）。

`package.json` 里没有任何 `@deepseek-ai/*` 依赖，也不做构建：`lib/index.js` 是普通 ESM，
`lib/client.js` 是手写的 `__ModuleLoader__` bundle（照 `templates/decoration` 的官方格式）。

## 用法

| 入口 | 作用 |
| --- | --- |
| `/flow` | 打开画布（自动载入最近的项目）；带参数时按新需求建项目 |
| `/flow-new [需求]` | 直接新建项目 |
| `/flow-import <路径>` | 导入项目：**宿主直接扫描，一次同时生成任务流水线与模块结构图，不经过 agent（零 token，秒级）**；路径支持 `@` 选择、`~`、引号与 `file://`；`--modules` 仅为兼容别名 |
| `codeflow_canvas` 工具 | agent 用它**回填图（`load`：从磁盘重读对应视图的图文件，首选）**、推图（`render`，后备，只替换目标视图）、读图（`read`）、落盘（`save`，双视图都落）、**回报进度（`progress`，仅专用会话可调）**；参数 `view:"tasks"\|"modules"` 指明视图 |
| 技能 `codeflow-canvas` | agent 的编排大脑（新建/运行/回填/交付语义），`/flow*` 会自动带上 |
| `node lib/importer.js <路径>` | 命令行独立导入：一次生成 `workflow.json` + `workflow.modules.json`，不需要 DSH 在跑 |

## 架构

```
浏览器（面板 iframe）
  ├── GET  /codeflow/canvas        ← 宿主组装：画布片段 + __CF_BOOT__（当前视图图、activeView、两视图可用性）
  ├── GET  /codeflow/api/state     ← 轮询（?view= 指定视图），rev 变大就整图刷新
  ├── POST /codeflow/api/state     ← 编辑自动暂存（按视图落盘，响应带 persisted/error；带 expectedRev 冲突检测）
  ├── POST /codeflow/api/view      ← 切换激活视图（写 view.json，不 bump rev、不扫描、不唤醒 agent）
  ├── POST /codeflow/api/save      ← "保存"按钮：宿主直接落盘（双视图都落），不打扰 agent（失败 507 + ok:false）
  ├── POST /codeflow/api/import    ← "导入项目"：宿主确定性扫描（lib/duo.js 一次生成两张图），不打扰 agent
  ├── POST /codeflow/api/coupling  ← v1.2 耦合分析：算节点耦合 + 整体"屎山程度"，写两张图（零 LLM）
  ├── GET  /codeflow/api/coupling  ← v1.2 过期判定（mtime 探测，10s 缓存，≤300 文件）
  ├── POST /codeflow/api/drop/*    ← v1.2 拖拽导入：begin/file/finalize/abort 上传通道 + path 就地通道
  ├── POST /codeflow/api/action    ← 运行/新建：快照（RUN_*，按视图）→ 专用会话投递 [CodeFlow:*]（带 view+graphPath）
  ├── POST /codeflow/api/session   ← 新建/重建项目的专用会话
  ├── GET  /codeflow/api/activity  ← 实时思考流/步骤/进度/文件编辑记录（纯内存，700–1000ms 增量拉取）
  ├── GET  /codeflow/api/undo      ← 运行历史（newest first，标注视图）
  └── POST /codeflow/api/undo      ← dryRun 预检 / 整次恢复（LIFO，跨视图共用）
                                        ↓
             agent 按技能执行 → 调 codeflow_canvas（render/progress，带 view）
                                        ↓
   store（每个视图独立的 rev 持有者）
     + CodeFlow/flow-projects/*/workflow.json + workflow.modules.json + view.json
     + sessions.js（专用会话绑定）
   activity.js（内存过程缓冲 + 编辑表）+ undo.js（.undo/ 快照与恢复）
```

关键取舍：

1. **画布跑在 iframe 里**。画布在 window 上挂了 `keydown`（Delete 删节点、空格平移）与 pointer 监听，
   放进宿主文档会抢走输入框的按键。iframe 同时让它 100% 复用原实现。
2. **画布不再由 agent 生成**。agent 只提交图 JSON 与进度，宿主负责组装文档与落盘。
3. **`rev` 归宿主管，按视图独立**。面板与 agent 都写同一份状态，宿主每次接受写入就在**目标视图**上自增一次；
   面板只在自己没参与时采纳新版本，避免互相覆盖。节点执行中的增量更新走
   `store.patchNode`（单节点、白名单字段、按视图），整图回填走"agent 改图文件 +
   `mode:"load"`"，两者都不需要把整图塞进工具参数（`render` 只是后备）。
   写一个视图永远不会 bump 另一个视图的 `rev`，所以在任务图里编辑不会被模块图的后台更新打断。
4. **消息里不放整图**。`[CodeFlow:*]` 携带 `view` 与 `graphPath`（指向该视图的图文件），
   agent 读文件拿精确状态，大图不会污染对话。
5. **路由过宿主的安全闸**。`/codeflow` 能往会话里注入 prompt，所以和其它 GUI 路由一样要求
   宿主签名的浏览器 cookie（`connection.requestRejection`）；同源 iframe 自带这个 cookie。
6. **会话绑定只有一个写者**。`lib/sessions.js` 是唯一的绑定管理者：工具 render 不再抢绑定，
   `/flow` 在任意会话执行都不会改写项目的专用会话；没有 `sessionController` 的极简组合会明确降级，
   绝不回退到"最新的会话"。
7. **过程数据只存内存**。思考流、工具调用、percent 只进 `lib/activity.js` 的环形缓冲
   （每项目 ≤500 条 / 256 KB，单条 ≤4 KB），不落盘、不进日志；`turn/end` 时仍为 running 的节点
   会被宿主置 `failed`，画布不会永久转圈。
8. **撤销以"次"为单位**。`lib/undo.js` 在投递前对项目源码树做快照；恢复时先备份当前状态，
   且只触碰快照候选范围——`node_modules`/`dist`/`.git` 里的改动永远不会被误删。

## v1.2.0 的两项升级（全部零 LLM、零 npm 依赖、可离线）

### A. 模块耦合分析（屎山程度）

- **入口**：文件级模块节点右键「分析耦合」（只分析该文件）；空白画布右键「分析全部耦合」；
  工具栏「耦合分析」按钮（任务视图下点击同样执行——宿主始终分析模块图，然后刷新当前视图的卡片）；
  导入项目完成后自动跑一次「全部」。
- **节点标签**：节点头部状态徽章左侧出现小胶囊 `耦合 · 低|中|高`（绿 `#22c55e` / 黄 `#eab308` /
  红 `#ef4444`，浅色主题文字加深一档），卡片右缘一条 3px 颜色提示；不改节点尺寸与端口位置。
- **左上角卡片**：`屎山程度 · 中`（大字 + 颜色点）+ `模块 12 · 平均 42 · 环 2`；部分结果时追加
  `· 已分析 3/12`；过期时追加 `· 可能过期`（整体降饱和）。点击卡片打开详情弹窗：
  整体结论 + 模块表格（按分数降序，列：模块/等级/分数/扇入 Ca/扇出 Ce/环/内部引用/符号）+
  根目录、分析时间、解析受限文件数 + 「重新分析」。
- **算法（附录化在 `lib/coupling.js` 顶部，全部常量可导出测试）**：
  `score = round(0.6×intra + 0.4×inter)`，intra 是文件内符号互引图（边数/密度/最大扇出/符号环），
  inter 是模块依赖图（扇入扇出/传递闭包/SCC 缩点后深度/成环/第三方 import 数），饱和函数
  `sat(x,max)=min(1, log1p(x)/log1p(max))`；等级阈值固定 30/60。整体 = 行数加权的模块均分
  + `min(15, 3×成环文件数)`。同一份源码两次分析结果逐字节一致（时间戳不参与评分）。
- **持久化**：节点级 `node.coupling` 只写模块图；整体结论 `meta.coupling` 模块图写全量、
  任务图**只镜像这一个键**（带 `source:"modules"`）。宿主按白名单清洗（未知键丢弃、数值夹紧、
  ≤800 字节），旧图（无这些字段）打开与写回**字节不变**。
- **过期（stale）不落盘**：`GET /api/coupling` 对每个有结果的节点 stat 一次源文件
  （10 秒缓存，最多 300 个文件），`mtime` 晚于分析时间或模块数量漂移 → 该节点徽章虚线灰化、
  卡片「可能过期」；不自动重算，给「重新分析」按钮。
- **失败语义**：没有模块图 → 400 +「当前项目没有模块结构图，请先导入项目」（按钮置灰）；
  源文件被删 → 该节点标签清除、计入 skipped、整体 partial；解析不出的语言按行数/体积给弱结论
  并注明「解析受限」，绝不伪造精确数字。

### B. 拖拽导入（文件夹 / 压缩包）

- **交互**：拖入画布出现全屏虚线遮罩「松开导入项目（文件夹 / zip / tar / tar.gz / 7z / rar）」→
  松手后先本地预检（类型/数量/大小，不合法直接 toast 不弹框）→ 确认框（类型/名称/文件数/大小、
  目标提示、可编辑项目名、递归深度、注释任务与补测试开关、记住选项）→ 进度弹窗
  （准备 → 上传 N/M · 字节 → 解压 → 分析，可取消）→ 完成后自动打开新项目（任务视图）+
  自动耦合 + toast 摘要。一次拖入多个条目只处理第一个。
- **两条通道**：画布 iframe 里拿不到拖入项的真实路径，所以**上传通道是主路径**——
  文件夹经 `webkitGetAsEntry()` 递归读取后逐文件 POST 到暂存区
  `CodeFlow/imports/.staging/<token>/`，finalize 时整体 rename 到 `imports/<项目名>/`；
  压缩包上传本体后解压到 `imports/<包名>/`（暂存副本随即删除）。若宿主桥接暴露了
  `getPathForFile`（特性探测 `window.__DSH_ELECTRON__/dsh/electron/webUtils`），压缩包可走
  `POST /api/drop/path` 就地解压、文件夹就地导入（不复制）。
- **解压**：zip/tar/tar.gz 纯 Node 解析（EOCD→中央目录→本地头；512 字节节头、ustar/pax/GNU
  longname；gz 流式解压带 500 MB 熔断）；7z/rar 按魔数识别后依次尝试
  `System32\tar.exe`（bsdtar）→ 7-Zip → WinRAR/UnRAR（`execFile`，120s 超时，全不可用 →
  中文提示先手动解压）。文件名编码：UTF-8 标志 → 严格 UTF-8 → GBK 降级。
  解压后「去壳」：根下只有一个目录时以该目录为项目根。
- **安全与限额**：zip-slip / 绝对路径 / `..` / NUL / 符号链接全部拒绝（外部工具解压后还会
  重新走一遍校验）；文件数 ≤1000、解压后总量 ≤500 MB、单文件 ≤64 MB、压缩包本体 ≤500 MB、
  路径 ≤400 字符、层级 ≤32，超限 413/400 + 中文原因并清理暂存；暂存区 6 小时自动清扫
  （30 分钟一轮），插件 dispose 时停止定时器。
- **冲突**：`imports/<包名>` 目录或项目名已存在 → `409 {code:"conflict", target, current}`，
  画布弹「覆盖 / 改名 / 取消」；覆盖先把旧图文件备份为 `.bak-<时间戳>`，改名自动加 `-2/-3`
  后缀（项目名与目录名同时处理）。
- **导入串联**：finalize 成功后复用现有链路——`importProjectDual` 一次生成两张图 →
  v1.1 功能识别 → v1.2 自动耦合 → 专用会话绑定（持久绑定，不投递消息）→ 返回与
  `/api/import` 同构的响应。扫描上限同步放宽为 **1000 个文件**（默认值仍是 200，行为不变）。

## v1.0.1 的修复与升级

### A. 「测试运行」空转 → 真实执行、明确失败、一键重试

实测现场：画布点「测试运行」后，专用会话收到 `[CodeFlow:RUN_NODE]`，agent 回复了几句话，
但没有执行测试、没有调用 `progress`，节点永远停在「待运行」。四层修复：

1. **运行请求自包含**——`RUN_NODE` 直接携带 `node`（`type`/`title`/`params`，`cmd` 必带）、
   `upstream`（直接上游的 `status` 与 `result` 摘要，≤120 字）、`cwd`（`testrun`/`shell` 必须执行的
   目录：导入项目 = 源码树，新建项目 = 项目目录）与 `expect`（一句话验收）；`RUN_ALL` 携带
   `order`（拓扑序、只含 `pending/failed`）。首行仍是单行 JSON，其后宿主附加三行
   「本次执行要求」：本次必须真实执行（"本会话之前跑过"不算）、结束前必须 `progress` 回填、
   未执行就结束回合宿主会置 `failed`。解析规则同步更新（`references/protocol.md`）：
   取首行 `]` 之后到行尾的 JSON，其后正文是附加要求。
2. **技能语义硬化**——`SKILL.md` 与 `references/node-types.md` 写死 `testrun` 契约：在项目根执行、
   必须记录真实命令/退出码/输出尾部、`result` 只能来自真实输出、缺运行时 → `failed` + 可行动原因、
   **禁止未执行置 done**（尤其"之前跑过"）；NEW 阶段的自我测试不算 `testrun` 已执行。
3. **乐观置 `running`**——prompt 入队成功的一刻，目标节点（RUN_NODE）或清单第一个待运行节点
   （RUN_ALL）立即 `running`，一个轮询周期内可见；投递失败回滚原状态。
4. **回合结束对账 + 重试**——运行回合结束但目标节点没有任何 `progress`（正是现场的签名）时，
   宿主把节点置 `failed`（`result: agent 未执行该节点`）、在活动读模型记一条 `issue`，
   画布显示横幅 + 一键「重试」（以 `rerun=true` 重发）。新运行开始即清空 issue。
   "无声的 pending"从此不是可能的结局。

### B. 画布四边贴满面板

生成物 `canvas.html` 开头曾是 `-->-->`（port 脚本的 `replaceRange` 保留结束标记，而 header
替换的结尾又自带一个 `-->`），浏览器把多余的 `-->` 渲染成一行正文——就是截图顶部 ~22px
的空隙和那个"箭头"。port 脚本不再重复终止符，且写入前自检（重复即抛错）；嵌入外壳
（`lib/canvas-page.js`）去掉画布根节点的 1px 边框与 14px 圆角，四边贴满面板（独立预览保留
卡片外观）；窄宽度下工具栏自动换行。

### C. 项目迁入 `<工作区>/CodeFlow/`，支持自定义

- 新布局：`<根>/flow-projects/<项目名>/`，默认根 `<工作区>/CodeFlow`。`workflow.json`、
  `workflow.modules.json`、`session.json`、`view.json`、`.undo/` 都在项目目录里，不变。
- `lib/paths.js` 是唯一的路径拼装点：全局自定义根（任意绝对路径）+ 单项目覆盖
  （`projects[<key>].dir` 指向项目目录本身）；配置固定在 `<工作区>/CodeFlow/config.json`
  （根改到别处也放这里）。配置损坏回退默认根 + 一次性 warning，绝不丢项目
  （`knownRoots` + 旧位置 + 覆盖都参与扫描）。
- **自动迁移一次**：首次解析到工作区时把 `<工作区>/flow-projects/*` 搬进 `<根>/flow-projects/`
  （整目录含 `.undo/`；先 `rename`，跨盘/被占用回退为递归复制 + 校验 + 删旧；冲突不覆盖、
  旧目录保留；失败保留旧目录并记原因；正在运行的项目推迟到下次）。汇总写
  `<工作区>/CodeFlow/migration.json`，画布 banner 汇报一次。
- **设置入口**：工具栏 ⚙ 设置（仅宿主模式）——只读的工作区/默认根，可编辑的全局根与
  当前项目目录（各带「恢复默认」），校验（必须绝对路径、不能是文件、不能在插件包目录内、
  必须 mkdir + 写探测成功），中文错误原样显示在弹窗里；`GET/POST /codeflow/api/config`
  与其它路由过同一道 fence。状态栏「已暂存」的 tooltip 显示项目绝对路径。

## v0.6.0 的三项升级

### A. 导入一次生成两张图 + 视图切换

- 面板"导入项目"对话框不再有"生成方式"下拉：一次确定性扫描**同时产出任务流水线**
  （`workflow.json`）与模块结构图（`workflow.modules.json`），同一项目名、同一 `meta.importedFrom`。
- 工具栏分段控件 `[ 任务流水线 12 ] [ 模块结构图 28 ]`（`role="tablist"`，支持左右键）：
  两个视图都可用时才显示；切换 = flush 写队列 → 拉取目标视图 → 整图替换 + 恢复视口，
  100ms 级完成，**不重扫、不重分析、不唤醒 agent**。
- 每个视图是完整独立的 `codeflow/1` 图：节点、连线、坐标、运行状态、`rev` 互不影响；
  自动保存/保存按钮/agent 回填只作用于目标视图。激活视图持久化在 `view.json`（不参与 rev），
  重启后回到上次的视图与缩放。
- 旧项目零迁移直接读：单 `workflow.json` 按其 `meta.strategy` 归属视图；旧模块项目的
  `workflow.json` 在内存中映射为模块视图的存储文件（绝不改名/复制）；损坏隔离按文件独立，
  模块图损坏不影响任务图。
- `/flow-import` 与 CLI（`node lib/importer.js`）同步双生成；`--modules` 只是兼容别名。

### B. agent 修改代码时高亮所属模块

- 宿主 Activity Hub 从**真实写文件工具调用**（`tool/call` 的 `edit`/`write`/`ops_replace`/
  `apply_patch`/`multi_edit`/`str_replace_editor`…）的参数中提取路径（单值键/数组键/patch 标记，
  Windows 分隔符与大小写都规范化），相对路径按 `meta.importedFrom` 解析，只记录项目内的文件。
- 路径 → 节点匹配在宿主完成（单一事实源）：模块图精确匹配 `params.path` 的**文件级**节点；
  任务图按 `artifacts[].path` / `params.instruction` 匹配相关任务；匹配不到不伪造高亮。
- 画布表现：模块视图"修改中"= 琥珀脉冲 + 卡片徽章（`prefers-reduced-motion` 时只保留静态边框），
  完成后保留 15 秒"已修改"静态标记；任务视图相关任务加虚线边框、活动行显示"修改 src/foo.ts"；
  侧边栏分类按钮出现小圆点；未激活视图有编辑活动时切换按钮显示圆点提示。
- 编辑表纯内存（≤100 条/项目、≤20 路径/次调用），不落盘、不进日志；`tool/result` 失败标 `error`
  不冒充成功。

### C. 左侧导航二级列表 + 搜索

- 分类点击：0 个禁用；**1 个直接定位**（不弹层）；≥2 个弹出二级浮层。
- 浮层：顶部搜索框（打开即聚焦，大小写不敏感，标题命中排在路径命中前）、类型色点 + 标题 +
  次级说明（模块的相对路径/任务状态摘要）+ 编辑状态标签；按标题 `zh-CN` 排序；最大高度 60vh。
- 键盘：↑/↓ 移动、Enter 选中、Esc 关闭；点击外处/再次点击同分类/切换视图/开始拖拽缩放时关闭。
- 选中后：缩放定位该节点（约 1.0–1.2 倍，带动画），高亮约 1.8 秒、其余节点变暗，并设为选中态；
  焦点回到触发按钮。深浅两套主题都适配（浅色规则带 `html[data-cf-theme="light"]` 前缀）。

## v0.5.2 的修复（实测报告 B2–B9 逐项对应）

实测报告（v0.4.2/v0.5.1）发现的每个问题在本版的落点：

- **B2 自动保存写失败静默**：`POST /api/state` 改为即时落盘后再应答，响应必带
  `persisted`/`error`；客户端状态栏显示「暂存失败（未落盘）」并节流弹一次提示。
- **B3 /api/save 失败仍 200**：落盘失败改答 **507 + `ok:false`**（`persisted:false`、`error` 保留）。
- **B4 损坏文件被当空画布**（最要命的一个）：`store.load` 遇到解析失败/非 codeflow/1 的
  `workflow.json` 时先把它**隔离**为 `workflow.json.bad-<时间戳>`（字节保留），返回 `degraded`；
  boot 页面、`GET /api/state`、`codeflow_canvas` 工具全链路可见。另有兜底：**从未加载过**的项目
  首次落盘前会先校验既有文件，坏的原件同样先隔离再写入——任何路径都不再可能无声覆盖坏文件。
- **B5 后写覆盖先写**：`store.write` 支持 `expectedRev`，不匹配抛 409（带 `currentRev`）。
  autosave / 保存 / 运行手势都携带；客户端把写操作串行化（写队列），`expectedRev` 在真正发送时
  才读取，避免「保存按钮 + 待触发 autosave」互顶 409。agent 回填与撤销不受影响。
- **B6 超限 500 → 413**；**B7 非法图 500 → 400**：错误对象带 `statusCode`，统一在路由出口生效。
- **B8 非原子写 + unref 防抖**：持久化改为 **临时文件 → fsync → rename**（失败回退直写），
  同项目磁盘写**串行化**（rename 不再可能乱序落地），去掉 `unref()`，插件 dispose 时
  `flushAll()` 兜底——退出前最后一笔不再丢。
- **B9 两个「未命名」桶**：新增 `projectKeyOf`/`projectDirOf`——空名、纯空白、`..`、字面
  `untitled` 全部归入唯一的 `__untitled__` 桶（磁盘目录仍是 `CodeFlow/flow-projects/untitled/`，兼容旧数据）；
  sidecar、undo 根目录、activity 缓冲全部改用同一映射，不再出现两个内存桶共用一个目录互相覆盖。
- **B10 偶发 fetch failed（观察项）**：客户端全部请求带 15s 超时；轮询连续 3 次失败才显示
  「与宿主连接中断」横幅，避免单次抖动打扰。修复过程中还定位到一个会真实造成该现象的服务端问题：
  413 等错误在**请求体未读完时就应答**会毒化 keep-alive 连接，同一 socket 上的下一个请求直接
  ECONNRESET（status=0）——现在先排空请求体再应答。
- **修复中新发现（真 HTTP 并发才暴露）**：`store.write`/`store.flush` 在 `await` 落盘之后才读取
  `state.rev`/`state.graph` 构造应答，N 个并发写会全部报告最终 rev、甚至带上别人的图。现在在
  await 之前快照，回归用例见 `tests/regression.mjs`（重叠写各答各的 rev）与 `tests/e2e.mjs`
  （10 并发 autosave rev 1..10 连续）。
- 关联修复：导入 CLI（`node lib/importer.js`）同样改原子写；`tests/validate.mjs` 的 fake agent
  默认 cwd 不再指向 `/work/space`（不会再往盘根散落测试项目）；新增 `tests/regression.mjs`
  （21 项，B2–B9 每项都有回归用例）。

## v0.5.0 的四项升级

### A. 交付走 DSH 原生 `present`

- 节点新增可选 `artifacts` 字段（`[{path, label?, kind?}]`，≤50 条，宿主清洗；见
  `assets/skill/.../references/workflow-schema.md`）。
- `deliver` 节点运行时：传递闭包收集上游 `artifacts`（没有则按规则扫描项目目录）→ 逐个验证"存在且是
  普通文件"（丢弃目录/符号链接/缺失/敏感文件）→ 写 `docs/DELIVERY.md`（含交付物清单）→ 调原生
  `present`（单次最多 8 个，`DELIVERY.md` 永远第一）→ 回填 `result/detail/artifacts/presented`。
- 宿主监听 `deliverables/presented` 事件，把实际提交的路径合并回 deliver 节点的 `presented`。
- 画布展示：卡片徽章 `N 个交付物 · 已提交 M 个卡片`、详情弹窗"交付物"清单（只读）、
  deliver 成功后 toast 提示去会话看卡片。**不做**画布内预览器，预览与"在文件夹中显示"全部用原生卡片。

### B. 每项目一个专用会话

- 触发创建：首次打开已有项目（boot）、NEW 成功后、IMPORT 成功后、首次运行兜底；in-flight Promise 去重。
- 持久绑定：项目目录里的 `session.json` sidecar（临时文件 + rename 原子写，
  损坏/版本不符按未绑定处理）；冷会话直接采用（`sessionController.prompt` 会恢复）。
- 投递：`sessionController.prompt({requestId, sessionId, mode:'queue', content}, signal)`；
  `session/not-found`/`archived` → 重建一次并重试一次；`session/writer-held` → 不抢，报"会话正被其他写入占用"。
- 创建后**不自动切换** DSH 当前会话；画布只显示入口。没有稳定公开的会话导航 API 时，
  "打开会话"退化为复制会话 ID（客户端按 `uiWorkspace.openSession` 特性检测，见"已知限制"）。
- 项目 A 与 B 的会话完全独立；并发打开/运行只创建一次。

### C. 实时思考过程 + 任务进度

- 宿主订阅 `session/event`（turn/step/tool/assistant/deliverables durable 事件）与
  `agent/assistant-stream`（`reasoning-delta`/`text-delta` 帧），只处理绑定到画布项目的会话。
- 降级阶梯：① 真实 reasoning 流可用 → 思考流；② 只有 durable 事件 → 步骤与正文，标题写
  "思考内容不可用，以下为执行步骤"；③ 连事件都没有 → "宿主未提供实时过程"。永不伪造 reasoning/百分比。
- `codeflow_canvas` 新增 `mode:"progress"`：单节点状态/步骤/percent/artifacts 增量上报，
  **只有该项目的专用会话能调用**；percent 只在 agent 明确给出时展示，没有确定进度条就画不确定动画。
- 面板：节点卡片单行活动摘要（不改布局）、详情弹窗"执行过程"（思考流自动跟随 + 回到底部 +
  工具时间线）、右上角可折叠执行监视器（折叠状态存 localStorage）、运行结束自动收起为摘要。

### D. 撤销 agent 的文件修改（按次运行快照）

- 一次 `RUN_NODE`/`RUN_ALL` = 一次运行。投递前快照项目根（新建项目 = `CodeFlow/flow-projects/<project>/`，默认根可配置，
  导入项目 = `meta.importedFrom`），排除 `.undo`/`.git`/`node_modules`/`venv`/`__pycache__`/`dist`/
  `build`/`target`/`coverage`/`.next`/`.cache` 与 `workflow.json`/`session.json`；符号链接跳过并记录
  （`partial:true`）；上限 5000 文件 / 512 MB，超过则**保留 undoable:false 记录**（阻止跳过它撤销更早的运行）。
- `GET /api/undo` 历史倒序；`POST /api/undo` 支持 `dryRun` 预检（只比较快照候选范围）与恢复：
  先备份到 `.undo/<runId>/current-<ts>/`（备份失败即中止），再删除快照范围外新增文件、回拷 before/、
  按 `beforeNodes` 恢复节点执行字段（`pos`/`params`/`links`/`title` 永不触碰），清空 activity。
- 严格 LIFO：只能撤销最新一条未撤销且快照完整的运行；恢复失败保留备份并标 `undo-failed`。
- 磁盘配额：保留最近 10 次或 1 GB（先清最旧，永远不删最新可撤销记录）；启动/懒式 reconcile 清理孤儿目录、
  把没有 `finishedAt` 的记录标记 `interrupted`（仍可撤销）。
- **范围限制**：项目根之外的写入（shell 重定向、绝对路径写别处）不在快照内，撤销无法恢复；
  UI/技能文档都已写明。`.undo/` 不进交付、导入、日志，也不通过任何 HTTP 路由暴露。

## 目录

```
lib/index.js        插件入口：注册技能/命令/工具，串起 HTTP、会话、活动与撤销（按视图）
lib/client.js       浏览器半侧：侧边栏图标 + main 面板 + "打开会话"导航桥
lib/routes.js       /codeflow 路由与 JSON API（state/view/save/import/action/session/activity/undo/config
                    + v1.2 coupling/drop）
lib/paths.js        v1.0：项目路径的唯一拼装点（默认根 <工作区>/CodeFlow、全局自定义根 +
                    单项目覆盖、config.json、一次性旧目录迁移）
lib/coupling.js     v1.2：耦合分析引擎——符号互引图、模块依赖图、SCC/闭包/深度、评分与
                    整体"屎山程度"、过期判定（纯函数 + runCoupling 编排，全部常量可导出测试）
lib/archive.js      v1.2：zip/tar/tar.gz 纯 Node 解压、7z/rar 外部工具探测与降级、路径安全
                    （zip-slip/符号链接/限额）、GBK 文件名、去壳
lib/drop-import.js  v1.2：拖拽导入暂存区（begin/file/finalize/abort、限额、6h 清扫）、
                    冲突/覆盖/改名、调用双图导入
lib/duo.js          双导入编排：一次扫描同时生成任务流水线与模块结构图（共用项目名）
lib/sessions.js     画布专用会话管理器：ensure/rebind/sidecar/错误恢复/投递
lib/activity.js     Activity Hub：事件订阅、节点映射、环形缓冲、进度、文件编辑表（纯内存）
lib/undo.js         运行快照/恢复（manifest 带 view）、manifest/index、LIFO、备份、配额清理、路径校验
lib/store.js        双视图图状态（每视图独立 rev）、artifacts/presented 清洗、patchNode、项目列表
lib/tool.js         codeflow_canvas 工具（render/read/save/progress/load，均支持 view）
lib/importer.js     确定性项目导入（任务流水线）：扫描/语言识别/注释解析/生成图（也是独立 CLI）
lib/analyst.js      代码块结构分析（模块结构图）：符号/导入解析/角色推断/module 节点图
lib/workspace.js    路径清洗（@、~、引号、file://、macOS 大小写/规范化）与会话工作目录修复
lib/starter.js      「新建项目」的确定性骨架图（无可用会话时也能创建项目）
lib/commands.js     /flow、/flow-new（agent 执行）；/flow-import（宿主直接执行，双生成）
lib/skill.js        技能 provider（内联 rank=600，免去跨包依赖）
lib/message.js      createUserMessage 的等价实现（同样避免跨包依赖）
lib/canvas-page.js  把画布片段包成完整文档并注入启动数据
assets/canvas/canvas.html      画布本体（由 tools/port-canvas.mjs 生成，勿手改）
assets/skill/codeflow-canvas/  技能文档 + 四份 references
tools/port-canvas.mjs          可复现的迁移脚本（逐条断言每个改动点）
tools/patches/                 features（v1.1）与 coupling/drop（v1.2）的画布行为与样式补丁
tools/theme-light.css          浅色主题覆盖层（生成时追加进画布样式表）
tools/upstream/                上游 v0.2.2 画布片段原件
tools/verify-client-bundle.mjs 客户端 bundle 的 10 项加载契约校验
tests/validate.mjs             结构 + 行为自检（会话/活动/进度/撤销/双视图/编辑追踪/画布资产/XSS）
tests/regression.mjs           v0.5.2 修复逐项回归（B2–B9）
tests/e2e.mjs                  真 http server + 真 fetch 场景（含双导入/切换/重启/旧项目/损坏隔离
                               + v1.2 耦合与拖拽导入）
tests/undo.mjs                 撤销快照/恢复/LIFO/跨视图
tests/coupling.mjs             v1.2 耦合引擎：评分/阈值/确定性/SCC/闭包/部分结果/清洗/过期
tests/drop-import.mjs          v1.2 解压与暂存：zip/tar 夹具、zip-slip、GBK、限额、冲突、无 LLM 断言
tests/contrast.mjs             浅色调色板的 WCAG AA 对比度审计（被自检调用）
```

## 开发

```bash
# 自检（不需要 DSH 在跑）
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/validate.mjs   # 174 项：注册/路由/工具/技能/双视图/编辑追踪/资产/耦合/拖拽
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/regression.mjs # 27 项：v0.5.2 修复逐项回归（B2–B9）
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/e2e.mjs        # 25 个场景：真 http server + 真 fetch
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/undo.mjs       # 16 项：快照/恢复/LIFO/跨视图
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/coupling.mjs   # 19 项：耦合引擎与持久化
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/drop-import.mjs # 24 项：解压/暂存/限额/冲突
# macOS:
# ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" tests/validate.mjs

# 改了画布片段之后：重新生成 assets/canvas/canvas.html（改 port-canvas.mjs 里的内嵌脚本，不要手改生成物）
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tools/port-canvas.mjs

# 客户端 bundle 的加载契约校验
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tools/verify-client-bundle.mjs .
```

改 `lib/*.js`（Host 半侧）后需要重启 DSH；改 `lib/client.js` 需要刷新页面；
改 `tools/port-canvas.mjs` / `tools/upstream/*` 后重新生成画布。

## 与 ZCode 版的差异

| ZCode v0.2.2 | 本版 |
| --- | --- |
| `::visualize{path,mode,wide}` 会话内嵌 Gen UI | 侧边栏原生面板（iframe） |
| agent 生成画布 HTML（复制模板 + 替换占位符） | 宿主组装文档，agent 只提交图 |
| `window.zcode.sendFollowUpMessage` | `POST /codeflow/api/action` → 专用会话 `sessionController.prompt` |
| `window.zcode.setWidgetState`（16 KiB 上限） | 宿主内存状态 + 落盘，无上限 |
| `widgetState.rev` 比较 | 宿主持有 `rev`，面板轮询采纳 |
| `/flow` 等是 markdown 命令文件 | `ctx.commands.register` 注册的真命令 |
| `.zcode-plugin/plugin.json` + `marketplace.json` | `package.json` + `cordis.patch.yml` |
| 图标依赖宿主的 lucide | 内联 SVG（18 个图标，选择器不变） |
| 固定 780px 高 | 填满面板 |
| 只有深色 | 深/浅两套调色板，跟随 DSH 主题 |
| —（无） | 专用会话绑定、实时过程、原生交付、运行撤销（v0.5.0） |

保留不变：节点类型库、连线规则、模块导航、菜单/对话框、图格式 `codeflow/1`、`[CodeFlow:*]` 协议前缀、
执行语义与结果书写规范。

## 主题

画布跟随 **DSH 当前主题**，不是直接读操作系统：

- DSH 主题偏好为 `system`（默认）时，改系统深/浅色 → 画布同步；
- 在 DSH 里手动指定深/浅色 → 画布也跟着变，不会和周围界面撞色。

实现上分两处，因为颜色有两个来源：

| 来源 | 承载 | 切换方式 |
| --- | --- | --- |
| CSS 规则（表面/边框/文字/菜单/弹窗/toast/监视器/过程区） | `tools/theme-light.css` 追加到样式表末尾，选择器一律带 `html[data-cf-theme="light"]` 前缀 | 面板推 `postMessage` → 画布翻 `<html>` 上的属性 |
| 内联 `style`（状态徽章、详情弹窗、小地图） | 画布的 `PALETTE.dark / PALETTE.light` | 同上，翻转后再 `renderAll()` 一次 |

首帧不会闪：面板把主题放进 iframe 的 `?theme=` 参数，宿主机把属性直接写在 `<html>` 上。
后续切换只发改动消息、**不重载 iframe**，所以视图缩放、选中态、未提交的编辑都不会丢。

## macOS 上的导入/新建问题

遇到下面两类报错时，v0.4.2 起的处理方式：

1. **`目录不存在：/Users/.../@/Users/...`** — DSH 输入框用 `@` 选择路径时，`@` 会跟着命令参数一起到达；
   拼到工作区后面就变成 `<工作区>/@/Users/...`。命令现在先清洗 `@`、`~`、引号、`file://` 和多余空白，
   再解析绝对/相对路径；画布「导入项目」对话框同样支持。macOS 上还会对大小写/Unicode 规范化做一次
   逐段匹配，避免"目录明明在、`realpath` 却找不到"的输入。
2. **`working-directory: directory does not exist: "…"`（每个 agent 回合都失败）** — 这是 DSH 会话自身的
   工作目录失效，不是画布文件写不进去。插件在投递任何画布消息、执行 `/flow*` 之前会调用宿主的
   `ctx.workingDirectory.ensure/set` 校验；若当前目录和原始项目目录都不可用，会依次尝试：
   规范 `realpath` → 上级目录 → 已在 DSH 注册的工作区 → 启动目录/主目录，并把结果提交回会话。
   仍失败时返回可操作的错误，而不是让回合在 DSH 里静默失败。
   如果路径中英文混排且 DSH 版本仍有已知 bug，最直接的办法是把项目放到纯英文路径后重启 DSH。

画布「新建项目」也不再依赖"先让 agent 渲染一次"：宿主先写一张骨架图（`meta.starter: true`）并落盘，
再尝试把 `[CodeFlow:NEW]` 交给项目的专用会话；没有可用会话/无法创建时项目仍然创建成功，
只是节点需要稍后运行，画布上会给出可操作的提示。

## 已知限制与降级路径

- **耦合分析只覆盖被扫到的语言**：`extractSymbols` 支持的语言族才有符号级 intra 指标；
  其它扩展名（`.vue`、自定义后缀…）按行数/体积给弱结论（`parsed:false`，详情注明「解析受限」），
  不伪造精确数字。分析对象是**模块图里的文件级节点**（≤36 个），不是全部 1000 个扫描文件。
- **过期判定有 10 秒服务端缓存**（键：项目+分析时间+节点数）：改完源文件后最多 10 秒内
  `GET /api/coupling` 仍可能报"未过期"；重新分析一次（新的分析时间）立即刷新。
- **拖拽导入拿不到真实路径时走上传复制**：DSH 当前未向 iframe 暴露 `getPathForFile`，
  所以文件夹导入会被复制到 `CodeFlow/imports/<名>/`（不是就地）；宿主未来暴露桥接后，
  压缩包/文件夹自动改走就地通道，无需改画布。独立模式（直接打开 canvas.html）下拖拽禁用。
- **拖拽导入的上限**：文件数 1000、解压后 500 MB、单文件 64 MB、路径 400 字符、层级 32；
  zip64 / 加密压缩包 / 符号链接条目直接拒绝。7z/rar 依赖本机工具（System32 bsdtar / 7-Zip /
  WinRAR），都没有时提示先手动解压。外部工具解压的结果会重新校验文件数/大小，但**无法**
  替你防范外部工具自身的 zip-slip——不可信来源的压缩包请先手动检查。
- **耦合/拖拽的写入也会 bump 对应视图的 rev**：分析完成后画布强制刷新采纳新图；若你的
  autosave 撞上 409，按既有 syncConflict 流程提示，不会吞掉。
- **修改高亮只认真实写文件工具**：allowlist 覆盖 `edit`/`write`/`ops_replace`/`apply_patch`/
  `multi_edit`/`str_replace_editor` 等常见名字；reasoning、对话文本、节点标题绝不参与推断。
  `shell` 重定向/脚本间接写文件**不在高亮范围内**（不假装能解析）。
- **未纳入模块图的文件不高亮**：编辑的文件匹配不到任何模块/任务节点时只给一次"修改了未纳入结构图的文件"
  提示，不伪造高亮；同一文件的符号子节点不会单独高亮（只有文件级模块节点会）。
- **编辑记录只在内存**：宿主重启后"修改中/已修改"标记自然消失，不落盘、不补造；不进 `workflow.json`、不进日志。
- **旧单视图项目没有切换控件**：只有 `workflow.json` 的旧任务项目、或旧模块项目（`workflow.json` 即模块图）
  都能正常打开，但工具栏不会出现一个永远点不亮的 tab；旧模块项目不支持再创建任务视图（写入会被拒绝），
  且绝不自动改名/复制旧文件。
- **切换视图的前提是两个视图都可用**：模块分析失败（几乎没有源码）时导入只产出任务流水线并给出 warning，
  模块视图标记为不可用、切换控件隐藏；不会用任务节点伪造模块图。
- **"打开会话"导航**：桌面客户端存在 `uiWorkspace.openSession(sessionId)`，插件客户端按特性检测调用；
  该能力不可用（版本差异/其他组合）时退化为复制会话 ID，用户在左侧会话列表按标题
  （`CodeFlow · <项目>`）查找。不猜测 URL、不硬编码内部路由。
- **`sessionController` 缺失**（极简组合）：画布仍可编辑/导入/保存，运行会给出明确错误；
  绝不绑定随机会话。
- **`present` 不可用**：deliver 节点按失败规则回填（`交付物已生成，卡片提交失败`），
  `artifacts` 保留，用户可从画布清单/文件系统取用。
- **reasoning 不可用**：模型/会话不给 `reasoning-delta` 时画布显示步骤降级文案，不空白、不报错。
- **撤销范围**：只覆盖项目根内的普通文件；根外写入、`.undo` 自身、排除目录不保证恢复。
  最新一次运行未创建快照时，无法撤销更早的运行（防止覆盖未知改动）。撤销历史跨视图共用一个
  严格 LIFO（文件快照是项目级的），但恢复只回滚该次运行所用视图的节点字段。
- **`.undo/` 磁盘占用**：快照是源码副本，最多 10 次/1 GB；含敏感文件副本，仅本地保存，
  不经任何路由暴露、不进交付/导入/日志。删除项目目录即可整体清除。
- 浅色主题是给画布单独做的一套调色板（自带 `--cf-*` 变量），不是直接套用 DSH 的 `--dsw-*` 令牌；
  两者色感接近但不完全一致。
- 同一项目同时被面板和 agent 修改时是"最后写入者胜"（按视图各自成立）。
- 面板同一时刻只显示一个项目的一个视图；切换视图由前端完成（不经过 agent）。
- `shell` 节点可执行任意命令，仅靠技能文档要求 agent 先确认。
- 面板与 agent 的图状态同步是轮询（约 1.8s），过程数据轮询约 0.85s（运行中且页面可见时），不是流式。
