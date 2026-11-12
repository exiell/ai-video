import { describe, expect, it } from 'vitest';
import type { ModelCapabilities, Shot } from '../src/types/model';
import {
  collectAnchors,
  type RefAsset,
  type ReferenceSource,
} from '../src/domain/image/anchors';
import { planDelivery, referenceCapabilityOf } from '../src/domain/image/delivery';
import {
  planReferenceImages,
  referenceRolesOf,
} from '../src/domain/image/referencePlan';

/**
 * 主帧投递 MVP（P2-b · C）：只在「能力已知 maxImages===1 + 首帧 + 跳切」时替换。
 */

const styleTags = ['anime'];
const now = '2026-01-01T00:00:00.000Z';

function ref(kind: string, tag = kind): RefAsset {
  return { kind, dataUrl: `data:image/png;base64,${tag}`, createdAt: now, styleTags };
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

const previousContinuous = makeShot({ id: 'prev', number: 1, transitionType: 'continuation' });
const previousCut = makeShot({ id: 'prev', number: 1, transitionType: 'cut' });

function sources(withStaging: boolean): ReferenceSource {
  return {
    ownFrames: [ref('first-frame')],
    previousFrames: [ref('end-frame')],
    characterSheets: [
      [ref('character-sheet', 'full'), ref('character-sheet-face', 'face')],
    ],
    scenePlates: [ref('scene-plate')],
    ...(withStaging ? { stagingFrames: [ref('staging-frame', 'staging')] } : {}),
  };
}

function anchorSet(options: {
  kind?: 'first-frame' | 'action-peak' | 'end-frame';
  cut?: boolean;
  withStaging?: boolean;
}) {
  return collectAnchors({
    kind: options.kind ?? 'first-frame',
    previous: options.cut ? previousCut : previousContinuous,
    sources: sources(options.withStaging ?? false),
    characterNames: ['林冲'],
    styleTags,
  });
}

function legacyCaps(maxImages: number): ModelCapabilities {
  return {
    negativePrompt: true,
    seed: true,
    referenceImage: maxImages > 0,
    maxReferenceImages: maxImages,
    maxOutputImages: 1,
  };
}

function declaredCaps(maxImages: number): ModelCapabilities {
  return {
    ...legacyCaps(maxImages),
    reference: {
      semantics: 'reference',
      maxImages,
      acceptsDataUri: true,
      aspectFollows: 'last',
    },
  };
}

function plan(
  options: Parameters<typeof anchorSet>[0],
  caps: ModelCapabilities,
) {
  return planDelivery(anchorSet(options), referenceCapabilityOf(caps));
}

describe('anchors：主帧来源', () => {
  it('**主帧只进 stagingFrame，不塞进候选 anchors**（不改变旧预算/排序）', () => {
    const plain = anchorSet({ cut: true, withStaging: false });
    const withStaging = anchorSet({ cut: true, withStaging: true });
    expect(withStaging.anchors.map((a) => a.role)).toEqual(plain.anchors.map((a) => a.role));
    expect(withStaging.anchors).toHaveLength(plain.anchors.length);
    expect(withStaging.stagingFrame?.dataUrl).toBe('data:image/png;base64,staging');
    expect(plain.stagingFrame).toBeUndefined();
  });
});

describe('delivery：1 槽 + 跳切首帧优先主帧', () => {
  it('**主帧替代角色图/场景板**：只投 1 张，不报 dropped，identity/space 不缺', () => {
    const delivery = plan({ cut: true, withStaging: true }, legacyCaps(1));
    expect(delivery.staging).toBe('used');
    expect(delivery.slots.map((slot) => slot.role)).toEqual(['staging-frame']);
    expect(delivery.dropped).toEqual([]);
    expect(delivery.degraded).toEqual([]);
    expect(delivery.aspectRatioOwner).toBe('staging-frame');
  });

  it('declared 1 槽同样适用（能力已知 maxImages===1）', () => {
    const delivery = plan({ cut: true, withStaging: true }, declaredCaps(1));
    expect(delivery.staging).toBe('used');
    expect(delivery.slots.map((slot) => slot.role)).toEqual(['staging-frame']);
  });

  it('**没有主帧 → 退回原行为并标记 missing**', () => {
    const delivery = plan({ cut: true, withStaging: false }, legacyCaps(1));
    expect(delivery.staging).toBe('missing');
    expect(delivery.slots.map((slot) => slot.role)).toEqual(['character-sheet']);
    expect(delivery.degraded).toEqual(['space']);
  });

  it('承接镜仍优先上一镜尾帧，主帧不参与', () => {
    const delivery = plan({ cut: false, withStaging: true }, legacyCaps(1));
    expect(delivery.staging).toBeUndefined();
    expect(delivery.slots.map((slot) => slot.role)).toEqual(['previous-end-frame']);
    expect(delivery.degraded).toEqual([]);
  });

  it('动作关键帧/尾帧仍优先本镜首帧，主帧不参与', () => {
    for (const kind of ['action-peak', 'end-frame'] as const) {
      const delivery = plan({ kind, withStaging: true }, legacyCaps(1));
      expect(delivery.staging, kind).toBeUndefined();
      expect(delivery.slots.map((slot) => slot.role), kind).toEqual(['own-first-frame']);
    }
  });

  it('多槽行为不变：3 槽跳切仍用角色图 + 场景板', () => {
    const delivery = plan({ cut: true, withStaging: true }, legacyCaps(3));
    expect(delivery.staging).toBeUndefined();
    expect(delivery.slots.map((slot) => slot.role)).toEqual(['character-sheet', 'scene-plate']);
  });

  it('0 槽不投递：主帧也不发，保持 text-only', () => {
    const delivery = plan({ cut: true, withStaging: true }, legacyCaps(0));
    expect(delivery.mode).toBe('text-only');
    expect(delivery.slots).toEqual([]);
    expect(delivery.staging).toBeUndefined();
  });
});

describe('compat：ReferencePlan 形状不变', () => {
  it('1 槽跳切 + 主帧：planReferenceImages 返回 staging-frame 槽位，但**不加新字段**', () => {
    const set = anchorSet({ cut: true, withStaging: true });
    const context = referenceCapabilityOf(legacyCaps(1));
    const detailed = planDelivery(set, context);
    const anchorSetWithData = set;

    // 通过兼容 wrapper 走一遍
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: legacyCaps(1),
      previous: previousCut,
      sources: sources(true),
      characterNames: ['林冲'],
      styleTags,
    });
    expect(referenceRolesOf(plan)).toEqual(['staging-frame']);
    expect(plan.slots[0]!.label).toContain('场景主帧');
    expect(plan.dropped).toEqual([]);
    expect(plan.aspectRatioOwner).toBe('staging-frame');
    // 旧形状没有 staging 字段（degraded 等由 detailed 入口提供）
    expect('staging' in plan).toBe(false);
    expect(detailed.staging).toBe('used');
    expect(anchorSetWithData.stagingFrame?.covers).toEqual([
      'identity',
      'space',
      'composition',
    ]);
  });
});
