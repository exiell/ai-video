import type { AniGuideDesktopAPI, ThemeChromeOptions } from './types';

export type {
  AniGuideDesktopAPI,
  NativeFileFilter,
  NativeHttpRequest,
  NativeHttpResponse,
  SaveBinaryOptions,
  SaveBinaryResult,
  ThemeChromeOptions,
} from './types';

/** 获取 Electron 桌面桥接对象；在普通浏览器或测试环境中返回 undefined */
export function getDesktopApi(): AniGuideDesktopAPI | undefined {
  if (typeof window === 'undefined') return undefined;
  const api = window.aniguideDesktop;
  return api && api.isDesktop === true ? api : undefined;
}

/** 当前是否运行在 Electron 桌面客户端中 */
export function isDesktopApp(): boolean {
  return getDesktopApi() !== undefined;
}

/** 桌面端运行平台；非桌面端返回 'web' */
export function getRuntimePlatform(): 'win32' | 'darwin' | 'linux' | 'web' {
  return getDesktopApi()?.platform ?? 'web';
}

/** 应用版本号（桌面端来自 package.json / Electron app.getVersion） */
export function getAppVersion(): string {
  return getDesktopApi()?.appVersion ?? '0.1.0';
}

/** 同步桌面窗口背景与 titleBarOverlay 配色；Web 端为空操作 */
export function syncDesktopThemeChrome(opts: ThemeChromeOptions): void {
  try {
    getDesktopApi()?.window.syncThemeChrome(opts);
  } catch {
    // 窗口尚未就绪或非桌面环境时静默忽略
  }
}

/** 桌面端通过系统默认浏览器打开外链；Web 端交由 window.open 处理 */
export async function openExternalUrl(url: string): Promise<void> {
  const api = getDesktopApi();
  if (api) {
    await api.shell.openExternal(url);
    return;
  }
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
