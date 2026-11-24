import { ipcMain, net } from 'electron';
import type { NativeHttpRequest, NativeHttpResponse } from '../../src/platform/types';

const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;

const activeControllers = new Map<string, AbortController>();

function isAllowedHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isBinaryContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('image/') ||
    ct.startsWith('video/') ||
    ct.startsWith('audio/') ||
    ct.includes('application/octet-stream')
  );
}

async function readLimitedBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const ab = await response.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw new Error(`响应体超过上限（${Math.round(maxBytes / 1024 / 1024)} MB）`);
    }
    return Buffer.from(ab);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`响应体超过上限（${Math.round(maxBytes / 1024 / 1024)} MB）`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

export function registerNetProxyIpc(): void {
  ipcMain.handle('aniguide:http:request', async (_event, req: NativeHttpRequest): Promise<NativeHttpResponse> => {
    if (!req || typeof req.url !== 'string' || !isAllowedHttpUrl(req.url)) {
      throw new Error('仅允许 http:// 或 https:// 协议的网络请求');
    }

    const controller = new AbortController();
    activeControllers.set(req.requestId, controller);

    try {
      const response = await net.fetch(req.url, {
        method: req.method || 'GET',
        headers: req.headers ?? {},
        ...(req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD'
          ? { body: req.body }
          : {}),
        signal: controller.signal,
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const contentType = headers['content-type'] ?? '';
      const binary = isBinaryContentType(contentType);
      const buf = await readLimitedBuffer(response, binary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES);

      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        ...(binary ? { bodyBase64: buf.toString('base64') } : { bodyText: buf.toString('utf8') }),
      };
    } finally {
      activeControllers.delete(req.requestId);
    }
  });

  ipcMain.on('aniguide:http:abort', (_event, requestId: string) => {
    const controller = activeControllers.get(requestId);
    if (controller) {
      controller.abort();
      activeControllers.delete(requestId);
    }
  });
}
