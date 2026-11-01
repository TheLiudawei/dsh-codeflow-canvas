#!/bin/bash
#
# CodeFlow Canvas · macOS 诊断套件启动器
#
# 双击即可运行。它会：
#   1. 找到 DSH 桌面版的 Electron 可执行文件（或退回 PATH 上的 node）；
#   2. 用 ELECTRON_RUN_AS_NODE=1 运行 tests/mac/mac-check.mjs；
#   3. 把报告写到 ~/Desktop/codeflow-mac-report-<时间>/ 并在 Finder 里打开。
#
# 可用环境变量：
#   DSH_EXECUTABLE  指定 Electron/DSH 可执行文件（含空格也可）
#   REPORT_OUT      指定报告输出目录
#
# 若双击被 macOS 拦住，先在终端执行：
#   chmod +x run-mac-check.command
#   xattr -dr com.apple.quarantine run-mac-check.command
#
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
SUITE="$DIR/mac-check.mjs"

pause_if_interactive() {
  if [ -t 0 ]; then
    # shellcheck disable=SC2034
    read -r -p "按回车关闭窗口…" _ || true
  fi
}

if [ ! -f "$SUITE" ]; then
  echo "错误：找不到 $SUITE"
  echo "请确认整个 tests/mac/ 目录一起复制过来了。"
  pause_if_interactive
  exit 2
fi

EXEC="${DSH_EXECUTABLE:-}"

# 1) 常见安装位置
if [ -z "$EXEC" ]; then
  for candidate in \
    "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
    "$HOME/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
    "/Applications/DSH.app/Contents/MacOS/DSH" \
    "$HOME/Applications/DSH.app/Contents/MacOS/DSH"
  do
    if [ -x "$candidate" ]; then
      EXEC="$candidate"
      break
    fi
  done
fi

# 2) 在 Applications 里搜任何名称含 Harness / DeepSeek / DSH 的应用
if [ -z "$EXEC" ]; then
  FOUND="$(find /Applications "$HOME/Applications" -maxdepth 4 -type f -path "*.app/Contents/MacOS/*" 2>/dev/null \
    | grep -Ei "harness|deepseek|(^|/)dsh$" | head -n 1)"
  if [ -n "$FOUND" ]; then
    EXEC="$FOUND"
  fi
fi

# 3) 参数：默认给一个带时间戳的 --out，方便回传
ARGS=("$@")
HAS_OUT=0
PREV=""
OUT="${REPORT_OUT:-}"
for arg in "$@"; do
  if [ "$arg" = "--out" ]; then
    HAS_OUT=1
  fi
  if [ "$PREV" = "--out" ]; then
    OUT="$arg"
  fi
  PREV="$arg"
done

if [ "$HAS_OUT" -eq 0 ]; then
  if [ -z "$OUT" ]; then
    OUT="$HOME/Desktop/codeflow-mac-report-$(date +%Y%m%d-%H%M%S)"
  fi
  ARGS+=(--out "$OUT")
fi

# 4) 插件目录：--plugin > PLUGIN_DIR > 同仓库布局 > 已安装副本自动发现
HAS_PLUGIN=0
PREV=""
for arg in "$@"; do
  if [ "$arg" = "--plugin" ]; then
    HAS_PLUGIN=1
  fi
  if [ "$PREV" = "--plugin" ] && [ -n "$arg" ]; then
    HAS_PLUGIN=1
  fi
  PREV="$arg"
done

PLUGIN_RESOLVED=""
if [ "$HAS_PLUGIN" -eq 1 ]; then
  : # 用户显式指定，原样交给 mac-check.mjs
elif [ -n "${PLUGIN_DIR:-}" ] && [ -f "$PLUGIN_DIR/package.json" ]; then
  PLUGIN_RESOLVED="$PLUGIN_DIR"
elif [ -f "$DIR/../../package.json" ] \
  && grep -q '"name"[[:space:]]*:[[:space:]]*"dsh-codeflow-canvas"' "$DIR/../../package.json" 2>/dev/null; then
  : # 测试包就在插件仓库的 tests/mac/ 下，默认根正确
else
  # 独立压缩包：在 DSH 常见安装位置找已安装的插件目录。
  SEARCH_ROOTS=(
    "$HOME/Library/Application Support/DeepSeek Harness"
    "$HOME/Library/Application Support/DSH"
    "$HOME/Library/Application Support/deepseek-harness"
    "$HOME/.deepseek-harness"
    "$HOME/.dsh"
  )
  CANDIDATES=()
  for root in "${SEARCH_ROOTS[@]}"; do
    [ -d "$root" ] || continue
    while IFS= read -r cand; do
      [ -n "$cand" ] || continue
      if [ -f "$cand/package.json" ] \
        && grep -q '"name"[[:space:]]*:[[:space:]]*"dsh-codeflow-canvas"' "$cand/package.json" 2>/dev/null; then
        CANDIDATES+=("$cand")
      fi
    done < <(find "$root" -maxdepth 8 -type d -name "dsh-codeflow-canvas" 2>/dev/null)
  done

  UNIQUE=()
  if [ "${#CANDIDATES[@]}" -gt 0 ]; then
    for cand in "${CANDIDATES[@]}"; do
      duplicate=0
      if [ "${#UNIQUE[@]}" -gt 0 ]; then
        for seen in "${UNIQUE[@]}"; do
          if [ "$seen" = "$cand" ]; then duplicate=1; break; fi
        done
      fi
      if [ "$duplicate" -eq 0 ]; then UNIQUE+=("$cand"); fi
    done
  fi

  if [ "${#UNIQUE[@]}" -eq 1 ]; then
    PLUGIN_RESOLVED="${UNIQUE[0]}"
  elif [ "${#UNIQUE[@]}" -gt 1 ]; then
    echo "找到多个已安装的 CodeFlow 插件目录，请用 --plugin 指定其中一个："
    printf '  %s\n' "${UNIQUE[@]}"
    pause_if_interactive
    exit 2
  else
    echo "错误：当前目录不是插件仓库，也没有自动找到已安装的 CodeFlow 插件。"
    echo
    echo "请用 --plugin 指向插件目录（DSH 设置 → 插件里可以看到安装位置）："
    echo "  \"$0\" --plugin \"/路径/到/dsh-codeflow-canvas\""
    echo "或设置环境变量："
    echo "  export PLUGIN_DIR=\"/路径/到/dsh-codeflow-canvas\""
    pause_if_interactive
    exit 2
  fi
fi

if [ -n "$PLUGIN_RESOLVED" ]; then
  echo "插件目录: $PLUGIN_RESOLVED"
  ARGS+=(--plugin "$PLUGIN_RESOLVED")
fi


echo "CodeFlow Canvas · macOS 诊断套件"
echo "套件目录: $DIR"
echo "报告目录: ${OUT:-（由 mac-check.mjs 决定）}"
echo

if [ -n "$EXEC" ]; then
  echo "运行时: $EXEC"
  ELECTRON_RUN_AS_NODE=1 "$EXEC" "$SUITE" "${ARGS[@]}"
  STATUS=$?
elif command -v node >/dev/null 2>&1; then
  echo "找不到 DSH 应用，改用 Node: $(command -v node)"
  node "$SUITE" "${ARGS[@]}"
  STATUS=$?
else
  echo "错误：找不到 DSH 桌面版，也没有可用的 node。"
  echo
  echo "请先安装 DSH，或显式指定可执行文件："
  echo "  export DSH_EXECUTABLE=\"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness\""
  echo "  \"$0\""
  pause_if_interactive
  exit 2
fi

echo
if [ -n "$OUT" ] && [ -d "$OUT" ]; then
  echo "打开报告目录: $OUT"
  open "$OUT" 2>/dev/null || true
fi

if [ "$STATUS" -eq 0 ]; then
  echo "自动诊断完成：没有失败项。下一步请完成 MANUAL-CHECKLIST.md。"
else
  echo "自动诊断完成：存在失败项（退出码 $STATUS）。请查看 report.md。"
fi
pause_if_interactive
exit "$STATUS"
