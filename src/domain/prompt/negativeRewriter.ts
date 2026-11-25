import type { VideoModelDialect } from '../../data/models/videoDialects';
import type { VideoMode } from '../../types/model';

/**
 * 负向提示词策略分流与正向改写器（Phase 1）
 *
 * 三种策略完全由 VideoModelDialect.negativePolicy 驱动：
 * - native_field：输出独立 negativePrompt，过滤与正文冲突的词，并按 negativeMaxChars（如 Wan 500 字符）优雅截断；
 * - positive_rewrite（Runway Gen-4/4.5、Veo 3.1、Hailuo、Sora 2）：
 *   绝不直接丢弃用户排除意图，也不在正向词中残留 "no ..." 否定句式，
 *   而是通过确定性映射表把高频排除意图转译为正向视觉状态并入主提示词；
 * - drop：自定义端点不支持负向词时安全清空。
 */

interface PositiveRewriteRule {
  pattern: RegExp;
  positive: string;
  scenicPositive?: string;
}

const POSITIVE_REWRITE_RULES: readonly PositiveRewriteRule[] = [
  {
    pattern: /no\s+camera\s+movement|camera\s+shake|shaky\s+camera|不要运镜|不要晃动|防抖/i,
    positive: 'locked-off static camera',
  },
  {
    pattern:
      /no\s+(?:extra\s+)?(?:people|humans?|persons?|crowd)|people|humans?|crowd|不要(?:多余)?(?:路人|人物|角色)/i,
    positive: 'single subject alone in frame',
    scenicPositive: 'uninhabited untouched natural landscape',
  },
  {
    pattern: /no\s+subtitles?|subtitles?|captions?|不要字幕|乱码字幕/i,
    positive: 'clean frame with zero on-screen captions',
  },
  {
    pattern: /no\s+text|text|watermark|logo|不要文字|不要水印/i,
    positive: 'clean unbranded visual frame',
  },
  {
    pattern: /blurry|blur|out\s+of\s+focus|low\s+quality|模糊/i,
    positive: 'sharp crisp focus and clear textures',
  },
  {
    pattern: /distorted\s+face|extra\s+fingers|deformed|畸形|脸崩/i,
    positive: 'consistent natural proportions and steady facial features',
  },
];

const INLINE_NEGATIVE_CLAUSE_RE =
  /,?\s*\b(?:no\s+(?:camera\s+movement|extra\s+people|people|humans?|persons?|crowd|text|watermark|subtitles?|characters?)|without\s+(?:people|humans?|text|watermark))\b/gi;

export interface NegativeRewriteResult {
  positivePrompt: string;
  negativePrompt: string;
  rewrittenToPositive: string[];
  truncated: boolean;
}

function truncateCommaList(items: string[], maxChars: number): { text: string; truncated: boolean } {
  const out: string[] = [];
  let len = 0;
  let truncated = false;
  for (const item of items) {
    const addLen = out.length === 0 ? item.length : item.length + 2;
    if (len + addLen > maxChars) {
      truncated = true;
      break;
    }
    out.push(item);
    len += addLen;
  }
  return { text: out.join(', '), truncated };
}

function dedupeAndFilterConflicts(rawNegative: string, positivePrompt: string): string[] {
  const lowerPositive = positivePrompt.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of rawNegative.split(/[,，\n;；]+/)) {
    const term = part.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    // 若正向提示词里明确要求了某个词，过滤掉同名负向词防止冲突
    if (
      /^[a-z0-9\s-]+$/i.test(term) &&
      new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lowerPositive)
    ) {
      continue;
    }
    seen.add(key);
    out.push(term);
  }
  return out;
}

export function processNegativePrompt(args: {
  dialect: VideoModelDialect;
  positivePrompt: string;
  rawNegativePrompt?: string;
  videoMode?: VideoMode;
}): NegativeRewriteResult {
  const { dialect, videoMode } = args;
  const rawNeg = (args.rawNegativePrompt ?? '').trim();

  if (dialect.negativePolicy === 'drop') {
    return {
      positivePrompt: args.positivePrompt.trim(),
      negativePrompt: '',
      rewrittenToPositive: [],
      truncated: false,
    };
  }

  if (dialect.negativePolicy === 'native_field') {
    const terms = dedupeAndFilterConflicts(rawNeg, args.positivePrompt);
    const maxChars = dialect.negativeMaxChars ?? 500;
    const { text, truncated } = truncateCommaList(terms, maxChars);
    return {
      positivePrompt: args.positivePrompt.trim(),
      negativePrompt: text,
      rewrittenToPositive: [],
      truncated,
    };
  }

  // positive_rewrite：剥离正文里的否定句式，并将核心排除意图转译为正向视觉状态
  const combinedSource = `${args.positivePrompt}\n${rawNeg}`;
  const cleanedPositive = args.positivePrompt
    .replace(INLINE_NEGATIVE_CLAUSE_RE, '')
    .replace(/\s*,\s*,+/g, ', ')
    .replace(/^,\s*|,\s*$/g, '')
    .trim();

  const rewritten: string[] = [];
  const lowerCleaned = cleanedPositive.toLowerCase();

  for (const rule of POSITIVE_REWRITE_RULES) {
    if (!rule.pattern.test(combinedSource)) continue;
    const target =
      videoMode === 'scenic' && rule.scenicPositive ? rule.scenicPositive : rule.positive;
    if (!lowerCleaned.includes(target.toLowerCase()) && !rewritten.includes(target)) {
      rewritten.push(target);
    }
  }

  const finalPositive = [cleanedPositive, ...rewritten].filter(Boolean).join(', ');
  return {
    positivePrompt: finalPositive,
    negativePrompt: '',
    rewrittenToPositive: rewritten,
    truncated: false,
  };
}
