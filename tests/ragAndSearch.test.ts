// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  chunkText,
  formatRagHitsForPrompt,
  searchKnowledgeInMemory,
  tokenizeText,
} from '../src/services/rag';
import {
  extractArticleFromHtml,
  formatWebResultsForPrompt,
  parseBingHtml,
  parseDuckDuckGoHtml,
} from '../src/services/search/webSearch';
import type { KnowledgeDoc } from '../src/services/storage';

describe('第二批：本地中文 RAG 与联网搜索解析（Batch 2）', () => {
  it('tokenizeText 能切分中文科普关键词与英文词', () => {
    const tokens = tokenizeText('黑洞的事件视界 Event Horizon');
    expect(tokens.some((t) => t.includes('黑洞'))).toBe(true);
    expect(tokens.some((t) => t.includes('视界'))).toBe(true);
    expect(tokens).toContain('event');
    expect(tokens).toContain('horizon');
  });

  it('chunkText 将长文档切分为合理长度的段落块', () => {
    const longText = Array.from({ length: 12 }, (_, i) => `第${i + 1}段：黑洞是引力极强的天体，连光都无法逃脱。`).join('\n\n');
    const chunks = chunkText(longText, 120, 20);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.length).toBeLessThanOrEqual(130);
  });

  it('searchKnowledgeInMemory 能从用户导入资料与内置知识库中召回高相关片段', () => {
    const docs: KnowledgeDoc[] = [
      {
        id: 'kb-1',
        scope: 'proj-1',
        title: '黑洞科普资料',
        content: '事件视界是黑洞的临界边界，一旦光子越过史瓦西半径，逃逸速度超过光速，任何信息都无法传出。',
        sourceType: 'file',
        createdAt: '2026-11-24T00:00:00.000Z',
      },
      {
        id: 'kb-2',
        scope: 'proj-1',
        title: '唐朝服饰考据',
        content: '盛唐女子流行齐胸襦裙与披帛，色彩以石榴红、青绿为主。',
        sourceType: 'web',
        sourceUrl: 'https://example.com/tang-costume',
        createdAt: '2026-11-24T00:00:01.000Z',
      },
    ];

    const hits = searchKnowledgeInMemory('史瓦西半径 黑洞 光速', docs, { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toContain('黑洞科普资料');

    const promptBlock = formatRagHitsForPrompt(hits);
    expect(promptBlock).toContain('本地资料库参考');
    expect(promptBlock).toContain('史瓦西半径');
  });

  it('parseBingHtml 与 parseDuckDuckGoHtml 正确解析搜索结果与域名', () => {
    const bingHtml = `
      <ul>
        <li class="b_algo">
          <h2><a href="https://zh.wikipedia.org/wiki/Black_hole">黑洞 - 维基百科</a></h2>
          <p>黑洞是时空展现出极强引力的区域。</p>
        </li>
      </ul>
    `;
    const bing = parseBingHtml(bingHtml, 5);
    expect(bing).toHaveLength(1);
    expect(bing[0]!.domain).toBe('zh.wikipedia.org');
    expect(bing[0]!.title).toContain('黑洞');

    const ddgHtml = `
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fnasa.gov%2Fblack-holes">NASA Black Holes</a>
      <a class="result__snippet">Learn how black holes form and evolve.</a>
    `;
    const ddg = parseDuckDuckGoHtml(ddgHtml, 5);
    expect(ddg).toHaveLength(1);
    expect(ddg[0]!.url).toBe('https://nasa.gov/black-holes');
    expect(formatWebResultsForPrompt(ddg)).toContain('NASA Black Holes');
  });

  it('extractArticleFromHtml 使用 Readability 提取干净正文并去除脚本噪声', () => {
    const html = `<!doctype html>
      <html>
        <head><title>黑洞原理解析</title></head>
        <body>
          <nav>导航栏 首页 登录 注册</nav>
          <article>
            <h1>黑洞原理解析</h1>
            <p>当大质量恒星燃料耗尽发生引力坍缩时，核心物质被压缩到史瓦西半径以内，便形成了黑洞。</p>
            <p>黑洞周围存在吸积盘，高速旋转的气体会发出耀眼的 X 射线，这也是天文学家观测黑洞的重要线索。</p>
          </article>
          <script>window.__tracking = true;</script>
        </body>
      </html>`;
    const article = extractArticleFromHtml(html, 'https://science.example.com/black-hole');
    expect(article.ok).toBe(true);
    expect(article.title).toContain('黑洞原理解析');
    expect(article.textContent).toContain('史瓦西半径');
    expect(article.textContent).not.toContain('__tracking');
  });
});
