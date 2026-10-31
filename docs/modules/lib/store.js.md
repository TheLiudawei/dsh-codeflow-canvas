# lib/store.js — 画布状态存储

## 一句话职责

CodeFlow 画布的唯一写者：内存里保存每个项目两个视图（tasks / modules）的 `codeflow/1` 图与修订号，并把它们原子地镜像到 `<cwd>/flow-projects/<project>/workflow.json` 与 `workflow.modules.json`。

## 关键导出

| 符号 | 行 | 作用 |
| --- | --- | --- |
| `UNTITLED_KEY` | 35 | 图还没有项目名时使用的桶键 `__untitled__` |
| `VIEW_KEYS` / `DEFAULT_VIEW` | 38 / 41 | 两个视图的固定顺序与默认视图 `tasks` |
| `VIEW_LABEL` / `VIEW_FILES` / `VIEW_SIDECAR_FILE` | 44 / 47 / 50 | 视图中文名、持久化文件名、视图侧车 `view.json` |
| `normalizeView` / `viewOfNodeId` | 53 / 58 | 视图名归一化；按节点 id（`t*` / `m*`）反推所属视图 |
| `normalizeGraph` / `emptyGraph` | 223 / 272 | 图结构清洗（保留 rev、按 maxFiles/节点数截断）与空图构造 |
| `normalizeArtifacts` / `normalizePresented` | 92 / 116 | 交付物与 present 路径的清洗（上限 `MAX_ARTIFACTS_PER_NODE = 50`） |
| `atomicWriteFile` | 184 | 临时文件 + rename 的原子落盘 |
| `safeProjectName` / `projectKeyOf` / `projectDirOf` | 136 / 155 / 168 | 项目名安全化与目录定位 |
| `createStore(logger)` | 281 | 工厂：返回下面这套 API |

## `createStore` 对外 API

- 读：`get(project, view)`, `keys()`, `mostRecent()`, `filePath()`, `viewFileName()`, `anyCwd()`, `listProjects(cwd)`
- 写：`write(rawGraph)`（校验后写入目标视图，**只 bump 该视图 rev**）、`patchNode()`（节点字段增量更新）、`flush()` / `flushAll()`（把定时持久化立即落盘）
- 加载：`load()` / `loadView()`（从磁盘恢复；损坏文件被 `quarantineCorrupt` 改名为 `*.bad-<时间戳>` 并记录 `degraded`，而不是静默覆盖）
- 绑定：`bindCwd()`, `bindSession()` / `bindSessionInfo()` / `forgetSession()`, `setActiveView()`

## 依赖关系

- **导入**：无项目内模块（仅 `node:fs/promises`、`node:crypto`、`node:path`），是依赖图的底层。
- **被依赖**（10 个模块 + 测试）：`lib/index.js`、`lib/routes.js`、`lib/tool.js`、`lib/undo.js`、`lib/sessions.js`、`lib/importer.js`、`lib/duo.js`、`lib/starter.js`、`lib/activity.js`、`lib/analyst.js`，以及 `tests/undo.mjs`。

## 设计要点

1. **单写者模型**：浏览器面板走 HTTP、agent 走 `codeflow_canvas` 工具，最终都进入本模块；写一次只影响目标视图的 `rev`，另一视图版本号不变，避免两边互相覆盖。
2. **按项目 + 视图串行持久化**（`persistChain`）：重叠的两次写不会出现旧版本晚于新版本落盘的竞态。
3. **损坏隔离**：首次写入前先验证磁盘内容（`verifyBeforeFirstWrite`），非 `codeflow/1` 的 JSON 会被改名留档，`degraded` 只标记所属视图。
4. **旧项目兼容**：`detectLayout` 一次性判定 legacy single-module 项目（`workflow.json` 里 `meta.strategy === 'modules'`），该文件永远不重命名，保证 v0.5.x 项目的画布绑定不被打断。
5. **写失败不抛异常**：只记录 `persistError` 并 `logger.warn`，只读工作区下画布仍可交互。

## 运行提示

- 视图文件路径固定为 `flow-projects/<safeName>/workflow.json` 与 `workflow.modules.json`，改文件名会孤儿化已有项目。
- 手工改这些 JSON 时保留 `rev` 字段：修订号是画布与 agent 判断“谁写的”的唯一依据。
