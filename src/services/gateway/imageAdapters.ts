/**
 * 图片模型适配器（v0.61 第一批）。
 *
 * 统一请求（ImageGenerationRequest）→ 各 apiFlavor 的适配器：
 *  - openai / dashscope-sync / dashscope-async：包装既有载荷/解析函数，
 *    不改变任何字段（既有云端行为不变）；
 *  - chat-completions-image：本地 FLUX3（/v1/chat/completions，多图走 content）。
 *
 * 旧符号（buildImagePayloadFor / extractImageUrlsFor / request）全部保留；
 * 这里只是多一层注册表，不替换既有云端调用链。
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
    batchSize: req.count,
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
    return extractImageUrlsFor(profile, response);
  },
  normalizeError: describeError,
};

const dashScopeSyncAdapter: ImageAdapter = {
  apiFlavor: 'dashscope-sync',
  buildRequest(profile, req) {
    return { url: profile.endpoint, body: buildImagePayloadFor(profile, toImageOptions(profile, req)) };
  },
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
  /** 原始响应，便于排查/测试 */
  response: unknown;
  /** 解析出的图片引用（可能尚未下载） */
  imageRefs: string[];
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mime};base64,${btoa(binary)}`;
}

async function fetchAsDataUrl(
  ref: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await fetchImpl(ref, signal ? { signal } : {});
  if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`);
  const mime = response.headers?.get?.('content-type')?.split(';')[0]?.trim() || 'image/png';
  const buffer = await response.arrayBuffer();
  return bytesToDataUrl(new Uint8Array(buffer), mime.startsWith('image/') ? mime : 'image/png');
}

/** 把图片引用归一成 data URI；本地响应通常已经是 data URI。 */
async function normalizeImageRefs(
  refs: string[],
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const out: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith('data:image/')) {
      out.push(ref);
    } else if (/^https?:\/\//.test(ref)) {
      out.push(await fetchAsDataUrl(ref, fetchImpl, signal));
    } else if (ref.startsWith('data:')) {
      out.push(ref);
    } else {
      throw new Error('响应里的图片既不是 data URI 也不是 http(s) URL，无法归一化。');
    }
  }
  return out;
}

/**
 * 执行一次统一生图请求：选适配器 → 构造 → 发请求 → 解析 → 归一化 data URI。
 *
 * 注意：既有 `generateImages` 的云端分支仍走原链路（保证字节级行为一致）；
 * 这个执行器给本地适配器和新测试用，也可作为后续全量迁移的落点。
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
  const images = await normalizeImageRefs(imageRefs, fetchImpl, signal);
  return {
    images: images.map((dataUrl) => ({ dataUrl })),
    elapsedMs: Date.now() - started,
    imageRefs,
    response,
  };
}
