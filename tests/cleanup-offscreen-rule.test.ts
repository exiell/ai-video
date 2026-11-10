import { describe, expect, it } from 'vitest';
import { runChecks } from '../src/domain/checks';
import { makeEmptyProject } from '../src/store/app';
import type { Project, Shot } from '../src/types/model';

/**
 * `offscreen-not-declared` 的直接测试（v0.55 · 测试缺口 E1）
 *
 * 这是 26 条检查规则里唯一没有测试直接引用的规则：`tests/autoFix.test.ts`
 * 只覆盖了它的自动修复提议，没有一条用例真正触发检查并断言结果。
 * 规则内容：镜头声明了画外人物，但画面三字段（起点/动作/终点）里没提到这个名字。
 */

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

describe('offscreen-not-declared · 直接补测（之前只有自动修复覆盖）', () => {
  it('**声明了画外人物，但画面三字段里没提到他 → 报出并指向这一镜**', () => {
    const shot = makeShot({
      id: 'shot-offscreen',
      number: 1,
      offscreenCharacters: ['老王'],
    });
    const issues = runChecks(projectWith(shot)).issues.filter(
      (issue) => issue.ruleId === 'offscreen-not-declared',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.location.id).toBe('shot-offscreen');
    expect(issues[0]!.title).toContain('老王');
  });

  it('画面描述里已经出现这个名字时不报（不误报）', () => {
    const shot = makeShot({
      id: 'shot-offscreen-ok',
      number: 1,
      offscreenCharacters: ['老王'],
      action: '门外传来老王的声音，他推开门',
    });
    const issues = runChecks(projectWith(shot)).issues.filter(
      (issue) => issue.ruleId === 'offscreen-not-declared',
    );
    expect(issues).toEqual([]);
  });
});
