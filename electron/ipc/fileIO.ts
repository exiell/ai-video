import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CacheMediaOptions,
  CacheMediaResult,
  SaveBinaryOptions,
  SaveBinaryResult,
} from '../../src/platform/types';

function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80);
  return cleaned || fallback;
}

let lastSaveDir: string | undefined;

export function registerFileIOIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('aniguide:file:saveBinary', async (_event, opts: SaveBinaryOptions): Promise<SaveBinaryResult> => {
    try {
      const win = getWindow();
      const baseDir = lastSaveDir ?? app.getPath('documents');
      const defaultPath = path.join(baseDir, path.basename(opts.defaultName || 'aniguide-export.zip'));

      const saveOptions: Electron.SaveDialogOptions = {
        title: '保存导出文件',
        defaultPath,
        ...(opts.filters && opts.filters.length > 0 ? { filters: opts.filters } : {}),
      };

      const picked = win
        ? await dialog.showSaveDialog(win, saveOptions)
        : await dialog.showSaveDialog(saveOptions);

      if (picked.canceled || !picked.filePath) {
        return { canceled: true };
      }

      const bytes = opts.bytes instanceof Uint8Array ? opts.bytes : new Uint8Array(opts.bytes);
      await writeFile(picked.filePath, bytes);
      lastSaveDir = path.dirname(picked.filePath);

      return {
        canceled: false,
        filePath: picked.filePath,
      };
    } catch (error) {
      return {
        canceled: false,
        error: error instanceof Error ? error.message : '保存文件失败',
      };
    }
  });

  ipcMain.handle('aniguide:file:revealInFolder', async (_event, filePath: string): Promise<void> => {
    if (typeof filePath === 'string' && filePath.trim().length > 0) {
      shell.showItemInFolder(filePath);
    }
  });

  ipcMain.handle('aniguide:file:openUserDataDir', async (): Promise<void> => {
    await shell.openPath(app.getPath('userData'));
  });

  /** 静默将生成的视频与尾帧缓存到本机项目目录（防止云端短期链接过期，同时供剪辑软件直读） */
  ipcMain.handle(
    'aniguide:file:cacheMedia',
    async (_event, opts: CacheMediaOptions): Promise<CacheMediaResult> => {
      try {
        const safeProject = sanitizeSegment(opts.projectId || 'default', 'default');
        const safeName = sanitizeSegment(path.basename(opts.fileName || 'clip.mp4'), 'clip.mp4');
        const dir = path.join(app.getPath('userData'), 'media', safeProject);
        await mkdir(dir, { recursive: true });
        const targetPath = path.join(dir, safeName);
        const bytes = opts.bytes instanceof Uint8Array ? opts.bytes : new Uint8Array(opts.bytes);
        await writeFile(targetPath, bytes);
        return { ok: true, filePath: targetPath };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : '缓存本地媒体文件失败',
        };
      }
    },
  );
}
