// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 存储持久化申请 & Key 的内存清理（v0.55 · P3-9 / P3-15）
 *
 * ===========================================================================
 * 两件小事，但都会影响「数据到底保不保得住」
 * ===========================================================================
 * 1. 浏览器默认的 IndexedDB 是「可回收」存储：磁盘紧、长期不访问都可能被清掉。
 *    `navigator.storage.persist()` 可以申请「不自动回收」，但浏览器可能直接拒绝，
 *    所以只能尽力申请一次、失败静默，绝不能因此影响保存流程。
 * 2. `forgetKeys` 原来只删 localStorage/sessionStorage，内存 state 里还留着 Key：
 *    设置页继续显示、当前会话还能用，用户会以为「不保存到本机」没生效。
 *    现在磁盘与内存一起清。
 */

function stubNavigatorStorage(
  persistImpl: () => Promise<boolean> = async () => true,
): ReturnType<typeof vi.fn> {
  const persist = vi.fn(persistImpl);
  Object.defineProperty(navigator, 'storage', {
    value: { persist, estimate: async () => ({ usage: 0, quota: 0 }) },
    configurable: true,
  });
  return persist;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
});

describe('requestPersistentStorage · 尽力但不打扰', () => {
  it('**只申请一次**：返回 true 后再次调用不再问浏览器，返回 false', async () => {
    const persist = stubNavigatorStorage(async () => true);
    const storage = await import('../src/services/storage/index');

    await expect(storage.requestPersistentStorage()).resolves.toBe(true);
    await expect(storage.requestPersistentStorage()).resolves.toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('浏览器拒绝 / 抛异常时静默失败，不抛给调用方', async () => {
    stubNavigatorStorage(async () => {
      throw new Error('not allowed');
    });
    const storage = await import('../src/services/storage/index');
    await expect(storage.requestPersistentStorage()).resolves.toBe(false);
  });

  it('环境里没有 storage.persist（jsdom 早期/隐私模式）时返回 false', async () => {
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
    const storage = await import('../src/services/storage/index');
    await expect(storage.requestPersistentStorage()).resolves.toBe(false);
  });
});

describe('forgetKeys · 磁盘与内存一起清', () => {
  it('**调用后内存 keys 为空**，localStorage/sessionStorage 也清空', async () => {
    const settings = await import('../src/store/settings');
    settings.useSettings.getState().setKey('dashscope', 'sk-in-memory');
    expect(settings.useSettings.getState().keys.dashscope).toBe('sk-in-memory');
    expect(localStorage.getItem('aniguide:keys')).not.toBeNull();

    settings.useSettings.getState().forgetKeys();

    expect(settings.useSettings.getState().keys).toEqual({});
    expect(localStorage.getItem('aniguide:keys')).toBeNull();
    expect(sessionStorage.getItem('aniguide:keys:session')).toBeNull();
  });

  it('勾「不保存到本机」时，内存里的 Key 也当场清掉', async () => {
    const settings = await import('../src/store/settings');
    settings.useSettings.getState().setKey('dashscope', 'sk-should-be-gone');
    settings.useSettings.getState().setPref('dontSaveKeys', true);

    expect(settings.useSettings.getState().keys).toEqual({});
    expect(localStorage.getItem('aniguide:keys')).toBeNull();
  });
});
