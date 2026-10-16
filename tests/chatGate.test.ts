import { describe, expect, it } from 'vitest';
import {
  MAX_EDITS,
  decideGate,
  isEditable,
} from '../src/domain/chat/edits';

/**
 * 闸门：**一律确认，不再有自动应用**（方案.md §7.6.25）
 *
 * ===========================================================================
 * 这组测试记录了一次设计反转，以及它为什么不矛盾
 * ===========================================================================
 * v0.31 时我把「定点小改」改成直接应用，依据是 Anthropic 公布的数据：
 * 用户对确认框的批准率是 **93%**，也就是说「每条都问 ≈ 没问」，
 * 安全性交给「可撤销」更实在。
 *
 * v0.35 用户明确要求改回「无论什么规模都要先确认」，并且说明了理由：
 * 这是创作工具，每次改动直接决定要花钱生成的成品，他确实会逐条看。
 *
 * **两条都不算错，因为场景不同**：
 *  - Anthropic 那条数据来自开发者 CLI —— 操作频繁、多数无害、
 *    批量处理是常态，所以逐条问会变成噪音
 *  - 这里是创作场景 —— 改动次数少、每条都影响成品、用户愿意细看
 *
 * 所以现在的取舍是：**宁可多问，不可擅自改**。
 * 测试钉住的是「当前的决定」，不是「这个决定永远对」。
 */

describe('闸门：一律确认', () => {
  it('**单条改动也要确认**（这就是 v0.35 的反转点）', () => {
    const d = decideGate({ editCount: 1 });
    expect(d.gate).toBe('confirm');
    expect(d.why).toBeTruthy();
  });

  it('多条改动同样确认', () => {
    for (const n of [2, 5, 20, MAX_EDITS]) {
      expect(decideGate({ editCount: n }).gate, `${n} 条`).toBe('confirm');
    }
  });

  it('**没有任何输入能让它变成自动应用**', () => {
    // 这条断言看着笨，但它钉住的正是「取消 auto 档」这件事：
    // 以后若有人想恢复自动应用，必须显式改掉这个测试，
    // 从而会看到上面那段「为什么改回来了」的说明。
    for (const n of [1, 2, 3, 10, 40, 100]) {
      expect(decideGate({ editCount: n }).gate).not.toBe('auto');
    }
  });

  it('零改动也不崩（调用方会拦住，但函数本身要安全）', () => {
    expect(() => decideGate({ editCount: 0 })).not.toThrow();
    expect(decideGate({ editCount: 0 }).gate).toBe('confirm');
  });

  it('理由要说清是「给你过目」而不是空话', () => {
    const one = decideGate({ editCount: 1 });
    const many = decideGate({ editCount: 12 });
    expect(one.why.length).toBeGreaterThan(5);
    expect(many.why).toContain('12');
    // 多条时要让用户先知道规模
    expect(many.why).toMatch(/过目|确认/);
  });
});

describe('一次能带多少条改动', () => {
  it('**上限放宽到 40**（原来 5 条，改情节根本表达不出来）', () => {
    // 用户要求支持「大段改情节，涉及多个镜头」，那天然会牵动十几条。
    // 5 条的上限会让这类需求没法表达 —— AI 只能挤牙膏式地给。
    expect(MAX_EDITS).toBeGreaterThanOrEqual(20);
  });

  it('上限仍然存在（防止模型失控输出几百条）', () => {
    expect(MAX_EDITS).toBeLessThanOrEqual(100);
  });
});

describe('闸门与白名单是两道独立的关', () => {
  it('内容字段可改', () => {
    expect(isEditable('shot', 'action')).toBe(true);
    expect(isEditable('scene', 'fixedElements')).toBe(true);
  });

  it('**引用字段可改**（v0.36 反转：能力问题不该用「不给能力」绕过）', () => {
    /*
      原来这里排除 sceneId / characterIds，理由是「改错了会挂到不存在的场景上」。
      那个理由经不起推敲：「让模型改引用」和「防止悬空引用」不冲突 ——
      前者是能力，后者是校验。我当时用「干脆不给能力」绕过了校验该做的事。

      代价很快暴露：用户让 AI 大改剧情，AI 新建了场景却无法挂到镜头上，
      于是「场景建了但没生效」。

      现在的做法是给能力 + 校验（validateFieldValue 检查目标存在）。
    */
    expect(isEditable('shot', 'sceneId')).toBe(true);
    expect(isEditable('shot', 'characterIds')).toBe(true);
  });

  it('**id 本身仍然不可改**（改它会让所有引用一起断掉）', () => {
    expect(isEditable('shot', 'id')).toBe(false);
    expect(isEditable('character', 'id')).toBe(false);
    expect(isEditable('character', 'shotIds')).toBe(false);
    expect(isEditable('shot', 'activeLockIds')).toBe(false);
  });
});
