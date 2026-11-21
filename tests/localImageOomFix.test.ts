import { describe, expect, it } from 'vitest';
import {
  classifyError,
  GatewayError,
  request,
} from '../src/services/gateway';
import {
  isLocalProfile,
  LOCAL_REFERENCE_MAX_BYTES,
  LOCAL_REFERENCE_MAX_LONG_EDGE,
} from '../src/services/gateway/localModel';
import { findProfile } from '../src/data/models/profiles';

const local = findProfile('local-flux3')!;
const cloud = findProfile('deepseek-chat')!;
const oomBody = '{"error":{"message":"CUDA out of memory while VAE encode: tried to allocate 2.1 GiB"}}';

describe('本地 FLUX3 500：本地人话，不引向厂商状态页', () => {
  it('本地档案 500 → 本地显存/参考图/VAE 建议，保留 detail', () => {
    const info = classifyError(undefined, 500, oomBody, local);
    expect(info.kind).toBe('server');
    expect(info.title).toContain('本地模型');
    expect(info.advice).toContain('参考图');
    expect(info.advice).toContain('02-start.sh');
    expect(info.advice).toContain('--vae-use-slicing');
    expect(info.title).not.toContain('厂商');
    expect(info.advice).not.toContain('厂商');
    expect(info.advice).not.toContain('状态页');
    expect(info.raw).toBe(oomBody);
  });

  it('authType none 的自定义本地配置也走本地文案', () => {
    const customLocal = { ...local, id: 'custom:image:mine', name: '我的本地 FLUX3', provider: '自定义' };
    const info = classifyError(undefined, 500, 'CUDA out of memory', customLocal);
    expect(info.title).toContain('本地模型');
    expect(info.advice).not.toContain('状态页');
    expect(isLocalProfile(customLocal)).toBe(true);
    expect(isLocalProfile(cloud)).toBe(false);
  });

  it('云端档案 500 行为不变：仍是厂商服务端/状态页', () => {
    const info = classifyError(undefined, 500, '{"error":{"message":"upstream failed"}}', cloud);
    expect(info.title).toContain('厂商服务端出错');
    expect(info.advice).toContain('状态页');
    expect(info.raw).toContain('upstream failed');
  });

  it('request 实际 500 走本地分类，不出现厂商文案', async () => {
    const error = await request({
      profile: local,
      apiKey: '',
      body: { model: 'flux-3-image-klein', messages: [] },
      fetchImpl: async () => new Response('CUDA out of memory', { status: 500 }),
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GatewayError);
    const info = (error as GatewayError).info;
    expect(info.title).toContain('本地模型');
    expect(info.advice).not.toContain('状态页');
  });
});

describe('本地参考图压缩上限（C）', () => {
  it('本地档案走 2MB/1024 保守档；云端未声明 longEdge 不改变', () => {
    // 不把本地保守档塞进内置档案，避免改变既有能力声明；store 按 isLocalProfile 兜底
    expect(isLocalProfile(local)).toBe(true);
    expect(LOCAL_REFERENCE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(LOCAL_REFERENCE_MAX_LONG_EDGE).toBe(1024);
    expect(cloud.capabilities.reference?.maxLongEdge).toBeUndefined();
  });
});
