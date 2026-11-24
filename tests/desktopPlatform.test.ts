// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRuntimePlatform, isDesktopApp, type AniGuideDesktopAPI } from '../src/platform';
import { resolvePlatformFetch } from '../src/platform/transport';
import { saveExportFile } from '../src/platform/fileExport';
import { classifyError } from '../src/services/gateway';
import { applyTheme, THEME_CHROME_MAP, type Theme } from '../src/store/theme';

function installMockDesktopApi(overrides: Partial<AniGuideDesktopAPI> = {}): AniGuideDesktopAPI {
  const api: AniGuideDesktopAPI = {
    isDesktop: true,
    platform: 'win32',
    appVersion: '0.1.0',
    http: {
      request: vi.fn(async () => ({
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({ ok: true }),
      })),
      abort: vi.fn(),
    },
    file: {
      saveBinary: vi.fn(async () => ({ canceled: false, filePath: 'C:\\Exports\\demo.zip' })),
      revealInFolder: vi.fn(async () => undefined),
      openUserDataDir: vi.fn(async () => undefined),
    },
    secrets: {
      isAvailable: vi.fn(async () => true),
      get: vi.fn(async () => null),
      set: vi.fn(async () => true),
      delete: vi.fn(async () => true),
    },
    window: {
      syncThemeChrome: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(async () => undefined),
    },
    ...overrides,
  };
  window.aniguideDesktop = api;
  return api;
}

afterEach(() => {
  delete window.aniguideDesktop;
});

describe('Electron 桌面端平台适配层（DESK-001）', () => {
  it('Web 环境下 isDesktopApp 返回 false 且平台为 web', () => {
    expect(isDesktopApp()).toBe(false);
    expect(getRuntimePlatform()).toBe('web');
  });

  it('桌面环境下 isDesktopApp 返回 true 并正确识别平台', () => {
    installMockDesktopApi({ platform: 'darwin' });
    expect(isDesktopApp()).toBe(true);
    expect(getRuntimePlatform()).toBe('darwin');
  });

  it('桌面环境下 resolvePlatformFetch 经主进程 IPC 转发并支持 AbortSignal', async () => {
    const api = installMockDesktopApi();
    const desktopFetch = resolvePlatformFetch();
    const res = await desktopFetch('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(api.http.request).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      desktopFetch('https://api.example.com/v1/models', { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('调用方显式注入 fetchImpl 时优先使用注入实现（不破坏单测桩）', () => {
    installMockDesktopApi();
    const stub = vi.fn() as unknown as typeof fetch;
    expect(resolvePlatformFetch(stub)).toBe(stub);
  });

  it('桌面环境下 saveExportFile 调用原生另存为并返回路径', async () => {
    const api = installMockDesktopApi();
    const outcome = await saveExportFile('demo.zip', new Uint8Array([1, 2, 3]), 'application/zip');
    expect(outcome).toEqual({ saved: true, filePath: 'C:\\Exports\\demo.zip' });
    expect(api.file.saveBinary).toHaveBeenCalledTimes(1);
  });

  it('桌面环境下切换全部 5 套主题都会同步 titleBarOverlay 配色', () => {
    const api = installMockDesktopApi();
    const themes: Theme[] = ['prism', 'pop', 'studio', 'night', 'blueprint'];
    for (const theme of themes) {
      applyTheme(theme);
      expect(api.window.syncThemeChrome).toHaveBeenCalledWith(THEME_CHROME_MAP[theme]);
    }
  });

  it('桌面环境下 TypeError 分类为 network 而非浏览器 CORS 错误', () => {
    const webInfo = classifyError(new TypeError('Failed to fetch'));
    expect(webInfo.kind).toBe('cors');

    installMockDesktopApi();
    const desktopInfo = classifyError(new TypeError('net::ERR_CONNECTION_REFUSED'));
    expect(desktopInfo.kind).toBe('network');
    expect(desktopInfo.title).not.toContain('浏览器');
  });
});
