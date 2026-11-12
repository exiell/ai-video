// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, ImageRequest } from '../src/types/model';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 主帧 store 接线（P2-b · B/C）
 *
 * - 生成/设定主帧接口（generateStagingFrame / promoteStagingFrame）；
 * - 1 槽跳切投递优先主帧；
 * - 无主帧 info、0 槽不投递、旧主帧替换；
 * - 存储字节统计与删除级联。
 *
 * 出图请求用 mock；存储用 fake-indexeddb（真实 Dexie 逻辑）。
 */

const mocks = vi.hoisted(() => ({
  generateImages: vi.fn(),
  prepareReference: vi.fn(),
  captured: [] as ImageRequest[],
}));

vi.mock('../src/services/image/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/image/generate')>();
  return { ...actual, generateImages: mocks.generateImages };
});

vi.mock('../src/services/image/prepare', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/image/prepare')>();
  return { ...actual, prepareReference: mocks.prepareReference };
});

import { useImage } from '../src/store/image';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import {
  assetsByteSize,
  deleteProject,
  listAssets,
  listAssetsFor,
  saveAssets,
} from '../src/services/storage';

const PROJECT = sampleProject;
const SHOT_ID = 'shot-02';
const SCENE_ID = PROJECT.shots[1]!.sceneId;
const CHARACTER_ID = 'ch-linchong';

function asset(
  id: string,
  kind: Asset['kind'],
  refId: string,
  overrides: Partial<Asset> = {},
): Asset {
  const stamp = new Date().toISOString();
  return {
    id,
    projectId: PROJECT.id,
    kind,
    refId,
    dataUrl: `data:image/png;base64,${id}`,
    mimeType: 'image/png',
    promptSnapshot: 'x',
    createdAt: stamp,
    updatedAt: stamp,
    schemaVersion: 1,
    ...overrides,
  };
}

/** 把项目改成「第二镜是跳切首帧，场景里只有林冲」 */
function projectForDelivery(): typeof PROJECT {
  const project = structuredClone(sampleProject);
  for (const shot of project.shots) {
    if (shot.id !== SHOT_ID) shot.sceneId = 'scene-other';
  }
  project.shots[0]!.transitionType = 'cut';
  const second = project.shots[1]!;
  second.characterIds = [CHARACTER_ID];
  second.sceneId = SCENE_ID;
  return project;
}

async function seedAssets(options: { staging?: boolean; plate?: boolean; sheets?: boolean } = {}) {
  const items: Asset[] = [
    asset(`plate-${SCENE_ID}`, 'scene-plate', SCENE_ID, {
      styleTags: [...PROJECT.brief.styleTags],
    }),
    asset('sheet-full', 'character-sheet', CHARACTER_ID, {
      styleTags: [...PROJECT.brief.styleTags],
    }),
    asset('sheet-face', 'character-sheet-face', CHARACTER_ID, {
      styleTags: [...PROJECT.brief.styleTags],
    }),
    asset('first-shot02', 'first-frame', SHOT_ID),
  ];
  if (options.staging !== false) {
    items.push(asset('staging-old', 'staging-frame', SCENE_ID));
  }
  if (options.plate === false) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i]!.kind === 'scene-plate') items.splice(i, 1);
    }
  }
  if (options.sheets === false) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i]!.kind.startsWith('character-sheet')) items.splice(i, 1);
    }
  }
  await saveAssets(items);
}

function resetState(): void {
  useImage.setState({
    pending: null,
    feedback: {},
    gallery: {},
    assetCount: 0,
    assetCounts: {},
    batch: null,
    batchSummary: null,
  });
  mocks.captured.length = 0;
  mocks.generateImages.mockReset();
  mocks.generateImages.mockImplementation(async (args: { req: ImageRequest }) => {
    mocks.captured.push(args.req);
    return {
      ok: true,
      warnings: [],
      images: [{ dataUrl: 'data:image/png;base64,GEN', url: 'https://x/gen.png' }],
    };
  });
  mocks.prepareReference.mockReset();
  mocks.prepareReference.mockImplementation(async (anchor: { dataUrl: string }) => ({
    dataUrl: anchor.dataUrl,
    width: 0,
    height: 0,
    byteSize: 100,
    transformed: false,
  }));
}

beforeEach(async () => {
  await deleteProject(PROJECT.id).catch(() => undefined);
  resetState();
  useAppStore.setState({ project: projectForDelivery() });
  useSettings.setState({
    keys: { dashscope: 'sk-test', minimax: 'sk-minimax', zhipu: 'sk-zhipu' },
    prefs: {
      ...useSettings.getState().prefs,
      defaultReferenceProfileId: 'minimax-image',
    },
  });
});

describe('投递：1 槽跳切首帧优先主帧', () => {
  it('**用主帧替代角色图/场景板**：referenceImages 只有主帧，职责说明是主帧', async () => {
    await seedAssets({ staging: true });
    await useImage.getState().generateForFrame(SHOT_ID, 'first-frame', true);

    const req = mocks.captured[0]!;
    expect(req.referenceImages).toEqual([`data:image/png;base64,staging-old`]);
    expect(req.frameRole?.roles?.[0]).toContain('staging reference frame');
    // P2-c：主帧走 passthrough（不重编码，只在有变化时警告）
    expect(
      mocks.prepareReference.mock.calls.some(
        (call) => call[0]?.role === 'staging-frame' && call[1] === 'passthrough',
      ),
    ).toBe(true);
    // 用了主帧时不再提示「没有主帧」
    expect(useImage.getState().feedback[`first-frame:${SHOT_ID}`]?.warnings.join('\n')).not.toContain(
      '还没有主帧',
    );
  });

  it('**没有主帧 → 退回原行为，并给 info 提示**', async () => {
    await seedAssets({ staging: false });
    await useImage.getState().generateForFrame(SHOT_ID, 'first-frame', true);

    const req = mocks.captured[0]!;
    expect(req.referenceImages).toHaveLength(1);
    expect(req.referenceImages![0]).not.toContain('staging');
    const warnings = useImage.getState().feedback[`first-frame:${SHOT_ID}`]?.warnings.join('\n') ?? '';
    expect(warnings).toContain('还没有主帧');
  });

  it('0 槽纯文生图不投递主帧', async () => {
    useSettings.setState({
      prefs: { ...useSettings.getState().prefs, defaultReferenceProfileId: 'zhipu-image' },
    });
    await seedAssets({ staging: true });
    await useImage.getState().generateForFrame(SHOT_ID, 'first-frame', true);

    expect(mocks.captured[0]!.referenceImages).toBeUndefined();
    expect(mocks.prepareReference).not.toHaveBeenCalled();
  });
});

describe('generateStagingFrame', () => {
  beforeEach(() => {
    useSettings.setState({
      prefs: { ...useSettings.getState().prefs, defaultReferenceProfileId: 'qwen-image-edit' },
    });
  });

  it('**成功**：用「角色形象图 + 场景板」生成，存为 staging-frame，替换旧主帧', async () => {
    await seedAssets({ staging: true });
    await useImage.getState().generateStagingFrame(SCENE_ID);

    const feedback = useImage.getState().feedback[`staging:${SCENE_ID}`];
    expect(feedback?.kind).toBe('info'); // 有「替换旧主帧」提示
    expect(feedback?.message).toContain('主帧');
    expect(feedback?.warnings.join('\n')).toContain('原来的主帧已被替换');

    const req = mocks.captured[0]!;
    expect(req.referenceImages).toHaveLength(2); // 林冲全身 + 场景板
    expect(req.prompt).toContain('staging reference image');
    expect(req.aspectRatio).toBe(PROJECT.brief.aspectRatio);

    const sceneAssets = await listAssetsFor(PROJECT.id, SCENE_ID);
    const staging = sceneAssets.filter((item) => item.kind === 'staging-frame');
    expect(staging).toHaveLength(1);
    expect(staging[0]!.id).not.toBe('staging-old');
    expect(staging[0]!.refId).toBe(SCENE_ID);
    expect(staging[0]!.promptSnapshot).toContain('staging reference image');

    const counts = useImage.getState().assetCounts['staging-frame'];
    expect(counts).toBe(1);
    // 场景页通过 gallery[sceneId] 取主帧（ui-design 用）
    const gallery = useImage.getState().gallery[SCENE_ID] ?? [];
    expect(gallery.some((item) => item.kind === 'staging-frame')).toBe(true);
  });

  it('**0 槽/不支持参考图 → 不生成，给人话反馈**', async () => {
    useSettings.setState({
      prefs: { ...useSettings.getState().prefs, defaultReferenceProfileId: 'zhipu-image' },
    });
    await seedAssets();
    await useImage.getState().generateStagingFrame(SCENE_ID);

    const feedback = useImage.getState().feedback[`staging:${SCENE_ID}`];
    expect(feedback?.kind).toBe('error');
    expect(feedback?.message).toContain('不能带参考图');
    expect(mocks.generateImages).not.toHaveBeenCalled();
  });

  it('**缺场景板 → 说清缺什么，不生成**', async () => {
    await seedAssets({ plate: false });
    await useImage.getState().generateStagingFrame(SCENE_ID);
    const feedback = useImage.getState().feedback[`staging:${SCENE_ID}`];
    expect(feedback?.kind).toBe('error');
    expect(feedback?.message).toContain('主视角参考板');
    expect(mocks.generateImages).not.toHaveBeenCalled();
  });

  it('**缺角色形象图 → 点名角色，不生成**', async () => {
    await seedAssets({ sheets: false });
    await useImage.getState().generateStagingFrame(SCENE_ID);
    const feedback = useImage.getState().feedback[`staging:${SCENE_ID}`];
    expect(feedback?.kind).toBe('error');
    expect(feedback?.message).toContain('林冲');
    expect(feedback?.message).toContain('形象图');
    expect(mocks.generateImages).not.toHaveBeenCalled();
  });

  it('**槽位不够 → 不生成，说清需要几张**', async () => {
    // 回到 1 槽档案：林冲 1 张 + 场景板 1 张 = 2 > 1
    useSettings.setState({
      prefs: { ...useSettings.getState().prefs, defaultReferenceProfileId: 'minimax-image' },
    });
    await seedAssets();
    await useImage.getState().generateStagingFrame(SCENE_ID);
    const feedback = useImage.getState().feedback[`staging:${SCENE_ID}`];
    expect(feedback?.kind).toBe('error');
    expect(feedback?.message).toContain('最多接受 1 张');
    expect(mocks.generateImages).not.toHaveBeenCalled();
  });
});

describe('promoteStagingFrame', () => {
  it('**把首帧复制成主帧**：保留元数据 + sourceAssetIds，原首帧还在，旧主帧被替换', async () => {
    await seedAssets({ staging: true });
    await useImage.getState().promoteStagingFrame(SCENE_ID, 'first-shot02');

    const feedback = useImage.getState().feedback[`staging:${SCENE_ID}`];
    expect(feedback?.kind).toBe('ok');
    expect(feedback?.warnings.join('\n')).toContain('原来的主帧已被替换');

    const sceneAssets = await listAssetsFor(PROJECT.id, SCENE_ID);
    const staging = sceneAssets.filter((item) => item.kind === 'staging-frame');
    expect(staging).toHaveLength(1);
    expect(staging[0]!.sourceAssetIds).toEqual(['first-shot02']);
    expect(staging[0]!.dataUrl).toBe('data:image/png;base64,first-shot02');
    expect(staging[0]!.promptSnapshot).toBe('x');

    // 原首帧仍是首帧
    const shotAssets = await listAssetsFor(PROJECT.id, SHOT_ID);
    expect(shotAssets.some((item) => item.id === 'first-shot02')).toBe(true);
  });

  it('非首帧 → 拒绝', async () => {
    await seedAssets({ staging: false });
    await saveAssets([asset('peak-shot02', 'action-peak', SHOT_ID)]);
    await useImage.getState().promoteStagingFrame(SCENE_ID, 'peak-shot02');
    const feedback = useImage.getState().feedback[`staging:${SCENE_ID}`];
    expect(feedback?.kind).toBe('error');
    expect(feedback?.message).toContain('首帧');
    const staging = (await listAssetsFor(PROJECT.id, SCENE_ID)).filter(
      (item) => item.kind === 'staging-frame',
    );
    expect(staging).toHaveLength(0);
  });

  it('不属于该场景的首帧 → 拒绝', async () => {
    await seedAssets({ staging: false });
    const other = PROJECT.shots.find((shot) => shot.sceneId !== SCENE_ID)!;
    await saveAssets([asset('first-other', 'first-frame', other.id)]);
    await useImage.getState().promoteStagingFrame(SCENE_ID, 'first-other');
    const feedback = useImage.getState().feedback[`staging:${SCENE_ID}`];
    expect(feedback?.kind).toBe('error');
    expect(feedback?.message).toContain('不属于这个场景');
  });
});

describe('存储：字节统计与删除级联', () => {
  it('主帧计入 assetsByteSize；删项目会连带删主帧', async () => {
    await saveAssets([asset('staging-byte', 'staging-frame', SCENE_ID, { byteSize: 1234 })]);
    const before = await assetsByteSize(PROJECT.id);
    expect(before).toBeGreaterThanOrEqual(1234);

    await deleteProject(PROJECT.id);
    expect(await listAssets(PROJECT.id)).toHaveLength(0);
  });
});
