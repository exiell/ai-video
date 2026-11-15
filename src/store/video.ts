/**
 * 视频任务 store（v0.65 核心层）
 *
 * 责任：
 *  - 提交/轮询/恢复/停止等待/重生成/删除；
 *  - 同一镜头只允许一个活动任务，全局排队最多 4；
 *  - 刷新后只查状态，不自动重提；submit-uncertain 不自动重试；
 *  - 成片 Blob 落 IndexedDB（videoClips），job 轻量元数据落 videoJobs。
 */
import { create } from 'zustand';
import type { Shot } from '../types/model';
import type {
  VideoClipRecord,
  VideoJobRecord,
  VideoOutputMetadata,
  VideoProfile,
} from '../types/video';
import { ACTIVE_VIDEO_JOB_STATUSES } from '../types/video';
import { useAppStore } from './app';
import { currentTransport, useSettings } from './settings';
import { buildVideoReferences, videoAspectFromSize } from '../data/video/references';
import { prepareReference } from '../services/image/prepare';
import {
  resolveDefaultVideoProfile,
  resolveVideoProfileById,
} from '../data/models/videoProfiles';
import {
  createVideoJob,
  fetchVideoContent,
  normalizeVideoError,
  pollVideoJob,
  VideoServiceError,
  type VideoRequestOptions,
} from '../services/gateway/videoAdapters';
import {
  deleteVideoClip,
  deleteVideoClipsForShot,
  listAssets,
  listVideoClipsForShot,
  listVideoJobs,
  newId,
  pruneVideoJobs,
  saveVideoClipReplacingShot,
  saveVideoJob,
} from '../services/storage';

const MAX_QUEUE = 4;
const POLL_VISIBLE_MS = 10_000;
const POLL_HIDDEN_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
const submitLocks = new Set<string>();
let pollInFlight = false;

export interface VideoSubmitOptions {
  fetchImpl?: typeof fetch;
  seed?: number;
  /** UI 选择器给出的参考图顺序；不传则用 buildVideoReferences 默认规则 */
  referenceAssetIds?: string[];
}

export interface VideoSubmitResult {
  ok: boolean;
  job?: VideoJobRecord;
  error?: string;
}

interface VideoState {
  jobs: VideoJobRecord[];
  /** shotId -> 当前成片（只保留当前一版） */
  clips: Record<string, VideoClipRecord>;
  submittingShotId: string | null;
  lastError: string | null;
  submitVideo: (shotId: string, options?: VideoSubmitOptions) => Promise<VideoSubmitResult>;
  pollActiveJobs: (options?: { fetchImpl?: typeof fetch }) => Promise<void>;
  recoverJobs: () => Promise<void>;
  stopWaiting: (jobId: string) => Promise<void>;
  regenerate: (shotId: string, options?: VideoSubmitOptions) => Promise<VideoSubmitResult>;
  deleteClip: (projectIdOrShotId: string, maybeShotId?: string) => Promise<void>;
  getClip: (projectIdOrShotId: string, maybeShotId?: string) => Promise<VideoClipRecord | undefined>;
}

export function videoClipKey(projectId: string, shotId: string): string {
  return `${projectId}:${shotId}`;
}

function currentProjectId(): string | undefined {
  return useAppStore.getState().project?.id;
}

function withClipAlias(
  clips: Record<string, VideoClipRecord>,
  projectId: string,
  shotId: string,
  clip: VideoClipRecord,
): Record<string, VideoClipRecord> {
  const next = { ...clips, [videoClipKey(projectId, shotId)]: clip };
  if (currentProjectId() === projectId) next[shotId] = clip;
  return next;
}

function removeClipFromCache(
  clips: Record<string, VideoClipRecord>,
  projectId: string,
  shotId: string,
): Record<string, VideoClipRecord> {
  const next = { ...clips };
  delete next[videoClipKey(projectId, shotId)];
  // 旧缓存/旧 UI 的 shotId-only key
  if (next[shotId] && currentProjectId() === projectId) delete next[shotId];
  return next;
}

export function buildVideoPrompt(shot: Pick<Shot, 'startState' | 'action' | 'endState' | 'dialogue'>): string {
  return [shot.startState, shot.action, shot.endState, shot.dialogue]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join('，');
}

function isActive(status: VideoJobRecord['status']): boolean {
  return ACTIVE_VIDEO_JOB_STATUSES.includes(status);
}

function resolveContext(): { profile: VideoProfile; apiKey: string } | { error: string } {
  const { prefs, keys } = useSettings.getState();
  const profile = resolveDefaultVideoProfile(prefs.defaultVideoProfileId, useSettings.getState().customModels);
  if (!profile) {
    return { error: '还没有配置视频模型。到设置里的自定义接入添加视频服务，再回来生成。' };
  }
  const key = profile.vendorId ? (keys[profile.vendorId] ?? '').trim() : '';
  if (profile.requiresKey && !key) {
    return { error: `还没有填「${profile.name}」的 API Key。` };
  }
  return { profile, apiKey: key };
}

function profileForJob(job: VideoJobRecord): VideoProfile | null {
  // 优先用提交时的快照，档案被删除/改名后仍按原 baseUrl/model 收尾；
  // 没有快照的旧 job 只按原 profileId 精确解析，绝不回退到另一条视频档案。
  return job.profileSnapshot ?? resolveVideoProfileById(job.profileId);
}

async function persistJob(job: VideoJobRecord): Promise<void> {
  await saveVideoJob(job);
}

function replaceJob(jobs: VideoJobRecord[], job: VideoJobRecord): VideoJobRecord[] {
  const index = jobs.findIndex((item) => item.id === job.id);
  if (index < 0) return [job, ...jobs];
  const next = [...jobs];
  next[index] = job;
  return next;
}

function schedulePolling(get: () => VideoState): void {
  if (pollTimer !== null) return;
  const hasRemote = get().jobs.some((job) => isActive(job.status) && Boolean(job.remoteJobId));
  if (!hasRemote) return;
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const delay = hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void get()
      .pollActiveJobs()
      .catch(() => undefined)
      .finally(() => schedulePolling(get));
  }, delay);
}

export function resetVideoPollingForTests(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  submitLocks.clear();
  pollInFlight = false;
}

export const useVideo = create<VideoState>((set, get) => ({
  jobs: [],
  clips: {},
  submittingShotId: null,
  lastError: null,

  submitVideo: async (shotId, options = {}) => {
    const project = useAppStore.getState().project;
    if (!project) return { ok: false, error: '还没有打开项目。' };
    const shot = project.shots.find((item) => item.id === shotId);
    if (!shot) return { ok: false, error: '找不到这个镜头。' };

    const lockKey = `${project.id}:${shotId}`;
    if (submitLocks.has(lockKey)) {
      const existing = get().jobs.find(
        (job) => job.projectId === project.id && job.shotId === shotId && isActive(job.status),
      );
      return {
        ok: false,
        error: '这一镜正在提交或生成，等它完成再试。',
        ...(existing ? { job: existing } : {}),
      };
    }
    submitLocks.add(lockKey);
    try {
    const currentJobs = get().jobs;
    const duplicate = currentJobs.find(
      (job) => job.projectId === project.id && job.shotId === shotId && isActive(job.status),
    );
    if (duplicate) return { ok: false, error: '这一镜正在生成，等它完成再试。' };
    if (currentJobs.filter((job) => isActive(job.status)).length >= MAX_QUEUE) {
      return { ok: false, error: '排队已满，等前面的任务跑完再提交。' };
    }
    const context = resolveContext();
    if ('error' in context) return { ok: false, error: context.error };

    const assets = await listAssets(project.id);
    let refs: ReturnType<typeof buildVideoReferences>;
    if (options.referenceAssetIds !== undefined) {
      const ids = options.referenceAssetIds;
      if (ids.length < 1 || ids.length > 4) {
        return { ok: false, error: '参考图必须是 1–4 张（第 1 张固定本镜首帧）。' };
      }
      if (new Set(ids).size !== ids.length) {
        return { ok: false, error: '参考图有重复，请去掉重复项。' };
      }
      const byId = new Map(assets.filter((asset) => asset.projectId === project.id).map((asset) => [asset.id, asset]));
      const picked = ids.map((id) => byId.get(id));
      if (picked.some((asset) => !asset || !asset.dataUrl)) {
        return { ok: false, error: '参考图里有不存在的资产或还没有出图，请重新选择。' };
      }
      const first = picked[0]!;
      if (first.kind !== 'first-frame' || first.refId !== shot.id) {
        return { ok: false, error: '第 1 张必须是本镜首帧，且不能调换顺序。' };
      }
      refs = {
        ok: true,
        assetIds: ids,
        dataUrls: picked.map((asset) => asset!.dataUrl as string),
        aspect: videoAspectFromSize(first.width, first.height),
      };
    } else {
      refs = buildVideoReferences(shot, project, assets);
    }
    if (!refs.ok) return { ok: false, error: refs.error ?? '参考图不完整。' };
    const maxReferences = context.profile.capabilities.maxReferenceImages;
    if (maxReferences < 1) {
      return { ok: false, error: '这个视频档案没有声明参考图能力，至少需要第 1 张首帧。' };
    }
    const selectedUrls = refs.dataUrls.slice(0, maxReferences);
    const selectedAssetIds = refs.assetIds.slice(0, maxReferences);
    // 复用 P2-c 预处理：浏览器有 canvas 时按 1.5MB/1280 长边压缩；
    // jsdom/无 canvas 环境会 passthrough，不会让测试因缺 canvas 失败。
    const preparedReferences = await Promise.all(
      selectedUrls.map((dataUrl) =>
        prepareReference({ dataUrl }, 'fit-bytes', { maxBytesPerImage: 1_500_000, maxLongEdge: 1280 }),
      ),
    );
    const referenceImages = preparedReferences.map((item) => item.dataUrl);

    const now = new Date().toISOString();
    const job: VideoJobRecord = {
      id: newId('videojob'),
      projectId: project.id,
      shotId,
      profileId: context.profile.id,
      profileSnapshot: context.profile,
      referenceAssetIds: selectedAssetIds,
      prompt: buildVideoPrompt(shot),
      seconds: context.profile.capabilities.durationSeconds,
      resolution: context.profile.capabilities.resolution,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      status: 'submitting',
      idempotencyKey: newId('video-idem'),
      createdAt: now,
      updatedAt: now,
    };
    set({ jobs: [job, ...currentJobs], submittingShotId: shotId, lastError: null });
    try {
      await persistJob(job);
    } catch {
      const message = '本地任务保存失败（可能是浏览器存储空间不足）。没有提交到服务端，检查空间后重试。';
      set({
        jobs: get().jobs.filter((item) => item.id !== job.id),
        submittingShotId: null,
        lastError: message,
      });
      return { ok: false, error: message };
    }

    try {
      const remote = await createVideoJob(
        context.profile,
        {
          prompt: job.prompt,
          referenceImages,
          seconds: job.seconds,
          resolution: job.resolution,
          ...(job.seed !== undefined ? { seed: job.seed } : {}),
          timeoutMs: context.profile.capabilities.maxTimeoutMs,
        },
        {
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(context.apiKey ? { apiKey: context.apiKey } : {}),
          ...(currentTransport() ? { transport: currentTransport() } : {}),
        } satisfies VideoRequestOptions,
      );
      const submitted: VideoJobRecord = {
        ...job,
        status: 'submitted',
        remoteJobId: remote.id,
        progress: remote.progress,
        elapsedSeconds: remote.elapsedSeconds,
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      };
      set({ jobs: replaceJob(get().jobs, submitted), submittingShotId: null });
      try {
        await persistJob(submitted);
      } catch {
        // POST 已经成功，远端任务在跑；本地只是没落盘。绝不能标 failed 或自动重提。
        const message =
          '视频任务已经提交到服务端，但本地保存失败；先确认服务端任务，不要重复提交，完成后可刷新恢复。';
        const uncertain: VideoJobRecord = {
          ...submitted,
          status: 'submit-uncertain',
          error: message,
          submitUncertainReason: message,
          updatedAt: new Date().toISOString(),
        };
        try {
          await persistJob(uncertain);
        } catch {
          // 本地存储仍不可用：至少把状态留在内存，UI 可停止等待/刷新
        }
        set({
          jobs: replaceJob(get().jobs, uncertain),
          submittingShotId: null,
          lastError: message,
        });
        return { ok: false, error: message, job: uncertain };
      }
      schedulePolling(get);
      return { ok: true, job: submitted };
    } catch (error) {
      const normalized = normalizeVideoError(error);
      const uncertain = normalized.kind === 'network' || normalized.kind === 'timeout';
      const failed: VideoJobRecord = {
        ...job,
        status: uncertain ? 'submit-uncertain' : 'failed',
        error: normalized.message,
        ...(uncertain ? { submitUncertainReason: normalized.message } : {}),
        updatedAt: new Date().toISOString(),
      };
      set({ jobs: replaceJob(get().jobs, failed), submittingShotId: null, lastError: normalized.message });
      await persistJob(failed);
      return { ok: false, error: normalized.message };
    }
    } finally {
      submitLocks.delete(lockKey);
    }
  },

  pollActiveJobs: async (options = {}) => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
    const active = get().jobs.filter((job) => isActive(job.status) && job.remoteJobId);
    for (const original of active) {
      const job = { ...original };
      if (job.nextPollAt && job.nextPollAt > new Date().toISOString()) continue;
      const profile = profileForJob(job);
      if (!profile) {
        job.status = 'failed';
        job.error = '这个视频档案已经不存在了，重新选择视频模型后再试。';
        job.updatedAt = new Date().toISOString();
        await persistJob(job);
        set({ jobs: replaceJob(get().jobs, job) });
        continue;
      }
      const { keys } = useSettings.getState();
      const apiKey = profile.vendorId ? (keys[profile.vendorId] ?? '').trim() : '';
      if (profile.requiresKey && !apiKey) {
        job.status = 'failed';
        job.error = `「${profile.name}」需要 API Key，但本机没有取到 Key；重新填 Key 后再试。`;
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
        await persistJob(job);
        set({ jobs: replaceJob(get().jobs, job) });
        continue;
      }
      try {
        const remote = await pollVideoJob(profile, job.remoteJobId!, {
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(apiKey ? { apiKey } : {}),
          ...(currentTransport() ? { transport: currentTransport() } : {}),
          timeoutMs: 30_000,
        });
        job.progress = remote.progress;
        job.elapsedSeconds = remote.elapsedSeconds;
        job.pollFailures = 0;
        delete job.nextPollAt;
        job.updatedAt = new Date().toISOString();
        if (remote.status === 'failed') {
          job.status = 'failed';
          job.error = remote.error ?? '视频生成失败，稍后重试。';
          job.finishedAt = job.updatedAt;
          await persistJob(job);
          set({ jobs: replaceJob(get().jobs, job) });
          continue;
        }
        if (remote.status !== 'completed') {
          job.status = remote.status === 'running' ? 'running' : 'submitted';
          await persistJob(job);
          set({ jobs: replaceJob(get().jobs, job) });
          continue;
        }
        const content = await fetchVideoContent(profile, job.remoteJobId!, {
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(apiKey ? { apiKey } : {}),
          ...(currentTransport() ? { transport: currentTransport() } : {}),
          timeoutMs: 120_000,
        });
        const output = remote.output;
        const clip: VideoClipRecord = {
          id: newId('videoclip'),
          projectId: job.projectId,
          shotId: job.shotId,
          remoteJobId: job.remoteJobId!,
          blob: content.blob,
          mimeType: 'video/mp4',
          width: output?.width ?? 480,
          height: output?.height ?? 848,
          duration: output?.duration ?? job.seconds,
          fps: output?.fps ?? 24,
          promptSnapshot: job.prompt,
          model: profile.model,
          ...(job.seed !== undefined ? { seed: job.seed } : {}),
          createdAt: new Date().toISOString(),
          byteSize: content.byteSize,
        };
        job.status = 'saved';
        job.outputClipId = clip.id;
        job.progress = 100;
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
        job.error = undefined;
        // 原子：写新 clip + 删旧 clip + 写 job 在同一事务；失败回滚，旧片保留
        await saveVideoClipReplacingShot(job, clip);
        set({
          jobs: replaceJob(get().jobs, job),
          clips: withClipAlias(get().clips, job.projectId, job.shotId, clip),
        });
        await pruneVideoJobs(50);
      } catch (error) {
        const normalized = normalizeVideoError(error);
        const failures = (job.pollFailures ?? 0) + 1;
        job.pollFailures = failures;
        job.error = normalized.message;
        job.updatedAt = new Date().toISOString();
        if (normalized.status === 429 || (normalized.status ?? 0) >= 500 || normalized.retryable) {
          job.nextPollAt = new Date(Date.now() + Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** (failures - 1))).toISOString();
        } else {
          job.status = 'failed';
          job.finishedAt = job.updatedAt;
        }
        await persistJob(job);
        set({ jobs: replaceJob(get().jobs, job) });
      }
    }
    } finally {
      pollInFlight = false;
      schedulePolling(get);
    }
  },

  recoverJobs: async () => {
    const jobs = await listVideoJobs();
    for (const job of jobs) {
      if (isActive(job.status) && !job.remoteJobId) {
        job.status = 'submit-uncertain';
        job.error = '上次提交结果不确定，可能已在服务端创建。先确认服务端任务，不要直接重试。';
        job.submitUncertainReason = job.error;
        job.updatedAt = new Date().toISOString();
        await persistJob(job);
      }
    }
    set({ jobs });
    schedulePolling(get);
  },

  stopWaiting: async (jobId) => {
    const job = get().jobs.find((item) => item.id === jobId);
    if (!job) return;
    const next: VideoJobRecord = {
      ...job,
      status: 'canceled',
      error: '已停止等待。服务端可能还在生成，完成后不会自动保存；过几分钟刷新看结果。',
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    await persistJob(next);
    set({ jobs: replaceJob(get().jobs, next) });
  },

  regenerate: async (shotId, options = {}) => {
    const project = useAppStore.getState().project;
    if (!project) return { ok: false, error: '还没有打开项目。' };
    // 旧成片先保留；新任务完成落库时由 deleteVideoClipsForShot 替换，
    // 避免重生成失败后旧视频也被提前删掉。
    return get().submitVideo(shotId, options);
  },

  deleteClip: async (projectIdOrShotId, maybeShotId) => {
    const projectId = maybeShotId ? projectIdOrShotId : currentProjectId();
    const shotId = maybeShotId ?? projectIdOrShotId;
    if (!projectId) return;
    const legacy = get().clips[shotId];
    const cached =
      get().clips[videoClipKey(projectId, shotId)] ??
      (currentProjectId() === projectId && legacy?.projectId === projectId ? legacy : undefined);
    if (cached) await deleteVideoClip(cached.id);
    await deleteVideoClipsForShot(projectId, shotId);
    set({ clips: removeClipFromCache(get().clips, projectId, shotId) });
  },

  getClip: async (projectIdOrShotId, maybeShotId) => {
    const projectId = maybeShotId ? projectIdOrShotId : currentProjectId();
    const shotId = maybeShotId ?? projectIdOrShotId;
    if (!projectId) {
      // 极端旧数据/未打开项目：只回退旧 shotId key，不猜项目
      return get().clips[shotId];
    }
    const key = videoClipKey(projectId, shotId);
    const legacy = get().clips[shotId];
    const cached =
      get().clips[key] ??
      (currentProjectId() === projectId && legacy?.projectId === projectId ? legacy : undefined);
    if (cached) return cached;
    const [latest] = await listVideoClipsForShot(projectId, shotId);
    if (latest) {
      set({
        clips: withClipAlias(get().clips, projectId, shotId, latest),
      });
    }
    return latest;
  },
}));

export {
  MAX_QUEUE,
  POLL_HIDDEN_MS,
  POLL_VISIBLE_MS,
  VideoServiceError,
  type VideoOutputMetadata,
};
