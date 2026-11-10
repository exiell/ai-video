// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * store/theme.ts（v0.55 · 测试缺口 E2-②）
 *
 * ===========================================================================
 * 为什么选它
 * ===========================================================================
 * 它同样在「从未被测试 import」的 13 个文件里，而且逻辑里有几个容易坏的点：
 *  - 启动时要从 localStorage 读上次的主题，读到非法值必须退回默认，不能白屏；
 *  - applyTheme 要同时更新 `document.documentElement.dataset.theme` 与 localStorage；
 *  - 隐私模式/LocalStorage 被禁用时，写入抛异常也不能影响当前会话。
 *
 * 主题初始化在模块加载时执行，所以用 vi.resetModules() + 动态 import 模拟「重新打开页面」。
 */

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  delete document.documentElement.dataset.theme;
});

describe('主题初始化', () => {
  it('没有保存过时用默认 studio', async () => {
    const mod = await import('../src/store/theme');
    expect(mod.useTheme.getState().theme).toBe('studio');
    expect(document.documentElement.dataset.theme).toBe('studio');
  });

  it('保存过 night 时按 night 初始化', async () => {
    localStorage.setItem('aniguide.theme', 'night');
    const mod = await import('../src/store/theme');
    expect(mod.useTheme.getState().theme).toBe('night');
    expect(document.documentElement.dataset.theme).toBe('night');
  });

  it('**保存的是非法值时退回默认**（旧版本/被改坏的 localStorage）', async () => {
    localStorage.setItem('aniguide.theme', 'neon-disco');
    const mod = await import('../src/store/theme');
    expect(mod.useTheme.getState().theme).toBe('studio');
  });
});

describe('切换主题', () => {
  it('applyTheme 同时更新 dataset 与 localStorage', async () => {
    const mod = await import('../src/store/theme');
    mod.applyTheme('blueprint');
    expect(document.documentElement.dataset.theme).toBe('blueprint');
    expect(localStorage.getItem('aniguide.theme')).toBe('blueprint');
  });

  it('**localStorage 写入抛异常时不崩溃**（隐私模式）', async () => {
    const mod = await import('../src/store/theme');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'QuotaExceededError');
    });
    try {
      expect(() => mod.applyTheme('night')).not.toThrow();
      // 内存与 dataset 仍然应用了本次选择
      expect(document.documentElement.dataset.theme).toBe('night');
    } finally {
      spy.mockRestore();
    }
  });

  it('setTheme 切换后 state 与 DOM 一致', async () => {
    const mod = await import('../src/store/theme');
    mod.useTheme.getState().setTheme('night');
    expect(mod.useTheme.getState().theme).toBe('night');
    expect(document.documentElement.dataset.theme).toBe('night');
    expect(localStorage.getItem('aniguide.theme')).toBe('night');
  });
});
