import { getDesktopApi } from '../../platform';
import type { VideoClipRecord } from '../../types/video';

/**
 * 本地媒体自动落盘缓存（Phase 0）
 *
 * 解决两大生产隐患：
 * 1. 云端视频链接普遍短命（阿里云百炼 24h、MiniMax/Hailuo 72h、火山方舟限制下载次数）；
 * 2. 仅存浏览器 IndexedDB 时，外部剪辑软件（剪映 / 达芬奇 / Final Cut Pro）无法直接读取实体文件。
 *
 * 行为：
 * - 桌面端（Electron）：在轮询拿到成片 Blob 瞬间，经由安全 IPC 静默写入 `<userData>/media/<projectId>/`
 *   并回填 `localMediaPath`，同时保留 IndexedDB 副本；
 * - Web 端：Blob 已写入 IndexedDB 持久化，同时计算远端链接预计过期时间供界面提醒备份。
 */

export interface MediaCacheOutcome {
  cachedOnDisk: boolean;
  storageKind: 'desktop-disk' | 'browser-indexeddb';
  localMediaPath?: string;
  remoteUrlExpiresAt?: string;
  warning?: string;
}

/** 根据厂商/端点估算云端临时链接有效期（小时） */
export function remoteUrlTtlHours(vendorOrEndpoint: string): number {
  const lower = vendorOrEndpoint.toLowerCase();
  if (/dashscope|aliyuncs|bailian|wan/.test(lower)) return 24;
  if (/volces|ark|seedance|doubao/.test(lower)) return 24;
  if (/hailuo|minimax|apimart/.test(lower)) return 72;
  if (/kling/.test(lower)) return 48;
  return 24;
}

/** 计算云端链接预计过期 ISO 时间戳 */
export function estimateRemoteUrlExpiry(
  vendorOrEndpoint: string,
  createdAtIso = new Date().toISOString(),
): string {
  const baseMs = Date.parse(createdAtIso);
  const start = Number.isFinite(baseMs) ? baseMs : Date.now();
  const ttlHours = remoteUrlTtlHours(vendorOrEndpoint);
  return new Date(start + ttlHours * 3600 * 1000).toISOString();
}

/** 生成给创作者看的远端过期倒计时提示（用于 Web 端导出提醒） */
export function formatExpiryHint(expiresAtIso: string | undefined, nowMs = Date.now()): string | null {
  if (!expiresAtIso) return null;
  const target = Date.parse(expiresAtIso);
  if (!Number.isFinite(target)) return null;
  const remainMs = target - nowMs;
  if (remainMs <= 0) return '云端原链接预计已过期（本机已保留缓存副本，建议及时导出备份）';
  const hours = Math.ceil(remainMs / (3600 * 1000));
  return `本机已保留副本；云端原链接预计约 ${hours} 小时后失效`;
}

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(await new Response(blob).arrayBuffer());
}

/**
 * 将已下载的成片 Blob 自动缓存到桌面端本地目录（若运行在桌面端）。
 * 写入失败时绝不阻断主流程（IndexedDB 里的 Blob 依然安全），只返回 warning。
 */
export async function cacheVideoClipLocally(
  clip: Pick<VideoClipRecord, 'id' | 'projectId' | 'shotId' | 'blob' | 'createdAt'>,
  vendorOrEndpoint = '',
): Promise<MediaCacheOutcome> {
  const remoteUrlExpiresAt = estimateRemoteUrlExpiry(vendorOrEndpoint, clip.createdAt);
  const desktopApi = getDesktopApi();
  if (!desktopApi?.file?.cacheMedia) {
    return {
      cachedOnDisk: false,
      storageKind: 'browser-indexeddb',
      remoteUrlExpiresAt,
    };
  }

  try {
    const bytes = await blobToUint8Array(clip.blob);
    const fileName = `${clip.shotId}-${clip.id}.mp4`;
    const result = await desktopApi.file.cacheMedia({
      projectId: clip.projectId,
      fileName,
      bytes,
    });
    if (result.ok && result.filePath) {
      return {
        cachedOnDisk: true,
        storageKind: 'desktop-disk',
        localMediaPath: result.filePath,
        remoteUrlExpiresAt,
      };
    }
    return {
      cachedOnDisk: false,
      storageKind: 'browser-indexeddb',
      remoteUrlExpiresAt,
      ...(result.error ? { warning: result.error } : {}),
    };
  } catch (error) {
    return {
      cachedOnDisk: false,
      storageKind: 'browser-indexeddb',
      remoteUrlExpiresAt,
      warning: error instanceof Error ? error.message : '本地磁盘缓存失败',
    };
  }
}
