/**
 * 自定义模型 · 测试连接数据层（v0.63）
 *
 * 给设置页的「测试连接」用：不发真实生成请求，只做最小探测。
 * - text：POST {endpoint}/chat/completions，max_tokens=1；
 * - image：GET {baseUrl}/models，校验配置的 model 在列表里；
 * - video：本批返回「下一批支持」占位。
 *
 * 约束：不打印 Key；3–5s 超时；不抛异常，失败也返回可展示结果。
 */

import { customModelToProfile, customModelsUrl, validateCustomModel } from '../../data/customModels';
import type { CustomModelConfig } from '../../types/customModel';

export type CustomModelCheckStatus =
  | 'ready'
  | 'missing-key'
  | 'unauthorized'
  | 'cors'
  | 'timeout'
  | 'missing-model'
  | 'unknown'
  | 'not-implemented'
  | 'bad-url'
  | 'http-error'
  | 'error';

export interface CustomModelCheckResult {
  ok: boolean;
  status: CustomModelCheckStatus;
  /** 可直接展示给用户的一句话；不能包含 Key */
  message: string;
  detail?: string;
  latencyMs?: number;
  models?: string[];
  httpStatus?: number;
}

export interface CheckCustomModelOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 4_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 日志/展示脱敏。
 *
 * 除了通用规则（hf_ / sk- / Bearer），还要把**本次传入的实际 Key**
 * 从 message/detail 中抹掉——自定义 Key 没有固定前缀，厂商报错有时会整段回显。
 * 同时处理 URL-encoded 与大小写变体。
 */
function sanitize(text: string, secretKey = ''): string {
  let out = text
    .replace(/hf_[A-Za-z0-9]{6,}/g, '***')
    .replace(/sk-[A-Za-z0-9._-]{6,}/g, '***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer ***');

  const raw = secretKey.trim();
  if (raw.length > 0) {
    const baseVariants = new Set<string>([
      raw,
      encodeURIComponent(raw),
      encodeURI(raw),
      raw.toLowerCase(),
      raw.toUpperCase(),
    ]);
    const variants = new Set<string>();
    for (const base of baseVariants) {
      if (!base) continue;
      variants.add(base);
      // 服务端如果只回显了 key 的前 300 / 后 100 字符，完整 key 匹配不到；
      // 长 key 额外把这两个片段也纳入替换（脱敏优先，宁可多遮）。
      if (base.length > 300) {
        variants.add(base.slice(0, 300));
        variants.add(base.slice(-100));
      }
    }
    for (const variant of variants) {
      if (!variant) continue;
      out = out.split(variant).join('[已隐藏]');
      try {
        out = out.replace(new RegExp(escapeRegExp(variant), 'gi'), '[已隐藏]');
      } catch {
        // 极端字符导致正则失败时，至少上面的字面替换已经做过
      }
    }
  }
  // **不要在脱敏前截断**：长 key 的前 300 字符会漏出去。截断由调用方在脱敏后做。
  return out;
}

function authHeaders(config: CustomModelConfig, key: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.requiresKey !== false && key.trim().length > 0) {
    headers.Authorization = `Bearer ${key.trim()}`;
  }
  return headers;
}

function summarizeModels(ids: string[]): string {
  if (ids.length === 0) return '（空）';
  const head = ids.slice(0, 5).join(', ');
  return ids.length > 5 ? `${head} 等 ${ids.length} 个` : head;
}

function networkErrorResult(error: unknown, latencyMs: number): CustomModelCheckResult {
  const aborted = error instanceof Error && error.name === 'AbortError';
  if (aborted) {
    return {
      ok: false,
      status: 'timeout',
      latencyMs,
      message: '连接超时。确认服务已启动、地址/端口正确；浏览器直连还需要 CORS/端口转发。',
    };
  }
  if (error instanceof TypeError) {
    return {
      ok: false,
      status: 'cors',
      latencyMs,
      message: '浏览器没能发出请求，最可能是跨域（CORS）被挡。确认服务允许应用 origin，或用代理。',
      detail: sanitize(error.message),
    };
  }
  return {
    ok: false,
    status: 'error',
    latencyMs,
    message: '连接失败。确认地址、端口、网络可达。',
    detail: sanitize(error instanceof Error ? error.message : String(error)),
  };
}

/**
 * 测试一条自定义配置。
 *
 * 调用方式：`checkCustomModel(config, key)`（Key 只用于本次请求，不进任何返回值/日志）。
 */
async function runCheckCustomModel(
  config: CustomModelConfig,
  key = '',
  options: CheckCustomModelOptions = {},
): Promise<CustomModelCheckResult> {
  const validation = validateCustomModel(config);
  if (!validation.ok) {
    const message = Object.values(validation.errors).filter(Boolean).join('；') || '配置不合法。';
    return { ok: false, status: 'bad-url', message };
  }
  if (config.modality === 'video') {
    return {
      ok: false,
      status: 'not-implemented',
      message: '视频接入下一批支持；现在只能保存配置，暂不能测试连接/生成。',
    };
  }
  if (config.requiresKey !== false && key.trim().length === 0) {
    return {
      ok: false,
      status: 'missing-key',
      message: '这条配置需要 API Key，先在设置里填 Key 再测试连接。',
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.min(
    5_000,
    Math.max(3_000, options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const headers = authHeaders(config, key);

  try {
    if (config.modality === 'image') {
      const url = customModelsUrl(config.baseUrl);
      let response: Response;
      try {
        response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
      } catch (error) {
        return networkErrorResult(error, Date.now() - started);
      }
      const latencyMs = Date.now() - started;
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            status: 'unauthorized',
            httpStatus: response.status,
            latencyMs,
            message: 'API Key 无效或没有权限（HTTP 401/403）。检查 Key 是否复制完整。',
            detail: sanitize(text),
          };
        }
        if (response.status === 404) {
          return {
            ok: true,
            status: 'unknown',
            httpStatus: 404,
            latencyMs,
            message:
              '服务可达，但没有 /models 接口，无法自动检测模型列表；可以保存配置后直接实跑。',
            detail: sanitize(text),
          };
        }
        return {
          ok: false,
          status: 'http-error',
          httpStatus: response.status,
          latencyMs,
          message: `服务返回 HTTP ${response.status}，无法确认连接。`,
          detail: sanitize(text),
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return {
          ok: false,
          status: 'unknown',
          httpStatus: response.status,
          latencyMs,
          message: '服务返回的不是 JSON，可能不是 OpenAI/vLLM 兼容接口。',
          detail: sanitize(text),
        };
      }
      const data =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>).data
          : undefined;
      if (!Array.isArray(data)) {
        return {
          ok: false,
          status: 'unknown',
          httpStatus: response.status,
          latencyMs,
          message: '/models 响应缺少 data 列表，无法确认模型。',
          detail: sanitize(text),
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
      if (ids.length === 0) {
        return {
          ok: false,
          status: 'missing-model',
          httpStatus: response.status,
          latencyMs,
          models: [],
          message: '服务连上了，但模型列表为空；确认服务已加载模型。',
        };
      }
      if (!ids.includes(config.model)) {
        return {
          ok: false,
          status: 'missing-model',
          httpStatus: response.status,
          latencyMs,
          models: ids,
          message: `模型列表里没有 ${config.model}；当前模型：${summarizeModels(ids)}。`,
        };
      }
      return {
        ok: true,
        status: 'ready',
        httpStatus: response.status,
        latencyMs,
        models: ids,
        message: `连接正常：模型 ${config.model} 在列表里（${latencyMs}ms）。`,
      };
    }

    // text：最小 chat 请求（比只查 /models 更能验证 model 真的可用）
    const profile = customModelToProfile(config);
    const payload = {
      model: config.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      temperature: 0,
    };
    let response: Response;
    try {
      response = await fetchImpl(profile.endpoint, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      return networkErrorResult(error, Date.now() - started);
    }
    const latencyMs = Date.now() - started;
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          status: 'unauthorized',
          httpStatus: response.status,
          latencyMs,
          message: 'API Key 无效或没有权限（HTTP 401/403）。检查 Key 是否复制完整。',
          detail: sanitize(text),
        };
      }
      if (response.status === 404) {
        return {
          ok: false,
          status: 'missing-model',
          httpStatus: 404,
          latencyMs,
          message: `服务没有找到 ${config.model}（HTTP 404）。检查模型名和 baseUrl（通常要含 /v1）。`,
          detail: sanitize(text),
        };
      }
      return {
        ok: false,
        status: 'http-error',
        httpStatus: response.status,
        latencyMs,
        message: `服务返回 HTTP ${response.status}，无法确认连接。`,
        detail: sanitize(text),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
    const choices =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>).choices
        : undefined;
    if (!Array.isArray(choices) || choices.length === 0) {
      return {
        ok: false,
        status: 'unknown',
        httpStatus: response.status,
        latencyMs,
        message:
          '服务返回了成功状态，但内容为空或不是 chat/completions 响应（choices 为空）。可能不是 OpenAI 兼容服务。',
        detail: sanitize(text),
      };
    }
    const firstChoice = choices[0];
    const firstMessage =
      typeof firstChoice === 'object' && firstChoice !== null
        ? (firstChoice as Record<string, unknown>).message
        : undefined;
    const content =
      typeof firstMessage === 'object' && firstMessage !== null
        ? (firstMessage as Record<string, unknown>).content
        : undefined;
    const hasContent =
      (typeof content === 'string' && content.trim().length > 0) ||
      (Array.isArray(content) && content.length > 0);
    if (!hasContent) {
      return {
        ok: false,
        status: 'unknown',
        httpStatus: response.status,
        latencyMs,
        message: '服务返回了成功状态，但回复内容为空（message/content 为空）。可能不是 OpenAI 兼容服务。',
        detail: sanitize(text),
      };
    }
    return {
      ok: true,
      status: 'ready',
      httpStatus: response.status,
      latencyMs,
      message: `连接正常：${config.model} 能返回对话结果（${latencyMs}ms）。`,
    };
  } finally {
    clearTimeout(timer);
  }
}


/**
 * 对外入口：跑探测，并保证 **本次传入的 Key** 不出现在返回的任何字段里。
 * 内部 runCheckCustomModel 各分支只做通用脱敏；这里再用实际 Key 兜底一次。
 */
export async function checkCustomModel(
  config: CustomModelConfig,
  key = '',
  options: CheckCustomModelOptions = {},
): Promise<CustomModelCheckResult> {
  const result = await runCheckCustomModel(config, key, options);
  const message = sanitize(result.message, key);
  // 先在完整原文上脱敏，再截断；反过来会让长 Key 的前 300 字符漏出去
  const detail =
    result.detail === undefined ? undefined : sanitize(result.detail, key).slice(0, 300);
  // models 也是用户可见字段：image /models 可能把 key 当模型 id 回显
  const models = result.models === undefined ? undefined : result.models.map((model) => sanitize(model, key));
  const status = result.status; // 联合类型静态值，不可能含 Key；保留在此以便审阅
  const httpStatus = result.httpStatus;
  const latencyMs = result.latencyMs;
  return {
    ok: result.ok,
    status,
    message,
    ...(detail !== undefined ? { detail } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  };
}
