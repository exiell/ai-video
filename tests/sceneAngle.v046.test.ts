// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useImage } from '../src/store/image';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { sampleProject } from '../src/data/samples/sampleProject';
import { getDb, saveAssets } from '../src/services/storage';
import { withReferenceInstruction } from '../src/services/gateway/dashscope';
import {
  SCENE_REVERSE_INSTRUCTION,
  buildScenePlatePrompt,
} from '../src/domain/image/prompts';
import { planReferenceImages, type RefAsset } from '../src/domain/image/referencePlan';
import { toAssets } from '../src/services/image/generate';
import { SCENE_ANGLE_LABEL } from '../src/types/model';
import type { ImageRequest, Project } from '../src/types/model';

/**
 * 反打视角（v0.46）
 *
 * ===========================================================================
 * 要解决的到底是什么
 * ===========================================================================
 * 一个场景只出一张图时，镜头一旦转到反方向就无图可用。模型拿主视角那张当参考，
 * 于是要么把主视角的构图焊在这一镜上（「角色在动，画面钉在原地」），
 * 要么把房间重新发明一遍（门窗跑到另一侧去）。
 *
 * 做法：**从主视角板派生一张反打板**，而不是凭空再画一间屋子。
 *
 * 这里守三条不变量：
 *  1. 空间结构与主光方向**不随视角改写**——它们写的是房间自己的方位。
 *  2. 反打板生成时**必须**带主视角板当参考图；没有就报错，不悄悄改成文生图。
 *  3. 反打镜头找不到反打板时**退回主视角板并说出来**，不静默降级。
 */

const REVERSE = 'reverse' as const;
const TEMPLE = 'sc-temple';

/** 场景板提示词里「房间坐标」那两句，必须逐字相同 */
function roomFacts(positive: string): { layout: string | undefined; light: string | undefined } {
  return {
    layout: positive.split(', ').find((p) => p.startsWith('room layout: ')),
    light: positive.split(', ').find((p) => p.startsWith('key light: ')),
  };
}

describe('反打板提示词', () => {
  it('主视角板里没有方向说明，反打板里有', () => {
    const master = buildScenePlatePrompt(sampleProject, TEMPLE, 'master');
    const reverse = buildScenePlatePrompt(sampleProject, TEMPLE, REVERSE);
    expect(master?.positive).not.toContain(SCENE_REVERSE_INSTRUCTION);
    expect(reverse?.positive).toContain(SCENE_REVERSE_INSTRUCTION);
  });

  it('不传角度就是主视角（老调用方不会悄悄变成反打）', () => {
    const implicit = buildScenePlatePrompt(sampleProject, TEMPLE);
    const master = buildScenePlatePrompt(sampleProject, TEMPLE, 'master');
    expect(implicit?.positive).toBe(master?.positive);
    expect(implicit?.subjectLabel).toBe(master?.subjectLabel);
  });

  /**
   * 这条是整件事的关键：光与空间必须用房间坐标，
   * 一旦哪一边用画面坐标（「光从画面左侧来」），反打之后必然自相矛盾。
   */
  it('空间结构与主光方向在两种视角下逐字相同', () => {
    const master = buildScenePlatePrompt(sampleProject, TEMPLE, 'master');
    const reverse = buildScenePlatePrompt(sampleProject, TEMPLE, REVERSE);
    expect(roomFacts(master?.positive ?? '').layout).toBeTruthy();
    expect(roomFacts(master?.positive ?? '')).toEqual(roomFacts(reverse?.positive ?? ''));
  });

  it('反打板的说明里有一节讲「反打视角」，主视角没有', () => {
    const master = buildScenePlatePrompt(sampleProject, TEMPLE, 'master');
    const reverse = buildScenePlatePrompt(sampleProject, TEMPLE, REVERSE);
    expect(master?.notes.some((n) => n.label === '反打视角')).toBe(false);
    const note = reverse?.notes.find((n) => n.label === '反打视角');
    expect(note).toBeDefined();
    expect(note?.reason).toContain('不是从零重画');
  });

  it('反打板的标题带「反打视角」，两张板在图库里分得开', () => {
    const master = buildScenePlatePrompt(sampleProject, TEMPLE, 'master');
    const reverse = buildScenePlatePrompt(sampleProject, TEMPLE, REVERSE);
    expect(master?.subjectLabel).not.toContain(SCENE_ANGLE_LABEL.reverse);
    expect(reverse?.subjectLabel).toContain(SCENE_ANGLE_LABEL.reverse);
  });

  it('反打板仍然是「空无一人」的场景板，没有把角色写进去', () => {
    const reverse = buildScenePlatePrompt(sampleProject, TEMPLE, REVERSE);
    expect(reverse?.positive).toContain('empty environment reference plate');
    expect(reverse?.positive).toContain('no people');
  });
});

// ---------------------------------------------------------------------------
// 参考图编排：按朝向挑板
// ---------------------------------------------------------------------------

const caps = {
  negativePrompt: false,
  seed: false,
  referenceImage: true,
  maxReferenceImages: 3,
  maxOutputImages: 1,
};

function plate(id: string, angle?: 'master' | 'reverse', createdAt?: string): RefAsset {
  return {
    kind: 'scene-plate',
    dataUrl: `data:image/png;base64,${id}`,
    createdAt: createdAt ?? '2026-10-21T10:00:00.000Z',
    ...(angle ? { angle } : {}),
  };
}

function plan(plates: RefAsset[], viewAngle?: 'master' | 'reverse') {
  return planReferenceImages({
    kind: 'first-frame',
    capabilities: caps,
    previous: undefined,
    ...(viewAngle ? { viewAngle } : {}),
    sources: { ownFrames: [], characterSheets: [], scenePlates: plates },
  });
}

describe('按朝向挑场景板', () => {
  it('主视角镜头拿主视角板，哪怕反打板更新', () => {
    const result = plan(
      [plate('master', undefined, '2026-10-01T00:00:00.000Z'), plate('reverse', 'reverse', '2026-10-21T00:00:00.000Z')],
      'master',
    );
    const slot = result.slots.find((s) => s.role === 'scene-plate');
    expect(slot?.dataUrl).toContain('master');
    expect(result.scenePlateFellBack).toBeUndefined();
  });

  it('反打镜头拿反打板，槽位标签写明是反打', () => {
    const result = plan(
      [plate('master'), plate('reverse', 'reverse')],
      'reverse',
    );
    const slot = result.slots.find((s) => s.role === 'scene-plate');
    expect(slot?.dataUrl).toContain('reverse');
    expect(slot?.label).toContain(SCENE_ANGLE_LABEL.reverse);
    expect(result.scenePlateFellBack).toBeUndefined();
  });

  it('只有主视角板时，反打镜头退回主视角板**并上报退回了**', () => {
    const result = plan([plate('master')], 'reverse');
    const slot = result.slots.find((s) => s.role === 'scene-plate');
    expect(slot?.dataUrl).toContain('master');
    // 静默退化正是这一轮反复出现的毛病，所以这里断言它必须被说出来
    expect(result.scenePlateFellBack).toBe(true);
    expect(slot?.label).not.toContain(SCENE_ANGLE_LABEL.reverse);
  });

  it('老素材没有 angle 字段，按主视角算', () => {
    const result = plan([plate('legacy')], 'master');
    expect(result.slots.find((s) => s.role === 'scene-plate')?.dataUrl).toContain('legacy');
  });

  it('反打镜头遇到没有 angle 的老板，也算主视角、照样上报退回', () => {
    const result = plan([plate('legacy')], 'reverse');
    expect(result.scenePlateFellBack).toBe(true);
  });

  it('一张板都没有时不报退回（没东西可退）', () => {
    const result = plan([], 'reverse');
    expect(result.slots.some((s) => s.role === 'scene-plate')).toBe(false);
    expect(result.scenePlateFellBack).toBeUndefined();
  });

  it('风格不一致的反打板不会被当成可用的反打板', () => {
    const stale = plate('reverse-stale', 'reverse');
    const withStyle: RefAsset = { ...stale, styleTags: ['赛璐璐', '暖色'] };
    const result = planReferenceImages({
      kind: 'first-frame',
      capabilities: caps,
      previous: undefined,
      viewAngle: 'reverse',
      styleTags: ['水墨', '冷蓝'],
      sources: { ownFrames: [], characterSheets: [], scenePlates: [withStyle] },
    });
    expect(result.slots.some((s) => s.role === 'scene-plate')).toBe(false);
    expect(result.staleSkipped).toContain('scene-plate');
  });
});

// ---------------------------------------------------------------------------
// store：反打板必须真的拿主视角板当参考图
// ---------------------------------------------------------------------------

const captured: ImageRequest[] = [];

vi.mock('../src/services/image/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/image/generate')>();
  return {
    ...actual,
    generateImages: async (args: { req: ImageRequest }) => {
      captured.push(args.req);
      return { ok: true, images: [], warnings: [] };
    },
  };
});

function effectivePrompt(req: ImageRequest): string {
  if (!req.referenceImages || req.referenceImages.length === 0) return req.prompt;
  return withReferenceInstruction(req.prompt, {
    referenceCount: req.referenceImages.length,
    hasFirstFrameAnchor: req.frameRole?.hasFirstFrameAnchor ?? false,
    hasPreviousEndAnchor: req.frameRole?.hasPreviousEndAnchor ?? false,
    ...(req.frameRole?.roles ? { roles: req.frameRole.roles } : {}),
    ...(req.frameRole ? { frameKind: req.frameRole.kind } : {}),
    ...(req.frameRole?.sheetDetails ? { sheetDetails: req.frameRole.sheetDetails } : {}),
  });
}

const LEGACY_SENTENCE =
  'Keep the facial features, hairstyle and body proportions of the person in the character reference image exactly.';

function dbAsset(id: string, angle?: 'master' | 'reverse') {
  const now = new Date().toISOString();
  return {
    id,
    projectId: sampleProject.id,
    kind: 'scene-plate' as const,
    refId: TEMPLE,
    dataUrl: `data:image/png;base64,${id}`,
    mimeType: 'image/png',
    promptSnapshot: 'x',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
    ...(angle ? { angle } : {}),
  };
}

function allFeedback() {
  return Object.values(useImage.getState().feedback)
    .filter((v): v is NonNullable<typeof v> => Boolean(v));
}

beforeEach(async () => {
  captured.length = 0;
  // fake-indexeddb 在同一文件内不清库：上一个用例存的场景板会留到下一个，
  // 让「没有主视角板就报错」那条莫名其妙地通过。
  await getDb().assets.clear();
  useImage.setState({
    pending: null,
    feedback: {},
    // 空图库 → confirmOverwrite 直接放行，不会调 window.confirm
    gallery: {},
    assetCount: 0,
    assetCounts: {},
    batch: null,
    batchSummary: null,
  });
  useSettings.setState({ keys: { dashscope: 'sk-test' } });
  useAppStore.setState({ project: structuredClone(sampleProject) });
});

describe('出反打板时真的带着主视角板', () => {
  it('反打板拿主视角板当参考图，并且不说「保持那张角色参考图里的人」', async () => {
    await saveAssets([dbAsset('master-plate')]);
    await useImage.getState().generateForScene(TEMPLE, 'reverse');
    const req = captured[captured.length - 1];
    expect(req).toBeDefined();
    expect(req?.referenceImages?.length).toBe(1);
    expect(req?.frameRole?.roles?.[0]).toContain('master view of this room');
    // 场景板不是「第几帧」
    expect(req?.frameRole?.kind).toBeUndefined();
    // 空数组 = 这次没有角色参考图 → 不许再要求保持角色的脸和体型
    expect(req?.frameRole?.sheetDetails).toEqual([]);
    const prompt = effectivePrompt(req!);
    expect(prompt).not.toContain(LEGACY_SENTENCE);
    expect(prompt).toContain('Image 1 is ');
  });

  it('没有主视角板时直接报错，不会偷偷改成文生图', async () => {
    await saveAssets([]);
    await useImage.getState().generateForScene(TEMPLE, 'reverse');
    expect(captured.length).toBe(0);
    const feedback = allFeedback();
    expect(feedback.some((f) => f.kind === 'error')).toBe(true);
    expect(feedback.map((f) => f.message).join(' ')).toContain('还没有主视角参考板');
    // 说清为什么必须先有主视角板
    expect(
      feedback.flatMap((f) => f.warnings).join(' '),
    ).toContain('不是重新画一间屋子');
  });

  it('主视角板仍然是纯文生图，不会平白多传参考图', async () => {
    await saveAssets([dbAsset('master-plate')]);
    await useImage.getState().generateForScene(TEMPLE, 'master');
    const req = captured[captured.length - 1];
    expect(req).toBeDefined();
    expect(req?.referenceImages ?? []).toEqual([]);
  });

  it('不传角度时按主视角出（老调用方行为不变）', async () => {
    await saveAssets([dbAsset('master-plate')]);
    await useImage.getState().generateForScene(TEMPLE);
    const req = captured[captured.length - 1];
    expect(req?.referenceImages ?? []).toEqual([]);
  });
});

describe('角度要跟着素材存下来', () => {
  it('toAssets 把 angle 写进素材，否则下一镜挑不出反打板', () => {
    const built = toAssets(
      {
        ok: true,
        images: [{ dataUrl: 'data:image/png;base64,AAA', url: 'https://x/y.png' }],
        warnings: [],
      } as never,
      {
        projectId: sampleProject.id,
        kind: 'scene-plate',
        refId: TEMPLE,
        promptSnapshot: 'x',
        angle: 'reverse',
      },
    );
    expect(built.assets[0]?.angle).toBe('reverse');
  });

  it('没传 angle 的素材没有这个字段（老数据不需要迁移）', () => {
    const built = toAssets(
      {
        ok: true,
        images: [{ dataUrl: 'data:image/png;base64,AAA', url: 'https://x/y.png' }],
        warnings: [],
      } as never,
      {
        projectId: sampleProject.id,
        kind: 'scene-plate',
        refId: TEMPLE,
        promptSnapshot: 'x',
      },
    );
    expect(built.assets[0]?.angle).toBeUndefined();
  });
});

describe('镜头标了反打但没有反打板', () => {
  it('出图时把退回这件事说出来，而不是静默用主视角板', async () => {
    await saveAssets([dbAsset('master-plate')]);
    const project: Project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId === TEMPLE);
    expect(shot).toBeDefined();
    shot!.viewAngle = 'reverse';
    useAppStore.setState({ project });

    await useImage.getState().generateForFrame(shot!.id, 'first-frame', true);
    const feedback = allFeedback();
    const warnings = feedback.flatMap((f) => f.warnings).join(' ');
    expect(warnings).toContain('还没有反打板');
  });
});
