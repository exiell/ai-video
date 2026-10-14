import { describe, expect, it } from 'vitest';
import { runChecks } from '../src/domain/checks';
import { findActionFragments } from '../src/domain/checks/shared';
import { checkScenes } from '../src/domain/checks/scenes';
import { checkCharacters } from '../src/domain/checks/characters';
import { checkStoryboard } from '../src/domain/checks/storyboard';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Project } from '../src/types/model';

function clone(): Project {
  return structuredClone(sampleProject);
}

function rulesOf(project: Project): string[] {
  return runChecks(project).issues.map((i) => i.ruleId);
}

describe('内置示例项目', () => {
  it('应当能跑通检查，且抓到埋好的问题', () => {
    const report = runChecks(sampleProject);
    const rules = new Set(report.issues.map((i) => i.ruleId));

    // 埋点 1：shot-10 写成「夜里正午的顶光」——光线冲突
    expect(rules.has('scene-light-conflict')).toBe(true);

    // 埋点 3：陆谦始终只在画外被提到
    expect(rules.has('character-not-registered')).toBe(true);

    // 示例项目本身应当是完整可用的：没有「必须修」级别的字段缺失
    const incomplete = report.issues.filter((i) => i.ruleId === 'shot-incomplete');
    expect(incomplete).toHaveLength(0);
  });

  it('两个场次都有镜头承载，不该报缺失场次', () => {
    const rules = rulesOf(sampleProject);
    expect(rules).not.toContain('story-scene-uncovered');
  });

  it('每条问题都必须给出原因和修改建议', () => {
    const report = runChecks(sampleProject);
    expect(report.issues.length).toBeGreaterThan(0);
    for (const issue of report.issues) {
      expect(issue.title.length).toBeGreaterThan(0);
      expect(issue.why.length).toBeGreaterThan(10);
      expect(issue.suggestion.length).toBeGreaterThan(10);
      // 不允许出现「校验失败」这类没有信息量的文案
      expect(issue.title).not.toContain('校验失败');
      expect(issue.why).not.toContain('校验失败');
    }
  });

  it('统计数量与问题列表一致', () => {
    const report = runChecks(sampleProject);
    const counted = report.issues.filter((i) => i.severity === 'error').length;
    expect(report.counts.error).toBe(counted);
  });
});

describe('规则 · 一镜多动作', () => {
  it('单个动作片段不应报警', () => {
    expect(findActionFragments('他缓缓转头，望向塌掉的草厅方向')).toHaveLength(1);
  });

  it('两个动作片段应当被识别出来', () => {
    const fragments = findActionFragments('他抬手拂去肩上的雪，把花枪换到左手');
    expect(fragments.length).toBeGreaterThan(1);
  });

  it('空动作返回空数组', () => {
    expect(findActionFragments('   ')).toHaveLength(0);
  });
});

describe('规则 · 场景一致性', () => {
  it('镜头没有归属场景时报错', () => {
    const project = clone();
    const shot = project.shots[0]!;
    shot.sceneId = '';
    const issues = checkScenes(project);
    expect(issues.some((i) => i.ruleId === 'scene-not-registered' && i.location.id === shot.id)).toBe(
      true,
    );
  });

  it('镜头指向已删除的场景时报错', () => {
    const project = clone();
    const shot = project.shots[0]!;
    shot.sceneId = 'sc-does-not-exist';
    const issues = checkScenes(project);
    expect(issues.some((i) => i.ruleId === 'scene-not-registered' && i.severity === 'error')).toBe(
      true,
    );
  });

  it('场景缺少固定元素时给出警告', () => {
    const project = clone();
    project.scenes[0]!.fixedElements = [];
    const issues = checkScenes(project);
    expect(issues.some((i) => i.ruleId === 'scene-missing-elements')).toBe(true);
  });

  it('**不再**因为「正文没提标志物」而报警（这是一条被撤掉的规则）', () => {
    // 原来这条规则在正常用法下几乎必然误报：
    //   * 用户用中文写画面描述，固定元素登记的是英文短语 → 字面永远匹配不上
    //   * 更根本的是固定元素**本来就会被自动注入到出图提示词里**，
    //     正文提没提不影响生成结果
    // 一个「必然报警、且报的是系统已自动处理好的事」的规则只会训练用户忽略检查单。
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId)!;
    const scene = project.scenes.find((s) => s.id === shot.sceneId)!;
    expect(scene.fixedElements.length).toBeGreaterThan(0);
    // 把正文写成完全不含固定元素的样子
    shot.startState = '他站在那里';
    shot.action = '他抬起头';
    shot.endState = '他看着前方';
    const issues = runChecks(project).issues.filter((i) => i.ruleId === 'scene-missing-elements');
    // 只剩「场景卡本身没登记固定元素」这一种可能，而示例项目的场景是登记过的
    expect(issues).toEqual([]);
  });

  it('场景卡**本身**没登记固定元素时仍然要报（这条才是有用的）', () => {
    const project = structuredClone(sampleProject);
    project.scenes[0]!.fixedElements = [];
    const issues = runChecks(project).issues.filter((i) => i.ruleId === 'scene-missing-elements');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.title).toContain('没有登记固定元素');
  });

  it('时段冲突被抓到（夜里写成正午）', () => {
    const project = clone();
    const shot = project.shots.find((s) => s.id === 'shot-10')!;
    const issues = checkScenes(project);
    expect(
      issues.some((i) => i.ruleId === 'scene-light-conflict' && i.location.id === shot.id),
    ).toBe(true);
  });

  it('光质冲突被抓到（冷调写成暖光）', () => {
    const project = clone();
    const shot = project.shots.find((s) => s.id === 'shot-07')!;
    shot.startState = '山神庙内，暖光洒满整个房间';
    const issues = checkScenes(project);
    expect(issues.some((i) => i.ruleId === 'scene-light-conflict')).toBe(true);
  });

  it('启用了场景变体时豁免光线冲突（剧情有意为之）', () => {
    const project = clone();
    const shot = project.shots.find((s) => s.id === 'shot-10')!;
    const scene = project.scenes.find((s) => s.id === 'sc-temple')!;
    scene.variants[0]!.changedFeatures = ['光线变为正午顶光'];
    // 把该镜的时段文字改成与场景一致，但保留变体启用
    shot.startState = '夜里，庙门口一片亮';
    shot.variantIds = ['var-temple-dooropen'];
    const issues = checkScenes(project).filter((i) => i.location.id === shot.id);
    expect(issues.some((i) => i.ruleId === 'scene-light-conflict')).toBe(false);
  });

  it('色调漂移给出提示', () => {
    const project = clone();
    // 必须挑一个**没有启用场景变体**的镜头：启用变体意味着「剧情有意改变」，
    // 检查引擎会豁免它。同时这个镜头的原始文本不能自带场景合法色（如暖橙）。
    const shot = project.shots.find(
      (s) => s.sceneId === 'sc-temple' && s.variantIds.length === 0,
    )!;
    expect(shot).toBeDefined();
    shot.startState = '一间屋子里，紫红色的光充满房间，墙面一片暗红';
    const issues = checkScenes(project);
    expect(
      issues.some((i) => i.ruleId === 'scene-color-drift' && i.location.id === shot.id),
    ).toBe(true);
  });
});

describe('规则 · 角色一致性', () => {
  it('镜头出现角色但没声明连续性锁时报错', () => {
    const project = clone();
    const shot = project.shots.find((s) => s.id === 'shot-08')!;
    shot.activeLockIds = [];
    const issues = checkCharacters(project);
    expect(
      issues.some(
        (i) =>
          i.ruleId === 'character-missing-lock' &&
          i.location.id === shot.id &&
          i.severity === 'error',
      ),
    ).toBe(true);
  });

  it('角色没有登记任何连续性锁时给出警告', () => {
    const project = clone();
    const character = project.characters.find((c) => c.id === 'ch-linchong')!;
    character.continuityLocks = [];
    const issues = checkCharacters(project);
    expect(issues.some((i) => i.ruleId === 'character-missing-lock')).toBe(true);
  });

  it('引用不存在的变体时给出警告', () => {
    const project = clone();
    const shot = project.shots[0]!;
    shot.variantIds = ['var-not-real'];
    const issues = checkCharacters(project);
    expect(issues.some((i) => i.ruleId === 'variant-not-owned')).toBe(true);
  });

  it('角色全片未出镜时给出提示', () => {
    // 示例项目里的「陆谦」始终只在画外被提到，没有任何镜头出镜
    const issues = checkCharacters(clone());
    expect(
      issues.some(
        (i) =>
          i.ruleId === 'character-not-registered' &&
          i.severity === 'info' &&
          i.location.id === 'ch-luqian',
      ),
    ).toBe(true);
  });
});

describe('规则 · 分镜与时长', () => {
  it('必填字段为空时报错，并指向具体字段', () => {
    const project = clone();
    const shot = project.shots[0]!;
    shot.action = '';
    const issues = checkStoryboard(project);
    const hit = issues.find((i) => i.ruleId === 'shot-incomplete' && i.location.id === shot.id);
    expect(hit).toBeDefined();
    expect(hit!.location.field).toBe('action');
  });

  it('总时长偏差超过容差时给出警告', () => {
    const project = clone();
    for (const shot of project.shots) shot.duration = 10;
    const issues = checkStoryboard(project);
    const hit = issues.find((i) => i.ruleId === 'duration-total');
    expect(hit).toBeDefined();
    expect(hit!.title).toContain('超');
  });

  it('总时长不足时提示还差多少', () => {
    const project = clone();
    for (const shot of project.shots) shot.duration = 0.5;
    const issues = checkStoryboard(project);
    const hit = issues.find((i) => i.ruleId === 'duration-total');
    expect(hit).toBeDefined();
    expect(hit!.title).toContain('差');
  });

  it('时长在容差内时不报警', () => {
    const project = clone();
    const total = project.shots.reduce((s, x) => s + x.duration, 0);
    project.brief.targetDuration = total;
    const issues = checkStoryboard(project);
    expect(issues.some((i) => i.ruleId === 'duration-total')).toBe(false);
  });

  it('单镜时长非正数时报错', () => {
    const project = clone();
    project.shots[0]!.duration = 0;
    const issues = checkStoryboard(project);
    expect(issues.some((i) => i.ruleId === 'duration-mismatch' && i.severity === 'error')).toBe(true);
  });

  it('单镜时长超过平台上限时给出提示', () => {
    const project = clone();
    project.shots[0]!.duration = 30;
    const issues = checkStoryboard(project);
    expect(issues.some((i) => i.ruleId === 'duration-mismatch' && i.severity === 'info')).toBe(true);
  });

  it('剧本场次没有镜头承载时给出警告', () => {
    const project = clone();
    project.story.scenes.push({ id: 'ss-3', label: '第三场 · 山道', summary: '林冲走在山道上' });
    const issues = checkStoryboard(project);
    expect(issues.some((i) => i.ruleId === 'story-scene-uncovered')).toBe(true);
  });

  it('缺少画幅与风格词时提示提示词不完整', () => {
    const project = clone();
    project.brief.aspectRatio = '';
    project.brief.styleTags = [];
    const issues = checkStoryboard(project);
    expect(issues.some((i) => i.ruleId === 'prompt-incomplete')).toBe(true);
  });

  it('一镜多动作给出警告并建议拆分', () => {
    const project = clone();
    const shot = project.shots.find((s) => s.id === 'shot-03')!;
    shot.action = '他抬手拂去肩上的雪，把花枪换到左手';
    const issues = checkStoryboard(project);
    const hit = issues.find((i) => i.ruleId === 'multi-action' && i.location.id === shot.id);
    expect(hit).toBeDefined();
    expect(hit!.suggestion).toContain('拆');
  });
});
