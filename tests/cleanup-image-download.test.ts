import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES, prefetchImage } from '../src/services/image/generate';

/**
 * 图片下载的地址/类型/体积校验（v0.55 · P3-7）
 *
 * ===========================================================================
 * 为什么下载也要当不可信输入处理
 * ===========================================================================
 * 图片 URL 来自厂商响应；用户又可以填代理。恶意/被篡改的端点可以：
 *  - 返回 `file://…`、`javascript:…` 这类协议（浏览器行为不可控）
 *  - 返回 `text/html`（把一段网页当图片存进 IndexedDB，再当 dataURL 渲染）
 *  - 返回一个几百 MB 的文件（内存放大）
 * 这些内容最终都会变成素材里的 dataUrl，所以必须在**下载入口**拦掉。
 */

function fakeResponse(options: {
  body?: Uint8Array;
  blobType?: string;
  contentType?: string | null;
  declaredLength?: number;
}): Response {
  const body = options.body ?? new Uint8Array([1, 2, 3]);
  const blobPart = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  const blob = new Blob([blobPart], options.blobType ? { type: options.blobType } : {});
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'content-type') return options.contentType ?? null;
        if (key === 'content-length') {
          return options.declaredLength !== undefined ? String(options.declaredLength) : null;
        }
        return null;
      },
    },
    blob: async () => blob,
  } as unknown as Response;
}

function fakeFetch(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

describe('prefetchImage · 地址协议白名单', () => {
  for (const badUrl of ['file:///etc/passwd', 'ftp://example.com/a.png', 'javascript:alert(1)']) {
    it(`**拒绝 ${badUrl.split(':')[0]} 协议，且不发起请求**`, async () => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      await expect(prefetchImage(badUrl, { fetchImpl })).rejects.toThrow(/协议不被支持/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  }

  it('拒绝不是合法 URL 的地址', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(prefetchImage('不是 URL', { fetchImpl })).rejects.toThrow(/不是合法的 URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('允许 https 与 data URI', async () => {
    const ok = fakeResponse({ blobType: 'image/png' });
    await expect(
      prefetchImage('https://oss.example.com/a.png', { fetchImpl: fakeFetch(ok) }),
    ).resolves.toMatchObject({ mimeType: 'image/png' });
    await expect(
      prefetchImage('data:image/png;base64,AQID', { fetchImpl: fakeFetch(ok) }),
    ).resolves.toMatchObject({ mimeType: 'image/png' });
  });
});

describe('prefetchImage · 内容类型校验', () => {
  it('**Content-Type 不是 image/* 时拒绝**（哪怕是 200）', async () => {
    const response = fakeResponse({ contentType: 'text/html; charset=utf-8', blobType: 'text/html' });
    await expect(
      prefetchImage('https://oss.example.com/a.png', { fetchImpl: fakeFetch(response) }),
    ).rejects.toThrow(/不是图片/);
  });

  it('响应头缺失但 Blob 类型是 text/html 时也拒绝', async () => {
    const response = fakeResponse({ contentType: null, blobType: 'text/html' });
    await expect(
      prefetchImage('https://oss.example.com/a.png', { fetchImpl: fakeFetch(response) }),
    ).rejects.toThrow(/不是图片/);
  });

  it('Content-Type 缺失且 Blob 无类型时放行（少数存储不回头，由 dataUrl 兜底渲染）', async () => {
    const response = fakeResponse({ contentType: null, blobType: '' });
    const result = await prefetchImage('https://oss.example.com/a.png', {
      fetchImpl: fakeFetch(response),
    });
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('image/webp 被接受', async () => {
    const response = fakeResponse({ contentType: 'image/webp', blobType: 'image/webp' });
    const result = await prefetchImage('https://oss.example.com/a.webp', {
      fetchImpl: fakeFetch(response),
    });
    expect(result.mimeType).toBe('image/webp');
  });
});

describe('prefetchImage · 体积上限', () => {
  it('**Content-Length 超过 30MB 时提前拒绝**', async () => {
    const response = fakeResponse({ declaredLength: MAX_IMAGE_BYTES + 1, blobType: 'image/png' });
    await expect(
      prefetchImage('https://oss.example.com/huge.png', { fetchImpl: fakeFetch(response) }),
    ).rejects.toThrow(/超过 30 MB/);
  });

  it('没有 Content-Length 时按实际 Blob 大小兜底', async () => {
    const hugeBlob = { size: MAX_IMAGE_BYTES + 1, type: 'image/png' } as unknown as Blob;
    const response = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      blob: async () => hugeBlob,
    } as unknown as Response;
    await expect(
      prefetchImage('https://oss.example.com/huge.png', { fetchImpl: fakeFetch(response) }),
    ).rejects.toThrow(/超过 30 MB/);
  });
});
