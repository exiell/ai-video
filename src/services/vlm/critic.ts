import { z } from 'zod';
import type { ModelProfile, Project, Shot } from '../../types/model';
import {
  buildChatPayload,
  extractChatContent,
  GatewayError,
  request,
  type ChatContentPart,
  type ChatMessage,
  type TransportConfig,
} from '../gateway';
import { extractJsonObject } from '../llm/robustJson';

/**
 * 可选视觉质检官（Phase 3 · VLM Critic）
 *
 * 定位：按需触发（绝不静默耗费 API 费用），对照「规范主参考图 + 分镜规格 + 已声明的状态变化」
 * 审查生成的分镜关键帧，给出明确裁决：
 * - pass：可直接用于图生视频
 * - minor_fix：建议走「局部微调」修小瑕疵
 * - redraw_from_canonical：外观漂移较严重，建议「回溯主参考重绘」
 *
 * 铁律：全部网络调用严格经过 ModelGateway（requestJson）。
 */

export type VisualCriticVerdict = 'pass' | 'minor_fix' | 'redraw_from_canonical';

export const CRITIC_VERDICT_LABEL: Record<VisualCriticVerdict, string> = {
  pass: '通过（可直接生视频）',
  minor_fix: '建议局部微调',
  redraw_from_canonical: '建议回溯主参考重绘',
};

const criticOutputSchema = z.object({
  verdict: z.enum(['pass', 'minor_fix', 'redraw_from_canonical']),
  scores: z.object({
    identity: z.coerce.number().min(1).max(10),
    wardrobeAndProps: z.coerce.number().min(1).max(10),
    lightingAndScene: z.coerce.number().min(1).max(10),
    artifacts: z.coerce.number().min(1).max(10),
  }),
  summary: z.string().min(1),
  issues: z.array(z.string()).default([]),
  recommendedAction: z.string().default(''),
});

export type VisualCriticResult = z.infer<typeof criticOutputSchema>;

export interface CanonicalRefInput {
  label: string;
  dataUrl: string;
}

export function buildCriticMessages(args: {
  project: Project;
  shot: Shot;
  candidateDataUrl: string;
  canonicalRefs: CanonicalRefInput[];
}): ChatMessage[] {
  const { project, shot, candidateDataUrl, canonicalRefs } = args;
  const chars = project.characters.filter((c) => shot.characterIds.includes(c.id));
  const scene = project.scenes.find((s) => s.id === shot.sceneId);
  const props = (project.props ?? []).filter((p) => (shot.propIds ?? []).includes(p.id));
  const deltas = (shot.stateDeltas ?? [])
    .map(
      (d) =>
        `${Object.entries(d.changeableAttrs)
          .map(([k, v]) => `${k}=${v}`)
          .join('，')}（剧情原因：${d.reason || '剧情触发'}）`,
    )
    .join('；');

  const specLines = [
    `【待检分镜】第 ${shot.number} 镜（${shot.duration} 秒）`,
    scene ? `【目标场景】${scene.name}（${scene.identity.summary || scene.identity.summaryEn}）` : '',
    chars.length > 0
      ? `【出场角色】${chars.map((c) => `${c.name}：${c.identity.summary || c.identity.summaryEn}`).join('；')}`
      : '【出场角色】无角色镜头',
    props.length > 0
      ? `【关键道具】${props.map((p) => `${p.name}（${p.canonicalTraits}）`).join('；')}`
      : '',
    `【画面要求】起点：${shot.startState} | 动作：${shot.action} | 终点：${shot.endState}`,
    deltas
      ? `【已声明的合法剧情变化（不要判为穿帮）】${deltas}`
      : '【已声明的合法剧情变化】无',
  ].filter(Boolean);

  const userParts: ChatContentPart[] = [
    {
      type: 'text',
      text:
        specLines.join('\n') +
        '\n\n先看规范主参考图，再看最后一张「待检分镜帧」，严格按 JSON 返回审查结果：' +
        '{"verdict":"pass|minor_fix|redraw_from_canonical","scores":{"identity":1-10,"wardrobeAndProps":1-10,"lightingAndScene":1-10,"artifacts":1-10},"summary":"一句话中文结论","issues":["具体问题1"],"recommendedAction":"可直接粘贴进图像编辑框的中文修改指令"}',
    },
  ];

  for (const ref of canonicalRefs.slice(0, 4)) {
    userParts.push({ type: 'text', text: `规范主参考：${ref.label}` });
    userParts.push({ type: 'image_url', image_url: { url: ref.dataUrl, detail: 'low' } });
  }

  userParts.push({ type: 'text', text: '待检分镜帧：' });
  userParts.push({ type: 'image_url', image_url: { url: candidateDataUrl, detail: 'high' } });

  return [
    {
      role: 'system',
      content:
        '你是动画与 AI 视频制片质检总监。你只输出合法 JSON 对象，不输出多余解释文字。' +
        '判断原则：1) 与规范主参考比对五官、发型、服装、道具、光线一致性；2) 尊重已声明的合法剧情变化（如淋雨/换装/道具破损），不要误判为穿帮；' +
        '3) 检查多指、畸形、画面乱码字幕或多余人物；4) 仅小瑕疵给 minor_fix，人脸/服装明显走样给 redraw_from_canonical。',
    },
    {
      role: 'user',
      content: userParts,
    },
  ];
}

export function parseCriticResponse(raw: string): {
  ok: boolean;
  result?: VisualCriticResult;
  error?: string;
} {
  const jsonText = extractJsonObject(raw) ?? raw.trim();
  try {
    const parsed: unknown = JSON.parse(jsonText);
    const checked = criticOutputSchema.safeParse(parsed);
    if (!checked.success) {
      return { ok: false, error: '视觉质检模型返回的 JSON 缺少必要字段，请重试或换一个支持视觉的模型。' };
    }
    return { ok: true, result: checked.data };
  } catch {
    return { ok: false, error: '视觉质检模型没有返回可解析的 JSON，请确认所选模型支持看图（Vision）。' };
  }
}

export async function critiqueShotFrame(options: {
  profile: ModelProfile;
  apiKey: string;
  project: Project;
  shot: Shot;
  candidateDataUrl: string;
  canonicalRefs: CanonicalRefInput[];
  transport?: TransportConfig;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; result?: VisualCriticResult; error?: string }> {
  if (!options.candidateDataUrl) {
    return { ok: false, error: '请先生成本镜关键帧后再执行视觉质检。' };
  }
  const messages = buildCriticMessages({
    project: options.project,
    shot: options.shot,
    candidateDataUrl: options.candidateDataUrl,
    canonicalRefs: options.canonicalRefs,
  });

  const payload = buildChatPayload({
    model: options.profile.model ?? options.profile.id,
    messages,
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 700,
  });

  try {
    const rawResp = await request<unknown>({
      profile: options.profile,
      apiKey: options.apiKey,
      body: payload,
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: 60_000,
    });
    const content = extractChatContent(rawResp);
    return parseCriticResponse(content);
  } catch (err) {
    if (err instanceof GatewayError) {
      return { ok: false, error: `${err.info.title}：${err.info.advice}` };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : '视觉质检调用失败，请稍后重试。',
    };
  }
}
