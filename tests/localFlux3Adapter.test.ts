import { describe, expect, it, vi } from 'vitest';
import type { ModelProfile } from '../src/types/model';
import type { ImageGenerationRequest } from '../src/services/gateway/types';
import {
  ALL_MODEL_PROFILES,
  LOCAL_MODEL_PROFILES,
  MODEL_PROFILES,
  findProfile,
} from '../src/data/models/profiles';
import {
  buildHeaders,
  buildImagePayloadFor,
  extractChatCompletionsImageUrls,
} from '../src/services/gateway';
import {
  executeImageGeneration,
  getImageAdapter,
} from '../src/services/gateway/imageAdapters';
import {
  applyLocalProfileOverrides,
  DEFAULT_LOCAL_MODEL_ENDPOINT,
  localModelsUrl,
  normalizeLocalEndpoint,
  probeLocalModel,
} from '../src/services/gateway/localModel';
import { checkLocalModel } from '../src/store/settings';
import { referenceCapabilityOf } from '../src/domain/image/delivery';

/**
 * v0.61 本地 FLUX3 适配器 / 统一接口
 *
 * 这组测试不启动真实模型：用 mock fetch 验证「发出去的请求形状」与
 * 「回来的响应怎么解析」。真实 GPU 冒烟在 Agent 环境跑不了。
 */

const local = findProfile('local-flux3')!;

const refA = 'data:image/png;base64,AAAA';
const refB = 'data:image/jpeg;base64,BBBB';

function request(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    prompt: 'put the character into the scene',
    aspectRatio: '9:16',
    count: 1,
    seed: 42,
    referenceImages: [refA, refB],
    ...overrides,
  };
}

describe('本地 FLUX3 档案', () => {
  it('**是内置本地档案**：不在云端 MODEL_PROFILES 里，但 findProfile 能查到', () => {
    expect(MODEL_PROFILES.some((p) => p.id === 'local-flux3')).toBe(false);
    expect(LOCAL_MODEL_PROFILES.some((p) => p.id === 'local-flux3')).toBe(true);
    expect(ALL_MODEL_PROFILES.some((p) => p.id === 'local-flux3')).toBe(true);
    expect(local).toBeDefined();
    expect(local.type).toBe('t2i');
    expect(local.endpoint).toBe(DEFAULT_LOCAL_MODEL_ENDPOINT);
    expect(local.authType).toBe('none');
    expect(local.apiFlavor).toBe('chat-completions-image');
    expect(local.model).toBe('flux-3-image-klein');
    expect(local.timeoutMs).toBe(600_000);
  });

  it('**能力声明 10 张参考图、declared reference、单图输出**', () => {
    expect(local.capabilities.referenceImage).toBe(true);
    expect(local.capabilities.maxReferenceImages).toBe(10);
    expect(local.capabilities.maxOutputImages).toBe(1);
    expect(local.capabilities.reference).toEqual({
      semantics: 'reference',
      maxImages: 10,
      acceptsDataUri: true,
      aspectFollows: 'param',
    });
    expect(local.corsDirect).toBe('unknown');
    expect(local.notes).toMatch(/未能核实|未实测/);
    // 投递层读到的也必须是「10 张、declared、可 data URI」
    const context = referenceCapabilityOf(local.capabilities);
    expect(context.source).toBe('declared');
    expect(context.capability.maxImages).toBe(10);
    expect(context.capability.acceptsDataUri).toBe(true);
    expect(context.capability.aspectFollows).toBe('param');
  });

  it('**无鉴权档案不发任何 Key 头**', () => {
    const headers = buildHeaders(local, '');
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
    expect(headers.Authorization).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();
  });
});

describe('本地适配器：请求体形状', () => {
  it('**messages content = text + 按顺序的 image_url**，extra_body 有 size/seed', () => {
    const adapter = getImageAdapter(local);
    const prepared = adapter.buildRequest(local, request());
    expect(prepared.url).toBe('http://127.0.0.1:8099/v1/chat/completions');

    const body = prepared.body as {
      model: string;
      messages: { role: string; content: { type: string; text?: string; image_url?: { url: string } }[] }[];
      extra_body?: { size?: string; seed?: number };
    };
    expect(body.model).toBe('flux-3-image-klein');
    expect(body.messages[0]!.role).toBe('user');
    expect(body.messages[0]!.content.map((item) => item.type)).toEqual([
      'text',
      'image_url',
      'image_url',
    ]);
    expect(body.messages[0]!.content[0]!.text).toBe('put the character into the scene');
    expect(body.messages[0]!.content[1]!.image_url!.url).toBe(refA);
    expect(body.messages[0]!.content[2]!.image_url!.url).toBe(refB);
    // 9:16 换算成 720x1280；seed 透传
    expect(body.extra_body).toEqual({ size: '720x1280', seed: 42 });
  });

  it('**没有 guidance_scale / negative_prompt**（FLUX3 蒸馏包不要）', () => {
    const prepared = getImageAdapter(local).buildRequest(local, request({ negativePrompt: 'ugly' }));
    const json = JSON.stringify(prepared.body);
    expect(json).not.toContain('guidance');
    expect(json).not.toContain('negative');
  });

  it('可显式传 size；无参考图时 content 只有 text', () => {
    const prepared = getImageAdapter(local).buildRequest(
      local,
      request({ aspectRatio: undefined, size: '1024x1024', referenceImages: [] }),
    );
    const body = prepared.body as {
      messages: { content: { type: string }[] }[];
      extra_body?: { size?: string };
    };
    expect(body.messages[0]!.content).toHaveLength(1);
    expect(body.messages[0]!.content[0]!.type).toBe('text');
    expect(body.extra_body).toEqual({ size: '1024x1024', seed: 42 });
  });
});

describe('本地适配器：响应解析', () => {
  it('解析多个 image_url，保持顺序', () => {
    const response = {
      choices: [
        {
          message: {
            content: [
              { type: 'image_url', image_url: { url: refA } },
              { type: 'image_url', image_url: { url: refB } },
            ],
          },
        },
      ],
    };
    const refs = getImageAdapter(local).parseResponse(local, response);
    expect(refs).toEqual([refA, refB]);
  });

  it('兼容 content 是字符串 / data URI', () => {
    const response = {
      choices: [{ message: { content: refA } }],
    };
    expect(getImageAdapter(local).parseResponse(local, response)).toEqual([refA]);
  });

  it('**b64_json fallback**：顶层 data[].b64_json 补成 data URI', () => {
    const b64 = 'A'.repeat(80);
    const refs = extractChatCompletionsImageUrls({ data: [{ b64_json: b64 }] });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.startsWith('data:image/png;base64,')).toBe(true);
    expect(refs[0]!.endsWith(b64)).toBe(true);
  });

  it('异常 JSON / 空响应 → 空数组，不抛异常', () => {
    expect(extractChatCompletionsImageUrls(null)).toEqual([]);
    expect(extractChatCompletionsImageUrls({ choices: [{ message: { content: 'not json at all' } }] })).toEqual([]);
    expect(extractChatCompletionsImageUrls({ choices: [] })).toEqual([]);
  });
});

describe('执行器：mock fetch 端到端', () => {
  it('发出正确 URL/body/无 auth，归一化 data URI 图片', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: [{ type: 'image_url', image_url: { url: refA } }] } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const executed = await executeImageGeneration({
      profile: local,
      apiKey: '',
      request: request(),
      fetchImpl,
    });

    expect(executed.images.map((image) => image.dataUrl)).toEqual([refA]);
    expect(executed.imageRefs).toEqual([refA]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8099/v1/chat/completions');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(calls[0]!.init!.body)) as {
      messages: { content: { type: string }[] }[];
    };
    expect(body.messages[0]!.content[0]!.type).toBe('text');
  });

  it('**超时** → GatewayError(kind=timeout)', async () => {
    const hangingFetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    await expect(
      executeImageGeneration({
        profile: local,
        apiKey: '',
        request: request({ timeoutMs: 5 }),
        fetchImpl: hangingFetch,
      }),
    ).rejects.toMatchObject({ info: { kind: 'timeout' } });
  });

  it('**调用方取消** → 请求被 abort（不是挂死）', async () => {
    const controller = new AbortController();
    const abortFetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    controller.abort();
    await expect(
      executeImageGeneration({
        profile: local,
        apiKey: '',
        request: request(),
        fetchImpl: abortFetch,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('错误规范化：普通异常返回 message，AbortError 说取消/超时', () => {
    const adapter = getImageAdapter(local);
    expect(adapter.normalizeError(new Error('boom'))).toBe('boom');
    expect(adapter.normalizeError(new DOMException('Aborted', 'AbortError'))).toContain('取消');
  });
});

describe('端点覆盖 / 测试连接', () => {
  it('规范化端点与 /v1/models URL', () => {
    expect(normalizeLocalEndpoint(' http://127.0.0.1:9999/v1/ ')).toBe('http://127.0.0.1:9999/v1');
    expect(normalizeLocalEndpoint('http://127.0.0.1:9999/v1/chat/completions')).toBe(
      'http://127.0.0.1:9999/v1',
    );
    expect(localModelsUrl('http://127.0.0.1:9999/v1')).toBe(
      'http://127.0.0.1:9999/v1/models',
    );
    expect(localModelsUrl('http://127.0.0.1:9999')).toBe(
      'http://127.0.0.1:9999/v1/models',
    );
  });

  it('端点/超时覆盖不修改内置档案对象', () => {
    const original: ModelProfile = local;
    const merged = applyLocalProfileOverrides(original, {
      endpoint: 'http://127.0.0.1:9999/v1',
      timeoutMs: 123_456,
    });
    expect(merged.endpoint).toBe('http://127.0.0.1:9999/v1');
    expect(merged.timeoutMs).toBe(123_456);
    expect(original.endpoint).toBe(DEFAULT_LOCAL_MODEL_ENDPOINT);
    expect(original.timeoutMs).toBe(600_000);
  });

  it('checkLocalModel 走 GET /v1/models 并读出 flux 模型', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'flux-3-image-klein' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await checkLocalModel({
      endpoint: 'http://127.0.0.1:9999/v1',
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('flux-3-image-klein');
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(
      'http://127.0.0.1:9999/v1/models',
    );
  });

  it('**HTTP 200 但不是合法 JSON → ok:false**（不再误报可用）', async () => {
    const result = await probeLocalModel('http://127.0.0.1:9999/v1', {
      fetchImpl: async () => new Response('<html>not json</html>', { status: 200 }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('无法识别');
    expect(result.message).not.toContain('可用');
  });

  it('**HTTP 200 但 data 为空 → ok:false**（服务在但没加载模型）', async () => {
    const result = await probeLocalModel('http://127.0.0.1:9999/v1', {
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('还没有加载模型');
  });

  it('**HTTP 200 有 data 但没有 flux → ok:false，并带实际模型列表**', async () => {
    const result = await probeLocalModel('http://127.0.0.1:9999/v1', {
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ id: 'other-model' }, { id: 'another' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('没有 flux-3-image-klein');
    expect(result.message).toContain('other-model');
    expect(result.models).toEqual(['other-model', 'another']);
  });

  it('expectedModel 可覆盖默认检查的模型名', async () => {
    const result = await probeLocalModel('http://127.0.0.1:9999/v1', {
      expectedModel: 'my-model',
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ id: 'my-model' }] }), { status: 200 }),
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('my-model');
  });

  it('本地服务 500 / 连不上 → 返回人话，不抛异常', async () => {
    const httpError = await probeLocalModel('http://127.0.0.1:9999/v1', {
      fetchImpl: async () => new Response('bad gateway', { status: 500 }),
    });
    expect(httpError.ok).toBe(false);
    expect(httpError.message).toContain('HTTP 500');

    const network = await probeLocalModel('http://127.0.0.1:9999/v1', {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(network.ok).toBe(false);
    expect(network.message).toContain('连不上本地服务');
  });
});

describe('现有 OpenAI/DashScope 适配器：载荷仍走旧函数', () => {
  it('dashscope-sync 档案的 buildRequest 与 buildImagePayloadFor 字节一致', () => {
    const cloud = findProfile('qwen-image-edit')!;
    const prepared = getImageAdapter(cloud).buildRequest(cloud, request({ referenceImages: [refA] }));
    expect(prepared.url).toBe(cloud.endpoint);
    expect(prepared.body).toEqual(
      buildImagePayloadFor(cloud, {
        model: cloud.model ?? cloud.name,
        prompt: 'put the character into the scene',
        aspectRatio: '9:16',
        batchSize: 1,
        seed: 42,
        referenceImages: [refA],
      }),
    );
  });

  it('openai 档案的 buildRequest 与 buildImagePayloadFor 字节一致', () => {
    const cloud = findProfile('qwen-image')!;
    const adapter = getImageAdapter(cloud);
    const prepared = adapter.buildRequest(cloud, request({ referenceImages: [] }));
    expect(prepared.url).toBe(cloud.endpoint);
    expect(prepared.body).toEqual(
      buildImagePayloadFor(cloud, {
        model: cloud.model ?? cloud.name,
        prompt: 'put the character into the scene',
        aspectRatio: '9:16',
        batchSize: 1,
        seed: 42,
      }),
    );
  });
});
