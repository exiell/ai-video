import { Readability } from '@mozilla/readability';
import { isDesktopApp } from '../../platform';
import { resolvePlatformFetch } from '../../platform/transport';

/**
 * 联网搜索与网页正文提取服务（Batch 2）
 *
 * 策略：
 * - 桌面端（Electron）经主进程 net.fetch 天然无 CORS，默认支持免 Key 轻量搜索（DuckDuckGo HTML / Bing），
 *   也可在设置中配置 Tavily / 博查（Bocha）/ SearXNG 获得更稳定的中文检索体验；
 * - 网页正文提取使用成熟开源库 @mozilla/readability，避免重复造轮子。
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
    return new URL(rawUrl).hostname.replace(/^www\./, '');
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

/** 解析 DuckDuckGo HTML 轻量结果页（免 Key） */
export function parseDuckDuckGoHtml(html: string, limit = 5): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) !== null && results.length < limit) {
    const url = decodeDdgUrl(match[1] ?? '');
    const title = stripHtmlTags(match[2] ?? '');
    const snippet = stripHtmlTags(match[3] ?? match[4] ?? '');
    if (!url.startsWith('http') || !title) continue;
    results.push({ title, url, snippet, domain: domainOf(url) });
  }
  return results;
}

/** 解析 Bing 国际/中文搜索 HTML 结果（免 Key 兜底） */
export function parseBingHtml(html: string, limit = 5): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const itemRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(html)) !== null && results.length < limit) {
    const block = match[1] ?? '';
    const linkMatch = /<h2[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkMatch) continue;
    const url = linkMatch[1] ?? '';
    const title = stripHtmlTags(linkMatch[2] ?? '');
    const pMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = stripHtmlTags(pMatch?.[1] ?? '');
    if (!title || !url) continue;
    results.push({ title, url, snippet, domain: domainOf(url) });
  }
  return results;
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
    return { ok: false, results: [], error: `Tavily 搜索返回 HTTP ${res.status}，请检查 API Key。` };
  }
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const results: WebSearchResult[] = (data.results ?? [])
    .filter((r) => Boolean(r.title && r.url))
    .slice(0, limit)
    .map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r.content ?? '').slice(0, 320),
      domain: domainOf(r.url ?? ''),
    }));
  return { ok: true, results, providerUsed: 'Tavily' };
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
    return { ok: false, results: [], error: `博查搜索返回 HTTP ${res.status}，请检查 API Key。` };
  }
  const data = (await res.json()) as {
    data?: { webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string; summary?: string }> } };
  };
  const items = data.data?.webPages?.value ?? [];
  const results: WebSearchResult[] = items
    .filter((r) => Boolean(r.name && r.url))
    .slice(0, limit)
    .map((r) => ({
      title: r.name ?? '',
      url: r.url ?? '',
      snippet: (r.summary || r.snippet || '').slice(0, 320),
      domain: domainOf(r.url ?? ''),
    }));
  return { ok: true, results, providerUsed: '博查' };
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
    return { ok: false, results: [], error: `SearXNG 返回 HTTP ${res.status}，请确认实例地址开启了 JSON 格式。` };
  }
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const results: WebSearchResult[] = (data.results ?? [])
    .filter((r) => Boolean(r.title && r.url))
    .slice(0, limit)
    .map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r.content ?? '').slice(0, 320),
      domain: domainOf(r.url ?? ''),
    }));
  return { ok: true, results, providerUsed: 'SearXNG' };
}

async function searchFreeDesktop(
  query: string,
  fetchImpl: typeof fetch,
  limit: number,
): Promise<WebSearchOutcome> {
  // 优先 Bing（中文网络可达性高），失败则回退 DuckDuckGo HTML
  try {
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit + 3}`;
    const res = await fetchImpl(bingUrl, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (res.ok) {
      const html = await res.text();
      const parsed = parseBingHtml(html, limit);
      if (parsed.length > 0) {
        return { ok: true, results: parsed, providerUsed: 'Bing（免 Key）' };
      }
    }
  } catch {
    // 回退 DuckDuckGo
  }

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
        return { ok: true, results: parsed, providerUsed: 'DuckDuckGo（免 Key）' };
      }
    }
  } catch {
    // 均不可达
  }

  return {
    ok: false,
    results: [],
    error: '免 Key 联网搜索暂时没有抓到结果。可在「设置 → 连接与 Key」配置博查或 Tavily 搜索密钥以获得稳定中文搜索。',
  };
}

/** 统一联网搜索入口 */
export async function searchWeb(
  query: string,
  options: { limit?: number; config?: WebSearchConfig; fetchImpl?: typeof fetch } = {},
): Promise<WebSearchOutcome> {
  const q = query.trim();
  if (!q) return { ok: true, results: [] };
  const limit = options.limit ?? 5;
  const config = options.config ?? readWebSearchConfig();
  const fetchImpl = resolvePlatformFetch(options.fetchImpl);

  try {
    if (config.provider === 'tavily' && config.apiKey.trim()) {
      return await searchWithTavily(q, config.apiKey.trim(), fetchImpl, limit);
    }
    if (config.provider === 'bocha' && config.apiKey.trim()) {
      return await searchWithBocha(q, config.apiKey.trim(), fetchImpl, limit);
    }
    if (config.provider === 'searxng' && config.searxngUrl.trim()) {
      return await searchWithSearxng(q, config.searxngUrl.trim(), fetchImpl, limit);
    }

    // auto 模式：若有配置 Key/URL 优先使用，否则桌面端走免 Key 搜索
    if (config.apiKey.trim()) {
      return await searchWithTavily(q, config.apiKey.trim(), fetchImpl, limit);
    }
    if (config.searxngUrl.trim()) {
      return await searchWithSearxng(q, config.searxngUrl.trim(), fetchImpl, limit);
    }

    if (isDesktopApp() || options.fetchImpl) {
      return await searchFreeDesktop(q, fetchImpl, limit);
    }

    return {
      ok: false,
      results: [],
      error: '网页版受浏览器跨域限制，无法免 Key 直接抓搜索引擎。请使用 AniGuide 桌面客户端，或在「设置 → 连接与 Key」填写 Tavily / 博查搜索密钥。',
    };
  } catch (error) {
    return {
      ok: false,
      results: [],
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
          excerpt: (article.excerpt?.trim() || clean.slice(0, 240)),
        };
      }
    }
    // 兜底纯文本剥离
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
