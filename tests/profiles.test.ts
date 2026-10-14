import { describe, expect, it } from 'vitest';
import {
  MODEL_PROFILES,
  findProfile,
  DEFAULT_T2I_PROFILE_ID,
  DEFAULT_REFERENCE_PROFILE_ID,
} from '../src/data/models/profiles';
import { buildMappedImagePayload, flavorOf } from '../src/services/gateway';
import type { ModelProfile } from '../src/types/model';

/**
 * 模型档案的完整性与可维护性（v0.26）
 *
 * ===========================================================================
 * 这组测试盯的是「档案填错」这一类事故
 * ===========================================================================
 * 档案是纯数据，写得对不对编译不报错——所以只能靠测试守。
 * 而填错的代价很实在：用户看到「测试连接」失败，却不知道该怪谁。
 *
 * 已经发生过的真实事故：生成时误把**界面显示名**当成模型名传过去，
 * 于是「测试连接通过、一生成就报错」。第一条测试就是它的护栏。
 */

describe('档案完整性 · 不能有空模型名', () => {
  it('**每个档案都必须有非空的 model**（显示名不能当模型名用）', () => {
    for (const profile of MODEL_PROFILES) {
      // 千帆是唯一例外：模型名未能从官方文档核实，故意留空并已在界面上说明。
      if (profile.id === 'qianfan-chat') {
        expect(profile.model).toBe('');
        expect(profile.notes).toContain('未能核实');
        continue;
      }
      expect(profile.model, `${profile.id} 缺少 model 字段`).toBeTruthy();
      expect(profile.model!.trim().length, `${profile.id} 的 model 是空白`).toBeGreaterThan(0);
    }
  });

  it('模型名不能等于显示名（那正是那次事故）', () => {
    for (const profile of MODEL_PROFILES) {
      if (!profile.model) continue;
      expect(profile.model, `${profile.id} 的 model 与 name 相同，可疑`).not.toBe(profile.name);
    }
  });

  it('不用显示名里的中文当模型名', () => {
    for (const profile of MODEL_PROFILES) {
      if (!profile.model) continue;
      // 模型名是厂商侧的标识符，不该含中日韩字符
      expect(profile.model, `${profile.id} 的 model 含中文`).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});

describe('档案完整性 · 其他必填项', () => {
  it('id 不重复', () => {
    const ids = MODEL_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个档案都有 endpoint、provider、name', () => {
    for (const profile of MODEL_PROFILES) {
      expect(profile.name.length, `${profile.id} 缺 name`).toBeGreaterThan(0);
      expect(profile.provider.length, `${profile.id} 缺 provider`).toBeGreaterThan(0);
      expect(profile.endpoint, `${profile.id} 缺 endpoint`).toMatch(/^https:\/\//);
    }
  });

  it('声明可直连的档案必须写明证据来源', () => {
    for (const profile of MODEL_PROFILES) {
      if (profile.corsDirect !== 'yes') continue;
      expect(profile.notes ?? '', `${profile.id} 标了可直连却没写证据`).toMatch(
        /实测|预检|ACAO/,
      );
    }
  });

  it('未实测确认的档案要么没有，要么注明「未能核实」', () => {
    for (const profile of MODEL_PROFILES) {
      if (profile.group !== 'llm-experimental' && profile.group !== 't2i-experimental') continue;
      expect(profile.notes ?? '', `${profile.id} 未实测却没说明`).toMatch(
        /未能核实|未实测|存疑/,
      );
    }
  });

  it('默认档案必须存在', () => {
    expect(findProfile(DEFAULT_T2I_PROFILE_ID)).toBeDefined();
    expect(findProfile(DEFAULT_REFERENCE_PROFILE_ID)).toBeDefined();
  });

  it('默认出图档案必须支持参考图（否则 L3 锚定全废）', () => {
    const profile = findProfile(DEFAULT_REFERENCE_PROFILE_ID)!;
    expect(profile.capabilities.referenceImage).toBe(true);
    expect(profile.capabilities.maxReferenceImages).toBeGreaterThan(0);
  });
});

describe('分组 · 诚实标注', () => {
  it('每个档案都有分组', () => {
    for (const profile of MODEL_PROFILES) {
      expect(profile.group, `${profile.id} 没有分组`).toBeDefined();
    }
  });

  it('分组与类型一致（对话的不会分到出图档）', () => {
    for (const profile of MODEL_PROFILES) {
      const group = profile.group!;
      if (profile.type === 'llm') expect(group.startsWith('llm-')).toBe(true);
      if (profile.type === 't2i') expect(group.startsWith('t2i-')).toBe(true);
    }
  });

  it('已有至少 4 个对话档案与 4 个出图档案（扩充的目标）', () => {
    expect(MODEL_PROFILES.filter((p) => p.type === 'llm').length).toBeGreaterThanOrEqual(4);
    expect(MODEL_PROFILES.filter((p) => p.type === 't2i').length).toBeGreaterThanOrEqual(4);
  });
});

describe('字段映射 · 各家字段名不同也能用', () => {
  function fake(overrides: Partial<ModelProfile>): ModelProfile {
    return {
      id: 'x',
      name: 'x',
      provider: 'x',
      type: 't2i',
      lang: 'en',
      endpoint: 'https://example.com',
      authType: 'bearer',
      corsDirect: 'yes',
      capabilities: {
        negativePrompt: false,
        seed: false,
        referenceImage: false,
        maxReferenceImages: 0,
        maxOutputImages: 1,
      },
      ...overrides,
    };
  }

  it('MiniMax：宽高比走 aspect_ratio，且不出现 size', () => {
    const profile = findProfile('minimax-image')!;
    const payload = buildMappedImagePayload(profile, {
      model: profile.model!,
      prompt: 'a red circle',
      aspectRatio: '16:9',
    });
    expect(payload.aspect_ratio).toBe('16:9');
    expect(payload.prompt).toBe('a red circle');
    // 这家的字段名与别家不同——这正是需要映射的原因
    expect('size' in payload).toBe(false);
    expect('text' in payload).toBe(false);
    expect('batch_size' in payload).toBe(false);
    expect('negative_prompt' in payload).toBe(false);
  });

  it('MiniMax：声明了不支持负向词，就不会带上那个字段', () => {
    const profile = findProfile('minimax-image')!;
    const payload = buildMappedImagePayload(profile, {
      model: profile.model!,
      prompt: 'x',
      negativePrompt: 'text, watermark',
    });
    expect('negative_prompt' in payload).toBe(false);
  });

  it('硅基流动：尺寸字段叫 image_size 而不是 size', () => {
    const profile = findProfile('siliconflow-image')!;
    const payload = buildMappedImagePayload(profile, {
      model: profile.model!,
      prompt: 'x',
      aspectRatio: '16:9',
    });
    expect(payload.image_size).toBe('1280x720');
    expect('size' in payload).toBe(false);
  });

  it('智谱：就是标准的 prompt + size', () => {
    const profile = findProfile('zhipu-image')!;
    const payload = buildMappedImagePayload(profile, {
      model: profile.model!,
      prompt: 'x',
    });
    expect(payload.prompt).toBe('x');
    expect(typeof payload.size).toBe('string');
  });

  it('没有映射的档案走 OpenAI 形状（不破坏既有行为）', () => {
    const profile = fake({});
    expect(profile.imagePayload).toBeUndefined();
    expect(flavorOf(profile)).toBe('openai');
  });
});

describe('已核实的下线信息写进了档案备注', () => {
  it('Kimi 档案提醒 moonshot-v1 已下线', () => {
    expect(findProfile('kimi-k3')!.notes).toContain('moonshot-v1');
    expect(findProfile('kimi-k3')!.notes).toContain('下线');
  });

  it('StepFun 档案说明它现在没有文生图', () => {
    const notes = findProfile('stepfun-chat')!.notes ?? '';
    expect(notes).toContain('没有文生图');
  });

  it('MiniMax 档案提醒旧 base URL 已失效', () => {
    const notes = findProfile('minimax-chat')!.notes ?? '';
    expect(notes).toContain('api.minimax.chat');
  });

  it('没有零一万物档案（它的 API 已返回 model_service_closed）', () => {
    const all = MODEL_PROFILES.map((p) => `${p.id} ${p.name} ${p.endpoint}`).join(' ');
    expect(all).not.toContain('lingyiwanwu');
  });

  it('没有火山方舟档案（预检过但实际响应无 ACAO，存疑）', () => {
    const all = MODEL_PROFILES.map((p) => p.endpoint).join(' ');
    expect(all).not.toContain('volces.com');
  });

  it('没有 OpenAI 档案（本机测不出，得不出 CORS 结论）', () => {
    const all = MODEL_PROFILES.map((p) => p.endpoint).join(' ');
    expect(all).not.toContain('api.openai.com');
  });
});
