---
name: codeflow-canvas
description: "CodeFlow workflow canvas (ComfyUI-style) for DSH. A native sidebar panel renders a node graph where each node is an agent-executable coding task connected by dataflow links. Use when: the /flow, /flow-new or /flow-import command is invoked; the user asks to open the workflow/flow/ComfyUI canvas (工作流画布 / Flow 画布 / ComfyUI 画布); a message starts with the [CodeFlow: marker sent by the canvas; or the user asks the canvas to 新建项目 / 导入项目 / 运行工作流 / 运行节点 / 保存项目. ComfyUI 风格的编程工作流画布：右键新建项目（agent 生成初版）、导入项目（一次同时生成任务流水线与模块结构图）、节点即 agent 可执行的开发任务。"
---

# CodeFlow 工作流画布

把 ComfyUI 的节点画布范式搬到编程：**节点 = agent 可执行的开发任务，连线 = 依赖与数据流**。
用户在左侧栏的 CodeFlow 面板上编排，你在工作区真实执行，并把结果回填到画布。

参考资料（相对本文件所在目录）：

| 文件 | 作用 |
| --- | --- |
| `references/workflow-schema.md` | 工作流图 JSON 格式（一个项目两个视图、含 `artifacts`/`presented` 可选字段） |
| `references/node-types.md` | 16 种节点类型与每种的执行语义 |
| `references/protocol.md` | 画布 ↔ agent 消息协议（含 `view` 字段与 `progress` 模式） |
| `references/import-analysis.md` | 导入项目时的扫描与注释解析规则（任务流水线 + 模块结构图） |

开工前先读 `workflow-schema.md` 与 `protocol.md`；执行节点前查 `node-types.md` 中对应类型的"执行语义"。

## 0. 两个方向（先记住这条）

- **画布 → 你**：用户点按钮时，你的会话里会出现一条以 `[CodeFlow:<ACTION>]` 开头的用户消息，后面是单行 JSON。
- **你 → 画布**：调用 `codeflow_canvas` 工具。**这是唯一通道** —— 不要生成 HTML，不要写画布文件，不要引用任何 `::visualize` 之类的标记。

### 一个项目两个视图（v0.6.0 起）

导入一个项目后，它同时拥有两张图，各自独立、互不影响：

- **任务流水线**（`workflow.json`，视图名 `tasks`）：scan → comments → 任务节点 → 审查 → 交付；
- **模块结构图**（`workflow.modules.json`，视图名 `modules`）：每个代码文件一个 `module` 节点（入口/被依赖最多的核心文件还会展开符号子节点）。

用户在画布工具栏用 `[ 任务流水线 12 ] [ 模块结构图 28 ]` 分段控件随时切换（不重扫、不重分析）。
`[CodeFlow:*]` 消息里的 **`view`** 字段标明本次消息属于哪个视图，**`graphPath`** 指向该视图的图文件——
回填时只写这个文件、只动这个视图。两张图的 `rev` 各自独立，写一边绝不会让另一边的版本号变化。

图只有一份权威副本（每视图一份）：`<工作区>/CodeFlow/flow-projects/<项目名>/workflow.json` 与
`workflow.modules.json`（v1.0 起项目根目录可在画布「设置」里自定义，以消息里的
`graphPath` 为准）。宿主在画布每次改动、以及你每次调用工具时都会写对应文件；
`graphPath` 就是它的绝对路径。

### 回填的首选通道：改文件 + load（重要）

把更新后的整图**用你的文件编辑工具直接写入 `graphPath` 指向的图文件**（任务图写 `workflow.json`、
模块图写 `workflow.modules.json`），然后调 `codeflow_canvas` 的
`{"mode":"load","project":"<项目>","view":"<tasks|modules>"}` 让宿主从磁盘重读该视图并刷新画布。
**不要把整图 JSON 塞进工具参数**——超长的嵌套 JSON 是模型工具调用最容易写出非法字符的地方，
一但参数解析失败整个回合会以 `tool input is invalid JSON` 失败。`mode:"render"` 只在
手头没有可用的文件写入工具、或要从零构建一个磁盘上还不存在的图时作为后备使用
（它只替换目标视图，绝不删除另一视图）。

### 专用会话（v0.5.0 起）

每个项目有一个**画布专用会话**（标题形如 `CodeFlow · <项目名>`），与项目持久绑定：

- `[CodeFlow:RUN_NODE]` / `[CodeFlow:RUN_ALL]` 等执行消息**只会**投递到该专用会话；
  如果你正在别的会话里执行 `/flow`，只负责渲染/建项目，**节点执行不发生在你这里**。
- 你不需要（也拿不到）会话切换；宿主负责把消息送进对的会话。用户在画布底部状态栏可以看到
  "专用会话 · <标题>" 入口。
- 画布运行发起前宿主会自动对项目源码树做快照，用户之后可以"撤销这次运行"。
  **你写文件时尽量待在项目根目录内**：项目根之外的写入（如绝对路径写到别处、shell 重定向到根外）
  不在快照范围内，撤销无法恢复，要在最终回复里提醒用户。
- 撤销按时间全局倒序（跨视图共用一个 LIFO）；恢复只回滚该次运行所用视图的节点字段和文件。

## 1. 打开画布（/flow、用户要求打开画布）

1. 确定初始图：若工作区有 `CodeFlow/flow-projects/*/workflow.json`，选**最近修改**的一个，直接调
   `codeflow_canvas`（`mode="load"` + `project`）让宿主从磁盘重载（图已在磁盘上，不必经由工具参数搬运）；
   双视图项目默认载入任务流水线，想看模块图再加 `view:"modules"`。
   工作区一个项目都没有时，用 `mode="render"` 推一张空图
   `{"format":"codeflow/1","rev":0,"project":null,"nodes":[],"links":[],"meta":{}}`。
2. 回一两句话：告诉用户点左侧栏的 **CodeFlow（⬡）** 图标看画布，右键空白画布可"新建项目 / 导入项目"；
   若载入了历史项目，说明项目名与进度。

用户没打开面板时工具也会成功——图已经就位，用户点开面板就能看到。
注意：这一步只渲染，**不创建、不改写**项目的画布专用会话。

## 2. 处理画布消息

收到以 `[CodeFlow:` 开头的用户消息时，**不要**重新开画布。按 `action` 分派。
消息**首行**是前缀 + 单行 JSON；RUN_* 消息 JSON 之后还有一段「本次执行要求」正文，
是宿主附加的硬性规则（解析规则见 `protocol.md`）。消息形如：

```
[CodeFlow:RUN_NODE]{"action":"RUN_NODE","project":"todo-cli","view":"modules","rev":7,"graphPath":"/abs/path/CodeFlow/flow-projects/todo-cli/workflow.modules.json","nodeId":"m5","rerun":false,"undoable":true,"node":{"id":"m5","type":"module","title":"app.py","params":{"path":"/abs/app.py","symbol":""}}}

本次执行要求（必须遵守）：
1. 本次必须真实执行该节点，不得以「之前已经跑过/已经通过」为理由跳过；
2. 结束前必须用 codeflow_canvas mode="progress" 回填 status/result/detail（nodeId=m5）；
3. 未执行就结束回合，宿主会把该节点标记为失败。
```

**图以 `graphPath` 为准**：先用 `read` 读它，不要凭记忆里更早的版本。文件里的 `rev` 就是该视图当前版本。
**`view` 指明视图**：后续 `progress`/`load` 都带上它。

### NEW — 新建项目

字段：`{name, language, brief, autoRun, rev, graphPath}`。步骤：

1. 项目目录定为 `<工作区>/CodeFlow/flow-projects/<name>/`（v1.2.1 起工作区由**用户在画布对话框里选定**——
   宿主已校验它是已登记的 DSH 工作区，未选或选错时项目根本不会创建；项目根仍可在画布「设置」里自定义，
   以消息里的 `graphPath` 为准；宿主已做安全化；与现有目录冲突时问用户是覆盖、改名还是取消——
   **不要静默覆盖**）。
   **画布可能已创建骨架**：若 `graphPath` 指向的图带 `meta.starter:true`，说明宿主为了让"新建"在无会话时也能成功，
   已经写好一张 `requirement → design → codegen → … → deliver` 的骨架。直接在它上面补全/替换，不要重复建项目。
   若消息里带 `warning`（例如图谱未落盘、工作目录被切换），在最终回复里用一句话说明。
2. 按 brief 生成项目初版（即"代码生成"的执行语义）：
   - `design`：想清模块划分与文件清单，写入 `docs/design.md`；
   - `codegen`：在项目目录写出真实可运行的代码（语言与 brief 一致，含入口与必要配置；3–8 个文件起步）；
   - `write`：确认文件已落盘；
   - `testgen`：`autoRun=true` 时为核心模块写一个可运行的测试。
3. 构建工作流图（详见 `workflow-schema.md`；默认链
   `requirement → design → codegen → write → testgen → testrun → review → deliver`）。
   **宿主已写好骨架文件（`meta.starter:true`），在它上面补全**：
   - 已执行的节点 `status:"done"` 并填 `result`（≤80 字）与 `detail`（产出文件相对路径清单）；
   - **实际写了文件的节点必须上报 `artifacts`**（真实存在的文件，路径相对工作区根；见 `node-types.md` 的
     `artifacts` 一节）；
   - 未执行的节点（测试运行、代码审查、交付打包）`status:"pending"`；
   - `project.origin:"new"`，坐标按默认链横向排列（间距 330×170）。
   NEW 只产生任务流水线视图；模块结构图只在导入时生成，不要为新建项目伪造模块图。
4. 把补全后的整图**写入 `graphPath` 指向的 `workflow.json`**（用文件工具，不要经工具参数搬运），
   再调 `codeflow_canvas`（`{"mode":"load","project":"<项目>","view":"tasks"}`）刷新画布。**rev 由宿主维护，不要自己 +1。**
5. 最终回复：生成了哪些文件、如何运行、画布上哪些节点待运行。

### IMPORT — 导入项目

**正常情况下不会出现这条消息**：导入是纯确定性的目录扫描，面板点"导入项目"或用户执行
`/flow-import` 时，宿主直接完成扫描、**一次生成任务流水线与模块结构图两张图**并落盘，
**不需要你参与，也不会给你发消息**（不再有"二选一"，`--modules` 只是兼容别名）：

- **任务流水线**：`lib/importer.js` 按注释标记生成任务节点，写入 `workflow.json`（import-analysis.md 第 6 节）。
- **模块结构图**：`lib/analyst.js` 识别每个代码块的结构与角色（符号、导入依赖、入口/路由/模型/工具…），
  生成 `module` 节点依赖图，写入 `workflow.modules.json`（import-analysis.md 第 7 节）。`module` 节点导入时已
  预填推断，用户**运行**某节点时你才介入：读源文件验证并深化职责说明（执行语义见 node-types.md `module`）。
- 目录里几乎没有源码时模块图不可用（任务流水线照常导入）；不要伪造空模块图。
- **落点规则（v1.2.1）**：`path` 可以是磁盘上任意已存在目录（不限于工作区）；但图文件始终落在
  **当前工作区**的 `<工作区>/CodeFlow/flow-projects/<项目名>/` 下——宿主在扫描之前就解析并校验落点，
  解析不出会直接报错，绝不会把 CodeFlow 文件写进源码目录。

只有两种情况需要你动手：

- 用户口头请你导入（没有用命令或面板按钮）：引导用户用 `/flow-import <路径>`
  或面板的"导入项目"按钮。路径可以带 `@`（DSH 输入框的 @ 选择）、`~`、引号或 `file://`，宿主会先清洗再解析。
  实在需要你代劳时，按 `references/import-analysis.md` 的第 6、7 节手工构图（两张图、同一项目名），
  分别写入 `workflow.json` 与 `workflow.modules.json` 后用 `codeflow_canvas`（`mode="load"` + `view`）重载
  （图不在磁盘上时才退回 `mode="render"`），语义与脚本保持一致。
- 收到手工构造的 `[CodeFlow:IMPORT]` 旧消息：同上处理。

### RUN_NODE / RUN_ALL — 执行

字段：`RUN_NODE` 带 `nodeId` 与 `rerun`；两者都带 `project`、`view`、`rev`、`graphPath`、`undoable`。
v1.0 起 RUN_* 消息**自包含**：`RUN_NODE` 另带 `node`（目标节点的 `type`/`title`/`params`）、
`upstream`（直接上游的 `status` 与 `result` 摘要）；`RUN_ALL` 另带 `order`（本次要执行的节点 id，
拓扑序）；`testrun`/`shell` 还带 `cwd`（必须执行命令的目录）与 `expect`（验收标准）。
JSON 之后的「本次执行要求」正文是**硬性规则**。这条消息**只会出现在该项目的画布专用会话**里。步骤：

1. `read` 出 `graphPath` 的图（或 `codeflow_canvas` `mode="read"` + `project` + `view`）。
2. 定目标：`RUN_NODE` 目标 = `nodeId`；`rerun=true` 时目标及其上游全部重跑，否则只补跑 `pending/failed` 的上游。
   `RUN_ALL` 按 `order`（消息里的执行清单）执行**当前视图**的节点。
   运行任务流水线不会影响模块图的任何状态，反之亦然。
3. **硬规则（违反任何一条都算失败，宿主会对账）**：
   - **「同一会话里之前跑过」不算本次执行**：用户点运行就是一次新的执行请求，必须重跑并回填——
     哪怕你在 NEW 阶段刚跑过同样的测试、结果是通过；
   - **不得只回复不执行**：没有任何真实工具调用的运行回合，宿主会在回合结束时把目标节点置
     `failed`（`result: agent 未执行该节点`），画布会显示原因和「重试」按钮；
   - 每个节点结束时必须 `progress` 置终态（`done`/`failed`）；`running` 不许留到回合结束。
4. 逐节点执行，语义见 `node-types.md` 各类型的"执行语义"。顺序：置 `running` → 用工具真干活 → 置 `done`/`failed`
   并写 `result`/`detail`。上游的 `result`/`detail`（消息 `upstream` 或图里）作为该节点的输入上下文。
5. **每个节点都通过 `progress` 模式实时上报**（画布会展示思考流与步骤；模块视图运行时，
   宿主还会根据你真实编辑的文件高亮所属模块）：
   1. 开始时：`{"mode":"progress","project":"<项目>","view":"<view>","nodeId":"<id>","status":"running","step":"开始：<动词>"}`
   2. 每个关键动作后：`progress(step="读取 src/app.py")`、`progress(step="写入 3 个文件")`、`progress(step="运行测试")`
   3. `percent` 只在任务本身有真实百分比时才传（如"第 3/8 个文件"）；**没有就不要传，绝不估算**。
   4. 结束时：`progress(status="done"|"failed", result=…, detail=…, artifacts=[…])`。
   5. 全部节点结束后，把更新后的整图写入 `graphPath` 指向的图文件，再调一次
      `{"mode":"load","project":"<项目>","view":"<view>"}` 保持图一致（不要把整图塞进工具参数）。
6. `testrun`、`shell` 要跑命令：**在 `cwd`（消息里给的目录）下执行**；用会话已有的 shell 工具与项目自身依赖；
   **运行时不可用（如本机无 Node/Python）时把节点置 `failed` 并在 detail 说明，绝不伪造通过**。
7. 实际写文件的节点（codegen/edit/fix/testgen/docgen/write/module/deliver；shell 仅在明确产出文件时）必须在
   完成 `progress` 或最终整图里带 `artifacts`（见 `node-types.md`）。
8. 最终回复：每个执行节点的结果一行（✓/✗ + result），若有新增文件再附产出文件树；
   若 `undoable:false`（快照失败）或运行前有 `warning`，明确转告用户。

### SAVE

画布的"保存"按钮由宿主直接落盘，**不会给你发消息**。你不需要为它做任何事。
用户如果口头让你"保存项目"，用 `codeflow_canvas`（`mode="save"`）即可（两个视图都会落盘）。

### FEATURES — 功能归属识别（v1.1）

用户在画布「方案/构建」浮层点了「让 agent 识别」时收到 `[CodeFlow:FEATURES]`：
`candidates` 列出未归属功能的模块节点，`featuresPath` 指向项目的 `features.json`
（消息协议见 `protocol.md` 同名小节）。规则：

1. 只判断 `candidates` 里的节点，**不要重扫全部代码**、不要读无关文件。
2. 用 `codeflow_features` 工具**一次性**写入（`op:"write"`，`mode:"replace-manual"`）：
   `features:[{name, files:[相对源码根、/ 分隔的路径]}]`；`files` 找不到节点的文件会
   出现在返回的「未匹配」清单里，原样转告用户即可，不要静默丢弃。
3. 不确定归属的节点保持未归属，**不要为了好看硬归类**；宁可少标。
4. 不要修改图文件、不要 bump 任何 `rev`、不要调用 `codeflow_canvas` 改图；写完回复一行摘要。
5. `codeflow_features op="list"` 也可零成本查询某个项目当前的功能分组（不需要读图）。

### 耦合分析与拖拽导入（v1.2）—— 宿主侧零 token，**不要你参与**

画布的两个 v1.2 功能全部是宿主确定性代码，**不产生任何 agent 回合、不会给你发任何
`[CodeFlow:*]` 消息**：

- **模块耦合分析**（节点右键「分析耦合」/ 空白右键「分析全部耦合」/ 工具栏「耦合分析」）：
  宿主扫描源码、算符号互引与模块依赖图，给文件级模块节点写 `node.coupling`
  （低/中/高），把整体「屎山程度」写到 `meta.coupling`（模块图全量、任务图只镜像这一个键，
  带 `source:"modules"`）。字段格式见 `workflow-schema.md`。
- **拖拽导入**（把文件夹 / zip / tar / tar.gz / 7z / rar 拖进画布）：宿主接收上传、
  解压到 `CodeFlow/imports/<包名>/`、走与「导入项目」完全相同的一次双图导入 +
  自动耦合流程。

对你（agent）的要求：

1. 用户问起这两个功能时，引导他们用画布 UI（或 `/flow-import <路径>`），**不要**用
   `codeflow_canvas`/文件工具重做一遍、不要自己计算或改写 `coupling` 字段。
2. 读图时遇到 `node.coupling` / `meta.coupling`：这是宿主的分析产物，**原样保留**；
   旧项目没有这些字段是正常的，不要补造。
3. 回填图时不要动 `meta.coupling`（宿主在分析/导入时维护）；任务图的节点上出现
   `coupling` 字段属于异常（宿主会清洗），不要依赖它。
4. 节点上的耦合徽章可能带「过期」虚线态（源文件 mtime 晚于分析时间）——那是宿主
   `GET /api/coupling` 的临时判定，不落盘，与你的执行状态无关。

## 3. 回填规范（重要）

1. 节点**执行中**的状态/步骤更新用 `mode="progress"`（单节点增量，宿主会 `bump rev` 并落盘，**带 `view`**）；
   整图结构变化（增删节点/连线/坐标）或全部执行完后，**把整图写入 `graphPath` 指向的图文件，再调
   `{"mode":"load","project":"<项目>","view":"<view>"}`** —— 这是首选回填通道。
   `mode="render"`（整图作为工具参数）只在没有文件工具可用、或图还不存在于磁盘时作为后备。
2. 不要把 `rev` 当成你的计数器：读到的 `rev` 只用来确认"这是不是最新一版"；写文件时保留文件里
   现有的 `rev` 值，`load` 之后宿主会自增。两个视图的 `rev` 互不相干。
3. 写图文件前先 `mode="read"`（或直接读文件）拿最新内容，在它上面改状态/结果/新节点，
   **一次完整写入**，不要分段编辑留下半成品 JSON；宿主会清洗并拒绝不合法的图。
4. 只写本次运行视图的图文件（`graphPath` 指向的那个）。**永远不要**顺手写另一个视图的文件——
   用户在另一张图上的编辑不在你的上下文里。
5. 图里的 `nodes[].pos` 由画布负责；你没有明确理由时**保留原坐标**，不要重排。
6. 一次回合里可以多次调用 `codeflow_canvas`（例如先推初版、跑完再推结果）。
7. 单图建议 ≤ 60 节点：面板能显示更多，但模型自己维护上百节点的图容易出错。

## 4. 状态与结果书写规范

- `result` ≤80 字符，面向画布单行展示，如 `生成 5 个文件`、`12 passed, 0 failed`、`发现 8 条标记，5 个文件`。
- `detail` ≤400 字符，放文件清单（相对路径，顿号分隔）或失败原因。超出就精简，**不要**放源码。
- `failed` 必须给出可行动的原因（缺运行时 / 编译错误首行 / 文件缺失…）。
- 不要把 `status` 置为 `running` 后结束回合——回合结束时所有节点必须是终态（done/failed/pending/skipped）；
  宿主会在回合结束时把仍为 `running` 的节点自动置为 `failed`（detail 写明原因）。
- `artifacts` 只报**真实存在**的文件：上报前你已经写过/验证过它；缺失的文件说明原因，不要静默。

## 5. 交付（deliver 节点）与原生 present

`deliver` 是终点节点。运行它时（详见 `node-types.md` 的 `deliver`）：

1. **收集交付物**：沿入线收集全部上游节点的 `artifacts`（去重）；没有 `artifacts` 时按规则扫描项目目录；
   逐个验证"存在且是普通文件"，丢弃目录、符号链接、缺失文件、`.env`/密钥/构建产物，缺失的要记录。
2. **写 `docs/DELIVERY.md`**：项目状态、文件树、如何运行、已知问题、测试结果，外加"交付物清单"一节；
   写完把 `docs/DELIVERY.md` 本身作为第一个交付项。
3. **调用原生 `present` 工具**提交交付卡片：`files: [{path, description}]`，最多 8 个（DSH 限制），
   优先级 `docs/DELIVERY.md` → README → 入口 → 配置 → 测试 → 其他；其余文件在画布清单和 DELIVERY.md 里完整列出，
   最终回复说明"另有 N 个文件已在画布/DELIVERY.md 列出"。用户点卡片在右侧栏预览，可用系统菜单"在文件夹中显示"。
4. **回填**：成功 → `status:"done"`、`result:"交付就绪 · N 个文件 / 已提交 M 个卡片"`、`artifacts` 全量、
   `presented` 实际提交的路径；没有任何可交付文件 → `failed`；文件已生成但 `present` 失败/不可用 →
   `failed`，`result:"交付物已生成，卡片提交失败"`，`artifacts` 保留。**不要伪装 done。**

## 6. 多项目与历史

- 每个 `CodeFlow/flow-projects/<name>/` 是一个项目（任务流水线 `workflow.json` + 可选的模块图 `workflow.modules.json`；
  根目录可在画布「设置」里自定义）。
  用户再次 `/flow` 时载入最近项目；用户想切换项目时，列出项目根下的项目供选择（或
  `codeflow_canvas` 的 `mode="read"`）。
- 画布面板同一时刻只显示一个项目的一个视图；切换项目 = 把对应图渲染过去，切换视图 = 工具栏分段控件（纯前端，不经过你）。
- 每个项目有各自的画布专用会话；项目 A 的运行绝不会进入项目 B 的会话。

## 7. 安全边界

- `shell` 节点执行任意命令：只执行 `params.cmd` 里的命令本身，不追加其他操作；破坏性命令
  （删目录、格式化、推远端等）先向用户确认。
- 导入扫描只读；生成/修改文件只发生在项目的项目目录（默认 `CodeFlow/flow-projects/<项目名>/`）
  与用户明确指定的目标目录。
- 不在画布或图里写密钥等敏感信息。
- **不要**读取或修改项目的 `.undo/` 目录：那里是宿主的运行快照（撤销用），不属于项目源码，
  也不应出现在交付物、导入或文档里。
- 项目根之外的文件写入不在撤销快照范围内；确需写到根外时在最终回复里提醒用户。
- 画布上"agent 修改了哪个模块"的高亮来自宿主对**真实写文件工具调用**（edit/write/ops_replace/apply_patch…）
  的解析——只读工具和对话文本不会触发高亮；用 shell 重定向间接写文件不在高亮范围内。
