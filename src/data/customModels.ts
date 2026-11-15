/**
 * 自定义模型 · 纯数据层（v0.63 第三批）
 *
 * 这一层只做四件事：
 *  1. 校验用户填的配置（纯函数，不碰 store）；
 *  2. 读写 localStorage 里的配置列表（**不存 Key**）；
 *  3. 把配置映射成与内置同形状的 ModelProfile；
 *  4. 提供端点/模型列表 URL 的拼接。
 *
 * 注意：它**不 import profiles.ts / store/settings.ts**，避免循环依赖。
 * profiles.ts 反过来 import 这里的 readCustomProfiles()，findProfile 因此能
 * 同时解析内置与自定义档案；store/settings.ts 负责 CRUD 与 Key。
 */

import type { ModelCapabilities, ModelProfile } from '../types/model';
import {
  MAX_CUSTOM_MODELS_PER_MODALITY,
  PROTOCOL_MODALITY,
  type CustomModelConfig,
  type CustomModelDraft,
  type CustomModelValidation,
  type CustomProtocol,
} from '../types/customModel';

export const CUSTOM_MODELS_STORAGE_KEY = 'aniguide:custom-models';

export function customProfileId(modality: CustomModelConfig['modality'], id: string): string {
  return `custom:${modality}:${id}`;
}

/** Key 的存储键：复用现有 keys 存储，但要和内置厂商 Key 区分开 */
export function customVendorId(id: string): string {
  return `custom:${id}`;
}

export function isCustomProfileId(id: string): boolean {
  return id.startsWith('custom:');
}

/** 去掉首尾空白和尾部斜杠；空串返回 '' */
export function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** 把 baseUrl 和协议路径拼起来；已经带该路径时原样返回 */
export function joinEndpoint(baseUrl: string, suffix: string): string {
  const base = cleanBaseUrl(baseUrl);
  const cleanSuffix = suffix.replace(/^\/+/, '');
  if (base.endsWith(`/${cleanSuffix}`)) return base;
  return `${base}/${cleanSuffix}`;
}

/** GET 模型列表的 URL（OpenAI/vLLM 兼容惯例；baseUrl 应含 /v1 时由用户填写） */
export function customModelsUrl(baseUrl: string): string {
  return joinEndpoint(baseUrl, 'models');
}

function isProtocol(value: unknown): value is CustomProtocol {
  return (
    value === 'openai-chat' ||
    value === 'openai-images' ||
    value === 'vllm-omni-chat-image' ||
    value === 'openai-videos'
  );
}

function normalizeCapabilities(
  draft: CustomModelDraft,
): CustomModelDraft['capabilities'] {
  const caps = draft.capabilities ?? {};
  const result: NonNullable<CustomModelDraft['capabilities']> = {};
  if (caps.maxReferenceImages !== undefined) {
    result.maxReferenceImages = caps.maxReferenceImages;
  }
  if (caps.negativePrompt !== undefined) result.negativePrompt = caps.negativePrompt;
  if (caps.seed !== undefined) result.seed = caps.seed;
  if (caps.maxOutputImages !== undefined) result.maxOutputImages = caps.maxOutputImages;
  if (caps.maxOutputTokens !== undefined) result.maxOutputTokens = caps.maxOutputTokens;
  return result;
}

function validateCapabilities(
  modality: CustomModelDraft['modality'],
  caps: CustomModelDraft['capabilities'],
  errors: CustomModelValidation['errors'],
): void {
  if (!caps) return;
  const isNonNegativeInt = (value: unknown): boolean =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0;
  if (caps.maxReferenceImages !== undefined && !isNonNegativeInt(caps.maxReferenceImages)) {
    errors.capabilities = '参考图上限必须是非负整数。';
  }
  if (caps.maxOutputImages !== undefined) {
    if (!Number.isInteger(caps.maxOutputImages) || caps.maxOutputImages < 1) {
      errors.capabilities = '最多出图张数必须是 ≥1 的整数。';
    }
  }
  if (caps.maxOutputTokens !== undefined) {
    if (!Number.isInteger(caps.maxOutputTokens) || caps.maxOutputTokens < 1) {
      errors.capabilities = '最大输出 token 必须是 ≥1 的整数。';
    }
  }
  if (modality === 'text' && caps.maxReferenceImages !== undefined) {
    errors.capabilities = '文字模型不支持参考图，请不要填参考图上限。';
  }
  if (modality === 'video' && (caps.maxReferenceImages ?? 0) > 0) {
    errors.capabilities = '视频接入下一批，暂不支持参考图能力。';
  }
}

/**
 * 校验自定义配置（纯函数）。
 *
 * `requiresKey=true` 但还没填 Key **不是校验失败**：保存配置不应被 Key 阻塞；
 * 生成前 readiness 再报人话（见报告「Key 与 readiness」）。
 */
export function validateCustomModel(draft: CustomModelDraft): CustomModelValidation {
  const errors: CustomModelValidation['errors'] = {};
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (name.length === 0) errors.name = '请填写显示名。';

  if (draft.modality !== 'text' && draft.modality !== 'image' && draft.modality !== 'video') {
    errors.modality = '请选择文字 / 图片 / 视频。';
  }
  if (!isProtocol(draft.protocol)) {
    errors.protocol = '请选择支持的协议。';
  } else if (
    draft.modality === 'text' ||
    draft.modality === 'image' ||
    draft.modality === 'video'
  ) {
    if (PROTOCOL_MODALITY[draft.protocol] !== draft.modality) {
      errors.protocol = '协议与模态不匹配。';
    }
  }

  const rawBase = typeof draft.baseUrl === 'string' ? draft.baseUrl.trim() : '';
  if (rawBase.length === 0) {
    errors.baseUrl = '请填写 base URL。';
  } else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(rawBase);
    } catch {
      errors.baseUrl = '地址格式不正确，需要 http:// 或 https:// 开头的完整地址。';
    }
    if (parsed) {
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.baseUrl = '只支持 http / https 地址。';
      } else if (parsed.username || parsed.password) {
        errors.baseUrl = '地址里不能带用户名/密码，凭据请填到 API Key。';
      } else if (parsed.search || parsed.hash) {
        errors.baseUrl = 'base URL 不能带查询参数或 # 片段。';
      }
    }
  }

  const model = typeof draft.model === 'string' ? draft.model.trim() : '';
  if (model.length === 0) errors.model = '请填写模型名。';

  if (
    draft.timeoutMs !== undefined &&
    (!Number.isInteger(draft.timeoutMs) || draft.timeoutMs < 1000 || draft.timeoutMs > 600_000)
  ) {
    errors.timeoutMs = '超时需在 1000–600000 毫秒之间。';
  }

  validateCapabilities(draft.modality, draft.capabilities, errors);

  const normalized: CustomModelDraft = {
    name,
    modality: draft.modality,
    protocol: draft.protocol,
    baseUrl: cleanBaseUrl(rawBase),
    model,
    requiresKey: draft.requiresKey !== false,
    ...(draft.timeoutMs !== undefined ? { timeoutMs: draft.timeoutMs } : {}),
    capabilities: normalizeCapabilities(draft),
  };

  return Object.keys(errors).length === 0
    ? { ok: true, errors: {}, normalized }
    : { ok: false, errors };
}

/** 配置 → 统一 ModelProfile（内置档案同形状，走既有网关/执行器） */
export function customModelToProfile(config: CustomModelConfig): ModelProfile {
  const baseUrl = cleanBaseUrl(config.baseUrl);
  const requiresKey = config.requiresKey !== false;
  const vendorId = customVendorId(config.id);
  const common = {
    id: customProfileId(config.modality, config.id),
    vendorId,
    name: config.name,
    provider: '自定义',
    lang: config.modality === 'text' ? ('zh' as const) : ('en' as const),
    endpoint: baseUrl,
    authType: requiresKey ? ('bearer' as const) : ('none' as const),
    model: config.model,
    corsDirect: 'unknown' as const,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    notes: '自定义接入配置。能力按你填的声明；不确定的项默认 0/false，不自动猜测。',
  };

  if (config.modality === 'text') {
    return {
      ...common,
      type: 'llm',
      group: 'llm-experimental',
      apiFlavor: 'openai',
      endpoint: joinEndpoint(baseUrl, 'chat/completions'),
      ...(config.capabilities?.maxOutputTokens !== undefined
        ? { maxOutputTokens: config.capabilities.maxOutputTokens }
        : {}),
      capabilities: {
        negativePrompt: false,
        seed: false,
        referenceImage: false,
        maxReferenceImages: 0,
        maxOutputImages: 0,
      },
    };
  }

  if (config.modality === 'video') {
    return {
      ...common,
      type: 'i2v',
      // 视频生成本批不实现；apiFlavor 先给 openai 让类型/展示可用，不参与生成。
      apiFlavor: 'openai',
      capabilities: {
        negativePrompt: false,
        seed: false,
        referenceImage: false,
        maxReferenceImages: 0,
        maxOutputImages: 0,
      },
    };
  }

  const caps = config.capabilities ?? {};
  const maxReferenceImages = Math.max(0, caps.maxReferenceImages ?? 0);
  const maxOutputImages = Math.max(1, caps.maxOutputImages ?? 1);
  const negativePrompt = caps.negativePrompt === true;
  const seed = caps.seed === true;
  const capabilities: ModelCapabilities = {
    negativePrompt,
    seed,
    referenceImage: maxReferenceImages > 0,
    maxReferenceImages,
    maxOutputImages,
    ...(maxReferenceImages > 0
      ? {
          reference: {
            semantics: 'reference' as const,
            maxImages: maxReferenceImages,
            acceptsDataUri: true,
            aspectFollows: 'param' as const,
          },
        }
      : {}),
  };

  if (config.protocol === 'vllm-omni-chat-image') {
    return {
      ...common,
      type: 't2i',
      group: 't2i-experimental',
      apiFlavor: 'chat-completions-image',
      endpoint: joinEndpoint(baseUrl, 'chat/completions'),
      capabilities,
    };
  }

  return {
    ...common,
    type: 't2i',
    group: 't2i-experimental',
    apiFlavor: 'openai',
    endpoint: joinEndpoint(baseUrl, 'images/generations'),
    imagePayload: {
      promptField: 'prompt',
      sizeField: 'size',
      countField: 'n',
      negativePromptField: negativePrompt ? 'negative_prompt' : null,
      referenceField: maxReferenceImages > 0 ? 'image' : null,
    },
    capabilities,
  };
}

/** 读配置列表；损坏 JSON / 不合法条目直接丢弃（不阻塞应用启动） */
export function readCustomModelConfigs(storage?: Pick<Storage, 'getItem'>): CustomModelConfig[] {
  const target =
    storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  if (!target) return [];
  try {
    const raw = target.getItem(CUSTOM_MODELS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: CustomModelConfig[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Partial<CustomModelConfig>;
      if (typeof record.id !== 'string' || record.id.length === 0) continue;
      if (seen.has(record.id)) continue;
      const validation = validateCustomModel({
        name: record.name ?? '',
        modality: record.modality as CustomModelDraft['modality'],
        protocol: record.protocol as CustomModelDraft['protocol'],
        baseUrl: record.baseUrl ?? '',
        model: record.model ?? '',
        requiresKey: record.requiresKey,
        ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
        capabilities: record.capabilities ?? {},
      });
      if (!validation.ok || !validation.normalized) continue;
      seen.add(record.id);
      const normalized = validation.normalized;
      out.push({
        ...normalized,
        requiresKey: normalized.requiresKey !== false,
        capabilities: normalized.capabilities ?? {},
        id: record.id,
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** 写配置列表；失败（隐私模式/配额）返回 false，不抛异常 */
export function writeCustomModelConfigs(
  configs: CustomModelConfig[],
  storage?: Pick<Storage, 'setItem'>,
): boolean {
  const target =
    storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  if (!target) return false;
  try {
    target.setItem(CUSTOM_MODELS_STORAGE_KEY, JSON.stringify(configs));
    return true;
  } catch {
    return false;
  }
}

/** 读成 ModelProfile 列表（供 findProfile/UI 动态展示） */
export function readCustomProfiles(storage?: Pick<Storage, 'getItem'>): ModelProfile[] {
  return readCustomModelConfigs(storage).map(customModelToProfile);
}

export function findCustomProfile(
  id: string,
  storage?: Pick<Storage, 'getItem'>,
): ModelProfile | undefined {
  return readCustomProfiles(storage).find((profile) => profile.id === id);
}

/** 某模态当前数量（用于上限校验；UI 也可用） */
export function countCustomModels(
  configs: CustomModelConfig[],
  modality: CustomModelConfig['modality'],
): number {
  return configs.filter((config) => config.modality === modality).length;
}

export { MAX_CUSTOM_MODELS_PER_MODALITY };
