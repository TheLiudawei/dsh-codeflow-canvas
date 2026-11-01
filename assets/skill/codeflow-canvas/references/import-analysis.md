# 导入项目：语言识别与注释解析指南

"导入项目"时按本文件中的规则扫描目录并生成工作流。目标：**快、准、克制** —— 不整读大文件，
不把源码塞进图里，只提取足以生成任务流水线的结构信号。

> 这些规则已由宿主的 `lib/duo.js` **确定性实现**（调度 `lib/importer.js` 与 `lib/analyst.js`）：
> 面板"导入项目"与 `/flow-import` 都由它直接完成，**一次同时生成任务流水线与模块结构图**，
> 不经过 agent。本文剩余部分是这份实现的规格说明，也是 agent 在没有宿主脚本时
> （独立模式、旧客户端）手工导入的依据——两者语义必须保持一致，改规则时两处同步。

## 1. 扫描规则

1. 解析路径（支持绝对路径与工作区相对路径），目录不存在时如实报错并停止。
2. 递归遍历，**跳过**：`.git`, `node_modules`, `venv`, `.venv`, `env`, `__pycache__`, `dist`, `build`, `out`, `.idea`, `.vscode`, `vendor`, `target`, `bin`, `obj`, `*.min.js`, 锁文件。
3. 文件数上限 = scan 节点控件 `maxFiles`（默认 200，上限 1000）。超出时优先保留源码扩展名文件，并在结果中注明"已截断"。
4. 二进制/媒体扩展名（png/jpg/zip/…）只计数，不读内容。
5. 单文件只读前 200 行用于注释与文件头分析；不整读。

## 2. 语言识别

按扩展名统计源码文件数，取最高为主语言：

| 语言 | 扩展名 |
| --- | --- |
| python | py, pyw |
| javascript | js, mjs, cjs, jsx |
| typescript | ts, tsx |
| java | java |
| go | go |
| rust | rs |
| c/cpp | c, h, cpp, hpp, cc |
| csharp | cs |
| ruby | rb |
| php | php |
| swift | swift |
| kotlin | kt |
| html/css | html, htm, css, scss, vue |
| shell | sh, bash, ps1 |
| 其他 | 其余全部合计 |

`project.language` 写主语言；结构报告（scan 节点 `detail`）记录完整统计表与文件总数。

## 3. 注释语法提取表

| 语言族 | 行注释 | 块注释 | 其他 |
| --- | --- | --- | --- |
| python | `#` | — | `"""…"""` / `'''…'''` docstring（模块级首个 = 文件用途） |
| js/ts/java/go/rust/c/cpp/csharp/kt/swift/php | `//`、`///` | `/* … */` | jsdoc `/** … */` |
| ruby/shell/yaml | `#` | — | — |
| html/xml/vue | — | `<!-- … -->` | — |
| css/scss | — | `/* … */` | `//`（scss） |

提取时逐行扫描（前 200 行），正则示例：

- 行注释：`^\s*(?://|#|--|<!--)\s?(.*)$`（按语言选 token；`<!--` 需行尾含 `-->`）
- 块注释：多行状态机（进入 `/*` 或 `<!--` 后逐行收集直至闭合）
- docstring：文件开头首个 `"""` 配对

## 4. 任务标记（TODO 类）

在注释文本中匹配行首标记（大小写敏感）：

```
TODO | FIXME | HACK | XXX | OPTIMIZE | NOTE
```

输出条目结构：`{ file(相对路径), line, marker, text }`。按 marker 权重排序（FIXME > HACK/XXX > TODO > OPTIMIZE > NOTE），同类内按文件聚组。**最多保留 50 条**，超出在报告中注明。

## 5. 文件头注释 = 项目意图

每个源码文件前 15 行中的连续注释块视为"文件头注释"，是文件用途的最强信号。结构报告为每个关键文件（入口、配置、被引用最多者，≤20 个）记录一行：`相对路径 — 头注释首句`。

## 6. 产物一：任务流水线（comments.makeTasks=true 时）

**v0.6.0 起，一次导入同时产出两个视图**：本节的任务流水线写入 `workflow.json`
（`meta.strategy="tasks"`），第 7 节的模块结构图写入 `workflow.modules.json`
（`meta.strategy="modules"`）。两者共用同一项目名与 `meta.importedFrom`，不存在"二选一"
（旧参数 `strategy`/`--modules` 只作兼容，不再改变结果）。目录里几乎没有源码时模块图不可用，
任务流水线照常导入，不伪造空模块图。

```
scan(项目扫描, done, 结果=语言统计摘要)
  └─ comments(注释解析, done, 结果=N 条标记)
       ├─ edit/codegen "任务：<标记文本前 18 字>" × 最多 5 个   ← 最重要的标记各一个节点
       ├─ testgen "补齐测试"        ← 项目中无 test 扩展名文件时才生成（addTests=true）
       └─ review "整体代码审查"
            └─ deliver(交付打包)
```

- 节点 id 一律 `t1, t2, …`（模块结构图为 `m1, m2, …`），跨视图不歧义。
- 任务节点 `params.instruction` = 完整标记文本 + `（来自 <file>:<line>）`；`status=pending`。
- scan/comments 两个节点在导入时即执行完成（`status=done`，result/detail 按第 2/4 节填写）——导入本身就是一次扫描。
- 标记不足 3 条时只生成 1 个汇总 `edit` 节点（"处理全部 N 条待办注释"），避免图过碎。
- 图的 `project.origin="import"`，`project.name` = 目录名（冲突时加 `-flow` 后缀，两个视图共用）。

## 7. 产物二：模块结构图（同一次导入同时生成）

与任务流水线同时生成的另一张图：不是任务清单，而是"这份代码由什么组成"的结构图。由宿主
`lib/analyst.js` 确定性实现，以下是其规则（与任务流水线共用第 1–2 节的扫描与语言识别）：

**逐文件提取**
1. 顶层符号：函数 / 类 / 接口 / 类型（按语言族正则，Python 只取零缩进定义），记录 `名字、种类、行号`。
2. 导入 specifier 并尽量解析到项目内文件：相对路径（js/ts `./x`）、Python 点号（`.a.b`、`from . import`）、
   Go / Java 后缀匹配；解析不到的（第三方包、标准库）忽略。
3. 角色推断（命中即停，顺序如下）：测试 → 入口（main/app/index/server/cli 等文件名、`__main__` 守卫）→
   路由接口（`@app.route`、`@RestController`、express `Router()`…）→ 数据模型（ORM 基类 / `@Entity` /
   `CREATE TABLE`…）→ UI 组件（react/vue/svelte + JSX 标签）→ 服务（service/controller/handler…）→
   工具（util/helper/common…）→ 脚本 / 样式 → 默认 `模块`。头注释首句作为职责猜测写入 detail。

**选节点（预算 ≤ 60）**
- 文件级 `module` 节点 ≤ 36 个：入口优先，再按被依赖数取核心；其余文件计入 scan 节点的"未展开"说明。
- 核心文件（入口 + 被依赖最多，≤ 3 个）展开符号子节点，每文件 ≤ 6 个（类/类型优先）。

**连线与布局**
- `scan(done)` 连向无本地依赖的模块；其余模块连向其**最强的**一条本地依赖（端口单入线限制），
  完整依赖/被依赖清单写在该节点 `detail`。
- x 轴按依赖深度分层（依赖在左、被依赖在右，层距 340px），y 轴同层堆叠（170px）。
- 所有 `module` 节点导入时即预填推断结果（`pending`）：运行时 agent 读取源文件验证并深化（见 node-types.md `module`）。
- `params.path` 是源文件**绝对路径**；`params.symbol` 为空串是文件级节点，非空是符号子节点——
  宿主把 agent 真实编辑的文件匹配回**文件级**节点做"修改中/已修改"高亮。

**图属性**：`project.origin="import"`、`meta.strategy="modules"`，项目名与任务流水线相同；
落盘为 `workflow.modules.json`。
