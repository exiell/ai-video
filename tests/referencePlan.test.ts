import { describe, expect, it } from 'vitest';
import {
  isContinuousWithPrevious,
  planReferenceImages,
  previousShotOf,
  referenceRolesOf,
  hasCrossShotAnchor,
  describeReferencePlan,
} from '../src/domain/image/referencePlan';
import { withReferenceInstruction } from '../src/services/gateway/dashscope';
import { checkContinuity } from '../src/domain/checks/continuity';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { ModelCapabilities, Project, Shot } from '../src/types/model';

/**
 * 跨镜参考图编排（v0.21 新增）
 *
 * ===========================================================================
 * 这组测试盯的核心是一句话
 * ===========================================================================
 * **上一镜尾帧只在两镜确实连续时才能当锚点。**
 *
 * 跳切时用它，等于把两个不该相连的镜头强行焊在一起——会同时毁掉两边：
 * 本镜的构图被拉向上一镜，上一镜的空间被搬进一个全新场景。
 * 所以判据必须保守：读不准就不用。不用只是少一道保险，用错是主动引入错误。
 */

const CAPS: ModelCapabilities = {
  negativePrompt: true,
  seed: true,
  referenceImage: true,
  maxReferenceImages: 3,
  maxOutputImages: 1,
};

function shot(overrides: Partial<Shot> & { id: string; number: number }): Shot {
  return {
    duration: 3,
    shotSize: 'medium',
    cameraPosition: '',
    cameraMove: 'static',
    startState: 'x',
    action: 'y',
    endState: 'z',
    dialogue: '',
    sound: '',
    mood: '',
    transition: '硬切',
    sceneId: 'sc-a',
    characterIds: [],
    activeLockIds: [],
    variantIds: [],
    offscreenCharacters: [],
    sourceSceneId: '',
    ...overrides,
  };
}

function asset(kind: string, createdAt: string, tag = kind) {
  return { kind, createdAt, dataUrl: `data:image/png;base64,${tag}` };
}

describe('连续性判定 · 读不准就不用', () => {
  it('第一镜没有上一镜 → 不连续', () => {
    const result = isContinuousWithPrevious(undefined);
    expect(result.continuous).toBe(false);
    expect(result.reason).toContain('第一镜');
  });

  it('上一镜没写衔接说明 → 不连续（并说明这是保守选择）', () => {
    const result = isContinuousWithPrevious(shot({ id: 'a', number: 1 }));
    expect(result.continuous).toBe(false);
    expect(result.reason).toContain('用错比不用更糟');
  });

  it('**写了「切到」→ 不连续**（跳切时绝不能拿上一镜尾帧当锚点）', () => {
    for (const note of ['直接切到第二天早上', '画面一转，到了院子里', '与此同时，另一边']) {
      const result = isContinuousWithPrevious(shot({ id: 'a', number: 1, continuityNote: note }));
      expect(result.continuous, `「${note}」应判为不连续`).toBe(false);
    }
  });

  it('**写了「接着/保持」→ 连续**', () => {
    for (const note of ['他保持这个姿势，下一镜从同一机位推进', '紧接着他继续往前走', '同一机位不切']) {
      const result = isContinuousWithPrevious(shot({ id: 'a', number: 1, continuityNote: note }));
      expect(result.continuous, `「${note}」应判为连续`).toBe(true);
    }
  });

  it('既没有连续信号也没有断开信号 → 判不准，按不连续处理', () => {
    const result = isContinuousWithPrevious(
      shot({ id: 'a', number: 1, continuityNote: '他站在原地，雪落在肩上' }),
    );
    expect(result.continuous).toBe(false);
    // 要告诉用户怎么才能用上这个锚点
    expect(result.reason).toContain('接着');
  });

  it('判定依据是可以读的，不是黑盒', () => {
    const result = isContinuousWithPrevious(
      shot({ id: 'a', number: 1, continuityNote: '接着上一镜' }),
    );
    expect(result.reason.length).toBeGreaterThan(10);
    expect(result.reason).toContain('接着');
  });
});

describe('参考图编排 · 首帧', () => {
  const previous = shot({ id: 'p', number: 1, continuityNote: '接着往下' });

  it('连续时，首帧拿上一镜尾帧当锚点', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: CAPS,
      previous,
      sources: {
        ownFrames: [],
        previousFrames: [asset('end-frame', '2026-01-01T00:00:00Z')],
        characterSheets: [],
      },
    });
    expect(hasCrossShotAnchor(plan)).toBe(true);
    expect(plan.slots[0]!.role).toBe('previous-end-frame');
  });

  it('**跳切时，即使上一镜有尾帧也不能用**', () => {
    const cutPrevious = shot({ id: 'p', number: 1, continuityNote: '直接切到第二天早上' });
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: CAPS,
      previous: cutPrevious,
      sources: {
        ownFrames: [],
        previousFrames: [asset('end-frame', '2026-01-01T00:00:00Z')],
        characterSheets: [],
      },
    });
    expect(hasCrossShotAnchor(plan)).toBe(false);
    expect(plan.slots.some((s) => s.role === 'previous-end-frame')).toBe(false);
  });

  it('连续但上一镜还没出尾帧 → 安静地不用，不报错', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: CAPS,
      previous,
      sources: { ownFrames: [], previousFrames: [], characterSheets: [] },
    });
    expect(plan.slots).toEqual([]);
    expect(plan.isContinuous).toBe(true);
  });

  it('上一镜有多张尾帧时用最新的（重生成说明用户对旧的不满意）', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: CAPS,
      previous,
      sources: {
        ownFrames: [],
        previousFrames: [
          asset('end-frame', '2026-01-01T00:00:00Z', 'OLD'),
          asset('end-frame', '2026-06-01T00:00:00Z', 'NEW'),
        ],
        characterSheets: [],
      },
    });
    expect(plan.slots[0]!.dataUrl).toContain('NEW');
  });

  it('首帧不会把自己当参考图（它正是正在生成的这一张）', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: CAPS,
      previous,
      sources: {
        ownFrames: [asset('first-frame', '2026-01-01T00:00:00Z')],
        characterSheets: [],
      },
    });
    expect(plan.slots.some((s) => s.role === 'own-first-frame')).toBe(false);
  });
});

describe('参考图编排 · 后两帧', () => {
  it('动作关键帧与本镜首帧：用本镜首帧当构图锚点', () => {
    for (const kind of ['action-peak', 'end-frame'] as const) {
      const plan = planReferenceImages({
        kind,
        capabilities: CAPS,
        previous: shot({ id: 'p', number: 1, continuityNote: '接着' }),
        sources: {
          ownFrames: [asset('first-frame', '2026-01-01T00:00:00Z')],
          previousFrames: [asset('end-frame', '2026-01-01T00:00:00Z')],
          characterSheets: [],
        },
      });
      expect(plan.slots[0]!.role, `${kind} 应当以本镜首帧为首选锚点`).toBe('own-first-frame');
      // 后两帧不该再拿上一镜尾帧——那会与「本镜首帧」这两个锚点打架
      expect(plan.slots.some((s) => s.role === 'previous-end-frame')).toBe(false);
    }
  });

  it('本镜首帧还没出时不报错，安静降级到角色形象图', () => {
    const plan = planReferenceImages({
      kind: 'end-frame',
      capabilities: CAPS,
      previous: undefined,
      sources: {
        ownFrames: [],
        characterSheets: [[asset('character-sheet-face', '2026-01-01T00:00:00Z')]],
      },
    });
    expect(plan.slots[0]!.role).toBe('character-sheet');
  });
});

describe('参考图编排 · 预算取舍', () => {
  const richSources = {
    ownFrames: [asset('first-frame', '2026-01-01T00:00:00Z')],
    characterSheets: [
      [asset('character-sheet-face', '2026-01-01T00:00:00Z'), asset('character-sheet', '2026-01-01T00:00:00Z')],
    ],
    scenePlates: [asset('scene-plate', '2026-01-01T00:00:00Z')],
  };

  it('三个槽位都用上：本镜首帧 + 头特 + 场景板', () => {
    const plan = planReferenceImages({
      kind: 'end-frame',
      capabilities: CAPS,
      previous: undefined,
      sources: richSources,
    });
    expect(plan.slots).toHaveLength(3);
    expect(new Set(referenceRolesOf(plan))).toEqual(
      new Set(['own-first-frame', 'character-sheet', 'scene-plate']),
    );
  });

  it('**最后一张决定输出画幅**——出后两帧时由本镜首帧定画幅', () => {
    // 千问多图编辑的硬约束：输出宽高比随最后一张参考图。
    // 所以本镜的取景必须由本镜首帧说了算，三帧才是同一个镜头。
    const plan = planReferenceImages({
      kind: 'end-frame',
      capabilities: CAPS,
      previous: undefined,
      sources: richSources,
    });
    expect(plan.aspectRatioOwner).toBe('own-first-frame');
    expect(referenceRolesOf(plan).at(-1)).toBe('own-first-frame');
  });

  it('出首帧且没有上一镜锚点时，由场景板定画幅', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: CAPS,
      previous: undefined,
      sources: { ...richSources, ownFrames: [] },
    });
    expect(plan.aspectRatioOwner).toBe('scene-plate');
  });

  it('**角色形象图永远不当画幅决定者**', () => {
    // 设定稿常是方形或竖构图，让它定画幅会把整部片子带偏
    for (const kind of ['first-frame', 'action-peak', 'end-frame'] as const) {
      const plan = planReferenceImages({
        kind,
        capabilities: CAPS,
        previous: undefined,
        sources: {
          ownFrames: kind === 'first-frame' ? [] : richSources.ownFrames,
          characterSheets: richSources.characterSheets,
          scenePlates: richSources.scenePlates,
        },
      });
      expect(plan.aspectRatioOwner, `${kind} 不该由角色形象图定画幅`).not.toBe('character-sheet');
    }
  });

  it('角色头部特写优先于全身图——脸只能靠图锁', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: CAPS,
      previous: undefined,
      sources: {
        ownFrames: [],
        characterSheets: [
          [asset('character-sheet', '2026-01-01T00:00:00Z', 'FULL'), asset('character-sheet-face', '2026-01-01T00:00:00Z', 'FACE')],
        ],
      },
    });
    expect(plan.slots[0]!.dataUrl).toContain('FACE');
  });

  it('槽位不够时**如实报告丢掉了什么**，不静默丢弃', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: { ...CAPS, maxReferenceImages: 1 },
      previous: shot({ id: 'p', number: 1, continuityNote: '接着' }),
      sources: {
        ownFrames: [],
        previousFrames: [asset('end-frame', '2026-01-01T00:00:00Z')],
        characterSheets: [[asset('character-sheet-face', '2026-01-01T00:00:00Z')]],
        scenePlates: [asset('scene-plate', '2026-01-01T00:00:00Z')],
      },
    });
    expect(plan.slots).toHaveLength(1);
    expect(plan.slots[0]!.role).toBe('previous-end-frame');
    expect(plan.dropped.length).toBeGreaterThan(0);
  });

  it('**承接镜由上一镜尾帧定画幅**——它排在最后，同时锁空间、光线与取景', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: CAPS,
      previous: shot({ id: 'p', number: 1, continuityNote: '接着' }),
      sources: {
        ownFrames: [],
        previousFrames: [asset('end-frame', '2026-01-01T00:00:00Z')],
        characterSheets: [[asset('character-sheet-face', '2026-01-01T00:00:00Z')]],
      },
    });
    expect(plan.aspectRatioOwner).toBe('previous-end-frame');
    expect(referenceRolesOf(plan).at(-1)).toBe('previous-end-frame');
    // 角色形象图排在前面，但仍然在集合里
    expect(referenceRolesOf(plan)).toContain('character-sheet');
  });

  it('模型不支持参考图时返回空，不崩', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: { ...CAPS, referenceImage: false, maxReferenceImages: 0 },
      previous: shot({ id: 'p', number: 1, continuityNote: '接着' }),
      sources: {
        ownFrames: [],
        previousFrames: [asset('end-frame', 'x')],
        characterSheets: [],
      },
    });
    expect(plan.slots).toEqual([]);
  });

  it('没有任何素材时返回空计划', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: CAPS,
      previous: undefined,
      sources: { ownFrames: [], characterSheets: [] },
    });
    expect(plan.slots).toEqual([]);
    expect(describeReferencePlan(plan)).toContain('无参考图');
  });
});

describe('参考图说明 · 逐张写明职责', () => {
  it('**按顺序逐张说明每张图管什么**，模型不用猜', () => {
    const prompt = withReferenceInstruction('a puppy eating a burger', {
      referenceCount: 2,
      hasFirstFrameAnchor: false,
      hasPreviousEndAnchor: true,
      roles: [
        'the last frame of the immediately preceding shot',
        'the character design sheet',
      ],
    });
    expect(prompt).toContain('Image 1 is the last frame of the immediately preceding shot');
    expect(prompt).toContain('Image 2 is the character design sheet');
  });

  it('跨镜连续与同镜构图是两句不同的说明（不能混成一句）', () => {
    const crossShot = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: false,
      hasPreviousEndAnchor: true,
    });
    expect(crossShot).toContain('Continue the action from that exact point');
    expect(crossShot).not.toContain('first frame of this very shot');

    const sameShot = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: true,
      hasPreviousEndAnchor: false,
    });
    expect(sameShot).toContain('first frame of this very shot');
    expect(sameShot).not.toContain('Continue the action from that exact point');
  });

  it('两者可以同时出现（既接上一镜、又有本镜首帧锚点）', () => {
    const prompt = withReferenceInstruction('x', {
      referenceCount: 2,
      hasFirstFrameAnchor: true,
      hasPreviousEndAnchor: true,
    });
    expect(prompt).toContain('Continue the action from that exact point');
    expect(prompt).toContain('first frame of this very shot');
  });

  it('**承接镜要分清「保空间」与「可取景」**——不能只写保持', () => {
    // 只写「保持同一空间」的话，需要一个中景接在广角之后时，
    // 模型要么死死沿用上一镜的取景，要么连空间一起改掉
    const prompt = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: false,
      hasPreviousEndAnchor: true,
      shotSizeEn: 'medium',
    });
    // 保什么
    expect(prompt).toContain('same objects in the same places at the same relative sizes');
    expect(prompt).toContain('same direction and colour temperature of light');
    // 可以改什么，而且用肯定句明说本镜的取景
    expect(prompt).toContain('medium framing');
    expect(prompt).toContain('without moving the location');
  });

  it('不写景别时不说「medium framing」，但保空间那句仍在', () => {
    const prompt = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: false,
      hasPreviousEndAnchor: true,
    });
    expect(prompt).not.toContain('medium framing');
    expect(prompt).toContain('same objects in the same places');
  });

  it('没有角色的镜头仍然有锁外观那句（无害，且保持行为一致）', () => {
    const prompt = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: true,
    });
    expect(prompt).toContain('facial features');
  });
});

describe('工具函数', () => {
  it('previousShotOf 取上一镜，第一镜返回 undefined', () => {
    const project: Project = structuredClone(sampleProject);
    expect(previousShotOf(project, project.shots[0]!.id)).toBeUndefined();
    expect(previousShotOf(project, project.shots[1]!.id)?.number).toBe(1);
  });

  it('describeReferencePlan 能读', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: CAPS,
      previous: shot({ id: 'p', number: 1, continuityNote: '接着' }),
      sources: {
        ownFrames: [],
        previousFrames: [asset('end-frame', 'x')],
        characterSheets: [[asset('character-sheet-face', 'x')]],
      },
    });
    const text = describeReferencePlan(plan);
    expect(text).toContain('上一镜尾帧');
    expect(text).toContain('角色形象图');
  });
});

// ---------------------------------------------------------------------------
// 显式 transitionType 优先于关键词推断
// ---------------------------------------------------------------------------

describe('显式转场类型是总开关', () => {
  it('**标为 cut 时，即使衔接说明里写了「接着」也不用尾帧**', () => {
    // 显式字段是用户（或模型建议 + 用户确认）的明确意图，优先级高于文字推断
    const previous = shot({
      id: 'p',
      number: 1,
      transitionType: 'cut',
      continuityNote: '接着往下演',
    });
    const result = isContinuousWithPrevious(previous);
    expect(result.continuous).toBe(false);
    expect(result.reason).toContain('跳切');
  });

  it('标为 continuation 时，即使衔接说明是空的也承接', () => {
    const previous = shot({ id: 'p', number: 1, transitionType: 'continuation', continuityNote: '' });
    const result = isContinuousWithPrevious(previous);
    expect(result.continuous).toBe(true);
    expect(result.reason).toContain('承接');
  });

  it('字段缺失时退回关键词推断（老项目与手写镜头）', () => {
    const inferred = isContinuousWithPrevious(
      shot({ id: 'p', number: 1, continuityNote: '他保持这个姿势不动' }),
    );
    expect(inferred.continuous).toBe(true);
  });

  it('标为 cut 时，尾帧根本不进候选（连降级都不会发生）', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: CAPS,
      previous: shot({ id: 'p', number: 1, transitionType: 'cut' }),
      sources: {
        ownFrames: [],
        previousFrames: [asset('end-frame', 'x')],
        characterSheets: [[asset('character-sheet-face', 'x')]],
        scenePlates: [asset('scene-plate', 'x')],
      },
    });
    expect(plan.slots.some((s) => s.role === 'previous-end-frame')).toBe(false);
    expect(plan.aspectRatioOwner).toBe('scene-plate');
  });
});

// ---------------------------------------------------------------------------
// 承接链过长
// ---------------------------------------------------------------------------

describe('承接链过长时提示重新起锚', () => {
  function chainProject(length: number) {
    const project: Project = structuredClone(sampleProject);
    const base = project.shots[0]!;
    project.shots = Array.from({ length }, (_, i) => ({
      ...structuredClone(base),
      id: `s${i}`,
      number: i + 1,
      // 第一镜一律 cut，其余全部承接
      transitionType: i === 0 ? ('cut' as const) : ('continuation' as const),
    }));
    return project;
  }

  it('连续承接 6 镜时会提示', () => {
    const issues = checkContinuity(chainProject(6)).filter(
      (i) => i.ruleId === 'continuity-long-chain',
    );
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('info');
  });

  it('只承接 5 镜时不提示（不过度打扰）', () => {
    const issues = checkContinuity(chainProject(5)).filter(
      (i) => i.ruleId === 'continuity-long-chain',
    );
    expect(issues).toEqual([]);
  });

  it('链被打断后重新计数，不会重复报', () => {
    const project = chainProject(10);
    // 在第 8 镜处插一次 cut，重新起锚
    project.shots[7]!.transitionType = 'cut';
    const issues = checkContinuity(project).filter(
      (i) => i.ruleId === 'continuity-long-chain',
    );
    // 6~7 触发一次；8 是 cut 重新开始；9、10 只有 3 镜，不触发
    expect(issues.length).toBe(1);
  });

  it('建议里说的是「重新起锚」而不是「你错了」', () => {
    const issues = checkContinuity(chainProject(6)).filter(
      (i) => i.ruleId === 'continuity-long-chain',
    );
    expect(issues[0]!.suggestion).toContain('重新起锚');
    expect(issues[0]!.why).toContain('累积');
  });
});
