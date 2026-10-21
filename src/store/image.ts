import { create } from 'zustand';
import type { StoreApi } from 'zustand';
import type { Asset, ModelProfile } from '../types/model';
import { ASSET_KIND_LABEL } from '../types/model';
import {
  REFERENCE_ROLE_LABEL,
  planReferenceImages,
  previousShotOf,
  referenceRolesOf,
  type ReferenceRole,
} from '../domain/image/referencePlan';
import { useAppStore } from './app';
import { currentTransport, useSettings } from './settings';
import { findProfile, DEFAULT_REFERENCE_PROFILE_ID, DEFAULT_T2I_PROFILE_ID } from '../data/models/profiles';
import { generateImages, toAssets, type GenerateImagesOutcome } from '../services/image/generate';
import {
  buildCharacterSheetPrompt,
  buildFramePrompt,
  type FrameKind,
  buildScenePlatePrompt,
  type ImagePromptInput,
} from '../domain/image/prompts';
import { deleteAsset, listAssets, listAssetsFor, saveAssets } from '../services/storage';
import {
  type CharacterSheetKind,
} from '../domain/image/characterSheet';

/**
 * 出图编排（方案.md §7.4 P0.5）
 *
 * 这一层的职责只有一件事：**把「用户点了生成」变成「图安全地存在本地了」**。
 * 中间任何一步失败，都要给出用户能理解的下一步，而不是抛一句英文错误。
 *
 * 特别处理的两件事：
 *  - 平台返回的链接 24 小时失效 → 必须下载留存（由 generate.ts 强制）
 *  - 参考图（L3 锚定）→ 用已生成的定妆图当参考图，这是本工具一致性最好的一级
 */

export type ImageTaskKind =
  | 'character-sheet'
  | 'character-sheet-face'
  | 'scene-plate'
  | 'first-frame'
  | 'action-peak'
  | 'end-frame';

export interface ImageTaskFeedback {
  kind: 'ok' | 'error' | 'info';
  message: string;
  warnings: string[];
  detail?: string;
}

export interface BatchProgress {
  /** 整批在做什么，例：「角色形象图（3 个角色）」 */
  label: string;
  /** 当前这一张是什么，例：「角色「小狗」· 全身多视图」 */
  current: string;
  done: number;
  total: number;
  failed: number;
}

interface ImageState {
  /** 正在进行的任务键，格式 `${kind}:${refId}` */
  pending: string | null;
  /** 允许 undefined：清空任务反馈时会把键置空，而不是留一条空消息 */
  feedback: Record<string, ImageTaskFeedback | undefined>;
  /** refId → 素材列表 */
  gallery: Record<string, Asset[]>;
  /**
   * 本项目已经生成并存在本机的图片总数。
   *
   * 为什么单独记一个数：改风格前要提示「你有 N 张图会是旧风格」，
   * 而 `gallery` 是按 refId 分片加载的，随时可能不全。这个数在每次生成 /
   * 删除 / 进项目时刷新，是**项目级的准确值**。
   */
  assetCount: number;
  /**
   * 按素材类型统计的数量（v0.44）。
   *
   * 用途：判断「上一镜的尾帧到底出了没有」。批量出首帧时，如果尾帧一张都没有，
   * 首帧就接不住上一镜——而这不会报错，只是默默降级。
   * 有了这个数才能在按钮上提前说清楚。
   */
  assetCounts: Partial<Record<Asset['kind'], number>>;
  /** 批量生成进度。非空表示正在批量跑。 */
  batch: BatchProgress | null;
  /** 批量完成后的总结 */
  batchSummary: string | null;

  loadGallery: (refId: string) => Promise<void>;
  /** 重新统计本项目图片总数（进项目、生成完、删除后调用） */
  refreshAssetCount: () => Promise<void>;
  /**
   * 按**镜头顺序**一次出完三帧：第 1 镜首帧 → 关键帧 → 尾帧，再第 2 镜……
   *
   * 为什么不按「帧类型」分批（v0.44 修）：
   * 参考图的依赖是
   *   本镜首帧 ← 上一镜尾帧（承接时）
   *   本镜关键帧/尾帧 ← 本镜首帧
   * 先跑「全部首帧」时所有尾帧都还不存在，于是每一镜的首帧都**悄悄丢了**
   * 跨镜衔接这个最强的锚点；而首帧又是另外两帧的锚点，误差会一路传下去。
   */
  generateAllFramesInOrder: () => Promise<void>;
  clearFeedback: (key: string) => void;
  removeAsset: (refId: string, assetId: string) => Promise<void>;

  generateForCharacter: (
    characterId: string,
    useReference?: boolean,
    kind?: CharacterSheetKind,
  ) => Promise<void>;

  /** 批量生成：所有角色的形象图（先全身再多视图，再头部特写） */
  generateAllCharacterSheets: () => Promise<void>;
  /** 批量生成：所有场景的参考板 */
  generateAllScenePlates: () => Promise<void>;
  /** 批量生成：所有镜头的关键帧（带参考图锚定） */
  /**
   * 批量生成所有镜头的指定帧。
   *
   * 三种帧分别批量，而不是一次全跑：首帧是视频生成的输入图，必须先有；
   * 动作关键帧与尾帧是锦上添花，预算有限时可以后补。
   */
  generateAllFrames: (kind: FrameKind) => Promise<void>;
  clearBatchSummary: () => void;
  generateForScene: (sceneId: string) => Promise<void>;
  /** 生成镜头的某一帧（首帧 / 动作关键帧 / 尾帧） */
  generateForFrame: (shotId: string, kind: FrameKind, useReference?: boolean) => Promise<void>;
}

/**
 * 各参考图职责的英文说法，用于提示词里的「Image 1 is …」。
 *
 * 必须与 REFERENCE_ROLE_LABEL 的语义一致，但**要写成模型能读懂的描述**
 * 而不是给人看的短标签——「锁构图与机位」这种说法模型读了没有用。
 */
const REFERENCE_ROLE_PHRASE: Record<ReferenceRole, string> = {
  'own-first-frame': 'the first frame of this very shot, defining its camera angle and framing',
  'previous-end-frame': 'the last frame of the immediately preceding shot, defining the space and lighting you continue from',
  'character-sheet': 'the character design sheet, defining face, hairstyle, body proportions and outfit',
  'scene-plate': 'the empty scene reference plate, defining the location layout, fixed objects and light direction',
};

const FRAME_BATCH_LABEL: Record<FrameKind, string> = {
  'first-frame': '首帧',
  'action-peak': '动作关键帧',
  'end-frame': '尾帧',
};

function taskKey(kind: ImageTaskKind, refId: string): string {
  return `${kind}:${refId}`;
}

/**
 * 取当前用于出图的档案与 Key。
 *
 * 返回类型刻意用扁平的 { ok, error?, profile?, apiKey? }，
 * 而不是联合类型 —— 联合类型会让 error 的推断带上多余的 undefined，
 * 上层就没法直接把 error 当成 string 用。
 */
interface ResolvedImageProfile {
  ok: boolean;
  error?: string;
  profile?: ModelProfile;
  apiKey?: string;
}

function resolveImageProfile(preferReference: boolean): ResolvedImageProfile {
  const prefs = useSettings.getState().prefs;
  const keys = useSettings.getState().keys;

  const referenceId = prefs.defaultReferenceProfileId || DEFAULT_REFERENCE_PROFILE_ID;
  const plainId = prefs.defaultT2iProfileId || DEFAULT_T2I_PROFILE_ID;
  const profile = findProfile(preferReference ? referenceId : plainId) ?? findProfile(plainId);

  if (!profile) {
    return { ok: false, error: '没有可用的出图档案。' };
  }
  const apiKey = (keys[profile.vendorId ?? ''] ?? '').trim();
  if (apiKey.length === 0) {
    return {
      ok: false,
      error: `还没有填「${profile.name}」的 API Key。去「设置」页填上并点「测试连接」确认能通。`,
    };
  }
  return { ok: true, profile, apiKey };
}

export const useImage = create<ImageState>((set, get) => ({
  pending: null,
  feedback: {},
  gallery: {},
  assetCount: 0,
  assetCounts: {},
  batch: null,
  batchSummary: null,

  refreshAssetCount: async () => {
    const project = useAppStore.getState().project;
    if (!project) {
      set({ assetCount: 0, assetCounts: {} });
      return;
    }
    try {
      const all = await listAssets(project.id);
      if (typeof window === 'undefined') return;
      const withImage = all.filter((a) => a.dataUrl);
      const counts: Partial<Record<Asset['kind'], number>> = {};
      for (const asset of withImage) {
        counts[asset.kind] = (counts[asset.kind] ?? 0) + 1;
      }
      set({ assetCount: withImage.length, assetCounts: counts });
    } catch {
      // 统计失败不该影响主流程：保守地保留旧值
    }
  },

  loadGallery: async (refId) => {
    const project = useAppStore.getState().project;
    if (!project) return;
    const assets = await listAssetsFor(project.id, refId);
    // 测试环境或页面在异步查询完成前被销毁时，不要再触发 React 更新。
    if (typeof window === 'undefined') return;
    set((s) => ({ gallery: { ...s.gallery, [refId]: assets } }));
  },

  clearFeedback: (key) =>
    set((s) => {
      const feedback = { ...s.feedback };
      delete feedback[key];
      return { feedback };
    }),

  removeAsset: async (refId, assetId) => {
    await deleteAsset(assetId);
    await get().loadGallery(refId);
    await get().refreshAssetCount();
  },

  generateForCharacter: async (characterId, useReference = false, kind = 'turnaround') => {
    const project = useAppStore.getState().project;
    if (!project) return;
    const key = taskKey(kind === 'face' ? 'character-sheet-face' : 'character-sheet', characterId);
    if (get().pending) return;

    const prompt = buildCharacterSheetPrompt(project, characterId, kind);
    if (!prompt) return;

    // 出头部特写时可以拿已有的全身图当参考，保证脸和身体是同一个人；
    // 反过来出全身图时也可以拿头部特写当参考。这样两张图互相锚定。
    let referenceImages: string[] = [];
    if (useReference) {
      const existing = await listAssetsFor(project.id, characterId);
      const opposite = existing.filter((asset) =>
        kind === 'face' ? asset.kind === 'character-sheet' : asset.kind === 'character-sheet-face',
      );
      referenceImages = opposite
        .filter((a): a is typeof a & { dataUrl: string } => Boolean(a.dataUrl))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 1)
        .map((a) => a.dataUrl);
    }

    await runGeneration({
      key,
      draft: {
        projectId: project.id,
        kind: kind === 'face' ? 'character-sheet-face' : 'character-sheet',
        refId: characterId,
        promptSnapshot: prompt.positive,
        lockPhrases: prompt.lockPhrases,
        styleTags: [...project.brief.styleTags],
      },
      prompt,
      preferReference: useReference || referenceImages.length > 0,
      referenceImages,
      set,
      get,
    });
  },

  generateForScene: async (sceneId) => {
    const project = useAppStore.getState().project;
    if (!project) return;
    const key = taskKey('scene-plate', sceneId);
    if (get().pending) return;

    const prompt = buildScenePlatePrompt(project, sceneId);
    if (!prompt) return;

    await runGeneration({
      key,
      draft: {
        projectId: project.id,
        kind: 'scene-plate',
        refId: sceneId,
        promptSnapshot: prompt.positive,
        lockPhrases: prompt.lockPhrases,
        styleTags: [...project.brief.styleTags],
      },
      prompt,
      preferReference: false,
      referenceImages: [],
      set,
      get,
    });
  },

  clearBatchSummary: () => set({ batchSummary: null }),

  generateAllCharacterSheets: async () => {
    const project = useAppStore.getState().project;
    if (!project || get().batch) return;
    const characters = project.characters;
    if (characters.length === 0) {
      set({ batchSummary: '还没有角色，先去「角色设定」建一个。' });
      return;
    }

    await runBatch(
      `角色形象图（${characters.length} 个角色）`,
      characters.length * 2,
      set,
      async (onStep) => {
        let failed = 0;
        for (const character of characters) {
          // 先全身多视图：它给后续的头部特写当参考，顺序不能反
          onStep(`角色「${character.name}」· 全身多视图`);
          await get().generateForCharacter(character.id, false, 'turnaround');

          // 再头部特写，并拿刚出的全身图当参考，保证两张图是同一个人
          onStep(`角色「${character.name}」· 头部特写`);
          await get().generateForCharacter(character.id, true, 'face');

          // 全身与头部特写各自判成败：两张要的是不同的东西，不能互相掩盖
          if (!succeeded('character-sheet', character.id)) failed += 1;
          if (!succeeded('character-sheet-face', character.id)) failed += 1;
        }
        return failed;
      },
    );
  },

  generateAllScenePlates: async () => {
    const project = useAppStore.getState().project;
    if (!project || get().batch) return;
    const scenes = project.scenes;
    if (scenes.length === 0) {
      set({ batchSummary: '还没有场景，先去「场景设定」建一个。' });
      return;
    }
    await runBatch(`场景参考板（${scenes.length} 个场景）`, scenes.length, set, async (onStep) => {
      let failed = 0;
      for (const scene of scenes) {
        onStep(`场景「${scene.name}」`);
        await get().generateForScene(scene.id);
        if (!succeeded('scene-plate', scene.id)) failed += 1;
      }
      return failed;
    });
  },

  generateAllFrames: async (kind) => {
    const project = useAppStore.getState().project;
    if (!project || get().batch) return;
    const shots = project.shots;
    if (shots.length === 0) {
      set({ batchSummary: '还没有镜头，先生成分镜表。' });
      return;
    }
    const label = `全部${FRAME_BATCH_LABEL[kind]}（${shots.length} 个镜头）`;
    await runBatch(label, shots.length, set, async (onStep) => {
      let failed = 0;
      for (const shot of shots) {
        onStep(`第 ${shot.number} 镜 · ${FRAME_BATCH_LABEL[kind]}`);
        // 一律带参考图锚定：三种帧必须是同一个人、同一处地方
        await get().generateForFrame(shot.id, kind, true);
        if (!succeeded(kind, shot.id)) failed += 1;
      }
      return failed;
    });
  },

  /**
   * 按镜头顺序出三帧。
   *
   * 顺序不可换：第 N 镜的尾帧必须先于第 N+1 镜的首帧存在，
   * 否则第 N+1 镜的首帧拿不到「上一镜尾帧」这个锚点，跨镜就接不住。
   * 而每一镜内部必须是 首帧 → 关键帧/尾帧，因为后两帧以首帧为构图锚点。
   */
  generateAllFramesInOrder: async () => {
    const project = useAppStore.getState().project;
    if (!project || get().batch) return;
    const shots = project.shots;
    if (shots.length === 0) {
      set({ batchSummary: '还没有镜头，先生成分镜表。' });
      return;
    }

    const order: FrameKind[] = ['first-frame', 'action-peak', 'end-frame'];
    await runBatch(
      `全部三帧（${shots.length} 个镜头，按镜头顺序）`,
      shots.length * order.length,
      set,
      async (onStep) => {
        let failed = 0;
        for (const shot of shots) {
          for (const kind of order) {
            onStep(`第 ${shot.number} 镜 · ${FRAME_BATCH_LABEL[kind]}`);
            await get().generateForFrame(shot.id, kind, true);
            if (!succeeded(kind, shot.id)) failed += 1;
          }
        }
        return failed;
      },
    );
  },

  generateForFrame: async (shotId, kind, useReference = true) => {
    const project = useAppStore.getState().project;
    if (!project) return;
    const key = taskKey(kind, shotId);
    if (get().pending) return;

    const prompt = buildFramePrompt(project, shotId, kind);
    if (!prompt) return;

    const referenceImages: string[] = [];
    const referenceLabels: string[] = [];
    let referenceRoles: ReferenceRole[] = [];
    /** 因风格不符被跳过的参考图，生成完要如实告诉用户 */
    let staleRoles: ReferenceRole[] = [];
    if (useReference) {
      const shot = project.shots.find((s) => s.id === shotId);
      const previous = previousShotOf(project, shotId);
      const resolved = resolveImageProfile(true);
      const caps = resolved.profile?.capabilities ?? {
        negativePrompt: false,
        seed: false,
        referenceImage: false,
        maxReferenceImages: 0,
        maxOutputImages: 1,
      };

      // -----------------------------------------------------------------
      // 参考图编排（取舍规则都在 planReferenceImages 里，可读可测）
      // -----------------------------------------------------------------
      // 最重要的一条：**上一镜尾帧只在两镜确实连续时才用**。
      // 跳切时把上一镜尾帧当参考图，等于把两个不该相连的镜头强行焊在一起，
      // 会同时毁掉两边——本镜构图被拉向上一镜，上一镜的空间被搬进新场景。
      const ownFrames = await listAssetsFor(project.id, shotId);
      const previousFrames = previous ? await listAssetsFor(project.id, previous.id) : undefined;
      const characterSheets: Awaited<ReturnType<typeof listAssetsFor>>[] = [];
      for (const characterId of shot?.characterIds ?? []) {
        characterSheets.push(await listAssetsFor(project.id, characterId));
      }
      const scenePlates = shot?.sceneId
        ? await listAssetsFor(project.id, shot.sceneId)
        : undefined;

      const plan = planReferenceImages({
        kind,
        capabilities: caps,
        previous,
        styleTags: project.brief.styleTags,
        sources: {
          ownFrames,
          ...(previousFrames ? { previousFrames } : {}),
          characterSheets,
          ...(scenePlates ? { scenePlates } : {}),
        },
      });

      for (const slot of plan.slots) {
        referenceImages.push(slot.dataUrl);
        referenceLabels.push(slot.label);
      }
      referenceRoles = referenceRolesOf(plan);
      staleRoles = plan.staleSkipped;
    }
    const frameRole = {
      kind,
      hasFirstFrameAnchor: referenceRoles.includes('own-first-frame'),
      hasPreviousEndAnchor: referenceRoles.includes('previous-end-frame'),
      // 逐张写职责时用的英文说明，必须与传图顺序一致
      roles: referenceRoles.map((role) => REFERENCE_ROLE_PHRASE[role]),
      // 承接镜时用来明说「取景可以改、地方不能动」
      ...(prompt.shotSizeEn ? { shotSizeEn: prompt.shotSizeEn } : {}),
      ...(prompt.cameraPositionEn ? { cameraPositionEn: prompt.cameraPositionEn } : {}),
    };

    /*
      【v0.39 修】这里原来算了第二次 buildFramePrompt，并把三个「锚点」参数传进去。
      但那个函数里是 `void options` —— 参数被丢弃，所以**两次结果完全相同**，
      第二次纯属白算。跟着一起删掉的还有一段说明「有锚点时不再重描角色」的注释，
      它与函数里「角色外观永远注入」的实现相反，会误导后续修改。

      实际策略只有一个：外观**始终**注入。原因记在 prompts.ts 的对应位置。
    */
    await runGeneration({
      key,
      prompt,
      draft: {
        projectId: project.id,
        kind,
        refId: shotId,
        promptSnapshot: prompt.positive,
        lockPhrases: prompt.lockPhrases,
        styleTags: [...project.brief.styleTags],
        referenceCount: referenceImages.length,
        frameRole,
      },
      preferReference: referenceImages.length > 0,
      referenceImages,
      referenceLabels,
      staleSkipped: staleRoles.map((role) => REFERENCE_ROLE_LABEL[role]),
      set,
      get,
    });
  },
}));

interface RunArgs {
  key: string;
  draft: Parameters<typeof toAssets>[1];
  prompt: ImagePromptInput;
  preferReference: boolean;
  referenceImages: string[];
  /** 参考图的中文说明，用于在界面上讲清「用了哪几张、各管什么」 */
  referenceLabels?: string[];
  /**
   * 因为风格和当前不一致而被主动跳过的参考图。
   *
   * 生成成功时也要把它说出来：用户看到的是一张「没有参考图锚定」的图，
   * 如果不说，他会以为参考图机制失灵了。
   */
  staleSkipped?: string[];
  set: StoreApi<ImageState>['setState'];
  get: StoreApi<ImageState>['getState'];
}

/**
 * 覆盖前的确认。
 *
 * 为什么必须有：出图是要花钱的。用户已经有图的情况下再点一次生成，
 * 很可能只是手滑，或者忘了自己已经生成过。**在花钱之前拦一下**，
 * 让他明确知道「这次会覆盖掉已有的图」。
 *
 * 批量生成不走这个确认——那本身就是用户主动发起的批量动作，
 * 每张都弹一次会让批量变得没法用。批量卡片上已经写明了它会做什么。
 */
function confirmOverwrite(refId: string, kind: Asset['kind']): boolean {
  const existing = useImage.getState().gallery[refId] ?? [];
  const sameKind = existing.filter((asset) => asset.kind === kind && asset.dataUrl);
  if (sameKind.length === 0) return true;

  const label = ASSET_KIND_LABEL[kind];
  return window.confirm(
    `这里已经有 ${sameKind.length} 张「${label}」了。\n\n` +
      '继续生成会**新增**一张，旧的仍然保留（可以在图库里对比后删掉不要的）。\n\n' +
      '注意：出图是要花钱的。确定要再生成一张吗？',
  );
}

async function runGeneration(args: RunArgs): Promise<void> {
  const { key, draft, prompt, preferReference, referenceImages, set, get } = args;
  const referenceLabels = args.referenceLabels ?? [];
  const staleSkipped = args.staleSkipped ?? [];
  // 非批量时才确认：批量出图是用户主动发起的，每张都弹窗会没法用
  if (!useImage.getState().batch && !confirmOverwrite(draft.refId, draft.kind)) {
    return;
  }

  const resolved = resolveImageProfile(preferReference);

  if (!resolved.ok || !resolved.profile || !resolved.apiKey) {
    const message = resolved.error ?? '出图模型还没配置好。';
    set((s) => ({
      feedback: { ...s.feedback, [key]: { kind: 'error', message, warnings: [] } },
    }));
    return;
  }

  const { profile, apiKey } = resolved as { profile: ModelProfile; apiKey: string };
  set((s) => ({ pending: key, feedback: { ...s.feedback, [key]: undefined } }));

  const transport = currentTransport();
  const outcome: GenerateImagesOutcome = await generateImages({
    profile,
    apiKey,
    req: {
      prompt: prompt.positive,
      ...(prompt.negative ? { negativePrompt: prompt.negative } : {}),
      aspectRatio: prompt.aspectRatio,
      count: 1,
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
    },
    ...(transport ? { transport } : {}),
  });

  set({ pending: null });

  if (!outcome.ok) {
    set((s) => ({
      feedback: {
        ...s.feedback,
        [key]: {
          kind: 'error',
          message: outcome.error ?? '生成失败。',
          warnings: outcome.warnings,
        },
      },
    }));
    return;
  }

  const built = toAssets(outcome, { ...draft, model: profile.model ?? profile.name });
  if (built.assets.length > 0) {
    await saveAssets(built.assets);
    // 素材存好后立刻刷新图库，用户马上能看到图
    const refId = draft.refId;
    const project = useAppStore.getState().project;
    if (project) {
      const assets = await listAssetsFor(project.id, refId);
      set((s) => ({ gallery: { ...s.gallery, [refId]: assets } }));
      // 总数变了 —— 改风格提示要用它算「有多少张图是旧风格」
      await get().refreshAssetCount();
    }
  }

  const referenceNote =
    referenceLabels.length > 0
      ? `（参考图：${referenceLabels.join('、')}）`
      : referenceImages.length > 0
        ? `（用了 ${referenceImages.length} 张参考图锚定）`
        : '';

  /**
   * 风格改过之后旧图不能当参考图 —— 这件事必须说出来。
   * 不说的话，用户看到的是一张「没有锚定」的图，会以为参考图机制坏了。
   */
  const staleWarnings =
    staleSkipped.length > 0
      ? [
          `有 ${staleSkipped.length} 类旧素材（${[...new Set(staleSkipped)].join('、')}）因为**风格和现在不一致**没有被用作参考图。` +
            '这是一次主动跳过：拿旧风格的图当锚点，会让新图介于两种风格之间，看起来像崩了。' +
            '想彻底换风格，先把角色形象图和场景参考板按新风格重出一遍，再出关键帧。',
        ]
      : [];

  set((s) => ({
    feedback: {
      ...s.feedback,
      [key]: {
        kind:
          built.assets.length === 0
            ? 'error'
            : built.warnings.length > 0 || staleWarnings.length > 0
              ? 'info'
              : 'ok',
        message:
          built.assets.length > 0
            ? `${prompt.subjectLabel}已生成并保存到本机${referenceNote}。`
            : '图生成出来了，但没能下载到本地。请稍后重试。',
        warnings: [...built.warnings, ...staleWarnings],
      },
    },
  }));
}

/**
 * 批量执行的公共外壳。
 *
 * 三条设计取舍：
 *  1. **顺序执行，不并发**。出图接口有限流，并发只会换来 429。
 *  2. **单个失败不中断整批**。跑一半就停会让用户不知道进度到哪了，
 *     也会让他以为剩下的都没生成。失败的计数后在结尾如实报告。
 *  3. **进度可见**。批量运行可能要几分钟，没有进度用户会以为卡死了。
 */
async function runBatch(
  label: string,
  total: number,
  set: StoreApi<ImageState>['setState'],
  work: (onStep: (current: string) => void) => Promise<number>,
): Promise<void> {
  set({ batch: { label, current: '', done: 0, total, failed: 0 }, batchSummary: null });

  /**
   * 标记「开始做下一张」。
   *
   * 注意： 这里曾经写成 `Math.min(done + 1, total)`，而 `done` 是一个永远为 0 的局部变量
   * —— 于是进度永远停在 1/N，直到整批结束才跳到 N。这是闭包固化的经典错误。
   * 正确做法是**基于状态里的当前值自增**，而不是基于一个捕获的常量。
   */
  const onStep = (current: string) =>
    set((s) =>
      s.batch ? { batch: { ...s.batch, current, done: Math.min(s.batch.done + 1, total) } } : {},
    );

  let failed = 0;
  try {
    failed = await work(onStep);
  } catch (error) {
    failed += 1;
    set({
      batchSummary: `${label}中途出错：${error instanceof Error ? error.message : String(error)}`,
    });
  }

  set({
    batch: null,
    batchSummary:
      failed === 0
        ? `${label}全部完成。`
        : `${label}完成，其中 ${failed} 项失败。失败的多半是限流或额度问题，` +
          '可以隔一会儿再单独重试那一项。',
  });
}

/**
 * 判断某个对象的**某一类**出图是否成功。
 *
 * ===========================================================================
 * 【v0.28 修】这里原来不区分帧类型，会把「别的帧类型的成功」当成这次成功
 * ===========================================================================
 * 原实现用 `endsWith(':' + refId)` 匹配该对象的**所有**任务键，
 * 只要有一条不是 error 就算成功。于是：
 *   先批量出首帧（`first-frame:<shotId>` = ok）
 *   → 再批量出尾帧，部分镜头尾帧失败（`end-frame:<shotId>` = error）
 *   → 被首帧那条 ok 命中 → 失败不计数
 *   → 总结显示「全部尾帧（N 个镜头）全部完成。」
 * **用户不会去补那几张缺图**，而缺的那几张恰恰是尾帧——跨镜衔接的锚点。
 *
 * 另外 `feedback[k]?.kind !== 'error'` 在值为 undefined 时也返回 true，
 * 而生成过程中确实会先写 undefined 占位。所以这里：
 *  - 只认精确的 `${kind}:${refId}` 键
 *  - 必须显式是 ok / info 才算成功，undefined 一律视为失败
 */
function succeeded(kind: ImageTaskKind, refId: string): boolean {
  const feedback = useImage.getState().feedback[`${kind}:${refId}`];
  return feedback?.kind === 'ok' || feedback?.kind === 'info';
}

/** 供界面判断「这个对象能不能出图」 */
export function imageCapabilityHint(): { ready: boolean; reason?: string; level: string } {
  const resolved = resolveImageProfile(true);
  if (!resolved.ok || !resolved.profile) {
    return { ready: false, reason: resolved.error ?? '出图模型还没配置好。', level: '—' };
  }
  const caps = resolved.profile.capabilities;
  const level = caps.referenceImage ? 'L3' : caps.seed ? 'L2' : 'L1';
  return { ready: true, level };
}

