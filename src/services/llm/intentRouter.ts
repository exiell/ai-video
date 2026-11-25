import { z } from 'zod';
import type { IntentRouteResult, VideoMode } from '../../domain/pipeline/profiles';
import type { GenerateContext } from './generate';
import { callStructuredLLM } from './structuredClient';

/**
 * 前置意图路由器（Phase 2 · 第一层防呆）
 *
 * 在进入脚本生成和资产提取前，将用户创作需求固化为强类型状态锁：
 * { mode, enableVirtualHost, confidence, reasoning, detectedStyleHint }
 */

export const INTENT_ROUTER_SYSTEM_PROMPT = `你是视频生产管线的意图路由分类器。根据用户的创作需求，将项目精准分类到以下三种模式之一，并严格返回 JSON（禁止输出多余解释）：

- "narrative"（叙事剧情模式）：包含明确的人物/拟人化角色互动、剧情冲突、角色对白或连续人物表演（如短剧、微电影、故事动画）。
- "scenic"（自然风光/无角色模式）：核心展示自然景观、气象变化、微观生态、城市空镜、建筑空间或纯氛围画面；用户明确表示「不要角色/不要人物」，或主题本身没有人类/拟人化主角。
- "explainer"（科普解说/知识模式）：核心目的是解释概念、科学原理、历史脉络、财经数据、技术流程或产品逻辑；画面由抽象视觉隐喻、信息图表、符号母题和连续旁白驱动，不依赖固定物理剧情场景。

硬性判定规则：
- 若用户提及自然要素（如水滴、光线、岩石、云雾、河流、山峰、树木）作为画面展示对象，除非用户明确要求「把水滴拟人化成一个会说话的小精灵角色」，否则一律判定为 "scenic"，绝不能当作 "narrative"。
- 在 "explainer" 模式下，除非用户主动要求「需要一个虚拟主持人/吉祥物/卡通讲解员」，否则 enableVirtualHost 必须为 false。

返回 JSON 字段：
{
  "mode": "narrative | scenic | explainer",
  "enableVirtualHost": false,
  "confidence": 0.9,
  "reasoning": "一句话说明判定理由",
  "detectedStyleHint": "可选的风格提示，没有则为 null"
}`;

/** 跨厂商最大公约数 JSON Schema：顶层 object、无顶层 anyOf、无数值边界、显式 additionalProperties: false */
export const INTENT_ROUTE_WIRE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'enableVirtualHost', 'confidence', 'reasoning', 'detectedStyleHint'],
  properties: {
    mode: { type: 'string', enum: ['narrative', 'scenic', 'explainer'] },
    enableVirtualHost: { type: 'boolean' },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
    detectedStyleHint: { type: ['string', 'null'] },
  },
};

export const intentRouteZodSchema = z.object({
  mode: z.enum(['narrative', 'scenic', 'explainer']),
  enableVirtualHost: z.boolean().default(false),
  confidence: z.coerce.number().default(0.8),
  reasoning: z.string().default(''),
  detectedStyleHint: z.string().nullable().default(null),
});

const EXPLICIT_NO_CHARACTER_RE =
  /不要(?:任何)?(?:角色|人物|人像|主角)|无角色|不要出现人|无人(?:荒野|风景|空镜)|no\s+(?:people|characters|humans)/i;

const EXPLICIT_PERSONIFICATION_RE =
  /拟人化|会说话的(?:水滴|石头|云|树|猫|花)|小精灵角色|变成一个(?:小)?(?:精灵|角色)/i;

const EXPLICIT_HOST_RE =
  /虚拟(?:主持人|讲解员|主播|助手)|吉祥物|卡通讲解员|小鸭子(?:讲解|主持)|virtual\s+host|mascot/i;

const EXPLAINER_SIGNAL_RE =
  /科普|原理|为什么|如何工作|机制|解说|教学|知识|教程|财报|数据对比|历史脉络|量子|黑洞|神经网络|通胀|算法|公式|DNA|免疫|相对论|超光速|explainer|how\s+does|why\s+does/i;

const SCENIC_SIGNAL_RE =
  /风景|风光|自然纪录片|山谷|阿尔卑斯|雪山|森林|溪流|瀑布|日出|日落|晨雾|薄雾|露珠|水滴|松针|青苔|岩石|云海|星空|海洋|海岸|极光|延时摄影|空镜|建筑空间|微距生态|landscape|scenic|nature\s+documentary|timelapse/i;

const NARRATIVE_SIGNAL_RE =
  /短剧|微电影|对话|台词|冲突|复仇|反转|主角|反派|侠客|外卖员|同学|老师|父子|情侣|对峙|密谋|遇见|故事剧情/i;

/** 规范化意图结果并在应用层执行边界与硬规则校验 */
export function sanitizeIntentRoute(raw: IntentRouteResult): IntentRouteResult {
  const confidence = Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0.75;
  const enableVirtualHost = raw.mode === 'explainer' ? Boolean(raw.enableVirtualHost) : false;
  const detectedStyleHint =
    typeof raw.detectedStyleHint === 'string' && raw.detectedStyleHint.trim().length > 0
      ? raw.detectedStyleHint.trim()
      : null;

  return {
    mode: raw.mode,
    enableVirtualHost,
    confidence,
    reasoning: raw.reasoning.trim() || `识别为 ${raw.mode} 模式`,
    detectedStyleHint,
  };
}

/**
 * 本地确定性启发式路由器：
 * 既作为无 LLM 环境/测试的即时识别，也用于对 LLM 结果做防呆纠偏。
 */
export function classifyIntentHeuristic(input: string): IntentRouteResult {
  const text = input.trim();
  const hasExplicitHost = EXPLICIT_HOST_RE.test(text);
  const hasPersonification = EXPLICIT_PERSONIFICATION_RE.test(text);
  const hasNoCharacter = EXPLICIT_NO_CHARACTER_RE.test(text);
  const hasExplainer = EXPLAINER_SIGNAL_RE.test(text);
  const hasScenic = SCENIC_SIGNAL_RE.test(text);
  const hasNarrative = NARRATIVE_SIGNAL_RE.test(text);

  if (hasExplainer && (!hasNarrative || hasNoCharacter || !hasPersonification)) {
    return sanitizeIntentRoute({
      mode: 'explainer',
      enableVirtualHost: hasExplicitHost,
      confidence: 0.9,
      reasoning: '检测到知识科普、原理解析或数据解说意图，采用无实景科普模式。',
      detectedStyleHint: /拼贴|vox/i.test(text)
        ? 'editorial halftone collage'
        : 'flat geometric vector illustration',
    });
  }

  if ((hasScenic || hasNoCharacter) && !hasPersonification && (!hasNarrative || hasNoCharacter)) {
    return sanitizeIntentRoute({
      mode: 'scenic',
      enableVirtualHost: false,
      confidence: hasNoCharacter ? 0.96 : 0.9,
      reasoning: hasNoCharacter
        ? '用户明确要求不包含角色或人物，锁定为无角色自然风光模式。'
        : '画面核心为自然景物与氛围演进，无人物叙事互动，锁定为无角色自然风光模式。',
      detectedStyleHint: '35mm documentary cinema, natural film grain',
    });
  }

  return sanitizeIntentRoute({
    mode: 'narrative',
    enableVirtualHost: false,
    confidence: hasNarrative ? 0.88 : 0.72,
    reasoning: '包含人物或剧情叙事特征，采用叙事剧情模式。',
    detectedStyleHint: null,
  });
}

export interface RouteVideoIntentOptions {
  /** 用户手动指定的模式；一旦指定则直接锁死，不再被模型覆盖 */
  manualOverride?: VideoMode;
  /** 用户手动指定的虚拟讲解员开关 */
  manualVirtualHost?: boolean;
  /** 可选 LLM 上下文；未提供时使用本地启发式分类 */
  ctx?: GenerateContext;
}

/**
 * 执行前置意图路由。
 * 若提供了 ctx 则优先调用结构化 LLM 路由器，失败时平滑退回启发式结果，
 * 并始终执行「明确禁角色 / 自然要素非拟人」的硬性纠偏。
 */
export async function routeVideoIntent(
  userInput: string,
  options: RouteVideoIntentOptions = {},
): Promise<IntentRouteResult> {
  if (options.manualOverride) {
    return sanitizeIntentRoute({
      mode: options.manualOverride,
      enableVirtualHost:
        options.manualOverride === 'explainer' ? Boolean(options.manualVirtualHost) : false,
      confidence: 1,
      reasoning: '由创作者手动指定生产模式。',
      detectedStyleHint: null,
    });
  }

  const heuristic = classifyIntentHeuristic(userInput);
  if (!options.ctx) {
    return options.manualVirtualHost !== undefined && heuristic.mode === 'explainer'
      ? sanitizeIntentRoute({ ...heuristic, enableVirtualHost: options.manualVirtualHost })
      : heuristic;
  }

  const outcome = await callStructuredLLM({
    schemaName: 'intent_route_result',
    wireJsonSchema: INTENT_ROUTE_WIRE_SCHEMA,
    zodSchema: intentRouteZodSchema,
    messages: [
      { role: 'system', content: INTENT_ROUTER_SYSTEM_PROMPT },
      { role: 'user', content: userInput.trim() || '请判断最合适的视频生产模式。' },
    ],
    ctx: options.ctx,
    maxTokens: 500,
    temperature: 0.1,
    maxRetries: 2,
  });

  if (!outcome.ok || !outcome.data) {
    return heuristic;
  }

  let result = sanitizeIntentRoute(outcome.data);

  // 防呆兜底：用户明确写「不要角色/不要人物」时，绝不允许模型误判回 narrative
  if (EXPLICIT_NO_CHARACTER_RE.test(userInput) && result.mode === 'narrative') {
    result = sanitizeIntentRoute({
      ...result,
      mode: EXPLAINER_SIGNAL_RE.test(userInput) ? 'explainer' : 'scenic',
      enableVirtualHost: false,
      reasoning: '检测到明确的无角色约束，已强制切换为非叙事模式。',
    });
  }

  if (options.manualVirtualHost !== undefined && result.mode === 'explainer') {
    result = sanitizeIntentRoute({ ...result, enableVirtualHost: options.manualVirtualHost });
  }

  return result;
}
