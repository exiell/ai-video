// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 设置项的向后兼容（方案.md §7.6.22）
 *
 * ===========================================================================
 * 为什么这些测试要**单独一个文件**
 * ===========================================================================
 * 它们要验证的是「模块初始化时读到了什么」，所以必须用 `vi.resetModules()`
 * 重新导入一次 store。而 resetModules 会让后续 import 拿到**新的模块实例** ——
 * 放在别的测试文件里会把同文件后续的测试搞坏
 * （症状是莫名其妙的「磁盘配额已满」「expected null not to be null」，
 *   看起来像被测代码坏了，其实是测试之间互相污染）。
 *
 * 单独一个文件，污染范围就只有这个文件。
 */
describe('🔴 从旧版升级：安全设置不能被静默放宽', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('**旧版没勾「记住到本机」的用户，升级后仍然不落盘**', async () => {
    // 旧语义：rememberKeys 缺失/false = 用户没有要求留在本机。
    // 新默认是「保存」，如果直接套用它，等于把用户当初那个
    // 「不长期留在磁盘上」的选择静默撤销了 —— 安全设置不该被静默放宽。
    vi.resetModules();
    localStorage.setItem('aniguide:prefs', JSON.stringify({ rememberKeys: false }));
    const mod = await import('../src/store/settings');
    expect(mod.useSettings.getState().prefs.dontSaveKeys).toBe(true);
  });

  it('**旧版勾过「记住到本机」的用户，升级后保持保存**', async () => {
    vi.resetModules();
    localStorage.setItem('aniguide:prefs', JSON.stringify({ rememberKeys: true }));
    const mod = await import('../src/store/settings');
    expect(mod.useSettings.getState().prefs.dontSaveKeys).toBe(false);
  });

  it('全新用户拿到新默认值（不保存 = false）', async () => {
    vi.resetModules();
    // 完全没有 prefs 记录
    const mod = await import('../src/store/settings');
    expect(mod.useSettings.getState().prefs.dontSaveKeys).toBe(false);
  });

  it('已经是新格式时不会被旧字段覆盖', async () => {
    vi.resetModules();
    localStorage.setItem(
      'aniguide:prefs',
      JSON.stringify({ rememberKeys: false, dontSaveKeys: false }),
    );
    const mod = await import('../src/store/settings');
    expect(mod.useSettings.getState().prefs.dontSaveKeys).toBe(false);
  });
});
