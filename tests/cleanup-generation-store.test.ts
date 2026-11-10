import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * store/generation.ts 的编排逻辑（v0.55 · 测试缺口 E2-①）
 *
 * ===========================================================================
 * 为什么选它
 * ===========================================================================
 * 全仓审查 P2-16 统计出 13 个「从未被任何测试 import」的 src 文件，
 * `store/generation.ts` 是其中最大的一个（315 行）。它负责把「生成故事 / 角色场景 /
 * 分镜 / 风格词」的结果写回项目，还要处理「没配置好」「生成失败」「并发重复点」
 * 三种边界——这些路径一直只靠手测。
 *
 * 这里 mock 掉 LLM 层（不真的发请求），只测 store 的编排：
 *  - 未就绪 → 错误反馈，不调用生成
 *  - 成功 → 写回项目 + ok 反馈
 *  - 失败 → 保留 detail/raw/warnings 供折叠区排查
 *  - 已有任务在跑 → 不重复发起
 */

const mocks = vi.hoisted(() => ({
  buildGenerateContext: vi.fn(),
  generateStory: vi.fn(),
  generateAssets: vi.fn(),
  generateShots: vi.fn(),
  generateStyleTags: vi.fn(),
}));

vi.mock('../src/services/llm/readiness', () => ({
  buildGenerateContext: mocks.buildGenerateContext,
}));

vi.mock('../src/services/llm/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/llm/generate')>();
  return {
    ...actual,
    generateStory: mocks.generateStory,
    generateAssets: mocks.generateAssets,
    generateShots: mocks.generateShots,
    generateStyleTags: mocks.generateStyleTags,
  };
});

import { useGeneration } from '../src/store/generation';
import { makeEmptyProject, useAppStore } from '../src/store/app';
import type { GenerateContext } from '../src/services/llm/generate';

const FAKE_CTX: GenerateContext = {
  profile: { id: 'fake', name: '假模型' } as GenerateContext['profile'],
  apiKey: 'sk-test',
  model: 'fake-model',
};

function emptyStory() {
  return {
    body: '',
    charactersNote: '',
    setting: '',
    conflict: '',
    ending: '',
    scenes: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({
    project: makeEmptyProject('生成测试'),
    report: null,
    dirty: false,
    revision: 0,
    saveError: null,
  });
  useGeneration.setState({ pending: null, feedback: {} });
  mocks.buildGenerateContext.mockReturnValue({ ctx: FAKE_CTX });
});

describe('runStory · 编排', () => {
  it('**成功时把故事写回项目**，反馈里带「一次成功/重试次数」', async () => {
    mocks.generateStory.mockResolvedValue({
      ok: true,
      attempts: 1,
      warnings: [],
      data: { ...emptyStory(), body: '一个人在山神庙过夜。', scenes: [{ label: '山神庙', summary: '' }] },
    });

    await useGeneration.getState().runStory();

    expect(useAppStore.getState().project?.story.body).toBe('一个人在山神庙过夜。');
    const feedback = useGeneration.getState().feedback.story;
    expect(feedback?.kind).toBe('ok');
    expect(feedback?.message).toContain('一次成功');
    expect(useGeneration.getState().pending).toBeNull();
  });

  it('**模型没配置好时不发请求，直接给人话错误**', async () => {
    mocks.buildGenerateContext.mockReturnValue({ error: '还没有填「DeepSeek」的 API Key。' });

    await useGeneration.getState().runStory();

    expect(mocks.generateStory).not.toHaveBeenCalled();
    const feedback = useGeneration.getState().feedback.story;
    expect(feedback?.kind).toBe('error');
    expect(feedback?.message).toContain('API Key');
  });

  it('**失败时保留 detail 与 raw**（折叠区排查「格式不对」要用）', async () => {
    mocks.generateStory.mockResolvedValue({
      ok: false,
      attempts: 2,
      warnings: ['第 1 次生成的结果结构不对，已自动重试。'],
      error: '模型返回的故事结构不对',
      detail: 'body：expected string',
      raw: '{"body": 123}',
    });

    await useGeneration.getState().runStory();

    const feedback = useGeneration.getState().feedback.story;
    expect(feedback?.kind).toBe('error');
    expect(feedback?.detail).toContain('expected string');
    expect(feedback?.raw).toContain('"body"');
    expect(feedback?.warnings).toHaveLength(1);
  });

  it('**已有任务在跑时直接返回**，不会并发发起第二个请求', async () => {
    useGeneration.setState({ pending: 'assets' });

    await useGeneration.getState().runStory();

    expect(mocks.generateStory).not.toHaveBeenCalled();
    expect(useGeneration.getState().pending).toBe('assets');
  });
});

describe('runStyleTags · 编排', () => {
  it('中文风格倾向为空时只给提示，不调模型', async () => {
    await useGeneration.getState().runStyleTags();

    expect(mocks.generateStyleTags).not.toHaveBeenCalled();
    expect(useGeneration.getState().feedback.style?.kind).toBe('info');
  });

  it('**成功时把英文风格词写回项目**（之后出图都会带上）', async () => {
    useAppStore.getState().patchBrief({ styleTone: '水墨写意 + 冷色调' });
    mocks.generateStyleTags.mockResolvedValue({
      ok: true,
      attempts: 1,
      warnings: [],
      data: { tags: ['Chinese ink wash', 'cold palette'] },
    });

    await useGeneration.getState().runStyleTags();

    expect(useAppStore.getState().project?.brief.styleTags).toEqual([
      'Chinese ink wash',
      'cold palette',
    ]);
    expect(useGeneration.getState().feedback.style?.kind).toBe('ok');
  });
});
