/**
 * Minimal, dependency-free equivalents of the two `@deepseek-ai/dsh-llm`
 * constructors this plugin needs.
 *
 * Why re-implement instead of importing: an external plugin package installed
 * into a DSH profile resolves modules from its own tree, which does not contain
 * the runtime's `@deepseek-ai/*` packages (they live inside the application
 * bundle). Importing them would make activation depend on where DSH happens to
 * be installed. Both helpers below are pure value constructors, so mirroring
 * them here is cheaper than coupling to the runtime's module graph.
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
 * Build one user-role message exactly like the runtime's `createUserMessage`:
 * a detached, deep-frozen value carrying a fresh stable identity.
 *
 * @param {{ content: readonly { type: string, [key: string]: unknown }[], source: object }} input
 *   message content blocks plus the producer source tag.
 * @returns a frozen user message ready for `agent.followup()`.
 */
export function createUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/**
 * Build the one-text-block content array every prompt in this plugin uses.
 * @param text - prompt text.
 * @returns a single `TextBlock` list.
 */
export function textContent(text) {
  return text.length === 0 ? [] : [{ type: 'text', text }]
}
