import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 出图落库失败与配额预检（v0.54 · P1-3）
 *
 * ===========================================================================
 * 为什么这两条要单独测
 * ===========================================================================
 * 1. 图片是 base64 存 IndexedDB 的，几十张后就会碰到配额。
 *    `bulkPut` 抛 `QuotaExceededError` 时原来没有任何 catch：
 *    异常变成 unhandled rejection，feedback 不更新，用户以为图已保存——
 *    而它只存在于厂商 24 小时后失效的临时链接里。
 * 2. 配额接近满但还没满时，用户没机会提前处理。落库前应当提示一次。
 *
 * 这里把「存储层」和「生成层」都 mock 掉，只测 store 的编排逻辑，
 * 不会真的调用厂商接口，也不会写 IndexedDB。
 */

const mocks = vi.hoisted(() => ({
  saveAssets: vi.fn(),
  estimateUsage: vi.fn(),
  generateImages: vi.fn(),
}));

vi.mock('../src/services/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage')>();
  return {
    ...actual,
    saveAssets: mocks.saveAssets,
    estimateUsage: mocks.estimateUsage,
    listAssets: vi.fn(async () => []),
    listAssetsFor: vi.fn(async () => []),
  };
});

vi.mock('../src/services/image/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/image/generate')>();
  return { ...actual, generateImages: mocks.generateImages };
});

import { useImage } from '../src/store/image';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { sampleProject } from '../src/data/samples/sampleProject';

const SHOT_ID = sampleProject.shots[0]!.id;

function configure(): void {
  useAppStore.setState({
    project: structuredClone(sampleProject),
    report: null,
    dirty: false,
    revision: 0,
    saveError: null,
  });
  useSettings.setState({
    keys: { dashscope: 'sk-test' },
    prefs: { ...useSettings.getState().prefs, dontSaveKeys: false },
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
  mocks.generateImages.mockResolvedValue({
    ok: true,
    images: [{ url: 'https://example.com/generated.png', dataUrl: 'data:image/png;base64,AAA' }],
    warnings: [],
  });
  mocks.saveAssets.mockResolvedValue(undefined);
  mocks.estimateUsage.mockResolvedValue(null);
}

function feedbackOf(key = `first-frame:${SHOT_ID}`) {
  return useImage.getState().feedback[key];
}

beforeEach(() => {
  vi.clearAllMocks();
  configure();
});

describe('出图落库失败 · 不许静默丢图', () => {
  it('**saveAssets 抛配额错误时，feedback 变成人话错误，pending 清空**', async () => {
    mocks.saveAssets.mockRejectedValue(new DOMException('exceeded', 'QuotaExceededError'));

    await useImage.getState().generateForFrame(SHOT_ID, 'first-frame', false);

    const feedback = feedbackOf();
    expect(feedback?.kind).toBe('error');
    expect(feedback?.message).toContain('没能存进本机');
    expect(feedback?.message).toContain('临时链接');
    expect(feedback?.message).toContain('备份');
    expect(useImage.getState().pending).toBeNull();
  });

  it('批量路径把落库失败计入 failed，不再报「全部完成」', async () => {
    mocks.saveAssets.mockRejectedValue(new DOMException('exceeded', 'QuotaExceededError'));

    await useImage.getState().generateAllFramesInOrder();

    const summary = useImage.getState().batchSummary ?? '';
    expect(summary).toContain('失败');
    expect(summary).not.toContain('全部完成');
  });
});

describe('落库前的配额预检', () => {
  it('**用量超过 80% 时，生成成功也要提示先备份/清理**', async () => {
    mocks.estimateUsage.mockResolvedValue({ usage: 850, quota: 1000 });

    await useImage.getState().generateForFrame(SHOT_ID, 'first-frame', false);

    const feedback = feedbackOf();
    expect(feedback?.kind).toBe('info');
    expect(feedback?.warnings.join('\n')).toContain('本机存储已用掉约 85%');
    expect(feedback?.warnings.join('\n')).toContain('备份');
  });

  it('用量正常时不打扰（不产生这条警告）', async () => {
    mocks.estimateUsage.mockResolvedValue({ usage: 100, quota: 1000 });

    await useImage.getState().generateForFrame(SHOT_ID, 'first-frame', false);

    const feedback = feedbackOf();
    expect(feedback?.kind).toBe('ok');
    expect(feedback?.warnings.join('\n')).not.toContain('本机存储已用掉');
  });

  it('estimateUsage 不可用（返回 null）时照常出图，不报错', async () => {
    mocks.estimateUsage.mockResolvedValue(null);

    await useImage.getState().generateForFrame(SHOT_ID, 'first-frame', false);

    expect(feedbackOf()?.kind).toBe('ok');
    expect(mocks.saveAssets).toHaveBeenCalledTimes(1);
  });
});
