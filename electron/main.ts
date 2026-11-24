import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { registerFileIOIpc } from './ipc/fileIO';
import { registerNetProxyIpc } from './ipc/netProxy';
import { registerSecretsIpc } from './ipc/secrets';
import { loadWindowState, registerWindowChromeIpc, saveWindowState, type PersistedWindowState } from './ipc/windowChrome';

const isDev = Boolean(process.env['ELECTRON_RENDERER_URL']);
let mainWindow: BrowserWindow | null = null;
let windowState: PersistedWindowState;

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function createMainWindow(): BrowserWindow {
  windowState = loadWindowState();

  const win = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(windowState.x !== undefined && windowState.y !== undefined
      ? { x: windowState.x, y: windowState.y }
      : {}),
    minWidth: 1024,
    minHeight: 680,
    show: false,
    icon: path.join(__dirname, '../dist/favicon.png'),
    backgroundColor: windowState.chrome.bg,
    title: 'AniGuide · AI 动漫视频创作向导',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 12 } }
      : {
          titleBarOverlay: {
            color: windowState.chrome.overlayColor,
            symbolColor: windowState.chrome.symbolColor,
            height: 40,
          },
        }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--aniguide-version=${app.getVersion()}`],
    },
  });

  if (windowState.isMaximized) {
    win.maximize();
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  const persistBounds = (): void => {
    if (win.isDestroyed()) return;
    windowState.isMaximized = win.isMaximized();
    if (!win.isMaximized() && !win.isMinimized()) {
      const bounds = win.getBounds();
      windowState.width = bounds.width;
      windowState.height = bounds.height;
      windowState.x = bounds.x;
      windowState.y = bounds.y;
    }
    saveWindowState(windowState);
  };

  win.on('resize', persistBounds);
  win.on('move', persistBounds);
  win.on('close', persistBounds);

  // 所有外链统一交由系统默认浏览器打开，不在 Electron 内弹出空白窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 禁止页面内意外导航离开本地应用
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
  });

  // 桌面级上下文菜单：仅在可编辑区或选中文本时弹出，其他 UI 区域屏蔽浏览器默认右键菜单
  win.webContents.on('context-menu', (_event, params) => {
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ]).popup({ window: win });
      return;
    }
    if (params.selectionText && params.selectionText.trim().length > 0) {
      Menu.buildFromTemplate([{ role: 'copy', label: '复制' }]).popup({ window: win });
    }
  });

  // 生产环境禁止误触 F5 / Ctrl+R 整页刷新
  if (!isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      const isReload =
        input.key === 'F5' ||
        ((input.control || input.meta) && input.key.toLowerCase() === 'r');
      if (isReload) {
        event.preventDefault();
      }
    });
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    if (process.platform !== 'darwin') {
      Menu.setApplicationMenu(null);
    }

    registerNetProxyIpc();
    registerFileIOIpc(() => mainWindow);
    registerSecretsIpc();
    ipcMain.handle('aniguide:shell:openExternal', async (_event, url: string) => {
      if (isSafeExternalUrl(url)) {
        await shell.openExternal(url);
      }
    });

    mainWindow = createMainWindow();
    registerWindowChromeIpc(() => mainWindow, windowState);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
