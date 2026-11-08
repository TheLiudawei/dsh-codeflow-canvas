# CodeFlow 画布 ↔ Agent 通信协议（DSH 版）

两条通道，方向相反：

- **画布 → agent**：面板把用户手势 POST 给宿主，宿主把它变成一条以 `[CodeFlow:<ACTION>]` 开头的用户消息。
- **agent → 画布**：调用 `codeflow_canvas` 工具。宿主校验图、递增 `rev`、落盘，面板轮询时自动刷新。

没有第三条通道：不生成 HTML、不写画布文件、不引用 `::visualize`。

## 1. 画布 → agent

消息**首行**是前缀 + 一个**单行 JSON 对象**（无空格、无换行）。解析规则（v1.0 起）：
找到第一个 `]`，取其后**到行尾**的整段做 `JSON.parse`；**其后的正文是宿主附加的
「本次执行要求」**，属于硬性规则，必须遵守（见 RUN_NODE/RUN_ALL 一节）。

所有动作都带 `project`、`view`（`tasks` = 任务流水线 / `modules` = 模块结构图）、`rev`，以及 `graphPath`
（**该视图**权威图的绝对路径，宿主已把它落盘；任务图 = `workflow.json`，模块图 = `workflow.modules.json`，
默认在 `<工作区>/CodeFlow/flow-projects/<项目名>/` 下，可在画布「设置」里自定义根目录）。
**图本身不在消息里**——这样大图不会污染对话，你随时 `read` `graphPath` 拿到用户眼前的精确状态。
运行只作用于消息所属的视图：另一个视图的图与状态完全不受影响。

### `[CodeFlow:NEW]` 新建项目

```json
{"action":"NEW","project":"todo-cli","view":"tasks","rev":0,"graphPath":"/ws/CodeFlow/flow-projects/todo-cli/workflow.json","name":"todo-cli","language":"python","brief":"命令行待办事项工具，支持增删改查与持久化","autoRun":true}
```

- `autoRun=true`：用户勾了"生成后自动执行到初版"，把 需求→方案→代码生成→文件写入(→测试生成) 跑完并标 `done`。
- 用户在"新建项目"对话框点"生成"后发出。NEW 只产生任务流水线视图（模块结构图只在导入时生成）。

### `[CodeFlow:IMPORT]` 导入项目

**正常情况下不会出现**：导入是纯确定性的目录扫描（`lib/duo.js` 一次调度 `lib/importer.js` 与 `lib/analyst.js`），
面板点"导入项目"由宿主 `POST /codeflow/api/import` 直接完成并落盘**两张图**（`workflow.json` +
`workflow.modules.json`，同一项目名），不惊动 agent。v1.2.1 起源码目录可以是磁盘上任意已存在目录
（对话框里的「浏览…」只读目录树也可以），但图文件始终落在**当前工作区**的
`<工作区>/CodeFlow/flow-projects/<项目名>/` 下——宿主在扫描前就解析并校验落点，解析不出直接报错。
这个动作名只为兼容旧客户端与独立模式的手工构造请求保留；万一收到，按 `import-analysis.md`
扫描并推送即可，语义不变：

```json
{"action":"IMPORT","project":"legacy-app","rev":0,"graphPath":"/ws/CodeFlow/flow-projects/legacy-app/workflow.json","path":"C:/code/legacy-app","depth":4,"fromComments":true,"addTests":true}
```

### `[CodeFlow:RUN_NODE]` 运行单个节点（含上游）

首行 JSON（v1.0 起自包含——目标节点、直接上游、工作目录都在消息里，不必先读图也能开工）：

```json
{"action":"RUN_NODE","project":"todo-cli","view":"tasks","rev":7,"graphPath":"/ws/CodeFlow/flow-projects/todo-cli/workflow.json","nodeId":"t6","rerun":false,"undoable":true,"node":{"id":"t6","type":"testrun","title":"测试运行","params":{"cmd":"python -m unittest discover -s tests -v"}},"upstream":[{"id":"t5","type":"testgen","status":"done","result":"1 个测试文件，约 6 个用例"}],"cwd":"/ws/CodeFlow/flow-projects/todo-cli","expect":"在 cwd 下真实执行 params.cmd，并把真实输出统计写进 result；未执行就是失败，不得跳过"}
```

JSON 之后宿主会附加一段正文（硬性要求）：

```
本次执行要求（必须遵守）：
1. 本次必须真实执行该节点，不得以「之前已经跑过/已经通过」为理由跳过；
2. 结束前必须用 codeflow_canvas mode="progress" 回填 status/result/detail（nodeId=t6）；
3. 未执行就结束回合，宿主会把该节点标记为失败。
```

硬规则（对应正文三条，违反任何一条都算失败）：

- **"同一会话里之前跑过"不算本次执行**：用户点运行就是一次新的执行请求，必须重跑并回填；
  哪怕你在 NEW 阶段刚跑过同样的命令、结果是通过。
- **不得只回复不执行**：没有真实工具调用（shell/文件工具/`codeflow_canvas`）的运行回合，宿主会在
  回合结束时把节点标记为 `failed`，画布上会出现失败原因与「重试」按钮。
- 每个节点结束时必须 `progress` 置终态（`done`/`failed`）；`running` 不许留到回合结束。

字段说明：`node` = 目标节点（`params` 原样，`cmd` 必带）；`node.freeform` = **true 表示这是任务节点**
（v1.5.0，`meta.cf.task:true` 的自由要求节点）：按 `node.params.requirement` 真实执行即可，`node.type`
是宿主事后分类的结果、不是本次执行的约束——详见 SKILL.md「任务节点」一节；`upstream` = 直接上游
`[{id,type,status,result(≤120字)}]`，可直接当输入上下文；`cwd`（`testrun`/`shell` 才带）= 必须
执行命令的目录（导入项目 = 源码树，新建项目 = 项目目录）；`expect` = 一句话验收标准。
`rerun=true`：已完成的节点也重跑。`undoable`：宿主是否已为本次运行创建文件快照（`false` 时带
`warning` 字段说明原因，需要转告用户"本次运行不可撤销"）。文件快照是项目级的，撤销历史按时间全局
LIFO（跨视图运行也共用一个"只能撤销最新一次"），但恢复只回滚该次运行所用视图的节点字段。

任务节点的**类型由宿主在回合结束后写入**（`node.type` 与 `meta.cf.typeAuto`，零 LLM 纯脚本）：
它不产生任何新消息、不需要你回填，你也不要去改这两个字段；撤销运行时它们会与文件一起回滚。

### `[CodeFlow:RUN_ALL]` 运行整图

```json
{"action":"RUN_ALL","project":"todo-cli","view":"tasks","rev":7,"graphPath":"/ws/CodeFlow/flow-projects/todo-cli/workflow.json","undoable":true,"order":["t1","t2","t3","t4","t5","t6","t7"],"cwd":"/ws/CodeFlow/flow-projects/todo-cli","expect":"testrun/shell 节点必须在 cwd 下真实执行命令，并把真实输出写进 result；未执行就是失败，不得跳过"}
```

- `order`：本次将执行的节点 id（拓扑序，只含 `pending/failed`；`done` 复用结果、`skipped` 跳过）。
  按它执行，逐个 `progress` 回填；其后的正文同样是硬性要求。
- 你点运行后宿主会立刻把第一个待运行节点置为「运行中」，随后由你的 `progress` 接管。

两个 RUN 动作都只会出现在该项目的**画布专用会话**里（每个项目一个，持久绑定；
标题形如 `CodeFlow · <项目>`）。运行前宿主已对项目源码树做快照（`.undo/`），
用户之后可在画布上"撤销这次运行"。

### `[CodeFlow:SAVE]`

**正常情况下不会出现**：面板的"保存"按钮由宿主直接落盘（两个视图都落），不惊动 agent。
保留这个动作名是为了兼容手工构造的请求。

### `[CodeFlow:FEATURES]` 功能归属识别（v1.1）

用户在画布「方案/构建」浮层里点了「让 agent 识别」时发出——这是功能识别**唯一**的模型路径，
打开菜单/渲染浮层本身零模型调用。`candidates` 已经列出未归属的模块节点，**不要扫全库**：

```json
{"action":"FEATURES","project":"todo-cli","view":"modules","rev":7,"graphPath":"/ws/CodeFlow/flow-projects/todo-cli/workflow.modules.json","featuresPath":"/ws/CodeFlow/flow-projects/todo-cli/features.json","candidates":[{"id":"m7","title":"utils.py","path":"src/utils.py"}],"reason":"用户在画布上点击了「让 agent 识别」"}

本次识别要求（必须遵守）：
1. 只针对 candidates 列出的未归属模块做功能识别；不要重扫全部代码、不要读取无关文件；
2. 结合节点标题、params.path 与你已有的项目知识判断功能归属；不确定的节点宁可不标（保持未归属），不要为了好看硬归类；
3. 用 codeflow_features 工具一次性写入（op="write"），不要逐条调用、不要修改图文件、不要 bump rev；
4. 写入完成后回复一行摘要（识别了几个功能、多少模块仍未归属）。
```

- `featuresPath` 指向项目的 `features.json`：识别结果写进它的 `manual` 段，重建时原样保留，放心写。
- 归属的**持久键是文件**（相对源码根、`/` 分隔）；节点 id 只是当前图的缓存。
- 写入只走 `codeflow_features`（op="write"）；**绝不**用 `codeflow_canvas` 改图、不 bump 任何 `rev`。

## 2. agent → 画布（回填）

**首选通道（v0.5.1 起）：改文件 + `load`。** 用你的文件编辑工具把更新后的整图直接写入
`graphPath` 指向的图文件（任务图 `workflow.json`、模块图 `workflow.modules.json`——**只写消息所属视图的文件**），然后：

```json
{"mode":"load","project":"todo-cli","view":"modules"}
```

宿主从磁盘重读**该视图**的文件、清洗、`rev` 自增并落盘，面板自动刷新；另一个视图原样保留。
**整图 JSON 不经过工具参数**——超长嵌套 JSON 是模型工具调用最容易写出非法字符的地方（宿主会报
`tool input is invalid JSON` 并使整个回合失败），这是它被设计为首选的原因。

规则：

1. 写文件前先读最新内容（`mode="read"` 或直接读文件），在它上面改状态/结果/新节点，一次完整写入。
2. 文件里的 `rev` 保持原值即可，`load` 之后宿主自增；**不要自己维护 `rev`**。两个视图的 `rev` 互不相干。
3. 面板每 ~1.8 秒拉一次当前视图的状态；`rev` 变大就整图替换，并在用户正在拖拽/输入时跳过，避免打断。
4. 其他模式（都接受可选 `view`，缺省为面板当前激活视图）：
   - `mode="read"` + `project` (+ `view`)：读出该视图当前图（回 `graph` 与 `view`），摘要会说明另一视图是否存在。
   - `mode="save"`：落盘（双视图项目两个视图都落盘）。
   - `mode="progress"`（v0.5.0 起）：节点执行中的增量更新，**只有该项目的画布专用会话能调用**：

     ```json
     {"mode":"progress","project":"todo-cli","view":"modules","nodeId":"m5","status":"running","step":"读取 src/app.py","percent":40,"artifacts":[]}
     ```

     - `view` 建议带上；缺省时宿主按运行上下文与节点 id 前缀（`t*`/`m*`）定位，定位错会拒绝而不是猜着改。
     - 开始：`status:"running", step:"开始：<动词>"`；
     - 每个关键动作后：`step:"读取 X" / "写入 N 个文件" / "运行测试"`；
     - 结束：`status:"done"|"failed"` + `result`/`detail`/`artifacts`；
     - `percent`（0–100）只在任务本身有真实百分比时传，**绝不估算**；
     - `artifacts`/`presented` 也可在 progress 里上报，避免为交付物来回整图。
   - `mode="render"`（**后备**）：把整图作为工具参数推送，只替换目标视图。仅在没有文件工具可用、或图还不存在于磁盘
     （例如给空工作区推一张空图）时使用：

     ```json
     {"mode":"render","view":"tasks","graph":{"format":"codeflow/1","rev":7,"project":{"name":"todo-cli","language":"python","origin":"new"},"nodes":[…],"links":[…],"meta":{}}}
     ```

     宿主校验、`rev` 自增、写该视图的图文件。用 `render` 时传**完整整图**，照抄读到的图再改内容；
     绝不会删除另一个视图。

## 3. 幂等与并发

- 一次回合里可能连续来多条 `[CodeFlow:*]` 消息（用户连点）。逐条按序处理，每条都以它自己带的
  `graphPath`/`view` 为准。
- `RUN_NODE` 只跑目标节点及其 `pending/failed` 上游；`done` 上游直接复用其 `result` 与磁盘上的文件。
- 宿主与面板之间是"最后写入者胜"。若你在读图之后用户又改了画布，以**你回填的图**为准覆盖——
  所以除非确有理由，不要凭空重造整张图，只在读到的图上改状态/结果/新节点。
- 另一个视图不属于本次运行：不要读它、不要写它。

## 4. 独立预览模式

把 `assets/canvas/canvas.html` 单独放进浏览器（不经宿主）时没有 `window.__CF_BOOT__`，
画布进入"独立模式"：发送动作改为弹出可复制的请求文本，状态只存本机 localStorage，视图切换控件隐藏。
这是开发自测路径，正常使用不涉及。
