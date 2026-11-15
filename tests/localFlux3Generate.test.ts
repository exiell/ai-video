import { describe, expect, it, vi } from 'vitest';
import { generateImages } from '../src/services/image/generate';
import { findProfile } from '../src/data/models/profiles';

/**
 * 本地 FLUX3 出图链路的集成测试（不走真实 GPU）
 *
 * 重点：
 *  - 参考图顺序原样进 messages.content；
 *  - 最多 10 张，超出按能力截断并给 warning；
 *  - 无 Authorization；
 *  - b64 fallback / 超时 / 取消的错误能变成人话。
 */

const local = findProfile('local-flux3')!;

function responseWith(images: string[]): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: images.map((url) => ({ type: 'image_url', image_url: { url } })),
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function refs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `data:image/png;base64,REF${i}`);
}

describe('generateImages · 本地 FLUX3', () => {
  it('10 张参考图全部按顺序发出，无 auth，返回 data URI', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return responseWith(['data:image/png;base64,OUT']);
    });

    const outcome = await generateImages({
      profile: local,
      apiKey: '',
      req: { prompt: 'combine', count: 1, referenceImages: refs(10) },
      fetchImpl,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.images).toHaveLength(1);
    expect(outcome.images[0]!.dataUrl).toBe('data:image/png;base64,OUT');
    expect(outcome.images[0]!.url).toBe('data:image/png;base64,OUT');

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();

    const body = JSON.parse(String(calls[0]!.init!.body)) as {
      messages: { content: { type: string; image_url?: { url: string } }[] }[];
    };
    const content = body.messages[0]!.content;
    expect(content).toHaveLength(11); // text + 10 张
    expect(content[0]!.type).toBe('text');
    expect(content.slice(1).map((item) => item.image_url!.url)).toEqual(refs(10));
  });

  it('超过 10 张时按能力截断并给 warning', async () => {
    const capture: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capture.push(init!);
      return responseWith(['data:image/png;base64,OUT']);
    });
    const outcome = await generateImages({
      profile: local,
      apiKey: '',
      req: { prompt: 'combine', count: 1, referenceImages: refs(11) },
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings.join('\n')).toContain('最多接受 10 张');
    const body = JSON.parse(String(capture[0]!.body)) as {
      messages: { content: unknown[] }[];
    };
    expect(body.messages[0]!.content).toHaveLength(11);
  });

  it('响应只有顶层 data[].b64_json 也能落地（fallback）', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: 'A'.repeat(80) }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const outcome = await generateImages({
      profile: local,
      apiKey: '',
      req: { prompt: 'x', count: 1, referenceImages: [] },
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.images[0]!.dataUrl!.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('HTTP 错误 → ok:false + 人话 error', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const outcome = await generateImages({
      profile: local,
      apiKey: '',
      req: { prompt: 'x', count: 1, referenceImages: [] },
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
  });

  it('**超时** → ok:false + error 提超时', async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const outcome = await generateImages({
      profile: { ...local, timeoutMs: 5 },
      apiKey: '',
      req: { prompt: 'x', count: 1, referenceImages: [] },
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('超时');
  });

  it('**取消** → ok:false + error 提取消', async () => {
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
    const controller = new AbortController();
    controller.abort();
    const outcome = await generateImages({
      profile: local,
      apiKey: '',
      req: { prompt: 'x', count: 1, referenceImages: [] },
      fetchImpl,
      signal: controller.signal,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('取消');
  });
});
