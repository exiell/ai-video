/**
 * 图片模型适配器（v0.61 第一批）。
 *
 * 统一请求（ImageGenerationRequest）→ 各 apiFlavor 的适配器：
 *  - openai / dashscope-sync / dashscope-async：包装既有载荷/解析函数，
 *    不改变任何字段（既有云端行为不变）；
 *  - chat-completions-image：本地 FLUX3（/v1/chat/completions，多图走 content）。
 *
 * v0.62 起 generate.ts 的云端+本地都走这里的执行器；旧符号
 * （buildImagePayloadFor / extractImageUrlsFor / request）保留作为测试 oracle/兼容出口。
 */

import type { ApiFlavor, ModelProfile } from '../../types/model';
import {
  buildChatCompletionsImagePayload,
  buildImagePayloadFor,
  chatCompletionsUrl,
  extractChatCompletionsImageUrls,
  extractImageUrlsFor,
  request,
  type ImageRequestOptions,
  type TransportConfig,
} from './index';
import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  PreparedImageRequest,
} from './types';

export interface ImageAdapter {
  readonly apiFlavor: ApiFlavor;
  /** 把统一请求翻译成网关可发的 URL + body */
  buildRequest(profile: ModelProfile, req: ImageGenerationRequest): PreparedImageRequest;
  /** 从原始响应里取出图片引用（data URI 或 URL），保持顺序 */
  parseResponse(profile: ModelProfile, response: unknown): string[];
  /** 适配器默认超时；undefined 表示沿用网关既有默认（云端 180s） */
  readonly defaultTimeoutMs?: number;
  /** 把底层异常翻成一句人话（不改变既有 GatewayError 的展示） */
  normalizeError(error: unknown): string;
}

function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'info' in error) {
    const info = (error as { info?: { title?: string; advice?: string } }).info;
    if (info?.title) return `${info.title}。${info.advice ?? ''}`.trim();
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return '请求已取消或超时。';
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * b64_json fallback（v0.62，严格收窄）。
 *
 * 规则（复验后收紧，不再递归扫描整个响应）：
 *  - 只认顶层 `data[]` 数组项里的 `b64_json` 字符串；
 *  - 必须能 base64 解码，且字节的 magic 是图片（PNG/JPEG/WebP/GIF）；
 *  - 非法候选直接忽略，不产出坏 dataUrl；
 *  - 绝不扫描 error / message / echo / DashScope output 等其它字段。
 */
function sniffImageMime(bytes: Uint8Array): string | undefined {
  const startsWith = (header: number[]): boolean =>
    header.every((byte, index) => bytes[index] === byte);
  // PNG 89 50 4E 47 0D 0A 1A 0A
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // JPEG FF D8 FF
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  // GIF87a / GIF89a
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  // WebP: RIFF....WEBP
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

function decodeValidImageB64(b64: string): string | undefined {
  const cleaned = b64.replace(/\s+/g, '');
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return undefined;
  const remainder = cleaned.length % 4;
  if (remainder === 1) return undefined;
  const padded = remainder === 0 ? cleaned : cleaned + '='.repeat(4 - remainder);
  try {
    const binary = atob(padded);
    if (!binary) return undefined;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const mime = sniffImageMime(bytes);
    if (!mime) return undefined;
    return `data:${mime};base64,${padded}`;
  } catch {
    return undefined;
  }
}

function parseWithB64Fallback(profile: ModelProfile, response: unknown): string[] {
  const urls = extractImageUrlsFor(profile, response);
  if (urls.length > 0) return urls;
  if (typeof response !== 'object' || response === null) return [];
  const data = (response as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const b64 = (item as Record<string, unknown>).b64_json;
    if (typeof b64 !== 'string' || b64.trim().length === 0) continue;
    const dataUrl = decodeValidImageB64(b64);
    if (dataUrl) out.push(dataUrl);
  }
  return [...new Set(out)];
}

function toImageOptions(
  profile: ModelProfile,
  req: ImageGenerationRequest,
): ImageRequestOptions {
  return {
    model: profile.model ?? profile.name,
    prompt: req.prompt,
    ...(req.negativePrompt !== undefined ? { negativePrompt: req.negativePrompt } : {}),
    ...(req.aspectRatio !== undefined ? { aspectRatio: req.aspectRatio } : {}),
    ...(req.size !== undefined ? { imageSize: req.size } : {}),
    ...(req.count !== undefined ? { batchSize: req.count } : {}),
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
    ...(req.referenceImages.length > 0 ? { referenceImages: req.referenceImages } : {}),
  };
}

const openAiLikeAdapter: ImageAdapter = {
  apiFlavor: 'openai',
  buildRequest(profile, req) {
    return { url: profile.endpoint, body: buildImagePayloadFor(profile, toImageOptions(profile, req)) };
  },
  parseResponse(profile, response) {
    return parseWithB64Fallback(profile, response);
  },
  normalizeError: describeError,
};

const dashScopeSyncAdapter: ImageAdapter = {
  apiFlavor: 'dashscope-sync',
  buildRequest(profile, req) {
    return { url: profile.endpoint, body: buildImagePayloadFor(profile, toImageOptions(profile, req)) };
  },
  // DashScope 的图在 output.*；保持旧解析，不套 OpenAI 的 data[].b64 fallback
  parseResponse(profile, response) {
    return extractImageUrlsFor(profile, response);
  },
  normalizeError: describeError,
};

const dashScopeAsyncAdapter: ImageAdapter = {
  apiFlavor: 'dashscope-async',
  buildRequest(profile, req) {
    return { url: profile.endpoint, body: buildImagePayloadFor(profile, toImageOptions(profile, req)) };
  },
  // 异步任务的图要靠轮询拿；本适配器只负责创建请求。既有 generate.ts 的异步分支保持不变。
  parseResponse() {
    return [];
  },
  normalizeError: describeError,
};

const chatCompletionsImageAdapter: ImageAdapter = {
  apiFlavor: 'chat-completions-image',
  defaultTimeoutMs: 600_000,
  buildRequest(profile, req) {
    return {
      url: chatCompletionsUrl(profile.endpoint),
      body: buildChatCompletionsImagePayload(toImageOptions(profile, req)),
    };
  },
  parseResponse(_profile, response) {
    return extractChatCompletionsImageUrls(response);
  },
  normalizeError: describeError,
};

const ADAPTERS: Record<ApiFlavor, ImageAdapter> = {
  openai: openAiLikeAdapter,
  'dashscope-sync': dashScopeSyncAdapter,
  'dashscope-async': dashScopeAsyncAdapter,
  'chat-completions-image': chatCompletionsImageAdapter,
};

export function getImageAdapter(profile: ModelProfile): ImageAdapter {
  return ADAPTERS[profile.apiFlavor ?? 'openai'] ?? openAiLikeAdapter;
}

export interface ExecuteImageGenerationOptions {
  profile: ModelProfile;
  /** 本地模型可以传空字符串（authType: 'none'） */
  apiKey?: string;
  request: ImageGenerationRequest;
  transport?: TransportConfig;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface ImageGenerationExecution extends ImageGenerationResult {
  /**
   * 只包含**响应本身就是 data URI** 的图；URL 响应时为空数组。
   * 完整图片引用看 `imageRefs`，URL 的下载/安全校验由 generate.ts 的 prefetch 负责。
   */
  images: ImageGenerationResult['images'];
  /** 原始响应，便于排查/测试 */
  response: unknown;
  /** 解析出的全部图片引用（URL 或 data URI），顺序与响应一致 */
  imageRefs: string[];
}

/** 结果里已经是 data URI 的图（云端 URL 交给 generate.ts 的 prefetch 安全校验） */
function dataUriImages(imageRefs: string[]): ImageGenerationResult['images'] {
  return imageRefs
    .filter((ref) => ref.startsWith('data:image/'))
    .map((dataUrl) => ({ dataUrl }));
}

/**
 * 执行一次统一生图请求：选适配器 → 构造 → 发请求 → 解析。
 *
 * 只负责「请求 + 解析出图片引用」；URL 的下载与安全校验（30MB/协议/content-type）
 * 仍归 generate.ts 的 prefetch 负责，保证迁移后安全边界不变。
 * `images` 里只包含响应本身就是 data URI 的图；云端 URL 用 `imageRefs`。
 */
export async function executeImageGeneration(
  options: ExecuteImageGenerationOptions,
): Promise<ImageGenerationExecution> {
  const { profile, request: req, transport, fetchImpl = fetch, signal } = options;
  const adapter = getImageAdapter(profile);
  const prepared = adapter.buildRequest(profile, req);
  const timeoutMs = req.timeoutMs ?? adapter.defaultTimeoutMs;
  const started = Date.now();

  const response = await request({
    profile,
    apiKey: options.apiKey ?? '',
    ...(prepared.url ? { url: prepared.url } : {}),
    body: prepared.body,
    ...(transport ? { transport } : {}),
    fetchImpl,
    ...(signal ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

  const imageRefs = adapter.parseResponse(profile, response);
  return {
    images: dataUriImages(imageRefs),
    elapsedMs: Date.now() - started,
    imageRefs,
    response,
  };
}
