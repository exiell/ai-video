import { Readability } from '@mozilla/readability';
import { isDesktopApp } from '../../platform';
import { resolvePlatformFetch } from '../../platform/transport';
import { buildChatPayload, extractChatContent, request } from '../gateway';
import type { GenerateContext } from '../llm/generate';

/**
 * 联网搜索与网页正文提取服务（Batch 2 + 搜索质量增强）
 *
 * 三层质量保障：
 * 1. 智能搜索词提炼（LLM Query Rewrite + 本地口语清洗兜底），彻底避免把「我 / 帮我 / 想做」原句喂给搜索引擎；
 * 2. 免 Key 多源协同：cn.bing.com（解码跳转链）+ 中文维基百科开放 JSON API + DuckDuckGo 兜底，
 *    同时支持在设置中配置博查（Bocha）/ Tavily / SearXNG；
 * 3. 严格脏结果过滤：剔除搜索引擎自身主页/导航链接、单字无效词条（如「我」）与重复 URL。
 */

export type SearchProvider = 'auto' | 'tavily' | 'bocha' | 'searxng';

export interface WebSearchConfig {
  provider: SearchProvider;
  apiKey: string;
  searxngUrl: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface WebSearchOutcome {
  ok: boolean;
  results: WebSearchResult[];
  /** 实际提交给搜索引擎的提炼后关键词，便于界面透明展示 */
  searchQueryUsed?: string;
  providerUsed?: string;
  error?: string;
}

export interface ExtractedWebpage {
  ok: boolean;
  title: string;
  url: string;
  textContent: string;
  excerpt: string;
  error?: string;
}

const SEARCH_CONFIG_KEY = 'aniguide:web-search-config';

const BLOCKED_SEARCH_HOSTS = new Set([
  'bing.com',
  'cn.bing.com',
  'www.bing.com',
  'duckduckgo.com',
  'html.duckduckgo.com',
  'google.com',
  'www.google.com',
  'go.microsoft.com',
  'login.live.com',
  'account.microsoft.com',
]);

export function readWebSearchConfig(): WebSearchConfig {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SEARCH_CONFIG_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WebSearchConfig>;
      const provider: SearchProvider =
        parsed.provider === 'tavily' ||
        parsed.provider === 'bocha' ||
        parsed.provider === 'searxng'
          ? parsed.provider
          : 'auto';
      return {
        provider,
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
        searxngUrl: typeof parsed.searxngUrl === 'string' ? parsed.searxngUrl : '',
      };
    }
  } catch {
    // 忽略损坏配置
  }
  return { provider: 'auto', apiKey: '', searxngUrl: '' };
}

export function saveWebSearchConfig(config: WebSearchConfig): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SEARCH_CONFIG_KEY, JSON.stringify(config));
    }
  } catch {
    // 存储受限时忽略
  }
}

function domainOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 本地搜索词清洗兜底：
 * 去掉「我想做一个…」「帮我查一下…」「请问…」等聊天口语前缀与人称代词，保留核心主题词。
 */
export function cleanSearchQuery(rawInput: string): string {
  let q = rawInput
    .replace(/\r?\n/g, ' ')
    .replace(/[「」『』【】《》"'“”‘’]/g, ' ')
    .replace(
      /^(?:请|麻烦|你好|嗨|帮我|给我|我想|我要|我打算|我准备|咱们|我们|能不能|可以|能否)+(?:做|拍|写|查|搜|搜索|了解|看看|讲讲|介绍一下|探讨|讨论)?(?:一个|一部|一段|一下|关于)?/g,
      '',
    )
    .replace(/(?:怎么拍|怎么写|怎么做|怎么讲|给点建议|有什么建议|帮我查一下|查一下|搜一下|科普动漫|科普视频|动漫视频|短视频)/g, ' ')
    .replace(/[，。！？、；：,.!?;:()（）]+/g, ' ')
    .replace(/(?:^|\s)(?:我|你|他|她|它|我们|你们|大家|这个|那个|一下|关于)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (q.length > 48) {
    q = q.slice(0, 48).trim();
  }
  return q || rawInput.trim().slice(0, 48);
}

/**
 * 智能搜索词提炼：优先调用当前已配置的 LLM 提炼 1 条干净搜索词（~0.5s），
 * 失败或未传 LLM 上下文时自动回退到本地 cleanSearchQuery。
 */
export async function rewriteSearchQuery(
  rawInput: string,
  options: { projectTopic?: string; llmCtx?: GenerateContext } = {},
): Promise<string> {
  const fallback = cleanSearchQuery(rawInput);
  if (!options.llmCtx) return fallback;

  try {
    const topicHint = options.projectTopic?.trim()
      ? `当前视频项目主题：${options.projectTopic.trim()}\n`
      : '';
    const response = await request({
      profile: options.llmCtx.profile,
      apiKey: options.llmCtx.apiKey,
      timeoutMs: 8_000,
      body: buildChatPayload({
        model: options.llmCtx.model,
        messages: [
          {
            role: 'system',
            content:
              '你是搜索引擎关键词提炼器。把用户的自然语言提问改写成 1 条精准的中文或中英混合搜索关键词（2-6 个核心词，空格分隔）。' +
              '严禁出现「我」「你」「帮我」「想做」「视频」等口语词，严禁输出解释、引号或标点，只输出这一行搜索词。',
          },
          {
            role: 'user',
            content: `${topicHint}用户提问：${rawInput.trim()}`,
          },
        ],
        jsonMode: false,
        temperature: 0.1,
        maxTokens: 64,
      }),
      ...(options.llmCtx.transport ? { transport: options.llmCtx.transport } : {}),
      ...(options.llmCtx.fetchImpl ? { fetchImpl: options.llmCtx.fetchImpl } : {}),
    });
    const candidate = extractChatContent(response)
      .split(/\r?\n/)[0]
      ?.replace(/^[\s"'「」`\-*•]+|[\s"'「」`。！？]+$/g, '')
      .trim();
    if (candidate && candidate.length >= 2 && candidate.length <= 60 && candidate !== '我') {
      return candidate;
    }
  } catch {
    // 提炼失败静默回退本地清洗，不阻塞主对话
  }
  return fallback;
}

/** 解码 Bing 搜索结果里的跳转链接（bing.com/ck/a?...&u=a1<base64url>） */
export function decodeBingRedirectUrl(href: string): string {
  try {
    const parsed = new URL(href);
    const host = parsed.hostname.toLowerCase();
    if ((host === 'www.bing.com' || host === 'cn.bing.com' || host === 'bing.com') && parsed.pathname.startsWith('/ck/a')) {
      const u = parsed.searchParams.get('u');
      if (u && u.startsWith('a1') && u.length > 4) {
        const b64 = u.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const decoded =
          typeof Buffer !== 'undefined'
            ? Buffer.from(padded, 'base64').toString('utf8')
            : atob(padded);
        if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
          return decoded;
        }
      }
    }
  } catch {
    // 保持原链接
  }
  return href;
}

function decodeDdgUrl(href: string): string {
  try {
    const u = new URL(href, 'https://html.duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg;
    if (href.startsWith('http://') || href.startsWith('https://')) return href;
  } catch {
    // fallback
  }
  return href;
}

/** 过滤搜索引擎自身主页/跳转页、单字无效标题（如「我」）与非法链接 */
export function isValidSearchResult(item: WebSearchResult): boolean {
  const title = item.title.trim();
  if (title.length < 2) return false;
  if (!item.url.startsWith('http://') && !item.url.startsWith('https://')) return false;

  try {
    const parsed = new URL(item.url);
    const host = parsed.hostname.toLowerCase();
    if (BLOCKED_SEARCH_HOSTS.has(host)) return false;
    // 排除纯搜索引擎首页（例如 baidu.com / sogou.com 根路径）
    if (
      (host.endsWith('baidu.com') || host.endsWith('sogou.com') || host.endsWith('so.com')) &&
      (parsed.pathname === '/' || parsed.pathname === '')
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function dedupeAndFilter(items: WebSearchResult[], limit: number): WebSearchResult[] {
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const item of items) {
    if (!isValidSearchResult(item)) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** 解析 DuckDuckGo HTML 轻量结果页（免 Key） */
export function parseDuckDuckGoHtml(html: string, limit = 5): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) !== null && results.length < limit * 2) {
    const url = decodeDdgUrl(match[1] ?? '');
    const title = stripHtmlTags(match[2] ?? '');
    const snippet = stripHtmlTags(match[3] ?? match[4] ?? '');
    results.push({ title, url, snippet, domain: domainOf(url) });
  }
  return dedupeAndFilter(results, limit);
}

/** 解析 Bing 国际/中文搜索 HTML 结果（自动解码跳转链并过滤搜索引擎自身链接） */
export function parseBingHtml(html: string, limit = 5): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const itemRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(html)) !== null && results.length < limit * 2) {
    const block = match[1] ?? '';
    const linkMatch = /<h2[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkMatch) continue;
    const url = decodeBingRedirectUrl(linkMatch[1] ?? '');
    const title = stripHtmlTags(linkMatch[2] ?? '');
    const pMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = stripHtmlTags(pMatch?.[1] ?? '');
    results.push({ title, url, snippet, domain: domainOf(url) });
  }
  return dedupeAndFilter(results, limit);
}

/** 中文维基百科开放搜索 API（纯 JSON，无反爬，适合科普/历史/概念调研） */
async function searchWikipediaZh(
  query: string,
  fetchImpl: typeof fetch,
  limit: number,
): Promise<WebSearchResult[]> {
  try {
    const url =
      `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
      `&format=json&utf8=1&srlimit=${limit}`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      query?: { search?: Array<{ title?: string; snippet?: string; pageid?: number }> };
    };
    const items = data.query?.search ?? [];
    return items
      .filter((item) => Boolean(item.title))
      .map((item) => {
        const title = item.title ?? '';
        const pageUrl = `https://zh.wikipedia.org/wiki/${encodeURIComponent(title)}`;
        return {
          title: `${title} - 维基百科`,
          url: pageUrl,
          snippet: stripHtmlTags(item.snippet ?? ''),
          domain: 'zh.wikipedia.org',
        };
      });
  } catch {
    return [];
  }
}

async function searchWithTavily(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  limit: number,
): Promise<WebSearchOutcome> {
  const res = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
      search_depth: 'basic',
    }),
  });
  if (!res.ok) {
    return {
      ok: false,
      results: [],
      searchQueryUsed: query,
      error: `Tavily 搜索返回 HTTP ${res.status}，请检查 API Key。`,
    };
  }
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const results = dedupeAndFilter(
    (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r.content ?? '').slice(0, 320),
      domain: domainOf(r.url ?? ''),
    })),
    limit,
  );
  return { ok: true, results, searchQueryUsed: query, providerUsed: 'Tavily' };
}

async function searchWithBocha(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  limit: number,
): Promise<WebSearchOutcome> {
  const res = await fetchImpl('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      summary: true,
      count: limit,
    }),
  });
  if (!res.ok) {
    return {
      ok: false,
      results: [],
      searchQueryUsed: query,
      error: `博查搜索返回 HTTP ${res.status}，请检查 API Key。`,
    };
  }
  const data = (await res.json()) as {
    data?: { webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string; summary?: string }> } };
  };
  const items = data.data?.webPages?.value ?? [];
  const results = dedupeAndFilter(
    items.map((r) => ({
      title: r.name ?? '',
      url: r.url ?? '',
      snippet: (r.summary || r.snippet || '').slice(0, 320),
      domain: domainOf(r.url ?? ''),
    })),
    limit,
  );
  return { ok: true, results, searchQueryUsed: query, providerUsed: '博查' };
}

async function searchWithSearxng(
  query: string,
  baseUrl: string,
  fetchImpl: typeof fetch,
  limit: number,
): Promise<WebSearchOutcome> {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  const url = `${clean}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN`;
  const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!res.ok) {
    return {
      ok: false,
      results: [],
      searchQueryUsed: query,
      error: `SearXNG 返回 HTTP ${res.status}，请确认实例地址开启了 JSON 格式。`,
    };
  }
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const results = dedupeAndFilter(
    (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r.content ?? '').slice(0, 320),
      domain: domainOf(r.url ?? ''),
    })),
    limit,
  );
  return { ok: true, results, searchQueryUsed: query, providerUsed: 'SearXNG' };
}

async function searchFreeDesktop(
  query: string,
  fetchImpl: typeof fetch,
  limit: number,
): Promise<WebSearchOutcome> {
  const collected: WebSearchResult[] = [];
  const providers: string[] = [];

  // 1. cn.bing.com（国内直连可达，解码跳转链接并剔除自身主页）
  try {
    const bingUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${limit + 4}&ensearch=0`;
    const res = await fetchImpl(bingUrl, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if (res.ok) {
      const html = await res.text();
      const parsed = parseBingHtml(html, limit);
      if (parsed.length > 0) {
        collected.push(...parsed);
        providers.push('Bing');
      }
    }
  } catch {
    // 继续尝试其他源
  }

  // 2. 若结果偏少，补充中文维基百科开放 API（科普与背景知识命中极高）
  if (collected.length < limit) {
    const wiki = await searchWikipediaZh(query, fetchImpl, Math.min(3, limit));
    if (wiki.length > 0) {
      collected.push(...wiki);
      providers.push('维基百科');
    }
  }

  // 3. 仍为空时兜底 DuckDuckGo HTML
  if (collected.length === 0) {
    try {
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetchImpl(ddgUrl, {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        },
      });
      if (res.ok) {
        const html = await res.text();
        const parsed = parseDuckDuckGoHtml(html, limit);
        if (parsed.length > 0) {
          collected.push(...parsed);
          providers.push('DuckDuckGo');
        }
      }
    } catch {
      // 均不可达
    }
  }

  const finalResults = dedupeAndFilter(collected, limit);
  if (finalResults.length > 0) {
    return {
      ok: true,
      results: finalResults,
      searchQueryUsed: query,
      providerUsed: `${providers.join(' + ')}（免 Key）`,
    };
  }

  return {
    ok: false,
    results: [],
    searchQueryUsed: query,
    error: '免 Key 联网搜索暂时没有抓到有效结果。建议在「设置 → 连接与 Key」配置博查或 Tavily 搜索密钥以获得稳定中文搜索。',
  };
}

/** 统一联网搜索入口（自动进行搜索词提炼） */
export async function searchWeb(
  rawQuery: string,
  options: {
    limit?: number;
    config?: WebSearchConfig;
    fetchImpl?: typeof fetch;
    projectTopic?: string;
    llmCtx?: GenerateContext;
  } = {},
): Promise<WebSearchOutcome> {
  const trimmed = rawQuery.trim();
  if (!trimmed) return { ok: true, results: [] };

  const query = await rewriteSearchQuery(trimmed, {
    ...(options.projectTopic ? { projectTopic: options.projectTopic } : {}),
    ...(options.llmCtx ? { llmCtx: options.llmCtx } : {}),
  });
  const limit = options.limit ?? 5;
  const config = options.config ?? readWebSearchConfig();
  const fetchImpl = resolvePlatformFetch(options.fetchImpl);

  try {
    if (config.provider === 'tavily' && config.apiKey.trim()) {
      return await searchWithTavily(query, config.apiKey.trim(), fetchImpl, limit);
    }
    if (config.provider === 'bocha' && config.apiKey.trim()) {
      return await searchWithBocha(query, config.apiKey.trim(), fetchImpl, limit);
    }
    if (config.provider === 'searxng' && config.searxngUrl.trim()) {
      return await searchWithSearxng(query, config.searxngUrl.trim(), fetchImpl, limit);
    }

    if (config.apiKey.trim()) {
      return await searchWithTavily(query, config.apiKey.trim(), fetchImpl, limit);
    }
    if (config.searxngUrl.trim()) {
      return await searchWithSearxng(query, config.searxngUrl.trim(), fetchImpl, limit);
    }

    if (isDesktopApp() || options.fetchImpl) {
      return await searchFreeDesktop(query, fetchImpl, limit);
    }

    return {
      ok: false,
      results: [],
      searchQueryUsed: query,
      error: '网页版受浏览器跨域限制，无法免 Key 直接抓搜索引擎。请使用 AniGuide 桌面客户端，或在「设置 → 连接与 Key」填写博查或 Tavily 搜索密钥。',
    };
  } catch (error) {
    return {
      ok: false,
      results: [],
      searchQueryUsed: query,
      error: error instanceof Error ? error.message : '联网搜索失败，请稍后重试。',
    };
  }
}

/** 使用 @mozilla/readability 提取网页干净正文，供「收入资料库」与深度引用 */
export function extractArticleFromHtml(html: string, url: string): ExtractedWebpage {
  try {
    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const base = doc.createElement('base');
      base.href = url;
      doc.head?.appendChild(base);
      const article = new Readability(doc).parse();
      if (article && article.textContent && article.textContent.trim().length > 40) {
        const clean = article.textContent.replace(/\s+/g, ' ').trim();
        return {
          ok: true,
          title: article.title?.trim() || domainOf(url) || url,
          url,
          textContent: clean.slice(0, 12_000),
          excerpt: article.excerpt?.trim() || clean.slice(0, 240),
        };
      }
    }
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const title = stripHtmlTags(titleMatch?.[1] ?? '') || domainOf(url) || url;
    const textContent = stripHtmlTags(html).slice(0, 12_000);
    return {
      ok: textContent.length > 0,
      title,
      url,
      textContent,
      excerpt: textContent.slice(0, 240),
    };
  } catch (error) {
    return {
      ok: false,
      title: domainOf(url) || url,
      url,
      textContent: '',
      excerpt: '',
      error: error instanceof Error ? error.message : '正文解析失败',
    };
  }
}

/** 抓取网页并提取正文 */
export async function fetchAndExtractWebpage(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<ExtractedWebpage> {
  const fetcher = resolvePlatformFetch(fetchImpl);
  try {
    const res = await fetcher(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      return {
        ok: false,
        title: domainOf(url) || url,
        url,
        textContent: '',
        excerpt: '',
        error: `目标网页返回 HTTP ${res.status}`,
      };
    }
    const html = await res.text();
    return extractArticleFromHtml(html, url);
  } catch (error) {
    return {
      ok: false,
      title: domainOf(url) || url,
      url,
      textContent: '',
      excerpt: '',
      error: error instanceof Error ? error.message : '无法读取该网页内容',
    };
  }
}

/** 将搜索结果压缩为可注入提示词的参考资料块 */
export function formatWebResultsForPrompt(results: WebSearchResult[]): string {
  if (results.length === 0) return '';
  const lines = results.map(
    (item, idx) => `[网${idx + 1}] ${item.title} (${item.domain})\n链接：${item.url}\n摘要：${item.snippet || '（无摘要）'}`,
  );
  return `联网搜索参考资料（引用时可注明来源标题）：\n${lines.join('\n\n')}`;
}
