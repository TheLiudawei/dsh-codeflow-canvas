# CodeFlow 节点类型库（agent ↔ 画布共享契约）

画布前端 JS 与本文件必须保持一致：画布负责展示与连线校验，agent 负责按本文件的"执行语义"真正干活。
修改节点类型时，两处必须同步更新（画布模板中 `NODE_TYPES` 常量 + 本文件）。

## 端口类型（type token）

| type   | 颜色    | 含义                     |
| ------ | ------- | ------------------------ |
| `text` | 蓝      | 自然语言文本（需求、文档） |
| `json` | 紫      | 结构化数据（方案、任务清单）|
| `code` | 绿      | 源代码 / 代码文件集合      |
| `report` | 青绿  | 执行/审查报告             |
| `file` | 橙      | 文件路径集合              |
| `any`  | 灰      | 万能类型，可与任意类型相连  |

连线规则：两端类型相同，或任一端为 `any`。输入端口只允许一条入线（新连线替换旧线），输出端口可接多条出线。不允许成环（画布前端会拒绝）。

## 节点状态

`pending`（待运行 ○）→ `running`（运行中 ◐）→ `done`（完成 ✓）/ `failed`（失败 ✗）；
`skipped`（已跳过，灰）。每个节点可附带 `result`（≤80 字符摘要）与 `detail`（≤400 字符，含产出文件清单）。

## `artifacts` 交付物字段（v0.5.0 起，可选）

实际写文件的节点在**完成时**必须上报真实存在的文件，供 `deliver` 节点汇总、画布展示与交付卡片使用：

```json
{ "artifacts": [ { "path": "src/app.py", "label": "程序入口", "kind": "code" } ] }
```

- `path`：**工作区相对路径**（`/` 分隔）。以工作区根为基准，与 `CodeFlow/flow-projects/<project>/` 同级——
  **不要**把 `CodeFlow/flow-projects/<project>/` 前缀写两遍。工作区外的文件（导入项目）用绝对路径。
- `label`：≤80 字符，可省略；`kind`：`code | doc | test | config | asset | other`，可省略。
- 每个节点最多 50 条；宿主会去重、去空、去控制字符，非法项直接丢弃。
- **谁负责填**：`codegen`、`edit`、`fix`、`testgen`、`docgen`、`write`、`deliver` 必填；
  `module` 在写入 `docs/modules/*.md` 时填写；`shell` 仅在明确产出了文件时填写，不要猜测。
- 只报**验证过存在**的普通文件。目录、符号链接、`.env`/密钥、构建产物一律不报。

## 节点类型定义与执行语义

### 输入类（蓝 #3b82f6）

**`requirement` 需求输入** — 工作流起点。
- 输出：`需求(text)`
- 控件：`brief`（textarea 需求描述）、`language`（select，默认 python）
- 执行语义：无需真正执行；agent 校验 brief 非空后把 `result` 设为需求摘要（≤40 字），状态置 `done`。若 brief 为空则 `failed`。

**`scan` 项目扫描** — 扫描目录，产出结构与文件清单。
- 输入：无（路径在控件中）；输出：`结构报告(json)`、`文件清单(file)`
- 控件：`path`（text 项目路径）、`recursive`（bool，默认 true）、`maxFiles`（number，默认 200，上限 300）
- 执行语义：按 import-analysis.md 的规则扫描。`result` 形如 `Python 12 文件 / JS 3 文件`；`detail` 写入语言统计与代表性文件路径列表。跳过 node_modules/.git/venv/dist/build/__pycache__ 等。

**`readfile` 文件读取** — 读取单个文件内容。
- 输出：`内容(text)`
- 控件：`path`（text 文件路径）
- 执行语义：读取文件（截断至 400 行）。`result` = `路径 · N 行`。

### 方案类（紫 #8b5cf6）

**`design` 技术方案** — 把需求变成实现方案。
- 输入：`需求(text)`；输出：`方案(json)`
- 控件：`depth`（select 简洁/标准/详尽，默认标准）、`notes`（textarea 补充约束）
- 执行语义：综合上游需求写出方案要点（模块划分、文件清单、关键技术选型、风险），写入项目目录 `docs/design.md`。`result` = 方案要点首行；`detail` = 文件清单。`depth=简洁` ≤5 个文件，`标准` ≤10，`详尽` 不设限但要分模块。

**`comments` 注释解析** — 从代码注释中提取待办与意图。
- 输入：`文件清单(file)`；输出：`任务清单(json)`
- 控件：`markers`（select：TODO / TODO,FIXME / 全部(含NOTE,HACK)）、`makeTasks`（bool 默认 true）
- 执行语义：按 import-analysis.md 的注释语法提取标记。`result` = `发现 N 条标记，M 个文件`；`detail` 列出前 8 条（`文件:行 标记 文本`）。`makeTasks=true` 时 agent 应在画布中为最重要的标记追加任务节点（见 SKILL.md"导入项目"一节）。

**`module` 模块说明** — 读源码文件，说明该代码块的职责与结构。导入项目的"模块结构图"策略（`import-analysis.md` 第 7 节）生成的节点就是它。
- 输入：`依赖(any)`；输出：`模块说明(text)`
- 控件：`path`（text 源文件**绝对路径**）、`symbol`（text 聚焦符号名，空 = 整个文件）
- 导入预填：脚本已把角色推断（入口/路由接口/数据模型/UI组件/服务/工具/测试…）、符号清单、导入与被依赖关系写进 `result`/`detail`，状态为 `pending`。
- 执行语义：读取 `path` 指向的源文件（截断至 400 行），结合 `detail` 里的结构摘要**验证并深化**说明：
  - `symbol` 为空：`result` = 一句话职责（≤80 字）；`detail` = 关键符号、对外接口、导入/被依赖；完整说明写入 `docs/modules/<相对路径>.md`。
  - `symbol` 非空：聚焦该函数/类——签名、输入输出、副作用、被谁调用；`result` = 它的职责一句话。
  - 写入 `docs/modules/<相对路径>.md` 时把该文件加进本节点的 `artifacts`（见"artifacts 交付物字段"）。
  - 文件缺失或读不了 → `failed` 并说明原因。**只产出理解与说明，不要修改源码**。

### 构建类（紫红 #a855f7）

**`codegen` 代码生成** — 核心编码节点。
- 输入：`需求/方案(any)`；输出：`代码(code)`
- 控件：`language`（select）、`dir`（text 目标目录，空=项目 src/）、`prompt`（textarea 生成要点）
- 执行语义：根据上游需求/方案在工作区真实写出代码文件。`result` = `生成 N 个文件`；`detail` = 文件相对路径清单。语言取控件值，缺省用项目语言。

**`edit` 代码修改** — 按说明修改既有代码。
- 输入：`代码(code)`、`任务(json)`；输出：`代码(code)`
- 控件：`instruction`（textarea 修改说明）
- 执行语义：读取上游涉及的文件，按 instruction/任务清单修改。`result` = `修改 N 个文件`；`detail` = 变更摘要（每文件一句）。

**`testgen` 测试生成** — 为代码写测试。
- 输入：`代码(code)`；输出：`测试(code)`
- 控件：`framework`（select：自动/pytest/unittest/jest 或 vitest/go test，默认自动）
- 执行语义：为核心模块写测试文件（放在 tests/ 或与源码同目录，遵循语言惯例）。`result` = `N 个测试文件，约 M 个用例`。
- **注意**：新建项目（NEW）阶段为自检跑过的测试**不代表** `testrun` 节点已执行——
  用户点「测试运行」时该节点仍是 `pending`，必须重新真实执行并回填，不得把之前的运行当成它的结果。

### 执行类（橙 #f97316）

**`testrun` 测试运行** — 运行测试并报告结果。
- 输入：`测试/代码(code)`；输出：`测试报告(report)`
- 控件：`cmd`（text，空=自动推断）
- 执行语义（v1.0 起逐条硬性要求，违反任何一条都算伪造/失败）：
  1. **工作目录 = 项目根**（`[CodeFlow:RUN_NODE]` 消息里的 `cwd`；没有时取 `graphPath` 的上一级），
     **不是工作区根**——在工作区根执行 `python -m unittest discover -s tests` 会 0 用例或直接报错；
  2. 命令取 `params.cmd`；为空时按语言推断（python：有 pytest 用 `python -m pytest -q`，否则
     `python -m unittest discover -s tests -v`；node：`npm test`）；
  3. **必须记录**：实际执行的命令、退出码、stdout/stderr 尾部（≤300 字写进 `detail`）；
  4. `result` 只能来自真实输出：如 `24 passed, 0 failed` / `exit 1 · 3 failed`；解析不出统计就写
     `exit 0 · N tests` 一类可从输出验证的摘要；
  5. 运行时缺失、命令不存在、超时 → `failed`，`detail` 写可行动原因（缺什么、怎么装）；
  6. **禁止未执行置 done**（尤其"之前跑过/已经通过"——用户点运行就是一次新的执行请求），
     禁止伪造通过。宿主会在回合结束时对账：没执行就结束回合 → 节点 `failed` + 画布「重试」。

**`shell` 命令执行** — 执行任意命令（谨慎）。
- 输出：`输出(report)`
- 控件：`cmd`（text 命令）
- 执行语义：执行控件中的命令，超时 120s。`result` = 退出码 + 输出首行；`detail` = 截断输出（≤300 字符）。画布在发送该节点运行请求时会提示用户确认。

### 质检类（绿 #22c55e）

**`review` 代码审查** — 审查代码并产出问题清单。
- 输入：`代码(code)`；输出：`审查报告(report)`
- 控件：`focus`（textarea 关注点，默认"正确性,安全,可读性"）
- 执行语义：阅读上游文件，按关注点输出问题列表（严重度/位置/建议）。`result` = `发现 N 个问题（高 x）`；无问题则 `done` + `未发现问题`。

**`fix` 问题修复** — 修复报告中的问题。
- 输入：`问题清单(report)`、`代码(code)`；输出：`代码(code)`
- 控件：`notes`（textarea 修复要求）
- 执行语义：按问题清单修复，能修则修，修不了的在 `detail` 说明原因。`result` = `修复 N / 共 M`。

**`docgen` 文档生成** — 生成项目文档。
- 输入：`代码(code)`；输出：`文档(text)`
- 控件：`format`（select：Markdown / 内联注释）
- 执行语义：Markdown→写 `README.md`；内联注释→为公共函数补 docstring/注释。`result` = 文档文件名或 `补充 N 处注释`。

### 输出类（琥珀 #eab308）

**`write` 文件写入** — 把上游产出落盘。
- 输入：`代码/文档(any)`；输出：`写入清单(report)`
- 控件：`dir`（text 目标目录，空=项目根）
- 执行语义：确保上游产出已写入磁盘（若上游已直接写盘则核对存在性）。`result` = `已就绪 N 个文件`；`detail` = 路径清单。

**`deliver` 交付打包** — 终点节点：汇总交付并调用原生 `present`。
- 输入：`成果(any)`；输出：`交付说明(text)`
- 控件：`notes`（textarea 交付要求）
- 执行语义（v0.5.0 起，按以下顺序执行）：

  1. **收集交付物**：沿入线向上游做传递闭包，收集所有上游节点的 `artifacts`（去重）。
     若上游没有 `artifacts`（常见于导入项目），退化为扫描项目目录：扫描根 = 新建项目的项目目录
     （默认 `<工作区>/CodeFlow/flow-projects/<project>/`），
     导入项目 = 图里 `meta.importedFrom`；包含项目根、`src/`、`app/`、`lib/`、`tests/`、`docs/` 等常见目录；
     跳过 `.git`、`.undo`、`node_modules`、`venv`、`.venv`、`__pycache__`、`dist`、`build`、`target`、`coverage`、`.next`；
     跳过 `workflow.json`、`session.json` 等 CodeFlow 元数据；跳过 `.env`、`*.pem`、`*.key`、`id_rsa*`、
     `credentials*` 等敏感文件；最多 20 个，优先 README、入口文件、配置、测试、文档。
     **对每个候选逐个验证**：必须是存在的普通文件；目录、符号链接、缺失文件全部丢弃，
     缺失的要记录，不要静默。
  2. **写 `docs/DELIVERY.md`**：项目状态、文件树、如何运行、已知问题、测试结果，并新增"交付物清单"一节，
     逐条列出最终 `artifacts` 路径与一句话说明。不写源码，不写密钥。
     写完后把 `docs/DELIVERY.md` 本身加入交付物清单，作为第一个交付项。
  3. **调用原生 `present` 工具**：`files: [{path, description}]`，`description` 用中文一句话
     （如"交付说明""程序入口""测试"）。只提交**已验证存在的普通文件**；
     路径用会话工作目录相对路径或绝对路径（工作区外必须绝对路径）。
     优先级：`docs/DELIVERY.md` → README → 入口文件 → 配置 → 测试 → 其他。
     DSH `present` 单次最多 8 个文件：超过时提交最重要的 8 个，其余在画布交付物清单和 `DELIVERY.md`
     里完整列出，最终回复明确说"另有 N 个文件已在画布/DELIVERY.md 列出"。
     不要为凑数提交无关文件。若当前会话没有挂载 `present`（工具不存在/调用报错），按失败规则处理。
  4. **回填节点**：
     - 成功：`status:"done"`；`result:"交付就绪 · N 个文件 / 已提交 M 个卡片"`（≤80 字）；
       `detail` 交付物路径清单（≤400 字）；`artifacts` 全部已验证文件（≤50）；
       `presented` 实际提交给 `present` 的路径数组。
     - 没有任何可交付文件 → `failed`，`result:"没有可交付的文件"`，`detail` 说明扫描/验证结果。
     - 文件已生成但 `present` 失败/不可用 → `failed`，`result:"交付物已生成，卡片提交失败"`，
       `detail` 给可行动原因（例如"present 工具不可用"），`artifacts` 仍保留。**不要伪装 done。**
  5. **最终回复**：一句话说明交付了什么、卡片在哪里看（会话里的交付卡片，点开右侧栏预览）、如何运行；
     若 `present` 失败，明确告诉用户文件仍已生成及路径。

## 布局建议（agent 生成图时）

- 新建项目默认链：`requirement → design → codegen → write → testgen → testrun → review → deliver`
- 导入项目默认链：`scan → comments → (任务节点 edit/codegen/testgen …) → review → deliver`
- 导入项目"模块结构图"：`scan → 各 module 节点`（按依赖深度从左到右分层，依赖在左、被依赖在右；
  核心文件的符号子节点挂在其文件节点右下）
- 节点横向间距 ≥ 90px，纵向间距 ≥ 40px；可用画布"整理布局"的分层规则预估位置。
