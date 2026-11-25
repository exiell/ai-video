import { useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, ModelProfile } from '../types/model';
import type { FrameKind } from '../domain/image/prompts';
import { ASSET_KIND_LABEL } from '../types/model';
import { useAppStore } from '../store/app';
import { useImage } from '../store/image';
import { useSettings } from '../store/settings';
import { resolveDefaultImageEditProfile } from '../data/models/imageProfiles';
import { listAssets } from '../services/storage';
import {
  canServeAsCanonicalAnchor,
  formatSurgicalEditPrompt,
  type ImageEditMode,
} from '../domain/image/canonicalPool';

export type ImageEditTarget = 'character' | 'scene' | 'frame';
type DialogEditStrategy = 'free' | ImageEditMode;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 800;

interface CandidateAsset {
  asset: Asset;
  label: string;
}

interface CandidateGroup {
  title: string;
  items: CandidateAsset[];
}

interface SelectedReference {
  key: string;
  dataUrl: string;
  label: string;
  kind?: Asset['kind'];
}

/**
 * 图像编辑对话框（v0.66）
 *
 * 流程固定为：先选参考图（项目素材或本地上传），再写修改要求，再生成。
 * 这里不直接碰 core：编辑模型由 resolveDefaultImageEditProfile 解析，
 * 生成走 useImage.generateEditedImage 契约，成功/失败反馈由 store 写入。
 */
export function ImageEditDialog({
  open,
  target,
  refId,
  onClose,
  returnFocusRef,
}: {
  open: boolean;
  target: ImageEditTarget;
  refId: string;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const project = useAppStore((state) => state.project);
  const prefs = useSettings((state) => state.prefs);
  const generateEditedImage = useImage((state) => state.generateEditedImage);
  const feedback = useImage((state) => state.feedback[`edit:${refId}`]);
  const clearFeedback = useImage((state) => state.clearFeedback);

  const editProfile: ModelProfile | undefined = resolveDefaultImageEditProfile(prefs);
  const maxReferences = Math.max(1, editProfile?.capabilities.maxReferenceImages ?? 3);
  const minReferences = Math.max(1, editProfile?.capabilities.minReferenceImages ?? 1);

  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<SelectedReference[]>([]);
  const [prompt, setPrompt] = useState('');
  const [editStrategy, setEditStrategy] = useState<DialogEditStrategy>('free');
  const [preserveNote, setPreserveNote] = useState('');
  const [frameKind, setFrameKind] = useState<FrameKind>('first-frame');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const stateRef = useRef({ submitting, onClose });
  stateRef.current = { submitting, onClose };

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setPrompt('');
    setEditStrategy('free');
    setPreserveNote('');
    setFrameKind('first-frame');
    setError(null);
    setUploadError(null);
    clearFeedback(`edit:${refId}`);
    restoreRef.current =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const root = dialogRef.current;
    root?.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled])')?.focus?.();
    // 打开时只初始化一次；refId 变化时按新对象重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refId]);

  useEffect(() => {
    if (!open || !project) return;
    let alive = true;
    void listAssets(project.id)
      .then((next) => {
        if (alive) setAssets(next);
      })
      .catch(() => {
        if (alive) setAssets([]);
      });
    return () => {
      alive = false;
    };
  }, [open, project]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!stateRef.current.submitting) stateRef.current.onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = [
        ...root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
        ),
      ];
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  const groups = useMemo<CandidateGroup[]>(() => {
    if (!project) return [];
    const usable = assets.filter((asset) => Boolean(asset.dataUrl));
    const result: CandidateGroup[] = [];

    const characterItems: CandidateAsset[] = [];
    for (const asset of usable) {
      if (asset.kind !== 'character-sheet' && asset.kind !== 'character-sheet-face') continue;
      const character = project.characters.find((item) => item.id === asset.refId);
      if (!character) continue;
      characterItems.push({
        asset,
        label: `${character.name} · ${ASSET_KIND_LABEL[asset.kind]}`,
      });
    }
    if (characterItems.length > 0) {
      result.push({ title: '角色形象图', items: characterItems });
    }

    const sceneItems: CandidateAsset[] = [];
    const frameItems: CandidateAsset[] = [];
    for (const asset of usable) {
      if (asset.kind === 'scene-plate') {
        const scene = project.scenes.find((item) => item.id === asset.refId);
        if (!scene) continue;
        sceneItems.push({ asset, label: `${scene.name} · 场景参考板` });
      }
      if (
        asset.kind === 'first-frame' ||
        asset.kind === 'action-peak' ||
        asset.kind === 'end-frame'
      ) {
        const shot = project.shots.find((item) => item.id === asset.refId);
        if (!shot) continue;
        frameItems.push({
          asset,
          label: `第 ${shot.number} 镜 · ${ASSET_KIND_LABEL[asset.kind]}`,
        });
      }
    }
    if (sceneItems.length > 0) result.push({ title: '场景参考板', items: sceneItems });
    if (frameItems.length > 0) result.push({ title: '分镜帧', items: frameItems });
    return result;
  }, [assets, project]);

  if (!open) return null;

  const promptText = prompt.trim();
  const filled = promptText.length > 0;
  const enoughReferences = selected.length >= Math.max(1, minReferences);
  const canSubmit = Boolean(editProfile) && enoughReferences && filled && !submitting;

  function toggleAsset(asset: Asset, label: string, dataUrl: string): void {
    setError(null);
    setSelected((current) => {
      const existing = current.findIndex((item) => item.key === asset.id);
      if (existing >= 0) return current.filter((_, index) => index !== existing);
      if (current.length >= maxReferences) {
        setError(`最多选 ${maxReferences} 张参考图。`);
        return current;
      }
      return [...current, { key: asset.id, dataUrl, label, kind: asset.kind }];
    });
  }

  function removeReference(key: string): void {
    setSelected((current) => current.filter((item) => item.key !== key));
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setUploadError(null);
    const remaining = maxReferences - selected.length;
    if (remaining <= 0) {
      setUploadError(`最多选 ${maxReferences} 张参考图，先移除一张再上传。`);
      return;
    }
    const accepted: SelectedReference[] = [];
    for (const file of [...files].slice(0, remaining)) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        setUploadError('只支持 png / jpg / webp 图片。');
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setUploadError(`「${file.name}」超过 10MB，换一张小一点的图。`);
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      }).catch(() => '');
      if (dataUrl) {
        accepted.push({
          key: `upload-${file.name}-${file.size}-${file.lastModified}`,
          dataUrl,
          label: `上传图片 · ${file.name}`,
        });
      }
    }
    if (accepted.length > 0) {
      setSelected((current) => [...current, ...accepted].slice(0, maxReferences));
    }
  }

  async function submit(): Promise<void> {
    if (!editProfile) {
      setError('还没有选图像编辑模型。先到设置 → 默认模型 → 图像编辑 选一个模型。');
      return;
    }
    if (!enoughReferences) {
      setError(`至少选 ${Math.max(1, minReferences)} 张参考图。`);
      return;
    }
    if (!filled) {
      setError('写点修改要求再开始生成。');
      return;
    }
    if (useImage.getState().pending) {
      setError('别的图还在生成，等它完成再试。');
      return;
    }
    setSubmitting(true);
    setError(null);
    clearFeedback(`edit:${refId}`);
    try {
      const compiledPrompt =
        editStrategy === 'free'
          ? promptText
          : formatSurgicalEditPrompt({
              mode: editStrategy,
              changeInstruction: promptText,
              preserveNote,
            });
      await generateEditedImage({
        target,
        refId,
        ...(target === 'frame' ? { frameKind } : {}),
        prompt: compiledPrompt,
        referenceImages: selected.map((item) => item.dataUrl),
        referenceLabels: selected.map((item) => item.label),
      });
      const latest = useImage.getState().feedback[`edit:${refId}`];
      if (latest && latest.kind !== 'ok') {
        setError(latest.message);
        return;
      }
      onClose();
    } catch (submitFailure) {
      setError(
        submitFailure instanceof Error && submitFailure.message.trim().length > 0
          ? submitFailure.message
          : '生成失败，稍后再试。',
      );
    } finally {
      setSubmitting(false);
    }
  }

  const contextLabel =
    target === 'character'
      ? '角色形象图'
      : target === 'scene'
        ? '场景参考板'
        : '分镜帧';

  return (
    <div className="confirm-backdrop" role="presentation" onClick={() => !submitting && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-edit-title"
        className="confirm-card image-edit-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-title" id="image-edit-title">
          图像编辑 · {contextLabel}
        </div>
        <p className="confirm-body" style={{ marginTop: 0 }}>
          先选参考图，再写你要改什么。参考图最多 {maxReferences} 张，顺序会影响结果。
        </p>

        {!editProfile ? (
          <div className="issue warning" style={{ marginBottom: 10 }}>
            <div className="issue-line">
              还没有选图像编辑模型。先到设置 → 默认模型 → 图像编辑 选一个支持参考图的模型。
            </div>
          </div>
        ) : null}

        <section className="image-edit-step" aria-label="第 1 步：选参考图">
          <div className="image-edit-step-head">
            <b>第 1 步：选参考图</b>
            <span className="hint" style={{ marginTop: 0 }}>
              已选 {selected.length} / {maxReferences}
              {minReferences > 1 ? ` · 至少 ${minReferences} 张` : ''}
            </span>
          </div>

          {selected.length > 0 ? (
            <>
              <ol className="image-edit-selected" aria-label="已选参考图顺序">
                {selected.map((item, index) => (
                  <li key={item.key}>
                    <span className="image-edit-order">{index + 1}</span>
                    <img src={item.dataUrl} alt="" />
                    <span className="image-edit-selected-label">{item.label}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={`移除第 ${index + 1} 张参考图`}
                      onClick={() => removeReference(item.key)}
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ol>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected([])}>
                清空
              </button>
            </>
          ) : (
            <p className="hint" style={{ marginTop: 0 }}>
              还没有选参考图。从下面项目图片里选，或者上传本地图片。
            </p>
          )}

          {groups.length > 0 ? (
            groups.map((group) => (
              <div className="image-edit-group" key={group.title}>
                <div className="image-edit-group-title">{group.title}</div>
                <div className="image-edit-grid">
                  {group.items.map(({ asset, label }) => {
                    const order = selected.findIndex((item) => item.key === asset.id);
                    const disabled = order < 0 && selected.length >= maxReferences;
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        className={`image-edit-tile${order >= 0 ? ' is-selected' : ''}`}
                        aria-label={order >= 0 ? `${label}（已选第 ${order + 1} 张）` : `选择 ${label}`}
                        disabled={disabled}
                        onClick={() => toggleAsset(asset, label, asset.dataUrl ?? '')}
                      >
                        {asset.dataUrl ? <img src={asset.dataUrl} alt="" /> : null}
                        <span className="image-edit-tile-label">{label}</span>
                        <span className="image-edit-tile-state">
                          {order >= 0 ? `已选 ${order + 1}` : disabled ? `已满 ${maxReferences} 张` : '点一下选'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          ) : (
            <p className="hint">项目里还没有可用的图片。先出角色图、场景板或分镜帧，或上传一张本地图片。</p>
          )}

          <div className="image-edit-upload">
            <label className="btn btn-sm image-edit-upload-label">
              上传本地图片
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                aria-label="上传本地参考图"
                className="image-edit-upload-input"
                onChange={(event) => {
                  void handleFiles(event.target.files);
                  event.target.value = '';
                }}
              />
            </label>
            <span className="hint" style={{ marginTop: 0 }}>
              只在这次使用，不保存到项目图库。
            </span>
          </div>
          {uploadError ? <div className="field-error">{uploadError}</div> : null}
        </section>

        <section className="image-edit-step" aria-label="第 2 步：写修改要求">
          <div className="image-edit-step-head">
            <b>第 2 步：写修改要求</b>
            <span className="hint" style={{ marginTop: 0 }}>
              {prompt.length} / {MAX_PROMPT_LENGTH}
            </span>
          </div>
          {selected.length > 0 &&
          selected.every((item) => item.kind !== undefined && !canServeAsCanonicalAnchor(item.kind)) ? (
            <div className="issue warning" style={{ marginBottom: 8 }}>
              <div className="issue-line">
                当前仅选了分镜帧；若已连续修图多轮，建议改用「回溯主参考重绘」并选回角色或场景主图，防止外观漂移。
              </div>
            </div>
          ) : null}
          <label className="image-edit-save-as" style={{ marginBottom: 8 }}>
            <span>修图模式</span>
            <select
              value={editStrategy}
              aria-label="修图模式"
              onChange={(event) => setEditStrategy(event.target.value as DialogEditStrategy)}
            >
              <option value="free">自由填写（原样发送）</option>
              <option value="surgical_edit">局部微调（只改指定项，锁其余画面）</option>
              <option value="canonical_redraw">回溯主参考重绘（防多轮修图漂移）</option>
            </select>
          </label>
          <label className="field-label" htmlFor="image-edit-prompt">
            要改什么
          </label>
          <textarea
            id="image-edit-prompt"
            className="image-edit-prompt"
            rows={4}
            maxLength={MAX_PROMPT_LENGTH}
            value={prompt}
            placeholder="例：保持角色不变，把表情改成惊讶；或把光线改成黄昏。"
            aria-label="修改要求"
            onChange={(event) => {
              setPrompt(event.target.value);
              setError(null);
            }}
          />
          {editStrategy !== 'free' ? (
            <div style={{ marginTop: 6 }}>
              <label className="field-label" htmlFor="image-edit-preserve">
                显式保留项（可选）
              </label>
              <input
                id="image-edit-preserve"
                type="text"
                value={preserveNote}
                placeholder="例：保持发型、深绿风衣、窗外雨景和机位不变"
                onChange={(event) => setPreserveNote(event.target.value)}
              />
            </div>
          ) : null}

          {target === 'frame' ? (
            <label className="image-edit-save-as">
              <span>保存为</span>
              <select
                value={frameKind}
                aria-label="保存为"
                onChange={(event) => setFrameKind(event.target.value as FrameKind)}
              >
                <option value="first-frame">首帧</option>
                <option value="action-peak">动作关键帧</option>
                <option value="end-frame">尾帧</option>
              </select>
            </label>
          ) : (
            <p className="hint" style={{ marginBottom: 0 }}>
              保存到{target === 'character' ? '这个角色的形象图库' : '这个场景的参考板图库'}。
            </p>
          )}
        </section>

        {error ? (
          <div className="issue error" role="alert" style={{ margin: 0 }}>
            <div className="issue-line">{error}</div>
          </div>
        ) : feedback && feedback.kind !== 'ok' ? (
          <div className="issue error" role="alert" style={{ margin: 0 }}>
            <div className="issue-line">{feedback.message}</div>
          </div>
        ) : null}

        <div className="row image-edit-actions">
          <button type="button" className="btn" disabled={submitting} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-blue"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {submitting ? '生成中…' : '开始生成'}
          </button>
        </div>
        {!filled && selected.length > 0 ? (
          <div className="hint" style={{ marginTop: 0 }}>
            写点修改要求再开始生成。
          </div>
        ) : null}
      </div>
    </div>
  );
}

