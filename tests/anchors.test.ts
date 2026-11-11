import { describe, expect, it } from 'vitest';
import type { SceneAngle, Shot, ShotSize } from '../src/types/model';
import {
  collectAnchors,
  isContinuousWithPrevious,
  sameStyle,
  type RefAsset,
  type ReferenceSource,
  type ReferenceRole,
} from '../src/domain/image/anchors';

/**
 * 锚点收集（P1）
 *
 * ===========================================================================
 * 这组测试盯什么
 * ===========================================================================
 * `collectAnchors()` 是「与模型能力无关」的那一半：同一份项目素材，
 * 无论用 0 槽还是 10 槽模型，算出来的锚点集合必须完全相同。
 * 所以这里**不传任何 capabilities**，只断言：
 *  - 候选顺序（上一镜尾帧 → 本镜首帧 → 角色形象图 → 场景板）；
 *  - 风格不符的旧素材被跳过并上报；
 *  - 反打板缺图时的退回与上报；
 *  - 景别决定全身/头像（缺图退回）；
 *  - 没有 dataUrl 的候选仍留在集合里（交给投递层按「有图才算」处理）。
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

const now = '2026-01-01T00:00:00.000Z';

function asset(
  kind: string,
  overrides: Partial<RefAsset> & { createdAt?: string } = {},
): RefAsset {
  return {
    kind,
    createdAt: overrides.createdAt ?? now,
    dataUrl: `data:image/png;base64,${kind}`,
    ...overrides,
  };
}

interface Fixture {
  sources: ReferenceSource;
  previous: Shot;
  current: Shot;
}

/** 1 个角色（全身 + 头像）+ 上一镜尾帧 + 本镜首帧 + 场景板 */
function slimFixture(options: {
  shotSize?: ShotSize;
  viewAngle?: SceneAngle;
  styleTags?: string[];
} = {}): Fixture {
  const styleTags = options.styleTags ?? ['anime'];
  const sources: ReferenceSource = {
    ownFrames: [asset('first-frame', { styleTags })],
    previousFrames: [asset('end-frame', { styleTags })],
    characterSheets: [
      [
        asset('character-sheet', { styleTags }),
        asset('character-sheet-face', { styleTags }),
      ],
    ],
    scenePlates: [asset('scene-plate', { styleTags })],
  };
  const previous = makeShot({
    id: 'prev',
    number: 1,
    transitionType: 'continuation',
    sceneId: 'scene-a',
    viewAngle: options.viewAngle ?? 'master',
  });
  const current = makeShot({
    id: 'cur',
    number: 2,
    transitionType: 'continuation',
    sceneId: 'scene-a',
    shotSize: options.shotSize ?? 'medium',
    viewAngle: options.viewAngle ?? 'master',
    characterIds: ['char-1'],
  });
  return { sources, previous, current };
}

function roles(anchors: ReturnType<typeof collectAnchors>): ReferenceRole[] {
  return anchors.anchors.map((anchor) => anchor.role);
}

describe('collectAnchors · 候选顺序与能力无关', () => {
  it('**首帧·承接**：上一镜尾帧 → 角色形象图 → 场景板', () => {
    const { sources, previous } = slimFixture();
    const set = collectAnchors({
      kind: 'first-frame',
      previous,
      sources,
      characterNames: ['林冲'],
    });
    expect(roles(set)).toEqual(['previous-end-frame', 'character-sheet', 'scene-plate']);
    expect(set.isContinuous).toBe(true);
    expect(set.anchors[1]!.owner).toBe('林冲');
  });

  it('**首帧·跳切**：不出现上一镜尾帧（连降级都不发生）', () => {
    const { sources } = slimFixture();
    const previous = makeShot({ id: 'prev', number: 1, transitionType: 'cut' });
    const set = collectAnchors({ kind: 'first-frame', previous, sources });
    expect(roles(set)).toEqual(['character-sheet', 'scene-plate']);
    expect(set.isContinuous).toBe(false);
  });

  it('**动作关键帧/尾帧**：本镜首帧 → 角色形象图 → 场景板', () => {
    const { sources, current } = slimFixture();
    const set = collectAnchors({ kind: 'action-peak', previous: current, sources });
    expect(roles(set)).toEqual(['own-first-frame', 'character-sheet', 'scene-plate']);
  });

  it('同一输入两次调用结果深度相等（没有隐藏的能力/全局状态）', () => {
    const { sources, previous } = slimFixture();
    const args = { kind: 'first-frame' as const, previous, sources, characterNames: ['林冲'] };
    expect(collectAnchors(args)).toEqual(collectAnchors(args));
  });

  it('没有 dataUrl 的候选仍保留（投递层按「有图才算」计算槽位）', () => {
    const { sources, previous } = slimFixture();
    const missing: ReferenceSource = { ...sources, previousFrames: [], scenePlates: [] };
    const set = collectAnchors({ kind: 'first-frame', previous, sources: missing });
    expect(roles(set)).toEqual(['previous-end-frame', 'character-sheet', 'scene-plate']);
    expect(set.anchors.every((anchor) => anchor.dataUrl === undefined || anchor.role === 'character-sheet')).toBe(true);
  });
});

describe('collectAnchors · 素材挑选规则', () => {
  it('景别决定全身图/头像：中景优先头像、全景优先全身图', () => {
    const { sources, previous } = slimFixture();
    const medium = collectAnchors({ kind: 'first-frame', previous, sources, shotSize: 'medium' });
    const wide = collectAnchors({ kind: 'first-frame', previous, sources, shotSize: 'wide' });
    expect(medium.anchors.find((a) => a.role === 'character-sheet')!.detail).toBe('face');
    expect(wide.anchors.find((a) => a.role === 'character-sheet')!.detail).toBe('full-body');
  });

  it('缺哪一档就退回另一档：只有头像时全景也用头像', () => {
    const { sources, previous } = slimFixture();
    sources.characterSheets = [[asset('character-sheet-face', { styleTags: sources.ownFrames[0]!.styleTags })]];
    const wide = collectAnchors({ kind: 'first-frame', previous, sources, shotSize: 'wide' });
    expect(wide.anchors.find((a) => a.role === 'character-sheet')!.detail).toBe('face');
  });

  it('**风格不符的旧素材被跳过并记录**（staleSkipped）', () => {
    const { sources, previous } = slimFixture();
    const oldStyle = { styleTags: ['old-style'] };
    sources.characterSheets = [[asset('character-sheet', oldStyle), asset('character-sheet-face', oldStyle)]];
    sources.scenePlates = [asset('scene-plate', oldStyle)];
    const set = collectAnchors({
      kind: 'first-frame',
      previous,
      sources,
      styleTags: ['anime'],
    });
    expect(set.staleSkipped).toEqual(['character-sheet', 'scene-plate']);
    const character = set.anchors.find((a) => a.role === 'character-sheet')!;
    expect(character.dataUrl).toBeUndefined();
  });

  it('反打镜头缺反打板时退回主视角板并标记（只 true 不 false）', () => {
    const { sources } = slimFixture();
    const previous = makeShot({ id: 'prev', number: 1, transitionType: 'continuation' });
    const set = collectAnchors({
      kind: 'first-frame',
      previous,
      sources,
      viewAngle: 'reverse',
    });
    expect(set.scenePlateFellBack).toBe(true);
    expect(set.anchors.find((a) => a.role === 'scene-plate')!.dataUrl).toBe('data:image/png;base64,scene-plate');

    const master = collectAnchors({ kind: 'first-frame', previous, sources, viewAngle: 'master' });
    expect('scenePlateFellBack' in master).toBe(false);
  });
});

describe('anchors.ts 的兼容工具', () => {
  it('isContinuousWithPrevious 的显式字段优先于关键词', () => {
    const previous = makeShot({
      id: 'p',
      number: 1,
      transitionType: 'continuation',
      continuityNote: '第二天，他走了',
    });
    expect(isContinuousWithPrevious(previous).continuous).toBe(true);
    expect(isContinuousWithPrevious(makeShot({ id: 'p', number: 1, transitionType: 'cut' })).continuous).toBe(false);
  });

  it('sameStyle：顺序无关、大小写无关；老素材（无 styleTags）算兼容', () => {
    expect(sameStyle(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameStyle(['Anime Style'], ['anime  style'])).toBe(true);
    expect(sameStyle(undefined, ['anime'])).toBe(true);
    expect(sameStyle(['a'], ['b'])).toBe(false);
  });
});
