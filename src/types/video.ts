/**
 * 视频层类型（v0.65 视频核心）
 *
 * 服务端契约：OpenAI Videos 形状的本地桥接（SkyReels，端口 8110）。
 * 这一层只描述「视频档案 / 任务 / 成片」；UI 和页面由后续批次接入。
 */

export type VideoProtocol = 'openai-videos';

export const VIDEO_PROTOCOLS: readonly VideoProtocol[] = ['openai-videos'];

export interface VideoCapabilities {
  /** 参考图张数上限；SkyReels 本地实测 1–4 */
  maxReferenceImages: number;
  /** 生成时长（秒）；第一版固定 5 */
  durationSeconds: number;
  /** 分辨率档；第一版固定 480P */
  resolution: '480P' | '540P' | '720P';
  /** 画幅跟随第一张参考图（首帧） */
  aspectFollowsFirstReference: boolean;
  supportsReferenceImages: boolean;
  requiresKey: boolean;
  /** 前端等待上限，必须覆盖服务端串行排队+生成 */
  maxTimeoutMs: number;
}

export const DEFAULT_VIDEO_CAPABILITIES: VideoCapabilities = {
  maxReferenceImages: 4,
  durationSeconds: 5,
  resolution: '480P',
  aspectFollowsFirstReference: true,
  supportsReferenceImages: true,
  requiresKey: false,
  maxTimeoutMs: 1_200_000,
};

/** 统一的视频档案视图；由 ModelProfile 的 i2v 档案转换而来 */
export interface VideoProfile {
  id: string;
  name: string;
  provider: string;
  /** 自定义视频档案的 vendorId（Key 存储用）；本地预设为空 */
  vendorId?: string;
  baseUrl: string;
  model: string;
  protocol: VideoProtocol;
  requiresKey: boolean;
  timeoutMs: number;
  capabilities: VideoCapabilities;
}

export type VideoAspect = 'vertical' | 'horizontal';

export type VideoJobStatus =
  | 'queued'
  | 'submitting'
  | 'submitted'
  | 'running'
  | 'saved'
  | 'failed'
  | 'canceled'
  | 'submit-uncertain';

export const ACTIVE_VIDEO_JOB_STATUSES: readonly VideoJobStatus[] = [
  'queued',
  'submitting',
  'submitted',
  'running',
];

export interface VideoOutputMetadata {
  width: number;
  height: number;
  duration: number;
  fps: number;
  byteSize: number;
  mimeType: string;
}

export interface VideoJobRecord {
  id: string;
  projectId: string;
  shotId: string;
  profileId: string;
  /** 提交时解析出的档案快照；档案删除后仍能按原 baseUrl/model 完成轮询 */
  profileSnapshot?: VideoProfile;
  /** 有序参考图 assetId；第 1 位固定本镜首帧 */
  referenceAssetIds: string[];
  prompt: string;
  seconds: number;
  resolution: string;
  seed?: number;
  negativePrompt?: string;
  status: VideoJobStatus;
  /** 服务端 job id；提交前为空 */
  remoteJobId?: string;
  /** 幂等键：同一次提交重试时保持不变；当前第一版只记录不重提 */
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  progress?: number | null;
  elapsedSeconds?: number | null;
  outputClipId?: string;
  /** 提交结果不确定时的说明；submit-uncertain 不自动重试 */
  submitUncertainReason?: string;
  /** 最近一次轮询时间 / 下次允许轮询时间（store 内部用） */
  lastPollAt?: string;
  nextPollAt?: string;
  /** 连续失败次数，用于指数退避 */
  pollFailures?: number;
}

export interface VideoClipRecord {
  id: string;
  projectId: string;
  shotId: string;
  remoteJobId: string;
  /** mp4 原始字节（IndexedDB Blob） */
  blob: Blob;
  mimeType: 'video/mp4';
  width: number;
  height: number;
  duration: number;
  fps: number;
  promptSnapshot: string;
  model: string;
  seed?: number;
  createdAt: string;
  byteSize: number;
}

export interface BuildReferencesResult {
  ok: boolean;
  /** 顺序即请求顺序；第 1 张永远是本镜首帧 */
  assetIds: string[];
  /** 与 assetIds 一一对应的 data URI */
  dataUrls: string[];
  aspect?: VideoAspect;
  error?: string;
}
