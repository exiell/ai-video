// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 代理口令的存储语义（v0.54 · P2-4）
 *
 * ===========================================================================
 * 为什么它要和 API Key 一样
 * ===========================================================================
 * 代理口令也是凭据：拿到它就能蹭用户的代理额度。原来的实现把它塞在 prefs 里，
 * 每次改设置都整份写进 localStorage，**完全不看「不保存到本机」那个勾**。
 * 用户勾了不保存、并且确认 Key 已经清掉，屏幕上却还能看到代理口令、
 * 磁盘上的 JSON 里也还留着它——等于「不保存」只做了一半。
 *
 * 现在规则统一为：
 *  - 不勾：跟其它偏好一起存 localStorage；
 *  - 勾了：localStorage 里置空，真值只进 sessionStorage（关掉浏览器即失效）；
 *  - 升级前已经落在磁盘上的口令，在勾选状态下加载时会被清掉。
 *
 * 这些用例必须用 `vi.resetModules()` 重新导入模块来模拟「重新打开页面」，
 * 所以单独一个文件，避免污染其它测试的模块实例（原因见 settingsMigration.test.ts）。
 */

type SettingsModule = typeof import('../src/store/settings');

const PREF_KEY = 'aniguide:prefs';
const SESSION_PROXY_KEY = 'aniguide:proxy-password:session';

async function loadSettings(
  prefs: Record<string, unknown> | null,
  sessionProxyPassword?: string,
): Promise<SettingsModule> {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  if (prefs) localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  if (sessionProxyPassword !== undefined) {
    sessionStorage.setItem(SESSION_PROXY_KEY, JSON.stringify({ proxyPassword: sessionProxyPassword }));
  }
  return import('../src/store/settings');
}

function diskPrefs(): Record<string, unknown> {
  const raw = localStorage.getItem(PREF_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sessionPassword(): string | null {
  const raw = sessionStorage.getItem(SESSION_PROXY_KEY);
  if (!raw) return null;
  return (JSON.parse(raw) as { proxyPassword?: string }).proxyPassword ?? null;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('默认（保存到本机）', () => {
  it('口令跟其它偏好一起写入 localStorage', async () => {
    const mod = await loadSettings({});
    mod.useSettings.getState().setPref('proxyPassword', 'pwd-on-disk');

    expect(diskPrefs().proxyPassword).toBe('pwd-on-disk');
    expect(sessionPassword()).toBeNull();
  });
});

describe('勾「不保存到本机」之后', () => {
  it('**当场把磁盘上的旧口令移进会话存储**', async () => {
    const mod = await loadSettings({ dontSaveKeys: false, proxyPassword: 'disk-old' });
    expect(mod.useSettings.getState().prefs.proxyPassword).toBe('disk-old');

    mod.useSettings.getState().setPref('dontSaveKeys', true);

    // 磁盘上被抹掉，会话里还在（当前这次打开仍然能用，符合「关掉浏览器失效」）
    expect(diskPrefs().proxyPassword).toBe('');
    expect(sessionPassword()).toBe('disk-old');
    expect(mod.useSettings.getState().prefs.proxyPassword).toBe('disk-old');
  });

  it('**之后填的口令只进会话存储**', async () => {
    const mod = await loadSettings({ dontSaveKeys: true });
    mod.useSettings.getState().setPref('proxyPassword', 'session-new');

    expect(diskPrefs().proxyPassword).toBe('');
    expect(sessionPassword()).toBe('session-new');
  });

  it('重新打开页面（重新导入模块）仍能从会话存储读到口令', async () => {
    // 模拟「同一个标签页刷新」：localStorage 里没有口令，sessionStorage 里有
    const mod = await loadSettings({ dontSaveKeys: true }, 'session-kept');

    expect(mod.useSettings.getState().prefs.proxyPassword).toBe('session-kept');
    expect(diskPrefs().proxyPassword ?? '').toBe('');
  });

  it('**升级前残留在磁盘上的口令，在勾选状态下加载时被清掉**', async () => {
    const mod = await loadSettings({ dontSaveKeys: true, proxyPassword: 'leaked-on-disk' }, 'session-pwd');

    expect(mod.useSettings.getState().prefs.proxyPassword).toBe('session-pwd');
    expect(diskPrefs().proxyPassword).toBe('');
  });

  it('取消勾选后，口令回到磁盘并清掉会话副本', async () => {
    const mod = await loadSettings({ dontSaveKeys: true }, 'session-pwd');

    mod.useSettings.getState().setPref('dontSaveKeys', false);

    expect(diskPrefs().proxyPassword).toBe('session-pwd');
    expect(sessionPassword()).toBeNull();
  });
});
