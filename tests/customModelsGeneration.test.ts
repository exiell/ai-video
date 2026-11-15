// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { customModelToProfile } from '../src/data/customModels';
import { DEFAULT_LLM_PROFILE_ID, type CustomModelConfig } from '../src/types/customModel';
import {
  DEFAULT_REFERENCE_PROFILE_ID,
  DEFAULT_T2I_PROFILE_ID,
} from '../src/data/models/profiles';
import { useSettings } from '../src/store/settings';
import { generateImages } from '../src/services/image/generate';
import { buildGenerateContext, checkLlmReadiness } from '../src/services/llm/readiness';
import { findProfile } from '../src/data/models/profiles';

/**
 * 自定义 text/image 生成链路（mock fetch，不联网）
 *
 * 验证：自定义 image 走统一执行器（openai-images / vllm-omni chat），
 * 自定义 text 走既有 OpenAI chat（readiness/context），内置行为不变。
 */

function config(overrides: Partial<CustomModelConfig> = {}): CustomModelConfig {
  return {
    id: 'cfg-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    name: '我的图片服务',
    modality: 'image',
    protocol: 'openai-images',
    baseUrl: 'https://api.example.com/v1',
    model: 'image-model',
    requiresKey: true,
    capabilities: { maxOutputImages: 1 },
    ...overrides,
  };
}

function addConfig(overrides: Partial<CustomModelConfig> = {}): CustomModelConfig {
  const images = config(overrides);
  const result = useSettings.getState().addCustomModel({
    name: images.name,
    modality: images.modality,
    protocol: images.protocol,
    baseUrl: images.baseUrl,
    model: images.model,
    requiresKey: images.requiresKey,
    ...(images.timeoutMs !== undefined ? { timeoutMs: images.timeoutMs } : {}),
    capabilities: images.capabilities,
  });
  if (!result.ok || !result.config) throw new Error(JSON.stringify(result.errors));
  return result.config;
}

const fakePrefetch = async (marker: string) => ({
  dataUrl: `data:image/png;base64,${marker}`,
  byteSize: 3,
  mimeType: 'image/png',
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useSettings.setState({
    customModels: [],
    prefs: {
      ...useSettings.getState().prefs,
      defaultLlmProfileId: DEFAULT_LLM_PROFILE_ID,
      defaultT2iProfileId: DEFAULT_T2I_PROFILE_ID,
      defaultReferenceProfileId: DEFAULT_REFERENCE_PROFILE_ID,
      dontSaveKeys: false,
    },
    keys: {},
    modelOverrides: {},
  });
});

describe('自定义 image · openai-images', () => {
  it('发出正确 URL/body/鉴权，参考图按能力投递', async () => {
    const cfg = addConfig({ capabilities: { maxOutputImages: 2, maxReferenceImages: 1, negativePrompt: true, seed: true } });
    const profile = customModelToProfile(cfg);
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ data: [{ url: 'https://img.example/a.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-custom',
      req: {
        prompt: 'a red circle',
        negativePrompt: 'bad',
        aspectRatio: '16:9',
        count: 2,
        seed: 5,
        referenceImages: ['data:image/png;base64,R1', 'data:image/png;base64,R2'],
      },
      fetchImpl,
      prefetchImpl: async () => fakePrefetch('a'),
    });
    expect(outcome.ok).toBe(true);
    expect(capturedUrl).toBe('https://api.example.com/v1/images/generations');
    expect(capturedHeaders.Authorization).toBe('Bearer sk-custom');
    expect(capturedBody).toMatchObject({
      model: 'image-model',
      negative_prompt: 'bad',
      size: '1280x720',
      n: 2,
      seed: 5,
    });
    // 旧 generate 会追加参考图职责说明；只断言原始 prompt 仍在
    expect(String(capturedBody.prompt)).toContain('a red circle');
    // 能力声明 1 张 → 参考图只发第一张
    expect(capturedBody.image).toEqual(['data:image/png;base64,R1']);
  });

  it('requiresKey=false 时不发 Authorization（本地兼容服务）', async () => {
    const cfg = addConfig({
      protocol: 'vllm-omni-chat-image',
      baseUrl: 'http://127.0.0.1:8099/v1',
      model: 'flux-3-image-klein',
      requiresKey: false,
      capabilities: { maxReferenceImages: 2 },
    });
    const profile = customModelToProfile(cfg);
    let headers: Record<string, string> = {};
    let body: { messages: { content: { type: string }[] }[] } = { messages: [] };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:8099/v1/chat/completions');
      headers = (init?.headers ?? {}) as Record<string, string>;
      body = JSON.parse(String(init?.body)) as typeof body;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,OUT' } }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const outcome = await generateImages({
      profile,
      apiKey: '',
      req: {
        prompt: 'combine',
        count: 1,
        referenceImages: ['data:image/png;base64,R1', 'data:image/png;base64,R2'],
      },
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(headers.Authorization).toBeUndefined();
    expect(body.messages[0]!.content.map((item) => item.type)).toEqual([
      'text',
      'image_url',
      'image_url',
    ]);
    expect(outcome.images[0]!.dataUrl).toBe('data:image/png;base64,OUT');
  });

  it('自定义 image 能力上限为 0 时，多传的参考图被截断并 warning', async () => {
    const cfg = addConfig({ capabilities: { maxOutputImages: 1, maxReferenceImages: 0 } });
    const profile = customModelToProfile(cfg);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ url: 'https://img.example/a.png' }] }), {
        status: 200,
      }),
    );
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-custom',
      req: { prompt: 'p', referenceImages: ['data:image/png;base64,R1'] },
      fetchImpl,
      prefetchImpl: async () => fakePrefetch('a'),
    });
    expect(outcome.warnings.join('\n')).toContain('不支持参考图');
  });
});

describe('自定义 text · 走既有 OpenAI chat', () => {
  it('requiresKey=false：readiness 直接可用，context 的 apiKey 为空', () => {
    const cfg = addConfig({
      name: '本地文本',
      modality: 'text',
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:9999/v1',
      model: 'local-text',
      requiresKey: false,
    });
    const profileId = `custom:text:${cfg.id}`;
    useSettings.setState({
      prefs: { ...useSettings.getState().prefs, defaultLlmProfileId: profileId },
    });

    expect(findProfile(profileId)?.id).toBe(profileId);
    const readiness = checkLlmReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.profile?.id).toBe(profileId);

    const context = buildGenerateContext();
    expect('ctx' in context).toBe(true);
    if ('ctx' in context) {
      expect(context.ctx.profile.id).toBe(profileId);
      expect(context.ctx.apiKey).toBe('');
      expect(context.ctx.profile.endpoint).toBe('http://127.0.0.1:9999/v1/chat/completions');
    }
  });

  it('requiresKey=true 缺 Key 时 readiness 报人话；填 Key 后可用', () => {
    const cfg = addConfig({
      name: '远端文本',
      modality: 'text',
      protocol: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      model: 'text-model',
      requiresKey: true,
    });
    const profileId = `custom:text:${cfg.id}`;
    useSettings.setState({
      prefs: { ...useSettings.getState().prefs, defaultLlmProfileId: profileId },
    });

    const missing = checkLlmReadiness();
    expect(missing.ready).toBe(false);
    expect(missing.reason).toContain('API Key');

    useSettings.getState().setCustomModelKey(cfg.id, 'sk-text');
    const ready = checkLlmReadiness();
    expect(ready.ready).toBe(true);
    const context = buildGenerateContext();
    if ('ctx' in context) expect(context.ctx.apiKey).toBe('sk-text');
  });
});
