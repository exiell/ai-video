/**
 * 视频档案（v0.65 核心层）
 *
 * 本地模型统一走「自定义接入」：SkyReels 只提供一个预设草稿，由 UI/用户保存成
 * CustomModelConfig（video / openai-videos）；解析时把 ModelProfile('i2v') 转成
 * VideoProfile，不新增内置本地视频档案，避免破坏 v0.64 的方向。
 */
import type { ModelProfile } from '../../types/model';
import type { CustomModelConfig, CustomModelDraft } from '../../types/customModel';
import {
  DEFAULT_VIDEO_CAPABILITIES,
  type VideoCapabilities,
  type VideoProfile,
} from '../../types/video';
import { customModelToProfile, readCustomModelConfigs } from '../customModels';
import { findProfile } from './profiles';

export const SKYREELS_VIDEO_MODEL = 'skyreels-v3-r2v';
export const SKYREELS_VIDEO_BASE_URL = 'http://127.0.0.1:8110/v1';
export const SKYREELS_VIDEO_TIMEOUT_MS = 1_200_000;

/** 设置页「新建本地视频模型」的预填草稿；保存后成为普通自定义 video 配置。 */
export const SKYREELS_VIDEO_PRESET: CustomModelDraft = {
  name: 'SkyReels V3 R2V（本地）',
  modality: 'video',
  protocol: 'openai-videos',
  baseUrl: SKYREELS_VIDEO_BASE_URL,
  model: SKYREELS_VIDEO_MODEL,
  requiresKey: false,
  timeoutMs: SKYREELS_VIDEO_TIMEOUT_MS,
  capabilities: { maxReferenceImages: 4 },
};

export function videoCapabilitiesFromConfig(config: CustomModelConfig): VideoCapabilities {
  const maxReferenceImages = Math.min(4, Math.max(0, config.capabilities?.maxReferenceImages ?? 0));
  return {
    ...DEFAULT_VIDEO_CAPABILITIES,
    maxReferenceImages,
    supportsReferenceImages: maxReferenceImages > 0,
    requiresKey: config.requiresKey !== false,
    maxTimeoutMs: config.timeoutMs ?? DEFAULT_VIDEO_CAPABILITIES.maxTimeoutMs,
  };
}

/** ModelProfile('i2v') → VideoProfile；不是视频档案返回 null */
export function toVideoProfile(profile: ModelProfile | undefined): VideoProfile | null {
  if (!profile || profile.type !== 'i2v' || !profile.videoProtocol) return null;
  const caps = profile.videoCapabilities ?? DEFAULT_VIDEO_CAPABILITIES;
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    ...(profile.vendorId ? { vendorId: profile.vendorId } : {}),
    baseUrl: profile.endpoint,
    model: profile.model ?? profile.name,
    protocol: profile.videoProtocol,
    requiresKey: profile.authType !== 'none',
    timeoutMs: profile.timeoutMs ?? caps.maxTimeoutMs,
    capabilities: caps,
  };
}

export function resolveVideoProfileById(id: string): VideoProfile | null {
  return toVideoProfile(findProfile(id));
}

/** 所有自定义视频配置（按列表顺序） */
export function listCustomVideoProfiles(): VideoProfile[] {
  return readCustomModelConfigs()
    .filter((config) => config.modality === 'video')
    .map((config) => toVideoProfile(customModelToProfile(config)))
    .filter((profile): profile is VideoProfile => profile !== null);
}

/**
 * 默认视频档案解析：
 *  - 显式 defaultVideoProfileId 能解析 → 用它；
 *  - 否则只有一条自定义视频配置 → 用它；
 *  - 否则 null（UI 提示先配置）。
 */
export function resolveDefaultVideoProfile(
  defaultVideoProfileId: string | undefined,
  configs: CustomModelConfig[] = readCustomModelConfigs(),
): VideoProfile | null {
  if (defaultVideoProfileId) {
    const explicit = resolveVideoProfileById(defaultVideoProfileId);
    if (explicit) return explicit;
  }
  const videos = configs
    .filter((config) => config.modality === 'video')
    .map((config) => toVideoProfile(customModelToProfile(config)))
    .filter((profile): profile is VideoProfile => profile !== null);
  return videos.length === 1 ? videos[0]! : null;
}
