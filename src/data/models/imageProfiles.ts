/**
 * 本地图片模型预设（v0.66）
 *
 * 本地模型统一走「自定义接入」：预设只是表单预填，用户保存后仍是普通
 * CustomModelConfig(image / vllm-omni-chat-image)，不新增内置档案。
 */
import type { CustomModelDraft } from '../../types/customModel';
import type { ModelProfile } from '../../types/model';
import { findProfile } from './profiles';
import { applyLocalProfileOverrides } from '../../services/gateway/localModel';

/** Qwen-Image-Edit-2511：3 卡 + vLLM-Omni，纯改图，必须有至少 1 张输入图。 */
export const QWEN_IMAGE_EDIT_PRESET: CustomModelDraft = {
  name: '本地改图模型（Qwen-Image-Edit-2511）',
  modality: 'image',
  protocol: 'vllm-omni-chat-image',
  baseUrl: 'http://127.0.0.1:8098/v1',
  model: 'qwen-image-edit-2511',
  requiresKey: false,
  timeoutMs: 600_000,
  capabilities: {
    maxReferenceImages: 3,
    minReferenceImages: 1,
    maxOutputImages: 1,
  },
};


/** 解析「图像编辑」独立默认档案：未设置/找不到/不支持参考图 → undefined（不回退生成画面档案）。 */
export interface ImageEditProfilePrefs {
  defaultImageEditProfileId?: string;
  localModelEndpoint?: string;
  localModelTimeoutMs?: number;
}

export function resolveDefaultImageEditProfile(
  prefs: ImageEditProfilePrefs,
): ModelProfile | undefined {
  const id = prefs.defaultImageEditProfileId;
  if (!id) return undefined;
  const found = findProfile(id);
  if (!found || found.type !== 't2i' || found.capabilities.referenceImage !== true) {
    return undefined;
  }
  return applyLocalProfileOverrides(found, {
    endpoint: prefs.localModelEndpoint,
    timeoutMs: prefs.localModelTimeoutMs,
  });
}
