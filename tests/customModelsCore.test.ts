// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_MODELS_STORAGE_KEY,
  cleanBaseUrl,
  countCustomModels,
  customModelToProfile,
  customModelsUrl,
  customProfileId,
  customVendorId,
  joinEndpoint,
  readCustomModelConfigs,
  validateCustomModel,
} from '../src/data/customModels';
import {
  DEFAULT_LLM_PROFILE_ID,
  MAX_CUSTOM_MODELS_PER_MODALITY,
  type CustomModelConfig,
  type CustomModelDraft,
} from '../src/types/customModel';
import {
  DEFAULT_REFERENCE_PROFILE_ID,
  DEFAULT_T2I_PROFILE_ID,
  MODEL_PROFILES,
  findProfile,
  resolveAllProfiles,
} from '../src/data/models/profiles';
import { useSettings } from '../src/store/settings';
import { checkCustomModel } from '../src/services/customModels/check';

/**
 * 自定义接入核心层（v0.63）
 *
 * 覆盖：校验 / 存储与 Key / 上限 / 删除清 Key 与默认回退 / 动态档案映射 /
 * 内置解析兼容 / 测试连接。全部用 mock，不联网。
 */

function draft(overrides: Partial<CustomModelDraft> = {}): CustomModelDraft {
  return {
    name: '我的 OpenAI',
    modality: 'text',
    protocol: 'openai-chat',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-test',
    requiresKey: true,
    ...overrides,
  };
}

function addModel(overrides: Partial<CustomModelDraft> = {}): CustomModelConfig {
  const result = useSettings.getState().addCustomModel(draft(overrides));
  if (!result.ok || !result.config) throw new Error(JSON.stringify(result.errors));
  return result.config;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  const prefs = {
    ...useSettings.getState().prefs,
    defaultLlmProfileId: DEFAULT_LLM_PROFILE_ID,
    defaultT2iProfileId: DEFAULT_T2I_PROFILE_ID,
    defaultReferenceProfileId: DEFAULT_REFERENCE_PROFILE_ID,
    localModelEndpoint: '',
    localModelTimeoutMs: undefined,
  };
  useSettings.setState({ customModels: [], prefs, keys: {}, modelOverrides: {} });
});

describe('校验纯函数', () => {
  it('合法文字配置通过，并规范化尾斜杠/requiresKey 默认值', () => {
    const result = validateCustomModel(draft({ baseUrl: 'https://api.example.com/v1/', requiresKey: undefined }));
    expect(result.ok).toBe(true);
    expect(result.normalized?.baseUrl).toBe('https://api.example.com/v1');
    expect(result.normalized?.requiresKey).toBe(true);
  });

  it('http/https、内嵌凭据、模型名、名称、协议/模态匹配都会被拦', () => {
    expect(validateCustomModel(draft({ baseUrl: 'ftp://x.example' })).errors.baseUrl).toContain('http');
    expect(
      validateCustomModel(draft({ baseUrl: 'https://user:pass@api.example.com/v1' })).errors.baseUrl,
    ).toContain('用户名');
    expect(validateCustomModel(draft({ model: '   ' })).errors.model).toBeTruthy();
    expect(validateCustomModel(draft({ name: '' })).errors.name).toBeTruthy();
    expect(
      validateCustomModel(draft({ modality: 'image', protocol: 'openai-chat' })).errors.protocol,
    ).toContain('不匹配');
  });

  it('requiresKey=true 但没填 Key 不影响保存校验（只影响 readiness）', () => {
    expect(validateCustomModel(draft({ requiresKey: true })).ok).toBe(true);
  });

  it('能力字段非法会报错；不确定的参考图默认 0', () => {
    expect(
      validateCustomModel(draft({ modality: 'image', protocol: 'openai-images', capabilities: { maxReferenceImages: -1 } }))
        .errors.capabilities,
    ).toContain('非负');
    expect(
      validateCustomModel(draft({ modality: 'image', protocol: 'openai-images', capabilities: { maxOutputImages: 0 } }))
        .errors.capabilities,
    ).toContain('≥1');
    const profile = customModelToProfile({
      ...(addModel({ modality: 'image', protocol: 'openai-images' }) as CustomModelConfig),
    });
    expect(profile.capabilities.maxReferenceImages).toBe(0);
  });
});

describe('存储/CRUD/上限/Key', () => {
  it('新增写 localStorage，配置里不含 Key；删除清 Key', () => {
    const config = addModel();
    const stored = readCustomModelConfigs();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(config.id);
    expect(JSON.stringify(stored)).not.toContain('sk-test');

    useSettings.getState().setCustomModelKey(config.id, 'sk-test');
    expect(useSettings.getState().getCustomModelKey(config.id)).toBe('sk-test');
    useSettings.getState().removeCustomModel(config.id);
    expect(useSettings.getState().getCustomModelKey(config.id)).toBe('');
    expect(readCustomModelConfigs()).toHaveLength(0);
  });

  it('update 修改并持久化，id/createdAt 不变', () => {
    const config = addModel();
    const updated = useSettings.getState().updateCustomModel(
      config.id,
      draft({ name: '改名后的服务', model: 'model-v2' }),
    );
    expect(updated.ok).toBe(true);
    const stored = readCustomModelConfigs();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(config.id);
    expect(stored[0]!.createdAt).toBe(config.createdAt);
    expect(stored[0]!.name).toBe('改名后的服务');
    expect(stored[0]!.model).toBe('model-v2');
    expect(findProfile(customProfileId('text', config.id))?.model).toBe('model-v2');
  });

  it('dontSaveKeys=true 时 Key 只进 sessionStorage，不落 localStorage', () => {
    const config = addModel();
    useSettings.getState().setPref('dontSaveKeys', true);
    useSettings.getState().setCustomModelKey(config.id, 'sk-session');
    expect(localStorage.getItem('aniguide:keys') ?? '').not.toContain('sk-session');
    expect(sessionStorage.getItem('aniguide:keys:session') ?? '').toContain('sk-session');
    expect(useSettings.getState().getCustomModelKey(config.id)).toBe('sk-session');
  });

  it(`每模态最多 ${MAX_CUSTOM_MODELS_PER_MODALITY} 条`, () => {
    for (let i = 0; i < MAX_CUSTOM_MODELS_PER_MODALITY; i += 1) {
      addModel({ name: `text-${i}` });
    }
    expect(countCustomModels(useSettings.getState().customModels, 'text')).toBe(10);
    const extra = useSettings.getState().addCustomModel(draft({ name: 'text-extra' }));
    expect(extra.ok).toBe(false);
    expect(extra.errors?.modality).toContain('最多');
    // 其它模态不受影响
    expect(useSettings.getState().addCustomModel(draft({ name: 'img', modality: 'image', protocol: 'openai-images' })).ok).toBe(true);
  });

  it('删除默认自定义档案会回退到内置默认', () => {
    const text = addModel();
    const image = addModel({ name: 'img', modality: 'image', protocol: 'openai-images' });
    const textProfileId = customProfileId('text', text.id);
    const imageProfileId = customProfileId('image', image.id);
    useSettings.getState().setPref('defaultLlmProfileId', textProfileId);
    useSettings.getState().setPref('defaultT2iProfileId', imageProfileId);
    useSettings.getState().setPref('defaultReferenceProfileId', imageProfileId);

    useSettings.getState().removeCustomModel(text.id);
    useSettings.getState().removeCustomModel(image.id);

    const prefs = useSettings.getState().prefs;
    expect(prefs.defaultLlmProfileId).toBe(DEFAULT_LLM_PROFILE_ID);
    expect(prefs.defaultT2iProfileId).toBe(DEFAULT_T2I_PROFILE_ID);
    expect(prefs.defaultReferenceProfileId).toBe(DEFAULT_REFERENCE_PROFILE_ID);
  });

  it('损坏 JSON 被丢弃，不影响启动', () => {
    localStorage.setItem(CUSTOM_MODELS_STORAGE_KEY, '{not json');
    expect(readCustomModelConfigs()).toEqual([]);
  });
});

describe('动态档案映射 + 内置解析兼容', () => {
  it('image openai-images：endpoint/payload/能力映射正确', () => {
    const config = addModel({
      name: 'img',
      modality: 'image',
      protocol: 'openai-images',
      capabilities: { maxReferenceImages: 3, negativePrompt: true, seed: true, maxOutputImages: 2 },
    });
    const profile = customModelToProfile(config);
    expect(profile.id).toBe(`custom:image:${config.id}`);
    expect(profile.vendorId).toBe(customVendorId(config.id));
    expect(profile.type).toBe('t2i');
    expect(profile.apiFlavor).toBe('openai');
    expect(profile.endpoint).toBe('https://api.example.com/v1/images/generations');
    expect(profile.imagePayload).toMatchObject({
      promptField: 'prompt',
      sizeField: 'size',
      countField: 'n',
      negativePromptField: 'negative_prompt',
      referenceField: 'image',
    });
    expect(profile.capabilities.maxReferenceImages).toBe(3);
    expect(profile.capabilities.reference?.maxImages).toBe(3);
    expect(profile.capabilities.reference?.semantics).toBe('reference');
    expect(profile.capabilities.maxOutputImages).toBe(2);
    expect(profile.timeoutMs).toBeUndefined();
  });

  it('image vllm-omni-chat-image：endpoint/chat flavor/参考图 declared', () => {
    const config = addModel({
      name: 'local',
      modality: 'image',
      protocol: 'vllm-omni-chat-image',
      baseUrl: 'http://127.0.0.1:8099/v1',
      model: 'flux-3-image-klein',
      requiresKey: false,
      capabilities: { maxReferenceImages: 10 },
    });
    const profile = customModelToProfile(config);
    expect(profile.apiFlavor).toBe('chat-completions-image');
    expect(profile.endpoint).toBe('http://127.0.0.1:8099/v1/chat/completions');
    expect(profile.authType).toBe('none');
    expect(profile.capabilities.maxReferenceImages).toBe(10);
    expect(profile.capabilities.reference?.aspectFollows).toBe('param');
  });

  it('text / video 的 type/apiFlavor；video 不参与生成', () => {
    const text = customModelToProfile(addModel());
    expect(text.type).toBe('llm');
    expect(text.endpoint).toBe('https://api.example.com/v1/chat/completions');
    expect(text.apiFlavor).toBe('openai');
    const video = customModelToProfile(
      addModel({ name: 'v', modality: 'video', protocol: 'openai-videos', model: 'v-model' }),
    );
    expect(video.type).toBe('i2v');
    expect(video.apiFlavor).toBe('openai');
    expect(video.capabilities.referenceImage).toBe(false);
  });

  it('findProfile 同时解析内置与自定义；内置长度/内容不变', () => {
    const before = MODEL_PROFILES.length;
    const config = addModel();
    const profileId = customProfileId('text', config.id);
    expect(findProfile(profileId)?.id).toBe(profileId);
    expect(findProfile('qwen-image')?.id).toBe('qwen-image');
    expect(MODEL_PROFILES.length).toBe(before);
    expect(resolveAllProfiles().some((profile) => profile.id === profileId)).toBe(true);
  });

  it('joinEndpoint/customModelsUrl 的基本拼接', () => {
    expect(cleanBaseUrl(' https://x.example/v1/// ')).toBe('https://x.example/v1');
    expect(joinEndpoint('https://x.example/v1', 'chat/completions')).toBe(
      'https://x.example/v1/chat/completions',
    );
    expect(joinEndpoint('https://x.example/v1/chat/completions', 'chat/completions')).toBe(
      'https://x.example/v1/chat/completions',
    );
    expect(customModelsUrl('https://x.example/v1')).toBe('https://x.example/v1/models');
  });
});

describe('checkCustomModel', () => {
  function configFor(overrides: Partial<CustomModelDraft> = {}): CustomModelConfig {
    return addModel(overrides);
  }

  it('text 成功：最小 chat 请求、带 Key，结果不打印 Key', async () => {
    const config = configFor();
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await checkCustomModel(config, 'sk-test', { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ready');
    expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions');
    expect(capturedHeaders.Authorization).toBe('Bearer sk-test');
    expect(JSON.stringify(result)).not.toContain('sk-test');
  });

  it('text 401 → unauthorized；无 Key → missing-key（不请求）', async () => {
    const config = configFor();
    const unauthorized = await checkCustomModel(config, 'sk-bad', {
      fetchImpl: async () => new Response('bad key', { status: 401 }),
    });
    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.status).toBe('unauthorized');

    const fetchImpl = vi.fn();
    const missing = await checkCustomModel(config, '', { fetchImpl });
    expect(missing.status).toBe('missing-key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('text CORS/网络错误 → cors，不抛异常', async () => {
    const config = configFor();
    const result = await checkCustomModel(config, 'sk-test', {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('cors');
  });

  it('image GET /models：成功/缺模型/404 无法自动检测', async () => {
    const config = configFor({
      name: 'img',
      modality: 'image',
      protocol: 'openai-images',
      model: 'glm-image',
    });
    const ok = await checkCustomModel(config, 'sk-test', {
      fetchImpl: async (input) => {
        expect(String(input)).toBe('https://api.example.com/v1/models');
        return new Response(JSON.stringify({ data: [{ id: 'glm-image' }] }), { status: 200 });
      },
    });
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe('ready');

    const missing = await checkCustomModel(config, 'sk-test', {
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ id: 'other-model' }] }), { status: 200 }),
    });
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe('missing-model');
    expect(missing.message).toContain('other-model');

    const noModels = await checkCustomModel(config, 'sk-test', {
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    expect(noModels.ok).toBe(true);
    expect(noModels.status).toBe('unknown');
    expect(noModels.message).toContain('无法自动检测');
  });

  it('image 本地无 Key 也走 /models 且不带 Authorization；video 返回占位', async () => {
    const config = configFor({
      name: 'local',
      modality: 'image',
      protocol: 'vllm-omni-chat-image',
      baseUrl: 'http://127.0.0.1:8099/v1',
      model: 'flux-3-image-klein',
      requiresKey: false,
    });
    let headers: Record<string, string> = {};
    const result = await checkCustomModel(config, '', {
      fetchImpl: async (_input, init) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ data: [{ id: 'flux-3-image-klein' }] }), { status: 200 });
      },
    });
    expect(result.ok).toBe(true);
    expect(headers.Authorization).toBeUndefined();

    const video = await checkCustomModel(
      configFor({ name: 'v', modality: 'video', protocol: 'openai-videos' }),
      'sk-test',
    );
    expect(video.ok).toBe(false);
    expect(video.status).toBe('not-implemented');
    expect(video.message).toContain('下一批');
  });
});
