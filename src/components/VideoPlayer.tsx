import { useEffect, useRef, useState } from 'react';
import type { Asset, Shot } from '../types/model';
import type { VideoClipRecord } from '../types/video';
import { ConfirmDialog } from './bits';

/**
 * 视频成片播放器（v0.65）
 *
 * 一镜当前只保留一版：重新生成会替换旧片，所以这里没有版本选择，
 * 只有确认后的「重新生成 / 删除」。
 */
export function VideoPlayer({
  clip,
  shot,
  firstFrame,
  endFrame,
  onRegenerate,
  onDelete,
}: {
  clip: VideoClipRecord;
  shot: Shot;
  firstFrame?: Asset;
  endFrame?: Asset;
  onRegenerate: () => void;
  onDelete: () => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string>('');
  const [zoom, setZoom] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const zoomRef = useRef<HTMLVideoElement | null>(null);
  /** 下载用 URL 延迟 revoke：立刻 revoke 可能让浏览器还没写完的下载中断 */
  const pendingRevokesRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(clip.blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [clip.blob]);

  useEffect(() => {
    const pending = pendingRevokesRef.current;
    return () => {
      for (const [url, timer] of pending) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      pending.clear();
    };
  }, []);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoom(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  function dateStamp(): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}${month}${day}`;
  }

  function download(): void {
    if (typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(clip.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `第${String(shot.number).padStart(2, '0')}镜_视频_${dateStamp()}.mp4`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 浏览器接手下载后再回收；卸载时统一清理，避免泄漏
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      pendingRevokesRef.current.delete(url);
    }, 60_000);
    pendingRevokesRef.current.set(url, timer);
  }

  return (
    <div className="video-player-block">
      <div className="video-player-head">
        <b>视频草稿</b>
        <span className="hint" style={{ marginTop: 0 }}>
          5 秒 · {clip.width}×{clip.height} · mp4
        </span>
      </div>

      <video
        className="video-element"
        src={objectUrl}
        poster={firstFrame?.dataUrl}
        controls
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={`第 ${shot.number} 镜的视频预览`}
      />

      {firstFrame || endFrame ? (
        <div className="video-compare">
          {firstFrame ? (
            <figure>
              {firstFrame.dataUrl ? (
                <img src={firstFrame.dataUrl} alt="这一镜的首帧" />
              ) : (
                <div className="video-compare-missing">首帧图片读不出来</div>
              )}
              <figcaption>起点 · 首帧</figcaption>
            </figure>
          ) : null}
          {endFrame ? (
            <figure>
              {endFrame.dataUrl ? (
                <img src={endFrame.dataUrl} alt="这一镜的尾帧" />
              ) : (
                <div className="video-compare-missing">尾帧图片读不出来</div>
              )}
              <figcaption>终点 · 尾帧</figcaption>
            </figure>
          ) : null}
        </div>
      ) : null}

      <div className="row video-actions">
        <button type="button" className="btn btn-sm" onClick={() => setConfirmRegenerate(true)}>
          重新生成
        </button>
        <button type="button" className="btn btn-sm" onClick={download}>
          下载 MP4
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setZoom(true)}>
          放大
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setConfirmDelete(true)}
        >
          删除
        </button>
      </div>

      {zoom ? (
        <div
          className="confirm-backdrop"
          role="presentation"
          onClick={() => setZoom(false)}
          style={{ alignItems: 'center' }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`第 ${shot.number} 镜的视频放大查看`}
            className="video-zoom-card"
            onClick={(event) => event.stopPropagation()}
          >
            <video
              ref={zoomRef}
              src={objectUrl}
              controls
              muted
              loop
              playsInline
              aria-label="放大播放视频"
            />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
              <button type="button" className="btn btn-sm" onClick={download}>
                下载 MP4
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setZoom(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmRegenerate}
        title="重新生成这一镜的视频？"
        confirmLabel="重新生成"
        cancelLabel="取消"
        onCancel={() => setConfirmRegenerate(false)}
        onConfirm={() => {
          setConfirmRegenerate(false);
          onRegenerate();
        }}
      >
        <p style={{ marginTop: 0 }}>
          会重新提交生成。完成后替换当前视频，旧视频会删除。
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmDelete}
        title="删除这一镜的视频？"
        confirmLabel="删除"
        cancelLabel="取消"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
      >
        <p style={{ marginTop: 0 }}>本机上的视频文件会一起删掉，无法恢复。</p>
      </ConfirmDialog>
    </div>
  );
}
