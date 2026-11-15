// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleProject } from '../src/data/samples/sampleProject';
import { customModelToProfile } from '../src/data/customModels';
import {
  DEFAULT_LLM_PROFILE_ID,
  type CustomModelConfig,
  type CustomModelDraft,
} from '../src/types/customModel';
import {
  DEFAULT_REFERENCE_PROFILE_ID,
  DEFAULT_T2I_PROFILE_ID,
} from '../src/data/models/profiles';
import { useSettings } from '../src/store/settings';
import { checkCustomModel } from '../src/services/customModels/check';
import { generateStory } from '../src/services/llm/generate';

/**
 * task-56 收尾修复测试
 *
 * 覆盖：测试连接 Key 脱敏、maxOutputTokens 接线、空 choices、
 * 改 modality 后默认回退、localStorage 写失败返回失败状态。
 */

function draft(overrides: Partial<CustomModelDraft> = {}): CustomModelDraft {
  return {
    name: '测试服务',
    modality: 'text',
    protocol: 'openai-chat',
    baseUrl: 'https://api.example.com/v1',
    model: 'model-a',
    requiresKey: true,
    ...overrides,
  };
}

function add(overrides: Partial<CustomModelDraft> = {}): CustomModelConfig {
  const result = useSettings.getState().addCustomModel(draft(overrides));
  if (!result.ok || !result.config) throw new Error(JSON.stringify(result.errors));
  return result.config;
}

beforeEach(() => {
  vi.restoreAllMocks();
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('测试连接 · Key 脱敏', () => {
  const customKey = 'my-custom-key-123456';

  it('401/500 body 回显自定义 Key → message/detail/JSON 都不含 Key', async () => {
    const cfg = add();
    for (const status of [401, 500]) {
      const result = await checkCustomModel(cfg, customKey, {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ error: `invalid key ${customKey} for ${cfg.model}` }),
            { status, headers: { 'content-type': 'application/json' } },
          ),
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(customKey);
      expect(result.detail ?? '').toContain('[已隐藏]');
    }
  });

  it('URL-encoded / 大小写变体也替换', async () => {
    const key = 'Custom Key/+=';
    const encoded = encodeURIComponent(key); // Custom%20Key%2F%2B%3D
    const cfg = add();
    const result = await checkCustomModel(cfg, key, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: `raw=${key}; encoded=${encoded}; upper=${key.toUpperCase()}`,
          }),
          { status: 500 },
        ),
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain(key);
    expect(json).not.toContain(encoded);
    expect(json).not.toContain(key.toUpperCase());
    expect(result.detail).toContain('[已隐藏]');
  });

  it('通用规则 sk-/hf_/Bearer 仍被掩；成功路径不受影响', async () => {
    const cfg = add();
    const failed = await checkCustomModel(cfg, 'sk-test', {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: 'sk-secret123456 hf_abcdefghi Bearer abcdefgh',
          }),
          { status: 401 },
        ),
    });
    expect(failed.detail ?? '').not.toContain('sk-secret123456');
    expect(failed.detail ?? '').not.toContain('hf_abcdefghi');
    expect(failed.detail ?? '').not.toContain('abcdefgh');

    const ok = await checkCustomModel(cfg, 'sk-test', {
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
          status: 200,
        }),
    });
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain(cfg.model);
  });

  it('detail 截断到 ≤300 字，且不包含 Key', async () => {
    const cfg = add();
    const long = `prefix-${'x'.repeat(1000)}-${customKey}-suffix`;
    const result = await checkCustomModel(cfg, customKey, {
      fetchImpl: async () => new Response(long, { status: 500 }),
    });
    expect((result.detail ?? '').length).toBeLessThanOrEqual(300);
    expect(result.detail ?? '').not.toContain(customKey);
  });

  it('**400 字符长 Key**：先脱敏再截断，前 300/后 100 都不出现', async () => {
    const longKey = 'K'.repeat(400) + 'END';
    const cfg = add();
    for (const status of [401, 500]) {
      const result = await checkCustomModel(cfg, longKey, {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: `bad key ${longKey}` }), { status }),
      });
      const json = JSON.stringify(result);
      expect(json).not.toContain(longKey);
      expect(json).not.toContain(longKey.slice(0, 300));
      expect(json).not.toContain(longKey.slice(-100));
      expect((result.detail ?? '').length).toBeLessThanOrEqual(300);
    }
  });

  it('长 Key 的 URL-encoded / 大写变体同样不泄露；服务端只回显前 300 也遮', async () => {
    const raw = 'AbC123'.repeat(70); // 420 字符
    const encoded = encodeURIComponent(raw);
    const cfg = add();
    const result = await checkCustomModel(cfg, raw, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { raw, encoded, upper: raw.toUpperCase(), truncated: raw.slice(0, 300) } }),
          { status: 500 },
        ),
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain(raw);
    expect(json).not.toContain(encoded);
    expect(json).not.toContain(raw.toUpperCase());
    expect(json).not.toContain(raw.slice(0, 300));
    expect((result.detail ?? '').length).toBeLessThanOrEqual(300);
  });

  it('image /models 的 models 数组同样脱敏；正常模型名不受影响', async () => {
    const key = 'my-custom-key-123456';
    const encoded = encodeURIComponent(key);
    const cfg = add({
      modality: 'image',
      protocol: 'openai-images',
      name: 'img',
      model: 'normal-model',
    });
    const result = await checkCustomModel(cfg, key, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ data: [{ id: key }, { id: encoded }, { id: 'normal-model' }] }),
          { status: 200 },
        ),
    });
    expect(result.ok).toBe(true);
    expect(result.models).toContain('normal-model');
    const json = JSON.stringify(result);
    expect(json).not.toContain(key);
    expect(json).not.toContain(encoded);
  });
});

describe('maxOutputTokens 接线', () => {
  function textProfile(maxOutputTokens?: number) {
    return customModelToProfile({
      ...add({
        name: `text-${String(maxOutputTokens ?? 'none')}`,
        modality: 'text',
        protocol: 'openai-chat',
        capabilities: maxOutputTokens !== undefined ? { maxOutputTokens } : {},
      }),
    });
  }

  function captureBody(): { calls: string[]; fetchImpl: typeof fetch } {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it('设置 500 → 请求 max_tokens 被压到 500', async () => {
    const profile = textProfile(500);
    const { calls, fetchImpl } = captureBody();
    await generateStory(sampleProject, {
      profile,
      apiKey: 'sk-test',
      model: 'model-a',
      maxAttempts: 1,
      fetchImpl,
    });
    expect(calls.length).toBeGreaterThan(0);
    const body = JSON.parse(calls[0]!) as { max_tokens?: number };
    expect(body.max_tokens).toBe(500);
  });

  it('设置值大于任务默认 → 仍取 min，保持任务默认 3000', async () => {
    const profile = textProfile(5000);
    const { calls, fetchImpl } = captureBody();
    await generateStory(sampleProject, {
      profile,
      apiKey: 'sk-test',
      model: 'model-a',
      maxAttempts: 1,
      fetchImpl,
    });
    const body = JSON.parse(calls[0]!) as { max_tokens?: number };
    expect(body.max_tokens).toBe(3000);
  });

  it('未设置 → 与旧行为一致（任务默认 3000）', async () => {
    const profile = textProfile(undefined);
    const { calls, fetchImpl } = captureBody();
    await generateStory(sampleProject, {
      profile,
      apiKey: 'sk-test',
      model: 'model-a',
      maxAttempts: 1,
      fetchImpl,
    });
    const body = JSON.parse(calls[0]!) as { max_tokens?: number };
    expect(body.max_tokens).toBe(3000);
  });
});

describe('空 choices / 空 content', () => {
  it('200 + choices:[] → 失败并给人话', async () => {
    const cfg = add();
    const result = await checkCustomModel(cfg, 'sk-test', {
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('内容为空');
  });

  it('200 + 空 content → 失败；合法 content → 成功', async () => {
    const cfg = add();
    const empty = await checkCustomModel(cfg, 'sk-test', {
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), {
          status: 200,
        }),
    });
    expect(empty.ok).toBe(false);
    expect(empty.status).toBe('unknown');

    const ok = await checkCustomModel(cfg, 'sk-test', {
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
          status: 200,
        }),
    });
    expect(ok.ok).toBe(true);
  });

  it('200 + content 是空数组 → 失败', async () => {
    const cfg = add();
    const result = await checkCustomModel(cfg, 'sk-test', {
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: [] } }] }), {
          status: 200,
        }),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('为空');
  });

  it('200 但 choices 里没有 message → 失败；200 非 JSON → 失败', async () => {
    const cfg = add();
    const noMessage = await checkCustomModel(cfg, 'sk-test', {
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{}] }), { status: 200 }),
    });
    expect(noMessage.ok).toBe(false);
    expect(noMessage.status).toBe('unknown');

    const notJson = await checkCustomModel(cfg, 'sk-test', {
      fetchImpl: async () => new Response('not-json', { status: 200 }),
    });
    expect(notJson.ok).toBe(false);
    expect(notJson.status).toBe('unknown');
  });
});

describe('update modality 后默认回退', () => {
  it('text 改 image：默认 LLM 回退内置，自定义档案 id 变化', () => {
    const cfg = add();
    const oldId = `custom:text:${cfg.id}`;
    useSettings.getState().setPref('defaultLlmProfileId', oldId);

    const result = useSettings.getState().updateCustomModel(
      cfg.id,
      draft({ modality: 'image', protocol: 'openai-images', name: '改成图片' }),
    );
    expect(result.ok).toBe(true);
    expect(useSettings.getState().prefs.defaultLlmProfileId).toBe(DEFAULT_LLM_PROFILE_ID);
    expect(useSettings.getState().customModels[0]!.modality).toBe('image');
    expect(`custom:image:${cfg.id}`).not.toBe(oldId);
  });

  it('image 改 text：图片默认回退内置', () => {
    const cfg = add({ modality: 'image', protocol: 'openai-images', name: '图片' });
    const oldId = `custom:image:${cfg.id}`;
    useSettings.getState().setPref('defaultT2iProfileId', oldId);
    useSettings.getState().setPref('defaultReferenceProfileId', oldId);

    const result = useSettings.getState().updateCustomModel(cfg.id, draft({ name: '改成文字' }));
    expect(result.ok).toBe(true);
    expect(useSettings.getState().prefs.defaultT2iProfileId).toBe(DEFAULT_T2I_PROFILE_ID);
    expect(useSettings.getState().prefs.defaultReferenceProfileId).toBe(DEFAULT_REFERENCE_PROFILE_ID);
  });

  it('同 modality 改协议：默认 id 仍有效，不回退', () => {
    const cfg = add({ modality: 'image', protocol: 'openai-images', name: '图片' });
    const profileId = `custom:image:${cfg.id}`;
    useSettings.getState().setPref('defaultT2iProfileId', profileId);
    useSettings.getState().setPref('defaultReferenceProfileId', profileId);

    const result = useSettings.getState().updateCustomModel(
      cfg.id,
      draft({
        modality: 'image',
        protocol: 'vllm-omni-chat-image',
        name: '图片',
        baseUrl: 'http://127.0.0.1:8099/v1',
        model: 'flux-3-image-klein',
      }),
    );
    expect(result.ok).toBe(true);
    expect(useSettings.getState().prefs.defaultT2iProfileId).toBe(profileId);
    expect(useSettings.getState().prefs.defaultReferenceProfileId).toBe(profileId);
  });

  it('删除成功返回 ok:true，并清掉 Key', () => {
    const cfg = add();
    useSettings.getState().setCustomModelKey(cfg.id, 'sk-test');
    const result = useSettings.getState().removeCustomModel(cfg.id);
    expect(result.ok).toBe(true);
    expect(useSettings.getState().customModels).toHaveLength(0);
    expect(useSettings.getState().getCustomModelKey(cfg.id)).toBe('');
  });
});

describe('localStorage 写失败返回失败状态', () => {
  it('add / update / remove / setCustomModelKey 写盘失败都不静默成功', () => {
    const cfg = add();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    const added = useSettings.getState().addCustomModel(draft({ name: '新配置' }));
    expect(added.ok).toBe(false);
    expect(added.message).toContain('保存');
    expect(useSettings.getState().customModels).toHaveLength(1);

    const updated = useSettings.getState().updateCustomModel(cfg.id, draft({ name: '改名' }));
    expect(updated.ok).toBe(false);
    expect(useSettings.getState().customModels[0]!.name).toBe(cfg.name);

    const removed = useSettings.getState().removeCustomModel(cfg.id);
    expect(removed.ok).toBe(false);
    expect(useSettings.getState().customModels).toHaveLength(1);

    const keyResult = useSettings.getState().setCustomModelKey(cfg.id, 'sk-test');
    expect(keyResult.ok).toBe(false);
    expect(useSettings.getState().getCustomModelKey(cfg.id)).toBe('');
  });
});
