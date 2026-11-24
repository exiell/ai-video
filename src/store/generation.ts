import { create } from 'zustand';
import { useAppStore } from './app';
import { buildGenerateContext } from '../services/llm/readiness';
import {
  describeFailure,
  discussStory,
  generateAssets,
  generateShots,
  generateStory,
  generateStyleTags,
} from '../services/llm/generate';
import { assetsFromGenerated, shotsFromGenerated, storyFromGenerated } from '../services/llm/mapping';
import { newId } from '../services/storage';
import { formatRagHitsForPrompt, searchKnowledge } from '../services/rag';
import { formatWebResultsForPrompt, searchWeb } from '../services/search/webSearch';
import type { CreativeContext, StoryChatTurn } from '../types/model';

/**
 * 生成状态（方案.md v0.6 §3.2 M1/M2）
 *
 * 单独一个 store 的原因：生成是异步的、会失败、会有「重试过一次」这类提示，
 * 这些状态不属于项目数据本身，混进 app store 会让「项目是否被改动」的判断变复杂。
 */

export type GenerationTask = 'story' | 'assets' | 'shots' | 'style';
export type PipelineStage = 'style' | 'assets' | 'shots';

export interface PipelineState {
  running: boolean;
  currentStage: PipelineStage | null;
  completed: PipelineStage[];
  failedStage?: PipelineStage;
  error?: string;
  detail?: string;
  summary?: string;
}

export interface TaskFeedback {
  kind: 'ok' | 'error' | 'info';
  message: string;
  /** 失败细节，收在折叠区 */
  detail?: string;
  /** 模型返回的原始内容。排查「格式不对」时唯一有用的东西。 */
  raw?: string;
  /** 生成过程里的非致命提示，例：自动重试过、有引用对不上 */
  warnings: string[];
  attempts?: number;
}

interface GenerationState {
  pending: GenerationTask | null;
  feedback: Partial<Record<GenerationTask, TaskFeedback>>;
  storyChatPending: boolean;
  storyChatError: string | null;
  pipeline: PipelineState | null;

  clearFeedback: (task: GenerationTask) => void;
  runStory: () => Promise<void>;
  runAssets: () => Promise<void>;
  runShots: () => Promise<void>;
  /**
   * 把中文「风格倾向」翻成英文风格关键词，并**直接写回项目**。
   *
   * 为什么要写回而不是只返回给页面：风格词是项目数据的一部分（会进每一张图的提示词），
   * 让页面自己 patch 会让「谁负责落盘」变得模糊。这里和其它三个任务保持一致：
   * 生成结果由 store 负责写进项目。
   */
  runStyleTags: () => Promise<void>;
  /** 故事页多轮共创对话：支持 RAG 资料库与联网搜索，结果持久化到 project.creativeContext */
  sendStoryChat: (
    message: string,
    options?: { useRag?: boolean; useWebSearch?: boolean },
  ) => Promise<void>;
  clearStoryChat: () => void;
  setConsensusSummary: (summary: string) => void;
  /** 一键串联生成：补风格词（如需） → 拆角色与场景 → 生成分镜 */
  runFullPipeline: (options?: { startFrom?: PipelineStage }) => Promise<boolean>;
  clearPipeline: () => void;
}

function currentCreativeContext(project: { creativeContext?: CreativeContext }): CreativeContext {
  return {
    storyChat: project.creativeContext?.storyChat ?? [],
    consensusSummary: project.creativeContext?.consensusSummary ?? '',
  };
}

export const useGeneration = create<GenerationState>((set, get) => ({
  pending: null,
  feedback: {},
  storyChatPending: false,
  storyChatError: null,
  pipeline: null,

  clearFeedback: (task) =>
    set((state) => {
      const feedback = { ...state.feedback };
      delete feedback[task];
      return { feedback };
    }),

  runStory: async () => {
    const { project } = useAppStore.getState();
    if (!project || useGeneration.getState().pending) return;

    const built = buildGenerateContext();
    if ('error' in built) {
      set((s) => ({
        feedback: { ...s.feedback, story: { kind: 'error', message: built.error, warnings: [] } },
      }));
      return;
    }

    set((s) => ({ pending: 'story', feedback: { ...s.feedback, story: undefined } }));
    const outcome = await generateStory(project, built.ctx);
    set({ pending: null });

    if (!outcome.ok || !outcome.data) {
      set((s) => ({
        feedback: {
          ...s.feedback,
          story: {
            kind: 'error',
            message: describeFailure(outcome),
            warnings: outcome.warnings,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
            ...(outcome.raw ? { raw: outcome.raw } : {}),
          },
        },
      }));
      return;
    }

    const story = storyFromGenerated(outcome.data, project.story);
    useAppStore.getState().patchStory(story);
    set((s) => ({
      feedback: {
        ...s.feedback,
        story: {
          kind: 'ok',
          message: `故事已生成：${story.scenes.length} 场戏，${
            outcome.attempts === 1 ? '一次成功' : `重试 ${outcome.attempts - 1} 次后成功`
          }。`,
          warnings: outcome.warnings,
          attempts: outcome.attempts,
        },
      },
    }));
  },

  runAssets: async () => {
    const { project } = useAppStore.getState();
    if (!project || useGeneration.getState().pending) return;

    const built = buildGenerateContext();
    if ('error' in built) {
      set((s) => ({
        feedback: { ...s.feedback, assets: { kind: 'error', message: built.error, warnings: [] } },
      }));
      return;
    }

    set((s) => ({ pending: 'assets', feedback: { ...s.feedback, assets: undefined } }));
    const outcome = await generateAssets(project, built.ctx);
    set({ pending: null });

    if (!outcome.ok || !outcome.data) {
      set((s) => ({
        feedback: {
          ...s.feedback,
          assets: {
            kind: 'error',
            message: describeFailure(outcome),
            warnings: outcome.warnings,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
            ...(outcome.raw ? { raw: outcome.raw } : {}),
          },
        },
      }));
      return;
    }

    const mapping = assetsFromGenerated(outcome.data);
    useAppStore.getState().patchProject({
      characters: mapping.characters,
      scenes: mapping.scenes,
    });
    set((s) => ({
      feedback: {
        ...s.feedback,
        assets: {
          kind: 'ok',
          message: `已生成 ${mapping.characters.length} 个角色、${mapping.scenes.length} 个场景，并自动写好了连续性锁。`,
          warnings: outcome.warnings,
          attempts: outcome.attempts,
        },
      },
    }));
  },

  runShots: async () => {
    const { project } = useAppStore.getState();
    if (!project || useGeneration.getState().pending) return;

    const built = buildGenerateContext();
    if ('error' in built) {
      set((s) => ({
        feedback: { ...s.feedback, shots: { kind: 'error', message: built.error, warnings: [] } },
      }));
      return;
    }

    set((s) => ({ pending: 'shots', feedback: { ...s.feedback, shots: undefined } }));
    const outcome = await generateShots(project, built.ctx);
    set({ pending: null });

    if (!outcome.ok || !outcome.data) {
      set((s) => ({
        feedback: {
          ...s.feedback,
          shots: {
            kind: 'error',
            message: describeFailure(outcome),
            warnings: outcome.warnings,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
            ...(outcome.raw ? { raw: outcome.raw } : {}),
          },
        },
      }));
      return;
    }

    // 逆映射：模型看到的是 item-N，回抄也是 item-N，这里换回真实 id
    const mapping = {
      characters: project.characters,
      scenes: project.scenes,
      characterIdBySlug: new Map(
        project.characters.map((c, i) => [`item-${i + 1}`, c.id] as const),
      ),
      sceneIdBySlug: new Map(project.scenes.map((s, i) => [`item-${i + 1}`, s.id] as const)),
      lockIdByLabel: new Map([
        ...project.characters.flatMap((c) => c.continuityLocks.map((l) => [l.label, l.id] as const)),
        ...project.scenes.flatMap((s) => s.continuityLocks.map((l) => [l.label, l.id] as const)),
      ]),
      // 锁面的回退索引：模型经常回抄锁面而不是 label，两种都得认
      lockIdByPhrase: new Map([
        ...project.characters.flatMap((c) => c.continuityLocks.map((l) => [l.phrase, l.id] as const)),
        ...project.scenes.flatMap((s) => s.continuityLocks.map((l) => [l.phrase, l.id] as const)),
      ]),
      variantIdByLabel: new Map([
        ...project.characters.flatMap((c) => c.variants.map((v) => [v.label, v.id] as const)),
        ...project.scenes.flatMap((s) => s.variants.map((v) => [v.label, v.id] as const)),
      ]),
    };

    const { shots, warnings } = shotsFromGenerated(
      outcome.data,
      mapping,
      project.story.scenes.map((s) => ({ id: s.id })),
    );
    useAppStore.getState().patchProject({ shots });

    const total = shots.reduce((sum, s) => sum + s.duration, 0);
    set((s) => ({
      feedback: {
        ...s.feedback,
        shots: {
          kind: warnings.length > 0 ? 'info' : 'ok',
          message: `已生成 ${shots.length} 个镜头，总时长 ${total} 秒。${
            warnings.length > 0 ? `有 ${warnings.length} 处引用对不上，已标出。` : '去穿帮检查看看有没有问题。'
          }`,
          warnings: [...outcome.warnings, ...warnings],
          attempts: outcome.attempts,
        },
      },
    }));
  },

  runStyleTags: async () => {
    const { project } = useAppStore.getState();
    if (!project || useGeneration.getState().pending) return;

    if (!project.brief.styleTone.trim()) {
      set((s) => ({
        feedback: {
          ...s.feedback,
          style: {
            kind: 'info',
            message: '先在上面写一句中文的风格倾向，比如「水墨写意 + 冷色调，厚重衣物质感」，再来生成关键词。',
            warnings: [],
          },
        },
      }));
      return;
    }

    const built = buildGenerateContext();
    if ('error' in built) {
      set((s) => ({
        feedback: { ...s.feedback, style: { kind: 'error', message: built.error, warnings: [] } },
      }));
      return;
    }

    set((s) => ({ pending: 'style', feedback: { ...s.feedback, style: undefined } }));
    const outcome = await generateStyleTags(project, built.ctx);
    set({ pending: null });

    if (!outcome.ok || !outcome.data) {
      set((s) => ({
        feedback: {
          ...s.feedback,
          style: {
            kind: 'error',
            message: describeFailure(outcome),
            warnings: outcome.warnings,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
            ...(outcome.raw ? { raw: outcome.raw } : {}),
          },
        },
      }));
      return;
    }

    const tags = outcome.data.tags;
    if (tags.length === 0) {
      set((s) => ({
        feedback: {
          ...s.feedback,
          style: {
            kind: 'error',
            message: '模型给回来的词都没法用在提示词里（太长或重复）。换个模型，或者把风格倾向写具体一点再试。',
            warnings: outcome.warnings,
          },
        },
      }));
      return;
    }

    useAppStore.getState().patchBrief({ styleTags: tags });
    set((s) => ({
      feedback: {
        ...s.feedback,
        style: {
          kind: 'ok',
          message: `已生成 ${tags.length} 条英文风格关键词，并应用到项目。之后出的图都会带上它们。`,
          warnings: outcome.warnings,
          attempts: outcome.attempts,
        },
      },
    }));
  },

  sendStoryChat: async (message, options) => {
    const text = message.trim();
    const { project } = useAppStore.getState();
    if (!text || !project || get().storyChatPending) return;

    const built = buildGenerateContext();
    if ('error' in built) {
      set({ storyChatError: built.error });
      return;
    }

    const existing = currentCreativeContext(project);
    const userTurn: StoryChatTurn = {
      id: newId('sc'),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    const nextChatWithUser = [...existing.storyChat, userTurn];
    useAppStore.getState().patchProject({
      creativeContext: { ...existing, storyChat: nextChatWithUser },
    });

    set({ storyChatPending: true, storyChatError: null });

    const useRag = options?.useRag !== false;
    const useWebSearch = Boolean(options?.useWebSearch);
    const ragHits = useRag ? await searchKnowledge(text, project.id, 4) : [];
    const webRes = useWebSearch ? await searchWeb(text, { limit: 5 }) : null;
    const webSources = webRes?.ok ? webRes.results : [];
    const referenceBlock = [
      formatRagHitsForPrompt(ragHits),
      formatWebResultsForPrompt(webSources),
    ]
      .filter(Boolean)
      .join('\n\n');

    const latestProject = useAppStore.getState().project ?? project;
    const result = await discussStory(
      latestProject,
      text,
      built.ctx,
      referenceBlock || undefined,
    );

    if (!result.ok || !result.reply) {
      set({
        storyChatPending: false,
        storyChatError: result.error ?? '对话请求失败，请检查模型配置后重试。',
      });
      return;
    }

    const afterProject = useAppStore.getState().project;
    if (afterProject) {
      const latestCtx = currentCreativeContext(afterProject);
      const assistantTurn: StoryChatTurn = {
        id: newId('sc'),
        role: 'assistant',
        content: result.reply,
        createdAt: new Date().toISOString(),
        ...(webSources.length > 0 ? { webSources } : {}),
        ...(ragHits.length > 0 ? { ragCount: ragHits.length } : {}),
      };
      useAppStore.getState().patchProject({
        creativeContext: {
          ...latestCtx,
          storyChat: [...latestCtx.storyChat, assistantTurn],
        },
      });
    }
    set({
      storyChatPending: false,
      storyChatError: webRes && !webRes.ok ? (webRes.error ?? null) : null,
    });
  },

  clearStoryChat: () => {
    const { project } = useAppStore.getState();
    if (!project) return;
    const existing = currentCreativeContext(project);
    useAppStore.getState().patchProject({
      creativeContext: { ...existing, storyChat: [] },
    });
    set({ storyChatError: null });
  },

  setConsensusSummary: (summary) => {
    const { project } = useAppStore.getState();
    if (!project) return;
    const existing = currentCreativeContext(project);
    useAppStore.getState().patchProject({
      creativeContext: { ...existing, consensusSummary: summary },
    });
  },

  clearPipeline: () => set({ pipeline: null }),

  runFullPipeline: async (options) => {
    const initialProject = useAppStore.getState().project;
    if (!initialProject || get().pending || get().pipeline?.running) return false;

    if (!initialProject.story.body.trim()) {
      set({
        pipeline: {
          running: false,
          currentStage: null,
          completed: [],
          failedStage: 'assets',
          error: '请先在第 1 步写完或生成故事正文，再连续生成角色、场景与分镜。',
        },
      });
      return false;
    }

    const built = buildGenerateContext();
    if ('error' in built) {
      set({
        pipeline: {
          running: false,
          currentStage: null,
          completed: [],
          failedStage: options?.startFrom ?? 'assets',
          error: built.error,
        },
      });
      return false;
    }

    const startFrom = options?.startFrom ?? 'style';
    const completed: PipelineStage[] = [];
    if (startFrom === 'assets') completed.push('style');
    if (startFrom === 'shots') completed.push('style', 'assets');

    // 第 1 步：若写了中文风格倾向但尚无英文风格词，先自动补齐
    if (startFrom === 'style') {
      const p1 = useAppStore.getState().project;
      const needsStyle =
        Boolean(p1?.brief.styleTone.trim()) && (p1?.brief.styleTags.length ?? 0) === 0;
      if (needsStyle && p1) {
        set({
          pending: 'style',
          pipeline: { running: true, currentStage: 'style', completed: [...completed] },
        });
        const styleOutcome = await generateStyleTags(p1, built.ctx);
        if (!styleOutcome.ok || !styleOutcome.data || styleOutcome.data.tags.length === 0) {
          set({
            pending: null,
            pipeline: {
              running: false,
              currentStage: null,
              completed: [...completed],
              failedStage: 'style',
              error: styleOutcome.ok
                ? '没能生成有效的英文风格词，请把风格倾向写具体后重试。'
                : describeFailure(styleOutcome),
            },
          });
          return false;
        }
        useAppStore.getState().patchBrief({ styleTags: styleOutcome.data.tags });
      }
      completed.push('style');
    }

    // 第 2 步：携带故事与对话上下文生成角色与场景
    if (startFrom === 'style' || startFrom === 'assets') {
      const p2 = useAppStore.getState().project;
      if (!p2) return false;
      set({
        pending: 'assets',
        pipeline: { running: true, currentStage: 'assets', completed: [...completed] },
      });
      const assetsOutcome = await generateAssets(p2, built.ctx);
      if (!assetsOutcome.ok || !assetsOutcome.data) {
        set({
          pending: null,
          pipeline: {
            running: false,
            currentStage: null,
            completed: [...completed],
            failedStage: 'assets',
            error: describeFailure(assetsOutcome),
          },
        });
        return false;
      }
      const mapping = assetsFromGenerated(assetsOutcome.data);
      useAppStore.getState().patchProject({
        characters: mapping.characters,
        scenes: mapping.scenes,
      });
      completed.push('assets');
    }

    // 第 3 步：基于最新角色、场景与对话上下文生成完整分镜
    // 连续重型调用之间短暂退避（1.5s），避免触发厂商 RPM/突发限流；若仍遇瞬态限流/服务繁忙则自动退避重试一次
    if (startFrom !== 'shots') {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    const p3 = useAppStore.getState().project;
    if (!p3) return false;
    set({
      pending: 'shots',
      pipeline: { running: true, currentStage: 'shots', completed: [...completed] },
    });
    const freshBuilt = buildGenerateContext();
    const shotsCtx = 'error' in freshBuilt ? built.ctx : freshBuilt.ctx;
    let shotsOutcome = await generateShots(p3, shotsCtx);
    if (
      !shotsOutcome.ok &&
      /限流|rate-limit|429|繁忙|server|502|503|超时|timeout/i.test(
        `${shotsOutcome.error ?? ''} ${shotsOutcome.detail ?? ''}`,
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      shotsOutcome = await generateShots(p3, shotsCtx);
    }
    if (!shotsOutcome.ok || !shotsOutcome.data) {
      set({
        pending: null,
        pipeline: {
          running: false,
          currentStage: null,
          completed: [...completed],
          failedStage: 'shots',
          error: describeFailure(shotsOutcome),
          ...(shotsOutcome.detail ? { detail: shotsOutcome.detail } : {}),
        },
      });
      return false;
    }

    const shotSlugMapping = {
      characters: p3.characters,
      scenes: p3.scenes,
      characterIdBySlug: new Map(
        p3.characters.map((c, i) => [`item-${i + 1}`, c.id] as const),
      ),
      sceneIdBySlug: new Map(p3.scenes.map((s, i) => [`item-${i + 1}`, s.id] as const)),
      lockIdByLabel: new Map([
        ...p3.characters.flatMap((c) => c.continuityLocks.map((l) => [l.label, l.id] as const)),
        ...p3.scenes.flatMap((s) => s.continuityLocks.map((l) => [l.label, l.id] as const)),
      ]),
      lockIdByPhrase: new Map([
        ...p3.characters.flatMap((c) => c.continuityLocks.map((l) => [l.phrase, l.id] as const)),
        ...p3.scenes.flatMap((s) => s.continuityLocks.map((l) => [l.phrase, l.id] as const)),
      ]),
      variantIdByLabel: new Map([
        ...p3.characters.flatMap((c) => c.variants.map((v) => [v.label, v.id] as const)),
        ...p3.scenes.flatMap((s) => s.variants.map((v) => [v.label, v.id] as const)),
      ]),
    };
    const shotMapping = shotsFromGenerated(
      shotsOutcome.data,
      shotSlugMapping,
      p3.story.scenes.map((s) => ({ id: s.id })),
    );
    useAppStore.getState().patchProject({ shots: shotMapping.shots });
    completed.push('shots');

    const finalProject = useAppStore.getState().project;
    const summary = finalProject
      ? `已连续生成：${finalProject.characters.length} 个角色、${finalProject.scenes.length} 个场景、${finalProject.shots.length} 个镜头。`
      : '全部生成完成。';

    set({
      pending: null,
      pipeline: {
        running: false,
        currentStage: null,
        completed: [...completed],
        summary,
      },
    });
    return true;
  },
}));
