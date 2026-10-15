// @vitest-environment jsdom
// 需要 localStorage 来验证「模型名覆盖」的持久化
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveModelName, isModelOverridden } from '../src/services/llm/modelName';
import { buildGenerateContext } from '../src/services/llm/readiness';
import { generateStory } from '../src/services/llm/generate';
import { testConnection } from '../src/services/gateway';
import { MODEL_PROFILES, findProfile } from '../src/data/models/profiles';
import { useSettings } from '../src/store/settings';
import { makeEmptyProject } from '../src/store/app';

/**
 * 模型名解析 —— 一个真实线上 bug 的回归测试
 *
 * ===========================================================================
 * 那个 bug 的症状：**测试连接通过，一生成就报错**
 * ===========================================================================
 * 厂商的原话：
 *   "The supported API model names are deepseek-flash, deepseek-v4-pro,
 *    but you passed DeepSeek Chat."
 *
 * 原因不是打错字，而是同一个东西在两个地方各算了一遍：
 *  - 测试连接走 `profile.model`（deepseek-v4-pro）→ 通过
 *  - 生成走 `profile.name`（"DeepSeek Chat"，界面显示名）→ 失败
 *
 * 所以这组测试的**核心断言不是「模型名对不对」，而是「两条路径算出来的是同一个值」**。
 * 只要还有两处，就还会有下一次不一致。
 */

const llm = findProfile('deepseek-chat')!;

function resetSettings(): void {
  localStorage.clear();
  sessionStorage.clear();
  useSettings.setState({
    prefs: {
      dontSaveKeys: false,
      defaultLlmProfileId: 'deepseek-flash',
      defaultT2iProfileId: 'qwen-image',
      defaultReferenceProfileId: 'qwen-image-edit',
      proxyBaseUrl: '',
      proxyPassword: '',
    },
    keys: { 'deepseek': 'sk-test' },
    modelOverrides: {},
  });
}

/** 抓住请求体，看实际发出去的模型名是什么 */
function captureFetch(responseBody: string): { fetchImpl: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return {
      ok: true,
      status: 200,
      text: async () => responseBody,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

const storyReply = JSON.stringify({
  choices: [
    {
      message: {
        content: JSON.stringify({
          body: '一只狗在吃汉堡。',
          charactersNote: '',
          setting: '',
          conflict: '',
          ending: '',
          scenes: [],
        }),
      },
    },
  ],
});

describe('模型名解析 · 唯一来源', () => {
  beforeEach(resetSettings);

  it('默认取档案里的真实模型名，不是界面显示名', () => {
    const model = resolveModelName(llm);
    expect(model).toBe('deepseek-v4-pro');
    expect(resolveModelName(findProfile('deepseek-flash')!)).toBe('deepseek-flash');
    // 关键：绝不能是显示名
    expect(model).not.toBe(llm.name);
    expect(model).not.toContain(' ');
  });

  it('所有 LLM 档案的模型名都不含空格（显示名不许漏到这一层）', () => {
    for (const profile of MODEL_PROFILES.filter((p) => p.type === 'llm')) {
      expect(profile.model, `${profile.id} 缺少 model 字段`).toBeDefined();
      expect(profile.model).not.toContain(' ');
      expect(profile.model).not.toBe(profile.name);
    }
  });

  it('用户覆盖后以覆盖值为准', () => {
    useSettings.getState().setModelOverride('deepseek-chat', 'deepseek-v5-ultra');
    expect(resolveModelName(llm)).toBe('deepseek-v5-ultra');
    expect(isModelOverridden('deepseek-chat')).toBe(true);
  });

  it('覆盖值只有空白时视为未覆盖', () => {
    useSettings.getState().setModelOverride('deepseek-chat', '   ');
    expect(resolveModelName(llm)).toBe('deepseek-v4-pro');
  });

  it('清空覆盖后回到默认值', () => {
    useSettings.getState().setModelOverride('deepseek-chat', 'x');
    useSettings.getState().setModelOverride('deepseek-chat', '');
    expect(resolveModelName(llm)).toBe('deepseek-v4-pro');
    expect(isModelOverridden('deepseek-chat')).toBe(false);
  });

  it('覆盖值会持久化到本机（换个页面回来还在）', () => {
    useSettings.getState().setModelOverride('deepseek-chat', 'deepseek-v5-ultra');
    const stored = localStorage.getItem('aniguide:model-overrides');
    expect(stored).toContain('deepseek-v5-ultra');
  });
});

describe('回归 · 测试连接与生成必须用同一个模型名', () => {
  beforeEach(resetSettings);

  it('**两条路径算出来的模型名完全一致**（这就是当初出 bug 的地方）', async () => {
    const gen = captureFetch(storyReply);
    const built = buildGenerateContext();
    expect('ctx' in built).toBe(true);
    if (!('ctx' in built)) return;
    // 用「生成实际会用的那个档案」去测连接，这才是真实的对照
    const activeProfile = built.ctx.profile;

    await testConnection(activeProfile, 'sk-test', undefined, gen.fetchImpl, {
      modelName: resolveModelName(activeProfile),
    });

    const testBody = JSON.parse(gen.bodies[0]!) as { model: string };
    expect(testBody.model).toBe(built.ctx.model);
    // 默认档案是 flash
    expect(testBody.model).toBe('deepseek-flash');
  });

  it('用户覆盖模型名后，两条路径**同时**跟着变', async () => {
    // 覆盖**当前生效的那个档案**——覆盖别的档案不会影响这次生成，
    // 这本身就是正确行为（每个档案各有自己的模型名）
    useSettings.getState().setModelOverride('deepseek-flash', 'deepseek-v5-ultra');

    const gen = captureFetch(storyReply);
    const built = buildGenerateContext();
    if (!('ctx' in built)) return;
    const activeProfile = built.ctx.profile;

    await testConnection(activeProfile, 'sk-test', undefined, gen.fetchImpl, {
      modelName: resolveModelName(activeProfile),
    });

    const testBody = JSON.parse(gen.bodies[0]!) as { model: string };
    expect(testBody.model).toBe('deepseek-v5-ultra');
    expect(testBody.model).toBe(built.ctx.model);
  });

  it('生成请求里发的确实是真实模型名，不是显示名', async () => {
    const gen = captureFetch(storyReply);
    const project = makeEmptyProject('测试');
    const built = buildGenerateContext();
    expect('ctx' in built).toBe(true);
    if (!('ctx' in built)) return;

    await generateStory(project, { ...built.ctx, fetchImpl: gen.fetchImpl });

    const body = JSON.parse(gen.bodies[0]!) as { model: string };
    expect(body.model).toBe('deepseek-flash');
    // 这几个断言就是这个 bug 的护栏
    expect(body.model).not.toBe(built.ctx.profile.name);
    expect(body.model).not.toContain(' ');
    expect(body.model).not.toBe('DeepSeek Chat');
  });
});

describe('错误分类 · 厂商原话必须显眼', () => {
  it('「模型名不被接受」要出现在标题里，而不是埋在折叠区', async () => {
    const vendorSays = JSON.stringify({
      error: {
        message:
          'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed DeepSeek Chat.',
        type: 'invalid_request_error',
        code: 'invalid_request_error',
      },
    });

    let thrown: unknown;
    const failing = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () => vendorSays,
      }) as unknown as Response) as unknown as typeof fetch;

    const result = await testConnection(llm, 'sk-test', undefined, failing).catch((e: unknown) => {
      thrown = e;
      return undefined;
    });
    void thrown;

    expect(result?.ok).toBe(false);
    // 厂商原话里的关键信息必须在最显眼的位置
    expect(result?.info?.title).toContain('deepseek-flash');
    expect(result?.info?.title).toContain('deepseek-v4-pro');
    // 并且要告诉用户「去改设置页的模型名」
    expect(result?.info?.advice).toContain('模型名');
    expect(result?.info?.advice).toContain('设置');
  });

  it('与模型名无关的 400 不会误报成模型问题', async () => {
    const failing = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () => '{"error":{"message":"temperature must be between 0 and 2"}}',
      }) as unknown as Response) as unknown as typeof fetch;

    const result = await testConnection(llm, 'sk-test', undefined, failing);
    // 非模型问题也要把厂商原话带上（用户需要知道到底哪里填错了），
    // 但不能误报成模型名问题
    expect(result.info?.title).toContain('temperature');
    expect(result.info?.title).not.toContain('模型名不被接受');
  });
});
