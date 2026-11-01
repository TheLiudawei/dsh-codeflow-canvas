/**
 * 画布「新建项目」动作的确定性骨架图。
 *
 * agent 仍是新项目真实流水线的作者：有可用会话时，宿主写下这份骨架、把
 * agent 指向它，让正常的 NEW 流程去填。连不上会话时（DSH 工作目录坏了、
 * 面板没经 `/flow` 打开、多个会话使归属含糊），同一份骨架仍然给用户一个
 * 可打开、可编辑、日后可运行的持久项目。没有它，画布对每次新建都只会回答
 * "画布还没有绑定到会话"。
 *
 * 这条链刻意取类型合法的最小形态：
 *
 *   requirement(text) → design(text) → codegen(any) → testgen(code)
 *     → testrun(code) → deliver(any)
 *
 * `write` 作为 `codegen` 的分支挂上，因为 `write` 产出 report，而 code 类型
 * 的 `testgen` 输入口不接受 report。
 *
 * @module dsh-codeflow-canvas/starter
 */
import { clip } from './core/text.js'
import { freeName } from './core/path.js'
import { safeProjectName } from './core/path.js'

/** Horizontal spacing used by the canvas's own default layout. */
const STEP_X = 330

/**
 * 为新项目构建骨架图。
 *
 * @param options.name - 期望的项目名（在这里安全化）。
 * @param options.brief - 需求文本。
 * @param options.language - 项目语言，默认 `python`。
 * @param options.existingNames - 项目根下已被占用的项目名。
 * @returns `{ graph, projectName, renamed }`。
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
