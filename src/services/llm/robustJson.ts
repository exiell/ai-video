/**
 * 模型输出的鲁棒解析
 *
 * ===========================================================================
 * 为什么需要这一层
 * ===========================================================================
 * 即使开了 `response_format: { type: 'json_object' }`，模型的实际输出仍然会出岔子。
 * 四种最常见的偏差：
 *
 *  1. **前面带说明文字**：「好的，这是故事：{...}」
 *  2. **后面带解释，而且解释里还有花括号**：「……的故事。下一场是 {教室} 和 {操场}」
 *     —— 这一条会把「取第一个 { 到最后一个 }」的做法彻底坑死，切出来不是合法 JSON
 *  3. **外面套了代码块**：```json ... ```
 *  4. **结构轻微走形**：该给对象数组的地方给了字符串数组
 *
 * 原来的实现只处理了 1 和 3，遇到 2 就会失败，而且失败信息只说「不是合法 JSON」，
 * 用户完全不知道发生了什么。这个模块把四类偏差都处理掉。
 */

/** 从字符串里切出第一个**括号配平**的 JSON 对象 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  // 括号没配平：说明输出被截断了。把剩下的原样返回，
  // 交给上层报「可能被长度上限截断」，而不是在这里假装成功。
  return text.slice(start);
}

/** 剥掉代码块围栏 */
function stripFence(text: string): string {
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  return fenced?.[1] !== undefined ? fenced[1].trim() : text;
}

/**
 * 顶层字段别名归一化。
 *
 * 注意： **只在顶层用，不要往下递归。**
 * 「characters」在故事输出里常被当成 charactersNote 的别名，
 * 但它在「角色与场景」输出里是合法的字段名。递归套用会把整个角色列表吃掉——
 * 这是一个真实发生过的错误，靠测试里那条「不被别名覆盖」的断言才拦住。
 */
/** 无论哪个 schema 都安全的别名替换 */
const SAFE_ALIASES: Record<string, string> = {
  story: 'body',
  content: 'body',
  narrative: 'body',
  background: 'setting',
  climax: 'conflict',
  resolution: 'ending',
  conclusion: 'ending',
  shotlist: 'shots',
  shotList: 'shots',
  storyboard: 'shots',
};

/**
 * 有歧义的别名：同一个词在不同 schema 里含义不同。
 *
 * `characters` 在故事输出里是 charactersNote 的常见误写，
 * 但在「角色与场景」输出里是**合法的顶层字段**。
 * 数据本身看不出是哪种情况，所以必须由调用方声明当前在修哪个 schema。
 * 不声明时一律不替换——宁可让 schema 报错，也不要悄悄吃掉整个角色列表。
 */
const AMBIGUOUS_ALIASES: Record<string, { target: string; onlyFor: SchemaHint[] }> = {
  characters: { target: 'charactersNote', onlyFor: ['story'] },
  character: { target: 'charactersNote', onlyFor: ['story'] },
  characterNote: { target: 'charactersNote', onlyFor: ['story'] },
  text: { target: 'body', onlyFor: ['story'] },
};

/** 修理时针对哪个 schema。不传则跳过有歧义的替换。 */
export type SchemaHint = 'story' | 'assets' | 'shots';

/** 递归归一化。这一层不做别名替换，只保证嵌套结构被走过一遍 */
function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeKeys);
  if (typeof value !== 'object' || value === null) return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(source)) {
    out[key] = normalizeKeys(raw);
  }
  return out;
}

/**
 * 根层归一化：应用别名表，并把指向同一个规范键的多个键合并。
 *
 * **别名只在这一层生效。** 原因是同一个词在不同输出里语义不同：
 * 故事输出里的 `characters` 是 charactersNote 的常见误写，
 * 而角色与场景输出里的 `characters` 是合法字段名。
 * 递归套用别名会把整个角色列表吃掉——这个错误真的发生过。
 */
function normalizeRoot(value: unknown, hint?: SchemaHint): Record<string, unknown> {
  const source = normalizeKeys(value) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };

  const replacements: [string, string][] = Object.entries(SAFE_ALIASES);
  if (hint) {
    for (const [alias, rule] of Object.entries(AMBIGUOUS_ALIASES)) {
      if (rule.onlyFor.includes(hint)) replacements.push([alias, rule.target]);
    }
  }

  for (const [alias, canonical] of replacements) {
    if (alias === canonical) continue;
    if (!(alias in out)) continue;
    // 规范键已存在时不动它：那说明这个别名不是笔误
    if (canonical in out) continue;
    out[canonical] = out[alias];
    delete out[alias];
  }
  return out;
}




/** 把值转成字符串；对象则尝试从里面的文本字段拼出来 */
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(asText).filter((v): v is string => v !== undefined && v.length > 0);
    return parts.length > 0 ? parts.join('；') : undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const key of ['text', 'content', 'value', 'description', 'summary', 'label', 'name']) {
      const found = asText(obj[key]);
      if (found && found.length > 0) return found;
    }
  }
  return undefined;
}

function asTextArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const parts = value
      .map(asText)
      .filter((v): v is string => v !== undefined && v.trim().length > 0);
    return parts;
  }
  const single = asText(value);
  return single !== undefined && single.trim().length > 0 ? [single] : undefined;
}

/**
 * 结构修理：把「轻微走形」的输出搬回 schema 期望的形状。
 *
 * 只处理**明确无歧义**的偏差。不猜测语义，不做创造性解释——
 * 宁可让用户看到失败，也不要给他一份悄悄编造的内容。
 */
export function repairShape(json: unknown, hint?: SchemaHint): unknown {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json;
  const out: Record<string, unknown> = { ...normalizeRoot(json, hint) };

  // ---- 故事 ----
  if ('body' in out) {
    // 注意：这里**不做**「数字转字符串」这类强制转型。
    // 那属于过度修理——把 body: 123 悄悄变成 "123"，用户会拿到一份
    // 看起来正常其实不对的故事。类型不对就该让校验拦住并报出来。
    // scenes 有时被写成 ["第一场：教室", "第二场：操场"] 这样的字符串数组
    const scenesValue = out.scenes;
    if (Array.isArray(scenesValue)) {
      out.scenes = scenesValue.map((item, index) => {
        if (typeof item === 'string') {
          return { label: item, summary: '' };
        }
        if (typeof item === 'object' && item !== null) {
          const scene = item as Record<string, unknown>;
          const label =
            asText(scene.label) ?? asText(scene.name) ?? asText(scene.title) ?? `第 ${index + 1} 场`;
          const summary = asText(scene.summary) ?? asText(scene.description) ?? '';
          return { label, summary };
        }
        return { label: `第 ${index + 1} 场`, summary: '' };
      });
    }
  }

  // ---- 分镜 ----
  if ('shots' in out && Array.isArray(out.shots)) {
    out.shots = (out.shots as unknown[]).map((item) => {
      if (typeof item !== 'object' || item === null) return item;
      const shot = normalizeKeys(item) as Record<string, unknown>;
      const fixed: Record<string, unknown> = { ...shot };
      // 「动作」常被写成数组（因为一镜里写了多件事）——合并成一句话。
      // 这是**结构性**偏差，修它是安全的；多动作本身的问题留给穿帮检查去提示。
      // 除此之外不做文本强制转型：类型不对就该被校验拦住。
      if (Array.isArray(fixed.action)) {
        const actions = asTextArray(fixed.action);
        if (actions && actions.length > 0) fixed.action = actions.join('，');
      }
      // 数组字段
      for (const key of ['characterSlugs', 'activeLockLabels', 'activeVariantLabels', 'offscreenCharacters']) {
        if (key in fixed && !Array.isArray(fixed[key])) {
          const arr = asTextArray(fixed[key]);
          if (arr !== undefined) fixed[key] = arr;
        }
      }
      return fixed;
    });
  }

  // ---- 角色与场景 ----
  for (const key of ['characters', 'scenes']) {
    if (!Array.isArray(out[key])) continue;
    out[key] = (out[key] as unknown[]).map((item) => {
      if (typeof item !== 'object' || item === null) return item;
      const entry = normalizeKeys(item) as Record<string, unknown>;
      const fixed: Record<string, unknown> = { ...entry };
      // 常见写法：把 name 当成 slug
      if (fixed.slug === undefined && typeof fixed.name === 'string') {
        const candidate = fixed.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        if (candidate.length > 0) fixed.slug = candidate;
      }
      // 固定元素有时被写成一段话
      if (key === 'scenes' && !Array.isArray(fixed.fixedElements)) {
        const arr = asTextArray(fixed.fixedElements);
        if (arr !== undefined) fixed.fixedElements = arr;
      }
      return fixed;
    });
  }

  return out;
}

export interface ExtractAttempt {
  /** 用来解析的候选文本 */
  candidate: string;
  /** 怎么得到的，便于排查 */
  strategy: string;
}

/**
 * 依次尝试几种抽取策略，返回第一个能解析成 JSON 对象的结果。
 *
 * 顺序有讲究：先试「原文直接解析」（最不容易出错），
 * 再试「剥围栏」，最后才用括号配平扫描——扫描是兜底，但它能解决
 * 「JSON 后面跟了一段带花括号的解释」这个把原实现坑死的情况。
 */
export function parseModelJson(raw: string): { value?: unknown; error?: string; usedStrategy?: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { error: 'empty' };

  const attempts: ExtractAttempt[] = [
    { candidate: trimmed, strategy: '原文直接解析' },
    { candidate: stripFence(trimmed), strategy: '剥离代码块围栏' },
  ];

  const balanced = extractJsonObject(stripFence(trimmed));
  if (balanced !== null) {
    attempts.push({ candidate: balanced, strategy: '括号配平扫描' });
  }

  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (seen.has(attempt.candidate)) continue;
    seen.add(attempt.candidate);
    try {
      const value = JSON.parse(attempt.candidate) as unknown;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return { value, usedStrategy: attempt.strategy };
      }
    } catch {
      // 换下一个策略
    }
  }

  return {
    error: extractJsonObject(stripFence(trimmed)) === null ? 'no-object' : 'invalid-json',
  };
}

