/**
 * 本插件需要的两个 `@deepseek-ai/dsh-llm` 构造器的最小、零依赖等价实现。
 *
 * 为什么重实现而不是导入：外部插件包装进 DSH profile 后从自己的模块树解析
 * 模块，而那棵树里没有运行时的 `@deepseek-ai/*` 包（它们在应用 bundle 内）。
 * 导入它们会让插件激活取决于 DSH 恰好装在哪。下面两个助手都是纯值构造器，
 * 在这里镜像比耦合运行时的模块图便宜。
 *
 * @module dsh-codeflow-canvas/message
 */
import { randomUUID } from 'node:crypto'

/** Recursively freeze a value so a message cannot be mutated after publication. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * 构造一条与运行时 `createUserMessage` 完全一致的用户角色消息：脱离原值、
 * 深冻结、携带全新稳定标识。
 *
 * @param {{ content: readonly { type: string, [key: string]: unknown }[], source: object }} input
 *   消息内容块 + 生产者 source 标记。
 * @returns 冻结的用户消息，可直接交给 `agent.followup()`。
 */
export function createUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/**
 * 构造本插件所有提示词共用的单文本块内容数组。
 * @param text - 提示词文本。
 * @returns 只有一个 `TextBlock` 的列表。
 */
export function textContent(text) {
  return text.length === 0 ? [] : [{ type: 'text', text }]
}
