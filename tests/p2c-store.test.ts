// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageRequest } from '../src/types/model';

/**
 * P2-c store 接线
 *
 * ===========================================================================
 * 这组测试盯三件事
 * ===========================================================================
 * 1. 发给模型的 referenceImages 是**预处理后的副本**（帧类锚点被替换）；
 * 2. 图库里存的原始资产**一个字节都没变**（只处理本次请求副本）；
 * 3. 0 槽纯文生图**不经过**预处理（不调用 prepareReference）。
 *
 * prepare 用 mock：真实实现的算法在 `prepareReference.test.ts` 里用注入的假
 * decode/encode 覆盖；这里只验证「有没有接上、接得对不对」。
 */

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  captured: [] as ImageRequest[],
}));

vi.mock('../src/services/image/prepare', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/image/prepare')>();
  return { ...actual, prepareReference: mocks.prepare };
});

vi.mock('../src/services/image/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/image/generate')>();
  return {
    ...actual,
    generateImages: async (args: { req: ImageRequest }) => {
      mocks.captured.push(args.req);
      return {
        ok: true,
        warnings: [],
        images: [{ dataUrl: 'data:image/png;base64,OUT', url: 'https://x/y.png' }],
      };
    },
  };
});

import { useImage } from '../src/store/image';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { sampleProject } from '../src/data/samples/sampleProject';
import { listAssetsFor, saveAssets } from '../src/services/storage';

const PROJECT = sampleProject;
const SHOT = 'shot-02';

function imageAsset(id: string, kind: 'end-frame' | 'character-sheet' | 'character-sheet-face' | 'scene-plate', refId: string) {
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
  };
}

function projectWithReferences() {
  const project = structuredClone(sampleProject);
  project.shots[0]!.transitionType = 'continuation';
  const second = project.shots[1]!;
  second.characterIds = ['ch-linchong'];
  second.shotSize = 'medium';
  return project;
}

async function runGeneration(): Promise<void> {
  useAppStore.setState({ project: projectWithReferences() });
  await useImage.getState().generateForFrame(SHOT, 'first-frame', true);
}

function warningsOf(): string[] {
  return useImage.getState().feedback['first-frame:shot-02']?.warnings ?? [];
}

beforeEach(async () => {
  mocks.captured.length = 0;
  mocks.prepare.mockReset();
  // 只让帧类锚点（aspect）「发生变化」，角色/场景保持原样（passthrough/fit-bytes 未超限）
  mocks.prepare.mockImplementation(
    async (anchor: { dataUrl: string }, purpose: string) => ({
      dataUrl: purpose === 'aspect' ? `${anchor.dataUrl}?prepared=aspect` : anchor.dataUrl,
      width: purpose === 'aspect' ? 1024 : 0,
      height: purpose === 'aspect' ? 1024 : 0,
      byteSize: 1000,
      transformed: purpose === 'aspect',
    }),
  );

  useImage.setState({
    pending: null,
    feedback: {},
    gallery: {},
    assetCount: 0,
    assetCounts: {},
    batch: null,
    batchSummary: null,
  });
  useSettings.setState({
    keys: { dashscope: 'sk-test', minimax: 'sk-minimax', zhipu: 'sk-zhipu' },
    prefs: { ...useSettings.getState().prefs, defaultReferenceProfileId: 'qwen-image-edit' },
  });
  useAppStore.setState({ project: structuredClone(sampleProject) });
  await saveAssets([
    imageAsset('end-01', 'end-frame', 'shot-01'),
    imageAsset('full-linchong', 'character-sheet', 'ch-linchong'),
    imageAsset('face-linchong', 'character-sheet-face', 'ch-linchong'),
    imageAsset('plate', 'scene-plate', sampleProject.shots[1]!.sceneId),
  ]);
});

describe('参考图投递前的预处理', () => {
  it('**帧类锚点用 aspect 处理，角色/场景不裁**；请求里的 referenceImages 是处理后副本', async () => {
    await runGeneration();

    const purposes = mocks.prepare.mock.calls.map((call) => call[1]);
    expect(purposes).toHaveLength(3);
    // qwen-image-edit 声明了 maxBytesPerImage → 角色/场景走 fit-bytes；帧类走 aspect
    expect(purposes.filter((purpose) => purpose === 'aspect')).toHaveLength(1);
    expect(purposes.filter((purpose) => purpose === 'fit-bytes')).toHaveLength(2);

    const req = mocks.captured[0]!;
    expect(req.referenceImages).toHaveLength(3);
    // 只有帧类锚点被替换（?prepared=aspect），其余保持原图
    expect(req.referenceImages!.filter((url) => url.endsWith('?prepared=aspect'))).toHaveLength(1);
    expect(req.referenceImages!.some((url) => url.includes('plate'))).toBe(true);

    // 只在真的有变化时提示（一次），且视频路径（fit-bytes 未超限）不提示
    const warnings = warningsOf().join('\n');
    expect(warnings.match(/已自动按画幅裁切\/压缩/g)).toHaveLength(1);
  });

  it('**图库原始资产字节未变**（只处理本次请求副本）', async () => {
    await runGeneration();
    const previous = await listAssetsFor(PROJECT.id, 'shot-01');
    const endFrame = previous.find((asset) => asset.kind === 'end-frame')!;
    expect(endFrame.dataUrl).toBe('data:image/png;base64,end-01');
    expect(endFrame.dataUrl).not.toContain('prepared');

    const character = await listAssetsFor(PROJECT.id, 'ch-linchong');
    expect(character.every((asset) => !asset.dataUrl?.includes('prepared'))).toBe(true);
  });

  it('**预处理失败**：请求回退原图 + feedback 给人话 warning', async () => {
    mocks.prepare.mockImplementation(async (anchor: { dataUrl: string }, purpose: string) => {
      if (purpose === 'aspect') {
        return {
          dataUrl: anchor.dataUrl,
          width: 0,
          height: 0,
          byteSize: 1,
          transformed: false,
          reason: '参考图解码失败，已回退原图。',
        };
      }
      return {
        dataUrl: anchor.dataUrl,
        width: 0,
        height: 0,
        byteSize: 1,
        transformed: false,
      };
    });

    await runGeneration();

    const req = mocks.captured[0]!;
    expect(req.referenceImages!.every((url) => !url.includes('prepared'))).toBe(true);
    expect(warningsOf().join('\n')).toContain('参考图解码失败，已回退原图');
  });

  it('**0 槽纯文生图不经过预处理**', async () => {
    useSettings.setState({
      prefs: { ...useSettings.getState().prefs, defaultReferenceProfileId: 'zhipu-image' },
    });
    await runGeneration();

    expect(mocks.prepare).not.toHaveBeenCalled();
    const req = mocks.captured[0]!;
    expect(req.referenceImages).toBeUndefined();
  });
});
