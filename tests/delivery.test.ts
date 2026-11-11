import { describe, expect, it } from 'vitest';
import type {
  AnchorDimension,
  ModelCapabilities,
  ReferenceCapability,
  SceneAngle,
  Shot,
  ShotSize,
} from '../src/types/model';
import {
  collectAnchors,
  type AnchorSet,
  type RefAsset,
  type ReferenceRole,
  type ReferenceSource,
} from '../src/domain/image/anchors';
import { planDelivery, referenceCapabilityOf } from '../src/domain/image/delivery';

/**
 * 投递计划（P1）
 *
 * ===========================================================================
 * 与 anchors.test 的分工
 * ===========================================================================
 * anchors 只回答「理论上需要哪些锚点」；这里回答「按这个模型能投几张、
 * 丢谁、排序后谁定画幅、投完还缺哪一维」。矩阵取 0/1/2/3/10 槽 ×
 * 首帧/动作关键帧 × 承接/跳切 × 中景/全景（对应方案 v2.1 §4.2 的表）。
 *
 * 这里**只测 legacy 与已声明的能力**；unknown 不投递与 declared 来源的测试
 * 在 P2-a 的测试文件里（那里才引入真实档案声明）。
 */

const base: ModelCapabilities = {
  negativePrompt: true,
  seed: true,
  referenceImage: true,
  maxReferenceImages: 3,
  maxOutputImages: 1,
};

function legacyCapabilities(maxImages: number): ModelCapabilities {
  return { ...base, referenceImage: maxImages > 0, maxReferenceImages: maxImages };
}

function declaredCapabilities(reference: ReferenceCapability): ModelCapabilities {
  return {
    ...base,
    referenceImage: reference.semantics !== 'none',
    maxReferenceImages: typeof reference.maxImages === 'number' ? reference.maxImages : 0,
    reference,
  };
}

const EDIT_3: ReferenceCapability = {
  semantics: 'edit',
  maxImages: 3,
  acceptsDataUri: true,
  aspectFollows: 'last',
};

const now = '2026-01-01T00:00:00.000Z';
function asset(kind: string): RefAsset {
  return { kind, createdAt: now, dataUrl: `data:image/png;base64,${kind}`, styleTags: ['anime'] };
}

const styleTags = ['anime'];

interface Fixture {
  sources: ReferenceSource;
  previous: Shot;
  current: Shot;
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
    characterIds: ['char-1'],
    variantIds: [],
    activeLockIds: [],
    offscreenCharacters: [],
    sourceSceneId: '',
    ...overrides,
  };
}

function slimFixture(options: {
  shotSize?: ShotSize;
  viewAngle?: SceneAngle;
} = {}): Fixture {
  const sources: ReferenceSource = {
    ownFrames: [asset('first-frame')],
    previousFrames: [asset('end-frame')],
    characterSheets: [[asset('character-sheet'), asset('character-sheet-face')]],
    scenePlates: [asset('scene-plate')],
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
  });
  return { sources, previous, current };
}

function anchorSetFor(args: {
  kind?: 'first-frame' | 'action-peak' | 'end-frame';
  transition?: 'continuation' | 'cut';
  shotSize?: ShotSize;
} = {}): AnchorSet {
  const fixture = slimFixture({ shotSize: args.shotSize });
  const previous = {
    ...fixture.previous,
    transitionType: args.transition ?? 'continuation',
  };
  return collectAnchors({
    kind: args.kind ?? 'first-frame',
    previous: args.kind && args.kind !== 'first-frame' ? fixture.current : previous,
    sources: fixture.sources,
    characterNames: ['林冲'],
    styleTags,
    ...(args.shotSize ? { shotSize: args.shotSize } : {}),
  });
}

function rolesOf(slots: { role: ReferenceRole }[]): ReferenceRole[] {
  return slots.map((slot) => slot.role);
}

describe('planDelivery · 0/1/2/3/10 槽矩阵', () => {
  it('0 槽（legacy 不支持）：全部锚点进 dropped，全部必需维度降级', () => {
    const delivery = planDelivery(anchorSetFor(), referenceCapabilityOf(legacyCapabilities(0)));
    expect(delivery.mode).toBe('text-only');
    expect(delivery.slots).toEqual([]);
    expect(rolesOf(delivery.dropped)).toEqual([
      'previous-end-frame',
      'character-sheet',
      'scene-plate',
    ]);
    expect(delivery.degraded).toEqual(['continuity', 'identity', 'space']);
    expect(delivery.aspectRatioOwner).toBeUndefined();
  });

  it('1 槽·承接·中景：只剩尾帧（四合一，不缺维度）', () => {
    const delivery = planDelivery(anchorSetFor(), referenceCapabilityOf(legacyCapabilities(1)));
    expect(rolesOf(delivery.slots)).toEqual(['previous-end-frame']);
    expect(rolesOf(delivery.dropped)).toEqual(['character-sheet', 'scene-plate']);
    expect(delivery.aspectRatioOwner).toBe('previous-end-frame');
    expect(delivery.degraded).toEqual([]);
  });

  it('**1 槽·跳切·中景：保脸丢空间**（P2-a 要显式化/补偿的格子）', () => {
    const delivery = planDelivery(
      anchorSetFor({ transition: 'cut' }),
      referenceCapabilityOf(legacyCapabilities(1)),
    );
    expect(rolesOf(delivery.slots)).toEqual(['character-sheet']);
    expect(rolesOf(delivery.dropped)).toEqual(['scene-plate']);
    expect(delivery.aspectRatioOwner).toBe('character-sheet');
    expect(delivery.degraded).toEqual(['space']);
  });

  it('**1 槽·跳切·全景：保景丢身份**（与现有丢图规则一致）', () => {
    const delivery = planDelivery(
      anchorSetFor({ transition: 'cut', shotSize: 'wide' }),
      referenceCapabilityOf(legacyCapabilities(1)),
    );
    expect(rolesOf(delivery.slots)).toEqual(['scene-plate']);
    expect(rolesOf(delivery.dropped)).toEqual(['character-sheet']);
    expect(delivery.aspectRatioOwner).toBe('scene-plate');
    expect(delivery.degraded).toEqual(['identity']);
  });

  it('2 槽·承接：尾帧 + 形象图，场景板让位', () => {
    const delivery = planDelivery(anchorSetFor(), referenceCapabilityOf(legacyCapabilities(2)));
    expect(rolesOf(delivery.slots)).toEqual(['character-sheet', 'previous-end-frame']);
    expect(rolesOf(delivery.dropped)).toEqual(['scene-plate']);
    expect(delivery.degraded).toEqual([]);
  });

  it('2 槽·跳切：形象图 + 场景板（不缺维度）', () => {
    const delivery = planDelivery(
      anchorSetFor({ transition: 'cut' }),
      referenceCapabilityOf(legacyCapabilities(2)),
    );
    expect(rolesOf(delivery.slots)).toEqual(['character-sheet', 'scene-plate']);
    expect(delivery.dropped).toEqual([]);
    expect(delivery.aspectRatioOwner).toBe('scene-plate');
    expect(delivery.degraded).toEqual([]);
  });

  it('3 槽·承接：三张全投，尾帧最后定画幅', () => {
    const delivery = planDelivery(anchorSetFor(), referenceCapabilityOf(declaredCapabilities(EDIT_3)));
    expect(rolesOf(delivery.slots)).toEqual([
      'character-sheet',
      'scene-plate',
      'previous-end-frame',
    ]);
    expect(delivery.aspectRatioOwner).toBe('previous-end-frame');
    expect(delivery.degraded).toEqual([]);
  });

  it('3 槽·动作关键帧：本镜首帧最后定画幅', () => {
    const delivery = planDelivery(
      anchorSetFor({ kind: 'action-peak' }),
      referenceCapabilityOf(legacyCapabilities(3)),
    );
    expect(rolesOf(delivery.slots)).toEqual(['character-sheet', 'scene-plate', 'own-first-frame']);
    expect(delivery.aspectRatioOwner).toBe('own-first-frame');
    expect(delivery.degraded).toEqual([]);
  });

  it('10 槽：全部候选都投，顺序同 rank', () => {
    const delivery = planDelivery(anchorSetFor(), referenceCapabilityOf(legacyCapabilities(10)));
    expect(rolesOf(delivery.slots)).toEqual([
      'character-sheet',
      'scene-plate',
      'previous-end-frame',
    ]);
    expect(delivery.dropped).toEqual([]);
    expect(delivery.degraded).toEqual([]);
  });

  it('动作关键帧·0 槽：构图维度也降级', () => {
    const delivery = planDelivery(
      anchorSetFor({ kind: 'end-frame' }),
      referenceCapabilityOf(legacyCapabilities(0)),
    );
    expect(delivery.mode).toBe('text-only');
    expect(delivery.degraded).toEqual(['identity', 'space', 'composition']);
  });

  it('「semantics 不同但槽位相同」不改变 slots（语义只影响提示词/模式）', () => {
    const set = anchorSetFor();
    const asEdit = planDelivery(set, referenceCapabilityOf(declaredCapabilities(EDIT_3)));
    const asReference = planDelivery(
      set,
      referenceCapabilityOf(
        declaredCapabilities({
          semantics: 'reference',
          maxImages: 3,
          acceptsDataUri: true,
          aspectFollows: 'unknown',
        }),
      ),
    );
    expect(rolesOf(asEdit.slots)).toEqual(rolesOf(asReference.slots));
    expect(asEdit.degraded).toEqual(asReference.degraded);
  });
});

describe('planDelivery · 与旧 ReferencePlan 的等价不变量', () => {
  it('slots + dropped 覆盖所有有图的候选（不丢也不凭空多）', () => {
    const set = anchorSetFor();
    const present = set.anchors.filter((anchor) => anchor.dataUrl).map((anchor) => anchor.role);
    for (let maxImages = 0; maxImages <= 10; maxImages += 1) {
      const delivery = planDelivery(set, referenceCapabilityOf(legacyCapabilities(maxImages)));
      const result = [...rolesOf(delivery.slots), ...rolesOf(delivery.dropped)].sort();
      expect(result).toEqual([...present].sort());
    }
  });

  it('aspectRatioOwner 就是排序后最后一张的 role（legacy 行为不变）', () => {
    const set = anchorSetFor();
    for (let maxImages = 0; maxImages <= 10; maxImages += 1) {
      const delivery = planDelivery(set, referenceCapabilityOf(legacyCapabilities(maxImages)));
      const last = delivery.slots[delivery.slots.length - 1];
      expect(delivery.aspectRatioOwner).toBe(last?.role);
    }
  });

  it('degraded 等于「必需维度 − 已投递锚点 covers 的并集」', () => {
    const required: Record<'first-frame' | 'action-peak' | 'end-frame', AnchorDimension[]> = {
      'first-frame': ['continuity', 'identity', 'space'],
      'action-peak': ['identity', 'space', 'composition'],
      'end-frame': ['identity', 'space', 'composition'],
    };
    const set = anchorSetFor();
    for (let maxImages = 0; maxImages <= 10; maxImages += 1) {
      const delivery = planDelivery(set, referenceCapabilityOf(legacyCapabilities(maxImages)));
      const covered = new Set(delivery.slots.flatMap((slot) => slot.covers));
      const expected = required['first-frame'].filter((dim) => !covered.has(dim));
      expect(delivery.degraded).toEqual(expected);
    }
  });
});
