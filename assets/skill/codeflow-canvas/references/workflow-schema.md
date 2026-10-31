# CodeFlow 工作流图 JSON Schema

工作流图是画布与 agent 之间唯一的状态载体。**一个项目有两个视图**（v0.6.0 起），每个视图都是一份
完整、自洽的 `codeflow/1` 图，有各自的节点、连线、坐标、运行状态与 `rev`：

| 视图 | `view` | 落盘文件 | 内容 |
| --- | --- | --- | --- |
| 任务流水线 | `"tasks"` | `<根>/flow-projects/<项目名>/workflow.json` | scan → comments → 任务节点 → 审查 → 交付 |
| 模块结构图 | `"modules"` | `<根>/flow-projects/<项目名>/workflow.modules.json` | 每个代码文件一个 `module` 节点 + 符号子节点 |

> v1.0：默认根是 `<工作区>/CodeFlow`，可在画布「设置」里自定义（也支持给单个项目覆盖目录）；
> 一切以消息里的 `graphPath` 为准。旧 `<工作区>/flow-projects/` 里的项目会在升级后自动迁移一次。

画布面板从宿主 HTTP 接口读取当前激活视图的状态；两张图互不影响（写一边不会动另一边的 `rev`）。
新建项目只有任务流水线视图；模块结构图只在**导入**时生成。旧项目兼容：只有一份 `workflow.json` 的
旧项目按其 `meta.strategy` 归属视图（`modules` → 该文件就是模块图），不做自动迁移。

## 完整示例（任务流水线视图）

```json
{
  "format": "codeflow/1",
  "rev": 3,
  "project": { "name": "todo-cli", "language": "python", "origin": "new" },
  "nodes": [
    {
      "id": "t1",
      "type": "requirement",
      "title": "需求输入",
      "pos": [60, 80],
      "params": { "language": "python", "brief": "命令行待办事项工具" },
      "status": "done",
      "result": "命令行待办工具，增删改查+持久化",
      "detail": ""
    },
    {
      "id": "t2",
      "type": "codegen",
      "title": "代码生成",
      "pos": [420, 80],
      "params": { "language": "python", "dir": "", "prompt": "模块化，CLI 入口清晰" },
      "status": "pending",
      "result": "",
      "detail": "",
      "artifacts": [
        { "path": "src/app.py", "label": "程序入口", "kind": "code" }
      ]
    }
  ],
  "links": [
    ["t1", 0, "t2", 0]
  ],
  "meta": { "createdAt": "2026-10-29T10:00:00+08:00", "updatedAt": "2026-10-29T10:05:00+08:00" }
}
```

模块结构图视图的节点 id 一律 `m1, m2, …`（任务流水线 `t1, t2, …`），`meta.strategy` 分别为
`"tasks"` / `"modules"`——宿主据此判断一个文件属于哪个视图，并据此路由无 `view` 参数的写入。

## 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `format` | string | 固定 `codeflow/1`，不匹配则拒绝加载 |
| `rev` | int | 版本号，**由宿主维护、按视图独立计数**：每次回填自增，面板以此判断是否采纳新状态 |
| `project.name` | string | 项目名，即项目根下 `flow-projects/` 里的目录名（安全化：仅中文/字母/数字/`-`/`_`）；两个视图共享同一项目名 |
| `project.language` | string | 项目主语言（新建时用户选；导入时自动检测，如 `python`） |
| `project.origin` | string | `new` \| `import` |
| `nodes[].id` | string | 任务流水线 `t1, t2, …`；模块结构图 `m1, m2, …`；旧图遗留的 `n1…` 仍合法。图内唯一，跨视图不会歧义 |
| `nodes[].type` | string | 节点类型 key，见 node-types.md（`module` 类型只出现在模块结构图） |
| `nodes[].title` | string | 显示名，可被用户重命名 |
| `nodes[].pos` | [x,y] | 世界坐标（画布左上角为原点）。**保留用户排布，不要无故重排** |
| `nodes[].params` | object | 控件值，key 与 node-types.md 中控件定义一致；`module` 节点的 `params.path` 是源文件绝对路径、`params.symbol` 为空串表示文件级节点 |
| `nodes[].status` | string | `pending` \| `running` \| `done` \| `failed` \| `skipped` |
| `nodes[].result` | string | ≤80 字符结果摘要（节点底部展示） |
| `nodes[].detail` | string | ≤400 字符详情（产出文件清单等），"查看详情"展示 |
| `nodes[].artifacts` | array | **可选**（v0.5.0 起）。节点产出的真实文件清单，`[{path, label?, kind?}]`；`path` 为工作区相对路径（`/` 分隔），`kind` ∈ `code\|doc\|test\|config\|asset\|other`；每节点 ≤50 条，宿主清洗。**谁填**：实际写文件的节点完成时必填（见 node-types.md）。宿主也用它把 agent 真实编辑的文件匹配回任务节点（高亮） |
| `nodes[].presented` | array | **可选**。实际提交给 `present` 工具的路径数组（`deliver` 节点专用，由宿主/agent 回填） |
| `links` | array | 四元组 `[fromNodeId, fromSlotIdx, toNodeId, toSlotIdx]`；slot 序号 = 该节点 inputs/outputs 定义中的下标 |
| `meta` | object | 时间戳；`meta.importedFrom`（导入项目）为项目源目录的绝对路径，也是撤销快照的根；`meta.strategy` ∈ `tasks` \| `modules` 标明视图归属 |

## 约束

1. `params` 只存控件值；端口定义不存图里，由节点类型库推导（图文件因此很小）。
2. `links` 中 fromSlot 指向 outputs 下标、toSlot 指向 inputs 下标；画布加载时丢弃越界连线与悬空连线。
3. 输入端口至多一条入线；保存前画布会去重。
4. 任务文本过长时放进 `detail` 而不是 `params`。
5. 落盘为紧凑格式（无缩进），键序不必稳定，画布不依赖键序。
6. `artifacts` 会被宿主清洗：非数组/非法项丢弃、去重去空、上限 50 条；旧图没有该字段不受影响。
7. 图 JSON **不含**运行期过程数据：思考流、步骤、`percent`、**agent 的文件编辑记录**只存在于宿主内存
   （Activity Hub），不落盘、不进图文件，DSH 重启即清空。
8. 撤销快照（`.undo/`）由宿主管理，不属于图格式；`session.json`（画布会话绑定）与 `view.json`
   （激活视图记忆，可选含两视图的视口）是项目目录的 sidecar 文件，不参与任何视图的 `rev`。
   撤销快照排除清单包含 `workflow.json`、`workflow.modules.json`、`session.json`、`view.json`——
   撤销只回滚节点字段，绝不把图文件回滚到旧版本。
9. **跨视图纪律**：一次运行只写自己视图的图文件；`progress`/`load` 带上消息里的 `view`；
   不要在读一个视图时顺手改写另一个视图。

## 与 ZCode 版的差别

- 没有 `widgetState`，也没有 16 KiB 快照上限：状态由宿主服务持有并落盘。
- 不再要求"agent 自己把 `rev` 加 1"：`rev` 是宿主写入时自增的计数器（按视图独立）。
- 没有 `</` 转义要求：画布不再内嵌进 HTML 字符串。
- v0.6.0 起一个项目两张图（两个文件），不再是单图。
