import { getDesktopApi, type NativeFileFilter } from './index';

export interface ExportSaveOutcome {
  saved: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

function filtersForFile(fileName: string): NativeFileFilter[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip')) {
    return [{ name: 'ZIP 压缩包', extensions: ['zip'] }];
  }
  if (lower.endsWith('.json')) {
    return [{ name: 'JSON 文件', extensions: ['json'] }];
  }
  if (lower.endsWith('.md')) {
    return [{ name: 'Markdown 文档', extensions: ['md'] }];
  }
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp')) {
    return [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp'] }];
  }
  return [{ name: '所有文件', extensions: ['*'] }];
}

/**
 * 双端统一文件保存：
 * - 桌面端（Electron）：弹出系统原生「另存为」窗口并返回落盘路径；
 * - Web 端：沿用 <a download> + Blob URL 触发浏览器下载。
 */
export async function saveExportFile(
  fileName: string,
  payload: Uint8Array | string,
  mimeType = 'application/octet-stream',
): Promise<ExportSaveOutcome> {
  const api = getDesktopApi();
  if (api) {
    const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const result = await api.file.saveBinary({
      defaultName: fileName,
      filters: filtersForFile(fileName),
      bytes,
    });
    if (result.canceled) return { saved: false, canceled: true };
    if (result.error) return { saved: false, error: result.error };
    return {
      saved: true,
      ...(result.filePath ? { filePath: result.filePath } : {}),
    };
  }

  const blob =
    typeof payload === 'string'
      ? new Blob([payload], { type: mimeType })
      : new Blob([payload.slice().buffer as ArrayBuffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { saved: true };
}

/** 桌面端在系统文件管理器中定位并高亮已保存的文件 */
export async function revealSavedFile(filePath: string): Promise<void> {
  const api = getDesktopApi();
  if (api && filePath) {
    await api.file.revealInFolder(filePath);
  }
}
