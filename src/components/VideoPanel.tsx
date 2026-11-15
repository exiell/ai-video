import { useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, AssetKind, Project, Shot } from '../types/model';
import { ASSET_KIND_LABEL } from '../types/model';
import type { VideoAspect } from '../types/video';
import { ACTIVE_VIDEO_JOB_STATUSES } from '../types/video';
import { defaultReferenceAssetIds, videoAspectFromSize } from '../data/video/references';
import { listAssets } from '../services/storage';
import { MAX_QUEUE, useVideo, videoClipKey } from '../store/video';
import { useImage } from '../store/image';
import { VideoPlayer } from './VideoPlayer';

const MAX_REFERENCES = 4;

interface CandidateItem {
  asset: Asset;
  label: string;
}

interface CandidateGroup {
  title: string;
  items: CandidateItem[];
}

function buildCandidateGroups(assets: Asset[], project: Project, shot: Shot): CandidateGroup[] {
  const characterName = (id: string) =>
    project.characters.find((character) => character.id === id)?.name ?? '角色';
  const sceneName = project.scenes.find((scene) => scene.id === shot.sceneId)?.name ?? '场景';
  const usable = assets.filter((asset) => Boolean(asset.dataUrl));

  const groups: CandidateGroup[] = [];
  const characterItems: CandidateItem[] = [];
  for (const asset of usable) {
    if (asset.kind !== 'character-sheet' && asset.kind !== 'character-sheet-face') continue;
    if (!shot.characterIds.includes(asset.refId)) continue;
    characterItems.push({
      asset,
      label: `${characterName(asset.refId)} · ${ASSET_KIND_LABEL[asset.kind]}`,
    });
  }
  if (characterItems.length > 0) groups.push({ title: '出镜角色形象图', items: characterItems });

  const sceneItems = usable
    .filter((asset) => asset.kind === 'scene-plate' && asset.refId === shot.sceneId)
    .map((asset) => ({ asset, label: `${sceneName} · 场景参考板` }));
  if (sceneItems.length > 0) groups.push({ title: '场景参考板', items: sceneItems });

  const frameItems = usable
    .filter(
      (asset) =>
        asset.refId === shot.id && (asset.kind === 'action-peak' || asset.kind === 'end-frame'),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((asset) => ({ asset, label: `本镜 · ${ASSET_KIND_LABEL[asset.kind as AssetKind]}` }));
  if (frameItems.length > 0) groups.push({ title: '本镜关键帧与尾帧', items: frameItems });

  return groups;
}

function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function elapsedSecondsOf(job: { elapsedSeconds?: number | null; startedAt?: string; createdAt: string }): number {
  if (typeof job.elapsedSeconds === 'number' && Number.isFinite(job.elapsedSeconds)) {
    return Math.max(0, job.elapsedSeconds);
  }
  const from = job.startedAt ?? job.createdAt;
  const startedAt = Date.parse(from);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function remainingText(elapsed: number): string {
  const remaining = Math.max(0, 12 * 60 - elapsed);
  if (remaining <= 0) return '可能快好了';
  return `预计还需约 ${Math.max(1, Math.ceil(remaining / 60))} 分钟`;
}

function aspectLabel(aspect: VideoAspect | undefined): string {
  return aspect === 'horizontal' ? '横屏 848×480' : '竖屏 480×848';
}

export function VideoPanel({
  shot,
  project,
  onJumpToFrames,
}: {
  shot: Shot;
  project: Project;
  onJumpToFrames: () => void;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [optionalIds, setOptionalIds] = useState<string[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const pickerRestoreRef = useRef<HTMLElement | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const jobs = useVideo((state) => state.jobs);
  const clips = useVideo((state) => state.clips);
  const submitVideo = useVideo((state) => state.submitVideo);
  const stopWaiting = useVideo((state) => state.stopWaiting);
  const deleteClip = useVideo((state) => state.deleteClip);
  const assetCount = useImage((state) => state.assetCount);

  useEffect(() => {
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
  }, [project.id, shot.id, assetCount]);

  useEffect(() => {
    setOptionalIds(null);
    setDirty(false);
    setSubmitError(null);
  }, [shot.id, project.id]);

  useEffect(() => {
    if (!pickerOpen) return;
    pickerRestoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 打开后焦点进弹窗，关闭后还回去；Tab 在弹窗内循环。
    pickerRef.current
      ?.querySelector<HTMLElement>('button:not([disabled]), [href]')
      ?.focus?.();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPickerOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const root = pickerRef.current;
      if (!root) return;
      const focusables = [
        ...root.querySelectorAll<HTMLElement>('button:not([disabled]), [href]'),
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
      pickerRestoreRef.current?.focus?.();
    };
  }, [pickerOpen]);

  const firstFrame = useMemo(
    () =>
      assets
        .filter(
          (asset) =>
            asset.kind === 'first-frame' && asset.refId === shot.id && Boolean(asset.dataUrl),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
    [assets, shot.id],
  );
  const endFrame = useMemo(
    () =>
      assets
        .filter(
          (asset) => asset.kind === 'end-frame' && asset.refId === shot.id && Boolean(asset.dataUrl),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
    [assets, shot.id],
  );

  // 未动选择器时用 core 默认结果初始化，保证「显示几张」就是「实际会发几张」。
  const defaultIds = useMemo(
    () => defaultReferenceAssetIds(shot, project, assets),
    [shot, project, assets],
  );
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const effectiveOptional = (optionalIds ?? defaultIds.slice(1))
    .filter((id) => id !== firstFrame?.id && assetMap.has(id))
    .slice(0, MAX_REFERENCES - 1);
  const effectiveIds = firstFrame ? [firstFrame.id, ...effectiveOptional] : [];
  const effectiveAssets = effectiveIds
    .map((id) => assetMap.get(id))
    .filter((asset): asset is Asset => Boolean(asset));
  const aspect = videoAspectFromSize(firstFrame?.width, firstFrame?.height);

  const shotJobs = jobs
    .filter((job) => job.projectId === project.id && job.shotId === shot.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const job = shotJobs[0];
  const clip = clips[videoClipKey(project.id, shot.id)];
  const isActive = Boolean(job && ACTIVE_VIDEO_JOB_STATUSES.includes(job.status));
  // 只认当前项目的 job 状态；submittingShotId 只有镜头 id，跨项目同 shotId 会误判
  const submitting = job?.status === 'submitting';
  const activeJobs = jobs
    .filter(
      (item) =>
        item.projectId === project.id && ACTIVE_VIDEO_JOB_STATUSES.includes(item.status),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const queueIndex = job ? activeJobs.findIndex((item) => item.id === job.id) : -1;
  const queueAhead = queueIndex > 0 ? queueIndex : 0;
  const queueFull = !isActive && activeJobs.length >= MAX_QUEUE;
  const candidates = useMemo(
    () => buildCandidateGroups(assets, project, shot),
    [assets, project, shot],
  );

  function updateOptional(next: string[]): void {
    setDirty(true);
    setOptionalIds(next.filter((id) => id !== firstFrame?.id).slice(0, MAX_REFERENCES - 1));
  }

  function addReference(assetId: string): void {
    // 未改选择器时，默认结果就是当前生效列表：追加应基于它，而不是空数组
    const current = optionalIds ?? defaultIds.slice(1);
    if (current.includes(assetId) || current.length >= MAX_REFERENCES - 1) return;
    updateOptional([...current, assetId]);
    setPickerOpen(false);
  }

  function moveReference(index: number, direction: -1 | 1): void {
    const current = [...effectiveOptional];
    const target = index + direction;
    if (target < 0 || target >= current.length) return;
    const left = current[index]!;
    current[index] = current[target]!;
    current[target] = left;
    updateOptional(current);
  }

  function removeReference(assetId: string): void {
    updateOptional(effectiveOptional.filter((id) => id !== assetId));
  }

  async function handleSubmit(): Promise<void> {
    setSubmitError(null);
    // 始终显式传当前选择：显示几张就发几张，核心不补全。
    // 没动过选择器时 effectiveIds 就是 core 默认结果。
    const result = await submitVideo(shot.id, { referenceAssetIds: effectiveIds });
    if (!result.ok) setSubmitError(result.error ?? '视频提交失败，稍后再试。');
  }

  const elapsed = job ? elapsedSecondsOf(job) : 0;
  const progress =
    typeof job?.progress === 'number' && Number.isFinite(job.progress) ? job.progress : null;

  return (
    <section className="video-panel" aria-label={`第 ${shot.number} 镜的视频`}>
      <div className="video-panel-head">
        <div>
          <b>视频草稿</b>
          <span className="hint" style={{ marginTop: 0, marginLeft: 8 }}>
            5 秒 · 480P · 参考图 {effectiveIds.length}/{MAX_REFERENCES}
          {dirty ? '（已自定义）' : '（默认）'}
        </span>
        </div>
        {clip ? (
          <span className="tag tag-ok">已生成</span>
        ) : isActive ? (
          <span className="tag tag-warning">生成中</span>
        ) : null}
      </div>

      {clip ? (
        <>
          <VideoPlayer
            clip={clip}
            shot={shot}
            firstFrame={firstFrame}
            endFrame={endFrame}
            onRegenerate={() => void handleSubmit()}
            onDelete={() => void deleteClip(project.id, shot.id)}
          />
          {isActive ? (
            <div className="video-status" role="status" aria-live="polite">
              <div className="video-status-line">
                {job?.status === 'running'
                  ? `生成中 ${formatElapsed(elapsed)} · ${remainingText(elapsed)}`
                  : job?.status === 'queued'
                    ? `排队中，前面还有 ${queueAhead} 个任务`
                    : submitting
                      ? '正在提交…'
                      : '已提交，等待生成'}
              </div>
              {job && job.status !== 'submitting' ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void stopWaiting(job.id)}
                >
                  停止等待
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className="hint video-panel-hint">
            本地服务一次只跑一条，一条 5 秒大约 12 分钟。先拿 1–2 镜试试，满意后再逐镜跑。
          </p>

          {!firstFrame ? (
            <div className="video-empty">
              <div className="issue warning" style={{ margin: 0 }}>
                <div className="issue-line">先出这一镜的首帧，视频会从首帧开始动。</div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onJumpToFrames}>
                去下面「这一镜的三帧」生成首帧
              </button>
            </div>
          ) : (
            <>
              <div className="video-refs-head">
                <b>参考图</b>
                <span className="hint" style={{ marginTop: 0 }}>
                  第 1 张固定首帧，决定画幅：{aspectLabel(aspect)}
                </span>
              </div>

              <ol className="video-refs">
                {effectiveAssets.map((asset, index) => {
                  const locked = index === 0;
                  return (
                    <li className="video-ref" key={asset.id}>
                      <span className="video-ref-no">{index + 1}</span>
                      {asset.dataUrl ? (
                        <img src={asset.dataUrl} alt={ASSET_KIND_LABEL[asset.kind]} />
                      ) : null}
                      <span className="video-ref-label">
                        {locked ? `首帧 · ${ASSET_KIND_LABEL[asset.kind]}` : ASSET_KIND_LABEL[asset.kind]}
                        {locked ? (
                          <span className="tag" style={{ marginLeft: 6 }}>
                            锁定
                          </span>
                        ) : null}
                      </span>
                      {!locked ? (
                        <span className="video-ref-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-label="上移这张参考图"
                            title="上移"
                            disabled={index <= 1}
                            onClick={() => moveReference(index - 1, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-label="下移这张参考图"
                            title="下移"
                            disabled={index >= effectiveAssets.length - 1}
                            onClick={() => moveReference(index - 1, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-label="移除这张参考图"
                            onClick={() => removeReference(asset.id)}
                          >
                            移除
                          </button>
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ol>

              {effectiveIds.length < MAX_REFERENCES ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setPickerOpen(true)}
                  aria-label="加参考图"
                >
                  + 加参考图（还可加 {MAX_REFERENCES - effectiveIds.length} 张）
                </button>
              ) : null}

            </>
          )}

          {isActive ? (
            <div className="video-status" role="status" aria-live="polite">
              <div className="video-status-line">
                {job?.status === 'queued' || job?.status === 'submitted'
                  ? `排队中，前面还有 ${queueAhead} 个任务`
                  : job?.status === 'running'
                    ? `生成中 ${formatElapsed(elapsed)} · ${remainingText(elapsed)}`
                    : '正在提交…'}
              </div>
              {progress !== null ? (
                <div
                  className="video-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress)}
                  aria-label="视频生成进度"
                >
                  <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
                </div>
              ) : null}
              {job && job.status !== 'submitting' ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void stopWaiting(job.id)}
                >
                  停止等待
                </button>
              ) : null}
            </div>
          ) : job && (job.status === 'failed' || job.status === 'canceled' || job.status === 'submit-uncertain') ? (
            <div className="video-status" role="status" aria-live="polite">
              <div className="issue error" style={{ margin: 0 }}>
                <div className="issue-line">
                  {job.status === 'submit-uncertain'
                    ? '上次提交结果不确定，可能已在服务端创建。先刷新确认服务端有没有这条任务，再决定重试。'
                    : job.error ?? '视频生成失败，稍后重试。'}
                </div>
              </div>
              {job.status !== 'submit-uncertain' ? (
                <button type="button" className="btn btn-sm" onClick={() => void handleSubmit()}>
                  重试
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => window.location.reload()}
                >
                  刷新页面确认
                </button>
              )}
            </div>
          ) : null}

          {submitError ? (
            <div className="issue error" style={{ margin: 0 }} role="alert">
              <div className="issue-line">{submitError}</div>
            </div>
          ) : null}

          <div className="video-submit-row">
            <button
              type="button"
              className="btn btn-blue"
              disabled={!firstFrame || isActive || submitting || queueFull}
              title={
                !firstFrame
                  ? '先出这一镜的首帧'
                  : isActive || submitting
                    ? '这一镜正在生成'
                    : queueFull
                      ? '排队已满，先把当前几条跑完'
                      : '生成 5 秒本地视频草稿'
              }
              onClick={() => void handleSubmit()}
            >
              {isActive || submitting ? '这一镜正在生成' : '生成视频（5 秒）'}
            </button>
            {queueFull ? <span className="hint">排队已满，等前面的任务跑完再提交。</span> : null}
          </div>
        </>
      )}

      {pickerOpen ? (
        <div
          className="confirm-backdrop"
          role="presentation"
          onClick={() => setPickerOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="video-ref-picker-title"
            className="confirm-card video-ref-picker"
            ref={pickerRef}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="confirm-title" id="video-ref-picker-title">
              加参考图
            </div>
            <p className="confirm-body" style={{ marginTop: 0 }}>
              第 1 张固定首帧；再加角色形象图、场景板、关键帧或尾帧，最多 4 张。
            </p>
            {candidates.length === 0 ? (
              <p className="hint">还没有可用的角色图/场景板/关键帧。先出这一镜的三帧，或生成角色形象图。</p>
            ) : (
              candidates.map((group) => (
                <div className="video-ref-group" key={group.title}>
                  <b>{group.title}</b>
                  <div className="video-ref-group-items">
                    {group.items.map(({ asset, label }) => {
                      const selected = effectiveIds.includes(asset.id);
                      const full = effectiveIds.length >= MAX_REFERENCES;
                      return (
                        <button
                          key={asset.id}
                          type="button"
                          className={`video-ref-option${selected ? ' is-selected' : ''}`}
                          disabled={selected || full}
                          aria-label={selected ? `${label}（已选）` : `选择${label}`}
                          onClick={() => addReference(asset.id)}
                        >
                          {asset.dataUrl ? <img src={asset.dataUrl} alt="" /> : null}
                          <span>{label}</span>
                          <span className="hint" style={{ marginTop: 0 }}>
                            {selected ? '已选' : full ? '已满 4 张' : '加上去'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
              <button type="button" className="btn btn-sm" onClick={() => setPickerOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
