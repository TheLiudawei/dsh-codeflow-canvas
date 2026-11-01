/**
 * 功能归属识别的词典层：静态领域词典 + 归一查找。
 *
 * 词典（静态常量，不引分词库）：canonical 功能名 → 归一 tokens（小写英文 +
 * 中文别名）。刻意**不收**最泛化的编程词（order/push/find/query/node/file/user
 * 单独出现时噪声远大于信号），只保留领域含义明确的组合——未命中就显示
 * 标识符原文，绝不硬凑。
 *
 * `manual.aliases` 是用户扩展词典的入口：buildDictionary 会把它们叠加到
 * 静态词典之上（canonical 不变，token 可新增）。
 *
 * 依赖方向：无 import。
 *
 * @module dsh-codeflow-canvas/features/dictionary
 */

/**
 * 静态领域词典：`[canonical 名, tokens[]]`。
 */
export const BASE_DICTIONARY = [
  ['登录', ['login', 'signin', 'auth', 'authentication', 'session', 'oauth', 'jwt', 'passport', '登录', '认证', '鉴权', '会话']],
  ['注册', ['register', 'signup', 'registration', '注册']],
  ['权限', ['permission', 'rbac', 'acl', '权限', '角色']],
  ['支付', ['payment', 'checkout', 'billing', '支付', '结算', '钱包', '账单']],
  ['订单', ['orders', 'cart', '订单', '购物车']],
  ['上传', ['upload', '上传']],
  ['下载', ['download', '下载']],
  ['导出', ['导出', '报表']],
  ['导入', ['importer', '导入']],
  ['搜索', ['search', '搜索', '检索']],
  ['通知', ['notify', 'notification', '通知', '推送']],
  ['设置', ['setting', 'settings', 'preference', '偏好', '设置']],
  ['收藏', ['favorite', 'favorites', 'bookmark', '收藏', '书签', '点赞']],
  ['评论', ['comment', 'comments', '评论', '回复']],
  ['统计', ['statistics', 'analytics', '统计', '指标']],
  ['缓存', ['cache', 'cached', 'redis', '缓存']],
  ['日志', ['logger', 'logging', '日志']],
  ['配置', ['config', 'configuration', '配置']],
  ['路由', ['router', 'routing', '路由']],
  ['数据库', ['database', 'schema', 'migration', 'migrations', '数据库']],
  ['测试', ['test', 'tests', 'spec', '测试']],
  ['部署', ['deploy', 'deployment', '部署']],
  ['画布', ['canvas', '画布']],
  ['节点', ['节点']],
  ['插件', ['plugin', 'plugins', '插件', '扩展']],
  ['用户', ['user', 'users', 'account', 'profile', '用户', '账户', '账号']],
  ['消息', ['messages', '消息', '聊天']],
  ['文件', ['files', 'storage', '文件', '存储']],
  ['任务', ['tasks', '任务', '作业']],
  ['首页', ['dashboard', '首页', '仪表盘', '总览']],
]

/**
 * 把一次识别到的原始名称归一到词典里的功能名；未命中就显示标识符原文。
 * `extra` 是 `manual.aliases` 扩展出来的 token（canonical → [tokens]）。
 */
export function buildDictionary(extraAliases) {
  const map = new Map()
  for (const [canonical, tokens] of BASE_DICTIONARY) {
    map.set(canonical, canonical)
    for (const token of tokens) {
      const key = token.toLowerCase()
      if (!map.has(key)) map.set(key, canonical)
    }
  }
  for (const [canonical, tokens] of Object.entries(extraAliases ?? {})) {
    if (!Array.isArray(tokens)) continue
    if (!map.has(canonical)) map.set(canonical, canonical)
    for (const token of tokens) {
      if (typeof token !== 'string' || token.trim().length === 0) continue
      const key = token.trim().toLowerCase()
      if (!map.has(key)) map.set(key, canonical)
    }
  }
  return map
}

/**
 * 拆词：camelCase / snake_case / kebab-case / 中文连续段。
 * 中文长段额外产出 2-gram（「用户登录」→ 用户/户登/登录），使词典能命中。
 */
export function wordsOf(text) {
  const out = []
  const parts = String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9\u4e00-\u9fff]+/)
  for (const part of parts) {
    if (!part) continue
    if (/^[\u4e00-\u9fff]+$/.test(part) && part.length > 2) {
      out.push(part)
      for (let i = 0; i < part.length - 1; i += 1) out.push(part.slice(i, i + 2))
    } else {
      out.push(part.toLowerCase())
    }
  }
  return [...new Set(out.filter(Boolean))]
}

/** 词典查找：整词优先，其次拆词正序、再倒序；命中返回 canonical 名。 */
export function lookupDictionary(token, dictionary) {
  const text = String(token ?? '').trim()
  if (!text) return undefined
  const words = wordsOf(text)
  const candidates = [text.toLowerCase(), ...words]
  for (let i = words.length - 1; i >= 0; i -= 1) candidates.push(words[i])
  for (const candidate of candidates) {
    const hit = dictionary.get(candidate)
    if (hit !== undefined) return hit
  }
  return undefined
}
