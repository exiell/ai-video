/**
 * 统一模型接口的内部类型（v0.61 第一批）。
 *
 * 这一层不绑定任何厂商协议：上层只描述「要生成什么」，由适配器
 * 决定翻译成 OpenAI / DashScope / chat-completions 的哪种请求。
 *
 * 注意：这里只放**出图**的请求/响应；文字模型仍走既有 chat 接口，
 * 不在本次统一范围内（避免一次改动过大）。
 */

/** 有序参考图：顺序即语义（第一张是角色、第二张是场景……） */
export type OrderedReferenceImages = string[];

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  /** 画幅比例，例：9:16。适配器可换算成 size 或 aspect 参数。 */
  aspectRatio?: string;
  /** 明确尺寸，例：1024x1024。有的协议只认 size。 */
  size?: string;
  /** 期望出图张数（适配器会按档案能力截断） */
  count: number;
  seed?: number;
  /** 有序的参考图 data URI；没有参考图时为空数组。 */
  referenceImages: OrderedReferenceImages;
  /** 单次请求超时；不传则由适配器/档案默认值决定。 */
  timeoutMs?: number;
}

export interface GeneratedImageData {
  /** 最终归一化的 data URI（本地响应本来就是 data URI；云端 URL 会下载转换）。 */
  dataUrl: string;
  width?: number;
  height?: number;
}

export interface ImageGenerationResult {
  images: GeneratedImageData[];
  /** 从发起请求到拿到全部图片（含需要时下载转换）的耗时 */
  elapsedMs?: number;
  /** 厂商/服务返回的 request id（若有） */
  requestId?: string;
}

/** 适配器构造出的、可直接交给网关 request() 的请求 */
export interface PreparedImageRequest {
  url: string;
  body: Record<string, unknown>;
}
