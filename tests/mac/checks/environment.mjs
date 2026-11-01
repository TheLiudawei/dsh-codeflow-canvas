/**
 * 环境检查：把"这台 Mac 上什么条件成立"变成报告里可引用的条目。
 *
 * 除"是否 macOS"外，这里全部是 warn/info——环境事实不是插件缺陷，但它们
 * 决定了后面的失败是否可解释：Rosetta 下的 x64 运行时、中文主目录、
 * Gatekeeper 隔离属性、APFS 的大小写/规范化行为、启用了哪些输入法。
 *
 * @module tests/mac/checks/environment
 */

/**
 * 运行环境检查。
 *
 * @param ctx - 套件上下文（`env` / `runner`）。
 */
export async function runEnvironmentChecks(ctx) {
  const { env, runner } = ctx
  runner.group('环境与平台')

  await runner.check('ENV-01', '运行在 macOS 上', async () => {
    if (env.platform.os !== 'darwin') {
      return { warn: `当前平台是 ${env.platform.os}；Darwin 专属用例会跳过，其余检查仍可运行` }
    }
    return `${env.macos?.productVersion ?? '?'} (${env.macos?.buildVersion ?? '?'}) · ${env.platform.arch}`
  })

  await runner.check('ENV-02', '运行架构与 Rosetta', async () => {
    if (env.platform.os !== 'darwin') return { skip: '仅 macOS' }
    if (env.dsh.rosetta) {
      return { warn: `DSH 正以 Rosetta 翻译运行（${env.platform.arch}），可能与原生 arm64 在输入法、触控板事件与性能上表现不同；请记录这一事实并尽量用 arm64 版本复测` }
    }
    return `${env.platform.arch}${env.macos?.hardware ? ` / ${env.macos.hardware}` : ''}`
  })

  await runner.check('ENV-03', '插件路径形状（中文 / 空格 / 符号链接）', async () => {
    const issues = []
    if (env.plugin.hasNonAscii) issues.push('路径含非 ASCII 字符')
    if (env.plugin.hasSpace) issues.push('路径含空格')
    if (!env.plugin.linked && env.plugin.root.includes('/Downloads/')) issues.push('插件直接从下载目录运行')
    const shape = `${env.plugin.root}${env.plugin.linked ? ` → ${env.plugin.readlink ?? env.plugin.realpath}` : ''}`
    if (issues.length > 0) return { warn: `${issues.join('、')}：${shape}` }
    return shape
  })

  await runner.check('ENV-04', 'Gatekeeper 隔离属性', async () => {
    if (env.platform.os !== 'darwin') return { skip: '仅 macOS' }
    if ((env.plugin.quarantine ?? []).length > 0) {
      return { warn: `插件文件带 com.apple.quarantine（${env.plugin.quarantine.map((entry) => entry.file).join(', ')}）。若客户端 bundle 加载失败，可先执行 xattr -dr com.apple.quarantine "${env.plugin.root}" 后重启 DSH` }
    }
    return '无隔离属性'
  })

  await runner.check('ENV-05', 'DSH 应用与版本可识别', async () => {
    if (env.dsh.appBundle === undefined) {
      return { warn: '没有从可执行路径识别出 .app（可能以 node 直接运行套件）；报告里的 DSH 版本将缺失' }
    }
    const info = env.dsh.appInfo
    if (info === undefined) return { warn: `找到 ${env.dsh.appBundle}，但读不出 Info.plist` }
    return `${info.name ?? 'DSH'} ${info.shortVersion ?? '?'} (${info.build ?? '?'}) · ${info.identifier ?? '?'}`
  })

  await runner.check('ENV-06', '输入法状态（中文/日文/韩文）', async () => {
    if (env.platform.os !== 'darwin') return { skip: '仅 macOS' }
    const summary = env.input?.summary
    if (summary === undefined) return { warn: '读不到输入源列表（defaults 不可用）；IME 用例请手动确认' }
    const active = [
      summary.simplifiedChinese ? '简体中文' : '',
      summary.traditionalChinese ? '繁体中文' : '',
      summary.japanese ? '日文' : '',
      summary.korean ? '韩文' : '',
    ].filter(Boolean)
    return `${active.join('、') || '未检测到 CJK 输入法'}（${summary.enabledCount ?? '?'} 个输入源；当前 ${env.input.currentLayout ?? '?'}）`
  })

  await runner.check('ENV-07', '文件系统大小写与 Unicode 规范化行为', async () => {
    const parts = [
      env.filesystem.caseInsensitive ? '大小写不敏感' : '大小写敏感',
      env.filesystem.unicodeNormalizationInsensitive ? 'NFC/NFD 互相命中' : 'NFC/NFD 区分',
      `存储形式 ${env.filesystem.storedForm ?? '?'}`,
    ]
    return `${parts.join(' · ')}${env.filesystem.rootMount ? ` · ${env.filesystem.rootMount}` : ''}`
  })

  await runner.check('ENV-08', 'TMPDIR 与 realpath 改写', async () => {
    if (env.platform.os !== 'darwin') return { skip: '仅 macOS 的 /var → /private/var 场景' }
    return env.filesystem.tmpRealpathDiffers
      ? `TMPDIR=${env.filesystem.tmpdir}，realpath=${env.filesystem.tmpdirRealpath}（测试已覆盖保留原拼写）`
      : `TMPDIR=${env.filesystem.tmpdir}（无改写）`
  })

  await runner.check('ENV-09', '插件目录可写 / 主目录形状', async () => {
    const notes = []
    if (!env.plugin.writable) notes.push('插件目录不可写（link 安装通常仍可，但更新会失败）')
    if (env.filesystem.homeHasNonAscii) notes.push('主目录含非 ASCII 字符')
    if (env.filesystem.homeHasSpace) notes.push('主目录含空格')
    if (notes.length > 0) return { warn: notes.join('；') }
    return `可写；主目录 ${env.filesystem.home}`
  })

  await runner.check('ENV-10', '运行时版本', async () => {
    return `Electron ${env.runtime.electron ?? '—'} · Node ${env.runtime.node} · Chromium ${env.runtime.chrome ?? '—'} · ICU ${env.runtime.icu ?? '—'}`
  })

  await runner.check('ENV-11', '全键盘控制（Tab 可达性）', async () => {
    if (env.platform.os !== 'darwin') return { skip: '仅 macOS' }
    const mode = env.input?.fullKeyboardAccess
    if (mode === undefined) return { warn: '读不到 AppleKeyboardUIMode' }
    if (String(mode).trim() === '0') {
      return { warn: '全键盘控制关闭（AppleKeyboardUIMode=0）：Tab 不会聚焦按钮/复选框，键盘可访问性用例会表现不同；这是系统设置，不是插件缺陷' }
    }
    return `AppleKeyboardUIMode=${mode}`
  })
}
