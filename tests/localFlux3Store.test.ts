// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageRequest, ModelProfile } from '../src/types/model';

/**
 * 本地档案在 store 里的解析（v0.61）
 *
 * 验证：没有 Key 也能走本地档案；设置里的 endpoint/timeout 覆盖会
 * 合并进传给 generateImages 的 profile，且不修改内置档案。
 * 出图本身用 mock，不启动 GPU。
 */

const mocks = vi.hoisted(() => ({
  captured: [] as { profile: ModelProfile; apiKey: string; req: ImageRequest }[],
}));

vi.mock('../src/services/image/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/image/generate')>();
  return {
    ...actual,
    generateImages: async (args: { profile: ModelProfile; apiKey: string; req: ImageRequest }) => {
      mocks.captured.push(args);
      return {
        ok: true,
        warnings: [],
        images: [{ url: 'data:image/png;base64,OUT', dataUrl: 'data:image/png;base64,OUT' }],
      };
    },
  };
});

import { useImage } from '../src/store/image';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { sampleProject } from '../src/data/samples/sampleProject';
import { findProfile } from '../src/data/models/profiles';

const local = findProfile('local-flux3')!;

beforeEach(() => {
  mocks.captured.length = 0;
  useImage.setState({
    pending: null,
    feedback: {},
    gallery: {},
    assetCount: 0,
    assetCounts: {},
    batch: null,
    batchSummary: null,
  });
  useAppStore.setState({ project: structuredClone(sampleProject) });
  useSettings.setState({
    keys: {},
    prefs: {
      ...useSettings.getState().prefs,
      defaultT2iProfileId: 'local-flux3',
      defaultReferenceProfileId: 'local-flux3',
      localModelEndpoint: 'http://127.0.0.1:9999/v1',
      localModelTimeoutMs: 123_456,
    },
  });
});

describe('store 解析本地档案', () => {
  it('**localModelEndpoint 覆盖不会改道云端档案**：qwen-image 仍用自己的 endpoint', async () => {
    useSettings.setState({
      keys: { dashscope: 'sk-test' },
      prefs: {
        ...useSettings.getState().prefs,
        defaultT2iProfileId: 'qwen-image',
        defaultReferenceProfileId: 'qwen-image',
        localModelEndpoint: 'http://127.0.0.1:9999/v1',
      },
    });
    const cloud = findProfile('qwen-image')!;

    await useImage.getState().generateForFrame('shot-02', 'first-frame', false);

    expect(mocks.captured).toHaveLength(1);
    const { profile, apiKey } = mocks.captured[0]!;
    expect(profile.id).toBe('qwen-image');
    expect(profile.endpoint).toBe(cloud.endpoint);
    expect(profile.endpoint).not.toBe('http://127.0.0.1:9999/v1');
    expect(apiKey).toBe('sk-test');
  });

  it('**没有 Key 也能出图**，并把 endpoint/timeout 覆盖带进 profile', async () => {
    await useImage.getState().generateForFrame('shot-02', 'first-frame', false);

    expect(mocks.captured).toHaveLength(1);
    const { profile, apiKey } = mocks.captured[0]!;
    expect(profile.id).toBe('local-flux3');
    expect(profile.authType).toBe('none');
    expect(profile.endpoint).toBe('http://127.0.0.1:9999/v1');
    expect(profile.timeoutMs).toBe(123_456);
    expect(apiKey).toBe('');

    const feedback = useImage.getState().feedback['first-frame:shot-02'];
    expect(feedback?.kind).not.toBe('error');

    // 内置档案对象没有被修改
    expect(local.endpoint).toBe('http://127.0.0.1:8099/v1');
    expect(local.timeoutMs).toBe(600_000);
  });
});
