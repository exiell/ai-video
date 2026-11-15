/**
 * 自定义模型接入 · 数据模型（v0.63 第三批核心层）
 *
 * 一条配置只描述「怎么连」；它会被映射成与内置档案同形状的 ModelProfile，
 * 走既有的 gateway/readyness/出图执行器。内置厂商不受影响。
 */

export type CustomModality = 'text' | 'image' | 'video';

/**
 * 允许的协议。只实现 OpenAI 兼容系与 vLLM 本地 chat 图片；
 * `openai-videos` 是占位：本批只保存/校验配置，不实现视频生成。
 */
export type CustomProtocol =
  | 'openai-chat'
  | 'openai-images'
  | 'vllm-omni-chat-image'
  | 'openai-videos';

export const CUSTOM_MODALITIES: readonly CustomModality[] = ['text', 'image', 'video'];

export const CUSTOM_PROTOCOLS: readonly CustomProtocol[] = [
  'openai-chat',
  'openai-images',
  'vllm-omni-chat-image',
  'openai-videos',
];

export const PROTOCOL_MODALITY: Record<CustomProtocol, CustomModality> = {
  'openai-chat': 'text',
  'openai-images': 'image',
  'vllm-omni-chat-image': 'image',
  'openai-videos': 'video',
};

/** 每模态配置上限（防止 UI/存储被滥用） */
export const MAX_CUSTOM_MODELS_PER_MODALITY = 10;

export interface CustomModelCapabilities {
  /** 图片：最多参考图数；不确定默认 0，不猜 */
  maxReferenceImages?: number;
  /** 图片：是否支持负向词；默认 false */
  negativePrompt?: boolean;
  /** 图片：是否支持 seed；默认 false */
  seed?: boolean;
  /** 图片：最多出图张数；默认 1（出图至少一张，这个 1 不是「猜能力」，是可用下限） */
  maxOutputImages?: number;
  /** 文字：最大输出 token（可选，空则用网关默认） */
  maxOutputTokens?: number;
}

/** 新建/更新时用户填的内容（id/createdAt 由 store 生成） */
export interface CustomModelDraft {
  name: string;
  modality: CustomModality;
  protocol: CustomProtocol;
  baseUrl: string;
  model: string;
  /** 默认 true；本地模型可 false（不发 Authorization） */
  requiresKey?: boolean;
  timeoutMs?: number;
  capabilities?: CustomModelCapabilities;
}

export interface CustomModelConfig extends CustomModelDraft {
  id: string;
  createdAt: string;
  /** 规范化后的必填布尔值 */
  requiresKey: boolean;
  capabilities: CustomModelCapabilities;
}

export type CustomModelField = 'name' | 'modality' | 'protocol' | 'baseUrl' | 'model' | 'timeoutMs' | 'capabilities';

export interface CustomModelValidation {
  ok: boolean;
  errors: Partial<Record<CustomModelField, string>>;
  /** 只有 ok=true 时有：去掉尾斜杠、补默认值后的草稿 */
  normalized?: CustomModelDraft;
}

/** 默认 LLM 档案 id（自定义删除后回退用；必须与内置一致） */
export const DEFAULT_LLM_PROFILE_ID = 'deepseek-flash';
