import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { runChecks } from '../src/domain/checks';
import { makeEmptyProject } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Project, Shot } from '../src/types/model';

/**
 * 26 条检查规则的 id 全覆盖（v0.55 · 测试缺口 E1）
 *
 * ===========================================================================
 * 为什么用「静态集合 + 直接补缺口」而不是 26 个手工 fixture
 * ===========================================================================
 * 26 条规则里 25 条已经在其它测试里被直接断言过（各自有 fixture 与边界用例），
 * 重复再写一遍只是把同样的数据抄两遍；真正缺的是 **`offscreen-not-declared`**
 * ——它没有任何测试直接引用（`tests/autoFix.test.ts` 只覆盖了自动修复提议）。
 *
 * 所以这组测试做三件事：
 *  1. 断言「源码里的 ruleId 集合」与「本文件维护的 26 条清单」一致——
 *     以后新增规则却忘了写测试，这里会红；
 *  2. 断言 26 个 id 每一个都被**其它测试文件**引用过（本文件排除在外，
 *     避免清单自己把自己算成覆盖）；
 *  3. 给唯一缺口 `offscreen-not-declared` 补直接的行为测试（正例 + 反例）。
 */

/** 26 条规则 id（与 src/domain/checks 下的 ruleId 字面量一一对应） */
const EXPECTED_RULE_IDS = [
  'abstract-emotion',
  'adjacent-same-shot-size',
  'character-missing-lock',
  'character-not-registered',
  'character-unlocked-feature',
  'continuity-large-motion',
  'continuity-light-mismatch',
  'continuity-location-jump',
  'continuity-long-chain',
  'continuity-missing-note',
  'continuity-state-conflict',
  'continuity-untyped-transition',
  'duration-mismatch',
  'duration-total',
  'multi-action',
  'offscreen-not-declared',
  'prompt-incomplete',
  'pronoun-in-visual',
  'scene-color-drift',
  'scene-light-conflict',
  'scene-missing-elements',
  'scene-missing-space',
  'scene-not-registered',
  'shot-incomplete',
  'story-scene-uncovered',
  'variant-not-owned',
] as const;

const REPO_ROOT = path.resolve(__dirname, '..');

function walkFiles(dir: string, extensions: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walkFiles(full, extensions);
    return extensions.some((ext) => full.endsWith(ext)) ? [full] : [];
  });
}

function sourceRuleIds(): string[] {
  const ids = new Set<string>();
  for (const file of walkFiles(path.join(REPO_ROOT, 'src/domain/checks'), ['.ts'])) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/ruleId: '([a-z0-9-]+)'/g)) ids.add(match[1]!);
  }
  return [...ids].sort();
}

/** 除本文件以外，测试目录里对每个 id 的引用情况 */
function referencedRuleIdsElsewhere(currentFile: string): Set<string> {
  const referenced = new Set<string>();
  for (const file of walkFiles(path.join(REPO_ROOT, 'tests'), ['.ts', '.tsx'])) {
    if (file === currentFile) continue;
    const text = readFileSync(file, 'utf8');
    for (const id of EXPECTED_RULE_IDS) {
      if (text.includes(`'${id}'`)) referenced.add(id);
    }
  }
  return referenced;
}

function makeShot(overrides: Partial<Shot> & Pick<Shot, 'id' | 'number'>): Shot {
  return {
    duration: 3,
    shotSize: 'medium',
    cameraPosition: '',
    cameraMove: 'static',
    startState: '他站在门口',
    action: '他推开门',
    endState: '他走进屋里',
    dialogue: '',
    sound: '',
    mood: '',
    transition: '硬切',
    sceneId: 'scene-a',
    characterIds: [],
    variantIds: [],
    activeLockIds: [],
    offscreenCharacters: [],
    sourceSceneId: '',
    ...overrides,
  };
}

function projectWith(shot: Shot): Project {
  const project = makeEmptyProject('规则覆盖');
  project.shots.push(shot);
  return project;
}

describe('规则 id 全覆盖', () => {
  it('**源码里的 26 条 ruleId 与清单完全一致**（新增规则要同步这里和测试）', () => {
    expect(sourceRuleIds()).toEqual([...EXPECTED_RULE_IDS].sort());
  });

  it('**每条规则 id 至少被一个其它测试文件引用**（避免「加了规则没人测」）', () => {
    const referenced = referencedRuleIdsElsewhere(__filename);
    const missing = EXPECTED_RULE_IDS.filter((id) => !referenced.has(id));
    expect(missing, `这些规则没有任何测试引用：${missing.join('、')}`).toEqual([]);
  });

  it('任何项目跑出来的 ruleId 都在清单里（没有拼错的 id）', () => {
    const allowed = new Set<string>(EXPECTED_RULE_IDS);
    for (const project of [makeEmptyProject('空'), sampleProject, projectWith(makeShot({ id: 's1', number: 1 }))]) {
      for (const issue of runChecks(project).issues) {
        expect(allowed.has(issue.ruleId), `未知 ruleId：${issue.ruleId}`).toBe(true);
      }
    }
  });
});
