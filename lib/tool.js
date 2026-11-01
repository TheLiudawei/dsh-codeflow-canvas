/**
 * The `codeflow_canvas` tool: the agent's only way to move a graph onto the
 * panel and to report execution progress.
 *
 * Replacing the original `::visualize{...}` reference, this tool makes "render
 * the canvas" an explicit, checkable act: the host validates the graph, bumps
 * `rev`, persists the durable copy. Since v0.5.0 `mode="progress"` lets a
 * running agent flip a node's status and stream step/percent updates without
 * re-rendering the whole graph — and it is the canvas-session-only channel:
 * a progress call from any other session is refused.
 *
 * Since v0.6.0 every mode understands an optional `view` (`tasks` | `modules`):
 * `load` re-reads exactly that view's file, `render` replaces exactly that
 * view (never the other one), `read` returns that view and reports whether the
 * other exists, `save` flushes both views, and `progress` patches the node in
 * its own view — the id prefix (`t*`/`m*`) plus the run context decide, never
 * a blind guess. A view that was never generated fails with an actionable
 * error instead of a silent empty graph.
 *
 * Note the deliberate asymmetry: `render` no longer *binds* the calling
 * session to the project. Canvas-session ownership lives exclusively in
 * `lib/sessions.js`; a `/flow` render from an arbitrary conversation can no
 * longer steal the binding.
 *
 * @module dsh-codeflow-canvas/tool
 */
import { projectDir } from './paths.js'
import { normalizeGraph, normalizeArtifacts, normalizePresented, normalizeView, VIEW_LABEL, viewOfNodeId } from './graph-format.js'

/** Tool name; also the key the conversation's tool card is dispatched under. */
export const TOOL_NAME = 'codeflow_canvas'

/** Count nodes by status for the human-facing summary line. */
function tally(nodes) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 }
  for (const node of nodes) counts[node.status] = (counts[node.status] ?? 0) + 1
  return counts
}

/** One-line account of a graph, shared by the tool result and the panel. */
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

/** Resolve the workspace root of the calling agent session. */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * Resolve the target view of a call: explicit `view` argument wins, then the
 * graph's own `meta.strategy`, then the project's active view.
 */
function resolveView(args, store, project, graph) {
  const explicit = normalizeView(args?.view)
  if (explicit !== undefined) return explicit
  if (graph !== null && typeof graph === 'object' && graph?.meta?.strategy === 'modules') return 'modules'
  const state = store.get(project)
  return normalizeView(state?.activeView) ?? 'tasks'
}

/**
 * Resolve the durable directory of a project under a workspace (v1.0,
 * `lib/paths.js`); `undefined` when there is no workspace to resolve against.
 * The store keeps its own resolved `state.dir`, so this only matters for the
 * first write/load of a project in this process.
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
 * Register the tool.
 *
 * @param ctx - plugin context carrying the `tools` service.
 * @param store - the canvas store.
 * @param options.activity - the activity hub (progress bookkeeping); optional
 *   so the tool still registers in a headless composition.
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
      'The user sees the canvas by clicking the CodeFlow (⬡) icon in the left sidebar.',
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
        return [{ type: 'text', text: `CodeFlow 画布已更新（${VIEW_LABEL[value.view] ?? value.view}视图）：${value.summary}（rev ${value.rev}${where}）${warning}。点左侧栏 ⬡ 打开画布。` }]
      },
    },
    async execute(args, exec) {
      const mode = String(args.mode ?? 'render')
      // A tool call happens inside a turn, but the session directory can still
      // be the reason the turn is running in a repaired parent; use the same
      // resolved directory the prompt used.
      const execCwd = cwdOf(exec)

      if (mode === 'progress') {
        return executeProgress(args, exec, mode)
      }

      if (mode === 'render') {
        const graph = normalizeGraph(args.graph)
        if (graph === undefined) throw new Error('codeflow_canvas: `graph` must be a codeflow/1 graph object')
        const viewName = resolveView(args, store, graph?.project?.name, graph)
        // No sessionId here: rendering must not grab the canvas-session binding.
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

      if (mode === 'load') {
        // The escaping-free fill-back channel: the agent edits the view's graph
        // file on disk with its file tools, then asks the host to re-read it.
        // The graph never travels inside tool arguments, which is where long
        // nested JSON most often breaks the model's tool-call emission
        // (DSH surfaces that as `tool input is invalid JSON`).
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
        // View availability is enforced by the store's load itself (which also
        // runs the one-time layout detection): a missing view file fails with
        // an actionable error, a corrupt one is quarantined and reported.
        let loaded
        try {
          loaded = await store.loadView(project, cwd, viewName, dir)
        } catch (error) {
          throw new Error(`codeflow_canvas: mode="load" failed for "${project}"（${VIEW_LABEL[viewName]}视图）：${String(error?.message ?? error)}`
            + `（请先用文件工具把完整的 codeflow/1 图 JSON 写入该视图的图文件，再调用 load）`)
        }
        // A corrupt file is quarantined by the store, never served as an empty
        // canvas: the agent must know its write did not land, or it would
        // believe the panel simply reset.
        if (loaded?.degraded !== undefined) {
          throw new Error(`codeflow_canvas: mode="load" failed for "${project}"：${viewName === 'modules' ? 'workflow.modules.json' : 'workflow.json'} 已损坏（${loaded.degraded.reason}）`
            + `，坏文件已${loaded.degraded.quarantinedTo !== undefined ? `隔离为 ${loaded.degraded.quarantinedTo}` : '保留在原处'}；`
            + '请用文件工具重新写入完整的 codeflow/1 图 JSON 后再调用 load')
        }
        // Push the file back through the store: normalize again, bump rev, and
        // persist so the panel — which only adopts revs greater than its own —
        // refreshes to exactly what the agent wrote. Only the target view is
        // written; the other view keeps its own rev and graph.
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

      if (mode === 'read') {
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
        // Nothing in memory yet: fall back to the durable copy.
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

      if (mode === 'save') {
        const project = typeof args.project === 'string' && args.project.length > 0 ? args.project : undefined
        // save = flush every loaded view of the project (both views of a dual
        // project), so neither graph lags behind memory.
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

      throw new Error(`codeflow_canvas: unknown mode "${mode}"`)
    },
  })

  /**
   * The progress channel: one node, whitelisted fields, canvas-session only.
   *
   * The gate compares the calling agent with the project's *canvas session*
   * binding. That is what stops an unrelated conversation (or a subagent that
   * inherited the tool) from writing execution state into the panel.
   *
   * The target view is resolved from the explicit `view` argument, then the
   * run context, then the node id shape — and the patch only lands once the
   * node is actually found in that view's graph, so a wrong guess is impossible.
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
      // The node was not found where context suggested: try the other view
      // before giving up, so a stale run view can never patch the wrong graph
      // but also never strands a real update.
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
