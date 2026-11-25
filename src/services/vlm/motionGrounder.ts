import { z } from 'zod';
import type { ModelProfile, Project, Shot } from '../../types/model';
import { CAMERA_MOVE_EN, CAMERA_MOVE_LABEL } from '../../types/model';
import { resolveVideoDialect } from '../../data/models/videoDialects';
import { compileVideoDialectPrompt } from '../../domain/prompt';
import {
  buildChatPayload,
  extractChatContent,
  GatewayError,
  request,
  type ChatMessage,
  type TransportConfig,
} from '../gateway';
import { extractJsonObject } from '../llm/robustJson';

/**
 * 可选首帧运动接地服务（Phase 3 · VLM Motion Grounder）
 *
 * 解决痛点：图生视频（I2V）时，文本里常写“主角向右走去推门”，但实际生成出来的首帧里门可能在画面左侧。
 * Motion Grounder 先看一眼真实首帧的构图方位，再把动作与单一运镜贴合到真实画面几何关系上，
 * 显著减少方向冲突、瞬移与肢体畸变。
 *
 * 按需触发；若未配置视觉模型或调用失败，可安全回退到本地 I2V 方言编译结果。
 */

const motionGrounderSchema = z.object({
  spatialLayout: z.string().min(1),
  groundedMotionPrompt: z.string().min(1),
  avoidPitfalls: z.array(z.string()).default([]),
});

export type MotionGrounderResult = z.infer<typeof motionGrounderSchema>;

export function buildMotionGrounderMessages(args: {
  shot: Shot;
  firstFrameDataUrl: string;
  dialectLabel: string;
}): ChatMessage[] {
  const { shot, firstFrameDataUrl, dialectLabel } = args;
  const moveLabel = CAMERA_MOVE_LABEL[shot.cameraMove];
  const moveEn = CAMERA_MOVE_EN[shot.cameraMove];

  return [
    {
      role: 'system',
      content:
        '你是专业图生视频（I2V）动作导演。你只输出合法 JSON，不输出多余解释。' +
        '核心铁律：1) 不要复述首帧已经存在的静止外貌和静态背景；2) 严格根据首帧里主体的真实左右站位、朝向和遮挡关系来描述动作轨迹；' +
        '3) 单镜只保留 1 个主导运镜；4) groundedMotionPrompt 用简洁自然的英文写出，可直接喂给视频模型。',
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `目标视频模型：${dialectLabel}\n` +
            `计划动作：${shot.action}\n` +
            `终点状态：${shot.endState}\n` +
            `计划主运镜：${moveLabel} (${moveEn})\n` +
            `时长：${shot.duration} 秒\n\n` +
            '请先观察下面的首帧画面，然后按 JSON 返回：' +
            '{"spatialLayout":"中文简述首帧里主体和关键物体的实际左右位置与朝向","groundedMotionPrompt":"贴合首帧真实构图的精简英文 I2V 动作+运镜提示词（不复述静态外观）","avoidPitfalls":["可能引发畸变或穿帮的注意事项"]}',
        },
        {
          type: 'image_url',
          image_url: { url: firstFrameDataUrl, detail: 'high' },
        },
      ],
    },
  ];
}

export function parseMotionGrounderResponse(raw: string): {
  ok: boolean;
  result?: MotionGrounderResult;
  error?: string;
} {
  const jsonText = extractJsonObject(raw) ?? raw.trim();
  try {
    const parsed: unknown = JSON.parse(jsonText);
    const checked = motionGrounderSchema.safeParse(parsed);
    if (!checked.success) {
      return { ok: false, error: '首帧运动接地返回格式不完整。' };
    }
    return { ok: true, result: checked.data };
  } catch {
    return { ok: false, error: '未能解析视觉模型返回的 JSON 结果。' };
  }
}

export async function groundShotMotionWithVlm(options: {
  profile?: ModelProfile;
  apiKey?: string;
  project: Project;
  shot: Shot;
  firstFrameDataUrl: string;
  dialectIdOrPlatform: string;
  transport?: TransportConfig;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{
  ok: boolean;
  usedVlm: boolean;
  result: MotionGrounderResult;
  warning?: string;
}> {
  const dialect = resolveVideoDialect(options.dialectIdOrPlatform);
  const fallbackCompiled = compileVideoDialectPrompt({
    project: options.project,
    shot: options.shot,
    dialectIdOrPlatform: dialect.dialectId,
    promptMode: 'i2v_motion_only',
  });
  const fallbackResult: MotionGrounderResult = {
    spatialLayout: '未使用视觉模型分析首帧构图，已采用本地 I2V 动作精简编译结果。',
    groundedMotionPrompt: fallbackCompiled.prompt,
    avoidPitfalls: fallbackCompiled.warnings,
  };

  if (!options.profile || !options.firstFrameDataUrl) {
    return {
      ok: true,
      usedVlm: false,
      result: fallbackResult,
      warning: '未配置视觉模型或缺少首帧图片，已安全回退到本地 I2V 动作提示词。',
    };
  }

  const messages = buildMotionGrounderMessages({
    shot: options.shot,
    firstFrameDataUrl: options.firstFrameDataUrl,
    dialectLabel: dialect.label,
  });

  const payload = buildChatPayload({
    model: options.profile.model ?? options.profile.id,
    messages,
    jsonMode: true,
    temperature: 0.25,
    maxTokens: 600,
  });

  try {
    const rawResp = await request<unknown>({
      profile: options.profile,
      apiKey: options.apiKey ?? '',
      body: payload,
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: 60_000,
    });
    const parsed = parseMotionGrounderResponse(extractChatContent(rawResp));
    if (parsed.ok && parsed.result) {
      return { ok: true, usedVlm: true, result: parsed.result };
    }
    return {
      ok: false,
      usedVlm: false,
      result: fallbackResult,
      warning: parsed.error ?? '视觉接地解析失败，已回退到本地 I2V 提示词。',
    };
  } catch (err) {
    const msg =
      err instanceof GatewayError
        ? `${err.info.title}：${err.info.advice}`
        : err instanceof Error
          ? err.message
          : '视觉模型调用失败';
    return {
      ok: false,
      usedVlm: false,
      result: fallbackResult,
      warning: `${msg}（已自动回退到本地 I2V 提示词）`,
    };
  }
}
