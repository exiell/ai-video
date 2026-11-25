import type { z } from 'zod';
import {
  buildChatPayload,
  extractChatContent,
  request,
  supportsStrictJsonSchema,
  type ChatJsonSchemaSpec,
  type ChatMessage,
} from '../gateway';
import type { GenerateContext, GenerateOutcome } from './generate';
import { parseModelJson } from './robustJson';

/**
 * 跨 LLM 供应商统一结构化输出客户端（Phase 2）
 *
 * 遵循跨厂商「最大公约数」协议：
 * 1. 支持原生 json_schema 的厂商（OpenAI / Gemini / Qwen 3.7+）走严格模式；
 * 2. DeepSeek 及存量模型自动降级走 json_object + 本地 Zod 二次校验；
 * 3. 若首次严格 json_schema 请求被端点返回 400 拒绝，自动降级为 json_object 重试；
 * 4. 校验失败时将具体 Zod 字段错误回灌给 LLM，最多定向重试 2 次；
 * 5. 结构化抽取调用严禁混用联网搜索工具（与检索严格分步解耦）。
 */

export interface StructuredCallOptions<T extends z.ZodTypeAny> {
  schemaName: string;
  /** 扁平化 JSON Schema（根节点必须为 object，每个 object 显式 additionalProperties: false，不含 minLength/minimum） */
  wireJsonSchema?: Record<string, unknown>;
  zodSchema: T;
  messages: ChatMessage[];
  ctx: GenerateContext;
  maxTokens?: number;
  temperature?: number;
  /** 校验失败时的最多定向重试次数（默认 2，即最多尝试 3 次） */
  maxRetries?: number;
}

export async function callStructuredLLM<T extends z.ZodTypeAny>(
  options: StructuredCallOptions<T>,
): Promise<GenerateOutcome<z.infer<T>>> {
  const maxAttempts = (options.maxRetries ?? 2) + 1;
  const warnings: string[] = [];
  const conversation: ChatMessage[] = [...options.messages];
  const effectiveMaxTokens =
    options.ctx.profile.maxOutputTokens !== undefined && options.maxTokens !== undefined
      ? Math.min(options.maxTokens, options.ctx.profile.maxOutputTokens)
      : options.maxTokens;

  let useStrictSchema =
    Boolean(options.wireJsonSchema) && supportsStrictJsonSchema(options.ctx.profile);
  let lastError = '';
  let lastDetail = '';
  let lastRaw = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let raw = '';
    const jsonSchemaSpec: ChatJsonSchemaSpec | undefined =
      useStrictSchema && options.wireJsonSchema
        ? { name: options.schemaName, schema: options.wireJsonSchema, strict: true }
        : undefined;

    try {
      const response = await request({
        profile: options.ctx.profile,
        apiKey: options.ctx.apiKey,
        body: buildChatPayload({
          model: options.ctx.model,
          messages: conversation,
          ...(jsonSchemaSpec ? { jsonSchema: jsonSchemaSpec } : { jsonMode: true }),
          temperature: options.temperature ?? 0.3,
          ...(effectiveMaxTokens !== undefined ? { maxTokens: effectiveMaxTokens } : {}),
        }),
        ...(options.ctx.transport ? { transport: options.ctx.transport } : {}),
        ...(options.ctx.fetchImpl ? { fetchImpl: options.ctx.fetchImpl } : {}),
      });
      raw = extractChatContent(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const gatewayInfo =
        typeof error === 'object' && error !== null && 'info' in error
          ? ((error as { info?: { kind?: string; advice?: string; raw?: string; status?: number } }).info ?? {})
          : {};
      // 若端点拒绝 json_schema（如部分 OpenAI 兼容代理/模型返回 400），自动降级为 json_object 再试一次
      if (
        useStrictSchema &&
        attempt < maxAttempts &&
        (gatewayInfo.status === 400 || /response_format|json_schema/i.test(`${message} ${gatewayInfo.raw ?? ''}`))
      ) {
        useStrictSchema = false;
        warnings.push('当前模型端点不支持严格 json_schema，已自动降级为 json_object 模式重试。');
        continue;
      }
      return {
        ok: false,
        attempts: attempt,
        warnings,
        error: message,
        detail: [gatewayInfo.kind ? `错误类型：${gatewayInfo.kind}` : '', gatewayInfo.advice ?? '']
          .filter(Boolean)
          .join('\n'),
        ...(gatewayInfo.raw ? { raw: gatewayInfo.raw } : {}),
      };
    }

    const extracted = parseModelJson(raw);
    if (extracted.value === undefined) {
      lastError = '返回内容不是合法 JSON 对象';
      lastDetail = `解析策略失败：${extracted.error ?? 'unknown'}`;
      lastRaw = raw;
    } else {
      const parsed = options.zodSchema.safeParse(extracted.value);
      if (parsed.success) {
        return {
          ok: true,
          data: parsed.data as z.infer<T>,
          attempts: attempt,
          warnings,
          raw,
        };
      }
      const issues = parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
        .join('；');
      lastError = `结构校验未通过：${issues}`;
      lastDetail = issues;
      lastRaw = raw;
    }

    if (attempt < maxAttempts) {
      conversation.push({ role: 'assistant', content: raw.slice(0, 1800) });
      conversation.push({
        role: 'user',
        content: [
          `你上一次的结构化输出未通过校验：${lastError}`,
          '请修正上述字段并重新输出严格合法的单个 JSON 对象，不要包含 Markdown 围栏或多余说明。',
        ].join('\n'),
      });
      warnings.push(`第 ${attempt} 次结构校验未通过，已将错误字段回灌模型重试。`);
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    warnings,
    error: lastError || '结构化生成失败',
    detail: lastDetail,
    raw: lastRaw,
  };
}
