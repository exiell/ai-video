// @vitest-environment jsdom
// 这个文件验证的是「图有没有真的安全落地」——涉及 IndexedDB 与 FileReader，
// 用 mock 顶替就等于没验证 TTL 那个坑。
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDashScopeContent, withReferenceInstruction } from '../src/services/gateway/dashscope';
import {
  generateImages,
  prefetchImage,
  toAssets,
  type PrefetchedImage,
} from '../src/services/image/generate';
import {
  assetsByteSize,
  deleteAsset,
  listAssets,
  listAssetsFor,
  saveAssets,
} from '../src/services/storage';
import {
  buildCharacterSheetPrompt,
  buildFramePrompt,
  buildScenePlatePrompt,
  consistencyAdvice,
} from '../src/domain/image/prompts';
import { MODEL_PROFILES, findProfile, DEFAULT_REFERENCE_PROFILE_ID } from '../src/data/models/profiles';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Asset, ImageRequest, ModelProfile } from '../src/types/model';

const qwen = findProfile('qwen-image')!;
const qwenEdit = findProfile('qwen-image-edit')!;

/** 造一个假的预取结果，避免测试真的去下载图片 */
function fakePrefetch(tag: string): PrefetchedImage {
  const payload = `ZmFrZS0${tag}`;
  return {
    dataUrl: `data:image/png;base64,${payload}`,
    byteSize: 12,
    mimeType: 'image/png',
  };
}

function imageResponse(...urls: string[]): string {
  return JSON.stringify({
    output: {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: urls.map((url) => ({ image: url })),
          },
        },
      ],
    },
    request_id: 'req-abc',
  });
}

function fakeFetch(body: string, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    }) as unknown as Response) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------

describe('参考图 · 请求体构造', () => {
  it('没有参考图时 content 只有文字', () => {
    const content = buildDashScopeContent('一只猫');
    expect(content).toEqual([{ text: '一只猫' }]);
  });

  it('有参考图时图片排在文字之前（官方示例的顺序）', () => {
    const content = buildDashScopeContent('换一身衣服', ['data:image/png;base64,AAA']);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ image: 'data:image/png;base64,AAA' });
    expect(content[1]).toEqual({ text: '换一身衣服' });
  });

  it('接受 base64 data URI 与公网 URL 两种形式', () => {
    const content = buildDashScopeContent('x', [
      'data:image/png;base64,AAA',
      'https://example.com/a.png',
    ]);
    expect(content[0]).toEqual({ image: 'data:image/png;base64,AAA' });
    expect(content[1]).toEqual({ image: 'https://example.com/a.png' });
  });

  it('空白参考图被忽略，不会产生空对象', () => {
    expect(buildDashScopeContent('x', ['', '   '])).toEqual([{ text: 'x' }]);
  });

  it('补的「保留面部特征」指令是官方示例的同义写法', () => {
    const result = withReferenceInstruction('a cat', 1);
    expect(result).toContain('facial features');
    expect(result).toContain('a cat');
  });

  it('没有参考图时不补指令', () => {
    expect(withReferenceInstruction('a cat', 0)).toBe('a cat');
  });
});

describe('出图 · 落地流程', () => {
  const baseReq: ImageRequest = { prompt: '一只猫', aspectRatio: '1:1', count: 1 };

  it('出图成功后每张图都带 dataUrl（否则就是定时炸弹）', async () => {
    const outcome = await generateImages({
      profile: qwen,
      apiKey: 'sk-test',
      req: baseReq,
      fetchImpl: fakeFetch(imageResponse('https://oss/a.png')),
      prefetchImpl: async () => fakePrefetch('a'),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.images).toHaveLength(1);
    expect(outcome.images[0]!.dataUrl).toMatch(/^data:image\/png;base64,/);
    // 临时链接也保留，供排查用
    expect(outcome.images[0]!.url).toBe('https://oss/a.png');
  });

  it('请求体用的是 DashScope 结构，且带上参考图', async () => {
    let captured = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = String(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => imageResponse('https://oss/a.png'),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await generateImages({
      profile: qwenEdit,
      apiKey: 'sk-test',
      req: { ...baseReq, referenceImages: ['data:image/png;base64,REF'] },
      fetchImpl,
      prefetchImpl: async () => fakePrefetch('a'),
    });

    const body = JSON.parse(captured) as {
      model: string;
      input: { messages: { content: Record<string, string>[] }[] };
    };
    expect(body.model).toBe('qwen-image-3.0-pro');
    const content = body.input.messages[0]!.content;
    expect(content[0]).toEqual({ image: 'data:image/png;base64,REF' });
    // 传了参考图就必须补上「保留面部特征」的指令
    expect(content[1]!.text).toContain('facial features');
  });

  it('参考图数量超限时截断并如实告知，而不是静默丢弃', async () => {
    const outcome = await generateImages({
      profile: qwenEdit,
      apiKey: 'sk-test',
      req: {
        ...baseReq,
        referenceImages: ['a', 'b', 'c', 'd', 'e'],
      },
      fetchImpl: fakeFetch(imageResponse('https://oss/a.png')),
      prefetchImpl: async () => fakePrefetch('a'),
    });
    expect(outcome.warnings.some((w) => w.includes('最多接受'))).toBe(true);
  });

  it('档案不支持参考图时给出警告并降级为纯文生图', async () => {
    const textOnly: ModelProfile = {
      ...qwen,
      capabilities: { ...qwen.capabilities, referenceImage: false, maxReferenceImages: 0 },
    };
    const outcome = await generateImages({
      profile: textOnly,
      apiKey: 'sk-test',
      req: { ...baseReq, referenceImages: ['data:image/png;base64,X'] },
      fetchImpl: fakeFetch(imageResponse('https://oss/a.png')),
      prefetchImpl: async () => fakePrefetch('a'),
    });
    expect(outcome.warnings.some((w) => w.includes('不支持参考图'))).toBe(true);
  });

  it('单张下载失败不影响其余图片，但会留下警告', async () => {
    let call = 0;
    const outcome = await generateImages({
      profile: qwen,
      apiKey: 'sk-test',
      req: baseReq,
      fetchImpl: fakeFetch(imageResponse('https://oss/a.png', 'https://oss/b.png')),
      prefetchImpl: async () => {
        call += 1;
        if (call === 1) throw new Error('网络中断');
        return fakePrefetch('b');
      },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.images).toHaveLength(2);
    expect(outcome.images[0]!.dataUrl).toBeUndefined();
    expect(outcome.images[1]!.dataUrl).toBeDefined();
    expect(outcome.warnings.some((w) => w.includes('24 小时'))).toBe(true);
  });

  it('接口通了但没返回图片地址时，给的是可读原因而不是空结果', async () => {
    const outcome = await generateImages({
      profile: qwen,
      apiKey: 'sk-test',
      req: baseReq,
      fetchImpl: fakeFetch(JSON.stringify({ output: { choices: [] } })),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('没有返回图片地址');
  });

  it('网关报错被翻成人话', async () => {
    const failing = (async () =>
      ({
        ok: false,
        status: 401,
        text: async () => '{"code":"InvalidApiKey","message":"Invalid API-key provided."}',
      }) as unknown as Response) as unknown as typeof fetch;

    const outcome = await generateImages({
      profile: qwen,
      apiKey: 'bad',
      req: baseReq,
      fetchImpl: failing,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('API Key');
  });
});

describe('出图 · 转成可持久化素材', () => {
  it('只收下已经落地的图，没落地的如实丢弃并报告', () => {
    const outcome = {
      ok: true,
      warnings: [],
      images: [
        { url: 'https://oss/a.png', dataUrl: 'data:image/png;base64,QUFB' },
        { url: 'https://oss/b.png' },
      ],
    };
    const { assets, dropped, warnings } = toAssets(outcome, {
      projectId: 'p1',
      kind: 'character-sheet',
      refId: 'ch-1',
      promptSnapshot: 'a cat',
      model: 'qwen-image-2.0-pro',
      lockPhrases: ['a red coat'],
      referenceCount: 0,
      seed: 42,
    });
    expect(assets).toHaveLength(1);
    expect(dropped).toBe(1);
    expect(warnings.some((w) => w.includes('24 小时'))).toBe(true);
    // 提示词快照与锁面必须留存，否则用户回看时不知道这张图怎么来的
    expect(assets[0]!.promptSnapshot).toBe('a cat');
    expect(assets[0]!.lockPhrases).toEqual(['a red coat']);
    expect(assets[0]!.sourceUrl).toBe('https://oss/a.png');
    // 长期引用是 dataUrl，不是会过期的 URL
    expect(assets[0]!.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('全部落地时没有丢弃、没有多余警告', () => {
    const { dropped, warnings } = toAssets(
      { ok: true, warnings: [], images: [{ url: 'u', dataUrl: 'data:image/png;base64,QUFB' }] },
      { projectId: 'p', kind: 'first-frame', refId: 's1', promptSnapshot: 'x' },
    );
    expect(dropped).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe('预取 · 下载并转 base64', () => {
  it('把图片转成 data URI 并给出字节数', async () => {
    const result = await prefetchImage('https://oss/a.png', {
      fetchImpl: fakeFetch('', 200),
    });
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.byteSize).toBeGreaterThan(0);
  });

  it('HTTP 失败时抛错，由调用方决定是否降级', async () => {
    await expect(
      prefetchImage('https://oss/a.png', { fetchImpl: fakeFetch('', 404) }),
    ).rejects.toThrow('404');
  });
});

describe('素材库 · 存取与统计', () => {
  beforeEach(async () => {
    const existing = await listAssets('p1');
    for (const asset of existing) await deleteAsset(asset.id);
  });

  function makeAsset(id: string, refId: string, bytes: number): Asset {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      id,
      projectId: 'p1',
      kind: 'character-sheet',
      refId,
      dataUrl: 'data:image/png;base64,QUFB',
      mimeType: 'image/png',
      promptSnapshot: 'x',
      byteSize: bytes,
    };
  }

  it('保存后能按项目读回', async () => {
    await saveAssets([makeAsset('a1', 'ch-1', 100), makeAsset('a2', 'ch-1', 200)]);
    expect(await listAssets('p1')).toHaveLength(2);
  });

  it('能按对象筛选（某个角色名下的图）', async () => {
    await saveAssets([makeAsset('a3', 'ch-1', 100), makeAsset('a4', 'sc-1', 100)]);
    expect(await listAssetsFor('p1', 'ch-1')).toHaveLength(1);
    expect(await listAssetsFor('p1', 'sc-1')).toHaveLength(1);
  });

  it('字节数统计用于设置页的用量提示', async () => {
    await saveAssets([makeAsset('a5', 'ch-1', 1500), makeAsset('a6', 'ch-1', 2500)]);
    expect(await assetsByteSize('p1')).toBe(4000);
  });

  it('空数组保存不会报错', async () => {
    await expect(saveAssets([])).resolves.toBeUndefined();
  });
});

describe('出图提示词 · 三种目标', () => {
  const project = sampleProject;

  it('角色定妆图要求三视图，并带上锁面与风格词', () => {
    const prompt = buildCharacterSheetPrompt(project, 'ch-linchong')!;
    expect(prompt.positive).toContain('turnaround');
    expect(prompt.positive).toContain('front view');
    for (const lock of project.characters[0]!.continuityLocks) {
      expect(prompt.positive).toContain(lock.phrase);
    }
    expect(prompt.positive).toContain(project.brief.styleTags[0]!);
    // 角色自己的负向词要合并进去
    expect(prompt.negative).toContain('smiling');
  });

  it('角色不存在时返回 null，而不是抛异常', () => {
    expect(buildCharacterSheetPrompt(project, '不存在')).toBeNull();
  });

  it('场景参考板刻意要求空无一人', () => {
    const prompt = buildScenePlatePrompt(project, 'sc-temple')!;
    expect(prompt.positive).toContain('no people');
    const scene = project.scenes.find((s) => s.id === 'sc-temple')!;
    for (const el of scene.fixedElements) {
      expect(prompt.positive).toContain(el);
    }
    expect(prompt.positive).toContain(scene.mainColor);
  });

  it('首帧只画起点，不把动作过程写进去', () => {
    const shot = project.shots.find((s) => s.id === 'shot-01')!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    expect(prompt.positive).toContain(shot.startState.slice(0, 20));
    // 动作属于视频阶段，不该出现在首帧里
    expect(prompt.positive).not.toContain(shot.action);
    expect(prompt.notes.some((n) => n.label.includes('首帧'))).toBe(true);
  });

  it('动作关键帧画的是动作顶点，不是起点也不是终点', () => {
    const shot = project.shots.find((s) => s.id === 'shot-01')!;
    const prompt = buildFramePrompt(project, shot.id, 'action-peak')!;
    // 顶点由「唯一动作」推导
    expect(prompt.positive).toContain(shot.action);
    expect(prompt.notes.some((n) => n.label.includes('动作关键帧'))).toBe(true);
  });

  it('尾帧只画终点', () => {
    const shot = project.shots.find((s) => s.id === 'shot-01')!;
    const prompt = buildFramePrompt(project, shot.id, 'end-frame')!;
    expect(prompt.positive).toContain(shot.endState.slice(0, 20));
    expect(prompt.notes.some((n) => n.label.includes('尾帧'))).toBe(true);
  });

  it('**三种帧产出不同的画面内容**，不是只换个名字', () => {
    const shot = project.shots.find((s) => s.id === 'shot-01')!;
    const first = buildFramePrompt(project, shot.id, 'first-frame')!;
    const peak = buildFramePrompt(project, shot.id, 'action-peak')!;
    const end = buildFramePrompt(project, shot.id, 'end-frame')!;
    expect(new Set([first.positive, peak.positive, end.positive]).size).toBe(3);
    expect(new Set([first.subjectLabel, peak.subjectLabel, end.subjectLabel]).size).toBe(3);
  });

  it('尾帧在有衔接说明时会把它带上——尾帧的职责就是让下一镜接得住', () => {
    const withNote = structuredClone(project);
    const shot = withNote.shots.find((s) => s.id === 'shot-01')!;
    shot.continuityNote = '他保持这个姿势，下一镜从同一机位推进';
    const prompt = buildFramePrompt(withNote, shot.id, 'end-frame')!;
    expect(prompt.notes.some((n) => n.label === '与下一镜的衔接')).toBe(true);
  });

  it('首帧只注入本镜声明生效的锁，不多带', () => {
    const shot = project.shots.find((s) => s.id === 'shot-03')!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    const lynchong = project.characters.find((c) => c.id === 'ch-linchong')!;
    for (const lock of lynchong.continuityLocks) {
      const active = shot.activeLockIds.includes(lock.id);
      expect(prompt.lockPhrases.includes(lock.phrase)).toBe(active);
    }
  });

  it('首帧的说明里写明了「终点的东西不能写进起点」', () => {
    const prompt = buildFramePrompt(project, 'shot-01', 'first-frame')!;
    const startNote = prompt.notes.find((n) => n.label.includes('首帧'))!;
    expect(startNote.reason).toContain('终点');
  });

  it('每条说明都有理由，不能只有标签', () => {
    for (const shot of project.shots) {
      for (const kind of ['first-frame', 'action-peak', 'end-frame'] as const) {
        const prompt = buildFramePrompt(project, shot.id, kind);
        if (!prompt) continue;
        for (const note of prompt.notes) {
          expect(note.reason.length).toBeGreaterThan(10);
        }
      }
    }
  });
});

describe('能力声明 · 如实告知能锁到哪一级', () => {
  it('支持参考图 → L3', () => {
    const advice = consistencyAdvice(qwen.capabilities, qwen.name);
    expect(advice.level).toBe('L3');
    expect(advice.hint).toContain('定妆图');
  });

  it('只支持种子 → L2，并明确说不支持参考图', () => {
    const advice = consistencyAdvice(
      { negativePrompt: true, seed: true, referenceImage: false, maxReferenceImages: 0, maxOutputImages: 1 },
      '某平台',
    );
    expect(advice.level).toBe('L2');
    expect(advice.summary).toContain('不支持参考图');
  });

  it('什么都不支持 → L1，不装作能锁住', () => {
    const advice = consistencyAdvice(
      { negativePrompt: false, seed: false, referenceImage: false, maxReferenceImages: 0, maxOutputImages: 1 },
      '某平台',
    );
    expect(advice.level).toBe('L1');
    expect(advice.hint).toContain('能改善多少算多少');
  });
});

describe('档案配置 · P0.5 相关', () => {
  it('存在专门的参考图档案，且声明了参考图能力', () => {
    expect(DEFAULT_REFERENCE_PROFILE_ID).toBe('qwen-image-edit');
    const profile = findProfile(DEFAULT_REFERENCE_PROFILE_ID)!;
    expect(profile.capabilities.referenceImage).toBe(true);
    expect(profile.capabilities.maxReferenceImages).toBeGreaterThan(0);
    expect(profile.model).toBe('qwen-image-3.0-pro');
  });

  it('所有出图档案都声明了图片链接有效期', () => {
    for (const profile of MODEL_PROFILES.filter((p) => p.type === 't2i')) {
      expect(profile.imageUrlTtlHours).toBeGreaterThan(0);
    }
  });

  it('每个档案都有完整的能力声明', () => {
    for (const profile of MODEL_PROFILES) {
      expect(profile.capabilities).toBeDefined();
      expect(typeof profile.capabilities.referenceImage).toBe('boolean');
      expect(typeof profile.capabilities.seed).toBe('boolean');
      expect(typeof profile.capabilities.negativePrompt).toBe('boolean');
    }
  });

  it('不支持参考图的档案，上限必须是 0（不能让界面以为能传）', () => {
    for (const profile of MODEL_PROFILES) {
      if (profile.capabilities.referenceImage) continue;
      expect(profile.capabilities.maxReferenceImages).toBe(0);
    }
  });
});

describe('预取实现的健壮性', () => {
  it('blob 没有 type 时兜底成 image/png', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        blob: async () => new Blob([new Uint8Array([1, 2, 3])]),
      }) as unknown as Response) as unknown as typeof fetch;
    const result = await prefetchImage('https://oss/a.png', { fetchImpl });
    expect(result.mimeType).toBe('image/png');
    expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('超时会中断请求，不会一直挂着', async () => {
    vi.useFakeTimers();
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    const promise = prefetchImage('https://oss/a.png', { fetchImpl: hanging, timeoutMs: 50 });
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// v0.28：出图链路必须对所有协议都走通
// ---------------------------------------------------------------------------

describe('出图 · 非 DashScope 提供方（这是一次真实漏测）', () => {
  /**
   * ===========================================================================
   * 这组测试的由来
   * ===========================================================================
   * 扩充提供方之后，新加的智谱 / MiniMax / 硅基流动出图**实际上是坏的**：
   *  - `generateImages` 自己拼了一份硬编码 OpenAI 形状的载荷，
   *    绕过了网关里读字段映射的那份构造
   *  - 响应又一律按 DashScope 的嵌套三层解析
   *  - 而网关那两个正确的函数（buildImagePayloadFor / extractImageUrlsFor）
   *    **全项目无人调用**
   *
   * 测试全绿是因为：profiles.test.ts 单独测了映射函数（过了），
   * image.test.ts 只走 DashScope 那条路。**两条平行实现，只测了其中一条。**
   *
   * 所以这组测试的作用是：**从真实入口 `generateImages` 出发，逐个协议验证**。
   */
  function captureFetch(responseBody: string) {
    let captured = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = String(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => responseBody,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, body: () => captured };
  }

  it('**MiniMax 收到的是 aspect_ratio，不是 size**（字段名与别家不同）', async () => {
    const profile = findProfile('minimax-image')!;
    const cap = captureFetch(JSON.stringify({ data: { image_urls: ['https://x/m.png'] } }));
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'a red circle', aspectRatio: '16:9' },
      fetchImpl: cap.fetchImpl,
      prefetchImpl: async () => fakePrefetch('m'),
    });

    expect(outcome.ok).toBe(true);
    const body = JSON.parse(cap.body()) as Record<string, unknown>;
    expect(body.aspect_ratio).toBe('16:9');
    expect('size' in body).toBe(false);
    expect('text' in body).toBe(false);
    expect('batch_size' in body).toBe(false);
  });

  it('**MiniMax 的响应从 data.image_urls 取到图**（不是 OpenAI 的 data[].url）', async () => {
    const profile = findProfile('minimax-image')!;
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'x' },
      fetchImpl: captureFetch(
        JSON.stringify({ data: { image_urls: ['https://x/one.png', 'https://x/two.png'] } }),
      ).fetchImpl,
      prefetchImpl: async () => fakePrefetch('m'),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.images).toHaveLength(2);
    expect(outcome.images[0]!.url).toBe('https://x/one.png');
    // 而且真的落地了（不是只留链接）
    expect(outcome.images[0]!.dataUrl).toContain('data:image/png');
  });

  it('智谱走标准 OpenAI 形状，响应从 data[].url 取', async () => {
    const profile = findProfile('zhipu-image')!;
    const cap = captureFetch(JSON.stringify({ data: [{ url: 'https://x/z.png' }] }));
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'x' },
      fetchImpl: cap.fetchImpl,
      prefetchImpl: async () => fakePrefetch('z'),
    });
    expect(outcome.ok).toBe(true);
    const body = JSON.parse(cap.body()) as Record<string, unknown>;
    expect(body.prompt).toBe('x');
    expect(typeof body.size).toBe('string');
    expect(outcome.images[0]!.url).toBe('https://x/z.png');
  });

  it('硅基流动的尺寸字段是 image_size', async () => {
    const profile = findProfile('siliconflow-image')!;
    const cap = captureFetch(JSON.stringify({ data: [{ url: 'https://x/s.png' }] }));
    await generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'x', aspectRatio: '16:9' },
      fetchImpl: cap.fetchImpl,
      prefetchImpl: async () => fakePrefetch('s'),
    });
    const body = JSON.parse(cap.body()) as Record<string, unknown>;
    expect(body.image_size).toBe('1280x720');
    expect('size' in body).toBe(false);
  });

  it('**参考图说明对所有支持参考图的协议都生效**，不只千问', async () => {
    // 原来这里加了 `&& flavor === 'dashscope-sync'`，
    // 把「千问需要这段说明」误解成了「只有千问才配有参考图」。
    const profile = findProfile('minimax-image')!;
    const cap = captureFetch(JSON.stringify({ data: { image_urls: ['https://x/m.png'] } }));
    await generateImages({
      profile,
      apiKey: 'sk-test',
      req: {
        prompt: 'a red circle',
        referenceImages: ['data:image/png;base64,REF'],
        frameRole: { kind: 'first-frame', hasFirstFrameAnchor: false },
      },
      fetchImpl: cap.fetchImpl,
      prefetchImpl: async () => fakePrefetch('m'),
    });
    const body = JSON.parse(cap.body()) as Record<string, unknown>;
    expect(String(body.prompt)).toContain('facial features');
    expect(String(body.prompt)).toContain('a red circle');
  });

  it('DashScope 仍然走它自己的协议（没有被改坏）', async () => {
    const profile = findProfile('qwen-image-edit')!;
    const cap = captureFetch(
      JSON.stringify({ output: { choices: [{ message: { content: [{ image: 'https://x/q.png' }] } }] } }),
    );
    const outcome = await generateImages({
      profile,
      apiKey: 'sk-test',
      req: { prompt: 'x', referenceImages: ['data:image/png;base64,REF'] },
      fetchImpl: cap.fetchImpl,
      prefetchImpl: async () => fakePrefetch('q'),
    });
    expect(outcome.ok).toBe(true);
    const body = JSON.parse(cap.body()) as {
      input: { messages: { content: Record<string, string>[] }[] };
    };
    // 参考图排在文字之前，且原样带上
    expect(body.input.messages[0]!.content[0]).toEqual({ image: 'data:image/png;base64,REF' });
    expect(outcome.images[0]!.url).toBe('https://x/q.png');
  });
});
