#!/usr/bin/env bash
#
# 用项目内自带的 Node 跑测试
#
# ===========================================================================
# 为什么需要这个脚本
# ===========================================================================
# `jsdom@30` 声明要求的运行时是 `^22.22.2 || ^24.15.0 || >=26`，而很多机器上装的是
# Node 20。版本不够时，后果不是「测试失败」，而是更坏的一种：
#
#   - `.tsx` 组件测试在**加载阶段**就崩在 undici 的 `webidl.util.markAsUncloneable`
#   - vitest 只打一条 Unhandled Error，不计入 Failed Tests
#   - 于是 `Test Files 23 passed` 看着是绿的，实际 25 个文件根本没跑
#
# 也就是说：改坏了 UI 也看不出来。这个脚本把 Node 版本固定到项目内的
# `.tools/node-v22`（便携版，不需要 sudo，也不改系统 PATH）。
#
# ===========================================================================
# 【v0.54 · P2-6】没有 .tools 时不再只是「警告一下」
# ===========================================================================
# 新克隆的仓库没有 `.tools/`（它被 gitignore），原来脚本在那种环境下只打印一句
# 警告就退回系统 Node——如果系统 Node 是 20，就是上面那次假绿的同一条件，
# 而且退出码是 0。现在：
#   - 系统 Node 主版本 >= 22：允许用，打印提示（CI 就是这种情况）；
#   - 主版本 < 22：直接 exit 1，并给出获取 Node 22 的方法。
# 宁可让测试跑不起来，也不要让它「看起来全绿」。
#
# 用法：
#   bash scripts/test.sh            # 跑一遍
#   bash scripts/test.sh run -t 分镜  # 其余参数原样传给 vitest
# ===========================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

LOCAL_NODE_DIR="$PWD/.tools/node-v22/bin"
CHECK_NODE="$PWD/scripts/check-node-version.mjs"

# 完整 semver 区间判断集中在一处（scripts/check-node-version.mjs）：
# jsdom@30 的 engines 是 ^22.22.2 || ^24.15.0 || >=26.0.0，
# 只比主版本会放过 22.0 / 22.10 / 23.x —— 那些版本下 .tsx 测试同样会静默跳过。
if [ -x "$LOCAL_NODE_DIR/node" ]; then
  export PATH="$LOCAL_NODE_DIR:$PATH"
  if ! "$LOCAL_NODE_DIR/node" "$CHECK_NODE" --quiet; then
    echo "" >&2
    echo "错误：项目内 .tools/node-v22 的 Node 版本不满足测试要求（原因见上）。" >&2
    echo "      把它换成 22.22.2+（或 24.15+ / 26+）的便携版，或删掉后改用系统 Node。" >&2
    exit 1
  fi
  echo "node: $("$LOCAL_NODE_DIR/node" -v)（项目内 .tools/node-v22）"
else
  if ! command -v node >/dev/null 2>&1; then
    echo "错误：找不到 node。测试需要 Node.js ^22.22.2 || ^24.15.0 || >=26.0.0。" >&2
    echo "  安装地址：https://nodejs.org/zh-cn（22 线请用 22.22.2+）" >&2
    echo "  或者把 22.22+ 便携版放到 .tools/node-v22/bin/node，脚本会自动优先用它。" >&2
    exit 1
  fi

  # 版本不满足时，这个脚本会打印「当前版本 / 要求区间 / 三种解法」并以非零退出
  if ! node "$CHECK_NODE" --quiet; then
    echo "提示：也可以把 22.22+ 便携版放到 .tools/node-v22/，test.sh 会优先用它。" >&2
    exit 1
  fi

  echo "提示：没找到 .tools/node-v22，改用系统 node $(node -v)（版本满足测试要求）。"
  echo "      如果实际跑到的测试文件明显少于 tests/ 里的数量，说明仍有文件被静默跳过。"
fi

if [ "$#" -eq 0 ]; then
  set -- run
fi

exec ./node_modules/.bin/vitest "$@"
