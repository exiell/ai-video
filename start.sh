#!/usr/bin/env bash
#
# AniGuide 一键启动器（macOS / Linux）
#
# ===========================================================================
# 用法
# ===========================================================================
#   chmod +x start.sh   # 只需一次
#   ./start.sh
#
# 它做什么：检查 Node → 确保 pnpm → 按需装依赖 → 起开发服务器。
# 每一步失败都说清是哪一步、该怎么办。
# ===========================================================================

set -euo pipefail

# 切到脚本所在目录（也就是项目根）
cd "$(dirname "$0")"

# 颜色（不支持时自动降级为空）
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''
fi

banner() {
  echo
  echo "  ${C_CYAN}============================================${C_RESET}"
  echo "  ${C_CYAN}  AniGuide · AI 动漫视频创作向导${C_RESET}"
  echo "  ${C_CYAN}============================================${C_RESET}"
  echo
}

fail() {
  local title="$1"; shift
  echo
  echo "  ${C_RED}[X] ${title}${C_RESET}"
  echo
  for line in "$@"; do echo "      ${line}"; done
  echo
  exit 1
}

step() { echo "  ${C_GREEN}[$1/4]${C_RESET} $2"; }

banner

# ---------------------------------------------------------------------------
# 第 1 步：Node.js
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  fail "没有找到 Node.js" \
    "这个工具需要 Node.js 20 或更高版本才能运行。" \
    "" \
    "请去这里下载安装（选 LTS 版本）：" \
    "  https://nodejs.org/zh-cn" \
    "" \
    "macOS 也可以：brew install node"
fi

NODE_VER="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"

if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js 版本太低（当前 v${NODE_VER}，需要 20 或更高）" \
    "请去 https://nodejs.org/zh-cn 装最新 LTS 版本。" \
    "macOS 也可以：brew upgrade node"
fi
step 1 "Node.js v${NODE_VER}"

# ---------------------------------------------------------------------------
# 第 2 步：pnpm
# ---------------------------------------------------------------------------
# 只往项目目录里装：不碰 /usr、不碰全局 npm 前缀，也不要求 $HOME 可写。
# 共享服务器、公司电脑、容器里经常没有 sudo，`npm install -g` 会直接 EACCES；
# 把 pnpm、npm 缓存都放进 .tools/ 后，这类机器上 ./start.sh 也能跑通。
TOOLS_DIR="$PWD/.tools"
NPM_CACHE="$TOOLS_DIR/npm-cache"
LOCAL_PNPM="$TOOLS_DIR/node_modules/.bin/pnpm"
PNPM=""

if command -v pnpm >/dev/null 2>&1; then
  # 系统里已经有 pnpm，直接用，不重复安装
  PNPM="$(command -v pnpm)"
elif [ -x "$LOCAL_PNPM" ] && "$LOCAL_PNPM" --version >/dev/null 2>&1; then
  # 上次运行装过，直接用
  PNPM="$LOCAL_PNPM"
else
  echo "  ${C_YELLOW}[2/4] 没有 pnpm，正在装到项目内 .tools/（不需要 sudo）...${C_RESET}"

  if command -v npm >/dev/null 2>&1; then
    # --prefix：装到项目内，不写全局 npm 目录
    # --cache：npm 缓存也留在项目内，否则 $HOME 不可写时连解包都会失败
    # pnpm@10：与 pnpm-lock.yaml 的 9.0 锁文件格式对应，要升级改这里
    npm install --prefix "$TOOLS_DIR" --cache "$NPM_CACHE" \
      --no-fund --no-audit --loglevel=error pnpm@10 >/dev/null 2>&1 || true
  fi

  if [ -x "$LOCAL_PNPM" ] && "$LOCAL_PNPM" --version >/dev/null 2>&1; then
    PNPM="$LOCAL_PNPM"
  fi
fi

if [ -z "$PNPM" ]; then
  fail "pnpm 安装失败" \
    "脚本只把 pnpm 装进当前项目的 .tools/，不写系统目录，也不需要 sudo。" \
    "" \
    "常见原因与做法：" \
    "  · 网络不通 —— 检查网络，或换一个 npm 镜像源" \
    "  · 项目目录不可写 —— 把项目放到你有写权限的目录再跑" \
    "" \
    "也可以手动执行（同样只装到当前目录）：" \
    "  npm install --prefix .tools --cache .tools/npm-cache pnpm@10" \
    "  ./.tools/node_modules/.bin/pnpm install"
fi
step 2 "pnpm $("$PNPM" --version)"

# ---------------------------------------------------------------------------
# 第 3 步：依赖
# ---------------------------------------------------------------------------
# 标记文件记录上次装依赖时 lockfile 的哈希，只有它变了才重装。
STAMP="node_modules/.aniguide-install-stamp"

hash_lock() {
  if command -v md5sum >/dev/null 2>&1; then md5sum pnpm-lock.yaml | cut -d' ' -f1
  elif command -v md5 >/dev/null 2>&1; then md5 -q pnpm-lock.yaml
  else shasum -a 1 pnpm-lock.yaml | cut -d' ' -f1; fi
}

NEED_INSTALL=1
if [ -d node_modules ] && [ -f "$STAMP" ]; then
  if [ "$(cat "$STAMP")" = "$(hash_lock)" ]; then NEED_INSTALL=0; fi
fi

if [ "$NEED_INSTALL" = "1" ]; then
  step 3 "正在安装依赖（第一次大约需要 1 分钟）..."
  echo
  # --store-dir 把 pnpm 的包仓库也放在项目内。默认仓库在 $HOME，
  # 家目录只读或不可写时会在安装到一半才报权限错误。
  if ! "$PNPM" install --store-dir "$PWD/.pnpm-store"; then
    fail "依赖安装失败" \
      "常见原因与做法：" \
      "  · 网络不通 —— 检查网络，或换一个 npm 镜像源" \
      "  · 磁盘空间不足 —— 依赖大约占 120 MB" \
      "  · 报错里有 ERR_PNPM_IGNORED_BUILDS" \
      "    说明 pnpm-workspace.yaml 被改动了，恢复它即可" \
      "" \
      "原始报错就在上面，可以截图反馈。"
  fi
  hash_lock > "$STAMP"
  echo
  echo "        ${C_GREEN}依赖安装完成${C_RESET}"
else
  step 3 "依赖已是最新，跳过安装"
fi

# ---------------------------------------------------------------------------
# 第 4 步：自检 + 启动
# ---------------------------------------------------------------------------

# 端口占用说明可能已经开着一个了
if command -v lsof >/dev/null 2>&1 && lsof -i :5173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo
  echo "  ${C_YELLOW}[!] 端口 5173 已被占用 —— 可能已经开着一个了${C_RESET}"
  echo
  printf "      现在打开 http://localhost:5173/ 看看？(y/N) "
  read -r ans
  case "$ans" in
    [Yy]*) command -v open >/dev/null 2>&1 && open http://localhost:5173/ || \
           command -v xdg-open >/dev/null 2>&1 && xdg-open http://localhost:5173/ || true ;;
  esac
  exit 0
fi

# 同步盘会让 Vite 的文件监视器因文件锁崩掉
case "$PWD" in
  *OneDrive*|*Dropbox*|*"Google Drive"*|*坚果云*|*Nutstore*)
    echo
    echo "  ${C_YELLOW}[!] 提醒：这个项目在同步盘目录下${C_RESET}"
    echo
    echo "      保存文件时同步软件会生成临时文件，可能让开发服务器崩溃（报 EBUSY）。"
    echo "      vite.config.ts 里已经做了忽略处理，但如果频繁崩，建议移到普通目录。"
    echo
    ;;
esac

step 4 "启动开发服务器..."
echo
echo "  ${C_DIM}------------------------------------------------${C_RESET}"
echo "  ${C_DIM}  就绪后浏览器会自动打开${C_RESET}"
echo "  ${C_DIM}  要停止服务器：按 Ctrl+C${C_RESET}"
echo "  ${C_DIM}------------------------------------------------${C_RESET}"
echo

# 等端口真的起来再开浏览器，开太早会看到「无法访问」
(
  for _ in $(seq 1 60); do
    sleep 0.5
    if command -v lsof >/dev/null 2>&1 && lsof -i :5173 -sTCP:LISTEN >/dev/null 2>&1; then
      if command -v open >/dev/null 2>&1; then open http://localhost:5173/
      elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:5173/
      fi
      break
    fi
  done
) &
OPENER_PID=$!

# 退出时收掉后台的探测进程
trap 'kill "$OPENER_PID" 2>/dev/null || true' EXIT

"$PNPM" dev

echo
echo "  ${C_DIM}开发服务器已停止。${C_RESET}"
