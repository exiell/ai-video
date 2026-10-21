import { describe, expect, it } from 'vitest';
import { planReferenceImages, type ReferenceSlot } from '../src/domain/image/referencePlan';
import { withReferenceInstruction } from '../src/services/gateway/dashscope';
import { buildFramePrompt, subjectHeightShare } from '../src/domain/image/prompts';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { ModelCapabilities, ShotSize } from '../src/types/model';

/**
 * 人物尺度与形象残缺（v0.46）
 *
 * ===========================================================================
 * 这组测试盯的是一个具体机制，不是一句口号
 * ===========================================================================
 * 用户反馈两个症状：**人物大小不合理**、**人物形象残缺**。
 *
 * 读代码找到的机制是这样的：
 *  1. 角色参考图永远优先挑**头部特写**，而头部特写里根本没有身体 →
 *     模型手上的身体信息只有文字，身高体型只能猜
 *  2. 两个角色同框时，两张参考图在提示词里是**同一句话** → 模型分不清谁是谁
 *  3. 参考图是头像时，提示词却要求「保持体型比例」→ 要求模型保持它看不见的东西
 *  4. 尺度锚点写的是「相对大小不随镜头改变（as in other shots）」，
 *     而这次生成里模型看不到别的镜头 → 这句话没有指代对象，等于没说
 *
 * 四条现在都有对应的断言。这类测试的价值不在「跑通」，
 * 而在于**如果有人把规则改回去，哪一条会响**。
 */

const CAPS: ModelCapabilities = {
  negativePrompt: true,
  seed: true,
  referenceImage: true,
  maxReferenceImages: 3,
  maxOutputImages: 1,
};

function asset(kind: string, createdAt: string, tag = kind) {
  return { kind, createdAt, dataUrl: `data:image/png;base64,${tag}` };
}

const BOTH_SHEETS = [
  asset('character-sheet', '2026-01-01T00:00:00Z', 'full'),
  asset('character-sheet-face', '2026-01-01T00:00:00Z', 'face'),
];

function plan(shotSize: ShotSize, sheets = [BOTH_SHEETS], names = ['林冲']) {
  return planReferenceImages({
    kind: 'first-frame',
    capabilities: CAPS,
    previous: undefined,
    shotSize,
    characterNames: names,
    sources: {
      ownFrames: [],
      characterSheets: sheets,
      scenePlates: [asset('scene-plate', '2026-01-01T00:00:00Z')],
    },
  });
}

/** 从计划里取出角色那张槽位 */
function charSlot(slots: ReferenceSlot[]): ReferenceSlot | undefined {
  return slots.find((s) => s.role === 'character-sheet');
}

describe('① 按景别选角色参考图', () => {
  it('全景用全身多视图——这一档读的就是体型', () => {
    for (const size of ['full', 'wide', 'extreme-wide'] as ShotSize[]) {
      const slot = charSlot(plan(size).slots);
      expect(slot?.detail, `${size} 应该用全身图`).toBe('full-body');
      expect(slot?.dataUrl).toContain('full');
    }
  });

  it('近景用头部特写——这一档读的是脸', () => {
    for (const size of ['close-up', 'extreme-close-up'] as ShotSize[]) {
      const slot = charSlot(plan(size).slots);
      expect(slot?.detail, `${size} 应该用头像`).toBe('face');
      expect(slot?.dataUrl).toContain('face');
    }
  });

  it('中景用头像：身体已被画幅裁掉大半，认人靠脸', () => {
    expect(charSlot(plan('medium').slots)?.detail).toBe('face');
  });

  it('首选那一档缺图时退回另一档，而不是干脆不给参考图', () => {
    const onlyFace = [asset('character-sheet-face', '2026-01-01T00:00:00Z')];
    const wide = charSlot(plan('wide', [onlyFace]).slots);
    expect(wide?.detail).toBe('face');
    expect(wide?.dataUrl).toBeDefined();

    const onlyFull = [asset('character-sheet', '2026-01-01T00:00:00Z')];
    const close = charSlot(plan('close-up', [onlyFull]).slots);
    expect(close?.detail).toBe('full-body');
    expect(close?.dataUrl).toBeDefined();
  });

  it('不传景别时保持改动前的行为（优先头像），不给老调用方换图', () => {
    const result = planReferenceImages({
      kind: 'first-frame',
      capabilities: CAPS,
      previous: undefined,
      sources: { ownFrames: [], characterSheets: [BOTH_SHEETS] },
    });
    expect(charSlot(result.slots)?.detail).toBe('face');
  });
});

describe('② 参考图带上角色名', () => {
  it('槽位记住了这张形象图是谁的', () => {
    const result = planReferenceImages({
      kind: 'first-frame',
      capabilities: { ...CAPS, maxReferenceImages: 3 },
      previous: undefined,
      shotSize: 'full',
      characterNames: ['林冲', '陆谦'],
      sources: {
        ownFrames: [],
        characterSheets: [BOTH_SHEETS, BOTH_SHEETS],
        scenePlates: [],
      },
    });
    const owners = result.slots.filter((s) => s.role === 'character-sheet').map((s) => s.owner);
    expect(owners).toEqual(['林冲', '陆谦']);
    // 界面上要能看出这是谁的哪张图，否则用户看不出参考图选得对不对
    expect(result.slots.find((s) => s.role === 'character-sheet')?.label).toContain('林冲');
  });

  it('两张角色参考图不再共用同一句话', () => {
    const a = withReferenceInstruction('x', {
      referenceCount: 2,
      hasFirstFrameAnchor: false,
      roles: ["林冲's sheet", "陆谦's sheet"],
    });
    expect(a).not.toContain("Image 2 is 林冲's sheet. Image 3 is 林冲's sheet.");
  });
});

describe('③ 明说「设定稿是多格拼图」与「这是不同的人」', () => {
  it('两个角色同框时提醒「他们是不同的人，别混成一个」', () => {
    const prompt = withReferenceInstruction('x', {
      referenceCount: 2,
      hasFirstFrameAnchor: false,
      characterCount: 2,
    });
    expect(prompt).toContain('different people');
    expect(prompt).toContain('never blend them into one person');
  });

  it('只有一个角色时不说这句（说多了是噪音）', () => {
    const prompt = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: false,
      characterCount: 1,
    });
    expect(prompt).not.toContain('different people');
  });
});

describe('④ 锁脸那句话要跟着参考图实际是什么走', () => {
  it('只有头像时，不再要求保持看不见的体型比例', () => {
    const prompt = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: false,
      sheetDetails: ['face'],
    });
    expect(prompt).not.toContain('body proportions');
    expect(prompt).toContain('shows the head only');
    // 身高体型要有别的来源，否则模型只能猜
    expect(prompt).toContain('fixed objects described in this scene');
  });

  it('有全身图时照常要求保持体型比例（这张看得见）', () => {
    const prompt = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: false,
      sheetDetails: ['full-body'],
    });
    expect(prompt).toContain('body proportions');
    expect(prompt).toContain('turnaround reference');
  });

  it('画面里一个角色都没有时，一个字都不提人物（否则模型会硬塞一个人进去）', () => {
    const prompt = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: false,
      sheetDetails: [],
    });
    expect(prompt).not.toContain('facial features');
    expect(prompt).not.toContain('body proportions');
  });

  it('只给了张数的老调用点仍然走旧行为（兼容）', () => {
    const prompt = withReferenceInstruction('x', 2);
    expect(prompt).toContain('facial features');
  });
});

describe('④ 尺度锚点换成一个模型能照着算的数', () => {
  it('每一档景别都有人物占比，且数值各不相同', () => {
    const sizes: ShotSize[] = [
      'extreme-wide',
      'wide',
      'full',
      'medium',
      'close-up',
      'extreme-close-up',
    ];
    const phrases = sizes.map((s) => subjectHeightShare(s));
    expect(phrases.every((p) => p.length > 0)).toBe(true);
    expect(new Set(phrases).size).toBe(sizes.length);
  });

  it('镜头提示词里出现的是「占画面高度的几成」，不是「和别的镜头一样」', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId)!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    expect(prompt.positive).toContain('of the frame height');
    expect(prompt.positive).not.toContain('as in other shots');
  });

  it('人物占比换景别就换数值——不然等于给了一个错误的固定值', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId)!;
    const wide = buildFramePrompt(project, shot.id, 'first-frame')!;
    project.shots = project.shots.map((s) =>
      s.id === shot.id ? { ...s, shotSize: 'close-up' as const } : s,
    );
    const close = buildFramePrompt(project, shot.id, 'first-frame')!;
    expect(wide.positive).not.toBe(close.positive);
    expect(wide.positive).toContain('one eighth of the frame height');
    expect(close.positive).toContain('from the shoulders up');
  });
});
