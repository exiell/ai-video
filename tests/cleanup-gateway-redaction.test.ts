import { describe, expect, it } from 'vitest';
import {
  GatewayError,
  redactProxyErrorBody,
  request,
} from '../src/services/gateway';
import { MODEL_PROFILES } from '../src/data/models/profiles';

/**
 * 经代理时的错误原文脱敏（v0.55 · P3-12）
 *
 * ===========================================================================
 * 场景
 * ===========================================================================
 * 设置页会把 `testConnection` 的 `info.raw` 展开给用户看（最多 600 字）。
 * 代理是用户自己填的第三方地址，恶意/被篡改的代理可能在错误 body 里
 * 回显请求头——如果带着 Authorization 或厂商 Key，就会在应用界面上再泄一次。
 *
 * 规则：**经代理时脱敏，直连保持原文**（直连的原文是用户自己的请求，方便排查）。
 */

const llm = MODEL_PROFILES.find((profile) => profile.type === 'llm')!;

function fakeFetch(status: number, body: string): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

async function errorOf(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GatewayError) return error;
    throw error;
  }
  throw new Error('这个请求本应失败，但它成功了');
}

const ECHO_BODY = JSON.stringify({
  error: 'unauthorized',
  authorization: 'Bearer sk-live-secret-123456',
  'x-api-key': 'sk-another-999999',
  echo: 'your key is sk-live-secret-123456',
});

describe('redactProxyErrorBody', () => {
  it('抹掉 Bearer token、sk- 形式 Key、authorization/x-api-key 字段值', () => {
    const redacted = redactProxyErrorBody(ECHO_BODY);
    expect(redacted).not.toContain('sk-live-secret-123456');
    expect(redacted).not.toContain('sk-another-999999');
    expect(redacted).toContain('[已脱敏]');
  });

  it('普通错误文本原样保留', () => {
    const text = '{"error":"模型名不被接受"}';
    expect(redactProxyErrorBody(text)).toBe(text);
  });
});

describe('request · 经代理时错误原文脱敏', () => {
  it('**代理回显的 Authorization / Key 不会出现在错误原文里**', async () => {
    const error = await errorOf(
      request({
        profile: llm,
        apiKey: 'sk-live-secret-123456',
        body: {},
        transport: { proxyBaseUrl: 'https://proxy.example.com' },
        fetchImpl: fakeFetch(401, ECHO_BODY),
      }),
    );
    expect(error.info.kind).toBe('auth');
    expect(error.info.raw).toBeDefined();
    expect(error.info.raw).not.toContain('sk-live-secret-123456');
    expect(error.info.raw).not.toContain('sk-another-999999');
    expect(error.info.raw).toContain('[已脱敏]');
  });

  it('**直连时保持原文**（方便排查，原文本来就是用户自己的请求）', async () => {
    const error = await errorOf(
      request({
        profile: llm,
        apiKey: 'sk-live-secret-123456',
        body: {},
        fetchImpl: fakeFetch(401, ECHO_BODY),
      }),
    );
    expect(error.info.raw).toContain('sk-live-secret-123456');
  });

  it('经代理返回非 JSON 时，parse 错误的 raw 也脱敏', async () => {
    const error = await errorOf(
      request({
        profile: llm,
        apiKey: 'sk-live-secret-123456',
        body: {},
        transport: { proxyBaseUrl: 'https://proxy.example.com' },
        fetchImpl: fakeFetch(200, 'Authorization: Bearer sk-live-secret-123456 这不是 JSON'),
      }),
    );
    expect(error.info.kind).toBe('parse');
    expect(error.info.raw).not.toContain('sk-live-secret-123456');
  });
});
