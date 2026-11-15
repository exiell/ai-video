// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  buildVideoCreateRequest,
  checkVideoProfile,
  createVideoJob,
  fetchVideoContent,
  httpVideoError,
  normalizeVideoError,
  parseVideoJob,
  pollVideoJob,
  cancelVideoJob,
  VideoServiceError,
} from '../src/services/gateway/videoAdapters';
import type { VideoProfile } from '../src/types/video';

const profile: VideoProfile = {
  id: 'custom:video:test',
  name: 'SkyReels 本地',
  provider: '自定义',
  baseUrl: 'http://127.0.0.1:8110/v1',
  model: 'skyreels-v3-r2v',
  protocol: 'openai-videos',
  requiresKey: false,
  timeoutMs: 1_200_000,
  capabilities: {
    maxReferenceImages: 4,
    durationSeconds: 5,
    resolution: '480P',
    aspectFollowsFirstReference: true,
    supportsReferenceImages: true,
    requiresKey: false,
    maxTimeoutMs: 1_200_000,
  },
};

const refs = ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'];

describe('OpenAI Videos 请求构造', () => {
  it('POST /videos：body 顺序、默认 5s/480P、无 auth', () => {
    const prepared = buildVideoCreateRequest(profile, { prompt: '测试提示词', referenceImages: refs, seed: 7 });
    expect(prepared.url).toBe('http://127.0.0.1:8110/v1/videos');
    expect(prepared.headers.Authorization).toBeUndefined();
    expect(prepared.body).toMatchObject({
      model: 'skyreels-v3-r2v',
      prompt: '测试提示词',
      seconds: 5,
      resolution: '480P',
      seed: 7,
    });
    expect(prepared.body.image_reference).toEqual([
      { image_url: refs[0] },
      { image_url: refs[1] },
    ]);
  });

  it('requiresKey=true 时带 Bearer；没有 Key 明确报错', () => {
    const guarded = { ...profile, requiresKey: true, capabilities: { ...profile.capabilities, requiresKey: true } };
    const prepared = buildVideoCreateRequest(guarded, { prompt: 'p', referenceImages: refs }, { apiKey: 'sk-x' });
    expect(prepared.headers.Authorization).toBe('Bearer sk-x');
    expect(() => buildVideoCreateRequest(guarded, { prompt: 'p', referenceImages: refs })).toThrow(VideoServiceError);
  });
});

describe('代理 transport 覆盖 poll/content/cancel', () => {
  it('poll、content、cancel 都走代理并带口令我', async () => {
    const calls: { url: string; method: string; proxyToken?: string }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init?.method ?? 'GET', proxyToken: headers['x-aniguide-proxy-token'] });
      if (decodeURIComponent(url).includes('/content')) {
        return new Response('mp4', { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ id: 'remote-1', status: 'completed' }), { status: 200 });
    });
    const transport = { proxyBaseUrl: 'https://proxy.example', applicationPassword: 'proxy-pass' };
    await pollVideoJob(profile, 'remote-1', { fetchImpl, transport });
    await fetchVideoContent(profile, 'remote-1', { fetchImpl, transport });
    await cancelVideoJob(profile, 'remote-1', { fetchImpl, transport });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.url).toContain('https://proxy.example/relay?target=');
      expect(call.proxyToken).toBe('proxy-pass');
    }
    expect(calls[0]?.method).toBe('GET');
    expect(calls[1]?.method).toBe('GET');
    expect(calls[2]?.method).toBe('DELETE');
  });
});

describe('checkVideoProfile', () => {
  it('/v1/models 命中模型即 ready；baseUrl 末尾 /v1 会正确拼根', async () => {
    let url = '';
    const result = await checkVideoProfile(profile, '', {
      fetchImpl: async (input) => {
        url = String(input);
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'skyreels-v3-r2v' }] }), { status: 200 });
      },
    });
    expect(result).toMatchObject({ ok: true, status: 'ready' });
    expect(url).toBe('http://127.0.0.1:8110/v1/models');
  });

  it('/v1/models 不可用 → 回退 /health；model_loaded=false 给 model-not-loaded', async () => {
    const urls: string[] = [];
    const result = await checkVideoProfile(profile, '', {
      fetchImpl: async (input) => {
        urls.push(String(input));
        if (String(input).endsWith('/v1/models')) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify({ status: 'ok', model_loaded: false }), { status: 200 });
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('model-not-loaded');
    expect(result.message).toContain('模型还没加载');
    expect(urls).toEqual(['http://127.0.0.1:8110/v1/models', 'http://127.0.0.1:8110/health']);
  });

  it('models 200 但缺模型 + health loaded=true 也保持 model-not-loaded', async () => {
    const urls: string[] = [];
    const result = await checkVideoProfile(profile, '', {
      fetchImpl: async (input) => {
        urls.push(String(input));
        if (String(input).endsWith('/v1/models')) {
          return new Response(JSON.stringify({ object: 'list', data: [{ id: 'other-model' }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: 'ok', model_loaded: true }), { status: 200 });
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('model-not-loaded');
    expect(urls).toHaveLength(1); // 模型列表明确缺模型时不再看 health 翻案
  });

  it('models 404 + health loaded=true → ready；health loaded=false → model-not-loaded', async () => {
    const ready = await checkVideoProfile(profile, '', {
      fetchImpl: async (input) => {
        if (String(input).endsWith('/v1/models')) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify({ status: 'ok', model_loaded: true }), { status: 200 });
      },
    });
    expect(ready).toMatchObject({ ok: true, status: 'ready' });
    const notReady = await checkVideoProfile(profile, '', {
      fetchImpl: async (input) => {
        if (String(input).endsWith('/v1/models')) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify({ status: 'ok', model_loaded: false }), { status: 200 });
      },
    });
    expect(notReady).toMatchObject({ ok: false, status: 'model-not-loaded' });
  });

  it('root 推导矩阵：/v1、/v1/videos、裸主机、尾斜杠都落到同一个 /v1/models', async () => {
    const bases = [
      'http://127.0.0.1:8110/v1',
      'http://127.0.0.1:8110/v1/',
      'http://127.0.0.1:8110/v1/videos',
      'http://127.0.0.1:8110/v1/videos/',
      'http://127.0.0.1:8110',
    ];
    for (const baseUrl of bases) {
      let called = '';
      const result = await checkVideoProfile(
        { ...profile, baseUrl },
        '',
        {
          fetchImpl: async (input) => {
            called = String(input);
            return new Response(JSON.stringify({ object: 'list', data: [{ id: 'skyreels-v3-r2v' }] }), {
              status: 200,
            });
          },
        },
      );
      expect(result.status, baseUrl).toBe('ready');
      expect(called, baseUrl).toBe('http://127.0.0.1:8110/v1/models');
    }
  });

  it('401 → unauthorized；网络错误 → cors；缺 Key → missing-key', async () => {
    const unauthorized = await checkVideoProfile(profile, '', {
      fetchImpl: async () => new Response('bad key', { status: 401 }),
    });
    expect(unauthorized.status).toBe('unauthorized');
    const cors = await checkVideoProfile(profile, '', {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(cors.status).toBe('cors');
    expect(cors.message).toContain('端口转发');
    const guarded = { ...profile, requiresKey: true, capabilities: { ...profile.capabilities, requiresKey: true } };
    const missing = await checkVideoProfile(guarded, '');
    expect(missing.status).toBe('missing-key');
  });
});

describe('任务状态解析', () => {
  it('queued / running / completed / failed 映射；未知状态报错', () => {
    expect(parseVideoJob({ id: 'v1', status: 'queued' }).status).toBe('queued');
    expect(parseVideoJob({ id: 'v1', status: 'in_progress' }).status).toBe('running');
    const completed = parseVideoJob({
      id: 'v1',
      status: 'completed',
      elapsed_seconds: 12.5,
      output: { width: 480, height: 848, duration_s: 5, fps: 24, bytes: 1000 },
    });
    expect(completed.output).toMatchObject({ width: 480, height: 848, duration: 5, fps: 24 });
    expect(parseVideoJob({ id: 'v1', status: 'failed', error: '显存不足' }).error).toBe('显存不足');
    expect(() => parseVideoJob({ id: 'v1', status: 'weird' })).toThrow(VideoServiceError);
  });
});

describe('网络调用与错误归一', () => {
  it('create/poll 发对 URL 和 method；content 返回 mp4 Blob', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method}:${String(input)}`);
      if (String(input).endsWith('/videos')) {
        return new Response(JSON.stringify({ id: 'remote-1', status: 'queued' }), { status: 202 });
      }
      if (String(input).endsWith('/content')) {
        return new Response('mp4-bytes', {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        });
      }
      return new Response(JSON.stringify({ id: 'remote-1', status: 'completed', output: { width: 480, height: 848 } }), { status: 200 });
    });
    const created = await createVideoJob(profile, { prompt: 'p', referenceImages: refs }, { fetchImpl });
    expect(created.id).toBe('remote-1');
    const polled = await pollVideoJob(profile, 'remote-1', { fetchImpl });
    expect(polled.status).toBe('completed');
    const content = await fetchVideoContent(profile, 'remote-1', { fetchImpl });
    expect(content.byteSize).toBeGreaterThan(0);
    expect(calls[0]).toBe('POST:http://127.0.0.1:8110/v1/videos');
    expect(calls[1]).toBe('GET:http://127.0.0.1:8110/v1/videos/remote-1');
    expect(calls[2]).toBe('GET:http://127.0.0.1:8110/v1/videos/remote-1/content');
  });

  it('transport 代理：URL 走 /relay，带代理口令，错误 body 脱敏', async () => {
    let calledUrl = '';
    let calledHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calledUrl = String(input);
      calledHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ error: { message: 'Bearer sk-proxy-secret 失败' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    });
    let message = '';
    try {
      await createVideoJob(
        profile,
        { prompt: 'p', referenceImages: refs },
        {
          fetchImpl,
          transport: { proxyBaseUrl: 'https://proxy.example', applicationPassword: 'proxy-pass' },
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('***');
    expect(message).not.toContain('sk-proxy-secret');
    expect(calledUrl).toContain('https://proxy.example/relay?target=');
    expect(calledHeaders['x-aniguide-proxy-token']).toBe('proxy-pass');
  });

  it('400/429/5xx OOM 人话；网络错误提示服务没起', async () => {
    expect(() => { throw httpVideoError(400, 'prompt 不能为空'); }).toThrow('prompt 不能为空');
    expect(() => { throw httpVideoError(429, ''); }).toThrow('队列已满');
    expect(() => { throw httpVideoError(500, 'CUDA out of memory'); }).toThrow('显存不够');
    const network = normalizeVideoError(new TypeError('Failed to fetch'));
    expect(network.message).toContain('连不上本地视频服务');
    expect(network.kind).toBe('network');
    const abort = normalizeVideoError(new DOMException('aborted', 'AbortError'));
    expect(abort.kind).toBe('timeout');
  });

  it('content 类型不对报人话；DELETE 405 视为不支持取消', async () => {
    await expect(
      fetchVideoContent(profile, 'v1', {
        fetchImpl: async () => new Response('nope', { status: 200, headers: { 'content-type': 'text/html' } }),
      }),
    ).rejects.toThrow('不是 mp4');
    const cancelled = await cancelVideoJob(profile, 'v1', {
      fetchImpl: async () => new Response('', { status: 405 }),
    });
    expect(cancelled.supported).toBe(false);
  });
});
