import { create } from 'zustand';
import { useAppStore } from './app';
import { buildGenerateContext } from '../services/llm/readiness';
import {
  describeFailure,
  generateAssets,
  generateShots,
  generateStory,
  generateStyleTags,
} from '../services/llm/generate';
import { assetsFromGenerated, shotsFromGenerated, storyFromGenerated } from '../services/llm/mapping';

/**
 * 生成状态（方案.md v0.6 §3.2 M1/M2）
 *
 * 单独一个 store 的原因：生成是异步的、会失败、会有「重试过一次」这类提示，
 * 这些状态不属于项目数据本身，混进 app store 会让「项目是否被改动」的判断变复杂。
 */

export type GenerationTask = 'story' | 'assets' | 'shots' | 'style';

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
}

export const useGeneration = create<GenerationState>((set) => ({
  pending: null,
  feedback: {},

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
          message: `已生成 ${tags.length} 条英文风格关键词，并应用到项目——之后出的图都会带上它们。`,
          warnings: outcome.warnings,
          attempts: outcome.attempts,
        },
      },
    }));
  },
}));
