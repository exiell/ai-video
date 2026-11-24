/**
 * 本地模型（vLLM-Omni）的端点覆盖与连通性检查（v0.61）。
 *
 * 本地档案不写进 `MODEL_PROFILES`（原因见 profiles.ts 的 LOCAL_MODEL_PROFILES 注释），
 * 但端点覆盖和「测试连接」需要独立、可测试的小工具，UI 下一批直接复用。
 */

import type { ModelProfile } from '../../types/model';
import { isDesktopApp } from '../../platform';
import { resolvePlatformFetch } from '../../platform/transport';

export const LOCAL_FLUX3_PROFILE_ID = 'local-flux3';
/** 本地生图参考图的保守档：24GB 3090 上 VAE encode 阶段容易 OOM */
export const LOCAL_REFERENCE_MAX_BYTES = 2 * 1024 * 1024;
export const LOCAL_REFERENCE_MAX_LONG_EDGE = 1024;

/** 判断是否本地档案：authType none 或 provider/id 明显是本地模型（含自定义接入的本地配置） */
export function isLocalProfile(profile: ModelProfile | undefined): boolean {
  if (!profile) return false;
  return (
    profile.authType === 'none' ||
    profile.vendorId === 'local' ||
    profile.id === LOCAL_FLUX3_PROFILE_ID ||
    /^local[-_]/i.test(profile.id) ||
    /本地/i.test(profile.provider)
  );
}
export const DEFAULT_LOCAL_MODEL_ENDPOINT = 'http://127.0.0.1:8099/v1';
/** 本地生图默认超时：vLLM-Omni + FLUX3 在 3090 上首张可能很慢 */
export const DEFAULT_LOCAL_TIMEOUT_MS = 600_000;
/** 「测试连接」只查模型列表，短超时即可 */
export const DEFAULT_LOCAL_CHECK_TIMEOUT_MS = 3_000;

/** 规范化本地端点：去空格/尾斜杠；如果误填了 chat/completions 或 models 路径，退回 base */
export function normalizeLocalEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let base = value.trim().replace(/\/+$/, '');
  for (const suffix of ['/chat/completions', '/models']) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length).replace(/\/+$/, '');
      break;
    }
  }
  return base || undefined;
}

/** `/v1/models` 的完整 URL；兼容用户只填主机/端口的情况 */
export function localModelsUrl(endpoint: string | undefined): string {
  const base = (normalizeLocalEndpoint(endpoint) ?? DEFAULT_LOCAL_MODEL_ENDPOINT).replace(/\/+$/, '');
  if (base.endsWith('/v1')) return `${base}/models`;
  return `${base}/v1/models`;
}

/** 合并设置里的本地端点/超时覆盖，不修改内置档案对象 */
export function applyLocalProfileOverrides(
  profile: ModelProfile,
  overrides: { endpoint?: string; timeoutMs?: number },
): ModelProfile {
  if (profile.id !== LOCAL_FLUX3_PROFILE_ID) return profile;
  const endpoint = normalizeLocalEndpoint(overrides.endpoint);
  const timeoutMs = overrides.timeoutMs;
  if (endpoint === undefined && timeoutMs === undefined) return profile;
  return {
    ...profile,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/** 本地档案实际生效的超时（档案/设置/默认值三级） */
export function localTimeoutMs(
  profile: ModelProfile | undefined,
  overrideMs: number | undefined,
): number {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0) {
    return Math.floor(overrideMs);
  }
  if (profile?.timeoutMs !== undefined && Number.isFinite(profile.timeoutMs) && profile.timeoutMs > 0) {
    return Math.floor(profile.timeoutMs);
  }
  return DEFAULT_LOCAL_TIMEOUT_MS;
}

export interface LocalModelCheckResult {
  ok: boolean;
  /** 可直接展示给用户的一句话（包含下一步建议） */
  message: string;
  endpoint: string;
  models?: string[];
  latencyMs?: number;
  detail?: string;
}

export interface LocalModelCheckOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 期望出现的模型名；默认 flux-3-image-klein（可覆盖，UI 可用同一个探测函数测别的模型） */
  expectedModel?: string;
}

function summarizeModelList(ids: string[]): string {
  if (ids.length === 0) return '（空）';
  const head = ids.slice(0, 5).join(', ');
  return ids.length > 5 ? `${head} 等 ${ids.length} 个` : head;
}

/**
 * GET /v1/models 探测本地服务。
 *
 * 不抛异常：UI 的「测试连接」只需要一条可展示的结果；失败也返回人话。
 */
export async function probeLocalModel(
  endpoint: string | undefined,
  options: LocalModelCheckOptions = {},
): Promise<LocalModelCheckResult> {
  const base = normalizeLocalEndpoint(endpoint) ?? DEFAULT_LOCAL_MODEL_ENDPOINT;
  const url = localModelsUrl(base);
  const fetchImpl = resolvePlatformFetch(options.fetchImpl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCAL_CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        endpoint: base,
        latencyMs,
        message: `本地服务返回 HTTP ${response.status}。确认 vLLM-Omni 已启动，且端口/路径正确（默认 ${DEFAULT_LOCAL_MODEL_ENDPOINT}）。`,
        detail: text.slice(0, 300),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return {
        ok: false,
        endpoint: base,
        latencyMs,
        message:
          '本地服务返回的内容无法识别，可能不是 vLLM-Omni 服务，或者设置里的地址填错了。',
        detail: text.slice(0, 300),
      };
    }

    const data =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>).data
        : undefined;
    if (!Array.isArray(data)) {
      return {
        ok: false,
        endpoint: base,
        latencyMs,
        message:
          '本地服务返回的 JSON 不是 /v1/models 的形状（缺少 data 列表），可能地址填错了。',
        detail: text.slice(0, 300),
      };
    }

    const ids = data
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null) {
          return (item as Record<string, unknown>).id;
        }
        return undefined;
      })
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    const expected = options.expectedModel ?? 'flux-3-image-klein';

    if (ids.length === 0) {
      return {
        ok: false,
        endpoint: base,
        latencyMs,
        models: [],
        message:
          '本地服务在，但还没有加载模型（模型列表为空）。确认 vLLM-Omni 启动参数里的模型名。',
      };
    }

    if (!ids.includes(expected)) {
      return {
        ok: false,
        endpoint: base,
        latencyMs,
        models: ids,
        message: `本地服务已连通，但模型列表里没有 ${expected}；当前模型：${summarizeModelList(ids)}。`,
      };
    }

    return {
      ok: true,
      endpoint: base,
      latencyMs,
      models: ids,
      message: `本地模型可用：${expected}（${latencyMs}ms）`,
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const aborted = error instanceof Error && error.name === 'AbortError';
    const desktop = isDesktopApp();
    return {
      ok: false,
      endpoint: base,
      latencyMs,
      message: aborted
        ? desktop
          ? `连接本地服务超时（${timeoutMs}ms）。确认本地模型服务已启动、地址可访问。`
          : `连接本地服务超时（${timeoutMs}ms）。确认 vLLM-Omni 已启动、地址可访问；浏览器直连还需要端口转发 + CORS 放行。`
        : desktop
          ? '连不上本地服务。确认地址和端口正确，且本地模型服务已启动。'
          : '连不上本地服务。确认地址/端口正确、vLLM-Omni 已启动；浏览器直连需要端口转发，并且 vLLM 要允许应用 origin。',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
