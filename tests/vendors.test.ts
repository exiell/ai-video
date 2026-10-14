// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { VENDORS, modelsOfVendor, vendorCors, findVendor, vendorHasType } from '../src/data/models/vendors';
import { MODEL_PROFILES, findProfile } from '../src/data/models/profiles';

/**
 * 厂商层（v0.27）
 *
 * ===========================================================================
 * 为什么要有「厂商」这一层
 * ===========================================================================
 * API Key 是**厂商级**的，不是模型级的。同一个厂商下的对话模型与出图模型
 * 共用一个 Key——原来的结构把 Key 挂在模型档案上，于是智谱、MiniMax、
 * 硅基流动各出现两个 Key 输入框，而它们其实是同一个 Key。
 *
 * 这组测试盯两件事：
 *  1. 分层是否自洽（每个档案都属于某个厂商、厂商的结论一致）
 *  2. **旧数据迁移不能丢 Key**——那等于把用户填的东西删了
 */

describe('厂商与模型的分层', () => {
  it('每个档案都归属某个厂商', () => {
    for (const profile of MODEL_PROFILES) {
      expect(profile.vendorId, `${profile.id} 没有 vendorId`).toBeTruthy();
      expect(findVendor(profile.vendorId), `${profile.id} 的 vendorId 找不到对应厂商`).toBeDefined();
    }
  });

  it('厂商 id 不重复', () => {
    const ids = VENDORS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个厂商至少有一个模型（否则不该出现在设置页）', () => {
    for (const vendor of VENDORS) {
      expect(modelsOfVendor(vendor.id).length, `${vendor.id} 一个模型都没有`).toBeGreaterThan(0);
    }
  });

  it('每个厂商都有申请 Key 的控制台地址', () => {
    for (const vendor of VENDORS) {
      expect(vendor.consoleUrl, `${vendor.id} 缺 consoleUrl`).toMatch(/^https:\/\//);
      expect(vendor.name.length).toBeGreaterThan(0);
    }
  });

  it('**同一个厂商只有一个 vendorId**——不能拿显示名当标识符', () => {
    // 真实踩过的坑：同一个硅基流动被写成「SiliconFlow」与「硅基流动 SiliconFlow」
    // 两种 provider 名。provider 是给人看的自由文本，vendorId 才是标识符。
    const byProvider = new Map<string, Set<string>>();
    for (const p of MODEL_PROFILES) {
      const set = byProvider.get(p.provider) ?? new Set<string>();
      set.add(p.vendorId!);
      byProvider.set(p.provider, set);
    }
    for (const [provider, vendorIds] of byProvider) {
      expect(vendorIds.size, `provider「${provider}」对应了多个 vendorId`).toBe(1);
    }
  });

  it('一个 vendorId 下的档案可以跨类型（智谱与 MiniMax 都是）', () => {
    expect(vendorHasType('zhipu', 'llm')).toBe(true);
    expect(vendorHasType('zhipu', 't2i')).toBe(true);
    expect(vendorHasType('minimax', 'llm')).toBe(true);
    expect(vendorHasType('minimax', 't2i')).toBe(true);
  });

  it('只有对话的厂商不会假装有出图', () => {
    expect(vendorHasType('moonshot', 't2i')).toBe(false);
    expect(vendorHasType('stepfun', 't2i')).toBe(false);
    expect(vendorHasType('qianfan', 't2i')).toBe(false);
  });
});

describe('厂商级直连结论', () => {
  it('有任一模型实测确认，厂商就算可直连（同一个域名）', () => {
    expect(vendorCors('zhipu')).toBe('yes');
    expect(vendorCors('dashscope')).toBe('yes');
    expect(vendorCors('minimax')).toBe('yes');
  });

  it('不存在的厂商返回 unknown，不假装知道', () => {
    expect(vendorCors('不存在的厂商')).toBe('unknown');
  });

  it('所有厂商的直连结论都写明了证据', () => {
    for (const vendor of VENDORS) {
      if (vendor.corsDirect !== 'yes') continue;
      expect(vendor.notes ?? '', `${vendor.id} 标了可直连却没写证据`).toMatch(
        /实测|预检|ACAO|可直连/,
      );
    }
  });
});

describe('Key 迁移 · 不能把用户填的东西删掉', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  /**
   * 迁移发生在 store 模块初始化时，所以要在写入旧格式之后
   * 动态 import 一次拿到新的 store 实例。
   * 用 `vi.resetModules()` 让模块重新执行。
   */
  async function loadStoreWith(rawKeys: Record<string, string>) {
    const { vi } = await import('vitest');
    vi.resetModules();
    localStorage.setItem('aniguide:keys', JSON.stringify(rawKeys));
    const mod = await import('../src/store/settings');
    return mod.useSettings;
  }

  it('**旧的档案级 Key 会被搬到厂商级**（否则用户以为 Key 丢了）', async () => {
    const store = await loadStoreWith({ 'deepseek-flash': 'sk-old' });
    expect(store.getState().keys['deepseek']).toBe('sk-old');
  });

  it('同一厂商下有多个旧档案时，取第一个非空的', async () => {
    const store = await loadStoreWith({
      'qwen-image': 'sk-qwen',
      'qwen-image-edit': 'sk-qwen',
    });
    expect(store.getState().keys['dashscope']).toBe('sk-qwen');
  });

  it('迁移后会写回存储，不需要每次启动都重算', async () => {
    await loadStoreWith({ 'kimi-k3': 'sk-kimi' });
    const stored = JSON.parse(localStorage.getItem('aniguide:keys') ?? '{}') as Record<string, string>;
    expect(stored['moonshot']).toBe('sk-kimi');
  });

  it('已经是新格式时原样保留，不重复迁移', async () => {
    const store = await loadStoreWith({ deepseek: 'sk-new' });
    expect(store.getState().keys['deepseek']).toBe('sk-new');
  });

  it('新旧混在一起时，新的优先（不拿旧值覆盖新值）', async () => {
    const store = await loadStoreWith({
      deepseek: 'sk-new',
      'deepseek-flash': 'sk-old',
    });
    expect(store.getState().keys['deepseek']).toBe('sk-new');
  });

  it('不认识的键被丢弃，不会污染状态', async () => {
    const store = await loadStoreWith({ '从来不存在的东西': 'sk-x' });
    expect(store.getState().keys['从来不存在的东西']).toBeUndefined();
  });

  it('空值不会被迁移过去（空的旧 Key 不该覆盖任何东西）', async () => {
    const store = await loadStoreWith({ 'deepseek-flash': '   ' });
    expect(store.getState().keys['deepseek']).toBeUndefined();
  });

  it('没有旧数据时不崩', async () => {
    const store = await loadStoreWith({});
    expect(store.getState().keys).toEqual({});
  });
});

describe('默认档案指向存在的模型', () => {
  it('默认对话与默认出图都能在档案表里找到', async () => {
    const { useSettings } = await import('../src/store/settings');
    const prefs = useSettings.getState().prefs;
    expect(findProfile(prefs.defaultLlmProfileId)).toBeDefined();
    expect(findProfile(prefs.defaultReferenceProfileId)).toBeDefined();
  });

  it('默认出图档案必须支持参考图', () => {
    const profile = findProfile('qwen-image-edit')!;
    expect(profile.capabilities.referenceImage).toBe(true);
  });
});
