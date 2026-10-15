import { describe, expect, it } from 'vitest';
import {
  AUTO_APPLY_MAX_EDITS,
  decideGate,
  isEditable,
} from '../src/domain/chat/edits';

/**
 * 闸门分级（方案.md §7.6.20）
 *
 * ===========================================================================
 * 为什么这个逻辑值得单独测
 * ===========================================================================
 * 它是「AI 要不要先问用户」的唯一判据。判错了有两个方向的坏结果：
 *
 *  - 太松：AI 一口气改十几个地方不问 → 用户失去掌控感，而这正是
 *    「AI 改稿」这类功能最常见的投诉
 *  - 太严：每改一句话都弹确认框 → 用户开始无脑点同意。
 *    Anthropic 的实测数字是**批准率 93%**，也就是说确认框此时
 *    提供的安全感是假的
 *
 * 所以规则必须**可预测、可解释**：用户看完理由应该能猜到
 * 「下次它会不会问我」。测的就是这条。
 */

describe('闸门分级', () => {
  it('**单点小改直接应用**（这是默认路径，也是省事的关键）', () => {
    const d = decideGate({ editCount: 1, scope: 'single', touchedTargets: 1 });
    expect(d.gate).toBe('auto');
    expect(d.why).toContain('可以撤销');
  });

  it('两三处、同一对象 → 仍然直接应用', () => {
    const d = decideGate({ editCount: 3, scope: 'single', touchedTargets: 1 });
    expect(d.gate).toBe('auto');
  });

  it(`超过 ${AUTO_APPLY_MAX_EDITS} 处 → 要求确认`, () => {
    const d = decideGate({ editCount: AUTO_APPLY_MAX_EDITS + 1, scope: 'single', touchedTargets: 1 });
    expect(d.gate).toBe('confirm');
    expect(d.why).toContain('条数比较多');
  });

  it('**改到多个不同对象 → 要求确认**（哪怕只有两条）', () => {
    const d = decideGate({ editCount: 2, scope: 'single', touchedTargets: 2 });
    expect(d.gate).toBe('confirm');
    expect(d.why).toContain('2 个不同的地方');
  });

  it('**模型自称要联动改 → 一律要求确认**', () => {
    // 联动改动之间有关联，逐条看反而会漏掉整体效果，
    // 所以哪怕只有一条也要给用户过目
    const d = decideGate({ editCount: 1, scope: 'related', touchedTargets: 1 });
    expect(d.gate).toBe('confirm');
    expect(d.why).toContain('连带影响');
  });

  it('联动 + 多条 → 依然是确认（不会因为条数少就放行）', () => {
    const d = decideGate({ editCount: 2, scope: 'related', touchedTargets: 2 });
    expect(d.gate).toBe('confirm');
  });

  it('只要不是联动且范围小，理由里都会说明「为什么这次不问你」', () => {
    // 用户应该永远知道「它这次没问我是有理由的」，而不是觉得它偷偷改了
    for (const n of [1, 2, 3]) {
      const d = decideGate({ editCount: n, scope: 'single', touchedTargets: 1 });
      expect(d.gate, `${n} 处`).toBe('auto');
      expect(d.why, `${n} 处`).toBeTruthy();
      expect(d.why).toMatch(/撤销|直接改/);
    }
  });

  it('要确认时，理由说清是哪一条规则触发的', () => {
    const cases = [
      decideGate({ editCount: 9, scope: 'single', touchedTargets: 1 }),
      decideGate({ editCount: 2, scope: 'single', touchedTargets: 3 }),
      decideGate({ editCount: 1, scope: 'related', touchedTargets: 1 }),
    ];
    for (const d of cases) {
      expect(d.gate).toBe('confirm');
      expect(d.why.length, '理由不能是一句空话').toBeGreaterThan(5);
    }
  });

  it('零改动不会走到这里（调用方负责拦住），但也不该崩', () => {
    expect(() => decideGate({ editCount: 0, scope: 'single', touchedTargets: 0 })).not.toThrow();
  });
});

describe('闸门与白名单是两道独立的关', () => {
  it('**白名单与闸门互不替代**：一条改动可以先过闸门、再被白名单挡住', () => {
    // 闸门决定「要不要问用户」，白名单决定「准不准改」。
    // 两者都必须存在：只靠闸门，用户点同意就能改坏结构；
    // 只靠白名单，用户会被问烦。
    expect(isEditable('shot', 'action')).toBe(true);
    // 这是个引用字段 —— 即便用户点了同意也不该能改
    expect(isEditable('shot', 'sceneId')).toBe(false);
  });
});
