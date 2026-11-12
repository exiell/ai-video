/**
 * 参考图确定性预处理（v0.58 · P2-c）
 *
 * ===========================================================================
 * 为什么需要它
 * ===========================================================================
 * 「传了参考图」不等于「锁住了特征」：一张 4K 全景里的脸可能只有几十像素，
 * 模型把图缩到 1–2 MP 之后几乎认不出来；而部分接口对单图有字节上限
 * （qwen-image-edit 官方文档写 ≤10 MB），超限的图要么被拒，要么被静默忽略。
 *
 * 这一层只做**确定性**的事：
 *  - 按目标画幅做**中心裁切**（不检测主体，中心裁切会裁掉边缘，这是明确妥协）；
 *  - 解码时按 EXIF 方向纠正像素（createImageBitmap 的 imageOrientation）；
 *  - 超长边缩到 maxLongEdge（默认 2048）；
 *  - 在**已核实**的单图字节上限下，按 0.85→0.7→0.6 质量、0.9 边长递缩，最多 3 轮压缩。
 *
 * **不做**：人脸检测、主体占比、视图选择（这些需要视觉/分割模型，见方案 v2.1 §4.5）。
 *
 * 依赖可注入：浏览器默认走 createImageBitmap + canvas；Node 测试环境没有 canvas，
 * 由调用方传入假的 decode/encode（测试用），因此**不新增任何依赖**。
 */

export interface PrepareReferenceAnchor {
  dataUrl: string;
  /** 仅用于日志/警告定位，不参与处理 */
  role?: string;
}

export type PreparePurpose = 'fit-bytes' | 'aspect' | 'passthrough';

export interface PreparedRef {
  dataUrl: string;
  /**
   * 处理后的像素尺寸。`passthrough`/无需处理时**不解码**，两者为 0
   * （调用方只在 transformed=true 或 reason 存在时使用它们）。
   */
  width: number;
  height: number;
  byteSize: number;
  transformed: boolean;
  /** 失败时的如实原因（中文，可直接进 feedback warning） */
  reason?: string;
}

/** 解码结果。EXIF 方向必须已在 decode 里纠正（默认实现传 imageOrientation:'from-image'）。 */
export interface DecodedImage {
  width: number;
  height: number;
  /** 是否含透明像素（决定输出 PNG 还是 JPEG） */
  hasAlpha: boolean;
  source: unknown;
}

export interface EncodeRequest {
  image: DecodedImage;
  /** 从解码图里裁哪一块（原图像素坐标） */
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  /** 输出尺寸（≤ maxLongEdge，保持裁切后的宽高比） */
  targetWidth: number;
  targetHeight: number;
  type: 'image/jpeg' | 'image/png';
  /** 仅 JPEG 有意义；PNG 忽略 */
  quality: number;
}

export interface EncodedImage {
  dataUrl: string;
  byteSize: number;
}

export interface PrepareDeps {
  decode: (dataUrl: string) => Promise<DecodedImage>;
  encode: (request: EncodeRequest) => Promise<EncodedImage>;
}

export interface PrepareOptions {
  /** 目标画幅，例：'9:16'。aspect 用途必传 */
  targetAspect?: string;
  /** 单图字节上限；**只有档案已核实才传**，不传就不按大小压缩 */
  maxBytesPerImage?: number;
  /** 长边上限，默认 2048 */
  maxLongEdge?: number;
  /** 仅测试用：注入假 decode/encode（浏览器里不传） */
  deps?: Partial<PrepareDeps>;
}

const DEFAULT_MAX_LONG_EDGE = 2048;
const QUALITIES = [0.85, 0.7, 0.6] as const;
const RETRY_EDGE_FACTOR = 0.9;

/** data URI 的实际字节数（base64 按 3/4 估算，扣掉 padding） */
function estimateByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (!/;base64/i.test(meta)) return payload.length;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 解析 '9:16' 这样的画幅；非法或缺省返回 undefined（此时 aspect 退化为不裁切） */
function parseAspect(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : undefined;
}

/**
 * 解析依赖：测试注入优先；否则尝试浏览器默认实现。
 *
 * 浏览器默认实现要求 createImageBitmap 或 OffscreenCanvas 至少有一个
 * （真实浏览器都满足；jsdom 两个都没有 → 返回 null，调用方静默跳过，
 * 这样 Node 测试里的旧参考图链路行为完全不变）。
 */
function resolveDeps(injected: Partial<PrepareDeps> | undefined): PrepareDeps | null {
  if (injected?.decode && injected.encode) {
    return { decode: injected.decode, encode: injected.encode };
  }
  const browser = browserDeps();
  if (!browser) return null;
  return {
    decode: injected?.decode ?? browser.decode,
    encode: injected?.encode ?? browser.encode,
  };
}

let cachedBrowserDeps: PrepareDeps | null | undefined;
function browserDeps(): PrepareDeps | null {
  if (cachedBrowserDeps !== undefined) return cachedBrowserDeps;
  const hasBitmap =
    typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap === 'function';
  const hasOffscreen = typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas === 'function';
  if (typeof document === 'undefined' || (!hasBitmap && !hasOffscreen)) {
    cachedBrowserDeps = null;
    return null;
  }
  cachedBrowserDeps = { decode: browserDecode, encode: browserEncode };
  return cachedBrowserDeps;
}

/** data URI → Blob（不依赖 fetch，避免 data: 协议在部分环境的差异） */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('无效的 data URI');
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mime = /^data:([^;,]+)/i.exec(meta)?.[1] ?? 'application/octet-stream';
  if (!/;base64/i.test(meta)) return new Blob([decodeURIComponent(payload)], { type: mime });
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('读取图片数据失败'));
      reader.readAsDataURL(blob);
    });
  }
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
  });
}

/** 用一张缩到 ≤256 长边的临时 canvas 抽样判断是否存在透明像素 */
function detectAlphaFromCanvas(canvas: HTMLCanvasElement): boolean {
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return true; // 拿不到 2D 上下文时保守当有 alpha（保 PNG 不会画成黑底）
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! < 250) return true;
    }
    return false;
  } catch {
    // 跨域/隐私模式下 getImageData 可能抛错；保守当有 alpha
    return true;
  }
}

function createSmallCanvas(width: number, height: number): HTMLCanvasElement {
  const maxSide = 256;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

async function browserDecode(dataUrl: string): Promise<DecodedImage> {
  const blob = dataUrlToBlob(dataUrl);
  if (typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const canvas = createSmallCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return {
      width: bitmap.width,
      height: bitmap.height,
      hasAlpha: detectAlphaFromCanvas(canvas),
      source: bitmap,
    };
  }
  // 回退：<img> + canvas（老浏览器），EXIF 由浏览器解码图片时处理
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('图片解码失败'));
    element.src = dataUrl;
  });
  const canvas = createSmallCanvas(image.naturalWidth, image.naturalHeight);
  canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    hasAlpha: detectAlphaFromCanvas(canvas),
    source: image,
  };
}

async function browserEncode(request: EncodeRequest): Promise<EncodedImage> {
  const canvas = document.createElement('canvas');
  canvas.width = request.targetWidth;
  canvas.height = request.targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d 不可用');
  ctx.drawImage(
    request.image.source as CanvasImageSource,
    request.cropX,
    request.cropY,
    request.cropWidth,
    request.cropHeight,
    0,
    0,
    request.targetWidth,
    request.targetHeight,
  );
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), request.type, request.quality);
  });
  if (!blob) throw new Error('编码图片失败');
  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, byteSize: estimateByteSize(dataUrl) };
}

/**
 * 预处理一张参考图。
 *
 * 返回值语义：
 *  - `transformed:false` 且无 `reason`：原图可直接发（字节级不变；passthrough 或本来合规）；
 *  - `transformed:true`：`dataUrl` 是处理后的**请求副本**，原资产不受影响；
 *  - `transformed:false` 且有 `reason`：处理失败，调用方应回退原图并给人话提示。
 *
 * 注意：`passthrough` 与「无需处理」的情况**不解码**（width/height 为 0），
 * 避免每次出图都为所有参考图付一次解码成本。
 */
export async function prepareReference(
  anchor: PrepareReferenceAnchor,
  purpose: PreparePurpose,
  options: PrepareOptions = {},
): Promise<PreparedRef> {
  const source = anchor.dataUrl;
  const sourceByteSize = estimateByteSize(source);
  const unchanged: PreparedRef = {
    dataUrl: source,
    width: 0,
    height: 0,
    byteSize: sourceByteSize,
    transformed: false,
  };

  if (purpose === 'passthrough') return unchanged;
  // 未核实/未声明字节上限时，fit-bytes 不按大小压缩（不猜）
  if (purpose === 'fit-bytes' && options.maxBytesPerImage === undefined) return unchanged;

  const maxBytes = options.maxBytesPerImage;
  const maxLongEdge = Math.max(64, Math.floor(options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE));
  const targetRatio = purpose === 'aspect' ? parseAspect(options.targetAspect) : undefined;
  const deps = resolveDeps(options.deps);
  // 环境不支持（例如 jsdom）：静默跳过，不把「没有 canvas」包装成用户可见错误
  if (!deps) return unchanged;

  let decoded: DecodedImage;
  try {
    decoded = await deps.decode(source);
  } catch {
    return { ...unchanged, reason: '参考图解码失败，已回退原图。' };
  }
  if (!decoded.width || !decoded.height) {
    return { ...unchanged, reason: '参考图尺寸无效，已回退原图。' };
  }

  // ---- 中心裁切（不检测主体）----
  let cropX = 0;
  let cropY = 0;
  let cropWidth = decoded.width;
  let cropHeight = decoded.height;
  if (targetRatio !== undefined) {
    const sourceRatio = decoded.width / decoded.height;
    // 忽略 0.5% 以内的小差异，避免为了噪声重新编码
    if (Math.abs(sourceRatio - targetRatio) / targetRatio > 0.005) {
      if (sourceRatio > targetRatio) {
        cropWidth = Math.max(1, Math.round(decoded.height * targetRatio));
        cropHeight = decoded.height;
        cropX = Math.round((decoded.width - cropWidth) / 2);
      } else {
        cropWidth = decoded.width;
        cropHeight = Math.max(1, Math.round(decoded.width / targetRatio));
        cropY = Math.round((decoded.height - cropHeight) / 2);
      }
    }
  }

  const cropped =
    cropX !== 0 || cropY !== 0 || cropWidth !== decoded.width || cropHeight !== decoded.height;
  const exceedsLongEdge = Math.max(cropWidth, cropHeight) > maxLongEdge;
  const exceedsBytes = maxBytes !== undefined && sourceByteSize > maxBytes;
  // 本来合规 → 字节级不变（不为了「处理过」而重新编码）
  if (!cropped && !exceedsLongEdge && !exceedsBytes) return unchanged;

  const type = decoded.hasAlpha ? 'image/png' : 'image/jpeg';
  for (let attempt = 0; attempt < QUALITIES.length; attempt += 1) {
    // 第 1 轮 0.85；之后每轮质量降一档、长边再乘 0.9
    const edgeLimit = maxLongEdge * Math.pow(RETRY_EDGE_FACTOR, attempt);
    const scale = Math.min(1, edgeLimit / Math.max(cropWidth, cropHeight));
    const targetWidth = Math.max(1, Math.round(cropWidth * scale));
    const targetHeight = Math.max(1, Math.round(cropHeight * scale));
    try {
      const encoded = await deps.encode({
        image: decoded,
        cropX,
        cropY,
        cropWidth,
        cropHeight,
        targetWidth,
        targetHeight,
        type,
        quality: QUALITIES[attempt]!,
      });
      const within = maxBytes === undefined || encoded.byteSize <= maxBytes;
      if (!within) continue;
      return {
        dataUrl: encoded.dataUrl,
        width: targetWidth,
        height: targetHeight,
        byteSize: encoded.byteSize,
        transformed: true,
      };
    } catch {
      return { ...unchanged, reason: '参考图编码失败，已回退原图。' };
    }
  }

  return {
    ...unchanged,
    reason: `压缩 3 轮后仍超过 ${formatBytes(maxBytes ?? 0)} 上限，已回退原图。`,
  };
}
