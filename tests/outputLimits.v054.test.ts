import { describe, expect, it } from 'vitest';
import { assetsSchema, shotsSchema, storySchema } from '../src/services/llm/schemas';
import { chatReplySchema } from '../src/services/llm/chat';
import {
  MAX_EDITS,
} from '../src/domain/chat/edits';
import {
  generateShots,
  generateStory,
  type GenerateContext,
} from '../src/services/llm/generate';
import { askModel } from '../src/services/llm/chat';
import { MODEL_PROFILES } from '../src/data/models/profiles';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 模型输出的长度上限与请求预算（v0.54 · P2-1）
 *
 * ===========================================================================
 * 为什么模型输出也要设上限
 * ===========================================================================
 * 模型输出是外部输入。用户的请求可以经过自己填的代理，代理返回什么长度都不可信：
 *  - 超长数组：zod 会为**每个非法元素**生成一条 issue，这是 CVE-2023-54404 的机制
 *  - 超长字符串：会被原样存进项目 / IndexedDB
 *  - 请求不设 `max_tokens`：输出上限完全交给端点决定
 *
 * 这里不测「拒绝后 UI 长什么样」（那是页面的事），只测数据层的三道闸：
 * schema `.max()`、请求体里的 `max_tokens`。
 */

const llm = MODEL_PROFILES.find((profile) => profile.type === 'llm')!;

function ctx(fetchImpl: typeof fetch, maxAttempts = 1): GenerateContext {
  return { profile: llm, apiKey: 'sk-test', model: 'deepseek-chat', fetchImpl, maxAttempts };
}

/** 记录每次请求体的假 fetch；返回的内容由调用方给 */
function capturingFetch(responseContent: string): { fetchImpl: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: responseContent } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

function validStoryJson(): string {
  return JSON.stringify({
    body: '一个短故事',
    charactersNote: '',
    setting: '',
    conflict: '',
    ending: '',
    scenes: [],
  });
}

describe('schema .max() · 数组上限', () => {
  it('分镜超过 200 个被拒绝', () => {
    const shots = Array.from({ length: 201 }, (_, index) => ({
      duration: 3,
      shotSize: 'medium',
      cameraMove: 'static',
      startState: `起点 ${index}`,
      action: `动作 ${index}`,
      endState: `终点 ${index}`,
      sceneSlug: 'scene-a',
    }));
    expect(shotsSchema.safeParse({ shots }).success).toBe(false);
  });

  it('角色 / 场景各超过 50 个被拒绝', () => {
    const characters = Array.from({ length: 51 }, (_, index) => ({
      slug: `character-${index}`,
      name: `角色 ${index}`,
      identity: { summaryEn: 'a character' },
    }));
    const scenes = Array.from({ length: 51 }, (_, index) => ({
      slug: `scene-${index}`,
      name: `场景 ${index}`,
      identity: { summaryEn: 'a place' },
    }));
    expect(assetsSchema.safeParse({ characters, scenes: [] }).success).toBe(false);
    expect(assetsSchema.safeParse({ characters: [], scenes }).success).toBe(false);
  });

  it('故事场次超过 50 个被拒绝', () => {
    const scenes = Array.from({ length: 51 }, (_, index) => ({
      label: `第 ${index} 场`,
      summary: '',
    }));
    expect(storySchema.safeParse({ body: 'x', scenes }).success).toBe(false);
  });

  it('聊天改动超过 MAX_EDITS 条被拒绝', () => {
    const edits = Array.from({ length: MAX_EDITS + 1 }, () => ({
      target: { kind: 'shot' as const, id: 's1', field: 'action' },
      title: '改动作',
      after: '新动作',
    }));
    expect(chatReplySchema.safeParse({ reply: '好', edits }).success).toBe(false);
  });

  it('恰好在上限内的正常输出仍然通过（不能把闸门设成误杀）', () => {
    expect(storySchema.safeParse({ body: 'x', scenes: [] }).success).toBe(true);
    expect(shotsSchema.safeParse({ shots: [] }).success).toBe(false); // 分镜至少 1 个
    expect(
      chatReplySchema.safeParse({
        reply: '好',
        edits: [{ target: { kind: 'shot', id: 's1', field: 'action' }, title: '改动作', after: '新动作' }],
      }).success,
    ).toBe(true);
  });
});

describe('schema .max() · 超长文本', () => {
  it('故事正文超过 2 万字符被拒绝', () => {
    expect(storySchema.safeParse({ body: '字'.repeat(20_001) }).success).toBe(false);
  });

  it('分镜动作超过 5000 字符被拒绝', () => {
    const shot = {
      duration: 3,
      shotSize: 'medium',
      cameraMove: 'static',
      startState: '起点',
      action: '动'.repeat(5_001),
      endState: '终点',
      sceneSlug: 'scene-a',
    };
    expect(shotsSchema.safeParse({ shots: [shot] }).success).toBe(false);
  });

  it('聊天回复超过 8000 字符被拒绝', () => {
    expect(chatReplySchema.safeParse({ reply: '字'.repeat(8_001) }).success).toBe(false);
  });
});

describe('生成请求带 max_tokens（输出预算）', () => {
  it('**写故事请求带 3000 上限**', async () => {
    const { fetchImpl, bodies } = capturingFetch(validStoryJson());
    await generateStory(sampleProject, ctx(fetchImpl));
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(body.max_tokens).toBe(3_000);
  });

  it('**拆分镜请求带 8000 上限**', async () => {
    const { fetchImpl, bodies } = capturingFetch('不是 JSON');
    await generateShots(sampleProject, ctx(fetchImpl));
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(body.max_tokens).toBe(8_000);
  });

  it('聊天改稿请求带 4000 上限', async () => {
    const { fetchImpl, bodies } = capturingFetch('不是 JSON');
    await askModel(ctx(fetchImpl), [{ role: 'user', content: '把第三镜动作改具体' }]);
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(body.max_tokens).toBe(4_000);
  });
});
