import { app, ipcMain, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function secretsFilePath(): string {
  return path.join(app.getPath('userData'), 'secrets.enc.json');
}

async function readStore(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(secretsFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch {
    // 首次运行尚无文件
  }
  return {};
}

async function writeStore(store: Record<string, string>): Promise<void> {
  await writeFile(secretsFilePath(), JSON.stringify(store, null, 2), 'utf8');
}

export function registerSecretsIpc(): void {
  ipcMain.handle('aniguide:secrets:isAvailable', () => safeStorage.isEncryptionAvailable());

  ipcMain.handle('aniguide:secrets:get', async (_event, key: string): Promise<string | null> => {
    if (!key || !safeStorage.isEncryptionAvailable()) return null;
    try {
      const store = await readStore();
      const encoded = store[key];
      if (!encoded) return null;
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch {
      return null;
    }
  });

  ipcMain.handle('aniguide:secrets:set', async (_event, key: string, value: string): Promise<boolean> => {
    if (!key || !safeStorage.isEncryptionAvailable()) return false;
    try {
      const store = await readStore();
      store[key] = safeStorage.encryptString(value).toString('base64');
      await writeStore(store);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('aniguide:secrets:delete', async (_event, key: string): Promise<boolean> => {
    if (!key) return false;
    try {
      const store = await readStore();
      if (key in store) {
        delete store[key];
        await writeStore(store);
      }
      return true;
    } catch {
      return false;
    }
  });
}
