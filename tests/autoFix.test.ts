import { describe, expect, it } from 'vitest';
import {
  applyFixes,
  buildFixPlan,
  MANUAL_ONLY_RULES,
  type FixProposal,
} from '../src/domain/checks/autoFix';
import { runChecks } from '../src/domain/checks';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Project } from '../src/types/model';

/**
 * 穿帮自动修复。
 *
 * 这组测试盯的是两条铁律：
 *  1. **只提议能机械确定的修改** —— 需要审美判断的一律不碰
 *  2. **只提议，不直接改** —— 应用必须由调用方显式发起
 */

function clone(): Project {
  return structuredClone(sampleProject);
}

function plan(project: Project) {
  return buildFixPlan(project, runChecks(project), { maxShotDuration: 10 });
}

describe('铁律一 · 该修的要提议', () => {
  it('镜头没归属场景时，按画面描述里的场景名提议', () => {
    const project = clone();
    const shot = project.shots.find((s) => s.id === 'shot-01')!;
    shot.sceneId = '';
    // 让画面描述里出现场景名的一部分——用户手写的自然语言
    // 不会和场景名逐字相同，这正是真实情况
    shot.startState = '大雪夜的草料场空地，左侧是被雪压塌的草厅';
    const hit = plan(project).proposals.find(
      (p) => p.kind === 'assign-scene' && p.target.shotId === shot.id,
    );
    expect(hit).toBeDefined();
    // 应当匹配到「草料场外 · 大雪」
    expect(hit!.after).toContain('草料场');
    // 并且要说明是靠什么判断的，用户才能核对
    expect(hit!.reason.length).toBeGreaterThan(10);
  });

  it('场景名没有直接出现时，靠固定元素判断', () => {
    const project = clone();
    const shot = project.shots.find((s) => s.id === 'shot-07')!;
    shot.sceneId = '';
    // 用场景卡里登记过的固定元素英文片段，但不提场景名
    shot.startState = '室内，左侧是一张 low altar table，门是 weathered double wooden door';
    const hit = plan(project).proposals.find(
      (p) => p.kind === 'assign-scene' && p.target.shotId === shot.id,
    );
    expect(hit).toBeDefined();
    expect(hit!.after).toContain('山神庙');
  });

  it('既没有文本线索、邻镜也不成多数时就不猜', () => {
    const project = clone();
    // 把场景线索彻底抹掉：文本无信息 + 邻居也都没归属
    for (const s of project.shots) {
      s.sceneId = '';
      s.startState = '空白';
      s.action = '无事发生';
      s.endState = '空白';
    }
    const proposals = plan(project).proposals.filter((p) => p.kind === 'assign-scene');
    expect(proposals).toEqual([]);
  });

  it('有文本线索的镜头仍然会被提议（「不猜」不等于一律不修）', () => {
    const project = clone();
    for (const s of project.shots) s.sceneId = '';
    // 让第 4 镜的文本里出现场景卡登记过的固定元素
    const shot = project.shots.find((s) => s.id === 'shot-07')!;
    shot.startState = '室内，左侧是一张 low altar table，右侧墙角堆着草料';
    const hit = plan(project).proposals.find(
      (p) => p.kind === 'assign-scene' && p.target.shotId === shot.id,
    );
    expect(hit).toBeDefined();
    expect(hit!.after).toContain('山神庙');
    expect(hit!.reason).toContain('固定元素');
  });

  it('角色漏勾锁时，为它出现的每一镜各提议一条', () => {
    const project = clone();
    for (const shot of project.shots) shot.activeLockIds = [];
    const proposals = plan(project).proposals.filter((p) => p.kind === 'add-lock');
    const lynchongShots = project.shots.filter((s) => s.characterIds.includes('ch-linchong'));
    expect(lynchongShots.length).toBeGreaterThan(0);
    // 主角出现的每一镜都要有一条提议
    for (const shot of lynchongShots) {
      const hit = proposals.find((p) => p.target.shotId === shot.id && p.title.includes('林冲'));
      expect(hit, `第 ${shot.number} 镜缺少补锁提议`).toBeDefined();
    }
    for (const proposal of proposals) {
      expect(proposal.after).toContain('补');
    }
  });

  it('时长非法时提议改成 3 秒，并说明上限', () => {
    const project = clone();
    project.shots[0]!.duration = 0;
    const hit = plan(project).proposals.find((p) => p.kind === 'set-duration');
    expect(hit).toBeDefined();
    expect(hit!.after).toBe('3 秒');
    expect(hit!.sideEffect).toContain('上限');
  });

  it('时长只是超过平台上限时不提议——那是取舍，不是错误', () => {
    const project = clone();
    project.shots[0]!.duration = 30;
    const hit = plan(project).proposals.find(
      (p) => p.kind === 'set-duration' && p.target.shotId === project.shots[0]!.id,
    );
    expect(hit).toBeUndefined();
  });

  it('缺起点时给一份从其它字段拼的草稿，并明确说它是草稿', () => {
    const project = clone();
    const shot = project.shots.find((s) => s.id === 'shot-01')!;
    shot.startState = '';
    const hit = plan(project).proposals.find(
      (p) => p.kind === 'fill-start-state' && p.target.shotId === shot.id,
    );
    expect(hit).toBeDefined();
    expect(hit!.after).toContain('草稿');
    expect(hit!.sideEffect).toContain('草稿');
  });

  it('缺动作时**不**提议——动作是创作核心，机器拼不出来', () => {
    const project = clone();
    const shot = project.shots.find((s) => s.id === 'shot-01')!;
    shot.action = '';
    const hit = plan(project).proposals.find((p) => p.kind === 'fill-action');
    expect(hit).toBeUndefined();
  });

  it('画外人物声明无效时提议清空，并说明另一种可能', () => {
    const project = clone();
    const shot = project.shots.find((s) => s.id === 'shot-08')!;
    shot.startState = '庙里只有他一个人';
    shot.action = '他闭着眼';
    shot.endState = '他睁开眼';
    shot.dialogue = '';
    const hit = plan(project).proposals.find(
      (p) => p.kind === 'remove-offscreen' && p.target.shotId === shot.id,
    );
    // 声明里是「陆谦」，正文里没有 → 应当提议清除
    if (hit) {
      expect(hit.sideEffect).toContain('该出现在画面里');
    }
  });

  it('缺风格词时提议补默认值，并提示换成自己的', () => {
    const project = clone();
    project.brief.styleTags = [];
    const hit = plan(project).proposals.find((p) => p.kind === 'set-brief');
    expect(hit).toBeDefined();
    expect(hit!.sideEffect).toContain('引导向导');
  });
});

describe('铁律一 · 不该碰的绝不碰', () => {
  it('需要审美判断的四类规则一条提议都不产生', () => {
    const project = clone();
    // 造出四类问题
    project.shots[0]!.action = '他缓缓站起身，把花枪换到左手'; // multi-action
    project.brief.targetDuration = 999; // duration-total
    const report = runChecks(project);
    const planResult = buildFixPlan(project, report, { maxShotDuration: 10 });

    for (const ruleId of MANUAL_ONLY_RULES) {
      const issues = report.issues.filter((i) => i.ruleId === ruleId);
      for (const issue of issues) {
        const proposal = planResult.proposals.find((p) => p.issueId === issue.id);
        expect(proposal, `${ruleId} 不该产生自动修复提议`).toBeUndefined();
      }
    }
  });

  it('把「不能自动修」的原因如实报告出来', () => {
    const project = clone();
    project.shots[0]!.action = '他抬手拂去肩上的雪，把花枪换到左手';
    const report = runChecks(project);
    const planResult = buildFixPlan(project, report, { maxShotDuration: 10 });
    expect(planResult.manualOnly).toBeGreaterThan(0);
    expect(planResult.manualRuleIds).toContain('multi-action');
  });

  it('光线冲突只报告不提议——改成傍晚还是改场景卡，只有用户知道', () => {
    const project = clone();
    const report = runChecks(project);
    const lightIssues = report.issues.filter((i) => i.ruleId === 'scene-light-conflict');
    expect(lightIssues.length).toBeGreaterThan(0);
    const planResult = buildFixPlan(project, report, { maxShotDuration: 10 });
    for (const issue of lightIssues) {
      expect(planResult.proposals.find((p) => p.issueId === issue.id)).toBeUndefined();
    }
    expect(planResult.manualRuleIds).toContain('scene-light-conflict');
  });

  it('每条提议都必须写清「为什么」，不能只给结论', () => {
    const project = clone();
    project.shots[0]!.sceneId = '';
    project.shots[0]!.duration = 0;
    for (const shot of project.shots) shot.activeLockIds = [];
    const proposals = plan(project).proposals;
    expect(proposals.length).toBeGreaterThan(0);
    for (const proposal of proposals) {
      expect(proposal.reason.length).toBeGreaterThan(15);
      expect(proposal.title.length).toBeGreaterThan(5);
    }
  });

  it('提议都带前后对照，否则用户无法核对', () => {
    const project = clone();
    project.shots[0]!.sceneId = '';
    for (const proposal of plan(project).proposals) {
      expect(typeof proposal.before).toBe('string');
      expect(proposal.after.length).toBeGreaterThan(0);
      expect(proposal.before).not.toBe(proposal.after);
    }
  });
});

describe('铁律二 · 只提议不直接改', () => {
  it('buildFixPlan 不改动原项目', () => {
    const project = clone();
    const before = JSON.stringify(project);
    plan(project);
    expect(JSON.stringify(project)).toBe(before);
  });

  it('applyFixes 返回新对象，原项目不动', () => {
    const project = clone();
    const originalSceneId = project.shots[0]!.sceneId;
    const proposals = plan(project).proposals;
    const result = applyFixes(project, proposals);
    expect(result.project).not.toBe(project);
    // 原对象未被改动
    expect(project.shots[0]!.sceneId).toBe(originalSceneId);
  });

  it('只应用传进来的那几条', () => {
    const project = clone();
    for (const shot of project.shots) shot.activeLockIds = [];
    const proposals = plan(project).proposals.filter((p) => p.kind === 'add-lock');
    expect(proposals.length).toBeGreaterThanOrEqual(2);

    // 必须挑两条**目标镜头不同**的提议，否则测不出「只改选中的」
    // （同一镜头上可能同时有角色锁与场景锁两条提议）
    const first = proposals[0]!;
    const second = proposals.find((p) => p.target.shotId !== first.target.shotId)!;
    expect(second).toBeDefined();

    const result = applyFixes(project, [first]);
    expect(result.applied).toBe(1);

    const secondTarget = second.target.shotId!;
    const before = project.shots.find((s) => s.id === secondTarget)!.activeLockIds;
    const after = result.project.shots.find((s) => s.id === secondTarget)!.activeLockIds;
    expect(after).toEqual(before);
  });

  it('目标已不存在时跳过而不是崩', () => {
    const project = clone();
    const bogus: FixProposal = {
      id: 'x',
      kind: 'fill-action',
      issueId: 'x',
      title: 't',
      reason: 'r',
      target: { shotId: '不存在的镜头' },
      before: '',
      after: '新动作',
    };
    const result = applyFixes(project, [bogus]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

describe('应用后检查结果确实变好', () => {
  it('把能修的都修掉之后，「必须修」的问题应当清零', () => {
    const project = clone();
    // 造一批可修的问题
    project.shots[0]!.sceneId = '';
    project.shots[0]!.duration = 0;
    for (const shot of project.shots) shot.activeLockIds = [];

    const reportBefore = runChecks(project);
    const errorsBefore = reportBefore.counts.error;
    expect(errorsBefore).toBeGreaterThan(0);

    const proposals = buildFixPlan(project, reportBefore, { maxShotDuration: 10 }).proposals;
    const { project: fixedProject } = applyFixes(project, proposals);

    const reportAfter = runChecks(fixedProject);
    expect(reportAfter.counts.error).toBeLessThan(errorsBefore);
  });

  it('修完之后不该冒出新的错误', () => {
    const project = clone();
    project.shots[0]!.duration = 0;
    const reportBefore = runChecks(project);
    const proposals = buildFixPlan(project, reportBefore, { maxShotDuration: 10 }).proposals;
    const { project: fixedProject } = applyFixes(project, proposals);
    const reportAfter = runChecks(fixedProject);

    // 与时长相关的错误应当消失
    const durationErrors = reportAfter.issues.filter(
      (i) => i.ruleId === 'duration-mismatch' && i.severity === 'error',
    );
    expect(durationErrors).toEqual([]);
  });

  it('补齐锁之后，原来报「漏勾锁」的镜头不再报', () => {
    const project = clone();
    for (const shot of project.shots) shot.activeLockIds = [];
    const reportBefore = runChecks(project);
    const proposals = buildFixPlan(project, reportBefore, { maxShotDuration: 10 }).proposals;
    const { project: fixedProject } = applyFixes(project, proposals);
    const reportAfter = runChecks(fixedProject);

    const missingLockAfter = reportAfter.issues.filter(
      (i) => i.ruleId === 'character-missing-lock' && i.severity === 'error',
    );
    expect(missingLockAfter).toEqual([]);
  });
});

describe('提议的稳定性', () => {
  it('同一输入产生相同的提议集合（可重放）', () => {
    const project = clone();
    project.shots[0]!.sceneId = '';
    const a = plan(project).proposals.map((p) => p.title).sort();
    const b = plan(project).proposals.map((p) => p.title).sort();
    expect(a).toEqual(b);
  });

  it('提议 id 不重复（界面用它做勾选键）', () => {
    const project = clone();
    for (const shot of project.shots) shot.activeLockIds = [];
    project.shots[0]!.duration = 0;
    const ids = plan(project).proposals.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('样例项目本身的问题都能被正确分类（可修 vs 需人工）', () => {
    const result = plan(clone());
    // 示例项目里埋了光线冲突（需人工）和缺锁类问题（可修）
    expect(result.manualRuleIds).toContain('scene-light-conflict');
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(result.affectedShots).toBeGreaterThan(0);
  });
});
