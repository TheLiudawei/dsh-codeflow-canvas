# CodeFlow Canvas · macOS 诊断套件

这是发给 Mac 用户的一套**只读诊断测试**：它不修改插件源码、不扫描你的真实项目、不上传任何数据，只在本机临时目录里跑一遍真实的路由、路径、导入、压缩包与撤销流程，并生成一份可以直接回传的报告。

它面向两个问题：

1. **「假按键」**——键盘输入被画布吃掉、中文输入法选词误触、重复/丢字、⌘ 快捷键不对；
2. **「UI 不显示」**——画布白屏、只有工具栏、节点不出现、连线消失、对话框被裁切。

此外覆盖 macOS 特有的触控板滚动/缩放、右键与 Control+点击、Finder 拖拽导入、中文/NFD 路径与工作目录。

---

## 一、三件套

| 文件 | 作用 | 谁来做 |
| --- | --- | --- |
| `mac-check.mjs` | 自动诊断：约 75 项主机侧检查，生成 `report.md` / `results.json` / `environment.json` | 终端一条命令 |
| `MANUAL-CHECKLIST.md` | 手动清单：必须由人观察的 UI、键盘、手势、拖拽、运行行为 | 用户按步骤操作并记录 |
| `console-probe.js` | 画布内探针：在 DevTools 里旁听焦点、按键、输入法、滚轮、右键、拖拽并导出 JSON | 有 DevTools 的用户 |

自动诊断负责**能确定的事实**，手动清单负责**只有真人能判断的体验**，探针负责**把"感觉不对"变成可对照的事件流**。三者缺一不可。

---

## 二、快速开始（10 分钟）

### 0. 准备

- macOS 12 或更新；
- 已安装 DSH 桌面版，且已安装 CodeFlow Canvas 插件（设置 → 插件里能看到 `dsh-codeflow-canvas`）；
- 把整个插件仓库目录（含 `tests/mac/`）放在本机；如果只拿到了测试套件，运行时用 `--plugin` 指向已安装的插件目录。

### 1. 跑自动诊断

**方式 A：双击（推荐）**

在 Finder 里双击 `run-mac-check.command`。如果 macOS 提示"无法打开"，在终端执行一次：

```bash
chmod +x "/路径/到/dsh-codeflow-canvas/tests/mac/run-mac-check.command"
```

**方式 B：终端**

```bash
cd "/路径/到/dsh-codeflow-canvas"
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  tests/mac/mac-check.mjs
```

应用名或安装位置不同时，把可执行文件路径换成你的；也可以先设置：

```bash
export DSH_EXECUTABLE="/Applications/你的应用.app/Contents/MacOS/你的应用"
```

报告默认写到 `~/Desktop/codeflow-mac-report-<时间>/`。终端会打印结论和失败项。

> 只装过 Node、没有 DSH 的机器也可以：把上面的 Electron 命令换成 `node tests/mac/mac-check.mjs`。但涉及 DSH 版本/应用信息的项会显示为警告。

### 2. 跑手动清单

打开 `MANUAL-CHECKLIST.md`。至少完成顶部的 **快速回归 17 项**；有条件再做完整版。每项用 `☐ 通过 / ☐ 失败 / ☐ 无法执行` 记录。

### 3. 采集画布内探针（怀疑假按键 / UI 不显示时必做）

1. 打开 DSH，切到 CodeFlow 面板；
2. 打开开发者工具：`⌘⌥I`（或菜单 View → Developer → Developer Tools）；
3. 在 Console 里粘贴 `console-probe.js` 的全部内容。若提示 `Don't paste code`，先在 Console 输入 `allow pasting` 回车，再粘贴；
4. 依次运行：

```js
CodeFlowProbe.ui()       // 先看 UI 诊断与 problems 列表
CodeFlowProbe.start()    // 开始记录
// 按清单操作：打字、中文选词、双指滚动、右键、从 Finder 拖文件……
CodeFlowProbe.download() // 下载 codeflow-probe-*.json
```

探针在主窗口或画布 iframe 的 Console 里都能运行；它会自动找到同源的 CodeFlow iframe。

### 4. 回传

把整个报告目录压缩回传，里面应包含：

```
codeflow-mac-report-<时间>/
  report.md            ← 自动诊断结论（最重要）
  results.json         ← 完整逐项结果
  environment.json     ← 环境快照
  probe.json           ← CodeFlowProbe.download() 导出的文件（若做了）
  screenshots/         ← 手动清单里截的图
  手动清单.md           ← 填好的 MANUAL-CHECKLIST.md
```

如果发生崩溃，再附上 `~/Library/Logs/DiagnosticReports/` 里最近与 DSH 相关的 `.ips` 文件。

---

## 三、自动诊断做了什么

全部在**临时目录**里运行，不触碰你已有的 CodeFlow 项目：

| 组 | 覆盖 | 典型 ID |
| --- | --- | --- |
| 环境与平台 | macOS 版本/构建、架构与 Rosetta、APFS 大小写与 NFC/NFD、TMPDIR realpath、输入法、Gatekeeper 隔离、插件路径形状 | `ENV-*` |
| 插件包完整性 | package.json 导出面、`lib/**` 的 import 精确解析与真实加载、客户端 bundle 注册与 `apply()`、技能文档、画布资产是否截断 | `PKG-*` |
| 画布文档（UI 不显示） | 内联脚本语法、关键 DOM id、启动链路、主题机制、boot 载荷、`</script>` 注入、离线自包含 | `DOC-*` |
| HTTP 启动面 | 真实路由 + 真实 store：boot 200、主题、无工作区降级、中文/空格项目、NFC/NFD 同名、损坏文件隔离、HEAD/405、rev 冲突、重启恢复、双视图 | `WEB-*` |
| 路径与 Unicode | `@`/引号/`file://`/`~`、中文与空格、NFD 命中 NFC、大小写、符号链接、权限、cwd 修复、配置读写、项目名清洗 | `PATH-*` |
| 确定性导入 | 中文夹具的节点/扫描、跳过清单、两次导入一致、NFD 根、模块图有界、功能索引、`/api/import` 端到端、CLI | `IMP-*` |
| 压缩包与 Finder 拖拽 | NFD 条目、zip-slip、Finder 的 `__MACOSX`/`.DS_Store`、tar/tar.gz、符号链接、上传冲突改名、7z/rar 候选 | `ARC-*` |
| 状态与撤销 | 中文项目重载、逐视图 rev、中文/NFD 文件快照与恢复、排除目录、LIFO、根边界 | `ST-*` |
| Mac 交互风险扫描 | 键盘/滚轮/右键/拖拽监听器的精确行号与已知风险（IME 守卫、触控板缩放、⌘Z） | `RISK-*` |

**不会做的事**：不启动 DSH、不调用模型、不访问网络、不读写 `~/Library`、不修改插件文件。可选的 `--with-core` 会额外跑仓库自带的 7 个自检（较慢）。

### 结果怎么读

- **通过**：这一项在当前机器上符合预期。
- **失败**：可复现的插件缺陷，优先看。
- **警告**：平台事实或已知差异（Rosetta、Gatekeeper、无 7z 解压器、macOS 上缺失的 ⌘Z 等），通常需要手动清单印证。
- **跳过**：前置条件不满足（例如非 APFS、非 macOS、权限用例在 root 下）。

终端退出码：`0` 无失败，`1` 有失败，`2` 参数/环境错误。

---

## 四、本套件已知会报告（或可能报告）的 Mac 特有问题

这些是**测试已经定位到的**，不是猜测：

1. **Finder 压缩包的 `__MACOSX/._*` 与 `.DS_Store` 会被当成源码扫描**（`ARC-03`）。用 Finder「压缩」得到的 zip 解压后，`__MACOSX/<项目>/src/._用户模块.js` 扩展名仍是 `.js`，模块图里会出现垃圾节点。手动清单 `DRP-02` 会复现。
2. **7z / rar 在 macOS 上没有外部解压器候选**（`ARC-10`）。`lib/archive.js` 只枚举 Windows 的 `System32\tar.exe`、`7-Zip`、`WinRAR`；Mac 上拖入 `.7z`/`.rar` 会得到"没有可用的 7z/rar 解压器"。建议手动解压后拖文件夹。
3. **触控板双指滚动会触发缩放**（`RISK-03`）。`onWheel` 对任何 `wheel` 都按固定 12% 缩放，不区分 macOS 捏合（带 `ctrlKey`）、不看 `deltaMode`、不看 `deltaX`；纯横向滚动时 `deltaY=0` 会落入缩小分支。
4. **没有输入法组合态守卫**（`RISK-02`）。画布不检查 `isComposing`，也不监听 `compositionstart/end`；中文输入法用空格/回车确认候选词时，若焦点在画布内，按键会被画布消费。
5. **撤销只绑定 Ctrl+Alt+Z**（`RISK-04`）。macOS 上实际是 Control+Option+Z，且没有 ⌘Z / ⌘⇧Z。
6. **CLI `--json` 不落模块图**（`IMP-10`，警告）。脚本化导入只写 `workflow.json`；GUI 导入不受影响。

请在报告里保留这些项的真实结果——它们正是需要修的地方。

---

## 五、探针输出怎么看

`CodeFlowProbe.report()` / `download()` 的 JSON 有三块：

- `ui`：`problems` 是自动归纳的 UI 问题清单（尺寸为 0、boot 有节点但 DOM 没有、图标未替换、空状态未显示、横幅文本等）；`dom` / `styles` / `viewport` / `focus` 是原始事实。
- `summary.findings`：
  - `keysPreventedByCanvas`：有多少按键被画布 `preventDefault()`；
  - `keysDuringComposition`：输入法组合态内到达的按键数；
  - `wheelEventsThatZoomed` / `horizontalWheelEvents`：滚轮事件里有多少真的改变了缩放、多少是纯横向；
  - `dragDeliveredDirectoryEntry`：Finder 拖入时是否真的交付了目录条目；
  - `focusInCanvas`：焦点进入画布多少次。
- `logs`：逐条事件（目标元素、是否可编辑、是否 preventDefault、事件前后节点数/缩放/菜单数的变化）。

典型判读：

- 在聊天框打字却看到 `keysPreventedByCanvas > 0` → 画布抢了键盘（`KEY-01..04`）。
- 中文选词时 `keysDuringComposition > 0` 且被 preventDefault → 输入法误触（`KEY-07..09`）。
- 双指轻扫 `wheelEventsThatZoomed` 接近 `wheelEvents` → 触控板滚动即缩放（`TRK-01`）。
- 拖入文件夹 `dragDeliveredDirectoryEntry=false` 且 `files=[]` → 浏览器没交付条目，拖拽导入必然失败（`DRP-01`）。
- `ui.problems` 里出现"boot 有 N 个节点但 DOM 里一个都没有" → 首绘失败，把 `errors` 一起回传（`UI-01/06`）。

---

## 六、隐私与安全

- 自动诊断只读取**插件安装目录**与**系统环境**；不读取你的项目、聊天记录、凭据。
- 所有夹具在 `$TMPDIR/codeflow-mac-work-*`，默认结束即删；`--keep` 才保留（排查导入/撤销时有用）。
- 报告默认把主目录脱敏成 `~`（`--no-redact` 可关闭）。中文项目名、文件名会保留，因为那正是诊断对象。
- 探针数据只存在页面内存，不上传、不写 `localStorage`；`download()` 由你决定是否回传。
- 手动清单建议在**测试副本**上操作；`shell` 节点只填 `echo` 这类无副作用命令。

---

## 七、故障排查

**`ELECTRON_RUN_AS_NODE` 不生效 / 提示不是可执行文件**

确认路径指向 `.app/Contents/MacOS/` 里的二进制，而不是 `.app` 目录；路径含空格时整体加引号。

**双击 `.command` 没反应**

```bash
chmod +x tests/mac/run-mac-check.command
xattr -dr com.apple.quarantine tests/mac/run-mac-check.command
```

再双击；或在终端 `bash tests/mac/run-mac-check.command`。

**报告里所有项都跳过**

多半是 `--plugin` 指错了目录。确认该目录下有 `package.json` 与 `lib/index.js`。

**只想复跑某一组**

```bash
ELECTRON_RUN_AS_NODE=1 "$DSH_EXECUTABLE" tests/mac/mac-check.mjs --filter PATH
```

前缀可取 `ENV` / `PKG` / `DOC` / `WEB` / `PATH` / `IMP` / `ARC` / `ST` / `RISK`。

**想保留临时夹具**

加 `--keep`，结束时终端会打印目录；导入/撤销的中间文件都在里面。

**画布探针找不到画布**

先在侧边栏打开 CodeFlow 面板；或在 DevTools 的 context 下拉里选中 `codeflow/canvas` 这个 iframe，再粘贴脚本。

---

## 八、文件地图

```
tests/mac/
  mac-check.mjs              自动诊断入口（CLI）
  run-mac-check.command      macOS 双击启动器
  console-probe.js           DevTools 探针（粘贴即用）
  MANUAL-CHECKLIST.md        手动测试清单（填写后回传）
  REPORT-TEMPLATE.md         问题汇总模板
  README.md                  本文件
  lib/
    environment.mjs          环境采集
    runner.mjs               检查运行器（ok/fail/warn/skip）
    report.mjs               Markdown/JSON 报告
    harness.mjs              假宿主、假 req/res、图构造器
    fixtures.mjs             Mac 形状夹具、zip/tar 构造器
  checks/
    environment.mjs  plugin.mjs  canvas-doc.mjs  http.mjs
    paths.mjs        import.mjs  archive.mjs     state.mjs  risk.mjs
```

套件版本：`1.0.0`（与被测插件版本无关）。报告里的 `suiteVersion` 用于区分不同轮次的测试。
