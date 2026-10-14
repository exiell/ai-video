import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useImage } from '../store/image';
import { useSettings } from '../store/settings';
import { findProfile, DEFAULT_REFERENCE_PROFILE_ID, DEFAULT_T2I_PROFILE_ID } from '../data/models/profiles';
import { consistencyAdvice } from '../domain/image/prompts';
import { ASSET_KIND_LABEL } from '../types/model';
import type { Asset } from '../types/model';
import { ImageLightbox, type LightboxState } from './ImageLightbox';

/**
 * 出图按钮 + 图库（方案.md §3.2 M3/M4）
 *
 * 四件事必须做到：
 *  1. 没配 Key 时说清楚去哪里做什么，不是把按钮灰掉了事
 *  2. 如实告知「能锁到哪一级」——用户容易以为填了角色卡一致性就解决了
 *  3. 图片以 dataUrl 展示（长期有效），而不是平台那个 24 小时后失效的链接
 *  4. **点得开、看得清**：形象图里有六个视角和头部特写，
 *     缩略图看不清脸对不对得上，而整个一致性机制都建立在「用户能判断」之上
 */

export type PanelTarget = 'character' | 'scene' | 'frame';

export interface GenerateOption {
  /** 按钮文字 */
  label: string;
  /** 是否用参考图锚定 */
  useReference: boolean;
  /** 出的是哪一类形象图（只有角色用得上） */
  sheetKind?: 'turnaround' | 'face';
  /** 出的是哪一帧（只有镜头用得上） */
  frameKind?: 'first-frame' | 'action-peak' | 'end-frame';
  /** 按钮说明，显示在按钮下方 */
  hint?: string;
}

export function ImagePanel({
  refId,
  target,
  label,
  options,
  footer,
}: {
  refId: string;
  /** 决定点击按钮时调哪个 store 动作。用显式枚举而不是猜按钮文字。 */
  target: PanelTarget;
  label: string;
  options: GenerateOption[];
  /** 面板下方的额外内容（角色页用它放统一图库） */
  footer?: React.ReactNode;
}) {
  const pending = useImage((s) => s.pending);
  const feedbackMap = useImage((s) => s.feedback);
  const generateForCharacter = useImage((s) => s.generateForCharacter);
  const generateForScene = useImage((s) => s.generateForScene);
  const generateForFrame = useImage((s) => s.generateForFrame);

  const prefs = useSettings((s) => s.prefs);
  const keys = useSettings((s) => s.keys);

  const referenceProfile =
    findProfile(prefs.defaultReferenceProfileId || DEFAULT_REFERENCE_PROFILE_ID) ?? null;
  const plainProfile = findProfile(prefs.defaultT2iProfileId || DEFAULT_T2I_PROFILE_ID) ?? null;
  const canReference = Boolean(referenceProfile?.capabilities.referenceImage);
  const hasKey = Boolean(
    (referenceProfile && keys[referenceProfile.vendorId ?? '']?.trim()) ||
      (plainProfile && keys[plainProfile.vendorId ?? '']?.trim()),
  );

  const advice =
    canReference && referenceProfile
      ? consistencyAdvice(referenceProfile.capabilities, referenceProfile.name)
      : plainProfile
        ? consistencyAdvice(plainProfile.capabilities, plainProfile.name)
        : null;

  const busy = pending !== null;

  // 反馈可能挂在几个不同的任务键上（全身图与头部特写是两条），合并显示
  const feedbacks = Object.entries(feedbackMap)
    .filter(([key]) => key.endsWith(`:${refId}`))
    .map(([, value]) => value)
    .filter((v): v is NonNullable<typeof v> => Boolean(v));

  function run(option: GenerateOption) {
    if (target === 'character') {
      void generateForCharacter(refId, option.useReference && canReference, option.sheetKind ?? 'turnaround');
      return;
    }
    if (target === 'scene') {
      void generateForScene(refId);
      return;
    }
    // frameKind 由调用方指定；没给就是首帧（最常用的那一种）
    void generateForFrame(refId, option.frameKind ?? 'first-frame', option.useReference && canReference);
  }

  return (
    <div style={{ marginTop: 14 }}>
      <div className="field-label">{label}</div>

      {!hasKey ? (
        <div className="issue warning" style={{ marginBottom: 10 }}>
          <div className="issue-title">还不能出图</div>
          <div className="issue-line">
            需要先填出图模型的 API Key。去
            <Link to="/settings"> 设置 </Link>
            页填上「通义千问」那一栏，点「测试连接」确认能通。
          </div>
        </div>
      ) : null}

      <div className="row">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            className={`btn${option.useReference ? '' : ' btn-primary'}`}
            disabled={busy || !hasKey}
            onClick={() => run(option)}
          >
            {busy ? '生成中…' : option.label}
          </button>
        ))}
      </div>

      {options.some((o) => o.hint) ? (
        <div className="hint" style={{ marginTop: 6 }}>
          {options
            .filter((o) => o.hint)
            .map((o, index) => (
              <div key={index}>
                <b>{o.label}</b>：{o.hint}
              </div>
            ))}
        </div>
      ) : null}

      {advice ? (
        <div className="hint" style={{ marginTop: 8 }}>
          <b>一致性级别：{advice.level}</b> —— {advice.summary}
          <br />
          {advice.hint}
        </div>
      ) : null}

      {feedbacks.map((feedback, index) => (
        <div
          key={index}
          className={`issue ${feedback.kind === 'error' ? 'error' : feedback.kind === 'info' ? 'warning' : ''}`}
          style={{
            marginTop: 12,
            marginBottom: 0,
            borderLeftColor: feedback.kind === 'ok' ? 'var(--ok)' : undefined,
          }}
        >
          <div className="issue-title">
            {feedback.kind === 'ok'
              ? '✓ 已生成并保存'
              : feedback.kind === 'info'
                ? '生成完成，但有事要看一下'
                : '✗ 生成失败'}
          </div>
          <div className="issue-line" style={{ whiteSpace: 'pre-wrap' }}>
            {feedback.message}
          </div>
          {feedback.warnings.length > 0 ? (
            <ul className="issue-line" style={{ paddingLeft: 20, margin: '6px 0 0' }}>
              {feedback.warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}

      {footer}
    </div>
  );
}

/** 图库：缩略图网格，点开可放大 */
export function AssetGallery({
  assets,
  emptyHint,
}: {
  assets: Asset[];
  emptyHint?: string;
}) {
  const removeAsset = useImage((s) => s.removeAsset);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  if (assets.length === 0) {
    return (
      <div className="hint" style={{ marginTop: 8 }}>
        {emptyHint ?? '还没有生成过图。'}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="field-label">
        已保存的图（{assets.length} 张，都存在你自己的浏览器里）· 点击放大查看
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
          gap: 10,
        }}
      >
        {assets.map((asset, index) => (
          <figure key={asset.id} style={{ margin: 0 }}>
            <button
              type="button"
              onClick={() => setLightbox({ assets, index })}
              title="点击放大查看"
              style={{
                padding: 0,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--bg)',
                cursor: 'zoom-in',
                display: 'block',
                width: '100%',
                overflow: 'hidden',
                lineHeight: 0,
              }}
            >
              <img
                src={asset.dataUrl}
                alt={ASSET_KIND_LABEL[asset.kind]}
                style={{ width: '100%', display: 'block' }}
              />
            </button>
            <figcaption className="hint" style={{ marginTop: 4 }}>
              <span className="tag">{ASSET_KIND_LABEL[asset.kind]}</span>
              <br />
              {new Date(asset.createdAt).toLocaleString('zh-CN')}
              {asset.model ? ` · ${asset.model}` : ''}
              {asset.referenceCount ? ` · ${asset.referenceCount} 张参考图` : ''}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ marginLeft: 6 }}
                onClick={() => void removeAsset(asset.refId, asset.id)}
              >
                删除
              </button>
            </figcaption>
          </figure>
        ))}
      </div>

      <ImageLightbox
        state={lightbox}
        onClose={() => setLightbox(null)}
        onNavigate={(index) => setLightbox((c) => (c ? { ...c, index } : c))}
      />
    </div>
  );
}
