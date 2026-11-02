/**
 * `codeflow_canvas` 工具：agent 把图送上面板、汇报执行进度的唯一通道。
 *
 * 取代原版的 `::visualize{...}` 引用后，"渲染画布"成为一个显式、可校验的
 * 动作：宿主校验图、bump `rev`、持久化副本。自 v0.5.0 起 `mode="progress"`
 * 让运行中的 agent 翻转节点状态、流式上报步骤/百分比，而不必重渲染整图
 * ——且它是**画布专用会话专属**的通道：来自其它会话的 progress 调用一律
 * 拒绝。
 *
 * 自 v0.6.0 起每个模式都理解可选的 `view`（`tasks` | `modules`）：
 * `load` 精确重读该视图的文件、`render` 只替换该视图（绝不碰另一个）、
 * `read` 返回该视图并报告另一视图是否存在、`save` 冲刷两个视图、
 * `progress` 把补丁落进节点所属的视图——由 id 前缀（`t*`/`m*`）加运行
 * 上下文决定，绝不盲猜。从未生成过的视图报可行动错误，而不是端上一张
 * 安静的空图。
 *
 * 注意刻意的非对称：`render` 不再**绑定**调用会话与项目。画布会话的归属权
 * 只在 lib/sessions.js；一次来自任意会话的 `/flow` 渲染再也不能偷走绑定。
 *
 * 结构：`registerTool` 注册 schema 与输出渲染；四个图模式的 handler 各自
 * 是一个具名函数（executeRender/executeLoad/executeRead/executeSave），
 * `execute` 只做分发；progress 通道独立在 `executeProgress`（自带会话门禁）。
 *
 * @module dsh-codeflow-canvas/tool
 */
import { projectDir } from './paths.js'
import { normalizeGraph, normalizeArtifacts, normalizePresented, normalizeView, VIEW_LABEL, viewOfNodeId } from './graph-format.js'

/** 工具名；也是会话里工具卡片分发所用的键。 */
export const TOOL_NAME = 'codeflow_canvas'

/** 按状态给节点计数（面向人的汇总行用）。 */
function tally(nodes) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 }
  for (const node of nodes) counts[node.status] = (counts[node.status] ?? 0) + 1
  return counts
}

/** 一张图的一行汇总，工具结果与面板共用。 */
export function summarize(graph) {
  const counts = tally(graph.nodes)
  const parts = [`${graph.nodes.length} 个节点`]
  if (counts.done > 0) parts.push(`${counts.done} 完成`)
  if (counts.pending > 0) parts.push(`${counts.pending} 待运行`)
  if (counts.running > 0) parts.push(`${counts.running} 运行中`)
  if (counts.failed > 0) parts.push(`${counts.failed} 失败`)
  if (counts.skipped > 0) parts.push(`${counts.skipped} 已跳过`)
  return parts.join(' · ')
}

/** 解析调用方 agent 会话的工作区根。 */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * 解析一次调用的目标视图：显式 `view` 参数优先，其次图自身的
 * `meta.strategy`，最后是项目激活视图。
 */
function resolveView(args, store, project, graph) {
  const explicit = normalizeView(args?.view)
  if (explicit !== undefined) return explicit
  if (graph !== null && typeof graph === 'object' && graph?.meta?.strategy === 'modules') return 'modules'
  const state = store.get(project)
  return normalizeView(state?.activeView) ?? 'tasks'
}

/**
 * 解析项目在某工作区下的持久目录（v1.0，`lib/paths.js`）；没有工作区可解析
 * 时 `undefined`。store 自己持有解析过的 `state.dir`，所以这只在本进程首次
 * 写/加载一个项目时才有意义。
 */
async function dirOf(cwd, project) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  try {
    return await projectDir(cwd, project)
  } catch {
    return undefined
  }
}

/**
 * 注册工具。
 *
 * @param ctx - 携带 `tools` 服务的插件上下文。
 * @param store - 画布 store。
 * @param options.activity - 活动中心（progress 簿记）；可选，headless 组合里
 *   工具照常注册。
 */
export function registerTool(ctx, store, options = {}) {
  const activity = options.activity
  ctx.tools.register({
    name: TOOL_NAME,
    description: [
      'Render or read the CodeFlow workflow canvas panel (a ComfyUI-style node graph whose nodes are agent-executable coding tasks).',
      'A project may hold two views: "tasks" (task pipeline, workflow.json) and "modules" (module-structure graph, workflow.modules.json); pass view="tasks"|"modules" to address one, default is the panel\'s active view.',
      'Use mode="load" as the primary fill-back channel: edit the graph file on disk with your file tools (the path the [CodeFlow:*] message quoted as graphPath), then call load — the host re-reads that view, refreshes the panel and never requires the graph inside tool arguments.',
      'Use mode="render" only as a fallback when file tools are unavailable or the graph does not exist on disk yet; it carries a complete `codeflow/1` graph as tool arguments and replaces only the target view.',
      'Use mode="read" to load the current graph before acting on it, and mode="save" to persist both views without changing them.',
      'While a node is running, use mode="progress" to report per-node status, step descriptions and artifacts incrementally instead of re-rendering the graph.',
      'The user sees the canvas by clicking the CodeFlow icon (a hexagon) in the left sidebar.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['render', 'read', 'save', 'progress', 'load'],
          description: 'load = re-read a view\'s graph file from disk and refresh the panel (preferred); render = push a graph via tool arguments (fallback, replaces only the target view); read = load the current graph; save = persist the current graphs; progress = per-node execution update while running.',
        },
        project: {
          type: 'string',
          description: 'Project name. Required for read/save/progress; for render it is derived from graph.project.name.',
        },
        view: {
          type: 'string',
          enum: ['tasks', 'modules'],
          description: 'Which view to address: "tasks" = 任务流水线 (workflow.json), "modules" = 模块结构图 (workflow.modules.json). Defaults to the panel\'s active view; progress also infers it from the running node id.',
        },
        graph: {
          type: 'object',
          description: 'Complete codeflow/1 graph. Required for render. Must carry format="codeflow/1", nodes and links.',
          additionalProperties: true,
        },
        title: {
          type: 'string',
          description: 'Optional panel subtitle, e.g. the project name shown in the canvas header.',
        },
        nodeId: {
          type: 'string',
          description: 'progress: the node this update is about.',
        },
        status: {
          type: 'string',
          enum: ['running', 'done', 'failed', 'skipped'],
          description: 'progress: the node status to set.',
        },
        step: {
          type: 'string',
          description: 'progress: one-line description of what is happening right now (e.g. 读取 src/app.py / 运行测试).',
        },
        result: {
          type: 'string',
          description: 'progress: ≤80-char result summary, set when the node finishes.',
        },
        detail: {
          type: 'string',
          description: 'progress: ≤400-char detail (file list or failure reason).',
        },
        artifacts: {
          type: 'array',
          description: 'progress/render: files this node produced, [{path, label?, kind?}] with kind in code|doc|test|config|asset|other.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              label: { type: 'string' },
              kind: { type: 'string', enum: ['code', 'doc', 'test', 'config', 'asset', 'other'] },
            },
          },
        },
        presented: {
          type: 'array',
          description: 'progress: paths actually submitted to the present tool (deliver nodes only).',
          items: { type: 'string' },
        },
        percent: {
          type: 'number',
          description: 'progress: 0-100, ONLY when the task itself reports a real percent. Never estimate; omit otherwise.',
        },
      },
      required: ['mode'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string' },
          project: { type: 'string' },
          view: { type: 'string', enum: ['tasks', 'modules'] },
          rev: { type: 'integer' },
          summary: { type: 'string' },
          file: { type: 'string' },
          persisted: { type: 'boolean' },
          warning: { type: 'string' },
          graph: { type: 'object', additionalProperties: true },
          nodeId: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['mode', 'project', 'rev', 'summary'],
      },
      render: (args, value) => {
        if (args.mode === 'read' && value.graph !== undefined) {
          return [{
            type: 'text',
            text: `CodeFlow 当前图（${value.project}，${VIEW_LABEL[value.view] ?? value.view}，rev ${value.rev}）：\n${JSON.stringify(value.graph)}`,
          }]
        }
        if (args.mode === 'load') {
          return [{
            type: 'text',
            text: `CodeFlow 已从磁盘重载「${value.project}」的${VIEW_LABEL[value.view] ?? value.view ?? ''}视图：${value.summary}（rev ${value.rev}${value.file === undefined ? '' : `，${value.file}`}）。画布面板会自动刷新。`,
          }]
        }
        if (args.mode === 'progress') {
          return [{
            type: 'text',
            text: `CodeFlow 节点进度已更新：${value.nodeId ?? '?'} → ${value.status ?? 'running'}（${VIEW_LABEL[value.view] ?? value.view}，rev ${value.rev}）。继续执行；节点全部结束后再用文件回填整图（或 render 后备）。`,
          }]
        }
        const where = value.persisted === false
          ? '，未能落盘'
          : value.file === undefined ? '' : `，已写入 ${value.file}`
        const warning = value.warning === undefined ? '' : `（${value.warning}）`
        return [{ type: 'text', text: `CodeFlow 画布已更新（${VIEW_LABEL[value.view] ?? value.view}视图）：${value.summary}（rev ${value.rev}${where}）${warning}。点左侧栏的 CodeFlow 图标打开画布。` }]
      },
    },

    /**
     * 模式分发器：progress 有独立的会话门禁，其余四个模式各是一个具名函数。
     */
    async execute(args, exec) {
      const mode = String(args.mode ?? 'render')
      // 工具调用发生在回合内，但会话目录仍可能是"回合跑在被修复过的父目录"
      // 的原因；用与提示词相同的已解析目录。
      const execCwd = cwdOf(exec)

      if (mode === 'progress') return executeProgress(args, exec, mode)
      if (mode === 'render') return executeRender(args, execCwd, mode)
      if (mode === 'load') return executeLoad(args, execCwd, mode)
      if (mode === 'read') return executeRead(args, execCwd, mode)
      if (mode === 'save') return executeSave(args, mode)
      throw new Error(`codeflow_canvas: unknown mode "${mode}"`)
    },
  })

  /**
   * render（后备通道）：整图经工具参数送达。校验 → 解析视图 → 落盘。
   * 这里绝不绑定 sessionId：渲染不得抢走画布会话的绑定。
   */
  async function executeRender(args, execCwd, mode) {
    const graph = normalizeGraph(args.graph)
    if (graph === undefined) throw new Error('codeflow_canvas: `graph` must be a codeflow/1 graph object')
    const viewName = resolveView(args, store, graph?.project?.name, graph)
    const dir = await dirOf(execCwd, graph?.project?.name)
    const written = await store.write(graph, { persist: 'now', cwd: execCwd, dir, title: args.title, view: viewName })
    const file = written.file ?? store.filePath(written.key, written.view)
    const warning = written.persisted === false
      ? `图谱未落盘：${written.error ?? '未知原因'}`
      : undefined
    return {
      mode,
      project: written.key,
      view: written.view,
      rev: written.rev,
      summary: summarize(written.graph),
      ...(file === undefined ? {} : { file }),
      ...(written.persisted === undefined ? {} : { persisted: written.persisted }),
      ...(warning === undefined ? {} : { warning }),
    }
  }

  /**
   * load（首选回填通道）：agent 用文件工具把该视图的图文件写在磁盘上，然后
   * 请宿主重读。图从不进工具参数——超长嵌套 JSON 最容易在这打断模型的
   * 工具调用（DSH 呈现为 `tool input is invalid JSON`）。
   */
  async function executeLoad(args, execCwd, mode) {
    const project = typeof args.project === 'string' && args.project.length > 0 ? args.project : undefined
    if (project === undefined) throw new Error('codeflow_canvas: mode="load" needs `project`')
    const bound = store.get(project)
    const cwd = typeof bound.cwd === 'string' && bound.cwd.length > 0 ? bound.cwd : execCwd
    const dir = bound.dir ?? (await dirOf(cwd, project))
    if (cwd === undefined) {
      throw new Error(`codeflow_canvas: mode="load" cannot locate the project directory of "${project}"：项目未绑定工作区，且当前会话没有可用的工作目录`)
    }
    const viewName = normalizeView(args.view)
      ?? (bound.views?.modules?.available === true && bound.views?.tasks?.available !== true && bound.rev > 0 ? 'modules' : undefined)
      ?? bound.activeView
      ?? 'tasks'
    // 视图可用性由 store 的 load 自己把关（顺带跑一次性布局探测）：缺文件的
    // 视图报可行动错误，坏文件被隔离并上报。
    let loaded
    try {
      loaded = await store.loadView(project, cwd, viewName, dir)
    } catch (error) {
      throw new Error(`codeflow_canvas: mode="load" failed for "${project}"（${VIEW_LABEL[viewName]}视图）：${String(error?.message ?? error)}`
        + `（请先用文件工具把完整的 codeflow/1 图 JSON 写入该视图的图文件，再调用 load）`)
    }
    // 坏文件被 store 隔离，绝不以空画布形态送达：agent 必须知道它的写没有
    // 落地，否则它会以为只是面板被重置了。
    if (loaded?.degraded !== undefined) {
      throw new Error(`codeflow_canvas: mode="load" failed for "${project}"：${viewName === 'modules' ? 'workflow.modules.json' : 'workflow.json'} 已损坏（${loaded.degraded.reason}）`
        + `，坏文件已${loaded.degraded.quarantinedTo !== undefined ? `隔离为 ${loaded.degraded.quarantinedTo}` : '保留在原处'}；`
        + '请用文件工具重新写入完整的 codeflow/1 图 JSON 后再调用 load')
    }
    // 把文件送回 store 走一遍：再次归一、bump rev、落盘——面板只采纳比自己的
    // rev 更新的版本，这样才能精确刷新到 agent 写的内容。只写目标视图；
    // 另一个视图保留自己的 rev 与图。
    const written = await store.write(loaded.graph, { persist: 'now', cwd, dir, title: bound.title, view: viewName })
    return {
      mode,
      project: written.key,
      view: written.view,
      rev: written.rev,
      summary: summarize(written.graph),
      ...(written.file !== undefined ? { file: written.file } : {}),
      ...(written.persisted !== undefined ? { persisted: written.persisted } : {}),
      ...(written.error !== undefined ? { warning: `图谱未落盘：${written.error}` } : {}),
    }
  }

  /**
   * read：行动之前先读当前图。内存里有就直接回；没有则回退到持久副本
   * （损坏的副本被隔离，如实上报而不是装作无事）。
   */
  async function executeRead(args, execCwd, mode) {
    const project = typeof args.project === 'string' && args.project.length > 0 ? args.project : undefined
    if (project === undefined) throw new Error('codeflow_canvas: mode="read" needs `project`')
    const viewName = resolveView(args, store, project, undefined)
    const summaryExtra = () => {
      const views = store.get(project)?.views
      if (views === undefined) return ''
      const other = viewName === 'modules' ? 'tasks' : 'modules'
      return views[other]?.available === true
        ? `（另一视图「${VIEW_LABEL[other]}」可用，共 ${views[other]?.nodes ?? '?'} 节点）`
        : '（另一视图未生成）'
    }
    const current = store.get(project, viewName)
    if (current.graph.nodes.length > 0) {
      return {
        mode,
        project: current.key,
        view: current.view,
        rev: current.rev,
        summary: `${summarize(current.graph)}${summaryExtra()}`,
        graph: current.graph,
      }
    }
    const execCwdForRead = current.cwd ?? execCwd
    if (execCwdForRead === undefined) {
      throw new Error(`codeflow_canvas: no canvas state or graph file for project "${project}" (${VIEW_LABEL[viewName]}视图)`)
    }
    // 内存里还没有：回退持久副本。
    let loaded
    try {
      loaded = await store.loadView(project, execCwdForRead, viewName, current.dir ?? (await dirOf(execCwdForRead, project)))
    } catch {
      throw new Error(`codeflow_canvas: no canvas state or graph file for project "${project}" (${VIEW_LABEL[viewName]}视图)`)
    }
    if (loaded?.degraded !== undefined) {
      return {
        mode,
        project: loaded.key,
        view: loaded.view,
        rev: loaded.rev,
        summary: `${summarize(loaded.graph)}${summaryExtra()}`,
        graph: loaded.graph,
        warning: `${viewName === 'modules' ? 'workflow.modules.json' : 'workflow.json'} 已损坏（${loaded.degraded.reason}），坏文件已隔离；当前为空图，请重写后用 mode="load" 刷新`,
      }
    }
    return {
      mode,
      project: loaded.key,
      view: loaded.view,
      rev: loaded.rev,
      summary: `${summarize(loaded.graph)}${summaryExtra()}`,
      graph: loaded.graph,
    }
  }

  /** save：冲刷项目的所有已加载视图（双视图项目两个都存），图不变。 */
  async function executeSave(args, mode) {
    const project = typeof args.project === 'string' && args.project.length > 0 ? args.project : undefined
    const flushed = await store.flush(project)
    const viewName = normalizeView(flushed?.view) ?? 'tasks'
    const current = store.get(project ?? flushed?.key, viewName)
    return {
      mode,
      project: current.key,
      view: viewName,
      rev: current.rev,
      summary: summarize(current.graph),
      ...(flushed?.file === undefined ? {} : { file: flushed.file }),
      ...(flushed?.persisted === undefined ? {} : { persisted: flushed.persisted }),
      ...(flushed?.error === undefined ? {} : { warning: `图谱未落盘：${flushed.error}` }),
    }
  }

  /**
   * progress 通道：一个节点、白名单字段、画布专用会话限定。
   *
   * 门禁把调用方 agent 与项目的**画布会话**绑定做比较——正是它挡住了无关
   * 会话（或继承了工具的子代理）往面板里写执行状态。
   *
   * 目标视图的解析顺序：显式 `view` 参数 → 运行上下文 → 节点 id 拼写；补丁
   * 只有在节点真的在那个视图的图里被找到才落地——错误的猜测不可能生效，
   * 真实的更新也绝不会被搁浅。
   */
  async function executeProgress(args, exec, mode) {
    const project = typeof args.project === 'string' && args.project.length > 0 ? args.project : undefined
    const nodeId = typeof args.nodeId === 'string' && args.nodeId.length > 0 ? args.nodeId : undefined
    if (project === undefined) throw new Error('codeflow_canvas: mode="progress" needs `project`')
    if (nodeId === undefined) throw new Error('codeflow_canvas: mode="progress" needs `nodeId`')
    const bound = store.get(project)
    if (typeof bound.sessionId !== 'string' || bound.sessionId.length === 0) {
      throw new Error('only the canvas session may update progress：该项目还没有绑定画布专用会话')
    }
    if (exec?.agent?.id !== bound.sessionId) {
      throw new Error('only the canvas session may update progress：请在该项目的画布专用会话里运行节点')
    }

    const explicitView = normalizeView(args.view)
    const runView = activity?.currentViewOf !== undefined ? activity.currentViewOf(project) : undefined
    let viewName = explicitView ?? normalizeView(runView) ?? viewOfNodeId(nodeId) ?? bound.activeView ?? 'tasks'
    const patch = {
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.result !== undefined ? { result: args.result } : {}),
      ...(args.detail !== undefined ? { detail: args.detail } : {}),
      ...(args.artifacts !== undefined ? { artifacts: normalizeArtifacts(args.artifacts) ?? [] } : {}),
      ...(args.presented !== undefined ? { presented: normalizePresented(args.presented) ?? [] } : {}),
    }
    let written = store.patchNode(project, nodeId, patch, { view: viewName, runView })
    if (written === undefined && explicitView === undefined) {
      // 上下文提示的视图里没找到节点：放弃之前试另一个视图——过时的运行视图
      // 既不能补错图，也不能搁浅一次真实的更新。
      const other = viewName === 'modules' ? 'tasks' : 'modules'
      written = store.patchNode(project, nodeId, patch, { view: other })
      if (written !== undefined) viewName = other
    }
    if (written === undefined) {
      throw new Error(`codeflow_canvas: progress target not found: project "${project}" node "${nodeId}"（${VIEW_LABEL[viewName]}视图）`)
    }
    if (activity?.noteProgress !== undefined) {
      activity.noteProgress(project, {
        view: viewName,
        nodeId,
        status: args.status,
        step: typeof args.step === 'string' ? args.step : undefined,
        percent: typeof args.percent === 'number' ? args.percent : undefined,
      })
    }
    return {
      mode,
      project: written.key,
      view: written.view,
      rev: written.rev,
      nodeId,
      status: args.status ?? 'running',
      summary: `节点 ${nodeId} 已更新`,
    }
  }
}
