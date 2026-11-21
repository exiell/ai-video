// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  captured: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/services/image/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/image/generate')>();
  return { ...actual, generateImages: mocks.generate };
});

import { sampleProject } from '../src/data/samples/sampleProject';
import { writeCustomModelConfigs } from '../src/data/customModels';
import { resolveDefaultImageEditProfile } from '../src/data/models/imageProfiles';
import { findProfile } from '../src/data/models/profiles';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { useImage } from '../src/store/image';
import { getDb, listAssetsFor } from '../src/services/storage';
import type { CustomModelConfig } from '../src/types/customModel';

const editConfig: CustomModelConfig = {
  id: 'edit-test',
  createdAt: '2026-01-01T00:00:00.000Z',
  name: '本地改图模型',
  modality: 'image',
  protocol: 'vllm-omni-chat-image',
  baseUrl: 'http://127.0.0.1:8098/v1',
  model: 'qwen-image-edit-2511',
  requiresKey: false,
  timeoutMs: 600_000,
  capabilities: { maxReferenceImages: 3, minReferenceImages: 1, maxOutputImages: 1 },
};
const editProfileId = 'custom:image:edit-test';

function generated(): { ok: true; images: { url: string; dataUrl: string }[]; warnings: string[] } {
  return {
    ok: true,
    images: [{ url: 'data:image/png;base64,OUT', dataUrl: 'data:image/png;base64,OUT' }],
    warnings: [],
  };
}

function prefsWith(overrides: Partial<ReturnType<typeof useSettings.getState>['prefs']> = {}) {
  return {
    ...useSettings.getState().prefs,
    defaultImageEditProfileId: editProfileId,
    ...overrides,
  };
}

beforeEach(async () => {
  mocks.generate.mockReset();
  mocks.generate.mockImplementation(async (options: Record<string, unknown>) => {
    mocks.captured.push(options);
    return generated();
  });
  mocks.captured.length = 0;
  await getDb().assets.clear();
  writeCustomModelConfigs([editConfig]);
  useAppStore.setState({ project: structuredClone(sampleProject) });
  useSettings.setState({
    customModels: [editConfig],
    keys: {},
    prefs: prefsWith(),
  });
  useImage.setState({
    pending: null,
    feedback: {},
    gallery: {},
    assetCount: 0,
    assetCounts: {},
    batch: null,
    batchSummary: null,
  });
});

describe('resolveDefaultImageEditProfile', () => {
  it('未设置/内置/自定义/被删回退', () => {
    expect(resolveDefaultImageEditProfile({})).toBeUndefined();
    expect(resolveDefaultImageEditProfile({ defaultImageEditProfileId: 'qwen-image-edit' })?.id).toBe(
      'qwen-image-edit',
    );
    expect(
      resolveDefaultImageEditProfile({ defaultImageEditProfileId: editProfileId })?.model,
    ).toBe('qwen-image-edit-2511');
    expect(resolveDefaultImageEditProfile({ defaultImageEditProfileId: 'custom:image:nope' })).toBeUndefined();
    expect(resolveDefaultImageEditProfile({ defaultImageEditProfileId: 'zhipu-image' })?.id).toBeUndefined();
  });

  it('本地 archive 应用 endpoint/timeout 覆盖', () => {
    const local = findProfile('local-flux3')!;
    const resolved = resolveDefaultImageEditProfile({
      defaultImageEditProfileId: local.id,
      localModelEndpoint: 'http://127.0.0.1:9999/v1',
      localModelTimeoutMs: 12345,
    });
    expect(resolved?.endpoint).toBe('http://127.0.0.1:9999/v1');
    expect(resolved?.timeoutMs).toBe(12345);
  });
});

describe('generateEditedImage', () => {
  it('未设置编辑模型：feedback 错误，不调用 transport', async () => {
    useSettings.setState({ prefs: prefsWith({ defaultImageEditProfileId: undefined }) });
    await useImage.getState().generateEditedImage({
      target: 'character',
      refId: 'ch-linchong',
      prompt: '改帽子',
      referenceImages: ['data:image/png;base64,IN'],
    });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(useImage.getState().feedback['edit:ch-linchong']?.message).toContain('还没有设置图像编辑模型');
  });

  it('0 张参考图 / 低于 min：提前错误，不调用 transport', async () => {
    for (const refs of [[], ['data:image/png;base64,IN']]) {
      await useImage.getState().generateEditedImage({
        target: 'character',
        refId: 'ch-linchong',
        prompt: '改帽子',
        referenceImages: refs,
      });
    }
    // min=1：0 张拒绝、1 张放行；检查最后一次已调用一次，但 0 张那次没有
    expect(useImage.getState().feedback['edit:ch-linchong']?.kind).toBe('ok');
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('角色编辑成功：asset kind/refId/referenceCount/promptSnapshot，feedback key 正确', async () => {
    await useImage.getState().generateEditedImage({
      target: 'character',
      refId: 'ch-linchong',
      prompt: '把帽子改成红色',
      referenceImages: ['data:image/png;base64,IN'],
      referenceLabels: ['角色形象图'],
    });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const call = mocks.captured[0] as { profile: { id: string }; req: { prompt: string; referenceImages: string[] } };
    expect(call.profile.id).toBe(editProfileId);
    expect(call.req.referenceImages).toEqual(['data:image/png;base64,IN']);
    expect(call.req.prompt).toContain('把帽子改成红色');
    expect(call.req.prompt).toContain('Project visual style');
    expect(useImage.getState().feedback['edit:ch-linchong']?.kind).toBe('ok');
    const assets = await listAssetsFor(sampleProject.id, 'ch-linchong');
    expect(assets[0]).toMatchObject({
      kind: 'character-sheet',
      refId: 'ch-linchong',
      referenceCount: 1,
      promptSnapshot: '把帽子改成红色',
    });
  });

  it('场景/帧 target→kind，frameKind 映射；超过 max 截断并 warning', async () => {
    await useImage.getState().generateEditedImage({
      target: 'scene',
      refId: 'sc-field',
      prompt: '换光线',
      referenceImages: ['data:image/png;base64,S1', 'data:image/png;base64,S2'],
    });
    await useImage.getState().generateEditedImage({
      target: 'frame',
      refId: 'shot-01',
      frameKind: 'end-frame',
      prompt: '改动作',
      referenceImages: ['data:image/png;base64,F1', 'data:image/png;base64,F2'],
    });
    await useImage.getState().generateEditedImage({
      target: 'frame',
      refId: 'shot-02',
      frameKind: 'first-frame',
      prompt: '换参考',
      referenceImages: ['a', 'b', 'c', 'd', 'e'],
    });
    const sceneAssets = await listAssetsFor(sampleProject.id, 'sc-field');
    expect(sceneAssets[0]?.kind).toBe('scene-plate');
    const shot1 = await listAssetsFor(sampleProject.id, 'shot-01');
    expect(shot1[0]?.kind).toBe('end-frame');
    const shot2 = await listAssetsFor(sampleProject.id, 'shot-02');
    expect(shot2[0]?.kind).toBe('first-frame');
    expect(shot2[0]?.referenceCount).toBe(3);
    const lastCall = mocks.captured[mocks.captured.length - 1] as { req: { referenceImages: string[] } };
    expect(lastCall.req.referenceImages).toHaveLength(3);
    expect(useImage.getState().feedback['edit:shot-02']?.warnings.join('\n')).toContain('多出的 2 张');
  });

  it('并发调用同 refId 只跑一次（pending/in-flight 防重）', async () => {
    let resolveGeneration: ((value: unknown) => void) | undefined;
    mocks.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    const first = useImage.getState().generateEditedImage({
      target: 'character',
      refId: 'ch-linchong',
      prompt: '拖延',
      referenceImages: ['data:image/png;base64,IN'],
    });
    const second = useImage.getState().generateEditedImage({
      target: 'character',
      refId: 'ch-linchong',
      prompt: '拖延2',
      referenceImages: ['data:image/png;base64,IN'],
    });
    await second;
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    resolveGeneration?.(generated());
    await first;
  });
});

describe('defaultImageEditProfileId 清理', () => {
  it('删除自定义图片档案时回退 undefined', () => {
    const added = useSettings.getState().addCustomModel({
      name: '临时改图',
      modality: 'image',
      protocol: 'vllm-omni-chat-image',
      baseUrl: 'http://127.0.0.1:8098/v1',
      model: 'qwen-image-edit-2511',
      requiresKey: false,
      timeoutMs: 600000,
      capabilities: { maxReferenceImages: 3, minReferenceImages: 1 },
    });
    expect(added.ok).toBe(true);
    useSettings.getState().setPref('defaultImageEditProfileId', `custom:image:${added.config!.id}`);
    useSettings.getState().removeCustomModel(added.config!.id);
    expect(useSettings.getState().prefs.defaultImageEditProfileId).toBeUndefined();
  });
});
