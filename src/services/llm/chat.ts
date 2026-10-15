import { z } from 'zod';
import { buildChatPayload, extractChatContent, request, type ChatMessage } from '../gateway';
import type { GenerateContext, GenerateOutcome } from './generate';
import type { ChatEditProposal, ChatReply } from '../../domain/chat/edits';
import { EDITABLE_FIELDS, readField } from '../../domain/chat/edits';
import type { Project } from '../../types/model';

/**
 * 对话式改稿 · 模型侧（方案.md §7.6.20）
 *
 * ===========================================================================
 * 这个文件里最重要的东西是「系统提示词怎么写」
 * ===========================================================================
 * 让模型「回答 + 给出可应用的字段修改」这件事，难点不在调用，
 * 而在**约束它的行为**。不加约束时它会：
 *
 *  1. **热心过头**：问「第三镜动作太平」，它顺手把第 4、5、7 镜也改了。
 *     改动范围一大，用户没法审阅，只能盲目相信或全盘拒绝 —— 两边都糟。
 *  2. **改接口不该改的东西**：把 characterIds 写成名字、给不存在的场景挂 id。
 *     所以提示词里明确禁止改引用关系，白名单在 domain 层再兜一次。
 *  3. **只给结论不给替换文本**：说「建议让动作更有张力」——
 *     那对用户毫无用处，他要的是「把 action 换成哪句话」。
 *
 * 所以提示词的核心是三条：只改被问到的、不改引用、必须给出完整替换文本。
 */

// ---------------------------------------------------------------------------
// 模型输出契约
// ---------------------------------------------------------------------------

export const chatEditSchema = z.object({
  /** 改哪个对象 */
  target: z.object({
    kind: z.enum(['shot', 'character', 'scene', 'story', 'brief']),
    id: z.string().optional(),
    field: z.string().min(1),
  }),
  /** 一句话说明改什么（给人看，不要字段名） */
  title: z.string().min(1),
  /** 为什么这么改 */
  reason: z.string().default(''),
  /** 修改后的**完整内容**，不是「把 X 改成 Y」这种说明 */
  after: z.union([z.string(), z.number(), z.array(z.string())]),
  /** 可能的副作用 */
  sideEffect: z.string().optional(),
});

export const chatReplySchema = z.object({
  reply: z.string().min(1),
  scope: z.enum(['single', 'related']).default('single'),
  edits: z.array(chatEditSchema).default([]),
});

export type GeneratedChatReply = z.infer<typeof chatReplySchema>;

// ---------------------------------------------------------------------------
// 系统提示词
// ---------------------------------------------------------------------------

/**
 * 把可改字段清单渲染成提示词。
 *
 * 从 `EDITABLE_FIELDS` 生成，而不是手写一遍 ——
 * 手写必然会在某次加字段后忘记同步，然后模型就会去改一个改不了的字段，
 * 而用户看到的是「AI 说改了但其实没改」。
 */
function renderFieldList(): string {
  const parts: string[] = [];
  for (const [kind, fields] of Object.entries(EDITABLE_FIELDS)) {
    const list = Object.entries(fields).map(([name, spec]) => {
      if (spec.type === 'enum') return `${name}（${spec.options?.join('/')}）`;
      if (spec.type === 'number') return `${name}（数字 ${spec.min}-${spec.max}）`;
      if (spec.type === 'stringArray') return `${name}（英文短语数组）`;
      return name;
    });
    const kindZh =
      { shot: '镜头', character: '角色', scene: '场景', story: '故事', brief: '规格' }[kind] ?? kind;
    parts.push(`- ${kind}（${kindZh}）：${list.join('、')}`);
  }
  return parts.join('\n');
}

export function buildChatSystemPrompt(): string {
  return `你是一个动漫分镜的改稿助手。用户是**完全的新手**，他不熟悉专业术语，
也不知道该怎么填表格。你的任务是：听懂他想改什么，用大白话解释你的理解，
然后给出**具体到字段的修改**。

# 你的回答分两部分

1. **reply**：用大白话回答他。先说你怎么理解他的意思，再说你打算怎么改、为什么。
   不要用「景别」「运镜」这类术语来回答，除非他自己用了。说「把镜头拉近一点」
   比说「改成 close-up」对他有用得多。

2. **edits**：具体的修改，每条包含：
   - target：改哪个对象的哪个字段
   - title：一句话说明改什么（给人看，例：「让第 3 镜的动作更有张力」）
   - reason：为什么这么改（例：「你说太平，主要问题是动作只有'走进来'，没有阻力」）
   - after：**修改后的完整内容**，不是「把 X 改成 Y」这种说明
   - sideEffect：可选，这个改动可能带来的连带影响

# 三条硬规则

**1. 默认只改用户问到的那一处。**
用户问「第三镜太平」，你只改第三镜。**不要顺手把第 4、5 镜也改了**——
改动范围一大，用户就没法逐条审阅，只能盲目全信或全部拒绝，两边都是坏结果。

只有当用户**明确要求**联动时才扩大范围（例如他说「连带相关的镜头一起改」），
这时把 scope 设为 "related"。

**2. 绝对不能改引用关系。**
不要改 id、sceneId、characterIds、activeLockIds、shotIds、variants、continuityLocks。
这些是对象之间的连接，改错了会把分镜挂到不存在的场景上，而且界面上不一定看得见。
挂哪个场景、谁出镜，是用户在界面上用下拉框做的决定，不是你的。

**3. after 必须是完整可替换的内容。**
反例：「让动作更有张力」—— 这不是内容，用户拿到它没有任何用。
正例：「他推开门，手停在门把上没松开」—— 这是可以直接替换进字段的东西。

# 风格要求

- 说话简短。用户是新手，一次说太多他会更糊涂。
- 一次最多给 5 条修改。超过 5 条说明这个改动太大了，应该先问清楚。
- 如果用户只是在提问（比如「这个工具能做什么」「为什么要锁角色」），
  就只回答，edits 返回空数组。**不要为了显示自己能干而硬凑修改。**
- 如果他的要求你做不到（例如「帮我生成图片」），直说做不到，并告诉他去哪里做。
- 中文回答。

# 你可以修改的字段

${renderFieldList()}

注意：**不在这份清单里的字段你不能改。** 如果你想改的东西不在清单里，
在 reply 里告诉用户「这个需要在界面上手动改」，而不是编一个字段名。

# 输出格式

只输出 JSON，不要有别的内容：

{
  "reply": "你的回答（中文，大白话）",
  "scope": "single",
  "edits": [
    {
      "target": { "kind": "shot", "id": "镜头的 id", "field": "action" },
      "title": "让第 3 镜的动作更有张力",
      "reason": "你说太平，主要问题是动作只有'走进来'，没有阻力",
      "after": "他推开门，手停在门把上没松开",
      "sideEffect": "这会让这一镜的时长需要更长一点"
    }
  ]
}`;
}

export function buildChatMessages(
  context: string,
  history: ChatMessage[],
  question: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: buildChatSystemPrompt() }];

  /**
   * 为什么把历史对话压成一段而不是原样塞进 messages：
   * 每轮都带完整项目上下文的话，几轮之后输入就会爆掉（20 镜的项目
   * 上下文本身就有几千字）。这里只在**最新一轮**带项目快照，
   * 历史只保留问答文本——足够模型理解「他刚才问了什么、我答了什么」。
   */
  if (history.length > 0) {
    const condensed = history
      .slice(-6)
      .map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.content}`)
      .join('\n');
    messages.push({
      role: 'system',
      content: `# 之前的对话（供你理解上下文，不要重复回答）\n${condensed}`,
    });
  }

  messages.push({
    role: 'user',
    content: `# 当前项目内容\n${context}\n\n# 用户的问题\n${question}`,
  });

  return messages;
}

// ---------------------------------------------------------------------------
// 解析与校验
// ---------------------------------------------------------------------------

export interface ParsedChat {
  reply: ChatReply;
  /** 校验挡掉的条数 */
  rejected: number;
  /** 被挡掉的原因，如实告诉用户 */
  rejectedReasons: string[];
}

/**
 * 把模型返回的 JSON 变成可用的提议。
 *
 * 两道关：
 *  1. Zod 校验**结构**（是不是该有的形状）
 *  2. `EDITABLE_FIELDS` 校验**权限**（这个字段准不准改）
 *
 * 第二道关不能省。模型的 JSON 可以是合法的，但字段名可能是编的——
 * 直接写进项目会污染数据。
 */
export function normalizeChatReply(parsed: GeneratedChatReply, project?: Project): ParsedChat {
  const edits: ChatEditProposal[] = [];
  const rejectedReasons: string[] = [];

  parsed.edits.forEach((raw, index) => {
    const { kind, id, field } = raw.target;

    // 除了 story / brief，其余都必须给出 id
    if (kind !== 'story' && kind !== 'brief' && !id) {
      rejectedReasons.push(`「${raw.title}」没说是改哪一个${kind === 'shot' ? '镜头' : '对象'}`);
      return;
    }

    const spec = EDITABLE_FIELDS[kind][field];
    if (!spec) {
      rejectedReasons.push(
        `「${raw.title}」想改的字段「${field}」不在可修改范围内（需要在界面上手动改）`,
      );
      return;
    }

    // 值本身也校验一遍：类型不对、超长、枚举不匹配都在这里挡掉。
    // 放在 domain 的 validateFieldValue 里，这里只做一次预检是为了
    // 能在界面上**当场**告诉用户哪条被挡了，而不是等他点了确认才发现。
    const typeOk =
      spec.type === 'text'
        ? typeof raw.after === 'string'
        : spec.type === 'number'
          ? typeof raw.after === 'number' || !Number.isNaN(Number(raw.after))
          : spec.type === 'stringArray'
            ? Array.isArray(raw.after) || typeof raw.after === 'string'
            : typeof raw.after === 'string';
    if (!typeOk) {
      rejectedReasons.push(`「${raw.title}」给出的内容格式不对`);
      return;
    }

    const target: ChatEditProposal['target'] = { kind, ...(id ? { id } : {}), field };
    /**
     * 记下「生成提议那一刻」的值，供确认时做冲突检测。
     * 不记的话，用户在提议之后的手改会被静默覆盖。
     */
    const beforeAtProposal = project ? readField(project, target) : undefined;

    edits.push({
      id: `chat-edit-${index}-${Date.now().toString(36)}`,
      title: raw.title,
      reason: raw.reason,
      target,
      before: beforeAtProposal ?? '',
      after: Array.isArray(raw.after) ? raw.after.join('、') : String(raw.after),
      ...(beforeAtProposal !== undefined ? { beforeAtProposal } : {}),
      ...(raw.sideEffect ? { sideEffect: raw.sideEffect } : {}),
    });
  });

  return {
    reply: {
      reply: parsed.reply,
      edits,
      rejected: rejectedReasons.length,
      scope: parsed.scope,
    },
    rejected: rejectedReasons.length,
    rejectedReasons,
  };
}

/** 从模型原始输出里解析出对话回复 */
export function parseChatReply(raw: string): {
  data?: GeneratedChatReply;
  error?: string;
  detail?: string;
} {
  if (!raw || raw.trim().length === 0) {
    return {
      error: '模型没有返回任何内容。',
      detail: '可能是输出被长度上限截断，或模型在 JSON 模式下抽风。再问一次通常能好。',
    };
  }

  // 复用项目里那套稳健的 JSON 提取（能处理模型在 JSON 前后加废话的情况）
  let value: unknown;
  try {
    value = JSON.parse(extractJson(raw));
  } catch {
    return {
      error: '模型这次没有按格式回答。',
      detail: '它返回的内容里没有可解析的 JSON。再问一次通常能好；反复如此就换一个模型。',
    };
  }

  const result = chatReplySchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      error: '模型返回的内容格式不对。',
      detail: issue ? `${issue.path.join('.')}：${issue.message}` : '未知的格式问题',
    };
  }
  return { data: result.data };
}

/** 从可能夹带解释文字的返回里抠出 JSON 对象 */
function extractJson(text: string): string {
  const trimmed = text.trim();
  // 去掉 ```json ``` 围栏
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return body;
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

export interface ChatOutcome extends Omit<GenerateOutcome<ParsedChat>, 'data'> {
  data?: ParsedChat;
}

/**
 * 问模型一个问题，拿回「回答 + 提议」。
 *
 * 复用 `generateWithRetry` 的失败回灌机制：第一次格式不对时，
 * 把失败原因连同「请严格按 JSON 格式」一起发回去重试。
 * 这比单纯重试有效得多——模型知道该怎么改了。
 */
export async function askModel(
  ctx: GenerateContext,
  messages: ChatMessage[],
  project?: Project,
): Promise<ChatOutcome> {
  const outcome = await generateRaw(messages, ctx);
  if (!outcome.ok || outcome.raw === undefined) {
    return { ok: false, attempts: outcome.attempts, warnings: [], error: outcome.error, detail: outcome.detail, raw: outcome.raw };
  }

  const parsed = parseChatReply(outcome.raw);
  if (!parsed.data) {
    return {
      ok: false,
      attempts: outcome.attempts,
      warnings: [],
      error: parsed.error ?? '解析失败',
      detail: parsed.detail ?? '',
      raw: outcome.raw,
    };
  }

  return {
    ok: true,
    data: normalizeChatReply(parsed.data, project),
    attempts: outcome.attempts,
    warnings: [],
    raw: outcome.raw,
  };
}

/**
 * 真正发请求的那一层。
 *
 * 与 `generateWithRetry` 分开写而不是直接复用，是因为那个函数把
 * `parse` 放在重试循环**内部**、并且只回灌 `lastError`。
 * 聊天这里希望在格式错误时回灌一句更具体的「重说一遍，只输出 JSON」，
 * 所以单独实现一遍循环，但沿用同样的策略。
 */
async function generateRaw(
  messages: ChatMessage[],
  ctx: GenerateContext,
): Promise<{ ok: boolean; raw?: string; attempts: number; error?: string; detail?: string }> {
  const maxAttempts = ctx.maxAttempts ?? 2;
  const conversation: ChatMessage[] = [...messages];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let raw = '';
    try {
      const response = await request({
        profile: ctx.profile,
        apiKey: ctx.apiKey,
        body: buildChatPayload({
          model: ctx.model,
          messages: conversation,
          jsonMode: true,
          /**
           * 温度比生成分镜低一些。
           *
           * 生成内容时希望它有想象力（0.7），但改稿时希望它**照做**
           * ——用户说「把动作改具体」，它就该改具体，而不是自由发挥
           * 顺手编一段新剧情。改稿跑偏比生成跑偏更让人恼火，
           * 因为那是用户已经认可的内容。
           */
          temperature: 0.4,
        }),
        ...(ctx.transport ? { transport: ctx.transport } : {}),
        ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
      });
      raw = extractChatContent(response);
    } catch (error) {
      // 网络 / 鉴权 / 跨域类错误重试没有意义，直接返回
      const message = error instanceof Error ? error.message : String(error);
      const gatewayInfo =
        typeof error === 'object' && error !== null && 'info' in error
          ? ((error as { info?: { title?: string; advice?: string } }).info ?? {})
          : {};
      return {
        ok: false,
        attempts: attempt,
        error: gatewayInfo.title ?? message,
        detail: gatewayInfo.advice ?? message,
      };
    }

    const parsed = parseChatReply(raw);
    if (parsed.data) return { ok: true, raw, attempts: attempt };

    // 把这个失败原因回灌，比单纯重试有效得多——模型知道该怎么改了
    conversation.push({ role: 'assistant', content: raw.slice(0, 500) });
    conversation.push({
      role: 'user',
      content:
        `你上一次的回答不符合格式要求：${parsed.detail ?? parsed.error ?? '不是合法 JSON'}。` +
        `请重新回答，并且**只输出 JSON**，不要有任何解释文字、不要用代码块包裹。`,
    });
  }

  return {
    ok: false,
    attempts: maxAttempts,
    error: '模型连续几次都没有按格式回答。',
    detail: '再问一次通常能好；反复如此建议在设置页换一个模型。',
  };
}
