import type { Project, Shot, ShotRenderEngine } from '../../types/model';
import {
  resolveVideoDialect,
  type VideoPromptMode,
} from '../../data/models/videoDialects';
import { resolveVideoMode } from '../pipeline/profiles';

/**
 * 分镜级混合渲染路由器与成本分档路由（Phase 1 + Phase 4）
 *
 * 1. 按制作阶段提供「草稿档（draft）试跑动作 → 旗舰档（final）最终出片」双轨成本路由；
 * 2. 按镜头语义意图（subtle_motion / major_transition / multi_subject_interaction /
 *    continuous_dialogue / data_formula）自动推荐最优视频模式与方言；
 * 3. 为二期代码渲染插件（html_hyperframes / manim）保留清晰的注册位与 codeRenderSpec 透传契约。
 */

export type RenderTier = 'draft' | 'final';

export type ShotIntent =
  | 'subtle_motion'
  | 'major_transition'
  | 'multi_subject_interaction'
  | 'continuous_dialogue'
  | 'data_formula';

export interface ShotRouteRecommendation {
  tier: RenderTier;
  intent: ShotIntent;
  engine: ShotRenderEngine;
  promptMode: VideoPromptMode;
  recommendedDialectId: string;
  estimatedUsdPerSec: number;
  reason: string;
}

export interface ShotRenderDispatchRequest {
  project: Project;
  shot: Shot;
  engine: ShotRenderEngine;
  codeRenderSpec: string | null;
  tier?: RenderTier;
}

export interface ShotRenderDispatchResult {
  handled: boolean;
  engine: ShotRenderEngine;
  kind: 'ai_pipeline' | 'kenburns_still' | 'code_plugin' | 'unimplemented_plugin';
  message: string;
  codeRenderSpec?: string | null;
}

export type ShotRendererPlugin = (
  req: ShotRenderDispatchRequest,
) => Promise<ShotRenderDispatchResult> | ShotRenderDispatchResult;

const registeredPlugins = new Map<ShotRenderEngine, ShotRendererPlugin>();

/** 从分镜字段自动推断镜头创作意图 */
export function inferShotIntent(shot: Shot, project?: Pick<Project, 'videoMode'> | null): ShotIntent {
  if (
    shot.renderEngine === 'html_hyperframes' ||
    shot.renderEngine === 'manim' ||
    Boolean(shot.codeRenderSpec)
  ) {
    return 'data_formula';
  }
  if (shot.continuityMode === 'first_last_frame') {
    return 'major_transition';
  }
  if ((shot.characterIds?.length ?? 0) >= 2) {
    return shot.dialogue.trim().length > 0 ? 'continuous_dialogue' : 'multi_subject_interaction';
  }
  if (resolveVideoMode(project) === 'narrative' && shot.dialogue.trim().length > 0) {
    return 'continuous_dialogue';
  }
  return 'subtle_motion';
}

export const ShotRendererRouter = {
  /** 注册外部渲染插件（例如二期接入 HyperFrames 或 Manim 服务） */
  registerPlugin(engine: ShotRenderEngine, plugin: ShotRendererPlugin): void {
    registeredPlugins.set(engine, plugin);
  },

  /** 卸载插件（测试清理用） */
  unregisterPlugin(engine: ShotRenderEngine): void {
    registeredPlugins.delete(engine);
  },

  /** 解析该镜头应使用的渲染引擎 */
  resolveEngine(shot: Shot, project?: Pick<Project, 'videoMode'> | null): ShotRenderEngine {
    if (shot.renderEngine) return shot.renderEngine;
    const mode = resolveVideoMode(project);
    if (mode === 'explainer') {
      return shot.codeRenderSpec ? 'html_hyperframes' : 'ai_ref_to_video';
    }
    if (mode === 'scenic' && shot.continuityMode === 'first_last_frame') {
      return 'ai_first_last_frame';
    }
    return 'ai_video';
  },

  /**
   * 按成本分档（draft 草稿验证 / final 终渲成片）与镜头意图推荐最优路由方案。
   */
  recommendRoute(
    shot: Shot,
    project?: Pick<Project, 'videoMode'> | null,
    tier: RenderTier = 'draft',
    explicitIntent?: ShotIntent,
  ): ShotRouteRecommendation {
    const intent = explicitIntent ?? inferShotIntent(shot, project);
    const videoMode = resolveVideoMode(project);

    if (intent === 'data_formula') {
      const engine = shot.renderEngine === 'manim' ? 'manim' : 'html_hyperframes';
      return {
        tier,
        intent,
        engine,
        promptMode: 't2v',
        recommendedDialectId: 'custom',
        estimatedUsdPerSec: 0,
        reason: '包含精密公式或数据图表，优先路由至确定性代码渲染插件避免像素错位。',
      };
    }

    if (intent === 'major_transition') {
      const dialectId = tier === 'draft' ? 'wan_2_7_r2v' : 'seedance_2_5';
      const dialect = resolveVideoDialect(dialectId);
      return {
        tier,
        intent,
        engine: 'ai_first_last_frame',
        promptMode: 'first_last_bridge',
        recommendedDialectId: dialectId,
        estimatedUsdPerSec:
          tier === 'draft'
            ? (dialect.costTierHint?.draftUsdPerSec ?? 0.06)
            : (dialect.costTierHint?.finalUsdPerSec ?? 0.23),
        reason: '大幅场景或状态转场适合首尾帧插值，先锁两端静帧再补中间运动。',
      };
    }

    if (intent === 'multi_subject_interaction') {
      const dialectId = tier === 'draft' ? 'vidu_q3' : 'seedance_2_5';
      const dialect = resolveVideoDialect(dialectId);
      return {
        tier,
        intent,
        engine: 'ai_ref_to_video',
        promptMode: 'r2v_multimodal',
        recommendedDialectId: dialectId,
        estimatedUsdPerSec:
          tier === 'draft'
            ? (dialect.costTierHint?.draftUsdPerSec ?? 0.048)
            : (dialect.costTierHint?.finalUsdPerSec ?? 0.23),
        reason: '多主体同框互动优先走多参考 R2V 绑定，防止多人混脸。',
      };
    }

    if (intent === 'continuous_dialogue') {
      const dialectId = tier === 'draft' ? 'wan_2_7_r2v' : 'kling_3';
      const dialect = resolveVideoDialect(dialectId);
      return {
        tier,
        intent,
        engine: 'ai_video',
        promptMode: 'multi_shot',
        recommendedDialectId: dialectId,
        estimatedUsdPerSec:
          tier === 'draft'
            ? (dialect.costTierHint?.draftUsdPerSec ?? 0.06)
            : (dialect.costTierHint?.finalUsdPerSec ?? 0.17),
        reason: '同场次连续对白适合支持原生音频与多镜编组的模型，保持光影与声线连贯。',
      };
    }

    // subtle_motion（细腻微表情与物理运动）：探索期用低价 Turbo/Hailuo 档，终渲期升旗舰档
    const dialectId =
      tier === 'draft'
        ? videoMode === 'scenic'
          ? 'wan_2_7_r2v'
          : 'minimax_hailuo_2_3'
        : videoMode === 'scenic'
          ? 'wan_2_7_r2v'
          : 'kling_3';
    const dialect = resolveVideoDialect(dialectId);
    return {
      tier,
      intent,
      engine: 'ai_video',
      promptMode: 'i2v_motion_only',
      recommendedDialectId: dialectId,
      estimatedUsdPerSec:
        tier === 'draft'
          ? (dialect.costTierHint?.draftUsdPerSec ?? 0.025)
          : (dialect.costTierHint?.finalUsdPerSec ?? 0.17),
      reason:
        tier === 'draft'
          ? '草稿验证档优先低成本快速试跑动作与运镜节奏。'
          : '终渲成片档切换旗舰高画质模型并启用精简 I2V 动作提示词。',
    };
  },

  /** 分发渲染请求：优先调用已注册插件，否则按内置路由返回可执行方案 */
  async dispatch(
    project: Project,
    shot: Shot,
    tier: RenderTier = 'draft',
  ): Promise<ShotRenderDispatchResult> {
    const engine = this.resolveEngine(shot, project);
    const req: ShotRenderDispatchRequest = {
      project,
      shot,
      engine,
      codeRenderSpec: shot.codeRenderSpec ?? null,
      tier,
    };

    const plugin = registeredPlugins.get(engine);
    if (plugin) {
      return await plugin(req);
    }

    if (engine === 'html_hyperframes' || engine === 'manim') {
      return {
        handled: false,
        engine,
        kind: 'unimplemented_plugin',
        message: `该镜头已标记为「${engine}」代码渲染，等待挂载对应外部渲染插件；已透传 codeRenderSpec。`,
        codeRenderSpec: req.codeRenderSpec,
      };
    }

    if (engine === 'ai_image_kenburns') {
      return {
        handled: true,
        engine,
        kind: 'kenburns_still',
        message: '使用关键帧静帧配合平滑推拉动效输出。',
      };
    }

    return {
      handled: true,
      engine,
      kind: 'ai_pipeline',
      message: `已路由至现有 AI 视频引擎（${engine} · ${tier === 'draft' ? '草稿档' : '终渲档'}）。`,
    };
  },
};
