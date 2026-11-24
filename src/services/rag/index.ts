import MiniSearch from 'minisearch';
import { TERMS } from '../../domain/help/terms';
import { STYLE_PRESETS } from '../../domain/help/stylePresets';
import { listKnowledgeDocs, type KnowledgeDoc } from '../storage';

/**
 * 本地零后端中文 RAG 检索引擎（Batch 2）
 *
 * 采用成熟轻量库 MiniSearch（BM25 相关性打分）+ 浏览器原生 Intl.Segmenter 中文分词，
 * 零词典体积、纯离线毫秒级召回：
 *  1. 内置创作知识（43 条分镜术语 + 画风预设）；
 *  2. 用户导入的 .txt/.md 资料、手写笔记与一键收入的网页正文（按段落切块索引）。
 */

export interface RagChunk {
  id: string;
  title: string;
  content: string;
  sourceLabel: string;
  sourceUrl?: string;
}

export interface RagHit {
  id: string;
  title: string;
  snippet: string;
  sourceLabel: string;
  sourceUrl?: string;
  score: number;
}

const STOP_WORDS = new Set([
  '的',
  '了',
  '是',
  '在',
  '我',
  '有',
  '和',
  '就',
  '不',
  '人',
  '都',
  '一',
  '一个',
  '上',
  '也',
  '很',
  '到',
  '说',
  '要',
  '去',
  '你',
  '会',
  '着',
  '没有',
  '看',
  '好',
  '自己',
  '这',
  '想',
  '做',
  '帮',
  '请',
  '什么',
  '怎么',
  '如何',
  '可以',
  '一下',
]);

let cachedSegmenter: Intl.Segmenter | null | undefined;
function getZhSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      cachedSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
      return cachedSegmenter;
    }
  } catch {
    // 极旧环境回退
  }
  cachedSegmenter = null;
  return null;
}

/** 中英文混合分词：优先 Intl.Segmenter，同时为中文长词补 2-gram 提升召回率 */
export function tokenizeText(text: string): string[] {
  const normalized = text.toLowerCase().trim();
  if (!normalized) return [];

  const tokens = new Set<string>();
  const seg = getZhSegmenter();
  if (seg) {
    for (const part of seg.segment(normalized)) {
      if (!part.isWordLike) continue;
      const w = part.segment.trim();
      if (!w || STOP_WORDS.has(w)) continue;
      tokens.add(w);
    }
  } else {
    const words = normalized.split(/[\s,.;:!?，。；：！？、()（）「」【】"'\-\/]+/);
    for (const w of words) {
      if (!w || STOP_WORDS.has(w)) continue;
      tokens.add(w);
    }
  }
  // 对连续中文片段补充 2-gram，解决专业术语（如「事件视界」「史瓦西半径」）被拆成单字的问题
  const cjkRuns = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i += 1) {
      const bi = run.slice(i, i + 2);
      if (!STOP_WORDS.has(bi)) tokens.add(bi);
    }
  }
  return [...tokens];
}

/** 将长文本按段落切分为 ~450 字的检索块，保留约 60 字上下文重叠 */
export function chunkText(text: string, maxChars = 450, overlap = 60): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const paragraphs = clean
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buffer = '';

  const flush = () => {
    if (buffer.trim()) {
      chunks.push(buffer.trim());
    }
    buffer = '';
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      flush();
      for (let start = 0; start < para.length; start += Math.max(1, maxChars - overlap)) {
        chunks.push(para.slice(start, start + maxChars).trim());
        if (start + maxChars >= para.length) break;
      }
      continue;
    }
    if ((buffer + '\n\n' + para).length > maxChars) {
      const tail = buffer.slice(-overlap);
      flush();
      buffer = tail ? `${tail}\n${para}` : para;
    } else {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
    }
  }
  flush();
  return chunks;
}

/** 构建内置创作知识块（分镜术语 + 画风预设） */
function buildBuiltinChunks(): RagChunk[] {
  const termChunks: RagChunk[] = TERMS.map((t, idx) => ({
    id: `builtin:term:${idx}`,
    title: `${t.zh}（${t.en}）`,
    content: `${t.summary} 适用时机：${t.whenToUse}${t.example ? ` 示例：${t.example}` : ''}`,
    sourceLabel: '内置分镜术语',
  }));

  const styleChunks: RagChunk[] = STYLE_PRESETS.map((s) => ({
    id: `builtin:style:${s.id}`,
    title: `画风预设 · ${s.label}`,
    content: `${s.description} 风格词：${s.tags.join(', ')}`,
    sourceLabel: '内置画风预设',
  }));

  return [...termChunks, ...styleChunks];
}

function buildUserDocChunks(docs: KnowledgeDoc[]): RagChunk[] {
  const chunks: RagChunk[] = [];
  for (const doc of docs) {
    const parts = chunkText(doc.content);
    const sourceLabel =
      doc.sourceType === 'web'
        ? '已收藏网页'
        : doc.sourceType === 'file'
          ? '导入资料'
          : '创作笔记';
    parts.forEach((part, idx) => {
      chunks.push({
        id: `doc:${doc.id}:${idx}`,
        title: parts.length > 1 ? `${doc.title}（片段 ${idx + 1}）` : doc.title,
        content: part,
        sourceLabel,
        ...(doc.sourceUrl ? { sourceUrl: doc.sourceUrl } : {}),
      });
    });
  }
  return chunks;
}

/** 纯内存检索函数（便于单测与直接复用） */
export function searchKnowledgeInMemory(
  query: string,
  docs: KnowledgeDoc[],
  options: { limit?: number; includeBuiltin?: boolean } = {},
): RagHit[] {
  const q = query.trim();
  if (!q) return [];
  const limit = options.limit ?? 4;
  const includeBuiltin = options.includeBuiltin !== false;

  const chunks = [
    ...buildUserDocChunks(docs),
    ...(includeBuiltin ? buildBuiltinChunks() : []),
  ];
  if (chunks.length === 0) return [];

  const index = new MiniSearch<RagChunk>({
    fields: ['title', 'content'],
    storeFields: ['title', 'content', 'sourceLabel', 'sourceUrl'],
    tokenize: tokenizeText,
    searchOptions: {
      boost: { title: 2 },
      prefix: true,
      combineWith: 'OR',
    },
  });
  index.addAll(chunks);

  const rawHits = index.search(q).slice(0, limit);
  return rawHits.map((hit) => {
    const content = typeof hit['content'] === 'string' ? hit['content'] : '';
    const title = typeof hit['title'] === 'string' ? hit['title'] : '';
    const sourceLabel = typeof hit['sourceLabel'] === 'string' ? hit['sourceLabel'] : '资料库';
    const sourceUrl = typeof hit['sourceUrl'] === 'string' ? hit['sourceUrl'] : undefined;
    return {
      id: String(hit.id),
      title,
      snippet: content.slice(0, 380),
      sourceLabel,
      ...(sourceUrl ? { sourceUrl } : {}),
      score: hit.score,
    };
  });
}

/** 从 Dexie 资料库 + 内置创作知识中召回最相关的 Top-K 片段 */
export async function searchKnowledge(
  query: string,
  projectId?: string,
  limit = 4,
): Promise<RagHit[]> {
  const docs = await listKnowledgeDocs(projectId);
  return searchKnowledgeInMemory(query, docs, { limit, includeBuiltin: true });
}

/** 将召回片段格式化为注入 LLM 提示词的参考块 */
export function formatRagHitsForPrompt(hits: RagHit[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map(
    (h, idx) =>
      `[资${idx + 1}] ${h.title}（来源：${h.sourceLabel}${h.sourceUrl ? ` · ${h.sourceUrl}` : ''}）\n${h.snippet}`,
  );
  return `本地资料库参考（RAG 召回，请优先结合这些准确事实作答）：\n${lines.join('\n\n')}`;
}
