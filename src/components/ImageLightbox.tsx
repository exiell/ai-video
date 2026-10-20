import { useEffect, useState } from 'react';
import type { Asset } from '../types/model';
import { ASSET_KIND_LABEL } from '../types/model';

/**
 * 图片放大查看
 *
 * 为什么必须做：形象图里有六个视角、头部特写、材质细节，
 * 缩略图的尺寸根本看不清脸对不对得上。而这个工具的整个一致性机制
 * 都建立在「用户能看清并判断」之上——看不清就没法判断，机制就空转了。
 *
 * 交互取舍（刻意从简）：
 *  - 打开后默认按「适应窗口」显示整张图
 *  - 再点一下切到 100% 原始像素，可以用滚动条看细节
 *  - Esc 或点背景关闭，左右方向键切换同组的图
 *  - **不做拖拽平移**：触控板和滚动条已经够用，多一个交互就多一处会坏的地方
 */

export interface LightboxState {
  assets: Asset[];
  index: number;
}

export function ImageLightbox({
  state,
  onClose,
  onNavigate,
}: {
  state: LightboxState | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const [actualSize, setActualSize] = useState(false);

  // 每次换图都回到「适应窗口」，否则大图会以上次的缩放状态打开，容易看晕
  useEffect(() => {
    setActualSize(false);
  }, [state?.index, state?.assets]);

  useEffect(() => {
    if (!state) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') onNavigate((state!.index + 1) % state!.assets.length);
      if (event.key === 'ArrowLeft')
        onNavigate((state!.index - 1 + state!.assets.length) % state!.assets.length);
      if (event.key === ' ') {
        event.preventDefault();
        setActualSize((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onClose, onNavigate]);

  if (!state || state.assets.length === 0) return null;
  const asset = state.assets[state.index];
  if (!asset) return null;

  const total = state.assets.length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="放大查看"
      className="lightbox"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(6, 8, 12, 0.94)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 顶栏 */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <b style={{ fontSize: 13 }}>{ASSET_KIND_LABEL[asset.kind]}</b>
        {total > 1 ? (
          <span className="tag">
            {state.index + 1} / {total}
          </span>
        ) : null}
        <span className="hint" style={{ marginTop: 0 }}>
          {new Date(asset.createdAt).toLocaleString('zh-CN')}
          {asset.model ? ` · ${asset.model}` : ''}
          {asset.seed !== undefined ? ` · 种子 ${asset.seed}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={`btn btn-sm${actualSize ? ' btn-primary' : ''}`}
          onClick={() => setActualSize((v) => !v)}
        >
          {actualSize ? '适应窗口' : '原始像素 (100%)'}
        </button>
        {total > 1 ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onNavigate((state.index - 1 + total) % total)}
            >
              ←
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onNavigate((state.index + 1) % total)}
            >
              →
            </button>
          </>
        ) : null}
        <button type="button" className="btn btn-sm" onClick={onClose}>
          关闭 (Esc)
        </button>
      </div>

      {/* 图片区 */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          alignItems: actualSize ? 'flex-start' : 'center',
          justifyContent: 'center',
          padding: actualSize ? 0 : 16,
        }}
      >
        <img
          src={asset.dataUrl}
          alt={ASSET_KIND_LABEL[asset.kind]}
          className="lightbox-img"
          onClick={(e) => {
            e.stopPropagation();
            setActualSize((v) => !v);
          }}
          style={
            actualSize
              ? { display: 'block', cursor: 'zoom-out', imageRendering: 'pixelated' }
              : {
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  cursor: 'zoom-in',
                  borderRadius: 6,
                }
          }
        />
      </div>

      {/* 底部信息：生成时用的提示词与锁面，事后核对一致性时要用 */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          borderTop: '1px solid var(--border)',
          padding: '8px 16px',
          maxHeight: 170,
          overflowY: 'auto',
        }}
      >
        {asset.lockPhrases && asset.lockPhrases.length > 0 ? (
          <div className="hint" style={{ marginTop: 0 }}>
            <b>当时生效的连续性锁</b>：
            {asset.lockPhrases.map((phrase) => (
              <code key={phrase} style={{ marginLeft: 4 }}>
                {phrase}
              </code>
            ))}
          </div>
        ) : null}
        {asset.referenceCount ? (
          <div className="hint">
            <b>参考图</b>：用了 {asset.referenceCount} 张
          </div>
        ) : null}
        <details className="why">
          <summary>这张图的提示词</summary>
          <div className="why-body">
            <pre>{asset.promptSnapshot}</pre>
          </div>
        </details>
      </div>
    </div>
  );
}
