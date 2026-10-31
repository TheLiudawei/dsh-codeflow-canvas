/**
 * Deterministic starter graph for the canvas's "新建项目" action.
 *
 * The agent remains the author of a new project's real pipeline: when a live
 * session is available the host writes this skeleton, points the agent at it
 * and lets the normal NEW flow fill it in. When no session can be reached
 * (DSH's working directory is broken, the panel was opened without `/flow`,
 * or several sessions make the owner ambiguous) the same skeleton still gives
 * the user a durable project to open, edit and run later. Without it, the
 * canvas answered every 新建 with "画布还没有绑定到会话".
 *
 * The chain is deliberately the smallest type-valid one:
 *
 *   requirement(text) → design(text) → codegen(any) → testgen(code)
 *     → testrun(code) → deliver(any)
 *
 * `write` is attached as a branch from `codegen` because `write` emits a
 * report, which the code-typed `testgen` input cannot accept.
 *
 * @module dsh-codeflow-canvas/starter
 */
import { clip, freeName } from './importer.js'
import { safeProjectName } from './store.js'

/** Horizontal spacing used by the canvas's own default layout. */
const STEP_X = 330

/**
 * Build a starter graph for a new project.
 *
 * @param options.name - requested project name (sanitized here).
 * @param options.brief - requirement text.
 * @param options.language - project language, default `python`.
 * @param options.existingNames - project names already under `flow-projects/`.
 * @returns `{ graph, projectName, renamed }`.
 */
export function buildStarterGraph(options = {}) {
  const base = safeProjectName(options.name)
  const projectName = freeName(base, options.existingNames)
  const brief = String(options.brief ?? '').trim()
  const language = typeof options.language === 'string' && options.language.length > 0
    ? options.language
    : 'python'
  const now = new Date().toISOString()

  const nodes = []
  const links = []
  let x = 60
  const add = (node) => {
    node.pos = [x, 80]
    x += STEP_X
    nodes.push(node)
    return node.id
  }
  const link = (from, fromSlot, to, toSlot) => links.push([from, fromSlot, to, toSlot])

  const requirement = add({
    id: 't1',
    type: 'requirement',
    title: '需求',
    params: { brief, language },
    status: brief.length > 0 ? 'done' : 'pending',
    result: brief.length > 0 ? clip(brief, 80) : '',
    detail: '',
  })
  const design = add({
    id: 't2',
    type: 'design',
    title: '技术方案',
    params: { depth: '标准', notes: '' },
    status: 'pending',
    result: '',
    detail: '',
  })
  const codegen = add({
    id: 't3',
    type: 'codegen',
    title: '代码生成',
    params: { language, dir: '', prompt: brief },
    status: 'pending',
    result: '',
    detail: '',
  })
  const write = add({
    id: 't4',
    type: 'write',
    title: '文件写入',
    params: { dir: '' },
    status: 'pending',
    result: '',
    detail: '',
  })
  const testgen = add({
    id: 't5',
    type: 'testgen',
    title: '测试生成',
    params: { framework: '自动' },
    status: 'pending',
    result: '',
    detail: '',
  })
  const testrun = add({
    id: 't6',
    type: 'testrun',
    title: '测试运行',
    params: { cmd: '' },
    status: 'pending',
    result: '',
    detail: '',
  })
  const deliver = add({
    id: 't7',
    type: 'deliver',
    title: '交付打包',
    params: { notes: `汇总 ${projectName} 的交付` },
    status: 'pending',
    result: '',
    detail: '',
  })

  link(requirement, 0, design, 0)
  link(design, 0, codegen, 0)
  link(codegen, 0, write, 0)
  link(codegen, 0, testgen, 0)
  link(testgen, 0, testrun, 0)
  link(testrun, 0, deliver, 0)

  return {
    graph: {
      format: 'codeflow/1',
      rev: 0,
      project: { name: projectName, language, origin: 'new' },
      nodes,
      links,
      meta: { createdAt: now, updatedAt: now, starter: true },
    },
    projectName,
    renamed: projectName !== base,
  }
}
