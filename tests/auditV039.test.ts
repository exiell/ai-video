// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { runChecks } from '../src/domain/checks';
import { strictestLimit, PLATFORM_MAX_DURATION } from '../src/domain/checks/storyboard';
import { findColorWords } from '../src/domain/checks/scenes';
import { findActionFragments } from '../src/domain/checks/shared';
import { buildShotPrompt } from '../src/domain/prompt';
import { buildFramePrompt } from '../src/domain/image/prompts';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Project } from '../src/types/model';

/**
 * 一次代码审查修掉的问题的回归测试（v0.39）
 *
 * 这一组测试的每一节都对应一个**在正常使用下会出错、但界面上看不出来**的问题。
 * 它们比功能测试更重要：功能坏了用户会发现，这些问题不会。
 */

function fresh(): Project {
  return structuredClone(sampleProject);
}

function countRule(report: ReturnType<typeof runChecks>, ruleId: string): number {
  return report.issues.filter((i) => i.ruleId === ruleId).length;
}

// ---------------------------------------------------------------------------
// 重复发报
// ---------------------------------------------------------------------------

describe('检查单不能重复发报（重复会训练用户跳过整份检查单）', () => {
  it('**未分配的变体只报一次**，不按镜头重复', () => {
    /*
      原来这段嵌在 `for (const shot of project.shots)` 里：
      7 个镜头 × 2 个未分配变体 = 14 条一模一样的问题，
      而且文案里写着「如果第 N 镜用得上它」——N 跟这个变体毫无关系。
    */
    const p = fresh();
    p.characters = p.characters.slice(0, 1);
    p.characters[0]!.variants = [
      { id: 'v1', label: '满身落雪', changedFeatures: ['落雪'], shotIds: [] },
      { id: 'v2', label: '受伤', changedFeatures: ['伤口'], shotIds: [] },
    ];
    p.shots.forEach((s) => {
      s.variantIds = [];
    });
    // 保证镜头数 > 1，否则测不出重复
    expect(p.shots.length).toBeGreaterThan(1);

    const hits = runChecks(p).issues.filter(
      (i) => i.ruleId === 'variant-not-owned' && i.title.includes('还没有分配给任何镜头'),
    );
    expect(hits, `报了 ${hits.length} 条，应该只有 2 条（每个变体一条）`).toHaveLength(2);
  });

  it('**项目级缺风格词只报一次**，不按镜头重复', () => {
    // 原来 styleTags / aspectRatio 的判断在逐镜循环里，7 个镜头报 7 条
    const p = fresh();
    p.brief.styleTags = [];
    const hits = runChecks(p).issues.filter(
      (i) => i.ruleId === 'prompt-incomplete' && i.title.includes('风格词'),
    );
    expect(hits).toHaveLength(1);
    // 而且它指向项目，不指向某一镜
    expect(hits[0]!.location.kind).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// 时长上限
// ---------------------------------------------------------------------------

describe('单镜时长上限要取**最严格**的平台', () => {
  it('同时选 Veo(8) 和 Seedance(15) 时，上限是 8 而不是 15', () => {
    // 原来用 Math.max：多选平台反而更容易过检，给出的是错误的安全感
    const r = strictestLimit(['veo', 'seedance']);
    expect(r.limit).toBe(8);
    expect(r.platform).toBe('veo');
  });

  it('单选时就是它自己的上限', () => {
    expect(strictestLimit(['seedance']).limit).toBe(15);
  });

  it('**Sora 是 12 秒**（原来写成 20，那是上一代的数字）', () => {
    expect(PLATFORM_MAX_DURATION.sora).toBe(12);
  });

  it('12 秒的镜头在 Veo 上会被提示', () => {
    const p = fresh();
    p.brief.platforms = ['veo', 'seedance'];
    p.shots.forEach((s) => {
      s.duration = 12;
    });
    const hits = runChecks(p).issues.filter((i) => i.ruleId === 'duration-mismatch');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toContain('Veo');
  });
});

// ---------------------------------------------------------------------------
// 误报
// ---------------------------------------------------------------------------

describe('误报：单字在中文里不是词', () => {
  it('「明白」「白天」不算颜色', () => {
    expect(findColorWords('他明白了')).toEqual([]);
    expect(findColorWords('白天的光')).toEqual([]);
  });

  it('「黑夜」不算颜色', () => {
    expect(findColorWords('黑夜里')).toEqual([]);
  });

  it('真颜色还是认得出来', () => {
    expect(findColorWords('暖橙 + 灰绿')).toContain('灰绿');
    expect(findColorWords('雪白的地面')).toContain('雪白');
    expect(findColorWords('墙上刷成白色')).toContain('白色');
  });

  it('英文按词边界：hundred 里没有 red，bluetooth 里没有 blue', () => {
    expect(findColorWords('one hundred items')).toEqual([]);
    expect(findColorWords('bluetooth speaker')).toEqual([]);
    expect(findColorWords('a red door')).toContain('red');
  });

  it('「走廊」「按照」「抱歉」不算动作', () => {
    // 这几个词里含有 走 / 按 / 抱，子串匹配会把它们当成动作
    expect(findActionFragments('他站在走廊尽头')).toHaveLength(0);
    expect(findActionFragments('按照他的意思办')).toHaveLength(0);
    expect(findActionFragments('我很抱歉')).toHaveLength(0);
  });

  it('真动作还是认得出来', () => {
    expect(findActionFragments('他走进屋里').length).toBeGreaterThan(0);
    expect(findActionFragments('她抬手拂去肩上的雪').length).toBeGreaterThan(0);
  });

  it('**一镜多动作该报的仍然会报**（收紧不等于失效）', () => {
    const fragments = findActionFragments('他推开门走进去，转身拔出长枪');
    expect(fragments.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

describe('视频提示词', () => {
  it('**有机位**（原来只有图片提示词有）', () => {
    const p = fresh();
    const shot = p.shots.find((s) => s.cameraPosition)!;
    const line = buildShotPrompt(p, shot, 'jimeng');
    expect(line.en).toContain('camera angle:');
    expect(line.en).toContain(shot.cameraPosition);
  });

  it('机位也进中文对照（用户要看得懂自己在贴什么）', () => {
    const p = fresh();
    const shot = p.shots.find((s) => s.cameraPosition)!;
    const line = buildShotPrompt(p, shot, 'jimeng');
    expect(line.zh).toContain('【机位】');
  });

  it('labelled 版式把机位放在 Camera 那一行', () => {
    const p = fresh();
    const shot = p.shots.find((s) => s.cameraPosition)!;
    const line = buildShotPrompt(p, shot, 'seedance');
    const cameraLine = line.en.split('\n').find((l) => l.startsWith('Camera:'))!;
    expect(cameraLine).toContain(shot.cameraPosition);
  });

  it('**中文衔接用标签式**，不拼成中英夹生句', () => {
    const p = fresh();
    const shot = p.shots[0]!;
    shot.continuityNote = '他保持这个姿势不动';
    const line = buildShotPrompt(p, shot, 'jimeng');
    expect(line.en).toContain('ending: 他保持这个姿势不动');
    expect(line.en).not.toContain('ending so that');
  });

  it('**英文衔接仍用自然从句**', () => {
    const p = fresh();
    const shot = p.shots[0]!;
    shot.continuityNote = 'he holds the pose';
    const line = buildShotPrompt(p, shot, 'jimeng');
    expect(line.en).toContain('ending so that he holds the pose');
  });
});

describe('图片提示词', () => {
  it('**景别用自然英文**，不注入带连字符的枚举值', () => {
    const p = fresh();
    const shot = p.shots.find((s) => s.shotSize === 'extreme-wide')!;
    const fp = buildFramePrompt(p, shot.id, 'first-frame')!;
    expect(fp.positive).toContain('extreme wide establishing shot');
    expect(fp.positive).not.toContain('extreme-wide');
  });

  it('传给下游的 shotSizeEn 也是自然英文（它会被嵌进英文句子）', () => {
    const p = fresh();
    const shot = p.shots[0]!;
    const fp = buildFramePrompt(p, shot.id, 'first-frame')!;
    expect(fp.shotSizeEn).not.toContain('-');
    expect(fp.shotSizeEn).toMatch(/shot|close-up/);
  });

  it('外观始终注入（锁里没写头饰时，帽子不能凭空消失）', () => {
    const p = fresh();
    const shot = p.shots.find((s) => s.characterIds.length > 0)!;
    const fp = buildFramePrompt(p, shot.id, 'first-frame')!;
    expect(fp.positive).toContain('felt hat');
  });
});

// ---------------------------------------------------------------------------
// 新加的三条规则
// ---------------------------------------------------------------------------

describe('新规则（依据当前主流 AI 视频制作规范）', () => {
  it('**相邻同景别**会提示', () => {
    const p = fresh();
    if (p.shots.length < 2) return;
    p.shots[0]!.shotSize = 'medium';
    p.shots[1]!.shotSize = 'medium';
    const hits = runChecks(p).issues.filter((i) => i.ruleId === 'adjacent-same-shot-size');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.why).toContain('没剪');
  });

  it('景别不同时不报', () => {
    const p = fresh();
    p.shots.forEach((s, i) => {
      // 交替景别
      s.shotSize = i % 2 === 0 ? 'wide' : 'close-up';
    });
    expect(countRule(runChecks(p), 'adjacent-same-shot-size')).toBe(0);
  });

  it('**画面描述里用了代词**会提示，并给出可以替换的名字', () => {
    const p = fresh();
    const shot = p.shots.find((s) => s.characterIds.length > 0)!;
    shot.action = '他猛地回头';
    const hits = runChecks(p).issues.filter(
      (i) => i.ruleId === 'pronoun-in-visual' && i.location.id === shot.id,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.suggestion).toContain('林冲');
  });

  it('**两人同框时代词升级为警告**（这是动作错位最常见的原因）', () => {
    const p = fresh();
    if (p.characters.length < 2) return;
    const shot = p.shots[0]!;
    shot.characterIds = [p.characters[0]!.id, p.characters[1]!.id];
    shot.action = '他看着她';
    const hit = runChecks(p).issues.find(
      (i) => i.ruleId === 'pronoun-in-visual' && i.location.id === shot.id,
    )!;
    expect(hit.severity).toBe('warning');
  });

  it('镜头里没有角色时，用「人影」不报', () => {
    const p = fresh();
    const shot = p.shots[0]!;
    shot.characterIds = [];
    shot.startState = '一个人影从远处走来';
    shot.action = '它停在空地中央';
    shot.endState = '它背对镜头';
    const hits = runChecks(p).issues.filter(
      (i) => i.ruleId === 'pronoun-in-visual' && i.location.id === shot.id,
    );
    expect(hits).toHaveLength(0);
  });

  it('**抽象情绪词**会提示，并给出可以替换的写法', () => {
    const p = fresh();
    const shot = p.shots[0]!;
    shot.mood = '悲伤';
    const hit = runChecks(p).issues.find(
      (i) => i.ruleId === 'abstract-emotion' && i.location.id === shot.id,
    )!;
    expect(hit).toBeTruthy();
    expect(hit.suggestion).toContain('瞳孔');
  });

  it('可以指导构图的词不算抽象（「压迫」保留）', () => {
    // 「紧张」「压迫」虽然抽象，但它们能指导构图，不该报
    const p = fresh();
    const shot = p.shots[0]!;
    shot.mood = '压迫，紧张';
    const hits = runChecks(p).issues.filter(
      (i) => i.ruleId === 'abstract-emotion' && i.location.id === shot.id,
    );
    expect(hits).toHaveLength(0);
  });
});
