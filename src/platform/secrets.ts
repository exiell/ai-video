import { getDesktopApi } from './index';

/**
 * 桌面端密钥加密存储桥接（基于 Electron safeStorage）。
 *
 * 用于将厂商 API Key 同步备份至系统凭据加密区（Windows DPAPI / macOS Keychain），
 * 同时保持与既有同步 store 的无缝兼容。
 */
export async function isNativeSecretStorageAvailable(): Promise<boolean> {
  const api = getDesktopApi();
  if (!api) return false;
  try {
    return await api.secrets.isAvailable();
  } catch {
    return false;
  }
}

export async function readNativeSecret(key: string): Promise<string | null> {
  const api = getDesktopApi();
  if (!api) return null;
  try {
    return await api.secrets.get(key);
  } catch {
    return null;
  }
}

export async function writeNativeSecret(key: string, value: string): Promise<boolean> {
  const api = getDesktopApi();
  if (!api) return false;
  try {
    return await api.secrets.set(key, value);
  } catch {
    return false;
  }
}

export async function deleteNativeSecret(key: string): Promise<boolean> {
  const api = getDesktopApi();
  if (!api) return false;
  try {
    return await api.secrets.delete(key);
  } catch {
    return false;
  }
}
