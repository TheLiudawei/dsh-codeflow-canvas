/**
 * `codeflow-canvas` 技能：一份 SKILL.md 加四份参考文档，以打包技能提供者
 * 的形式注册。
 *
 * 为什么用提供者而不是文件系统目录：包自带提供者在任何组合下行为一致，
 * 而 `dsh-skill-filesystem` 的根是一种部署偏好（本桌面 profile 里没有）。
 * rank 值镜像 `@deepseek-ai/dsh-skill` 的 `BUNDLED_SKILL_RANK`；内联是因为
 * 外部安装的插件包从自己的模块树解析不到运行时的包。
 *
 * @module dsh-codeflow-canvas/skill
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Public skill name; also the kebab-case identity referenced by the commands. */
export const SKILL_NAME = 'codeflow-canvas'

/** Precedence rank of a packaged/bundled skill (`BUNDLED_SKILL_RANK`). */
const BUNDLED_SKILL_RANK = 600

/** Directory holding SKILL.md and its `references/`, and the skill's resource base. */
const SKILL_DIR_URL = new URL('../assets/skill/codeflow-canvas/', import.meta.url)

/** Absolute base directory the model is told to resolve relative paths against. */
export const SKILL_DIR = fileURLToPath(SKILL_DIR_URL)

/** Absolute path of SKILL.md itself. */
const SKILL_FILE = fileURLToPath(new URL('SKILL.md', SKILL_DIR_URL))

/** Parse the leading YAML frontmatter block, returning its text and the remaining body. */
function splitFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) return { frontmatter: '', body: raw }
  return { frontmatter: match[1], body: raw.slice(match[0].length) }
}

/** Read one `description:` scalar out of the frontmatter without a YAML dependency. */
function frontmatterDescription(frontmatter) {
  const match = /^description:\s*(.+)$/mu.exec(frontmatter)
  if (match === null) return undefined
  let value = match[1].trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  return value.length > 0 ? value : undefined
}

/** Cached frontmatter description and body; the files ship with the package. */
let cached

/** Read (and memoize) the skill document. */
function readSkill() {
  if (cached === undefined) {
    const raw = readFileSync(SKILL_FILE, 'utf8')
    const { frontmatter, body } = splitFrontmatter(raw)
    const description = frontmatterDescription(frontmatter)
    if (description === undefined) throw new Error('codeflow-canvas: SKILL.md has no description')
    cached = { description, body: body.trim() }
  }
  return cached
}

/**
 * 按运行时 `skill` 工具的方式渲染技能正文，命令注入的消息与模型主动加载
 * 技能在模型眼里完全一致。
 *
 * @param body - 技能正文（frontmatter 已去除）。
 * @returns 完整的面向模型的 `<skill_content>` 块。
 */
export function renderSkillBlock(body) {
  return [
    `<skill_content name="${SKILL_NAME}">`,
    '<skill_resources>',
    `Base directory for this skill: ${SKILL_DIR}`,
    'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    body,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/** The skill body, for callers that inject it into a prompt. */
export function skillBody() {
  return readSkill().body
}

/** The skill wrapped in its model-facing block. */
export function skillBlock() {
  return renderSkillBlock(skillBody())
}

/**
 * 向宿主技能注册表注册技能提供者。
 * @param ctx - 携带 `skills` 服务的插件上下文。
 */
export function registerSkill(ctx) {
  const { description } = readSkill()
  const candidate = {
    name: SKILL_NAME,
    description,
    invocation: { modelInvocable: true, userInvocable: false },
    provider: 'codeflow',
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: SKILL_DIR },
    locator: SKILL_FILE,
  }
  const provider = {
    name: 'codeflow',
    list: () => Promise.resolve([candidate]),
    get: (input) => {
      if (input?.name !== undefined && input.name !== SKILL_NAME) return Promise.resolve(undefined)
      const { rank: _rank, locator: _locator, ...summary } = candidate
      return Promise.resolve({ ...summary, content: readSkill().body })
    },
  }
  ctx.skills.registerProvider(() => provider)
}
