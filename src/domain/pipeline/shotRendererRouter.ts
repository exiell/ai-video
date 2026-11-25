import type { Project, Shot, ShotRenderEngine } from '../../types/model';
import { resolveVideoMode } from '../pipeline/profiles';

/**
 * 分镜级混合渲染路由器（Phase 4 · 二期代码渲染扩展接口）
 *
 * 一期将 ai_video / ai_first_last_frame / ai_ref_to_video / ai_image_kenburns
 * 映射至现有图像与视频管线；同时为 html_hyperframes（HTML/SVG 转 MP4）与
 * manim（STEM 公式动画）暴露清晰的插件注册接口与 codeRenderSpec 透传契约。
 */

export interface ShotRenderDispatchRequest {
  project: Project;
  shot: Shot;
  engine: ShotRenderEngine;
  codeRenderSpec: string | null;
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

  /** 分发渲染请求：优先调用已注册插件，否则按内置路由返回可执行方案 */
  async dispatch(project: Project, shot: Shot): Promise<ShotRenderDispatchResult> {
    const engine = this.resolveEngine(shot, project);
    const req: ShotRenderDispatchRequest = {
      project,
      shot,
      engine,
      codeRenderSpec: shot.codeRenderSpec ?? null,
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
      message: `已路由至现有 AI 视频引擎（${engine}）。`,
    };
  },
};
