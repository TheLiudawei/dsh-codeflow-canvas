/**
 * The `codeflow_features` tool: the agent's zero-cost window into a project's
 * feature-group index (`features.json`), and the only write path for the
 * `[CodeFlow:FEATURES]` recognition turn.
 *
 * Deliberately unlike `codeflow_canvas`:
 *
 *   - `list` never returns the graph or source code — one compact line per
 *     feature (`功能名（N）：m2,m10,m11`, ≤30 lines);
 *   - `write` records manual feature labels (`manual.labels`, keyed by
 *     relative file paths — the persistent key); files that resolve to no
 *     canvas node come back in an explicit 「未匹配」 list instead of being
 *     dropped silently;
 *   - nothing here bumps a graph `rev` or touches `workflow*.json`.
 *
 * @module dsh-codeflow-canvas/features-tool
 */
import { stat } from 'node:fs/promises'

import { projectDir } from './paths.js'
import {
  buildFeatureIndex,
  effectiveFeatures,
  emptyIndex,
  featureOp,
  graphRootOf,
  mapNodes,
  readFeatureIndex,
  writeFeatureIndex,
} from './features.js'
import { clip } from './importer.js'
import { normalizeView } from './store.js'

/** Tool name; also the key the conversation's tool card is dispatched under. */
export const FEATURES_TOOL_NAME = 'codeflow_features'

/** Resolve the workspace root of the calling agent session. */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** Resolve the durable directory of a project; `undefined` when unresolvable. */
async function dirOf(store, project, execCwd) {
  const bound = store.get(project)
  if (typeof bound.dir === 'string' && bound.dir.length > 0) return bound.dir
  if (typeof execCwd !== 'string' || execCwd.length === 0) return undefined
  try {
    return await projectDir(execCwd, project)
  } catch {
    return undefined
  }
}

/** 项目的源码根（图 meta.importedFrom），退回项目目录本身。 */
function rootOf(store, project, dir) {
  const bound = store.get(project)
  return graphRootOf(bound.graph) ?? dir
}

/**
 * Register the tool.
 *
 * @param ctx - plugin context carrying the `tools` service.
 * @param store - the canvas store (graphs are read for node mapping only).
 * @param options.logger - optional logger for non-fatal warnings.
 */
export function registerFeaturesTool(ctx, store, options = {}) {
  const logger = options.logger
  ctx.tools.register({
    name: FEATURES_TOOL_NAME,
    description: [
      'Query or write the CodeFlow feature-group index (features.json) of a canvas project — 零成本查询：直接读宿主已生成的功能分组，不需要读图、不需要重扫代码。',
      'op="list" returns compact lines 功能名（N）：m2,m10（node ids of one view, ≤30 lines; never the graph or source).',
      'op="write" records manual feature labels: features=[{name, files:[相对源码根的/分隔路径], evidence?}], mode="replace-manual"（默认，替换人工标签）| "append"; files that match no canvas node are reported back in 未匹配 instead of being dropped.',
      'op="rename"/"merge" rename or merge a feature (from/to).',
      'Call it when a [CodeFlow:FEATURES] message asks you to write recognition results, or when the user explicitly asks about feature groups; do not call it for ordinary Q&A.',
      'Writing here never touches the graph files and never bumps a rev.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: {
          type: 'string',
          enum: ['list', 'write', 'rename', 'merge'],
          description: 'list = 查询功能分组（零成本，不需要读图）；write = 写入人工功能归属；rename/merge = 重命名 / 合并功能。',
        },
        project: {
          type: 'string',
          description: '项目名（画布项目的 project.name）。必填。',
        },
        view: {
          type: 'string',
          enum: ['tasks', 'modules'],
          description: 'list 返回哪个视图的节点 id；默认面板激活视图。',
        },
        features: {
          type: 'array',
          description: 'write：功能清单 [{name, files:[...], evidence?:[...]}]；files 是相对源码根、/ 分隔的文件路径。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
              evidence: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'files'],
          },
        },
        mode: {
          type: 'string',
          enum: ['replace-manual', 'append'],
          description: 'write：replace-manual 替换全部人工标签（默认）；append 在现有标签上追加。',
        },
        from: {
          type: 'string',
          description: 'rename/merge：原功能名。',
        },
        to: {
          type: 'string',
          description: 'rename：新名 / merge：合并目标功能名。',
        },
      },
      required: ['op', 'project'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string' },
          project: { type: 'string' },
          view: { type: 'string', enum: ['tasks', 'modules'] },
          summary: { type: 'string' },
          unmatched: { type: 'number' },
        },
        required: ['op', 'project', 'summary'],
      },
      render: (args, value) => [{
        type: 'text',
        text: `codeflow_features（${value.op} · ${value.project}${value.view ? ` · ${value.view}` : ''}）：${value.summary}`,
      }],
    },
    async execute(args, exec) {
      const op = String(args.op ?? 'list')
      const project = typeof args.project === 'string' && args.project.trim().length > 0 ? args.project.trim() : undefined
      if (project === undefined) throw new Error('codeflow_features: `project` is required')
      const execCwd = cwdOf(exec)
      const dir = await dirOf(store, project, execCwd)
      if (dir === undefined) {
        throw new Error(`codeflow_features: 无法定位项目「${project}」的目录（项目未绑定工作区，且当前会话没有可用的工作目录）`)
      }
      // 幽灵项目守卫：画布没有任何状态、磁盘上也没有项目目录 → 可行动错误，
      // 而不是对一个不存在的项目默默返回「未识别到功能」。
      const bound = store.get(project)
      if (bound.rev === 0 && (bound.graph?.nodes?.length ?? 0) === 0 && bound.sessionId === undefined) {
        let exists = false
        try {
          exists = (await stat(dir)).isDirectory()
        } catch {
          exists = false
        }
        if (!exists) {
          throw new Error(`codeflow_features: 项目「${project}」不存在（没有画布状态，目录 ${dir} 也不存在）；请先在画布上新建或导入该项目`)
        }
      }
      let index = await readFeatureIndex(dir)
      if (index === null) {
        // 文件缺失：识别一次并落盘（确定性、本地），之后照常查询。
        try {
          index = await buildFeatureIndex({ root: rootOf(store, project, dir) })
          index = await writeFeatureIndex(dir, index).catch(() => index)
        } catch (error) {
          logger?.warn?.(`codeflow_features: recognition failed for ${project}: ${String(error)}`)
          index = emptyIndex()
        }
      }

      if (op === 'list') {
        const viewName = normalizeView(args.view) ?? store.get(project).activeView ?? 'tasks'
        const state = store.get(project, viewName)
        const graph = state.graph
        const root = graphRootOf(graph) ?? dir
        const eff = effectiveFeatures(index)
        const mapped = (graph?.nodes?.length ?? 0) > 0
          ? mapNodes(eff, graph, { root, manual: index.manual })
          : null
        const features = mapped ? mapped.features : eff
        const lines = []
        for (const feature of features.slice(0, 30)) {
          const nodes = feature.nodes ?? []
          if (nodes.length > 0) {
            lines.push(`${feature.name}（${nodes.length}）：${nodes.slice(0, 10).join(',')}${nodes.length > 10 ? ' 等' : ''}`)
          } else {
            const files = feature.files ?? []
            lines.push(`${feature.name}（${files.length} 个文件）：${files.slice(0, 5).join(',')}${files.length > 5 ? ' 等' : ''}`)
          }
        }
        const unmapped = mapped?.unmapped ?? []
        if (unmapped.length > 0) {
          lines.push(`未归属（${unmapped.length}）：${unmapped.slice(0, 12).join(',')}${unmapped.length > 12 ? ' 等' : ''}`)
        }
        if (lines.length === 0) lines.push('未识别到功能（features.json 为空；可让用户在画布上点「让 agent 识别」）')
        const summary = clip(lines.join('\n'), 400)
        return { op, project, view: viewName, summary, unmatched: 0 }
      }

      if (op === 'write' || op === 'rename' || op === 'merge') {
        const graphs = {
          modules: store.get(project, 'modules').graph,
          tasks: store.get(project, 'tasks').graph,
        }
        const body = op === 'write'
          ? { features: args.features, mode: args.mode }
          : { from: args.from, to: args.to }
        const result = await featureOp({
          op,
          body,
          index,
          dir,
          root: rootOf(store, project, dir),
          graphs,
          graph: graphs.modules,
          logger,
        })
        const written = result.index
        let summary
        if (op === 'write') {
          const info = result.info ?? { unmatched: [], fileCount: 0, written: 0 }
          summary = clip(
            `已写入 ${info.written} 个功能 / ${info.fileCount} 个文件（manual.labels，重建时保留）`
            + (info.unmatched.length > 0 ? `；未匹配 ${info.unmatched.length} 个：${info.unmatched.slice(0, 6).join('、')}${info.unmatched.length > 6 ? ' 等' : ''}` : ''),
            400,
          )
          return { op, project, view: normalizeView(args.view) ?? store.get(project).activeView ?? 'tasks', summary, unmatched: info.unmatched.length }
        }
        summary = op === 'rename'
          ? clip(`已重命名功能「${args.from}」→「${args.to}」（manual.renames）`, 200)
          : clip(`已把功能「${args.from}」合并到「${args.to}」（manual.merged）`, 200)
        return { op, project, view: normalizeView(args.view) ?? store.get(project).activeView ?? 'tasks', summary, unmatched: 0 }
      }

      throw new Error(`codeflow_features: unknown op "${op}"`)
    },
  })
}
