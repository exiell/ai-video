import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import * as model from '../src/types/model';
import * as checks from '../src/domain/checks';
import * as vendors from '../src/data/models/vendors';
import { useSettings } from '../src/store/settings';

/**
 * 死代码清理的回归（v0.55 · P3-1）
 *
 * ===========================================================================
 * 这组测试为什么值得存在
 * ===========================================================================
 * 这轮删掉了 20 个「全仓零引用」的导出/方法。删死代码的收益是长期的，
 * 但如果没有护栏，下一次有人「顺手加回来」时没人会注意——
 * 于是又回到「仓库里有一堆看着像公共 API、其实没人用」的状态。
 *
 * 这里做两层检查：
 *  1. 源码里不再出现这些标识符（覆盖类型导出——它们运行时不存在，只能扫源码）；
 *  2. store 的持久化入口没有 persistKeys（那个方法会绕过「不保存到本机」）。
 *
 * 批次 5 收尾时补删了两处跨目录遗留：
 *  - `stripRichMarks`（src/components/bits.tsx）
 *  - `vendorEvidence`（src/data/models/vendors.ts）
 * 现在它们和其余名字一样在名单里受保护。
 *
 * 名单同时包含**类型导出**（`ContinuityKind`、`ConsistencyLevel` 等）：
 * 类型在运行时被擦除，无法用 `in module` 检查，只能靠下面的源码文本扫描兜住；
 * 有一条测试专门验证这套扫描确实能抓到类型名。
 */

const REPO_ROOT = path.resolve(__dirname, '..');

/** 已删除的导出/方法名（全仓应零出现） */
const REMOVED_EXPORTS = [
  'storyOf',
  'ContinuityKind',
  'CONTINUITY_KIND_LABEL',
  'summarizeReport',
  'resetIssueSeq',
  'assetKindLabel',
  'findStylePreset',
  'ImageTarget',
  'platformLabel',
  'promptLineToText',
  'applyGeneration',
  'describeShotSize',
  'describeCameraMove',
  'imageCapabilityHint',
  'MODEL_PROFILE_GROUP_LABEL',
  'PromptTemplate',
  'FRAME_KIND_HINT',
  'ConsistencyLevel',
  'CONSISTENCY_LEVEL_LABEL',
  'resolveConsistencyLevel',
  'ExportBundle',
  'ChatTurn',
  'persistKeys',
  'stripRichMarks',
  'vendorEvidence',
] as const;

function walkFiles(dir: string, extensions: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walkFiles(full, extensions);
    return extensions.some((ext) => full.endsWith(ext)) ? [full] : [];
  });
}

describe('死导出/死方法清理', () => {
  const sourceFiles = [
    ...walkFiles(path.join(REPO_ROOT, 'src'), ['.ts', '.tsx']),
    ...walkFiles(path.join(REPO_ROOT, 'scripts'), ['.mjs', '.sh', '.ps1']),
  ];

  it('**被删的名字在 src/ 与 scripts/ 里不再出现**', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = readFileSync(file, 'utf8');
      for (const name of REMOVED_EXPORTS) {
        if (new RegExp(`\\b${name}\\b`).test(text)) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${name}`);
        }
      }
    }
    expect(offenders, `这些已删的导出又出现了：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('**源码扫描能抓到类型导出名**（类型运行时不存在，只能靠文本扫描）', () => {
    // 与「已删名字在 src/scripts 里不再出现」用的是同一套 Name 规则
    const scan = (text: string): string[] =>
      REMOVED_EXPORTS.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
    expect(scan('export type ContinuityKind = ...')).toEqual(['ContinuityKind']);
    expect(scan('export type ConsistencyLevel = ...')).toEqual(['ConsistencyLevel']);
    expect(scan('export function storyOf(...)')).toEqual(['storyOf']);
    expect(scan('这些词一个都没有')).toEqual([]);
  });

  it('运行时模块上确实没有那些导出（类型导出除外）', () => {
    // 运行时存在的常量/函数：值导出才算数
    expect('vendorEvidence' in vendors).toBe(false);
    expect('MODEL_PROFILE_GROUP_LABEL' in model).toBe(false);
    expect('FRAME_KIND_HINT' in model).toBe(false);
    expect('CONSISTENCY_LEVEL_LABEL' in model).toBe(false);
    expect('resolveConsistencyLevel' in model).toBe(false);
    expect('summarizeReport' in checks).toBe(false);
  });

  it('**settings 没有 persistKeys**（它没有调用方，且会绕过「不保存到本机」）', () => {
    expect('persistKeys' in useSettings.getState()).toBe(false);
  });
});
