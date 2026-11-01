/**
 * 三个斜杠命令入口，取代原插件的三份 markdown 命令。
 *
 * `/flow` 与 `/flow-new` 为 agent 框定任务，把技能文档作为一条用户回合注入
 * ——生成项目需要模型。`/flow-import` 不需要：扫描目录是确定性的，它的
 * handler 直接跑 `lib/importer.js`、经 store 写图，从不唤醒 agent。
 *
 * @module dsh-codeflow-canvas/commands
 */
import path from 'node:path'

import { importProjectDual, persistDualResult } from './duo.js'
import { createUserMessage, textContent } from './message.js'
import { projectDir } from './paths.js'
import { skillBlock } from './skill.js'
import {
  cleanPathInput,
  directoryErrorText,
  ensureAgentDirectory,
  isDirectory,
  resolveWorkspaceDirectory,
} from './workspace.js'

/** Messages travel as one user turn; an injected turn always wakes the agent. */
function injectTurn(agent, text) {
  agent.followup(createUserMessage({ content: textContent(text), source: { kind: 'user' } }))
}

/** Wrap a task description and the skill body into the one injected prompt. */
function withSkill(task) {
  return `${task}\n\n${skillBlock()}`
}

const FLOW_TASK = `用户请求打开 CodeFlow 工作流画布。

请按技能文档中“1. 打开画布”一节执行：

1. 若工作区存在 \`CodeFlow/flow-projects/*/workflow.json\`，选最近修改的一个，直接调 \`codeflow_canvas\`
   （mode="load" + project）让宿主从磁盘重载；一个项目都没有时才用 mode="render" 推一张空图。
2. 回复一两句话，告诉用户：点左侧栏的 CodeFlow 图标（⬡）即可看到画布，右键空白画布可“新建项目 / 导入项目”。`

const FLOW_NEW_TASK = `用户请求在 CodeFlow 画布中新建一个项目。

请按技能文档中“2. 处理画布消息 → NEW”一节执行：确定项目目录（\`<工作区>/CodeFlow/flow-projects/<项目名>/\`）、
按需求生成初版代码、构建任务流水线图；把补全后的整图 JSON 用文件工具写入项目的
\`workflow.json\`，然后调 \`codeflow_canvas\`（mode="load" + project）刷新画布。
**不要把整图 JSON 塞进工具参数**（mode="render" 只作后备），超长嵌套 JSON 会使工具调用解析失败。
若用户在命令后附带了需求描述，就以它为需求，不必再追问；否则先向用户询问项目名、目标语言与核心需求。`

const FLOW_IMPORT_NO_PATH = '请提供要导入的项目路径，例如：/flow-import /Users/you/project（或 ~/project、工作区相对路径 ./server）；'
  + '从输入框 @ 选中的路径也可以直接使用。一次导入会同时生成任务流水线与模块结构图。'

/**
 * 注册三个命令。
 *
 * `rawInput` 包含分隔命令名的那个空白，所以在这里修剪，只作为提示追加到
 * 任务后面。
 *
 * @param ctx - 携带 `commands` 服务的插件上下文。
 * @param store - 画布 store，导入路径使用。
 */
export function registerCommands(ctx, store) {
  const definitions = [
    {
      definitionId: 'codeflow-canvas:flow',
      name: 'flow',
      description: '打开 CodeFlow 工作流画布（ComfyUI 风格编程节点画布）',
      input: { hint: '[需求描述]' },
      task: FLOW_TASK,
      // 带了参数说明用户在描述一个项目：直接新建，而不是只打开一张空
      // 画布。
      decorate: (rawInput) => (rawInput.length === 0 ? undefined : `用户同时给出了需求描述：${rawInput}`),
      success: '已请求 agent 打开 CodeFlow 画布',
    },
    {
      definitionId: 'codeflow-canvas:flow-new',
      name: 'flow-new',
      description: '通过 CodeFlow 画布新建项目（agent 根据需求生成初版）',
      input: { hint: '[需求描述]' },
      task: FLOW_NEW_TASK,
      decorate: (rawInput) => (rawInput.length === 0 ? undefined : `用户给出的需求描述：${rawInput}`),
      success: '已请求 agent 新建 CodeFlow 项目',
    },
  ]

  for (const definition of definitions) {
    ctx.commands.register({
      definitionId: definition.definitionId,
      name: definition.name,
      description: definition.description,
      input: definition.input,
      handler: async ({ agent, rawInput }) => {
        if (agent === undefined) {
          return { kind: 'error', text: '当前没有活动会话：请先在 DSH 里打开一个会话，再执行该命令。' }
        }
        if (typeof agent.followup !== 'function') {
          return { kind: 'error', text: '当前会话没有活动的 agent：请先发一条消息，再执行该命令。' }
        }
        const repair = await ensureAgentDirectory(ctx, agent)
        if (!repair.available) return { kind: 'error', text: directoryErrorText(repair) }
        const extra = definition.decorate(String(rawInput ?? '').trim())
        const recovery = repair.repaired
          ? `\n\n（注意：会话工作目录已从 ${repair.previous} 切换到 ${repair.cwd}；不切换的话 DSH 无法启动本次 agent 回合。）`
          : ''
        injectTurn(agent, withSkill(`${extra === undefined ? definition.task : `${definition.task}\n\n${extra}`}${recovery}`))
        return {
          kind: 'success',
          text: definition.success
            + (repair.repaired ? `；工作目录已切换到 ${repair.cwd}` : '')
            + (repair.error !== undefined && !repair.repaired
              ? '；注意：DSH 工作目录校验未通过，若 agent 回合启动失败，请修正工作区'
              : ''),
        }
      },
    })
  }

  // 导入在宿主侧运行：没有技能、没有 agent 回合、零 token。一次扫描在同一个
  // 项目名下产出两个视图（任务流水线 + 模块结构图）；`--modules` 作为兼容
  // 别名被接受但被忽略。
  ctx.commands.register({
    definitionId: 'codeflow-canvas:flow-import',
    name: 'flow-import',
    description: '导入项目到 CodeFlow 画布（宿主直接扫描，同时生成任务流水线与模块结构图）',
    input: { hint: '<项目路径> [--modules]' },
    handler: async ({ agent, rawInput }) => {
      const raw = String(rawInput ?? '').trim()
      if (raw.length === 0) return { kind: 'error', text: FLOW_IMPORT_NO_PATH }
      const targetRaw = raw.replace(/(^|\s)--(modules|tasks)(\s|$)/g, ' ').trim()
      if (targetRaw.length === 0) return { kind: 'error', text: FLOW_IMPORT_NO_PATH }

      // 先修会话目录在这里同样要紧：它是图的持久化工作区、也是 agent 日后
      // 要读的目录——哪怕扫描本身在宿主侧完成。
      const repair = agent === undefined ? undefined : await ensureAgentDirectory(ctx, agent)
      let workspace = repair?.cwd
      if (workspace !== undefined && !(await isDirectory(workspace))) workspace = undefined
      if (workspace === undefined) workspace = await resolveWorkspaceDirectory(ctx, store)
      if (workspace === undefined && !path.isAbsolute(cleanPathInput(targetRaw))) {
        return {
          kind: 'error',
          text: '导入失败：还没有可用的 DSH 工作区，无法解析相对路径。请使用绝对路径（如 /Users/you/project 或 ~/project），'
            + '或先在 DSH 里打开一个项目后再试。',
        }
      }
      const target = cleanPathInput(targetRaw, { cwd: workspace })
      if (target.length === 0) return { kind: 'error', text: FLOW_IMPORT_NO_PATH }

      try {
        const existingNames = new Set(workspace === undefined ? [] : (await store.listProjects(workspace)).map((entry) => entry.name))
        for (const key of store.keys()) existingNames.add(key)
        const result = await importProjectDual({
          path: target,
          cwd: workspace,
          existingNames,
        })
        // 这里绝不绑定会话：画布会话的归属权是会话管理器（lib/sessions.js）的
        // 职责，/flow-import 绝不能抢。双图写入 + v1.1 功能索引钩子与面板
        // 导入共用同一段落地序列（persistDualResult）；目录此刻才解析——
        // features.json 与图文件必须同目录。
        const dir = workspace !== undefined ? await projectDir(workspace, result.name) : undefined
        const { writtenTasks: written, featuresSummary } = await persistDualResult(store, {
          result,
          cwd: workspace,
          dir,
          title: result.name,
        })
        const places = [
          repair?.repaired ? `工作目录已从 ${repair.previous} 切换到 ${repair.cwd}` : '',
          written.persisted === false
            ? `图谱暂存在内存中，未能写入磁盘（${written.error ?? '未知原因'}）；点画布「保存」可重试`
            : written.file !== undefined ? `已写入 ${written.file}` : '',
        ].filter(Boolean)
        const moduleNote = result.modulesGraph !== undefined
          ? `模块结构图 ${result.modulesGraph.nodes.filter((node) => node.type === 'module').length} 节点，画布上可随时切换。`
          : `模块结构图未生成（${result.modulesWarning ?? '未知原因'}）。`
        const featureNote = featuresSummary !== undefined ? featuresSummary + '。' : ''
        return {
          kind: 'success',
          text: `已导入「${result.name}」：任务流水线 ${result.tasksGraph.nodes.length} 节点。${moduleNote}${featureNote}`
            + (places.length > 0 ? `\n${places.join('；')}。` : '')
            + ' 点左侧栏 CodeFlow 图标（⬡）查看画布。',
        }
      } catch (error) {
        return { kind: 'error', text: `导入失败：${String(error?.message ?? error)}` }
      }
    },
  })
}
