import { app, BrowserWindow, ipcMain } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ThemeChromeOptions } from '../../src/platform/types';

export interface PersistedWindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
  chrome: ThemeChromeOptions;
}

const DEFAULT_CHROME: ThemeChromeOptions = {
  bg: '#080b16',
  overlayColor: '#0d1224',
  symbolColor: '#f1f5ff',
};

const DEFAULT_STATE: PersistedWindowState = {
  width: 1360,
  height: 860,
  chrome: DEFAULT_CHROME,
};

function stateFilePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

export function loadWindowState(): PersistedWindowState {
  try {
    const raw = readFileSync(stateFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedWindowState>;
    const width = typeof parsed.width === 'number' && parsed.width >= 1024 ? Math.floor(parsed.width) : DEFAULT_STATE.width;
    const height = typeof parsed.height === 'number' && parsed.height >= 680 ? Math.floor(parsed.height) : DEFAULT_STATE.height;
    const chrome: ThemeChromeOptions = {
      bg: typeof parsed.chrome?.bg === 'string' ? parsed.chrome.bg : DEFAULT_CHROME.bg,
      overlayColor:
        typeof parsed.chrome?.overlayColor === 'string'
          ? parsed.chrome.overlayColor
          : DEFAULT_CHROME.overlayColor,
      symbolColor:
        typeof parsed.chrome?.symbolColor === 'string'
          ? parsed.chrome.symbolColor
          : DEFAULT_CHROME.symbolColor,
    };
    return {
      width,
      height,
      ...(typeof parsed.x === 'number' ? { x: Math.floor(parsed.x) } : {}),
      ...(typeof parsed.y === 'number' ? { y: Math.floor(parsed.y) } : {}),
      ...(typeof parsed.isMaximized === 'boolean' ? { isMaximized: parsed.isMaximized } : {}),
      chrome,
    };
  } catch {
    return { ...DEFAULT_STATE, chrome: { ...DEFAULT_CHROME } };
  }
}

export function saveWindowState(state: PersistedWindowState): void {
  try {
    writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // 忽略只读或磁盘受限场景
  }
}

export function registerWindowChromeIpc(
  getWindow: () => BrowserWindow | null,
  stateRef: PersistedWindowState,
): void {
  ipcMain.on('aniguide:window:syncThemeChrome', (_event, opts: ThemeChromeOptions) => {
    if (!opts || typeof opts.bg !== 'string') return;
    stateRef.chrome = {
      bg: opts.bg,
      overlayColor: opts.overlayColor || opts.bg,
      symbolColor: opts.symbolColor || '#f1f5ff',
    };
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    try {
      win.setBackgroundColor(stateRef.chrome.bg);
      if (process.platform !== 'darwin' && typeof win.setTitleBarOverlay === 'function') {
        win.setTitleBarOverlay({
          color: stateRef.chrome.overlayColor,
          symbolColor: stateRef.chrome.symbolColor,
          height: 40,
        });
      }
    } catch {
      // 某些 Linux 桌面环境不支持 titleBarOverlay，静默降级
    }
    saveWindowState(stateRef);
  });
}
