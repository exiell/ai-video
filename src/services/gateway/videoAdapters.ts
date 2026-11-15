/**
 * OpenAI Videos 形状的视频网关适配器（v0.65）
 *
 * 服务端是本地 SkyReels bridge（/v1/videos），未来云端同形状服务只需新档案。
 * 这一层只负责请求/解析/错误归一；任务状态和重试由 store/video.ts 管。
 */
import type { VideoProfile } from '../../types/video';
import type { CustomModelConfig } from '../../types/customModel';
import { buildProxyUrl, redactProxyErrorBody, type TransportConfig } from './index';

export type VideoRemoteStatus = 'queued' | 'running' | 'completed' | 'failed';
export type VideoErrorKind =
  | 'network'
  | 'timeout'
  | 'http'
  | 'invalid-response'
  | 'canceled'
  | 'unsupported';

export class VideoServiceError extends Error {
  readonly kind: VideoErrorKind;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(kind: VideoErrorKind, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'VideoServiceError';
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? (kind === 'network' || kind === 'timeout' || (options.status ?? 0) >= 500);
  }
}

export interface VideoCreateRequest {
  prompt: string;
  /** data URI，顺序即参考图顺序；第 1 张必须是首帧 */
  referenceImages: string[];
  seconds?: number;
  resolution?: string;
  seed?: number;
  negativePrompt?: string;
  timeoutMs?: number;
}

export interface VideoRemoteOutput {
  url?: string;
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  bytes?: number;
}

export interface VideoRemoteJob {
  id: string;
  status: VideoRemoteStatus;
  progress: number | null;
  elapsedSeconds: number | null;
  error: string | null;
  output: VideoRemoteOutput | null;
}

export interface VideoRequestOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  apiKey?: string;
  /** 现有 gateway 代理/直连语义；与图片/文字链路一致 */
  transport?: TransportConfig;
}

export interface VideoPreparedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const MAX_CONTENT_BYTES = 50 * 1024 * 1024;

function baseUrl(profile: VideoProfile): string {
  return profile.baseUrl.trim().replace(/\/+$/, '');
}

export function videoBaseUrl(profile: VideoProfile): string {
  const base = baseUrl(profile);
  if (base.endsWith('/videos')) return base.slice(0, -'/videos'.length);
  return base;
}

export function videoCreateUrl(profile: VideoProfile): string {
  return `${videoBaseUrl(profile)}/videos`;
}

export function videoJobUrl(profile: VideoProfile, remoteJobId: string): string {
  return `${videoCreateUrl(profile)}/${encodeURIComponent(remoteJobId)}`;
}

export function videoContentUrl(profile: VideoProfile, remoteJobId: string): string {
  return `${videoJobUrl(profile, remoteJobId)}/content`;
}

function proxyHeaders(headers: Record<string, string>, transport?: TransportConfig): Record<string, string> {
  if (transport?.proxyBaseUrl && transport.applicationPassword) {
    return { ...headers, 'x-aniguide-proxy-token': transport.applicationPassword };
  }
  return headers;
}

function requestUrl(url: string, transport?: TransportConfig): string {
  return transport?.proxyBaseUrl ? buildProxyUrl(transport.proxyBaseUrl, url) : url;
}

function authHeaders(profile: VideoProfile, apiKey?: string): Record<string, string> {
  if (!profile.requiresKey) return {};
  if (!apiKey || !apiKey.trim()) {
    throw new VideoServiceError('http', `「${profile.name}」需要 API Key，先到设置里填。`, { status: 401 });
  }
  return { Authorization: `Bearer ${apiKey.trim()}` };
}

function headersFor(profile: VideoProfile, apiKey?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...authHeaders(profile, apiKey),
  };
}

/** 构造 POST /videos 请求；不含网络调用，便于测试 body/顺序 */
export function buildVideoCreateRequest(
  profile: VideoProfile,
  request: VideoCreateRequest,
  options: { apiKey?: string } = {},
): VideoPreparedRequest {
  const caps = profile.capabilities;
  const body: Record<string, unknown> = {
    model: profile.model,
    prompt: request.prompt,
    image_reference: request.referenceImages.map((imageUrl) => ({ image_url: imageUrl })),
    seconds: request.seconds ?? caps.durationSeconds,
    resolution: request.resolution ?? caps.resolution,
  };
  if (request.seed !== undefined) body.seed = request.seed;
  if (request.negativePrompt) body.negative_prompt = request.negativePrompt;
  return { url: videoCreateUrl(profile), body, headers: headersFor(profile, options.apiKey) };
}

function parseOutput(value: unknown): VideoRemoteOutput | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const number = (key: string): number | undefined =>
    typeof record[key] === 'number' && Number.isFinite(record[key]) ? (record[key] as number) : undefined;
  return {
    ...(typeof record.url === 'string' ? { url: record.url } : {}),
    ...(number('width') !== undefined ? { width: number('width') } : {}),
    ...(number('height') !== undefined ? { height: number('height') } : {}),
    ...(number('duration_s') !== undefined
      ? { duration: number('duration_s') }
      : number('duration') !== undefined
        ? { duration: number('duration') }
        : {}),
    ...(number('fps') !== undefined ? { fps: number('fps') } : {}),
    ...(number('bytes') !== undefined ? { bytes: number('bytes') } : {}),
  };
}

export function parseVideoJob(payload: unknown): VideoRemoteJob {
  if (!payload || typeof payload !== 'object') {
    throw new VideoServiceError('invalid-response', '视频服务返回的不是任务对象。');
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new VideoServiceError('invalid-response', '视频服务返回的任务缺少 id。');
  }
  const rawStatus = record.status;
  const status: VideoRemoteStatus =
    rawStatus === 'completed'
      ? 'completed'
      : rawStatus === 'failed'
        ? 'failed'
        : rawStatus === 'in_progress' || rawStatus === 'running'
          ? 'running'
          : rawStatus === 'queued'
            ? 'queued'
            : (() => {
                throw new VideoServiceError('invalid-response', `视频服务返回了未知状态：${String(rawStatus)}。`);
              })();
  const progress = typeof record.progress === 'number' && Number.isFinite(record.progress) ? record.progress : null;
  const elapsed =
    typeof record.elapsed_seconds === 'number' && Number.isFinite(record.elapsed_seconds)
      ? record.elapsed_seconds
      : null;
  const error = typeof record.error === 'string' && record.error.trim() ? record.error.trim() : null;
  return { id: record.id, status, progress, elapsedSeconds: elapsed, error, output: parseOutput(record.output) };
}

async function readErrorBody(response: Response, viaProxy = false): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
      if (typeof parsed.error === 'object' && parsed.error && typeof parsed.error.message === 'string') {
        return viaProxy ? redactProxyErrorBody(parsed.error.message) : parsed.error.message;
      }
      if (typeof parsed.error === 'string') return viaProxy ? redactProxyErrorBody(parsed.error) : parsed.error;
    } catch {
      // 非 JSON：保留原文本（截断）
    }
    return viaProxy ? redactProxyErrorBody(text) : text;
  } catch {
    return '';
  }
}

function scrub(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9._-]{6,}/g, '***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

export function httpVideoError(status: number, rawMessage: string): VideoServiceError {
  const message = scrub(rawMessage);
  if (status === 400) {
    return new VideoServiceError('http', message || '视频参数不合法，检查提示词和参考图后重试。', { status });
  }
  if (status === 401 || status === 403) {
    return new VideoServiceError('http', '视频服务拒绝了请求，检查视频档案的 Key/地址。', { status });
  }
  if (status === 404) {
    return new VideoServiceError('http', '视频服务地址不对或任务不存在；确认 baseUrl 以 /v1 结尾、服务已启动。', { status });
  }
  if (status === 409) {
    return new VideoServiceError('http', message || '视频任务还在生成中，暂时不能操作。', { status });
  }
  if (status === 429) {
    return new VideoServiceError('http', '视频服务队列已满，等前面的任务跑完再提交。', { status, retryable: true });
  }
  if (status >= 500) {
    const lower = message.toLowerCase();
    if (lower.includes('out of memory') || lower.includes('oom') || message.includes('显存')) {
      return new VideoServiceError('http', '显卡显存不够，这一条没生成出来。关掉占显存的程序后重试，或换一张空闲显卡。', { status });
    }
    return new VideoServiceError('http', message || '视频服务生成失败，稍后看任务状态或重试。', { status, retryable: true });
  }
  return new VideoServiceError('http', message || `视频服务返回 HTTP ${status}。`, { status });
}

export function normalizeVideoError(error: unknown): VideoServiceError {
  if (error instanceof VideoServiceError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new VideoServiceError('timeout', '视频请求超时或已取消。服务端可能还在跑，先停止等待，过几分钟刷新看结果。');
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new VideoServiceError('timeout', '视频请求超时或已取消。服务端可能还在跑，先停止等待，过几分钟刷新看结果。');
  }
  if (error instanceof TypeError) {
    return new VideoServiceError(
      'network',
      '连不上本地视频服务。先启动视频服务（默认端口 8110），再点重试；远程使用还要确认端口转发。',
    );
  }
  return new VideoServiceError('http', '视频请求失败，先把服务日志和任务详情发给维护者。');
}

async function withTimeout<T>(
  options: VideoRequestOptions,
  profile: VideoProfile,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? profile.timeoutMs ?? profile.capabilities.maxTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fn(controller.signal);
  } catch (error) {
    throw normalizeVideoError(error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

async function requestJob(
  profile: VideoProfile,
  url: string,
  init: RequestInit,
  options: VideoRequestOptions,
): Promise<VideoRemoteJob> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const viaProxy = Boolean(options.transport?.proxyBaseUrl);
  return withTimeout(options, profile, async (signal) => {
    const headers = proxyHeaders((init.headers ?? {}) as Record<string, string>, options.transport);
    const response = await fetchImpl(requestUrl(url, options.transport), { ...init, headers, signal });
    if (!response.ok) {
      throw httpVideoError(response.status, await readErrorBody(response, viaProxy));
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new VideoServiceError('invalid-response', '视频服务返回了无法解析的数据。');
    }
    return parseVideoJob(payload);
  });
}

export async function createVideoJob(
  profile: VideoProfile,
  request: VideoCreateRequest,
  options: VideoRequestOptions = {},
): Promise<VideoRemoteJob> {
  const prepared = buildVideoCreateRequest(profile, request, { ...(options.apiKey ? { apiKey: options.apiKey } : {}) });
  return requestJob(
    profile,
    prepared.url,
    { method: 'POST', headers: prepared.headers, body: JSON.stringify(prepared.body) },
    { ...options, timeoutMs: options.timeoutMs ?? request.timeoutMs },
  );
}

export async function pollVideoJob(
  profile: VideoProfile,
  remoteJobId: string,
  options: VideoRequestOptions = {},
): Promise<VideoRemoteJob> {
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders(profile, options.apiKey) };
  return requestJob(profile, videoJobUrl(profile, remoteJobId), { method: 'GET', headers }, options);
}

export interface VideoContentResult {
  blob: Blob;
  byteSize: number;
  mimeType: string;
}

export async function fetchVideoContent(
  profile: VideoProfile,
  remoteJobId: string,
  options: VideoRequestOptions = {},
): Promise<VideoContentResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const viaProxy = Boolean(options.transport?.proxyBaseUrl);
  return withTimeout(options, profile, async (signal) => {
    const headers = proxyHeaders({ ...authHeaders(profile, options.apiKey) }, options.transport);
    const response = await fetchImpl(requestUrl(videoContentUrl(profile, remoteJobId), options.transport), {
      method: 'GET',
      headers,
      signal,
    });
    if (!response.ok) throw httpVideoError(response.status, await readErrorBody(response, viaProxy));
    const type = response.headers.get('content-type') ?? '';
    if (!type.toLowerCase().startsWith('video/mp4')) {
      throw new VideoServiceError('invalid-response', `视频服务返回的不是 mp4（${type || '未知类型'}）。`);
    }
    const blob = await response.blob();
    if (blob.size > MAX_CONTENT_BYTES) {
      throw new VideoServiceError('invalid-response', '视频文件超过 50MB，已拒绝保存；检查服务端是否返回了错误页面。');
    }
    if (blob.size === 0) throw new VideoServiceError('invalid-response', '视频文件是空的。');
    return { blob, byteSize: blob.size, mimeType: 'video/mp4' };
  });
}

export async function cancelVideoJob(
  profile: VideoProfile,
  remoteJobId: string,
  options: VideoRequestOptions = {},
): Promise<{ supported: boolean }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const viaProxy = Boolean(options.transport?.proxyBaseUrl);
  return withTimeout(options, profile, async (signal) => {
    const headers = proxyHeaders({ ...authHeaders(profile, options.apiKey) }, options.transport);
    const response = await fetchImpl(requestUrl(videoJobUrl(profile, remoteJobId), options.transport), {
      method: 'DELETE',
      headers,
      signal,
    });
    if (response.status === 404 || response.status === 405) return { supported: false };
    if (!response.ok) throw httpVideoError(response.status, await readErrorBody(response, viaProxy));
    return { supported: true };
  });
}

export interface VideoAdapter {
  protocol: VideoProfile['protocol'];
  buildRequest: typeof buildVideoCreateRequest;
  parseResponse: typeof parseVideoJob;
  pollJob: typeof pollVideoJob;
  fetchContent: typeof fetchVideoContent;
  cancelJob: typeof cancelVideoJob;
  normalizeError: typeof normalizeVideoError;
}

const openAiVideosAdapter: VideoAdapter = {
  protocol: 'openai-videos',
  buildRequest: buildVideoCreateRequest,
  parseResponse: parseVideoJob,
  pollJob: pollVideoJob,
  fetchContent: fetchVideoContent,
  cancelJob: cancelVideoJob,
  normalizeError: normalizeVideoError,
};

export function getVideoAdapter(profile: VideoProfile): VideoAdapter {
  if (profile.protocol === 'openai-videos') return openAiVideosAdapter;
  throw new VideoServiceError('unsupported', `不支持的视频协议：${profile.protocol}`);
}


// ---------------------------------------------------------------------------
// 视频「测试连接」核心函数（UI 不再自己拼 /v1/models + /health）
// ---------------------------------------------------------------------------

export type VideoCheckStatus =
  | 'ready'
  | 'missing-key'
  | 'unauthorized'
  | 'cors'
  | 'timeout'
  | 'not-found'
  | 'model-not-loaded'
  | 'error';

export interface VideoCheckResult {
  ok: boolean;
  status: VideoCheckStatus;
  message: string;
  detail?: string;
}

export interface VideoCheckOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  transport?: TransportConfig;
}

export type VideoCheckInput = VideoProfile | CustomModelConfig;

function checkInput(input: VideoCheckInput): { baseUrl: string; model: string; requiresKey: boolean; timeoutMs: number } {
  const baseUrl = input.baseUrl;
  const model = input.model ?? '';
  const requiresKey = input.requiresKey !== false;
  const timeoutMs = input.timeoutMs ?? 5_000;
  return { baseUrl, model, requiresKey, timeoutMs };
}

function checkRoot(baseUrl: string): string {
  let root = baseUrl.trim().replace(/\/+$/, '');
  // 统一根：去掉结尾的 /videos、/v1（可叠加，兼容 /v1/videos），再拼 /v1/models 与 /health
  for (;;) {
    if (root.endsWith('/videos')) {
      root = root.slice(0, -'/videos'.length).replace(/\/+$/, '');
      continue;
    }
    if (root.endsWith('/v1')) {
      root = root.slice(0, -'/v1'.length).replace(/\/+$/, '');
      continue;
    }
    break;
  }
  return root;
}

function checkAuthHeaders(requiresKey: boolean, key: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (requiresKey) {
    if (!key.trim()) {
      throw new VideoServiceError('http', '这条视频配置需要 API Key，先在设置里填 Key 再测试连接。', { status: 401 });
    }
    headers.Authorization = `Bearer ${key.trim()}`;
  }
  return headers;
}

async function checkFetch(
  url: string,
  headers: Record<string, string>,
  options: VideoCheckOptions,
  timeoutMs: number,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(8_000, Math.max(2_000, timeoutMs)));
  try {
    return await fetchImpl(requestUrl(url, options.transport), {
      method: 'GET',
      headers: proxyHeaders(headers, options.transport),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 测试视频档案/配置：
 *  - 先 GET {baseRoot}/v1/models，校验模型 id；
 *  - 失败再 GET {baseRoot}/health；health 200 但 model_loaded=false → model-not-loaded；
 *  - 401/403、CORS/端口、超时、404、模型缺失都有独立人话。
 */
export async function checkVideoProfile(
  input: VideoCheckInput,
  key = '',
  options: VideoCheckOptions = {},
): Promise<VideoCheckResult> {
  const { baseUrl, model, requiresKey, timeoutMs } = checkInput(input);
  if (!baseUrl.trim() || !model.trim()) {
    return { ok: false, status: 'error', message: '视频档案缺少 baseUrl 或模型名。' };
  }
  if (requiresKey && !key.trim()) {
    return { ok: false, status: 'missing-key', message: '这条视频配置需要 API Key，先在设置里填 Key 再测试连接。' };
  }
  const root = checkRoot(baseUrl);
  let headers: Record<string, string>;
  try {
    headers = checkAuthHeaders(requiresKey, key);
  } catch (error) {
    const normalized = normalizeVideoError(error);
    return { ok: false, status: 'missing-key', message: normalized.message };
  }

  let firstFailure: VideoCheckResult | null = null;
  try {
    const response = await checkFetch(`${root}/v1/models`, headers, options, timeoutMs);
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: 'unauthorized',
        message: '视频服务拒绝了请求（401/403），检查 Key 是否正确。',
        detail: scrub(await readErrorBody(response, Boolean(options.transport?.proxyBaseUrl))),
      };
    }
    if (response.ok) {
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }
      const data =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>).data
          : undefined;
      if (Array.isArray(data)) {
        const ids = data
          .map((item) =>
            typeof item === 'object' && item !== null
              ? (item as Record<string, unknown>).id
              : item,
          )
          .filter((id): id is string => typeof id === 'string');
        if (ids.includes(model)) {
          return { ok: true, status: 'ready', message: `视频服务已就绪：${model}` };
        }
        // 200 且列表可解析、但没有配置的模型：保持失败。
        // 不能再用 /health 的 model_loaded=true 翻成就绪，否则 UI 误报。
        return {
          ok: false,
          status: 'model-not-loaded',
          message: `视频服务在，但模型列表里没有 ${model}；确认模型名或等模型加载。`,
        };
      } else {
        // 200 但响应不是 OpenAI list：按「/v1/models 不可用」回退 /health 判断服务可达性
        firstFailure = {
          ok: false,
          status: 'model-not-loaded',
          message: `/v1/models 返回缺少 data 列表；服务可能不是 OpenAI Videos 形状。`,
        };
      }
    } else if (response.status !== 404) {
      firstFailure = {
        ok: false,
        status: 'error',
        message: `视频服务 /v1/models 返回 HTTP ${response.status}，继续检查 /health。`,
      };
    }
  } catch (error) {
    const normalized = normalizeVideoError(error);
    firstFailure = {
      ok: false,
      status: normalized.kind === 'timeout' ? 'timeout' : 'cors',
      message: normalized.message,
    };
  }

  try {
    const response = await checkFetch(`${root}/health`, headers, options, timeoutMs);
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: 'unauthorized',
        message: '视频服务拒绝了请求（401/403），检查 Key 是否正确。',
      };
    }
    if (response.status === 404) {
      return firstFailure ?? {
        ok: false,
        status: 'not-found',
        message: '视频服务地址不对：/v1/models 和 /health 都不存在。确认 baseUrl 指向视频服务。',
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: 'error',
        message: `视频服务 /health 返回 HTTP ${response.status}。`,
      };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return {
        ok: false,
        status: 'model-not-loaded',
        message: '/health 返回不是 JSON；确认这是视频服务而不是普通网页。',
      };
    }
    const health = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    if (health.model_loaded === false) {
      return {
        ok: false,
        status: 'model-not-loaded',
        message: '视频服务已启动，模型还没加载好。等几分钟再测；首个视频任务也会触发加载。',
      };
    }
    if (health.model_loaded === true) {
      return { ok: true, status: 'ready', message: `视频服务已就绪：${model}` };
    }
    return firstFailure ?? {
      ok: true,
      status: 'ready',
      message: `视频服务可达：${model}（/health 未报告模型加载状态）`,
    };
  } catch (error) {
    const normalized = normalizeVideoError(error);
    return firstFailure ?? {
      ok: false,
      status: normalized.kind === 'timeout' ? 'timeout' : 'cors',
      message: normalized.message,
    };
  }
}
