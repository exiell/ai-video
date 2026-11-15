import { describe, expect, it, vi } from 'vitest';
import type { ModelProfile } from '../src/types/model';
import { MODEL_PROFILES, findProfile } from '../src/data/models/profiles';
import {
  buildHeaders,
  buildImagePayloadFor,
  extractImageUrlsFor,
  type ImageRequestOptions,
} from '../src/services/gateway';
import { executeImageGeneration, getImageAdapter } from '../src/services/gateway/imageAdapters';
import type { ImageGenerationRequest } from '../src/services/gateway/types';
import { generateImages } from '../src/services/image/generate';
import { withReferenceInstruction } from '../src/services/gateway/dashscope';

/**
 * 第二批：7 个云端图片档案迁到统一接口后的等价性证据（v0.62）
 *
 * 旧函数（buildImagePayloadFor / extractImageUrlsFor / prefetchImage）继续保留，
 * 在本文件里充当 oracle；新路径必须逐字段一致，旧测试本身一行不改。
 */

/** 1x1 透明 PNG（magic 合法，用来测 data[].b64_json 的正向差异） */
const VALID_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const CLOUD_IMAGE_IDS = [
  'zhipu-image',
  'minimax-image',
  'siliconflow-image',
  'qwen-image',
  'qwen-image-fast',
  'qwen-image-2.1',
  'qwen-image-edit',
] as const;

function profileOf(id: string): ModelProfile {
  const profile = findProfile(id);
  if (!profile) throw new Error(`missing profile ${id}`);
  return profile;
}

/** 把统一请求翻译成旧 buildImagePayloadFor 的参数（与旧 generate 的字段完全一致） */
function oldOptions(profile: ModelProfile, req: ImageGenerationRequest): ImageRequestOptions {
  return {
    model: profile.model ?? profile.name,
    prompt: req.prompt,
    ...(req.negativePrompt !== undefined ? { negativePrompt: req.negativePrompt } : {}),
    ...(req.aspectRatio !== undefined ? { aspectRatio: req.aspectRatio } : {}),
    ...(req.count !== undefined
      ? { batchSize: Math.min(req.count, profile.capabilities.maxOutputImages || 1) }
      : {}),
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
    ...(req.referenceImages.length > 0 ? { referenceImages: req.referenceImages } : {}),
  };
}

function normalizedRequest(profile: ModelProfile, request: ImageGenerationRequest): ImageGenerationRequest {
  return {
    ...request,
    ...(request.count !== undefined
      ? { count: Math.min(request.count, profile.capabilities.maxOutputImages || 1) }
      : {}),
  };
}

/** 旧 generate 会先 withReferenceInstruction，再拼载荷；这里是同一个 oracle */
function effectivePrompt(request: ImageGenerationRequest): string {
  if (request.referenceImages.length === 0) return request.prompt;
  return withReferenceInstruction(request.prompt, {
    referenceCount: request.referenceImages.length,
    hasFirstFrameAnchor: false,
    hasPreviousEndAnchor: false,
  });
}

function refsFor(profile: ModelProfile, count = 2): string[] {
  const max = profile.capabilities.referenceImage ? profile.capabilities.maxReferenceImages : 0;
  return Array.from({ length: Math.min(count, max) }, (_, i) => `data:image/png;base64,R${i}`);
}

describe('7 个云端图片档案 · 迁移清单', () => {
  it('**7 个档案都在统一适配器覆盖范围内**，没有 dashscope-async 图片档案', () => {
    expect(CLOUD_IMAGE_IDS.map((id) => profileOf(id).id)).toEqual([...CLOUD_IMAGE_IDS]);
    for (const id of CLOUD_IMAGE_IDS) {
      const profile = profileOf(id);
      expect(getImageAdapter(profile).apiFlavor).toBe(profile.apiFlavor ?? 'openai');
    }
    const asyncImages = MODEL_PROFILES.filter(
      (p) => p.type === 't2i' && p.apiFlavor === 'dashscope-async',
    );
    expect(asyncImages).toHaveLength(0); // 异步适配器是占位，当前无档案使用
  });
});

describe('请求体等价：新适配器 vs 旧 buildImagePayloadFor', () => {
  const scenarios: { name: string; req: (profile: ModelProfile) => ImageGenerationRequest }[] = [
    {
      name: '纯 prompt',
      req: () => ({ prompt: 'a red circle', referenceImages: [] }),
    },
    {
      name: '比例 + 张数 + seed',
      req: () => ({
        prompt: 'a red circle',
        aspectRatio: '16:9',
        count: 2,
        seed: 7,
        referenceImages: [],
      }),
    },
    {
      name: '负向词 + 有序参考图',
      req: (profile) => ({
        prompt: 'a red circle',
        negativePrompt: 'ugly, blurry',
        referenceImages: refsFor(profile, 2),
      }),
    },
  ];

  for (const id of CLOUD_IMAGE_IDS) {
    for (const scenario of scenarios) {
      it(`${id} · ${scenario.name}`, () => {
        const profile = profileOf(id);
        const request = normalizedRequest(profile, scenario.req(profile));
        const built = getImageAdapter(profile).buildRequest(profile, request);
        expect(built.url).toBe(profile.endpoint);
        expect(built.body).toEqual(buildImagePayloadFor(profile, oldOptions(profile, request)));
      });
    }
  }
});

describe('响应解析等价：新 parseResponse vs 旧 extractImageUrlsFor', () => {
  const fixtures: Record<string, unknown> = {
    'zhipu-image': { data: [{ url: 'https://x/z.png' }] },
    'minimax-image': { data: { image_urls: ['https://x/m1.png', 'https://x/m2.png'] } },
    'siliconflow-image': { data: [{ url: 'https://x/s.png' }] },
    'qwen-image': {
      output: { choices: [{ message: { content: [{ image: 'https://x/q.png' }] } }] },
    },
    'qwen-image-fast': {
      output: { choices: [{ message: { content: [{ image: 'https://x/qf.png' }] } }] },
    },
    'qwen-image-2.1': {
      output: { choices: [{ message: { content: [{ image: 'https://x/q21.png' }] } }] },
    },
    'qwen-image-edit': {
      output: { choices: [{ message: { content: [{ image: 'https://x/qe.png' }] } }] },
    },
  };

  for (const id of CLOUD_IMAGE_IDS) {
    it(`${id} · 旧/新解析结果一致`, () => {
      const profile = profileOf(id);
      const fixture = fixtures[id];
      expect(getImageAdapter(profile).parseResponse(profile, fixture)).toEqual(
        extractImageUrlsFor(profile, fixture),
      );
    });
  }

  it('空响应 / 非图片结构 → 两者都为空', () => {
    for (const id of CLOUD_IMAGE_IDS) {
      const profile = profileOf(id);
      expect(getImageAdapter(profile).parseResponse(profile, {})).toEqual(
        extractImageUrlsFor(profile, {}),
      );
      expect(getImageAdapter(profile).parseResponse(profile, { foo: 'bar' })).toEqual(
        extractImageUrlsFor(profile, { foo: 'bar' }),
      );
    }
  });

  it('**合法 data[].b64_json**：旧函数只认 url，新适配器能落地（已记录的正向差异）', () => {
    const profile = profileOf('zhipu-image');
    const fixture = { data: [{ b64_json: VALID_PNG_B64 }] };
    expect(extractImageUrlsFor(profile, fixture)).toEqual([]);
    const parsed = getImageAdapter(profile).parseResponse(profile, fixture);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.startsWith('data:image/png;base64,')).toBe(true);

    // 全链路：合法 b64 能成功落地（旧路径会报没有图片地址）
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    return generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'p' },
      fetchImpl,
    }).then((outcome) => {
      expect(outcome.ok).toBe(true);
      expect(outcome.images[0]!.dataUrl!.startsWith('data:image/png;base64,')).toBe(true);
    });
  });

  it('**递归扫描已删除**：error/message/其它字段里的 b64_json 不会触发成功', () => {
    const profile = profileOf('zhipu-image');
    const fixture = {
      error: { b64_json: VALID_PNG_B64 },
      message: { content: { b64_json: VALID_PNG_B64 } },
      echo: [{ b64_json: VALID_PNG_B64 }],
    };
    expect(getImageAdapter(profile).parseResponse(profile, fixture)).toEqual([]);
    expect(extractImageUrlsFor(profile, fixture)).toEqual([]);
  });

  it('**非法 base64 / 非图片字节被忽略**，不产出坏 dataUrl', () => {
    const profile = profileOf('zhipu-image');
    expect(
      getImageAdapter(profile).parseResponse(profile, {
        data: [{ b64_json: '!!!not-base64!!!' }, { b64_json: 'aGVsbG8=' }],
      }),
    ).toEqual([]);
  });

  it('HTTP 200 但只有 error 对象带 b64 → 全链路保持旧错误语义（不成功）', async () => {
    const profile = profileOf('zhipu-image');
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { b64_json: VALID_PNG_B64, message: 'upstream failed' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'p' },
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('没有返回图片地址');
    expect(outcome.images).toEqual([]);
  });

  it('data[].b64 非法时全链路失败，不产出坏图', async () => {
    const profile = profileOf('zhipu-image');
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'p' },
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.images).toEqual([]);
    expect(outcome.error).toContain('没有返回图片地址');
  });

  it('**execution 契约**：URL 响应时 images 为空、imageRefs 有 URL；data URI 响应时 images 有值', async () => {
    const profile = profileOf('zhipu-image');
    const request = { prompt: 'p', referenceImages: [] };

    const urlFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ url: 'https://x/a.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const urlExecution = await executeImageGeneration({
      profile,
      apiKey: 'sk-test',
      request,
      fetchImpl: urlFetch,
    });
    expect(urlExecution.imageRefs).toEqual(['https://x/a.png']);
    expect(urlExecution.images).toEqual([]);

    const dataFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: VALID_PNG_B64 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const dataExecution = await executeImageGeneration({
      profile,
      apiKey: 'sk-test',
      request,
      fetchImpl: dataFetch,
    });
    expect(dataExecution.imageRefs).toHaveLength(1);
    expect(dataExecution.images).toHaveLength(1);
    expect(dataExecution.images[0]!.dataUrl).toBe(dataExecution.imageRefs[0]);
  });
});

function imageResponse(
  profile: ModelProfile,
  url = 'https://oss/a.png',
): Response {
  const body =
    profile.apiFlavor === 'dashscope-sync'
      ? { output: { choices: [{ message: { content: [{ image: url }] } }] } }
      : profile.imagePayload?.responseImageArray
        ? { data: { image_urls: [url] } }
        : { data: [{ url }] };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const fakePrefetch = async (marker: string) => ({
  dataUrl: `data:image/png;base64,${marker}`,
  byteSize: 3,
  mimeType: 'image/png',
});

describe('generateImages 全链路：7 档案请求体等价', () => {
  for (const id of CLOUD_IMAGE_IDS) {
    it(`${id} · 新路径发出的 body 与旧 oracle 一致`, async () => {
      const profile = profileOf(id);
      const request = {
        prompt: 'a red circle',
        negativePrompt: 'ugly',
        aspectRatio: '9:16',
        count: 1,
        seed: 42,
        referenceImages: refsFor(profile, 1),
      };
      let capturedBody = '';
      let capturedHeaders: Record<string, string> = {};
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = String(init?.body);
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return imageResponse(profile);
      });
      const outcome = await generateImages({
        profile,
        apiKey: 'sk-test',
        req: request,
        fetchImpl,
        prefetchImpl: async () => fakePrefetch('a'),
      });
      expect(outcome.ok).toBe(true);
      const expectedRequest = { ...request, prompt: effectivePrompt(request) };
      expect(JSON.parse(capturedBody)).toEqual(
        buildImagePayloadFor(profile, oldOptions(profile, expectedRequest)),
      );
      // URL/鉴权头与旧路径一致（DashScope 同步不发送 X-DashScope-Async）
      expect(capturedHeaders.Authorization).toBe('Bearer sk-test');
      expect(capturedHeaders['Content-Type']).toBe('application/json');
      expect(capturedHeaders['X-DashScope-Async']).toBeUndefined();
    });
  }
});

describe('网络/代理/错误行为保持', () => {
  it('代理 URL 与代理口令头保持旧行为', async () => {
    const profile = profileOf('zhipu-image');
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return imageResponse(profile);
    });
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'p' },
      transport: { proxyBaseUrl: 'https://proxy.example', applicationPassword: 'pw' },
      fetchImpl,
      prefetchImpl: async () => fakePrefetch('a'),
    });
    expect(outcome.ok).toBe(true);
    expect(capturedUrl.startsWith('https://proxy.example/relay?target=')).toBe(true);
    expect(capturedHeaders['x-aniguide-proxy-token']).toBe('pw');
    expect(capturedHeaders.Authorization).toBe('Bearer sk-test');
  });

  it('超时保持：profile.timeoutMs 生效，错误仍是人话', async () => {
    const profile = { ...profileOf('qwen-image'), timeoutMs: 5 };
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'p' },
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('超时');
  });

  it('取消保持：AbortSignal 立即中止', async () => {
    const profile = profileOf('zhipu-image');
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(
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
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'p' },
      fetchImpl,
      signal: controller.signal,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('取消');
  });

  it('HTTP 错误文案仍由网关分类（401 → API Key 提示）', async () => {
    const profile = profileOf('zhipu-image');
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const outcome = await generateImages({
      profile,
      apiKey: 'bad',
      req: { prompt: 'p' },
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('API Key');
  });
});

describe('CORS 行为保持', () => {
  it('fetch 抛 TypeError → 仍然是跨域提示（文案不变）', async () => {
    const outcome = await generateImages({
      profile: profileOf('zhipu-image'),
      apiKey: 'sk-test',
      req: { prompt: 'p' },
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('跨域');
  });
});

describe('prefetch 安全校验仍由 generate.ts 负责', () => {
  it('图片响应不是 image/* → 警告，不落 dataUrl', async () => {
    const profile = profileOf('zhipu-image');
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('images/generations')) {
        return imageResponse(profile);
      }
      return new Response('not an image', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'p' },
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.images[0]!.dataUrl).toBeUndefined();
    expect(outcome.warnings.join('\n')).toContain('不是图片');
  });

  it('图片 Content-Length > 30MB → 警告，不下载', async () => {
    const profile = profileOf('zhipu-image');
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('images/generations')) {
        return imageResponse(profile);
      }
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-length'
              ? '32000000'
              : name.toLowerCase() === 'content-type'
                ? 'image/png'
                : null,
        },
        blob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }),
      } as unknown as Response;
    });
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'p' },
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.images[0]!.dataUrl).toBeUndefined();
    expect(outcome.warnings.join('\n')).toContain('30 MB');
  });
});

describe('注册表回退 / 新 provider 只加数据', () => {
  it('**未知 apiFlavor 回退到 openai 适配器**（行为可预期）', () => {
    const unknown = {
      ...profileOf('zhipu-image'),
      apiFlavor: 'not-a-real-flavor' as never,
    };
    const adapter = getImageAdapter(unknown);
    expect(adapter.apiFlavor).toBe('openai');
    const request: ImageGenerationRequest = { prompt: 'p', referenceImages: [] };
    expect(adapter.buildRequest(unknown, request).body).toEqual(
      buildImagePayloadFor(unknown, { model: unknown.model ?? unknown.name, prompt: 'p' }),
    );
  });

  it('dashscope-async 适配器明确占位：parseResponse 为空（当前无图片档案使用）', () => {
    const asyncProfile = {
      ...profileOf('qwen-image'),
      apiFlavor: 'dashscope-async' as const,
    };
    const adapter = getImageAdapter(asyncProfile);
    expect(adapter.apiFlavor).toBe('dashscope-async');
    expect(adapter.parseResponse(asyncProfile, {})).toEqual([]);
    expect(buildHeaders(asyncProfile, 'sk-test')['X-DashScope-Async']).toBe('enable');
  });

  it('**假想 provider 只靠档案 imagePayload 映射即可正确出请求**', () => {
    const fake = {
      id: 'fake-provider',
      vendorId: 'fake',
      name: 'Fake 图片',
      provider: 'Fake',
      type: 't2i',
      lang: 'en',
      endpoint: 'https://fake.example/v1/images',
      authType: 'bearer',
      apiFlavor: 'openai',
      model: 'fake-model',
      corsDirect: 'unknown',
      imagePayload: {
        promptField: 'instruction',
        sizeField: 'dimensions',
        countField: 'num',
        negativePromptField: 'avoid',
        referenceField: 'refs',
      },
      capabilities: {
        negativePrompt: true,
        seed: true,
        referenceImage: true,
        maxReferenceImages: 2,
        maxOutputImages: 2,
      },
    } satisfies ModelProfile;
    const request: ImageGenerationRequest = {
      prompt: 'p',
      negativePrompt: 'bad',
      aspectRatio: '16:9',
      count: 2,
      seed: 1,
      referenceImages: ['data:image/png;base64,A'],
    };
    const body = getImageAdapter(fake).buildRequest(fake, request).body;
    expect(body).toMatchObject({
      model: 'fake-model',
      instruction: 'p',
      avoid: 'bad',
      dimensions: '1280x720',
      num: 2,
      seed: 1,
      refs: ['data:image/png;base64,A'],
    });
    expect(body).not.toHaveProperty('prompt');
  });
});
