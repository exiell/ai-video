#!/usr/bin/env node
/**
 * Node 版本闸（v0.54 · P2-6 补丁）
 *
 * ===========================================================================
 * 为什么需要它
 * ===========================================================================
 * 测试依赖 `jsdom@30`，它的 engines 是：
 *
 *     ^22.22.2 || ^24.15.0 || >=26.0.0
 *
 * 也就是说：22.0–22.21 不行、23.x 不行、25.x 不行。版本不够时后果不是
 * 「测试失败」，而是更坏的一种：`.tsx` 组件测试在加载阶段崩掉、被 vitest
 * **静默跳过**，屏幕上却是全绿。所以必须在入口处直接失败。
 *
 * ===========================================================================
 * 为什么单独一个脚本
 * ===========================================================================
 * `scripts/test.sh` 和 `package.json` 的 `test` 脚本都要做同一件事。
 * 两处各写一套比较逻辑，迟早会有一处漏掉 minor/patch（上一版只比主版本，
 * 22.0 / 22.10 / 23.0 都被放过）。这里只维护一份，两边调用。
 *
 * 用法：
 *   node scripts/check-node-version.mjs            # 检查当前 node
 *   node scripts/check-node-version.mjs v22.10.0   # 检查指定版本（测试/排查用）
 */

import { pathToFileURL } from 'node:url';

/** jsdom@30 的 engines 区间，错误提示里原样展示给用户 */
export const SUPPORTED_NODE_RANGE = '^22.22.2 || ^24.15.0 || >=26.0.0';

/**
 * 解析 `v22.23.4` / `22.23.4`（允许带 -rc.1 这类后缀）。
 * 解析不了返回 null——调用方按「不满足」处理，不猜。
 */
export function parseNodeVersion(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(raw ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * 完整 semver 区间判断，和 `SUPPORTED_NODE_RANGE` 一一对应：
 *  - 22.x：>= 22.22.2（即 minor > 22，或 minor === 22 且 patch >= 2）
 *  - 24.x：>= 24.15.0
 *  - 26+：全部支持
 *  - 其余（<22、23.x、25.x）一律不支持
 */
export function isSupportedNodeVersion(raw) {
  const version = parseNodeVersion(raw);
  if (!version) return false;
  const { major, minor, patch } = version;
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2);
  if (major === 24) return minor > 15 || minor === 15;
  return major >= 26;
}

function failureMessage(candidate) {
  return [
    `错误：Node ${candidate} 不满足测试要求。`,
    '',
    `  测试依赖的 jsdom@30 要求 Node.js 版本：${SUPPORTED_NODE_RANGE}`,
    '  （即 22.22.2 及以上 22.x、24.15.0 及以上 24.x、或 26 及以上；23.x / 25.x 不支持）',
    '',
    '  三种解法，任选一种：',
    '    1. 装 Node.js 22 LTS（22.22.2+）或更新版本：https://nodejs.org/zh-cn',
    '    2. 用 nvm：nvm install 22 && nvm use 22（确认实际版本 >= 22.22.2）',
    '    3. 把 Node 22.22+ 便携版解压到项目的 .tools/node-v22/（scripts/test.sh 会优先用它）',
    '',
    '  为什么卡这么严：Node 版本不够时，.tsx 组件测试会在加载阶段崩掉并被静默跳过，',
    '  屏幕上却显示全绿——必须在入口处直接失败，不能让它「看起来通过」。',
    '',
  ].join('\n');
}

function runCli(argv) {
  const args = argv.slice(2);
  // --quiet：scripts/test.sh 自己会打印 node 版本行，成功时不用再重复一遍
  const quiet = args.includes('--quiet');
  const candidate = (args.find((arg) => arg !== '--quiet') ?? process.version).trim();

  if (isSupportedNodeVersion(candidate)) {
    if (!quiet) console.log(`Node ${candidate} 满足测试要求（${SUPPORTED_NODE_RANGE}）。`);
    return 0;
  }

  console.error(failureMessage(candidate));
  return 1;
}

// 只在被直接执行时跑 CLI；被 import 时只提供函数（脚本与测试共用同一份判断）
const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
if (isMain) {
  process.exitCode = runCli(process.argv);
}
