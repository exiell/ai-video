import { z } from 'zod';
import {
  extractJsonObject,
  parseModelJson,
  repairShape,
  type SchemaHint,
} from './robustJson';

/**
 * 生成结果的校验模型（方案.md v0.6 §3.2 M2：「生成质量兜底」）
 *
 * 为什么必须校验：LLM 的输出是概率性的。它会漏字段、会自己改字段名、
 * 会在 JSON 外面套一层解释文字。不校验的后果是新手看到一片空白或者一份错乱的分镜表，
 * 然后得出结论「这工具没用」。
 *
 * 这里的做法是：解析失败 → 自动重试一次 → 仍失败则降级为「半自动填空」并如实告知。
 * **不允许出现空表。**
 */

/** 只剥围栏，不做括号扫描（括号扫描在 robustJson 里） */
function superStripFence(text: string): string {
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text.trim());
  return fenced?.[1] !== undefined ? fenced[1].trim() : text.trim();
}

/**
 * 从模型输出里剥离代码块围栏与前后解释文字。
 *
 * 实现在 robustJson.ts。这里保留这个名字是为了不破坏既有调用点。
 * 注意旧实现用的是「第一个 { 到最后一个 }」，当模型在 JSON 后面
 * 又写了一段带花括号的解释时，这个做法会切出非法 JSON——
 * 这正是「格式错误」的一个真实成因，已改为括号配平扫描。
 */
export function stripCodeFence(raw: string): string {
  return extractJsonObject(superStripFence(raw)) ?? superStripFence(raw);
}

// ---------------------------------------------------------------------------

export const storySchema = z.object({
  body: z.string().min(1),
  charactersNote: z.string().default(''),
  setting: z.string().default(''),
  conflict: z.string().default(''),
  ending: z.string().default(''),
  scenes: z
    .array(
      z.object({
        label: z.string().min(1),
        summary: z.string().default(''),
      }),
    )
    .default([]),
});

export type GeneratedStory = z.infer<typeof storySchema>;

// ---------------------------------------------------------------------------

const slug = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, 'slug 只能是字母、数字和连字符');

const continuityLockSchema = z.object({
  label: z.string().min(1),
  phrase: z.string().min(1),
  appliesTo: z.enum(['look', 'geography', 'lighting', 'prop', 'composition']).default('look'),
});

export const assetsSchema = z.object({
  characters: z
    .array(
      z.object({
        slug,
        name: z.string().min(1),
        role: z.enum(['protagonist', 'antagonist', 'supporting', 'cameo']).default('supporting'),
        identity: z.object({
          face: z.string().default(''),
          hair: z.string().default(''),
          bodyType: z.string().default(''),
          ageRange: z.string().default(''),
          summary: z.string().default(''),
          summaryEn: z.string().min(1),
        }),
        continuityLocks: z.array(continuityLockSchema).default([]),
        variants: z
          .array(
            z.object({
              label: z.string().min(1),
              changedFeatures: z.array(z.string()).default([]),
            }),
          )
          .default([]),
        negativePrompt: z.string().optional(),
      }),
    )
    .default([]),
  scenes: z
    .array(
      z.object({
        slug,
        name: z.string().min(1),
        identity: z.object({
          placeType: z.string().default(''),
          spatialStructure: z.string().default(''),
          summary: z.string().default(''),
          summaryEn: z.string().min(1),
        }),
        fixedElements: z.array(z.string()).default([]),
        lightDirection: z.string().default(''),
        mainColor: z.string().default(''),
        timeOfDay: z.string().optional(),
        weather: z.string().optional(),
        continuityLocks: z.array(continuityLockSchema).default([]),
      }),
    )
    .default([]),
});

export type GeneratedAssets = z.infer<typeof assetsSchema>;

// ---------------------------------------------------------------------------

export const shotSizeEnum = z.enum([
  'extreme-wide',
  'wide',
  'full',
  'medium',
  'close-up',
  'extreme-close-up',
]);

export const cameraMoveEnum = z.enum([
  'static',
  'push-in',
  'pull-out',
  'pan-left',
  'pan-right',
  'tilt-up',
  'tilt-down',
  'orbit',
  'tracking',
  'crane-up',
  'crane-down',
  'handheld',
]);

export const shotsSchema = z.object({
  shots: z
    .array(
      z.object({
        duration: z.coerce.number().positive().max(60),
        shotSize: shotSizeEnum,
        cameraPosition: z.string().default(''),
        cameraMove: cameraMoveEnum,
        startState: z.string().min(1),
        action: z.string().min(1),
        endState: z.string().min(1),
        dialogue: z.string().default(''),
        sound: z.string().default(''),
        mood: z.string().default(''),
        transition: z.string().default('硬切'),
        /**
         * 与下一个镜头的衔接说明。
         *
         * **必须是 optional 而不是 default('')**：模型不写这个字段是完全正常的，
         * 用 default 会把它变成「必填项」，导致模型漏写时整条分镜解析失败。
         * 这也影响类型：带 default 的字段在 z.infer 里是必填的。
         */
        continuityNote: z.string().optional(),
        /**
         * 与上一个镜头的转场类型。模型给默认值，用户可以改。
         * optional：模型漏写时由衔接说明推断，不该因此让整条分镜解析失败。
         */
        transitionType: z.enum(['continuation', 'cut']).optional(),
        sceneSlug: slug,
        characterSlugs: z.array(slug).default([]),
        activeLockLabels: z.array(z.string()).default([]),
        activeVariantLabels: z.array(z.string()).default([]),
        offscreenCharacters: z.array(z.string()).default([]),
        sourceSceneIndex: z.coerce.number().int().min(0).default(0),
      }),
    )
    .min(1),
});

export type GeneratedShots = z.infer<typeof shotsSchema>;
export type GeneratedShot = GeneratedShots['shots'][number];

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export interface ParseOutcome<T> {
  ok: boolean;
  data?: T;
  /** 给用户看的失败原因（人话） */
  error?: string;
  /** 给开发者看的细节，收在折叠区 */
  detail?: string;
  /**
   * 模型返回的**原始内容**。
   *
   * 为什么要把它带出来：只告诉用户「结构不对」等于没说——
   * 他既不知道模型错在哪，也没法把情况描述给开发者。
   * 把原文摆出来，问题一眼就能定位。这是血的教训换来的。
   */
  raw?: string;
}

/** 把模型的原始输出解析成故事 */
export function parseStory(raw: string): ParseOutcome<GeneratedStory> {
  return parseWith(storySchema, raw, '故事', 'story');
}

/** 把模型的原始输出解析成角色与场景 */
export function parseAssets(raw: string): ParseOutcome<GeneratedAssets> {
  return parseWith(assetsSchema, raw, '角色与场景', 'assets');
}

// ---------------------------------------------------------------------------
// 风格关键词（v0.41）
// ---------------------------------------------------------------------------

/**
 * 从中文「风格倾向」推出来的英文关键词。
 *
 * 为什么单独一个生成任务：`styleTone` 是作者用中文写的备忘（「水墨写意 + 冷色调」），
 * 它**不进提示词**——出图模型对英文更稳。真正进提示词的是 `styleTags`。
 * 但新手写不出英文风格词，于是「风格倾向」写了一堆、实际生成时风格词还是空的。
 * 这个任务就是把前者翻译并展开成后者。
 *
 * 数量和长度都要卡住：
 *  - 少于 3 条通常不够描述一种风格
 *  - 多于 10 条会挤占提示词里真正描述画面的空间（模型对提示词前段权重更高）
 *  - 单条过长会变成一句话，而提示词里要的是短语
 */
export const styleTagsSchema = z.object({
  tags: z.array(z.string().min(1).max(120)).min(1).max(16),
});

export type GeneratedStyleTags = z.infer<typeof styleTagsSchema>;

/** 把模型的原始输出解析成风格关键词 */
export function parseStyleTags(raw: string): ParseOutcome<GeneratedStyleTags> {
  const outcome = parseWith(styleTagsSchema, raw, '风格关键词');
  if (!outcome.ok || !outcome.data) return outcome;
  return { ...outcome, data: { tags: sanitizeStyleTags(outcome.data.tags) } };
}

/**
 * 清洗风格关键词。
 *
 * 模型常见的几种毛病，都在这里收掉而不是让它进提示词：
 *  - 带引号或句号（`"anime style"`、`cel shading.`）→ 去掉，提示词里是短语列表
 *  - 一整句（`the style is a blend of ink wash and cel shading`）→ 太长的不收
 *  - 重复 → 去掉。重复不是强调，是给模型两个略有不同的版本
 */
export function sanitizeStyleTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const cleaned = raw
      .replace(/^[\s"'“”‘’「」]+|[\s"'“”‘’「」，,。.;；]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length === 0) continue;
    // 超过 8 个词基本就是一句话了，不是风格短语
    if (cleaned.split(' ').length > 8) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 10) break;
  }
  return out;
}

/** 把模型的原始输出解析成分镜 */
export function parseShots(raw: string): ParseOutcome<GeneratedShots> {
  return parseWith(shotsSchema, raw, '分镜', 'shots');
}

function parseWith<T extends z.ZodTypeAny>(
  schema: T,
  raw: string,
  what: string,
  hint?: SchemaHint,
): ParseOutcome<z.infer<T>> {
  if (!raw || raw.trim().length === 0) {
    return {
      ok: false,
      error: `模型没有返回任何内容（${what}）。`,
      detail:
        '模型返回空字符串。最常见的原因是输出被长度上限截断，或模型在 JSON 模式下抽风。' +
        '可以去设置页换一个模型，或把要求写短一些。',
      raw,
    };
  }

  const extracted = parseModelJson(raw);
  if (extracted.value === undefined) {
    // 两种失败的成因不同，给用户的下一步也不同，所以文案必须区分开：
    //  · no-object   → 模型压根没用 JSON，得催它按格式回答
    //  · invalid-json → 输出里有 JSON 但残缺，多半是被长度上限截断了
    if (extracted.error === 'no-object') {
      return {
        ok: false,
        error: `模型没有按 JSON 格式回答（${what}）——它返回的内容里找不到 JSON 对象。`,
        detail: '模型可能直接用自然语言回答了，而不是按要求输出 JSON。再点一次生成通常能好；反复如此就换一个模型。',
        raw,
      };
    }
    return {
      ok: false,
      error: `模型返回的内容不是合法 JSON，无法解析成${what}（通常是输出被长度上限截断）。`,
      detail:
        '输出里有 JSON 的开头，但残缺不全。常见原因是模型输出超出长度上限被截断。' +
        '可以在设置页换一个上下文更长的模型，或把故事要求写短一些。',
      raw,
    };
  }

  // 先按原样校验；不通过再修一次形状。
  // 这样「本来就对」的输出不会被修理逻辑碰过，避免引入新问题。
  const direct = schema.safeParse(extracted.value);
  if (direct.success) {
    return { ok: true, data: direct.data as z.infer<T> };
  }

  const repaired = schema.safeParse(repairShape(extracted.value, hint));
  if (repaired.success) {
    return {
      ok: true,
      data: repaired.data as z.infer<T>,
      detail: `抽取策略：${extracted.usedStrategy}；结构经自动修理后通过校验。`,
      raw,
    };
  }

  const issues = repaired.error.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(根)'}：${i.message}`)
    .join('；');
  return {
    ok: false,
    error: `模型返回的${what}结构不对：${issues}`,
    detail: [
      `抽取策略：${extracted.usedStrategy}`,
      `原样校验的问题：${direct.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(根)'}：${i.message}`)
        .join('；')}`,
    ].join('\n'),
    raw,
  };
}
