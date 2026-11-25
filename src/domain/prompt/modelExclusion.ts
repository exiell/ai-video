import type { HumanExclusionMode, TargetPlatform } from '../../types/model';

/**
 * 视频模型能力声明表与模型感知去人化适配器（Phase 4）
 *
 * 不同视频生成模型对负向提示词的语法机制存在本质差异：
 * - Kling / Wan / Seedance / Veo / Pika / Hailuo / Jimeng：支持原生独立 negative_prompt 字段
 * - Runway Gen-4 / Sora：不支持否定句式，正向写 "no people" 反而可能适得其反地召唤人物，
 *   必须剥离否定句并改为正向肯定式无人表述。
 */

export interface VideoModelCapabilitySpec {
  platform: TargetPlatform;
  supportsNativeNegativePrompt: boolean;
  supportsFirstLastFrame: boolean;
  maxReferenceImages: number;
  supportsNativeAudio: boolean;
}

export const VIDEO_MODEL_CAPABILITIES: Record<TargetPlatform, VideoModelCapabilitySpec> = {
  wan: {
    platform: 'wan',
    supportsNativeNegativePrompt: true,
    supportsFirstLastFrame: true,
    maxReferenceImages: 4,
    supportsNativeAudio: true,
  },
  kling: {
    platform: 'kling',
    supportsNativeNegativePrompt: true,
    supportsFirstLastFrame: true,
    maxReferenceImages: 9,
    supportsNativeAudio: true,
  },
  seedance: {
    platform: 'seedance',
    supportsNativeNegativePrompt: true,
    supportsFirstLastFrame: true,
    maxReferenceImages: 30,
    supportsNativeAudio: true,
  },
  veo: {
    platform: 'veo',
    supportsNativeNegativePrompt: false,
    supportsFirstLastFrame: true,
    maxReferenceImages: 3,
    supportsNativeAudio: true,
  },
  pika: {
    platform: 'pika',
    supportsNativeNegativePrompt: true,
    supportsFirstLastFrame: false,
    maxReferenceImages: 3,
    supportsNativeAudio: false,
  },
  hailuo: {
    platform: 'hailuo',
    supportsNativeNegativePrompt: true,
    supportsFirstLastFrame: true,
    maxReferenceImages: 3,
    supportsNativeAudio: false,
  },
  jimeng: {
    platform: 'jimeng',
    supportsNativeNegativePrompt: true,
    supportsFirstLastFrame: true,
    maxReferenceImages: 4,
    supportsNativeAudio: false,
  },
  runway: {
    platform: 'runway',
    supportsNativeNegativePrompt: false,
    supportsFirstLastFrame: false,
    maxReferenceImages: 3,
    supportsNativeAudio: false,
  },
  sora: {
    platform: 'sora',
    supportsNativeNegativePrompt: false,
    supportsFirstLastFrame: false,
    maxReferenceImages: 1,
    supportsNativeAudio: true,
  },
};

const STRICT_DEHUMANIZE_NEGATIVE_TERMS = [
  'people',
  'humans',
  'person',
  'figure',
  'crowd',
  'portrait',
  'face',
  'text',
  'watermark',
] as const;

const POSITIVE_UNINHABITED_PHRASE =
  'uninhabited untouched natural landscape, pure natural environment';

const NEGATIVE_PHRASE_IN_POSITIVE_RE =
  /,?\s*\b(?:no\s+people|no\s+humans?|no\s+persons?|no\s+crowd|no\s+characters?|without\s+(?:people|humans?|persons?))\b/gi;

export interface ExclusionAdaptResult {
  positivePrompt: string;
  negativePrompt: string;
  usedStrategy: 'native_negative' | 'positive_rephrase' | 'passthrough';
}

/** 过滤与正向提示词直接冲突的负向词项，避免引导信号互相抵消 */
function filterConflictingNegatives(terms: readonly string[], positivePrompt: string): string[] {
  const lower = positivePrompt.toLowerCase();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    // 若正向提示词中明确要求了该词（例如正向写 "dramatic shadow"，负向就不应保留 "shadow"）
    if (new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)) {
      continue;
    }
    seen.add(key);
    result.push(term);
  }
  return result;
}

export const ModelExclusionAdapter = {
  getCapability(platform: TargetPlatform): VideoModelCapabilitySpec {
    return VIDEO_MODEL_CAPABILITIES[platform];
  },

  adapt(args: {
    platform: TargetPlatform;
    positivePrompt: string;
    baseNegativePrompt?: string;
    exclusionMode: HumanExclusionMode;
  }): ExclusionAdaptResult {
    const cap = VIDEO_MODEL_CAPABILITIES[args.platform];
    const baseNeg = (args.baseNegativePrompt ?? '').trim();

    if (args.exclusionMode === 'none') {
      return {
        positivePrompt: args.positivePrompt,
        negativePrompt: cap.supportsNativeNegativePrompt ? baseNeg : '',
        usedStrategy: 'passthrough',
      };
    }

    if (args.exclusionMode === 'strict_dehumanize') {
      // 不管是否支持负向词，都先剥离正向提示词里容易反向召唤人物的否定句式
      const cleanedPositive = args.positivePrompt
        .replace(NEGATIVE_PHRASE_IN_POSITIVE_RE, '')
        .replace(/\s*,\s*,+/g, ', ')
        .replace(/^,\s*|,\s*$/g, '')
        .trim();

      if (cap.supportsNativeNegativePrompt) {
        const mergedNeg = filterConflictingNegatives(
          [...STRICT_DEHUMANIZE_NEGATIVE_TERMS, ...baseNeg.split(',')],
          cleanedPositive,
        );
        return {
          positivePrompt: cleanedPositive,
          negativePrompt: mergedNeg.join(', '),
          usedStrategy: 'native_negative',
        };
      }

      const positiveWithLandscape = cleanedPositive.toLowerCase().includes('uninhabited')
        ? cleanedPositive
        : [cleanedPositive, POSITIVE_UNINHABITED_PHRASE].filter(Boolean).join(', ');
      return {
        positivePrompt: positiveWithLandscape,
        negativePrompt: '',
        usedStrategy: 'positive_rephrase',
      };
    }

    // subject_driven（科普模式）：保留核心清晰度负向词，不强行写入写实人像词
    const cleaned = args.positivePrompt.trim();
    if (!cap.supportsNativeNegativePrompt) {
      return {
        positivePrompt: cleaned.replace(NEGATIVE_PHRASE_IN_POSITIVE_RE, '').trim(),
        negativePrompt: '',
        usedStrategy: 'positive_rephrase',
      };
    }
    const safeNeg = filterConflictingNegatives(
      ['photorealistic', 'blurry text', 'watermark', ...baseNeg.split(',')],
      cleaned,
    );
    return {
      positivePrompt: cleaned,
      negativePrompt: safeNeg.join(', '),
      usedStrategy: 'native_negative',
    };
  },
};

/**
 * 科普教学提示词安全词中性化清洗：
 * 降低部分图像/视频模型对无害科普词汇（如 children / kids）的误杀率。
 */
const EXPLAINER_SAFETY_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/\bchildren\b/gi, 'students'],
  [/\bchild\b/gi, 'student'],
  [/\bkids?\b/gi, 'learners'],
  [/\blittle\s+(?:boy|girl)\b/gi, 'young learner'],
  [/\btoddlers?\b/gi, 'young learners'],
];

export function sanitizeExplainerSafetyTerms(prompt: string): string {
  let out = prompt;
  for (const [pattern, replacement] of EXPLAINER_SAFETY_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * 顺序接力抽帧安全偏移计算：
 * 避免取到视频模型字面最后一帧（常出现发糊/变暗/冻结），向前偏移约 0.2s（或 4 帧）。
 */
export function computeTailFrameOffsetSec(durationSec: number, fps = 24): number {
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 5;
  const offset = Math.max(0.2, 4 / Math.max(1, fps));
  return Number(Math.max(0, safeDuration - offset).toFixed(2));
}
