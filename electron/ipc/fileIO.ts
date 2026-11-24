import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SaveBinaryOptions, SaveBinaryResult } from '../../src/platform/types';

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
}
