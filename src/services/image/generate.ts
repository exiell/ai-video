import type { Asset, ImageRequest, ImageResult, ModelProfile } from '../../types/model';
import { SCHEMA_VERSION } from '../../types/model';
import { request, buildImagePayloadFor, extractImageUrlsFor, type TransportConfig } from '../gateway';
import {
  extractDashScopeTaskId,
  parseDashScopeTaskStatus,
  withReferenceInstruction,
} from '../gateway/dashscope';
import { newId } from '../storage';

/**
 * 出图服务（方案.md §7.4 P0.5）
 *
 * 这个模块只解决一个问题：**把「一份画面意图」变成「一张已经安全落地的图」**。
 *
 * ===========================================================================
 * 为什么「落地」要单独做成一步（这是本模块最重要的设计）
 * ===========================================================================
 * 阿里云返回的是 OSS 临时链接，**24 小时后失效**。
 * 如果只把 URL 存进项目，用户第二天打开图库会看到一片裂图，
 * 而且他完全不知道为什么——这是一个会静默损坏数据的坑。
 *
 * 所以流程被强制拆成两步，中间不给调用方绕过的机会：
 *   1. 调接口，拿到临时 URL
 *   2. **立刻下载**，转成 base64 data URI，连同字节数一起返回
 *
 * 存入 IndexedDB 的永远是第 2 步的产物。临时 URL 只留作排查线索。
 */

// ---------------------------------------------------------------------------
// 下载并转 base64
// ---------------------------------------------------------------------------

export interface PrefetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface PrefetchedImage {
  dataUrl: string;
  byteSize: number;
  mimeType: string;
}

/**
 * 把一张临时链接的图下载下来，转成 base64 data URI。
 *
 * 用 FileReader 而不是手写 base64 编码：浏览器原生实现更快，且不需要处理
 * 分块与补齐。在 Node 测试环境里跑时，由调用方注入 mock 的实现。
 */
export async function prefetchImage(
  url: string,
  options: PrefetchOptions = {},
): Promise<PrefetchedImage> {
  const { fetchImpl = fetch, timeoutMs = 120_000 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`下载图片失败：HTTP ${response.status}`);
    }
    const rawBlob = await response.blob();
    const mimeType = rawBlob.type || 'image/png';
    // 有些存储返回的 blob 没有 type，FileReader 会给出 application/octet-stream。
    // 那会让 dataUrl 无法作为图片直接渲染，所以先补上正确的类型再转。
    const blob =
      rawBlob.type === mimeType ? rawBlob : new Blob([rawBlob], { type: mimeType });
    const dataUrl = await blobToDataUrl(blob);
    // base64 的实际字节数按 3/4 估算即可，不需要精确解码
    const base64Part = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const byteSize = Math.floor((base64Part.length * 3) / 4);
    return { dataUrl, byteSize, mimeType };
  } finally {
    clearTimeout(timer);
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('读取图片数据失败'));
      reader.readAsDataURL(blob);
    });
  }
  // 兜底：没有 FileReader 的环境（例如 Node 测试）
  const buffer = await blob.arrayBuffer();
  const base64 = bytesToBase64(new Uint8Array(buffer));
  return `data:${blob.type || 'image/png'};base64,${base64}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// 出图
// ---------------------------------------------------------------------------

export interface GenerateImagesOptions {
  profile: ModelProfile;
  apiKey: string;
  req: ImageRequest;
  transport?: TransportConfig;
  fetchImpl?: typeof fetch;
  /** 是否在返回前把图下载并转成 dataUrl。默认 true —— 关掉它是危险操作。 */
  prefetch?: boolean;
  /** 测试用：自定义预取实现 */
  prefetchImpl?: (url: string) => Promise<PrefetchedImage>;
}

export interface GenerateImagesOutcome {
  ok: boolean;
  images: ImageResult['images'];
  requestId?: string;
  error?: string;
  /** 非致命的提示，例：有图没能下载成功 */
  warnings: string[];
}

/**
 * 生成图片。
 *
 * 落地的图以 `dataUrl` 形式返回；`url` 是临时链接，只用于排查。
 */
export async function generateImages(
  options: GenerateImagesOptions,
): Promise<GenerateImagesOutcome> {
  const {
    profile,
    apiKey,
    req,
    transport,
    fetchImpl,
    prefetch = true,
    prefetchImpl,
  } = options;

  const warnings: string[] = [];
  const requestedReferences = req.referenceImages ?? [];

  // 先判断「支不支持」，再决定要不要截断。
  // 顺序反过来会让「不支持参考图」这条警告永远不触发——因为数组已经被截成空的，
  // 后面的长度比较就永远成立不了。这类逻辑顺序错误只能靠测试发现。
  const referenceImages = profile.capabilities.referenceImage
    ? requestedReferences.slice(0, profile.capabilities.maxReferenceImages || 0)
    : [];
  if (requestedReferences.length > 0 && !profile.capabilities.referenceImage) {
    warnings.push(`${profile.name} 不支持参考图，本次调用已按纯文生图处理。`);
  } else if (requestedReferences.length > referenceImages.length) {
    warnings.push(
      `${profile.name} 最多接受 ${profile.capabilities.maxReferenceImages} 张参考图，多出的已忽略。`,
    );
  }

  const flavor = profile.apiFlavor ?? 'openai';

  /**
   * 参考图说明。
   *
   * 【v0.28 修】原来这里加了 `&& flavor === 'dashscope-sync'`，
   * 意思是「只有千问才写这段说明」。那是把「千问需要这段说明」
   * 误解成了「只有千问才配拥有参考图」——
   * 而说明本身只是一段**加在提示词前面的文字**，对所有支持参考图的模型都有意义。
   *
   * 现在只要真有参考图就加。说明里会按参考图的角色分开写
   * （本镜首帧管构图、角色形象图管外观、上一镜尾帧管跨镜连续）。
   */
  const effectivePrompt =
    referenceImages.length > 0
      ? withReferenceInstruction(req.prompt, {
          referenceCount: referenceImages.length,
          hasFirstFrameAnchor: req.frameRole?.hasFirstFrameAnchor ?? false,
          hasPreviousEndAnchor: req.frameRole?.hasPreviousEndAnchor ?? false,
          ...(req.frameRole?.roles ? { roles: req.frameRole.roles } : {}),
          ...(req.frameRole ? { frameKind: req.frameRole.kind } : {}),
          ...(req.frameRole?.shotSizeEn ? { shotSizeEn: req.frameRole.shotSizeEn } : {}),
          ...(req.frameRole?.cameraPositionEn
            ? { cameraPositionEn: req.frameRole.cameraPositionEn }
            : {}),
        })
      : req.prompt;

  /**
   * 载荷交给网关统一构造。
   *
   * ===========================================================================
   * 【v0.28 修】这里原来有一份**自己拼载荷**的代码
   * ===========================================================================
   * 它硬编码成 OpenAI 形状，于是：
   *  - MiniMax 收不到 `aspect_ratio`，反而收到它不认识的 `image: [...]`
   *  - 智谱与硅基流动的尺寸字段名（`size` / `image_size`）也全错
   *
   * 而网关里那份 `buildImagePayloadFor`（会读档案声明的 `imagePayload` 字段映射）
   * **全项目无人调用**——两份平行实现，测试只覆盖了网关那份，
   * 所以测试全绿而新加的提供方实际不可用。
   *
   * 现在只有一处构造：网关。档案声明字段名，网关照着拼。
   */
  const payload = buildImagePayloadFor(profile, {
    model: profile.model ?? profile.name,
    prompt: effectivePrompt,
    ...(req.negativePrompt !== undefined ? { negativePrompt: req.negativePrompt } : {}),
    ...(req.aspectRatio !== undefined ? { aspectRatio: req.aspectRatio } : {}),
    ...(req.count !== undefined
      ? { batchSize: Math.min(req.count, profile.capabilities.maxOutputImages || 1) }
      : {}),
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
    ...(referenceImages.length > 0 ? { referenceImages } : {}),
  });

  try {
    const response = await request({
      profile,
      apiKey,
      body: payload,
      ...(transport ? { transport } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });

    /**
     * 响应解析同样交给网关。
     *
     * 【v0.28 修】原来非异步的情况一律用 `extractDashScopeSyncImages`，
     * 它只认千问那套嵌套三层（`output.choices[0].message.content[0].image`）。
     * 换成 OpenAI 形状的提供方（智谱 / MiniMax / 硅基流动）时，
     * 响应里明明有图，这里却解析出 0 张，然后报「接口通了但没返回图片地址」——
     * 一个会把用户引向错误方向的报错。
     */
    const urls =
      flavor === 'dashscope-async'
        ? await pollDashScopeTask(profile, apiKey, response, { transport, fetchImpl })
        : extractImageUrlsFor(profile, response);

    if (urls.length === 0) {
      return {
        ok: false,
        images: [],
        warnings,
        error:
          '接口调用成功了，但没有返回图片地址。可能是提示词被安全策略拦下，或者接口返回了意料之外的结构。',
      };
    }

    const images: ImageResult['images'] = [];
    for (const url of urls) {
      const entry: ImageResult['images'][number] = { url };
      if (prefetch) {
        try {
          const fetched = prefetchImpl
            ? await prefetchImpl(url)
            : await prefetchImage(url, fetchImpl ? { fetchImpl } : {});
          entry.dataUrl = fetched.dataUrl;
        } catch (error) {
          // 单张下载失败不能葬送整批——但必须如实告诉用户
          warnings.push(
            `有一张图没能下载到本地（${error instanceof Error ? error.message : String(error)}）。` +
              '它的链接 24 小时后会失效，请尽快手动保存。',
          );
        }
      }
      images.push(entry);
    }

    return {
      ok: true,
      images,
      warnings,
      ...(extractRequestId(response) !== undefined
        ? { requestId: extractRequestId(response)! }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      images: [],
      warnings,
      error: describeGatewayFailure(error),
    };
  }
}

function extractRequestId(response: unknown): string | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const id = (response as Record<string, unknown>).request_id;
  return typeof id === 'string' ? id : undefined;
}

/** 把网关错误翻成一句用户能懂的话（细节由界面上的折叠区负责） */
function describeGatewayFailure(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'info' in error) {
    const info = (error as { info?: { title?: string; advice?: string } }).info;
    if (info?.title) return `${info.title}。${info.advice ?? ''}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 异步任务轮询（wanx 等系列；千问图像走同步接口，用不到这段）
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 180_000;

async function pollDashScopeTask(
  profile: ModelProfile,
  apiKey: string,
  createResponse: unknown,
  options: { transport?: TransportConfig; fetchImpl?: typeof fetch },
): Promise<string[]> {
  const taskId = extractDashScopeTaskId(createResponse);
  if (!taskId) return [];

  const base = new URL(profile.endpoint).origin;
  const taskUrl = `${base}/api/v1/tasks/${encodeURIComponent(taskId)}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const started = Date.now();

  while (Date.now() - started < POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const response = await fetchImpl(taskUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const text = await response.text();
    const parsed = parseDashScopeTaskStatus(safeJson(text));
    if (parsed.status === 'SUCCEEDED') return parsed.urls;
    if (parsed.status === 'FAILED' || parsed.status === 'CANCELED') {
      throw new Error(`生成任务失败：${parsed.message ?? parsed.status}`);
    }
  }
  throw new Error('生成任务超时（超过 3 分钟仍未完成）。稍后可以在平台控制台查看任务结果。');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 转成可持久化的素材
// ---------------------------------------------------------------------------

export interface AssetDraft {
  projectId: string;
  kind: Asset['kind'];
  refId: string;
  promptSnapshot: string;
  model?: string;
  lockPhrases?: string[];
  referenceCount?: number;
  /** 生成时项目的风格关键词，存进素材便于日后判断「这张图还合不合现在的风格」 */
  styleTags?: string[];
  /**
   * 出的是哪一帧，以及参考图里是否含本镜首帧。
   * 它会**存进素材记录**，便于事后核对「这张图当时是拿什么当锚点的」。
   */
  frameRole?: {
    kind: 'first-frame' | 'action-peak' | 'end-frame';
    /** 参考图里含本镜首帧（锁本镜构图） */
    hasFirstFrameAnchor: boolean;
    /** 参考图里含上一镜尾帧（锁跨镜连续） */
    hasPreviousEndAnchor?: boolean;
    /** 各张参考图的职责，按传图顺序 */
    roles?: string[];
    /** 这一镜的景别（英文）。承接镜时用来明说「取景可以改、地方不能动」 */
    shotSizeEn?: string;
    /** 这一镜的机位 */
    cameraPositionEn?: string;
  };
  seed?: number;
}

export interface BuildAssetsOutcome {
  assets: Asset[];
  /** 没能落地的图（下载失败），如实报告而不是丢掉 */
  dropped: number;
  warnings: string[];
}

/**
 * 把生成结果转成可持久化的素材。
 *
 * **只把已经成功转成 dataUrl 的图收进来**——没有 dataUrl 的图是定时炸弹，
 * 收进去只会在 24 小时后变成一张裂图。丢弃的数量会如实报告给用户。
 */
export function toAssets(
  result: GenerateImagesOutcome,
  draft: AssetDraft,
): BuildAssetsOutcome {
  const now = new Date().toISOString();
  const assets: Asset[] = [];
  let dropped = 0;

  for (const image of result.images) {
    if (!image.dataUrl) {
      dropped += 1;
      continue;
    }
    const base64Part = image.dataUrl.slice(image.dataUrl.indexOf(',') + 1);
    assets.push({
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      id: newId('asset'),
      projectId: draft.projectId,
      kind: draft.kind,
      refId: draft.refId,
      dataUrl: image.dataUrl,
      sourceUrl: image.url,
      mimeType: image.dataUrl.slice(5, image.dataUrl.indexOf(';')) || 'image/png',
      ...(image.width !== undefined ? { width: image.width } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
      ...(draft.seed !== undefined ? { seed: draft.seed } : {}),
      promptSnapshot: draft.promptSnapshot,
      ...(draft.model !== undefined ? { model: draft.model } : {}),
      ...(draft.lockPhrases !== undefined ? { lockPhrases: draft.lockPhrases } : {}),
      ...(draft.styleTags !== undefined ? { styleTags: draft.styleTags } : {}),
      ...(draft.referenceCount !== undefined ? { referenceCount: draft.referenceCount } : {}),
      byteSize: Math.floor((base64Part.length * 3) / 4),
    });
  }

  const warnings = [...result.warnings];
  if (dropped > 0) {
    warnings.push(
      `有 ${dropped} 张图没能下载到本地，已丢弃。它们只在平台上存在 24 小时，请尽快手动保存。`,
    );
  }

  return { assets, dropped, warnings };
}
