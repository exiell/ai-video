import { describe, expect, it, vi } from 'vitest';
import {
  buildChatPayload,
  buildHeaders,
  buildImagePayload,
  buildProxyUrl,
  classifyError,
  extractChatContent,
  extractImageUrls,
  extractVendorMessage,
  GatewayError,
  request,
  testConnection,
} from '../src/services/gateway';
import {
  MODEL_PROFILES,
  findProfile,
} from '../src/data/models/profiles';
import type { ModelProfile } from '../src/types/model';

const llm = MODEL_PROFILES.find((p) => p.id === 'deepseek-chat')!;

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return { ...llm, ...overrides };
}

/** 造一个假的 fetch，返回指定状态码与内容 */
function fakeFetch(status: number, body: string, ok = status >= 200 && status < 300): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      text: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------

describe('网关 · 错误分类（新手看到的必须是人话）', () => {
  it('fetch 抛 TypeError 时判定为跨域，并给出两条出路', () => {
    const info = classifyError(new TypeError('Failed to fetch'));
    expect(info.kind).toBe('cors');
    expect(info.advice).toContain('代理');
    expect(info.advice).toContain('直连');
  });

  it('401 判定为密钥无效', () => {
    const info = classifyError(undefined, 401, '{"error":{"message":"Invalid API key"}}');
    expect(info.kind).toBe('auth');
    expect(info.status).toBe(401);
    expect(info.advice).toContain('Invalid API key');
  });

  it('402 与 403 判定为额度或权限问题', () => {
    expect(classifyError(undefined, 402, '').kind).toBe('quota');
    expect(classifyError(undefined, 403, '').kind).toBe('quota');
    expect(classifyError(undefined, 402, '').title).toContain('余额');
  });

  it('429 判定为限流，并告诉用户等多久', () => {
    const info = classifyError(undefined, 429, '');
    expect(info.kind).toBe('rate-limit');
    expect(info.advice).toContain('等');
  });

  it('404 判定为地址或模型名错误', () => {
    const info = classifyError(undefined, 404, '');
    expect(info.kind).toBe('not-found');
  });

  it('5xx 明确告诉用户这不是他的问题', () => {
    const info = classifyError(undefined, 503, '');
    expect(info.kind).toBe('server');
    expect(info.advice).toContain('不是你的问题');
  });

  it('主动取消与超时区分开', () => {
    expect(classifyError(new DOMException('x', 'AbortError')).kind).toBe('aborted');
  });

  it('每一类错误都必须有 title 与 advice，不能出现空文案', () => {
    const samples: unknown[] = [
      new TypeError('Failed to fetch'),
      new Error('socket hang up'),
      new DOMException('x', 'AbortError'),
      'string error',
    ];
    for (const sample of samples) {
      const info = classifyError(sample);
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.advice.length).toBeGreaterThan(0);
    }
    for (const status of [400, 401, 402, 403, 404, 429, 500, 503, 418]) {
      const info = classifyError(undefined, status, '');
      expect(info.title.length).toBeGreaterThan(0);
      expect(info.advice.length).toBeGreaterThan(0);
    }
  });
});

describe('网关 · 厂商消息提取', () => {
  it('从 OpenAI 风格的 error.message 里取', () => {
    expect(extractVendorMessage('{"error":{"message":"余额不足"}}')).toBe('余额不足');
  });
  it('从顶层 message 里取', () => {
    expect(extractVendorMessage('{"message":"bad model"}')).toBe('bad model');
  });
  it('非 JSON 原样截断', () => {
    expect(extractVendorMessage('<html>502</html>')).toBe('<html>502</html>');
  });
  it('空输入返回空串', () => {
    expect(extractVendorMessage(undefined)).toBe('');
  });
});

describe('网关 · Transport 与请求头', () => {
  it('代理地址拼接时编码原始目标地址', () => {
    const url = buildProxyUrl('https://p.example.com/', 'https://api.deepseek.com/chat/completions');
    expect(url).toBe(
      'https://p.example.com/relay?target=https%3A%2F%2Fapi.deepseek.com%2Fchat%2Fcompletions',
    );
  });

  it('bearer 鉴权用 Authorization 头', () => {
    const headers = buildHeaders(profile({ authType: 'bearer' }), 'sk-abc');
    expect(headers.Authorization).toBe('Bearer sk-abc');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('header-key 鉴权用 x-api-key 头', () => {
    const headers = buildHeaders(profile({ authType: 'header-key' }), 'sk-abc');
    expect(headers['x-api-key']).toBe('sk-abc');
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('网关 · 请求', () => {
  it('成功时返回解析后的 JSON', async () => {
    const payload = '{"choices":[{"message":{"content":"可以"}}]}';
    const result = await request<{ choices: unknown[] }>({
      profile: llm,
      apiKey: 'sk-test',
      body: { hello: 1 },
      fetchImpl: fakeFetch(200, payload),
    });
    expect(result.choices).toHaveLength(1);
  });

  it('非 2xx 抛 GatewayError，且带上分类信息', async () => {
    await expect(
      request({
        profile: llm,
        apiKey: 'sk-test',
        body: {},
        fetchImpl: fakeFetch(401, '{"error":{"message":"Invalid token"}}'),
      }),
    ).rejects.toThrow(GatewayError);

    try {
      await request({
        profile: llm,
        apiKey: 'sk-test',
        body: {},
        fetchImpl: fakeFetch(401, '{"error":{"message":"Invalid token"}}'),
      });
    } catch (error) {
      expect((error as GatewayError).info.kind).toBe('auth');
    }
  });

  it('返回体不是 JSON 时给出「地址可能填错」的提示', async () => {
    try {
      await request({
        profile: llm,
        apiKey: 'sk-test',
        body: {},
        fetchImpl: fakeFetch(200, '<!doctype html><html>…'),
      });
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).info.kind).toBe('parse');
      expect((error as GatewayError).info.advice).toContain('接口地址');
    }
  });

  it('走代理时会改写到代理地址并带上通行口令', async () => {
    const spy = vi.fn(fakeFetch(200, '{}'));
    await request({
      profile: llm,
      apiKey: 'sk-test',
      body: {},
      transport: { proxyBaseUrl: 'https://p.example.com', applicationPassword: 'pw' },
      fetchImpl: spy as unknown as typeof fetch,
    });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('https://p.example.com/relay?target=');
    expect((init.headers as Record<string, string>)['x-aniguide-proxy-token']).toBe('pw');
  });

  it('没有代理配置时保持直连，不改写地址', async () => {
    const spy = vi.fn(fakeFetch(200, '{}'));
    await request({
      profile: llm,
      apiKey: 'sk-test',
      body: {},
      fetchImpl: spy as unknown as typeof fetch,
    });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(llm.endpoint);
    expect((init.headers as Record<string, string>)['x-aniguide-proxy-token']).toBeUndefined();
  });
});

describe('网关 · 载荷与响应解析', () => {
  it('对话载荷按需带上 json 模式与采样参数', () => {
    const payload = buildChatPayload({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 100,
    });
    expect(payload.model).toBe('deepseek-chat');
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.temperature).toBe(0.3);
    expect(payload.max_tokens).toBe(100);
  });

  it('不传的采样参数不会出现在载荷里', () => {
    const payload = buildChatPayload({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect('temperature' in payload).toBe(false);
    expect('response_format' in payload).toBe(false);
  });

  it('从对话响应里取出正文', () => {
    expect(extractChatContent({ choices: [{ message: { content: '你好' } }] })).toBe('你好');
    expect(extractChatContent({ choices: [] })).toBe('');
    expect(extractChatContent(null)).toBe('');
    expect(extractChatContent({})).toBe('');
  });

  it('文生图载荷把负向词与种子分开传，不混进正文', () => {
    const payload = buildImagePayload({
      model: 'Kwai-Kolors/Kolors',
      prompt: 'a red circle',
      negativePrompt: 'blurry, text',
      seed: 42,
      batchSize: 2,
      imageSize: '1024x1024',
    });
    expect(payload.prompt).toBe('a red circle');
    expect(payload.negative_prompt).toBe('blurry, text');
    expect(payload.seed).toBe(42);
  });

  it('从文生图响应里取出全部图片地址', () => {
    const urls = extractImageUrls({
      data: [{ url: 'https://a/1.png' }, { url: 'https://a/2.png' }, { b64: 'x' }],
    });
    expect(urls).toEqual(['https://a/1.png', 'https://a/2.png']);
    expect(extractImageUrls({})).toEqual([]);
  });
});

describe('网关 · 连接测试', () => {
  it('成功时报告直连、耗时与模型原话', async () => {
    const result = await testConnection(
      llm,
      'sk-test',
      undefined,
      fakeFetch(200, '{"choices":[{"message":{"content":"可以"}}]}'),
    );
    expect(result.ok).toBe(true);
    expect(result.via).toBe('direct');
    expect(result.sample).toBe('可以');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('被跨域挡住时报告 cors，而不是笼统的「失败」', async () => {
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const result = await testConnection(llm, 'sk-test', undefined, failing);
    expect(result.ok).toBe(false);
    expect(result.info?.kind).toBe('cors');
  });

  it('走代理时 via 标为 proxy，便于用户确认配置生效', async () => {
    const result = await testConnection(
      llm,
      'sk-test',
      { proxyBaseUrl: 'https://p.example.com' },
      fakeFetch(200, '{"choices":[{"message":{"content":"可以"}}]}'),
    );
    expect(result.via).toBe('proxy');
  });

  it('额度不足时给出可执行的建议', async () => {
    const result = await testConnection(
      llm,
      'sk-test',
      undefined,
      fakeFetch(402, '{"error":{"message":"Insufficient balance"}}'),
    );
    expect(result.ok).toBe(false);
    expect(result.info?.kind).toBe('quota');
    expect(result.info?.advice).toContain('余额');
  });

  it('文生图档案测的是图片接口，不是对话接口', async () => {
    // 显式取千问，不要靠「数组里第一个 t2i」——档案顺序会随扩充提供方变化
    const t2i = findProfile('qwen-image')!;
    expect(t2i.apiFlavor).toBe('dashscope-sync');
    // 千问走 DashScope 原生协议，响应结构是嵌套三层的
    // output.choices[0].message.content[0].image —— 不是 OpenAI 的 data[0].url。
    // 这里刻意用真实结构，避免「用错协议的响应喂测试，测试还过了」。
    const body = JSON.stringify({
      output: { choices: [{ message: { content: [{ image: 'https://a/1.png' }] } }] },
    });
    const result = await testConnection(t2i, 'sk-test', undefined, fakeFetch(200, body));
    expect(result.ok).toBe(true);
    expect(result.sample).toContain('1 张图');
  });

  it('OpenAI 兼容的文生图档案仍然按 data[].url 解析', async () => {
    const t2i = findProfile('zhipu-image')!;
    expect(t2i.apiFlavor ?? 'openai').toBe('openai');
    const openaiStyle = { ...t2i, apiFlavor: 'openai' as const };
    const result = await testConnection(
      openaiStyle,
      'sk-test',
      undefined,
      fakeFetch(200, '{"data":[{"url":"https://a/1.png"},{"url":"https://a/2.png"}]}'),
    );
    expect(result.ok).toBe(true);
    expect(result.sample).toContain('2 张图');
  });
});

describe('模型档案配置', () => {
  it('直连可行性取值为三态之一，且不能为空', () => {
    for (const p of MODEL_PROFILES) {
      expect(['yes', 'no', 'unknown']).toContain(p.corsDirect);
    }
  });

  it('标为 yes 的档案必须写明实测依据（notes 里要有来源）', () => {
    for (const p of MODEL_PROFILES) {
      if (p.corsDirect !== 'yes') continue;
      // 证据来源必须可追溯，不能只写一句「应该可以」
      expect(p.notes ?? '').toMatch(/实测|预检|ACAO/);
    }
  });

  it('首批三家都已实测确认可直连（依据：scripts/cors-probe.mjs）', () => {
    for (const p of MODEL_PROFILES) {
      expect(p.corsDirect).toBe('yes');
    }
  });

  it('档案的必填字段齐全，且 endpoint 是完整地址', () => {
    for (const p of MODEL_PROFILES) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.provider).toBeTruthy();
      expect(p.endpoint.startsWith('https://')).toBe(true);
      expect(['bearer', 'header-key']).toContain(p.authType);
      expect(['llm', 't2i', 'i2v']).toContain(p.type);
    }
  });
});
