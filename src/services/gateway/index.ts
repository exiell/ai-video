import type { ModelProfile } from '../../types/model';
import {
  buildDashScopeAsyncPayload,
  buildDashScopeHeaders,
  buildDashScopeSyncPayload,
  extractDashScopeSyncImages,
  extractDashScopeTaskId,
  mapDashScopeErrorCode,
  parseDashScopeError,
} from './dashscope';

/**
 * 模型调用网关（方案.md v0.6 §5.4 —— 核心壁垒之一）
 *
 * 铁律：**所有模型调用必须经过这里**。业务代码不允许直接 fetch 厂商接口。
 * 这样将来要接代理，只改这一处配置，业务逻辑零改动。
 *
 * 两种 Transport：
 *  - DirectTransport（默认）：浏览器直连厂商 endpoint
 *  - ProxyTransport（可选）：改写成 {proxyBaseUrl}/relay?target=<原地址>，
 *    由无状态轻代理转发。代理侧要求：域名白名单、不落库、不记录请求体与密钥。
 */

// ---------------------------------------------------------------------------
// 错误分类（方案.md §3.2 M0：设置页要能区分报错类型并给人话提示）
// ---------------------------------------------------------------------------

export type GatewayErrorKind =
  | 'cors'
  | 'network'
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'not-found'
  | 'bad-request'
  | 'server'
  | 'timeout'
  | 'parse'
  | 'aborted'
  /** 内容合规拦截（阿里云百炼会因提示词触发审核而拒绝） */
  | 'content-policy';

export interface GatewayErrorInfo {
  kind: GatewayErrorKind;
  /** 一句话说清出了什么事 */
  title: string;
  /** 为什么，以及怎么解决 */
  advice: string;
  /** HTTP 状态码（如果有） */
  status?: number;
  /** 厂商返回的原始信息，收在折叠区里 */
  raw?: string;
}

/**
 * 把一次失败的请求翻译成人话。
 *
 * 这是本模块最重要的部分：新手看到 "TypeError: Failed to fetch" 只会放弃，
 * 看到「浏览器被跨域策略挡住了，需要开启代理」才知道下一步做什么。
 */
export function classifyError(error: unknown, status?: number, body?: string): GatewayErrorInfo {
  // 主动取消
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { kind: 'aborted', title: '请求已取消', advice: '如果你没有主动取消，可能是超时了，重试一次。' };
  }

  // fetch 直接抛错：绝大多数情况是被 CORS 拦了
  if (error instanceof TypeError) {
    return {
      kind: 'cors',
      title: '浏览器没能发出这个请求，最可能是被跨域策略挡住了',
      advice:
        '这类错误在代码里看不出来，只能在浏览器里试。解决办法有两个：① 在设置里填写一个转发代理；② 换一家允许浏览器直连的服务商。点击「测试连接」可以看到更详细的判断。',
      raw: error.message,
    };
  }

  // 阿里云百炼的错误走顶层 code 字段，与 OpenAI 风格完全不同，必须先分流
  const vendorError = parseDashScopeError(body);
  if (vendorError) {
    const mapped = mapDashScopeErrorCode(vendorError.code);
    const detail = vendorError.message;
    if (mapped === 'auth') {
      return {
        kind: 'auth',
        title: 'API Key 无效或已过期',
        advice: `去阿里云百炼控制台确认 Key 有没有复制完整、有没有被删除。注意：北京与新加坡地域的 Key 不通用。${detail}`,
        ...(status !== undefined ? { status } : {}),
        raw: body,
      };
    }
    if (mapped === 'quota') {
      return {
        kind: 'quota',
        title: '账户余额不足或没有开通权限',
        advice: `去阿里云百炼控制台查余额；新账号的免费额度有时需要手动领取。${detail}`,
        ...(status !== undefined ? { status } : {}),
        raw: body,
      };
    }
    if (mapped === 'rate-limit') {
      return {
        kind: 'rate-limit',
        title: '请求太频繁，被限流了',
        advice: '等几十秒再试。批量生成时把节奏放慢一些。',
        ...(status !== undefined ? { status } : {}),
        raw: body,
      };
    }
    if (mapped === 'not-found') {
      return {
        kind: 'not-found',
        title: '模型不存在或当前地域不提供',
        advice: `检查模型名，以及你的 Key 属于哪个地域（北京 / 新加坡）。${detail}`,
        ...(status !== undefined ? { status } : {}),
        raw: body,
      };
    }
    if (mapped === 'content-policy') {
      return {
        kind: 'content-policy',
        title: '提示词被内容安全审核拦下了',
        advice:
          '这不是技术故障。把画面描述里的敏感内容改掉——通常涉及暴力、血腥、真人肖像或特定品牌。改完再试一次即可。' +
          detail,
        ...(status !== undefined ? { status } : {}),
        raw: body,
      };
    }
    if (mapped === 'server') {
      return {
        kind: 'server',
        title: '平台服务端出错',
        advice: '这不是你的问题。等几分钟重试。',
        ...(status !== undefined ? { status } : {}),
        raw: body,
      };
    }
    if (mapped === 'bad-request') {
      return {
        kind: 'bad-request',
        title: '请求参数有问题，平台拒绝了',
        advice: `通常是参数格式或取值范围不对。${detail}`,
        ...(status !== undefined ? { status } : {}),
        raw: body,
      };
    }
  }

  if (status !== undefined) {
    const detail = extractVendorMessage(body);
    switch (status) {
      case 400: {
        // 厂商的原话必须出现在最显眼的位置。
        // 教训：这条错误原来是笼统的「参数填错了」，
        // 而厂商其实明确说了「支持的模型名是 X、Y，你传的是 Z」——
        // 那句话才是用户真正需要的，不该被埋在折叠区里。
        const isModelProblem = /model/i.test(detail);
        return {
          kind: 'bad-request',
          title: detail
            ? isModelProblem
              ? `模型名不被接受：${detail}`
              : `厂商拒绝了这次请求：${detail}`
            : '请求格式有问题，厂商拒绝了',
          advice: isModelProblem
            ? '去「设置」页把这一栏的**模型名**改成厂商列出的名字。厂商会下架旧模型、上架新模型，' +
              '这个输入框就是为了让你不用等工具更新。'
            : '通常是参数填错了。检查一下设置里的模型名与参数范围，错误信息里通常写了原因。',
          status,
          raw: body,
        };
      }
      case 401:
        return {
          kind: 'auth',
          title: 'API Key 无效或已过期',
          advice:
            '去厂商控制台确认 Key 有没有复制完整（注意别带上多余空格），以及有没有被删除或重置。' +
            (detail ? `厂商的原话：${detail}` : ''),
          status,
          raw: body,
        };
      case 402:
      case 403:
        return {
          kind: 'quota',
          title:
            status === 402
              ? '账户余额不足'
              : '这个 Key 没有权限，或者余额不足',
          advice:
            '去厂商控制台看一下余额。国内平台多数需要先充值才会放行请求，新账号的免费额度有时需要手动领取。' +
            (detail ? `厂商的原话：${detail}` : ''),
          status,
          raw: body,
        };
      case 404:
        return {
          kind: 'not-found',
          title: '接口地址或模型名不存在',
          advice: `检查接口地址是否写对，以及模型名是否是这家厂商支持的。${detail}`,
          status,
          raw: body,
        };
      case 429:
        return {
          kind: 'rate-limit',
          title: '请求太频繁，被限流了',
          advice: '等几十秒再试。如果连续出现，说明当前账号的并发额度较低，把批量生成的节奏放慢一些。',
          status,
          raw: body,
        };
      default:
        if (status >= 500) {
          return {
            kind: 'server',
            title: `厂商服务端出错（${status}）`,
            advice: '这不是你的问题。等几分钟重试；如果持续出现，去厂商的状态页看看是不是在维护。',
            status,
            raw: body,
          };
        }
        return {
          kind: 'network',
          title: `请求失败（HTTP ${status}）`,
          advice: detail || '检查网络连接和接口地址。',
          status,
          raw: body,
        };
    }
  }

  if (error instanceof Error) {
    return {
      kind: 'network',
      title: '请求没有完成',
      advice: '检查网络连接。如果你在国内访问海外服务，可能需要额外的网络条件。',
      raw: error.message,
    };
  }

  return { kind: 'network', title: '未知错误', advice: '重试一次；如果一直失败，把原始错误信息记下来。' };
}

/** 从厂商返回体里抠出一句人能看懂的话 */
export function extractVendorMessage(body: string | undefined): string {
  if (!body) return '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const err = obj.error;
      if (typeof err === 'string') return err;
      if (typeof err === 'object' && err !== null) {
        const message = (err as Record<string, unknown>).message;
        if (typeof message === 'string') return message;
      }
      if (typeof obj.message === 'string') return obj.message;
      if (typeof obj.msg === 'string') return obj.msg;
    }
  } catch {
    // 不是 JSON，原样截断返回
  }
  return body.slice(0, 200);
}

export class GatewayError extends Error {
  readonly info: GatewayErrorInfo;

  constructor(info: GatewayErrorInfo) {
    super(info.title);
    this.name = 'GatewayError';
    this.info = info;
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface TransportConfig {
  /** 代理地址，留空则用直连 */
  proxyBaseUrl?: string;
  /** 代理通行口令（用户自设，代理侧校验后丢弃） */
  applicationPassword?: string;
}

export interface RequestOptions {
  profile: ModelProfile;
  apiKey: string;
  /** 相对 endpoint 的路径；profile.endpoint 已是完整地址，这里一般不需要 */
  body: unknown;
  transport?: TransportConfig;
  /** 超时毫秒，默认 60 秒 */
  timeoutMs?: number;
  /** 注入 fetch 便于测试 */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** 把 endpoint 改写成经过代理的地址 */
export function buildProxyUrl(proxyBaseUrl: string, target: string): string {
  const base = proxyBaseUrl.replace(/\/+$/, '');
  return `${base}/relay?target=${encodeURIComponent(target)}`;
}

/**
 * 组装请求头。
 *
 * 三种协议的鉴权方式不同，且 DashScope 异步接口还要求额外的
 * `X-DashScope-Async: enable`——少了它服务端会报
 * "current user api does not support synchronous calls"。
 */
export function buildHeaders(profile: ModelProfile, apiKey: string): Record<string, string> {
  const flavor = profile.apiFlavor ?? 'openai';
  if (flavor === 'dashscope-sync' || flavor === 'dashscope-async') {
    return buildDashScopeHeaders(flavor, apiKey);
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (profile.authType === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  else headers['x-api-key'] = apiKey;
  return headers;
}

/** 该档案走的是哪套协议 */
export function flavorOf(profile: ModelProfile): 'openai' | 'dashscope-sync' | 'dashscope-async' {
  return profile.apiFlavor ?? 'openai';
}

/**
 * 发起一次模型请求。
 * 成功返回解析后的 JSON，失败抛 GatewayError（已带人话说明）。
 */
export async function request<T = unknown>(options: RequestOptions): Promise<T> {
  const {
    profile,
    apiKey,
    body,
    transport,
    // 出图是同步接口里最慢的一类，官方给出的耗时量级是几十秒，默认给足 3 分钟
    timeoutMs = profile.type === 't2i' ? 180_000 : 60_000,
    fetchImpl = fetch,
    signal,
  } = options;

  const useProxy = Boolean(transport?.proxyBaseUrl);
  const url = useProxy
    ? buildProxyUrl(transport!.proxyBaseUrl!, profile.endpoint)
    : profile.endpoint;

  const headers = buildHeaders(profile, apiKey);
  if (useProxy && transport?.applicationPassword) {
    headers['x-aniguide-proxy-token'] = transport.applicationPassword;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new GatewayError(classifyError(error));
  }
  clearTimeout(timer);

  const text = await response.text();

  if (!response.ok) {
    throw new GatewayError(classifyError(undefined, response.status, text));
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GatewayError({
      kind: 'parse',
      title: '厂商返回的内容不是合法 JSON',
      advice: '通常是接口地址填错了（比如把页面地址当成了接口地址）。检查一下设置里的接口地址。',
      raw: text.slice(0, 300),
    });
  }
}

// ---------------------------------------------------------------------------
// 载荷构造
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequestOptions {
  model: string;
  messages: ChatMessage[];
  /** 要求返回 JSON 对象 */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
}

/** 构造 OpenAI 兼容的对话请求体 */
export function buildChatPayload(options: ChatRequestOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
  };
  if (options.jsonMode) payload.response_format = { type: 'json_object' };
  if (options.temperature !== undefined) payload.temperature = options.temperature;
  if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens;
  return payload;
}

/** 从 OpenAI 兼容的响应里取出正文 */
export function extractChatContent(response: unknown): string {
  if (typeof response !== 'object' || response === null) return '';
  const choices = (response as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return '';
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : '';
}

export interface ImageRequestOptions {
  /** 实际模型名。必须显式指定——不同厂商的模型名不通用。 */
  model: string;
  prompt: string;
  negativePrompt?: string;
  /** 画幅比例，例：9:16。DashScope 会换算成像素串，OpenAI 风格会转成尺寸串。 */
  aspectRatio?: string;
  /** OpenAI 风格的尺寸串，例：1024x1024。仅 openai 协议使用。 */
  imageSize?: string;
  batchSize?: number;
  seed?: number;
  /**
   * 参考图（base64 data URI）。
   *
   * 这是 L3 一致性锚定的载体：角色形象图、本镜首帧、上一镜尾帧都从这里进。
   * 各家的字段名不同（DashScope 走 content 数组、OpenAI 兼容走 image、
   * MiniMax 走 subject_reference），由档案的 imagePayload 映射决定怎么摆。
   */
  referenceImages?: string[];
}

/** 构造 OpenAI 兼容的文生图请求体 */
export function buildOpenAiImagePayload(options: ImageRequestOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: options.model,
    prompt: options.prompt,
  };
  if (options.negativePrompt) payload.negative_prompt = options.negativePrompt;
  if (options.imageSize) payload.image_size = options.imageSize;
  if (options.batchSize !== undefined) payload.batch_size = options.batchSize;
  if (options.seed !== undefined) payload.seed = options.seed;
  return payload;
}

/**
 * 按档案的协议风格构造文生图请求体。
 *
 * 这是「配置化适配层」的关键落点：上层调用方只给一份画面意图，
 * 由这里决定该翻译成哪种协议格式。业务代码不需要知道千问和硅基流动的区别。
 */
export function buildImagePayloadFor(
  profile: ModelProfile,
  options: ImageRequestOptions,
): Record<string, unknown> {
  const flavor = flavorOf(profile);
  const common = {
    model: options.model,
    prompt: options.prompt,
    ...(options.negativePrompt !== undefined ? { negativePrompt: options.negativePrompt } : {}),
    ...(options.aspectRatio !== undefined ? { aspectRatio: options.aspectRatio } : {}),
    ...(options.batchSize !== undefined ? { n: options.batchSize } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    /**
     * 注意： 参考图必须在这里透传。
     *
     * 这个函数原来**从来没有被调用过**（出图链路自己拼了另一份载荷），
     * 所以它漏掉 referenceImages 这件事一直没暴露。
     * 一旦接上真实链路，漏掉它就等于**整条 L3 参考图锚定全部失效**——
     * 而它恰恰是本工具一致性的命脉。
     */
    ...(options.referenceImages !== undefined ? { referenceImages: options.referenceImages } : {}),
  };
  if (flavor === 'dashscope-sync') return buildDashScopeSyncPayload(common);
  if (flavor === 'dashscope-async') return buildDashScopeAsyncPayload(common);
  // 有字段映射就按映射构造；没有就是 OpenAI 形状
  if (profile.imagePayload) return buildMappedImagePayload(profile, options);
  return buildOpenAiImagePayload(options);
}

/**
 * 按档案声明的字段映射构造出图请求体。
 *
 * 这样加一家提供方只需要在档案里写清「我们家的字段叫什么」，
 * 不用动网关逻辑——这是把「差异」放进数据、而不是放进代码。
 */
export function buildMappedImagePayload(
  profile: ModelProfile,
  options: ImageRequestOptions,
): Record<string, unknown> {
  const map = profile.imagePayload ?? {};
  const payload: Record<string, unknown> = {
    model: options.model,
    [map.promptField ?? 'prompt']: options.prompt,
  };

  // 尺寸：优先用宽高比字段（MiniMax 只认 aspect_ratio），否则用尺寸字段
  if (options.aspectRatio !== undefined) {
    if (map.aspectRatioField) payload[map.aspectRatioField] = options.aspectRatio;
    else if (map.sizeField) payload[map.sizeField] = ratioToSizeFor(options.aspectRatio);
  } else if (map.sizeField) {
    payload[map.sizeField] = ratioToSizeFor('1:1');
  }

  // 负向词：显式设为 null 表示该家不支持，就完全不带这个字段
  const negField = map.negativePromptField === undefined ? 'negative_prompt' : map.negativePromptField;
  if (negField !== null && options.negativePrompt?.trim()) {
    payload[negField] = options.negativePrompt;
  }

  if (options.batchSize !== undefined) payload[map.countField ?? 'n'] = options.batchSize;
  if (options.seed !== undefined) payload.seed = options.seed;

  /**
   * 参考图：各家摆法不同，这里给一个保守的默认——
   * 用 `image` 字段放数组（OpenAI 兼容风格里最常见的那种）。
   *
   * 如果某家既不是 OpenAI 风格、又不是 DashScope 风格，就在档案里补一个
   * `referenceField` 说明它叫什么；补不了就说明这个档案不支持参考图，
   * 应该在 capabilities 里写 referenceImage: false——**不要假装支持**。
   */
  if (options.referenceImages && options.referenceImages.length > 0) {
    if (map.referenceField === null) {
      // 档案明确声明不支持，静默不带（上层已按 capabilities 截断过）
    } else if (map.referenceFormat === 'character') {
      // MiniMax 形状：对象数组，每一项标明参考类型
      payload[map.referenceField ?? 'subject_reference'] = options.referenceImages.map(
        (dataUrl) => ({ type: 'character', image_file: dataUrl }),
      );
    } else {
      payload[map.referenceField ?? 'image'] = options.referenceImages;
    }
  }

  return payload;
}

/** 把比例换算成方形像素尺寸（各家对 size 的取值要求不同，这里给保守的方图） */
function ratioToSizeFor(ratio: string): string {
  if (ratio === '16:9') return '1280x720';
  if (ratio === '9:16') return '720x1280';
  return '1024x1024';
}

/** 从 OpenAI 兼容的文生图响应里取出图片 URL 列表 */
export function extractOpenAiImageUrls(response: unknown): string[] {
  if (typeof response !== 'object' || response === null) return [];
  const data = (response as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const urls: string[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const url = (item as Record<string, unknown>).url;
    if (typeof url === 'string') urls.push(url);
  }
  return urls;
}

/** 按档案的协议风格解析出图片 URL */
export function extractImageUrlsFor(profile: ModelProfile, response: unknown): string[] {
  const flavor = flavorOf(profile);
  if (flavor === 'dashscope-sync') return extractDashScopeSyncImages(response);
  // 异步接口的创建任务响应里没有图；这里返回空，由轮询逻辑负责取图
  if (flavor === 'dashscope-async') return extractDashScopeSyncImages(response);
  // 有自定义响应路径就按路径取（MiniMax 是 data.image_urls）
  const path = profile.imagePayload?.responseImageArray;
  if (path) return collectImageUrls(resolvePath(response, path));
  return extractOpenAiImageUrls(response);
}

/** 按点号路径取值，例如 `data.image_urls` */
function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 把「字符串数组」或「含 url 字段的对象数组」都收敛成 URL 列表 */
function collectImageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.push(item);
    else if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>;
      for (const key of ['url', 'image_url', 'b64_json', 'image']) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          out.push(candidate);
          break;
        }
      }
    }
  }
  return out;
}

/** @deprecated 用 buildImagePayloadFor(profile, options)；保留是为了兼容既有调用点 */
export const buildImagePayload = buildOpenAiImagePayload;
/** @deprecated 用 extractImageUrlsFor(profile, response) */
export const extractImageUrls = extractOpenAiImageUrls;

// ---------------------------------------------------------------------------
// 连接测试（方案.md §3.2 M0：「测试连接」按钮）
// ---------------------------------------------------------------------------

/**
 * 测试连接时的默认模型名。
 *
 * 注意： 调用方应当通过 options.modelName 显式传入模型名，
 * 由上层统一解析（见 services/llm/modelName.ts）。
 * 这个兜底值只在没传时使用。
 *
 * 历史教训：这里曾经和生成路径各算一遍模型名，导致
 * 「测试连接通过、一生成就报错」——同一个东西不能有两个来源。
 */
function testModelOf(profile: ModelProfile): string {
  return profile.model ?? profile.name;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** 用了哪种传输方式 */
  via: 'direct' | 'proxy';
  /** 耗时毫秒 */
  elapsedMs: number;
  info?: GatewayErrorInfo;
  /** 成功时返回的模型原话，用于确认这确实是模型在回答 */
  sample?: string;
}

/**
 * 测试连接：发一次最小请求，把「Key 是否有效 / 额度是否可用 / 跨域是否被拦」
 * 三件事一次问清楚，并给出分类结论。
 */
export interface TestConnectionOptions {
  /** 显式指定模型名。不传则用档案里的 model 字段。 */
  modelName?: string;
}

export async function testConnection(
  profile: ModelProfile,
  apiKey: string,
  transport?: TransportConfig,
  fetchImpl: typeof fetch = fetch,
  options: TestConnectionOptions = {},
): Promise<ConnectionTestResult> {
  const started = Date.now();
  const via: 'direct' | 'proxy' = transport?.proxyBaseUrl ? 'proxy' : 'direct';
  const model = options.modelName?.trim() || testModelOf(profile);

  /**
   * 没有模型名就不要发请求。
   *
   * 千帆那个档案的模型名**故意留空**——因为官方文档抓不到当前可用的 ernie 型号，
   * 填一个猜测的名字只会让用户看到「模型名不被接受」，然后不知道该怪谁。
   * 所以这里直接告诉他「缺什么、去哪查」，比发一个必然失败的请求有用。
   */
  if (!model.trim()) {
    return {
      ok: false,
      via,
      elapsedMs: Date.now() - started,
      info: {
        kind: 'bad-request',
        title: `${profile.name} 还没有填模型名`,
        advice:
          '去厂商控制台查当前可用的模型名，填到上面「模型名」那一栏再试。' +
          (profile.notes ?? ''),
      },
    } as ConnectionTestResult;
  }

  try {
    if (profile.type === 'llm') {
      const response = await request({
        profile,
        apiKey,
        body: buildChatPayload({
          model,
          messages: [{ role: 'user', content: '回复两个字：可以' }],
          maxTokens: 16,
        }),
        transport,
        timeoutMs: 30_000,
        fetchImpl,
      });
      return {
        ok: true,
        via,
        elapsedMs: Date.now() - started,
        sample: extractChatContent(response) || '(模型返回了空内容，但请求本身是通的)',
      };
    }

    // 用 1:1 的最小尺寸做探测，尽量少花钱
    const response = await request({
      profile,
      apiKey,
      body: buildImagePayloadFor(profile, {
        model,
        prompt: 'a simple red circle on white background',
        batchSize: 1,
        aspectRatio: '1:1',
      }),
      transport,
      timeoutMs: 180_000,
      fetchImpl,
    });
    const flavor = flavorOf(profile);

    // 异步接口在这一步只拿到 task_id，图片要再查一次
    if (flavor === 'dashscope-async') {
      const taskId = extractDashScopeTaskId(response);
      return {
        ok: Boolean(taskId),
        via,
        elapsedMs: Date.now() - started,
        sample: taskId
          ? `已创建生成任务（task_id ${taskId.slice(0, 8)}…）。接口可用。`
          : '(请求通了，但没有返回 task_id)',
      };
    }

    const urls = extractImageUrlsFor(profile, response);
    return {
      ok: true,
      via,
      elapsedMs: Date.now() - started,
      sample:
        urls.length > 0
          ? `生成了 ${urls.length} 张图${
              profile.imageUrlTtlHours
                ? `（链接 ${profile.imageUrlTtlHours} 小时后失效，请及时保存）`
                : ''
            }`
          : '(请求通了，但没返回图片地址)',
    };
  } catch (error) {
    const info =
      error instanceof GatewayError ? error.info : classifyError(error);
    return { ok: false, via, elapsedMs: Date.now() - started, info };
  }
}

