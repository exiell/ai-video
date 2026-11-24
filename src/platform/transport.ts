import { getDesktopApi } from './index';

let seq = 0;
function nextRequestId(): string {
  seq += 1;
  return `req-${Date.now().toString(36)}-${seq}`;
}

function headersToRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (init instanceof Headers) {
    init.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(init)) {
    for (const [key, value] of init) {
      out[key] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(init)) {
    if (value !== undefined) out[key] = String(value);
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 桌面端无 CORS fetch 适配（经由 Electron 主进程 net.fetch）。
 *
 * 仅在 Electron 环境生效；Web 端直接回退全局 fetch。
 * 若调用方显式传入自定义 fetchImpl（例如单测注入桩），始终尊重调用方实现。
 */
export function resolvePlatformFetch(explicit?: typeof fetch): typeof fetch {
  if (explicit) return explicit;
  const api = getDesktopApi();
  if (!api) return fetch;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = headersToRecord(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const requestId = nextRequestId();

    const signal = init?.signal;
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const onAbort = (): void => {
      api.http.abort(requestId);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await api.http.request({
        requestId,
        url,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      });

      const responseHeaders = new Headers(res.headers);
      if (res.bodyBase64 !== undefined) {
        const bytes = base64ToBytes(res.bodyBase64);
        return new Response(bytes.slice().buffer as ArrayBuffer, {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders,
        });
      }

      return new Response(res.bodyText ?? '', {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new DOMException(error.message || 'The operation was aborted.', 'AbortError');
      }
      throw new TypeError(error instanceof Error ? error.message : String(error));
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
