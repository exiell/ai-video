import { create } from 'zustand';
import type { StoreApi } from 'zustand';
import type { AnchorDimension, Asset, ModelProfile, SceneAngle } from '../types/model';
import { ASSET_KIND_LABEL, SCENE_ANGLE_LABEL } from '../types/model';
import {
  REFERENCE_ROLE_LABEL,
  describeDroppedReference,
  planReferenceImagesDetailed,
  previousShotOf,
  referenceRolesOf,
  sameStyle,
  type DroppedReference,
  type ReferenceRole,
  type ReferenceSlot,
} from '../domain/image/referencePlan';
import {
  buildDegradedTextCompensation,
  capabilityNotice,
  degradedWarnings,
  type TextAnchorMaterials,
} from '../domain/image/delivery';
import { useAppStore } from './app';
import { currentTransport, useSettings } from './settings';
import { findProfile, DEFAULT_REFERENCE_PROFILE_ID, DEFAULT_T2I_PROFILE_ID } from '../data/models/profiles';
import { generateImages, toAssets, type GenerateImagesOutcome } from '../services/image/generate';
import { prepareReference, type PreparePurpose } from '../services/image/prepare';
import {
  buildCharacterSheetPrompt,
  buildFramePrompt,
  type FrameKind,
  buildScenePlatePrompt,
  withDeliveryCompensation,
  type ImagePromptInput,
} from '../domain/image/prompts';
import { deleteAsset, estimateUsage, listAssets, listAssetsFor, saveAssets } from '../services/storage';
import {
  missingBeforeFrames,
  framePrereqMessage,
} from '../domain/image/order';
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
   * 出三帧之前该说的一句话（v0.53）。齐了返回 null。
   *
   * 为什么是现查而不是读 `assetCounts`：那个数只在进项目、生成完、删除后刷新，
   * 分镜页根本不调它，拿它判断「谁还没出图」会给出过期答案。
   * 查不到就直接放行（返回 null）——宁可少提示一次，不该因为统计失败挡住出图。
   */
  framePrereqNotice: () => Promise<string | null>;
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
  generateForScene: (sceneId: string, angle?: SceneAngle) => Promise<void>;
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

/**
 * 一张参考图的职责说明（v0.46）。
 *
 * ===========================================================================
 * 角色形象图为什么不能只写一句通用的话
 * ===========================================================================
 * 原来所有角色参考图共用一句「the character design sheet, …」。两个角色同框时
 * 发出去的是：
 *
 *   Image 2 is the character design sheet, defining face, hairstyle, body proportions and outfit.
 *   Image 3 is the character design sheet, defining face, hairstyle, body proportions and outfit.
 *
 * 两句话一模一样，模型不知道哪张是谁。于是「把两个人的特征混在一张脸上」
 * 成了可以预期的结果。名字本来就在角色卡上，写进去就行。
 *
 * 第二件事：**形象图是一张多格设定稿，不是一个角色**。
 * 全身图是六格排成一行（正面/侧面/背面/四分之三/俯视/仰视），
 * 头像是三格。直接丢进去，模型可能把分格排版一起画出来，
 * 或者把同一个人画好几次。所以要明说「它是什么、怎么用、别照着排版画」。
 *
 * 第三件事：**全身图能锁体型，头像不能**。对着一张只有头的图要求
 * 「保持体型比例」，是在要求模型保持它看不见的东西。
 */
function referenceRolePhrase(slot: ReferenceSlot): string {
  if (slot.role !== 'character-sheet') return REFERENCE_ROLE_PHRASE[slot.role];

  const who = slot.owner ? `${slot.owner}'s` : 'the';
  const sheet =
    slot.detail === 'full-body'
      ? `${who} character turnaround sheet, showing the same person in several views`
      : `${who} character head reference sheet, showing the same head in several views`;
  const whatToTake =
    slot.detail === 'full-body'
      ? 'defining face, hairstyle, build, body proportions and outfit'
      : 'defining facial features, hairstyle and head shape; the body is not shown in this image';
  return (
    `${sheet}, ${whatToTake}. ` +
    'Use it only to keep that one person consistent — pick the view in that sheet that matches this camera angle. ' +
    'Do not copy the panel layout and do not draw that person more than once'
  );
}

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

  framePrereqNotice: async () => {
    const project = useAppStore.getState().project;
    if (!project) return null;
    try {
      const assets = await listAssets(project.id);
      return framePrereqMessage(missingBeforeFrames(project, assets));
    } catch {
      // 查不到就当没缺——不能因为一次查询失败把出图挡住
      return null;
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

  /**
   * 出场景参考板。
   *
   * `angle`（v0.46）：
   *  - `master`：纯文生图，和以前一样。
   *  - `reverse`：**拿主视角板当参考图去改**，而不是从零再画一间屋子。
   *    重画出来的门和草料会挪位置，那就不是同一个地方了。
   *    没有主视角板时直接报错——没有参照物就无从「转过去」。
   */
  generateForScene: async (sceneId, angle = 'master') => {
    const project = useAppStore.getState().project;
    if (!project) return;
    const key = taskKey('scene-plate', sceneId);
    if (get().pending) return;

    const prompt = buildScenePlatePrompt(project, sceneId, angle);
    if (!prompt) return;

    let referenceImages: string[] = [];
    let referenceLabels: string[] = [];
    let referencePhrases: string[] = [];

    if (angle === 'reverse') {
      const scene = project.scenes.find((s) => s.id === sceneId);
      const plates = await listAssetsFor(project.id, sceneId);
      const master = plates
        .filter(
          (a) =>
            a.kind === 'scene-plate' &&
            a.dataUrl &&
            a.angle !== 'reverse' &&
            sameStyle(a.styleTags, project.brief.styleTags),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

      if (!master?.dataUrl) {
        set((s) => ({
          feedback: {
            ...s.feedback,
            [key]: {
              kind: 'error',
              message: `「${scene?.name ?? '这个场景'}」还没有主视角参考板，出不了反打板。`,
              warnings: [
                '反打板是把主视角那张转过去，不是重新画一间屋子，重画出来的门会换位置。所以要先有主视角板。',
              ],
            },
          },
        }));
        return;
      }

      referenceImages = [master.dataUrl];
      referenceLabels = [`${scene?.name ?? '这个场景'} · 主视角板（用来转成反打）`];
      referencePhrases = [
        'the master view of this room, used as the starting point for the reverse angle',
      ];
    }

    await runGeneration({
      key,
      draft: {
        projectId: project.id,
        kind: 'scene-plate',
        refId: sceneId,
        promptSnapshot: prompt.positive,
        lockPhrases: prompt.lockPhrases,
        styleTags: [...project.brief.styleTags],
        ...(angle !== 'master' ? { angle } : {}),
        ...(angle === 'reverse'
          ? {
              // 场景板不是「第几帧」，所以 kind 留空。
              // 但职责说明必须给：否则会走到「保持那张角色参考图里的人」那句旧分支上去，
              // 而这张参考图里根本没有角色。
              frameRole: {
                hasFirstFrameAnchor: false,
                hasPreviousEndAnchor: false,
                roles: referencePhrases,
                sheetDetails: [] as ('full-body' | 'face')[],
              },
            }
          : {}),
      },
      prompt,
      preferReference: referenceImages.length > 0,
      referenceImages,
      referenceLabels,
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
    /** 逐张写职责用的英文说明，与 referenceImages 严格同序（v0.46） */
    const referencePhrases: string[] = [];
    /** 角色参考图分别是全身图还是头像，决定「锁脸」那句话怎么写（v0.46） */
    const sheetDetails: ('full-body' | 'face')[] = [];
    let referenceRoles: ReferenceRole[] = [];
    /** 因风格不符被跳过的参考图，生成完要如实告诉用户 */
    let staleRoles: ReferenceRole[] = [];
    /** 因参考图槽位不够而没放进去的参考图（v0.48），生成完要如实说 */
    let droppedRefs: DroppedReference[] = [];
    /** 这一镜要反打板但没有，退回了主视角板（v0.46）。生成完要如实说 */
    let scenePlateFellBack = false;
    /**
     * P2-a：投递之后仍只能靠文字的维度，以及写进请求/feedback 的补偿与提示。
     *
     * 只有真的参考图编排过（useReference 且档案可用）才会赋值；
     * 纯文生图（useReference=false）没有「降级」可言。
     */
    let degradedDimensions: AnchorDimension[] = [];
    let textCompensation: string[] = [];
    let capabilityWarnings: string[] = [];
    let editMode = false;
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
      const characterNames: string[] = [];
      for (const characterId of shot?.characterIds ?? []) {
        characterSheets.push(await listAssetsFor(project.id, characterId));
        characterNames.push(
          project.characters.find((c) => c.id === characterId)?.name ?? 'the character',
        );
      }
      const scenePlates = shot?.sceneId
        ? await listAssetsFor(project.id, shot.sceneId)
        : undefined;

      const detailed = planReferenceImagesDetailed({
        kind,
        capabilities: caps,
        previous,
        styleTags: project.brief.styleTags,
        // 景别决定用全身图还是头像：全景读体型，近景读脸（v0.46）
        ...(shot ? { shotSize: shot.shotSize } : {}),
        // 朝向决定用哪张场景板：反打镜头拿反打板（v0.46）
        ...(shot?.viewAngle ? { viewAngle: shot.viewAngle } : {}),
        characterNames,
        sources: {
          ownFrames,
          ...(previousFrames ? { previousFrames } : {}),
          characterSheets,
          ...(scenePlates ? { scenePlates } : {}),
        },
      });
      const plan = detailed.plan;

      /*
        P2-a：降级上报与文字补偿。

        **只有真的投递了参考图才做**（plan.slots.length > 0）。0 槽/能力未知/
        空项目时 runGeneration 会回退纯文生图（profile 变成 plain 档案），
        此时一个额外句子都不能加——否则纯文生图会莫名出现「编辑任务」「空间由文字锁定」
        这类只对参考图路径成立的指令。这是复验抓到的 blocker。
      */
      if (plan.slots.length > 0) {
        degradedDimensions = detailed.degraded;
        editMode = detailed.source === 'declared' && detailed.semantics === 'edit';
        const notice = capabilityNotice(detailed.source);
        const materials: TextAnchorMaterials = {};
        if (degradedDimensions.includes('space') && shot?.sceneId) {
          const scene = project.scenes.find((item) => item.id === shot.sceneId);
          if (scene) {
            materials.scene = {
              spatialStructure: scene.identity.spatialStructure,
              fixedElements: scene.fixedElements,
              lightDirection: scene.lightDirection,
            };
          }
        }
        if (degradedDimensions.includes('identity')) {
          const characters = (shot?.characterIds ?? [])
            .map((id) => project.characters.find((character) => character.id === id))
            .filter((character) => character !== undefined)
            .map((character) => ({
              name: character.name,
              ...(character.identity.summary ? { summary: character.identity.summary } : {}),
              ...(character.identity.summaryEn ? { summaryEn: character.identity.summaryEn } : {}),
              locks: character.continuityLocks
                .filter((lock) => shot?.activeLockIds.includes(lock.id))
                .map((lock) => lock.phrase),
            }));
          if (characters.length > 0) materials.characters = characters;
        }
        textCompensation = buildDegradedTextCompensation(degradedDimensions, materials);

        /**
         * 哪些维度真的注入了原文（决定 warnings 能不能说「已写入」）。
         *
         * 判据必须是**实际注入的文本非空**，不能用「characters 数组非空」：
         * 新建角色的 identity 摘要可能是空的、也没有生效的锁面，此时
         * buildDegradedTextCompensation 不会产出身份补偿句；再说「已写进提示词」
         * 就是在编一个不存在的动作（复验抓到的文案真实性问题）。
         */
        const compensated: AnchorDimension[] = [];
        const sceneMaterial = materials.scene;
        if (
          sceneMaterial &&
          ((sceneMaterial.spatialStructure ?? '').trim().length > 0 ||
            (sceneMaterial.fixedElements ?? []).some((item) => item.trim().length > 0) ||
            (sceneMaterial.lightDirection ?? '').trim().length > 0)
        ) {
          compensated.push('space');
        }
        const identityCompensated = (materials.characters ?? []).some(
          (character) =>
            (character.summary ?? '').trim().length > 0 ||
            (character.summaryEn ?? '').trim().length > 0 ||
            (character.locks ?? []).some((phrase) => phrase.trim().length > 0),
        );
        if (identityCompensated) compensated.push('identity');

        capabilityWarnings = [
          ...(notice ? [notice] : []),
          ...degradedWarnings(detailed.degraded, detailed.source, compensated),
        ];
      }

      /*
        P2-c：参考图投递前做确定性预处理（只处理**这一次请求的副本**）：
        - 帧类锚点用 aspect：按项目画幅中心裁切 + 长边缩放，保证与输出同比例；
        - 角色形象图/场景参考板用 passthrough（或档案声明了已核实字节上限时 fit-bytes），
          绝不为统一比例去裁角色多视图（会裁掉视图）。
        0 槽时 plan.slots 为空，整段不执行（纯文生图不经过预处理）。
      */
      const preprocessWarnings: string[] = [];
      const maxBytesPerImage = caps.reference?.maxBytesPerImage;
      for (let index = 0; index < plan.slots.length; index += 1) {
        const slot = plan.slots[index]!;
        const isFrameAnchor =
          slot.role === 'own-first-frame' || slot.role === 'previous-end-frame';
        const purpose: PreparePurpose = isFrameAnchor
          ? 'aspect'
          : maxBytesPerImage !== undefined
            ? 'fit-bytes'
            : 'passthrough';
        const prepared = await prepareReference(
          { dataUrl: slot.dataUrl, role: slot.role },
          purpose,
          {
            ...(isFrameAnchor ? { targetAspect: project.brief.aspectRatio } : {}),
            ...(maxBytesPerImage !== undefined ? { maxBytesPerImage } : {}),
          },
        );
        referenceImages.push(prepared.dataUrl);
        referenceLabels.push(slot.label);
        referencePhrases.push(referenceRolePhrase(slot));
        if (slot.role === 'character-sheet' && slot.detail) sheetDetails.push(slot.detail);

        // 只在真的有变化/失败时提示，避免每次出图都刷屏
        if (prepared.transformed) {
          preprocessWarnings.push(
            `第 ${index + 1} 张参考图（${slot.label}）已自动${
              purpose === 'aspect' ? '按画幅裁切/压缩' : '压缩'
            }：${prepared.width}×${prepared.height}，${Math.max(1, Math.round(prepared.byteSize / 1024))} KB。`,
          );
        }
        if (prepared.reason) {
          preprocessWarnings.push(`第 ${index + 1} 张参考图：${prepared.reason}`);
        }
      }
      if (preprocessWarnings.length > 0) capabilityWarnings.push(...preprocessWarnings);
      referenceRoles = referenceRolesOf(plan);
      staleRoles = plan.staleSkipped;
      droppedRefs = plan.dropped;
      scenePlateFellBack = plan.scenePlateFellBack === true;
    }
    const frameRole = {
      kind,
      hasFirstFrameAnchor: referenceRoles.includes('own-first-frame'),
      hasPreviousEndAnchor: referenceRoles.includes('previous-end-frame'),
      // 逐张写职责时用的英文说明，必须与传图顺序一致
      roles: referencePhrases,
      /**
       * 空数组是**有意义的**：本镜一个角色都没有（纯空镜）。
       * 传了空数组，提示词里就不会出现「保持人物面部特征」这句
       * ——画面里没有人，要求保持人物的脸只会让模型硬塞一个人进去。
       * 所以这里不能写成「没角色就不传」，那不传会退回旧行为。
       */
      sheetDetails,
      // 几个角色同框。两个以上时要额外提醒「这是不同的人，别混成一个」
      characterCount: sheetDetails.length,
      // 承接镜时用来明说「取景可以改、地方不能动」
      ...(prompt.shotSizeEn ? { shotSizeEn: prompt.shotSizeEn } : {}),
      ...(prompt.cameraPositionEn ? { cameraPositionEn: prompt.cameraPositionEn } : {}),
      // P2-a：投递后仍缺的维度（可选字段，旧调用方不受影响）
      ...(degradedDimensions.length > 0 ? { degradedDimensions } : {}),
    };

    /*
      【v0.39 修】这里原来算了第二次 buildFramePrompt，并把三个「锚点」参数传进去。
      但那个函数里是 `void options` —— 参数被丢弃，所以**两次结果完全相同**，
      第二次纯属白算。跟着一起删掉的还有一段说明「有锚点时不再重描角色」的注释，
      它与函数里「角色外观永远注入」的实现相反，会误导后续修改。

      实际策略只有一个：外观**始终**注入。原因记在 prompts.ts 的对应位置。
    */
    /*
      P2-a：投递不足的文字补偿 + 编辑保留句。
      只改这一次请求的正向提示词；prompt 对象其余字段（negative/aspect/labels）不动。
    */
    const effectivePrompt: ImagePromptInput = {
      ...prompt,
      positive: withDeliveryCompensation(prompt.positive, {
        editMode,
        ...(textCompensation.length > 0 ? { compensation: textCompensation } : {}),
      }),
    };
    await runGeneration({
      key,
      prompt: effectivePrompt,
      draft: {
        projectId: project.id,
        kind,
        refId: shotId,
        promptSnapshot: effectivePrompt.positive,
        lockPhrases: prompt.lockPhrases,
        styleTags: [...project.brief.styleTags],
        referenceCount: referenceImages.length,
        frameRole,
      },
      preferReference: referenceImages.length > 0,
      referenceImages,
      referenceLabels,
      staleSkipped: staleRoles.map((role) => REFERENCE_ROLE_LABEL[role]),
      ...(droppedRefs.length > 0 ? { dropped: droppedRefs } : {}),
      ...(scenePlateFellBack ? { scenePlateFellBack: true } : {}),
      ...(capabilityWarnings.length > 0 ? { extraWarnings: capabilityWarnings } : {}),
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
  /**
   * 这一镜要反打板但没有，退回了主视角板（v0.46）。见 `ReferencePlan.scenePlateFellBack`。
   */
  scenePlateFellBack?: boolean;
  /**
   * 因参考图槽位不够而没能放进去的参考图（v0.48）。见 `ReferencePlan.dropped`。
   *
   * 失败与取舍都会走到这里，所以生成成功时也必须把它说出来——
   * 少一张参考图，出来的图会「看着像但哪里不对」，不说就永远归不了因。
   */
  dropped?: DroppedReference[];
  /**
   * P2-a：能力来源/降级提示（「能力未核实」「哪一维只剩文字」）。
   *
   * 与 dropped/stale 同属「取舍必须可见」：投递不足时用户要知道，
   * 否则会以为参考图机制坏了，去改提示词/换模型，全都改不到点上。
   */
  extraWarnings?: string[];
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
function confirmOverwrite(
  refId: string,
  kind: Asset['kind'],
  angle?: SceneAngle,
): boolean {
  const existing = useImage.getState().gallery[refId] ?? [];
  const wantAngle: SceneAngle = angle ?? 'master';
  /**
   * 只统计**同一种东西**。
   *
   * 【v0.47 修】原来只按 `kind` 算，于是主视角板已经在图库里的时候，
   * 出反打板会弹一句「这里已经有 1 张「场景参考板」了」——可那是**另一张板**，
   * 用户根本没在覆盖什么东西。这条提示读起来像是要覆盖主视角板，把人劝退。
   *
   * 现在场景板按角度分开算：出反打板只在已经有反打板时才问。
   */
  const sameKind =
    kind === 'scene-plate'
      ? existing.filter(
          (asset) =>
            asset.kind === kind && asset.dataUrl && (asset.angle ?? 'master') === wantAngle,
        )
      : existing.filter((asset) => asset.kind === kind && asset.dataUrl);
  if (sameKind.length === 0) return true;

  const label =
    kind === 'scene-plate'
      ? `${ASSET_KIND_LABEL[kind]}（${SCENE_ANGLE_LABEL[wantAngle]}）`
      : ASSET_KIND_LABEL[kind];
  return window.confirm(
    `这里已经有 ${sameKind.length} 张「${label}」了。\n\n` +
      '继续生成会新增一张，旧的仍然保留（可以在图库里对比后删掉不要的）。\n\n' +
      '注意：出图是要花钱的。确定要再生成一张吗？',
  );
}

/**
 * 落库前的存储余量预检。
 *
 * 为什么是 80%：浏览器配额接近满时，`bulkPut` 失败只是时间问题；等到失败再说，
 * 用户已经为这张图付过钱了。提前一句提示让他有机会先导出、先清理。
 * 查询失败（隐私模式 / 不支持 estimate）时返回 null 直接放行——
 * 一次查询失败不该挡住正常出图。
 */
async function storageQuotaWarning(): Promise<string | null> {
  try {
    const usage = await estimateUsage();
    if (!usage || usage.quota <= 0) return null;
    const ratio = usage.usage / usage.quota;
    if (ratio < 0.8) return null;
    return (
      `本机存储已用掉约 ${Math.round(ratio * 100)}%。图片只会越存越多，` +
      '建议先到「导出」页备份，再删掉不用的旧图；否则新图可能存不下。'
    );
  } catch {
    return null;
  }
}

async function runGeneration(args: RunArgs): Promise<void> {
  const { key, draft, prompt, preferReference, referenceImages, set, get } = args;
  const referenceLabels = args.referenceLabels ?? [];
  const staleSkipped = args.staleSkipped ?? [];
  const extraWarnings = args.extraWarnings ?? [];
  // 非批量时才确认：批量出图是用户主动发起的，每张都弹窗会没法用
  if (
    !useImage.getState().batch &&
    !confirmOverwrite(draft.refId, draft.kind, draft.angle)
  ) {
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
      /*
        【v0.46 修】这里原来**没有**这一行。

        `draft.frameRole` 一直在被构造、一直被存进素材，却从来没进过请求体。
        后果是 `withReferenceInstruction` 每次都走 `sheetDetails === undefined`
        的旧分支，无论参考图里是什么，都无条件追加那句
        「Keep the facial features, hairstyle and body proportions of the person
        in the character reference image exactly.」

        也就是说 v0.44 做的「逐张说明参考图职责」「头像不再被要求保持体型」
        「两个角色明说是不同的人」，**一次都没有真正到达模型**。
        测试当时只测了 `withReferenceInstruction` 本身，没测这条线，
        所以全绿而线上无效。

        现在把它接上。`draft.frameRole` 就是这一帧的参考图说明，
        与素材里存的那份是同一个对象，不会两边说法不一致。
      */
      ...(draft.frameRole ? { frameRole: draft.frameRole } : {}),
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
  const quotaWarning = built.assets.length > 0 ? await storageQuotaWarning() : null;
  if (built.assets.length > 0) {
    /**
     * 为什么落库必须自己 try/catch。
     *
     * 图片是 base64 存进 IndexedDB 的，几十张就会接近浏览器配额。配额满时
     * `bulkPut` 抛 `QuotaExceededError`，而这里没有 catch 的话：
     *  - 异常变成 unhandled rejection，界面什么都不显示
     *  - feedback 还停留在上一条「生成中」之后的状态，用户以为图已经存好了
     *  - 图只在厂商的临时链接里（24 小时失效），过一会儿就真没了
     * 项目里的文本落盘有这层保护（store/app.ts 的 persist），图片这条不能少。
     */
    try {
      await saveAssets(built.assets);
    } catch {
      set((s) => ({
        feedback: {
          ...s.feedback,
          [key]: {
            kind: 'error',
            message:
              '图生成出来了，但没能存进本机：本地存储可能满了或不可用。' +
              '这张图现在只在厂商的临时链接里，24 小时后会失效。' +
              '先去「导出」页备份已有的图，再在「设置」页删掉一些不用的旧图，然后重试。',
            warnings: [...built.warnings, ...(quotaWarning ? [quotaWarning] : [])],
          },
        },
      }));
      return;
    }
    // 素材存好后立刻刷新图库，用户马上能看到图
    try {
      const refId = draft.refId;
      const project = useAppStore.getState().project;
      if (project) {
        const assets = await listAssetsFor(project.id, refId);
        set((s) => ({ gallery: { ...s.gallery, [refId]: assets } }));
        // 总数变了 —— 改风格提示要用它算「有多少张图是旧风格」
        await get().refreshAssetCount();
      }
    } catch {
      // 刷新失败不影响「图已经存好了」这个事实；下次进页面会重新读图库
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

  /**
   * 这一镜要反打板，但没有反打板 → 悄悄退回了主视角板（v0.46）。
   *
   * 必须说。不说的话，用户拿到的是「把主视角构图焊在他身上」的图，
   * 只会觉得反打功能没生效，却不知道原因是没有那张板。
   */
  const fallbackWarnings = args.scenePlateFellBack
    ? [
        '这一镜标成了反打视角，但这个场景还没有反打板，所以暂时用了主视角板当参考图。' +
          '去「场景设定」给这个场景补一张反打板，再重出这一镜，朝向才会真的转过去。',
      ]
    : [];

  /**
   * 参考图没放全 —— 必须说（v0.48）。
   *
   * 槽位是硬上限（千问 2.0/3.0 系列最多 3 张），内容一多就一定会溢出。
   * 原来溢出是**静默**的：候选按顺序来，来一张丢一张，用户根本不知道
   * 这一镜少了哪张锚点。结果就是「出来的图看着像，但哪里不对」，
   * 他去改提示词、换风格、重出，全都改不到点上。
   */
  const droppedList = args.dropped ?? [];
  const droppedLabels = droppedList.map(describeDroppedReference);
  const droppedWarnings =
    droppedLabels.length > 0
      ? [
          `这一镜要 ${referenceImages.length + droppedLabels.length} 张参考图` +
            `（${[...referenceLabels, ...droppedLabels].join('、')}），` +
            `但当前模型最多只收 ${profile.capabilities.maxReferenceImages || 0} 张，` +
            `所以「${droppedLabels.join('」「')}」这一次没用上。` +
            (droppedList.some((item) => item.role === 'scene-plate')
              ? '这一镜的空间与光线这次只有文字描述。把景别改成全景或更远，工具会优先保住场景参考板。'
              : '想让每个角色都用图锁住，可以在「设置」里换成支持 10 张参考图的「多图参考版」；' +
                '不过官方建议一次 1–3 张，张数多了各项一致性会往下掉，换之前先小样本对比。'),
        ]
      : [];

  set((s) => ({
    feedback: {
      ...s.feedback,
      [key]: {
        kind:
          built.assets.length === 0
            ? 'error'
            : built.warnings.length > 0 ||
                quotaWarning !== null ||
                staleWarnings.length > 0 ||
                fallbackWarnings.length > 0 ||
                droppedWarnings.length > 0 ||
                extraWarnings.length > 0
              ? 'info'
              : 'ok',
        message:
          built.assets.length > 0
            ? `${prompt.subjectLabel}已生成并保存到本机${referenceNote}。`
            : '图生成出来了，但没能下载到本地。请稍后重试。',
        warnings: [
          ...built.warnings,
          ...(quotaWarning ? [quotaWarning] : []),
          ...staleWarnings,
          ...fallbackWarnings,
          ...droppedWarnings,
          ...extraWarnings,
        ],
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

