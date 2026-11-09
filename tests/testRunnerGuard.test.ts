import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Node 版本闸（v0.54 · P2-6，task-13 补完整 semver）
 *
 * ===========================================================================
 * 为什么给两个「入口脚本」写测试
 * ===========================================================================
 * 历史上吃过的亏：系统 Node 20 下 `.tsx` 测试加载即崩、静默跳过、退出码 0，
 * 「54 个文件全过」其实少了 25 个。上版闸门只比主版本，复验又发现
 * 22.0.0 / 22.10.0 / 23.0.0 仍会被放进来自测——
 * 而 jsdom@30 的真实要求是 `^22.22.2 || ^24.15.0 || >=26.0.0`。
 *
 * 现在版本判断只有一份实现（`scripts/check-node-version.mjs`），
 * `scripts/test.sh` 与 `package.json` 的 `test` 都调用它。这里分三层验证：
 *  1. 区间判断本身（矩阵，不需要真的安装那些 Node 版本）；
 *  2. `scripts/test.sh` 在假仓库里的行为（假 node + 假 vitest，精确控制版本）；
 *  3. `package.json` 的 `test` 确实串了闸门，`pnpm test` 绕不过去。
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const CHECK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-node-version.mjs');
const tempRoots: string[] = [];

/** 用当前真实 Node 跑版本闸脚本（传入指定版本号，不依赖真的装那些版本） */
function checkVersion(version: string) {
  return spawnSync(process.execPath, [CHECK_SCRIPT, version], { encoding: 'utf8' });
}

interface FakeRepo {
  root: string;
  fakeNodeDir: string;
}

/**
 * 造一个「假仓库」：只放 scripts/test.sh + check-node-version.mjs + 假 vitest，
 * 再用一个假 node 冒充指定版本。这样能精确控制版本与退出码，不碰真实依赖。
 */
function makeFakeRepo(options: { systemNode: string; localNode?: string }): FakeRepo {
  const root = mkdtempSync(path.join(tmpdir(), 'aniguide-testsh-'));
  tempRoots.push(root);

  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, 'scripts/test.sh'), path.join(root, 'scripts/test.sh'));
  copyFileSync(CHECK_SCRIPT, path.join(root, 'scripts/check-node-version.mjs'));

  // 假 vitest：被调用时打印一行，方便断言「到底有没有跑到测试」
  const vitestPath = path.join(root, 'node_modules', '.bin', 'vitest');
  mkdirSync(path.dirname(vitestPath), { recursive: true });
  writeFileSync(vitestPath, '#!/usr/bin/env bash\necho "FAKE_VITEST $*"\n');
  chmodSync(vitestPath, 0o755);

  /** 假 node：`-v` 说自己是 version；被要求跑版本闸时用真实 node + 指定 version 代跑 */
  const makeNodeShim = (version: string, targetDir: string) => {
    const nodePath = path.join(targetDir, 'node');
    const checkPath = path.join(root, 'scripts/check-node-version.mjs');
    writeFileSync(
      nodePath,
      [
        '#!/usr/bin/env bash',
        `if [ "\${1:-}" = "-v" ]; then echo "${version}"; exit 0; fi`,
        `if [ "\${1:-}" = "${checkPath}" ]; then`,
        `  exec "${process.execPath}" "${checkPath}" "${version}"`,
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(nodePath, 0o755);
  };

  const fakeNodeDir = path.join(root, 'fake-bin');
  mkdirSync(fakeNodeDir, { recursive: true });
  makeNodeShim(options.systemNode, fakeNodeDir);

  if (options.localNode) {
    const localBin = path.join(root, '.tools', 'node-v22', 'bin');
    mkdirSync(localBin, { recursive: true });
    makeNodeShim(options.localNode, localBin);
  }

  return { root, fakeNodeDir };
}

function runTestScript(repo: FakeRepo) {
  return spawnSync('bash', [path.join(repo.root, 'scripts', 'test.sh'), 'run'], {
    cwd: repo.root,
    env: { ...process.env, PATH: `${repo.fakeNodeDir}:/usr/local/bin:/usr/bin:/bin` },
    encoding: 'utf8',
  });
}

// 本文件自己创建的临时目录跑完就删（内容只有假 shim，不涉及用户数据）
process.on('exit', () => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结论
    }
  }
});

// ---------------------------------------------------------------------------
// ① 区间判断矩阵（不需要真的安装这些版本）
// ---------------------------------------------------------------------------

describe('check-node-version · 完整 semver 区间', () => {
  const accepted = [
    'v22.22.2', // 22 线最低点
    'v22.23.4', // 本机项目内版本
    'v22.99.0',
    'v24.15.0', // 24 线最低点
    'v24.16.1',
    'v26.0.0', // 26+ 全放行
    'v26.5.1',
  ];
  const rejected = [
    'v20.19.5', // 历史假绿版本
    'v22.0.0', // 复验发现的缺口：只比主版本会放行
    'v22.10.0',
    'v22.21.9',
    'v22.22.0', // 差 patch 也不放行
    'v22.22.1',
    'v23.0.0', // 23 不在 engines 里
    'v24.0.0',
    'v24.14.9',
    'v25.9.0', // 25 不在 engines 里
    'v21.7.3',
  ];

  for (const version of accepted) {
    it(`${version} 满足要求`, () => {
      const result = checkVersion(version);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('满足测试要求');
    });
  }

  for (const version of rejected) {
    it(`**${version} 被拒绝**`, () => {
      const result = checkVersion(version);
      expect(result.status).toBe(1);
      // 提示必须包含「要求区间 + 获取方法」，用户才知道下一步做什么
      expect(result.stderr).toContain('^22.22.2 || ^24.15.0 || >=26.0.0');
      expect(result.stderr).toContain('nodejs.org');
      expect(result.stderr).toContain('jsdom@30');
    });
  }

  it('不传版本时检查当前 node（本仓库测试环境应满足）', () => {
    const result = spawnSync(process.execPath, [CHECK_SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('满足测试要求');
  });

  it('`--quiet` 时成功不输出（test.sh 自己会打印 node 版本行）', () => {
    const result = spawnSync(process.execPath, [CHECK_SCRIPT, '--quiet'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// ② scripts/test.sh 的假仓库行为
// ---------------------------------------------------------------------------

describe('scripts/test.sh · 版本闸', () => {
  it('**没有 .tools 且系统 Node 22.10.0：exit 1，不跑测试**（复验发现的缺口）', () => {
    const repo = makeFakeRepo({ systemNode: 'v22.10.0' });
    const result = runTestScript(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('22.22.2');
    expect(result.stdout).not.toContain('FAKE_VITEST');
  });

  it('**没有 .tools 且系统 Node 23.0.0：exit 1**', () => {
    const repo = makeFakeRepo({ systemNode: 'v23.0.0' });
    const result = runTestScript(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('jsdom@30');
    expect(result.stdout).not.toContain('FAKE_VITEST');
  });

  it('没有 .tools 且系统 Node 22.0.0：exit 1', () => {
    const repo = makeFakeRepo({ systemNode: 'v22.0.0' });
    const result = runTestScript(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('FAKE_VITEST');
  });

  it('没有 .tools 且系统 Node 20.19.5：exit 1（历史事故条件）', () => {
    const repo = makeFakeRepo({ systemNode: 'v20.19.5' });
    const result = runTestScript(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('FAKE_VITEST');
  });

  it('没有 .tools 但系统 Node 22.23.4：允许跑（CI 场景）', () => {
    const repo = makeFakeRepo({ systemNode: 'v22.23.4' });
    const result = runTestScript(repo);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('改用系统 node v22.23.4');
    expect(result.stdout).toContain('FAKE_VITEST');
  });

  it('没有 .tools 但系统 Node 24.15.0：允许跑（24 线最低点）', () => {
    const repo = makeFakeRepo({ systemNode: 'v24.15.0' });
    const result = runTestScript(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FAKE_VITEST');
  });

  it('**有 .tools 但项目内 Node 22.0.0：也拒绝**（不能只看目录存在）', () => {
    const repo = makeFakeRepo({ systemNode: 'v22.23.4', localNode: 'v22.0.0' });
    const result = runTestScript(repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('22.22.2');
    expect(result.stdout).not.toContain('FAKE_VITEST');
  });

  it('有 .tools/node-v22（22.23.4）时优先用它，不管系统 Node 多老', () => {
    const repo = makeFakeRepo({ systemNode: 'v20.19.5', localNode: 'v22.23.4' });
    const result = runTestScript(repo);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('项目内 .tools/node-v22');
    expect(result.stdout).toContain('FAKE_VITEST');
  });

  it('包装脚本语法合法（bash -n）', () => {
    const result = spawnSync('bash', ['-n', path.join(REPO_ROOT, 'scripts', 'test.sh')], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ③ package.json 的两个入口都绕不过闸门
// ---------------------------------------------------------------------------

describe('package.json · 测试入口不能绕过版本闸', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('**`test` 先跑版本检查再跑 vitest**（pnpm test 绕不过去）', () => {
    const testScript = pkg.scripts.test ?? '';
    expect(testScript).toContain('scripts/check-node-version.mjs');
    expect(testScript).toContain('vitest run');
    // 检查必须在前：先 gate，后测试
    expect(testScript.indexOf('check-node-version.mjs')).toBeGreaterThanOrEqual(0);
    expect(testScript.indexOf('check-node-version.mjs')).toBeLessThan(
      testScript.indexOf('vitest run'),
    );
  });

  it('`test:local` 仍然走 scripts/test.sh（本地推荐入口）', () => {
    expect(pkg.scripts['test:local']).toBe('bash scripts/test.sh run');
  });
});
