# lib/store.js — 画布状态存储

## 一句话职责

CodeFlow 画布的唯一写者：内存里保存每个项目两个视图（tasks / modules）的 `codeflow/1` 图与修订号，并把它们原子地镜像到 `<项目目录>/workflow.json` 与 `workflow.modules.json`（v1.0 起项目目录由 `lib/paths.js` 解析：`<根>/flow-projects/<project>/`，默认根 `<工作区>/CodeFlow`，可全局自定义 + 单项目覆盖）。

## 关键导出

| 符号 | 作用 |
| --- | --- |
| `UNTITLED_KEY` | 图还没有项目名时使用的桶键 `__untitled__` |
| `VIEW_KEYS` / `DEFAULT_VIEW` | 两个视图的固定顺序与默认视图 `tasks` |
| `VIEW_LABEL` / `VIEW_FILES` / `VIEW_SIDECAR_FILE` | 视图中文名、持久化文件名、视图侧车 `view.json` |
| `normalizeView` / `viewOfNodeId` | 视图名归一化；按节点 id（`t*` / `m*`）反推所属视图 |
| `normalizeGraph` / `emptyGraph` | 图结构清洗与空图构造 |
| `normalizeArtifacts` / `normalizePresented` | 交付物与 present 路径的清洗（上限 `MAX_ARTIFACTS_PER_NODE = 50`） |
| `atomicWriteFile` | 临时文件 + rename 的原子落盘 |
| `safeProjectName` / `projectKeyOf` / `projectDirOf` | 项目名安全化与目录定位 |
| `projectDirPath(cwd, key)` | **默认根拼写**的项目目录（`<cwd>/CodeFlow/flow-projects/<dir>/`）；仅作未解析路径时的回退 |
| `createStore(logger)` | 工厂：返回下面这套 API |

## `createStore` 对外 API

- 读：`get(project, view)`（返回值含 `cwd` 与 v1.0 的 `dir`——项目实际目录）、`keys()`、`mostRecent()`、`filePath()`、`viewFileName()`、`anyCwd()`、`listProjects(workspace)`（v1.0 起走 `paths.listProjectDirs`：当前根 + knownRoots + 项目覆盖 + 旧目录，去重后逐一识别）
- 写：`write(rawGraph, options)`（options 新增 `dir`：调用方经 `lib/paths.js` 解析出的项目目录；校验后写入目标视图，**只 bump 该视图 rev**）、`patchNode()`（节点字段增量更新）、`flush()` / `flushAll()`
- 加载：`load()` / `loadView()`（均接受显式 `dir`；从磁盘恢复，损坏文件被 `quarantineCorrupt` 改名为 `*.bad-<时间戳>` 并记录 `degraded`，而不是静默覆盖）
- 绑定：`bindCwd(project, cwd, dir?)` / `bindDir()`、`bindSession()` / `bindSessionInfo()` / `forgetSession()`、`setActiveView()`

## 依赖关系（重构后）

- **导入**：`lib/core/fsio.js`（atomicWriteFile）、`lib/core/path.js`（projectKeyOf/projectDirPath/UNTITLED_KEY）、`lib/graph-format.js`（normalize* 与视图常量）、`lib/paths.js`（仅 `listProjectDirs`，项目列表扫描用）、`node:fs/promises`、`node:crypto`、`node:path`。历史的 `store ⇄ paths` ESM 循环已斩断（命名/IO/格式下沉后 paths 不再回头 import store）。
- **被依赖**：仅 `lib/index.js`（装配时创建 store）+ 测试（tests/undo、regression、e2e、coupling、validate 经 store.js 或其 re-export 取符号）。routes/tool/sessions/undo/activity 等已改为直接依赖 `lib/graph-format.js` 与 `lib/core/*`，运行时经注入持有 store。
- **兼容面**：本模块仍 re-export 图格式（normalizeGraph/normalizeView/VIEW_* 等）、命名（safeProjectName/projectKeyOf/projectDirOf/projectDirPath）与 atomicWriteFile——tests 与历史调用方继续从这里导入即可。

## 设计要点

1. **单写者模型**：浏览器面板走 HTTP、agent 走 `codeflow_canvas` 工具，最终都进入本模块；写一次只影响目标视图的 `rev`，另一视图版本号不变，避免两边互相覆盖。
2. **按项目 + 视图串行持久化**（`persistChain`）：重叠的两次写不会出现旧版本晚于新版本落盘的竞态。
3. **损坏隔离**：首次写入前先验证磁盘内容（`verifyBeforeFirstWrite`），非 `codeflow/1` 的 JSON 会被改名留档，`degraded` 只标记所属视图。
4. **旧项目兼容**：`detectLayout` 一次性判定 legacy single-module 项目（`workflow.json` 里 `meta.strategy === 'modules'`），该文件永远不重命名，保证 v0.5.x 项目的画布绑定不被打断。
5. **写失败不抛异常**：只记录 `persistError` 并 `logger.warn`，只读工作区下画布仍可交互。
6. **路径解析分层（v1.0）**：每个项目在内存里持有一个 `state.dir`（调用方经 `lib/paths.js` 解析后随 `write/load/loadView/bindCwd` 传入）；没传时回退到默认根拼写 `<cwd>/CodeFlow/flow-projects/<dir>/`。`rev`、`expectedRev` 冲突检测、原子写与损坏隔离的语义完全不因目录来源而变化。

## 运行提示

- 视图文件名固定为 `workflow.json` 与 `workflow.modules.json`，改文件名会孤儿化已有项目；**目录**由 `lib/paths.js` 决定（配置坏了会回退默认根，knownRoots 里的旧根仍可被发现）。
- 手工改这些 JSON 时保留 `rev` 字段：修订号是画布与 agent 判断“谁写的”的唯一依据。
