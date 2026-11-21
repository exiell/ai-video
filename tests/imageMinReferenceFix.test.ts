import { describe, expect, it, vi } from 'vitest';
import { generateImages } from '../src/services/image/generate';
import { classifyError } from '../src/services/gateway';
import { findProfile } from '../src/data/models/profiles';
import { customModelToProfile, validateCustomModel } from '../src/data/customModels';
import { QWEN_IMAGE_EDIT_PRESET } from '../src/data/models/imageProfiles';
import type { ModelProfile } from '../src/types/model';

const local = findProfile('local-flux3')!;
const cloud = findProfile('deepseek-chat')!;

function profileWithMin(min: number): ModelProfile {
  return { ...local, capabilities: { ...local.capabilities, minReferenceImages: min } };
}

function responseWithImage(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,OUT' } }] } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('最少参考图能力', () => {
  it('min 越界/大于 max 校验拒绝；合法 min 映射到 ModelProfile', () => {
    const base = {
      name: '改图',
      modality: 'image' as const,
      protocol: 'vllm-omni-chat-image' as const,
      baseUrl: 'http://127.0.0.1:8098/v1',
      model: 'qwen-image-edit-2511',
      requiresKey: false,
      capabilities: { maxReferenceImages: 3, minReferenceImages: 1 },
    };
    expect(validateCustomModel(base).ok).toBe(true);
    const profile = customModelToProfile({
      ...base,
      id: 'edit',
      createdAt: '2026-01-01T00:00:00.000Z',
      capabilities: { maxReferenceImages: 3, minReferenceImages: 2 },
    });
    expect(profile.capabilities.minReferenceImages).toBe(2);

    expect(validateCustomModel({ ...base, capabilities: { maxReferenceImages: 3, minReferenceImages: 4 } }).ok).toBe(false);
    expect(validateCustomModel({ ...base, capabilities: { maxReferenceImages: 3, minReferenceImages: -1 } }).ok).toBe(false);
    // max=0 时不声明 min，避免「0 张也要求 1 张」
    const noRefs = validateCustomModel({ ...base, capabilities: { maxReferenceImages: 0, minReferenceImages: 1 } });
    expect(noRefs.ok).toBe(true);
    expect(noRefs.normalized?.capabilities?.minReferenceImages).toBeUndefined();
  });

  it('参考图不足时 generate 提前拒绝，transport/fetch 完全不调用', async () => {
    const fetchImpl = vi.fn(async () => responseWithImage());
    const outcome = await generateImages({
      profile: profileWithMin(1),
      apiKey: '',
      req: { prompt: 'edit', count: 1, referenceImages: [] },
      fetchImpl,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('至少 1 张参考图');
    expect(outcome.error).toContain('当前 0 张');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('达到 min 后放行并正常出图', async () => {
    const fetchImpl = vi.fn(async () => responseWithImage());
    const outcome = await generateImages({
      profile: profileWithMin(1),
      apiKey: '',
      req: { prompt: 'edit', count: 1, referenceImages: ['data:image/png;base64,IN'] },
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome.images).toHaveLength(1);
  });

  it('本地 500 Missing preprocess images → 至少 1 张参考图人话并保留 raw；其它 500 不变', () => {
    const info = classifyError(undefined, 500, '{"error":{"message":"Missing preprocess images..."}}', local);
    expect(info.title).toContain('至少 1 张参考图');
    expect(info.advice).toContain('改图');
    expect(info.raw).toContain('Missing preprocess images');
    const oom = classifyError(undefined, 500, '{"error":{"message":"CUDA out of memory"}}', local);
    expect(oom.title).not.toContain('参考图');
    expect(oom.title).toContain('显存');
    const cloudInfo = classifyError(undefined, 500, '{"error":{"message":"Missing preprocess images..."}}', cloud);
    expect(cloudInfo.title).toContain('厂商服务端出错');
    expect(cloudInfo.title).not.toContain('参考图');
  });

  it('Qwen-Image-Edit 快捷预设字段正确', () => {
    expect(QWEN_IMAGE_EDIT_PRESET).toMatchObject({
      modality: 'image',
      protocol: 'vllm-omni-chat-image',
      baseUrl: 'http://127.0.0.1:8098/v1',
      model: 'qwen-image-edit-2511',
      requiresKey: false,
      timeoutMs: 600_000,
      capabilities: { maxReferenceImages: 3, minReferenceImages: 1, maxOutputImages: 1 },
    });
  });
});
