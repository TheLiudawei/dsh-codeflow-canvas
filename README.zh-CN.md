<p align="center"><img src="assets/branding/logo.svg" width="96" height="96" alt="CodeFlow 工作流画布 logo"></p>

<h1 align="center">CodeFlow 工作流画布</h1>

<p align="center"><b>把 agent 的编码过程变成一张可审、可回退的图。<br/>每个节点是一个真实任务，每条连线是一条数据流依赖，每个绿灯都是一个证据。</b></p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-3da639"></a>
  <a href="https://github.com/TheLiudawei/dsh-codeflow-canvas/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/TheLiudawei/dsh-codeflow-canvas/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-1.5.0-4f46e5">
  <img alt="Platform" src="https://img.shields.io/badge/platform-DSH%20desktop-2ea043">
  <img alt="Dependencies" src="https://img.shields.io/badge/npm%20dependencies-0-brightgreen">
  <img alt="Build" src="https://img.shields.io/badge/build-none%20required-lightgrey">
</p>

<p align="center">
  <img src="docs/images/canvas-tasks.png" alt="CodeFlow 画布：任务流水线视图" width="92%">
  <br/>
  <sub>一次确定性扫描，同时产出这条 8 节点任务流水线和 22 个模块的结构图——零 LLM token。</sub>
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

---

CodeFlow 是面向 DSH（DeepSeek Harness）的编码工作流画布。导入一个仓库，它变成一张节点图——画布形态是 ComfyUI 风格的。每个节点是 agent 在你的工作区里执行的任务，每条连线是依赖。真正把它和别人区分开的不是图本身，而是**这张图被允许声称什么**。

它是 DSH 插件，从 ZCode 插件 `codeflow-canvas` v0.2.2 迁移而来。画布编辑器沿用原实现；会话、工具协议、持久化、交付、撤销这一整套宿主接线全部为 DSH 重写。

> 截图是中文界面——画布跟随 DSH 的语言与主题。它自带深/浅两套调色板，随宿主实时切换。

## 问题在哪

你让 agent 给 8 个文件加校验，它回你一句「完成了」。

然后问题才开始：哪 8 个？都过了吗？有没有动你没让它动的地方？万一改坏了，要退回到哪一步？**这些答案只以散文形式留在对话记录里，而散文不是 diff。**

## 画布改变了什么

| | 在对话里排计划 | CodeFlow 画布 |
| --- | --- | --- |
| 计划从哪来 | 每次都由模型重新生成 | 从代码树算出来：扫描、符号提取、注释标记。不调模型、不耗 token、不联网 |
| 哪里失败了、为什么 | 只能从对话里回溯拼凑 | 落在具体节点卡片上，带原因，而且节点会停下 |
| 「它说完成了」 | 只能选择相信 | 回合结束没有进度回报 → 对账为 `failed` |
| 改坏了怎么退 | 手动 git 操作，容易误伤 | 每次运行前自动快照；一条命令同时回滚文件与节点状态 |
| 交付物 | 散落在聊天记录里 | 原生 `present` 卡片 + `docs/DELIVERY.md` |

## 对话记录做不到的三件事

**1 · 导入不经过模型。** `/flow-import` 与导入对话框在本地扫描代码树——语言识别、符号、`TODO`/`FIXME` 标记——秒级产出任务流水线与模块结构图。同一提交扫描两次，任务、文件、评分完全一致，因为没有任何东西是编出来的。 → `lib/importer.js`、`lib/analyst.js`、`lib/duo.js`

**2 · 撤销一次运行，而不是一个文件。** 每次 `RUN_NODE` / `RUN_ALL` 前都会快照项目树（排除 `node_modules`、`dist`、`.git` 等）。「撤销运行」把文件**和**节点状态一起恢复，严格 LIFO，DSH 重启后仍可用。恢复之前会先备份当前状态——所以恢复永远不会毁掉它覆盖掉的东西。 → `lib/undo.js`

**3 · 绿灯是有含义的。** prompt 入队时节点才变 `running`，只有 agent 真回报了才到 `done`。回合结束仍无进度 → 宿主标 `failed`（"agent 未执行该节点"）并给一键重试。**绝不从 agent 的说法推断结果。** → `lib/gestures.js`（乐观置 `running`）、`lib/index.js`（回合结束对账）、`lib/activity.js`

## 实测，不是口号

`npm run bench` 用一份固定的合成夹具（60 个模块、13.9 KB）跑**真实的导入命令**与**真实的撤销管理器**，输出下表。夹具由纯函数生成——同一份文件、同样的内容，在任何机器上都一样——而且只要确定性或撤销不再成立，这次运行就会**失败**，所以这些数字不会悄悄烂掉。

| 实测项 | 数值 |
| --- | --- |
| 导入（冷 / 热） | ≈90 ms / ≈70 ms（多次运行 65–120 ms） |
| 导入期间唤醒 agent 次数 | 0 |
| 导入消耗的 prompt token | 0 |
| 产出的任务 / 模块节点数 | 9 / 39 |
| 由 TODO / FIXME / HACK 生成的任务 | 5 |
| 两次独立导入的分析字段一致数 | 48 / 48 |
| 撤销校验（逐字节还原、新增文件移除、报告准确） | 4 / 4 |

绝对耗时来自作者机器，你的会不同；**两个 0 和一致计数不会**。

作为对照：在对话里写计划，模型至少要先读完源码才能开始——这里是 13.9 KB，**约 3.5k token（chars/4 估算）**。这一行是估算，并已明确标注；表里其余每一行都是实测。复现：`npm run bench`（加 `--json` 输出机器可读格式）。

## 1.5.0 变更

「先写要求、执行完由宿主自动认出类型」——把「添加节点时先选类型」这步从用户肩上卸下来。

- **添加入口收敛为一个「新建任务」框。** 双击空白 / 右键菜单 / 视图菜单都只弹一个「要求」输入框
  （空要求禁用提交）；节点以第 17 类 `task` 落图（`meta.cf.task:true` 结构标记，端口固定 `any → any`）。
  旧的类型列表 UI 没有删除——抽成通用类型选择器，供节点右键「设置类型…」复用。
- **运行后自动识别，零 LLM。** 回合结束时宿主用纯脚本判断这次实际改了什么：`lib/typing/classify.js`
  是唯一规则表（有证据才产出 `codegen / edit / testgen / docgen / testrun / shell` 六类），归属按
  「该节点自己的写文件工具路径 ∪ `artifacts`」∩ 本次 diff 计算——归属不到不猜，无文件改动保持 `task`。
  识别不调用模型、不产生额外 agent 回合、不新增工具。识别结果写进 `meta.cf.typeAuto`（来源、规则 id、
  时间、计数与最多 3 个样例路径，≤400 字节），节点颜色/标签随之变化，但**端口与连线永远不变**——
  `typeOf` 在画布侧是「显示类型 + 结构档案」的唯一合并点。
- **人工干预三条路。** 右键任务节点：设置类型…（手动 + 锁定，自动识别不再覆盖）、清除类型（回 `task`）、
  自动识别（按最近一次运行的证据重识别，无证据提示「下次运行后自动识别」）。详情里能看到识别来源与
  依据摘要，还能直接编辑「要求」。
- **撤销连类型一起回滚。** 运行快照的节点记录增加 `type` 与识别状态；撤销把文件、执行状态与自动识别
  一起恢复，其余 `meta.cf` 键（如失效卡片标记）不被整块覆盖。
- **新套件 `tests/typing`**（CI 现在 19 个套件）：判定矩阵、两节点归属互不串味、锁定与幂等、
  `reidentify` 门禁、撤销回滚（真 store + 真 undo + 临时目录）。

## 1.4.2 变更

- **对比表现在有实测数字了。** `tests/bench.mjs`（`npm run bench`）把一份固定的 60 模块夹具喂给**真实的 `/flow-import` 命令**与**真实的撤销管理器**，输出导入耗时、agent 唤醒次数、prompt token、产出的任务/模块数、两次导入的一致性与撤销保真度。只要确定性或撤销不再成立，它就返回非零退出码——所以这张表不会悄悄过期。
- **它刻意不测什么：** 模型在对话里写同样的计划会花多少 token。这里没人测过，所以 README 只给出一个**标明来源的下界**（源码字节 / 4），而不是编一个节省百分比。

## 1.4.1 变更

只动文档，没有代码变更。

- **首屏从"描述形态"改成"陈述立场"。** 开头先讲问题（"它说完成了——哪 8 个文件？改坏了怎么退？"），接一张五行对比表（对话里排计划 vs 画布），再给三条"对话记录做不到"的声明——每条都标出对应的代码文件（`lib/importer.js`、`lib/undo.js`、`lib/gestures.js` + `lib/index.js`）。
- **对比表里没有一个编造的数字。** 每一行都是能在源码里读到的行为——这正是这个插件的立场：没有证据的声明，就是它想解决的问题。

## 1.4.0 变更

产品门面上的可见变化——正因如此它值得一个自己的版本号。

- **字符字形退役，CodeFlow 有了正式标识。** 侧栏图标、工具栏 logo 与空状态原先画的是 `⬡`——一个在每台机器上渲染都不一样的文本字形。三处现在共用同一枚矢量标（六边形画布被流程通道切开），由 `tools/port-canvas.mjs` 内联绘制（工具栏 17px、空状态 46px），侧栏用 `currentColor`，悬停与选中色仍由宿主决定。
- **`assets/branding/` 是唯一事实来源**：`logo.svg`（彩色）、`logo-on-light.svg`、`logo-mono.svg`（currentColor），以及 32/64/128/256/512 的 PNG，供商店、文档与社交卡使用。
- **两份 README 都以该标识开头**，`docs/images/social-preview.png`（1280×640）已备好用于仓库社交卡。
- **版本纪律现在由测试强制。** 当 `package.json` 没有领先最近标签而又有未发布提交时，`tests/release.mjs` 直接失败——正是让 `feat` 提交停在 `v1.3.2` 之后的那种状况。它跑在 CI（checkout 已改为 `fetch-depth: 0`）与 `npm test` 里。

## 1.3.2 变更

卡片身份更严格了，另外修掉两个由 CI 矩阵抓出来的缺陷。

- **只有「像路径」的 token 才能成为源锚点。** 旧规则接受任何带小数点的片段，于是 `v1.2.3`、`3.5`、`https://example.com/x.md`、`e.g.` 都会变成锚点——两张无关的卡片可能配到一起，或者同一张卡片换个导入就配不上了。现在 token 要么含分隔符，要么命中已知源码扩展名（`SOURCE_EXTENSIONS`，约 90 项）；带 scheme 的 URL、版本号/纯数字、缩写、时间戳一律排除。五条反例与七条正例都在 `tests/cards.mjs`。
- **漂移的卡片退回 `pending`。** 源码在导入后变过，旧的「完成」就不再是当前状态的证据：卡片退回 `pending`（与「未执行即失败」同一口径），detail 记一条「源码已变，需重跑」，画布上挂琥珀色徽章，重跑后徽章自动消失。没有漂移则什么都不动。
- **`npm test` 改为 `tests/run-all.mjs`。** 顺序 spawn、收集退出码、末尾一张带耗时的汇总表——与 CI 的 `if: always()` 对齐，失败的套件不再掩盖后面的套件。
- **撤销能识别同尺寸修改。** `files.modified` 原先按 size 加 1ms 的 mtime 容差判定；同尺寸改动若落在同一毫秒内，Linux 上会被判成「未修改」。`dryRun` 与 `restore` 现在在这种模糊情形下按内容兜底。
- **临时目录清理加重试。** `rm(recursive)` 在 macOS 上偶尔抛 `ENOTEMPTY`——插件去抖落盘把文件刚放回去；`validate` 里的递归删除改为短退避重试，不再因竞态整轮标红。

## 1.3.1 变更

没有新功能——这一版让测试套件在**别人的机器上**也可信。

- **CI 三平台跑 19 个套件。** `ubuntu-latest` / `windows-latest` / `macos-latest` × Node 22，全部阻塞。每个步骤都带 `if: always()`：一个套件红了其余照跑，一轮就能看全貌。
- **修了一个真实的几何 bug。** `fit-popover` 的最小高度写成 `Math.min(minListHeight, Math.max(minListHeight, innerH))`——恒等于 `minListHeight`，极矮 stage 下仍然要 96px，把列表顶出下边界。现在改为 `Math.min(minListHeight, innerH)`，并在分支后把 `maxHeight` 夹到可用高度；对应测试也真正触达该边界（stage 100px、内高 84px）。
- **测试不再依赖检出方式。** 以 `\n` 为锚点的断言在 CRLF 检出下失效（`.gitattributes` 已统一 LF，共享 `read()` 也做归一）；一条只在 Windows 成立的断言删除，改为显式的 win32 / POSIX 两条；四条 `/flow-import` 检查原先靠 `%TEMP%` 里的残留目录才通过，已 hermetic 化；workspace 与 browse 套件里的 Windows 路径断言改为显式传平台。修复了 [#2](https://github.com/TheLiudawei/dsh-codeflow-canvas/issues/2) 报告的两项失败。
- **画布新鲜度改用内容哈希。** 生成器把输入源哈希写进画布头部（`tools/canvas-sources.mjs` 是唯一清单），按钮审计重算比对——mtime 在全新检出里根本不成立。
- **`npm test`** 一次跑完 19 个套件。

## 1.3.0 变更

- **顶栏重构为「命名菜单 + 主操作」布局。** 现在是 `logo · 项目/运行/视图/帮助 · 视图 tab · 新建/导入/运行全部 · 撤销/保存/设置图标`，`flex-wrap: nowrap`——任何宽度都不换行；<720px 时四个菜单收进 `☰` 分组面板，**折叠态与展开态出自同一份模型**（`lib/ui/menu.js` → `lib/ui/menu-html.js` 构建期渲染成静态标记；`tools/patches/menu-ui.js` 只做事件委托，经一张 action key → 现有函数的查表复用同一份处理逻辑）。全键盘可用（↑/↓/Home/End/Esc），ARIA 完整。
- **二级节点列表永远完整落在画布内。** 位置与高度由纯函数 `lib/ui/fit-popover.js`（构建期内联，单一实现）按 stage 可用空间反推：480px 高度 + 200 节点也能滚到最后一行，搜索框始终可见，列表滚轮不再带动画布缩放，左侧分类栏自身也可滚动。
- **任务卡片重新导入不丢失（默认关闭）。** 首次打开画布按工作区询问一次（`cards.asked` 写入 `CodeFlow/config.json`）。开启后重新导入同一项目按稳定标识合并（`lib/cards/identity.js`）：运行状态、结果、位置、改过的标题/参数都附着到新扫描的图上；源码中已删除的任务保留为「失效卡片」（不参与运行全部，可从项目菜单一键清理）；合并是纯函数（`lib/cards/merge.js`），失败只警告绝不阻断导入。关闭时行为与 1.2.2 一致（覆盖 + `.bak-` 备份）。
- **设置里可看工作日志。** 设置 → 查看工作日志（或「帮助」菜单）打开只读查看器：级别过滤、大小写不敏感搜索、跟随尾部（2 秒轮询，关闭即停）、复制可见原始 JSONL 行、打开所在目录（宿主无能力时降级为复制路径并明确提示）。底层是 `GET /api/log`（tail/rotated/level/q；文件路径在装配时绑定，请求参数指不到别处）与 `lib/logging/reader.js`。

## 1.2.2 变更

- **画布所有可点击控件都有清单、有绑定、有审计。** 数据清单 `lib/ui/actions.js`（73 个控件）是单一事实来源：`tests/buttons.mjs` 静态证明每个控件都登记且至少有一条绑定路径；生成器注入的 `window.__CF_ACTION_MANIFEST__` 供画布内真实点击自检脚本（`tests/buttons/canvas-selftest.js`）使用；其余路径由 `tests/buttons/MANUAL-CHECKLIST.md` 逐项验收。审计揪出并修复了四个真实缺陷：**「耦合分析」工具栏按钮从未绑过 click**（HTML 里 disabled、只能从右键进入，永远点不动）；**会话 chip 是可聚焦但无动作的假按钮**（现在点开「画布专用会话」）；**拖拽确认/进度/冲突三个对话框的 ✕ 是死按钮**——对话框的 close/cancel 现在由 `#cf-dialog` 上的一次事件委托统一兜底。 按钮修好后立即暴露出下一个潜伏缺陷：分析**成功后**的刷新链调用了一个拼错的函数名（`fetchCouplingStale`），宿主已写图成功、画布却弹「耦合分析失败」——已修复，且 `tests/buttons.mjs` 新增 undefined-symbol 检查：任何被调用却从未定义的标识符直接红。
- **外壳套外壳的导入找到真实项目根。** 三条导入通道（拖拽压缩包、拖拽文件夹、路径/对话框导入）都走同一个保守根解析器（`lib/import/root-detect.js`）：压缩包先按既有语义剥最外层，之后只有「项目标记 / 明显外壳名 / 与父同名」才继续下钻。`proj/src` 必须保留 `proj`；无标记的单链外壳直接 `400 SHELL_AMBIGUOUS`，绝不生成项目名/根目录错误的项目；空壳 400；多项目父目录保留父目录并记 `multiProject` 警告。`tests/import-shells.mjs` 覆盖 51 个「夹具 × 通道」组合。
- **工作与报错日志。** 插件在安装目录写 JSONL 文件日志 `codeflow.log`（5 MiB 轮转、保留一个 `.1`、串行写、失败降级不崩）：记录插件生命周期、导入（`import.start/root/done/…`）、耦合分析、HTTP 错误与画布 UI 动作/报错——绝不记录提示词、源码、图 JSON、Cookie/Token（按键名脱敏 + 截断）。画布侧通过 `POST /codeflow/api/log` 批量上报（白名单 `ui.action/ui.error/ui.selftest`、64 KiB 上限、50 条/秒、单批 20 条）。`CODEFLOW_LOG=off` 关闭；`CODEFLOW_LOG_FILE` 覆盖路径。新增架构测试（`tests/architecture.mjs`）钉住分层：logging/root-detect 零领域依赖、导入管道不接触 `req/res`、静态 import 图无环。

## 1.2.1 变更

- **新建项目必须先选真实存在的 DSH 工作区（Issue #1）。** 新建对话框新增**工作区下拉**（数据来自只读的 `GET /codeflow/api/workspaces`），下方只读预览最终绝对路径（`将创建到 …`，由宿主计算）。请求缺 `workspace`、或所选目录不是已登记工作区时，直接 `400` / `409`，磁盘上什么都不多出来。
- **工作区寻址只剩一条显式链（Issue #2）。** 绑定（store/侧车）→ 项目目录 → 会话 cwd，逐档对工作区注册表做最长前缀匹配；解析不出就硬失败并给出候选清单。旧的「注册表第一个工作区」回退——「乱窜」的根源——已删除。
- **画布会话真正归属工作区。** 宿主提供工作区实体时，专用会话以 `workspaceId` 创建并被 attach 进该工作区分组，不再落进「未分组」。
- **导入新增目录树选择器。** 导入对话框路径框右侧新增**浏览…**，底层是只读的 `GET /codeflow/api/browse`（只列目录、不跟符号链接、单层 500 项、5s 超时）。键盘优先：↑/↓ 选择、Enter 进入、Backspace 上一级、Esc 先关选择器。对话框同时显示「将扫描」（源码目录）与「项目文件保存在」（图文件的工作区落点）。

## 截图

<table>
<tr>
<td width="50%"><img src="docs/images/canvas-modules.png" alt="模块结构图与耦合徽章"><br/><sub><b>模块结构图。</b>每个文件一个节点，各自带 低/中/高 耦合徽章。</sub></td>
<td width="50%"><img src="docs/images/coupling-detail.png" alt="耦合分析详情"><br/><sub><b>耦合详情。</b>逐模块分数、扇入 Ca、扇出 Ce、成环与符号数——确定性、可复现。</sub></td>
</tr>
<tr>
<td width="100%" colspan="2"><img src="docs/images/module-nav.png" alt="可搜索的模块导航"><br/><sub><b>导航。</b>点模块分类弹出可搜索的二级列表；↑/↓/Enter 选中并缩放定位。</sub></td>
</tr>
</table>

## 核心能力

- **双视图、一次导入。** 一次扫描同时产出**任务流水线**（`workflow.json`）与**模块结构图**（`workflow.modules.json`）。工具栏分段控件随时切换——不重扫、不重分析、不唤醒 agent。两个视图的节点、坐标、运行状态与 `rev` 完全独立。
- **耦合分析（v1.2）。** 为每个文件级模块计算内部/外部耦合：`score = round(0.6 × intra + 0.4 × inter)`，按固定阈值 30 / 60 分级。画布上每个节点带徽章，左上角一张整体「屎山程度」卡片，点开是逐模块表格。算法常量全部导出并可单测；同一份源码两次分析结果逐字节一致。
- **功能归属索引（v1.1）。** 在图文件旁边生成 `features.json`，把「功能 → 文件 → 节点」做成确定性映射：解析设计文档、入口信号、顶层符号、目录/文件名词典。零模型调用；`manual` 段永远优先，且重建时原样保留。
- **拖拽导入（v1.2）。** 把文件夹或压缩包拖到画布上即可导入。文件夹走递归上传 + 暂存区一次 rename 落地；`zip` / `tar` / `tar.gz` 用纯 Node 解析，`7z` / `rar` 降级到系统工具。
- **执行过程可见。** 运行中的节点卡片显示当前动作、思考摘录、步骤数与耗时；右上角有可折叠监视器。模型不给 reasoning 流时降级为步骤摘要——绝不编造。
- **没执行就是失败。** 运行请求自包含（目标节点、上游结果、工作目录、验收标准）。回合结束时 agent 没有回报进度，宿主直接把节点置 `failed` 并给出一键重试。
- **原生交付。** `deliver` 节点收集上游产物、写 `docs/DELIVERY.md`、调用 DSH 原生 `present`，交付物在会话里是真实卡片，而不是画布里的一个清单。
- **按次撤销。** 每次运行前快照项目源码树。可整次回退（文件 + 节点状态），严格 LIFO，DSH 重启后仍可用；恢复前先备份当前状态。
- **每项目专用会话。** 每个项目一个持久会话（`CodeFlow · <项目>`），画布的运行只进该会话，不会劫持 DSH 当前会话。
- **改代码高亮模块。** agent 真的写了文件时（从 `edit`/`write`/`apply_patch` 等工具参数提取，绝不猜对话文本），对应模块脉冲高亮并挂上徽章。
- **17 种节点、端口有类型。** 连线按端口类型校验（`text` / `json` / `code` / `report` / `file` / `any`）；改参数会自动重置下游。
- **添加任务，运行后自动识别类型。** 双击空白只写「要求」，agent 执行完由宿主纯脚本认出这次改的是什么
  （改代码 / 新建代码 / 写测试 / 写文档 / 跑测试 / 跑命令）——识别不经过模型、不花 token；类型只影响
  颜色与标签，端口和连线永不变化，可手动锁定或清除。
- **零构建、零依赖。** `package.json` 没有任何运行时依赖。宿主半侧是普通 ESM，浏览器半侧是手写的 `__ModuleLoader__` bundle。

## 安装

```bash
# 从本地目录安装 —— 不需要构建
dsh plugin --profile desktop add link:<本目录的绝对路径>
```

或在「设置 → 插件」里安装本地目录，然后**重启 DSH**（宿主半侧不参与热重载）并刷新页面。

确认是否生效：

```bash
curl -i http://127.0.0.1:<端口>/codeflow/canvas   # 期望 200 + HTML
```

如果返回 404，且 `profiles/<profile>` 下 grep 不到 `codeflow`，说明插件没装进该 profile——重新执行上面的安装命令并重启。

**前提：** DSH 桌面端提供 `sessionController`（运行节点需要）。没有它，画布仍可编辑、导入、保存，但运行会给出明确错误，而不是随便绑一个会话。

## 用法

| 入口 | 作用 |
| --- | --- |
| `/flow` | 打开画布（载入最近项目）；带参数时按该需求建项目 |
| `/flow-new [需求]` | 直接新建项目 |
| `/flow-import <路径>` | 导入项目：宿主扫描并秒级产出两张图，不经过 agent。支持 `@` 选择、`~`、引号与 `file://` |
| `codeflow_canvas` 工具 | agent 的回填通道：`load`（从磁盘重读该视图的图，首选）、`render`（后备）、`read`、`save`、`progress`（仅专用会话）。`view: "tasks" \| "modules"` 指定视图 |
| 技能 `codeflow-canvas` | agent 的编排契约（新建/运行/回填/交付）；`/flow*` 会自动带上 |
| `node lib/importer.js <路径>` | 命令行独立导入——两张图，不需要 DSH 在跑 |

### 运行一个节点

右键节点 →「运行」，或工具栏「运行全部」。宿主先快照项目，把自包含的 `[CodeFlow:RUN_NODE]` 消息投给该项目的专用会话，并立即把节点置为 `running`。agent 执行并回报进度，卡片随之更新。

## 工作原理

```
浏览器（面板 iframe）
  ├── GET  /codeflow/canvas          宿主组装片段 + __CF_BOOT__
  ├── GET  /codeflow/api/state       轮询；rev 变大则替换该视图的图
  ├── POST /codeflow/api/state       自动暂存（expectedRev 冲突 → 409）
  ├── POST /codeflow/api/view        切换激活视图（不 bump rev、不扫描）
  ├── POST /codeflow/api/save        双视图落盘（失败 507 + ok:false）
  ├── POST /codeflow/api/import      确定性扫描 → 任务流水线 + 模块结构图
  ├── POST /codeflow/api/action      运行/新建 → 快照，再投递 [CodeFlow:*]
  ├── POST /codeflow/api/session     新建或重建项目的专用会话
  ├── GET  /codeflow/api/workspaces  已登记工作区清单（只读；新建下拉的数据源）
  ├── GET  /codeflow/api/browse      只读目录浏览（导入选择器；只列目录、不跟链接）
  ├── GET  /codeflow/api/activity    思考流、步骤、进度、文件编辑（纯内存）
  ├── GET/POST /codeflow/api/undo    运行历史 / 恢复（LIFO，跨视图共用）
  └── GET/POST /codeflow/api/config  项目根：全局根 + 单项目覆盖
                                        ↓
          agent 按技能执行 → codeflow_canvas（progress / load / render）
                                        ↓
  store.js（按视图的 rev）+ paths.js（唯一的项目路径拼装点）
  sessions.js（会话绑定）+ activity.js（内存过程缓冲）+ undo.js（.undo/ 快照）
```

几个关键取舍：

1. **画布跑在 iframe 里。** 它在 `window` 上挂了 `keydown`（Delete、空格）与指针事件；放进宿主文档会抢走输入框按键。
2. **`rev` 归宿主管、按视图独立。** 写一个视图永远不会 bump 另一个视图，在任务图里编辑不会被模块图的后台更新打断。
3. **整图不经工具参数搬运。** agent 改图文件后调 `load`；超长嵌套 JSON 塞进工具调用会触发 `tool input is invalid JSON`，直接毁掉整个回合。
4. **过程数据只在内存。** 每项目环形缓冲（≤500 条 / 256 KB），不落盘、不进日志。
5. **撤销只碰快照范围。** `node_modules`、`dist`、`.git` 之类永远不会被误删。
6. **绑定只有一个写者。** `sessions.js` 是唯一创建/重绑项目会话的组件。

## 项目目录

项目落在 `<工作区>/CodeFlow/flow-projects/<项目名>/`（`workflow.json`、`workflow.modules.json`、`view.json`、`features.json`、`session.json`）。**工作区本身由用户选定**：新建项目必须从 DSH 已登记的工作区里挑一个，插件绝不创建、不登记工作区根目录；宿主提供工作区实体时，画布专用会话一并归属该工作区。根目录可配置——工具栏 **⚙ 设置**里设全局根，也可以给单个项目覆盖，配置存在 `<工作区>/CodeFlow/config.json`，换根之后仍按工作区可发现。旧版 `<工作区>/flow-projects/` 数据首次解析时自动迁移；冲突不覆盖，失败保留旧目录。工作区解析只走一条显式链——**绑定 → 项目目录 → 会话 cwd**，逐档对注册表做最长前缀匹配；解析不出就报错并给候选清单，绝不悄悄落到别处。

```
lib/core/        fsio / path / text 基础层（原子写、宽容 JSON、有界读）
lib/scan/        walk / comments / symbols —— 共享扫描层
lib/features/    features.js 背后的六片职责子包（detect、dictionary、index-file、apply、map、ops）
lib/http/        respond / context / canvas / state / import / features / project / workspace / browse 路由
lib/paths.js     唯一的项目路径拼装点
lib/workspace-binding.js  工作区解析（B1 链）+ 注册表适配器（全插件唯一读注册表的地方）
lib/browse.js    只读目录浏览（纯函数 + fs 适配）
lib/store.js     双视图图状态、按视图的 rev、清洗
lib/coupling.js  耦合算法（常量导出供测试）
lib/importer.js  确定性导入（任务流水线）+ CLI
lib/analyst.js   结构分析（模块结构图）
lib/routes.js    薄路由装配
lib/index.js     插件入口 —— 纯装配
assets/canvas/   canvas.html（由 tools/port-canvas.mjs 生成，勿手改）
assets/skill/    技能文档 + 四份 references
tests/           validate / regression / e2e / undo / coupling / features / drop-import / workspace / browse / contrast
```

## 开发

```bash
# 一次跑完 16 套（普通 Node 即可；DSH 不需要在跑）
npm test

# 也可以单跑——同一命令换成 DSH 二进制当运行时同样可用
node tests/validate.mjs
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tests/validate.mjs

# 改了迁移脚本后重新生成画布（不要手改生成物）
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tools/port-canvas.mjs

# 客户端 bundle 的加载契约校验
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" tools/verify-client-bundle.mjs .
```

改 `lib/*.js` 需要重启 DSH；改 `lib/client.js` 刷新页面即可。

### CI 到底覆盖了什么

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在 **Ubuntu / Windows / macOS 三平台**（Node 22）跑 **19 个套件**，三平台均为阻塞（红了就是失败）：

| 覆盖范围 | 套件 |
| --- | --- |
| 结构、路由、工具、画布资产、XSS | `validate`（184 项） |
| 逐项修复回归（B2–B9、并发、原子写） | `regression` |
| 重导入合并、失效卡片、关闭开关的原行为 | `cards` |
| 菜单模型、ARIA、构建期渲染、弹层几何 | `menu` |
| 分层与静态 import 无环 | `architecture` |
| 日志 schema、脱敏、轮转、降级 | `logging` |
| 运行快照、LIFO、跨视图恢复 | `undo` |
| 任务节点运行后自动识别类型（零 LLM 规则表、归属、锁定、撤销回滚） | `typing` |
| 耦合评分确定性与持久化 | `coupling` |
| 功能索引构建与重建稳定性 | `features` |
| 工作区解析链 | `workspace` |
| 只读目录浏览的条数上限与超时 | `browse` |
| 保守导入根识别（51 组组合） | `import-shells` |
| 日志查看器过滤/搜索/跟随/路径绑定 | `log-viewer` |
| 文件夹与压缩包暂存、解压、重名冲突 | `drop-import` |
| 真实 HTTP server + fetch 场景 | `e2e` |
| 控件清单、绑定、动作审计 | `buttons` |
| 版本纪律：`package.json` 领先最近标签 | `release` |
| 实测基准：导入成本、确定性、撤销保真 | `bench` |

**哪些没有自动化保障**（下面这些不会被 CI 覆盖，文档也不假装覆盖）：

- **需要真实 DSH 宿主的一切**：真实会话创建、agent 实际执行、实时思考流、原生 `present` 交付、跟随系统主题。套件用的是假宿主——**契约**被测了，**集成**没有。
- **面板 iframe 里的真实浏览器行为**：输入法组词、触控板捏合缩放、Space/Delete 按键处理、从 Finder/资源管理器原生拖入。`tests/mac/` 正是为这类问题准备的**人工诊断套件**（见其 README），需要装好的 DSH 和人来跑。
- **交给系统工具的压缩格式**：`7z` / `rar` 只在装有对应工具时才能验证；`zip` / `tar` / `tar.gz` 由纯 Node 解析，已被覆盖。
- **`tests/contrast.mjs`** 是被其他套件引用的模块（浅色调色板 WCAG 审计），不是独立套件。
- **画布新鲜度**用*内容*哈希判定，不是 mtime：生成器把输入源哈希写进画布头部（清单的唯一事实来源是 `tools/canvas-sources.mjs`），`buttons` 重算比对——全新检出里过期生成物同样会被抓住。

## 与 ZCode 版的差异

| ZCode v0.2.2 | 本插件 |
| --- | --- |
| `::visualize{}` 会话内嵌 Gen UI | 侧边栏原生面板（iframe） |
| agent 生成画布 HTML | 宿主组装文档，agent 只提交图 |
| `window.zcode.sendFollowUpMessage` | `POST /codeflow/api/action` → 专用会话 |
| `setWidgetState`（16 KiB 上限） | 宿主状态 + 落盘，无上限 |
| `widgetState.rev` 比较 | 宿主持有 `rev`，按视图独立 |
| markdown 命令文件 | `ctx.commands.register` 注册的真命令 |
| `.zcode-plugin/plugin.json` | `package.json` + `cordis.patch.yml` |
| 只有深色 | 深/浅两套调色板，跟随 DSH |
| — | 专用会话、实时过程、原生交付、运行撤销、耦合分析、功能归属、拖拽导入 |

## 已知限制

- **新建项目要求已登记的工作区。** 未在 DSH 里登记的目录不能作为新建落点——插件直接拒绝并给出可用清单（不静默降级注册、不写 DSH 的工作区数据）；请先在 DSH 左侧栏添加该工作区。
- **导入需要能解析出图文件的落点工作区。** 源码目录可以是磁盘上任意目录，但图文件落在当前工作区之下；全新安装、还没有任何绑定时，导入会说明该怎么做，而不是猜一个位置。
- **浏览选择器只列目录。** 不显示文件、大小或内容；符号链接与 junction 一律不进入、不列出；单层最多 500 项、5s 超时保护慢速/掉线的网络位置。Windows 除符号链接/junction 之外的 reparse tag 在不引原生模块的前提下无法枚举。
- **修改高亮只认真实写文件工具。** 通过 `shell` 重定向或脚本间接写文件不在范围内，也不猜。
- **未纳入图表的文件不高亮。** 只给一次"修改了未纳入结构图的文件"提示，不伪造高亮。
- **编辑记录只在内存。** 宿主重启后标记消失；永远不进 `workflow.json`、不进日志。
- **撤销只覆盖项目根内。** 根外写入与排除目录不保证恢复；严格 LIFO，最新一次运行没快照时无法撤销更早的。
- **`.undo/` 存的是源码副本**（≤10 次 / 1 GB，仅本地，不经任何路由暴露）。删掉项目目录即整体清除。
- **切换视图需要两张图都在。** 模块分析失败时（几乎没有源码）导入只产任务流水线、切换控件隐藏——绝不用任务节点冒充模块图。
- **图状态同步是轮询**（约 1.8 s；运行中且页面可见时过程数据约 0.85 s），不是流式。
- `shell` 节点可执行任意命令，技能里只要求 agent 先确认。

## 许可

[MIT](LICENSE) © TheLiudawei
