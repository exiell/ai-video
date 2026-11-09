import { describe, expect, it, vi } from 'vitest';
import {
  GatewayError,
  MAX_RESPONSE_TEXT_BYTES,
  readResponseTextLimited,
  request,
} from '../src/services/gateway';
import { MODEL_PROFILES } from '../src/data/models/profiles';
import type { ModelProfile } from '../src/types/model';

/**
 * 网关的响应读取上限与超时（v0.54 · P2-1 / P2-2）
 *
 * ===========================================================================
 * 两条原来会「静默卡死 / 静默吃内存」的路径
 * ===========================================================================
 * 1. `response.text()` 无上限：用户可填代理，恶意代理返回超大 body 时，
 *    标签页会一路读到内存耗尽。现在 8MB 就停，并给一句人话。
 * 2. 超时 timer 原来在拿到响应头后就被清掉，body 读取完全没有保护：
 *    服务端可以先回 200 头再慢慢吐 body（或永远不吐完），请求永久 pending。
 *    这里用 fake timers 证明「响应头回来之后 body 卡住」也会按超时失败。
 */

const llm: ModelProfile = MODEL_PROFILES.find((profile) => profile.type === 'llm')!;

function dispatchError<T = unknown>(promise: Promise<T>): Promise<GatewayError> {
  return promise.then(
    () => {
      throw new Error('这个请求本应失败，但它成功了');
    },
    (error: unknown) => {
      if (error instanceof GatewayError) return error;
      throw error;
    },
  );
}

describe('响应读取上限', () => {
  it('Content-Length 超限时，在读取 body 之前就拒绝', async () => {
    const fake = {
      headers: { get: () => String(MAX_RESPONSE_TEXT_BYTES + 1) },
      text: async () => 'x',
    } as unknown as Response;

    const error = await dispatchError(readResponseTextLimited(fake));
    expect(error.info.kind).toBe('too-large');
    expect(error.info.title).toContain('异常大');
    expect(error.info.advice).toContain('代理可信');
  });

  it('**流式 body 超限时立刻停止读取**，不是先吃进内存', async () => {
    const response = new Response('x'.repeat(4096));
    const error = await dispatchError(readResponseTextLimited(response, 64));
    expect(error.info.kind).toBe('too-large');
  });

  it('没有 body 流的测试替身按文本长度兜底', async () => {
    const fake = { text: async () => 'x'.repeat(32) } as unknown as Response;
    const error = await dispatchError(readResponseTextLimited(fake, 16));
    expect(error.info.kind).toBe('too-large');
    await expect(readResponseTextLimited(fake, 64)).resolves.toHaveLength(32);
  });

  it('正常响应能完整解码（多字节字符不被 chunk 边界截断）', async () => {
    const response = new Response('中文回复');
    await expect(readResponseTextLimited(response)).resolves.toBe('中文回复');
  });
});

describe('超时覆盖到 body 读完', () => {
  it('**响应头回来之后 body 卡住，也会按超时失败**（不再永久 pending）', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = (async (_url: string, init: RequestInit) =>
        ({
          ok: true,
          status: 200,
          // 模拟「头到了、body 永远不来」：只有 abort 时才会结束
          text: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              );
            }),
        }) as unknown as Response) as unknown as typeof fetch;

      const pending = dispatchError(
        request({ profile: llm, apiKey: 'sk-test', body: {}, timeoutMs: 1_000, fetchImpl }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      const error = await pending;
      expect(error.info.kind).toBe('timeout');
      expect(error.info.title).toContain('超时');
    } finally {
      vi.useRealTimers();
    }
  });

  it('调用方主动取消仍然报「已取消」，不会被误判成超时', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;

    const pending = dispatchError(
      request({
        profile: llm,
        apiKey: 'sk-test',
        body: {},
        timeoutMs: 60_000,
        fetchImpl,
        signal: controller.signal,
      }),
    );
    controller.abort();
    const error = await pending;
    expect(error.info.kind).toBe('aborted');
  });
});
