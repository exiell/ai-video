import type { AnchorDimension, SceneAngle, Shot, ShotSize } from '../../types/model';

/**
 * 锚点收集（v0.58 · P1「锚点与投递分离」）
 *
 * ===========================================================================
 * 为什么把「取锚点」单独拆出来
 * ===========================================================================
 * 原来 `planReferenceImages` 把三件事揉在一个函数里：
 *   ① 从项目素材算出「这一帧理论上需要哪些锚点」（与模型无关）
 *   ② 按模型能力决定怎么送（槽位/语义/画幅）
 *   ③ 产出界面/提示词用的标签
 *
 * 槽位一少，①算出来的锚点只能被②丢掉，而丢掉的锚点没有替代物。
 * 拆开之后：
 *  - `collectAnchors()` 的入参里**没有 capabilities**，同一输入在任何模型下输出相同；
 *  - 「丢了谁、为什么」只发生在 delivery 层，可单独穷举测试；
 *  - 加一种新模型，只需要补投递策略，不动锚点逻辑。
 *
 * 本文件是**纯函数 + 常量**：不读存储、不看能力、不做排序（排序属于投递）。
 * 候选顺序就是优先级：上一镜尾帧 → 本镜首帧 → 角色形象图 → 场景板。
 */

/** 一张参考图在这张画面里的职责 */
export type ReferenceRole =
  /** 本镜首帧：锁本镜的构图、机位、景别、光线方向 */
  | 'own-first-frame'
  /** 上一镜尾帧：锁跨镜的空间、光线与主体位置 */
  | 'previous-end-frame'
  /** 角色形象图：锁外观（脸、体型、服装） */
  | 'character-sheet'
  /** 场景参考板：锁空间结构、固定元素、主光方向 */
  | 'scene-plate'
  /** 场景主帧：角色已经在景里，同时锁身份、空间与构图（v0.60 · P2-b） */
  | 'staging-frame';

/** 一张能做参考的素材。`styleTags` 是它**生成时**用的风格词。 */
export interface RefAsset {
  dataUrl?: string;
  kind: string;
  createdAt: string;
  /** 生成这张图时项目的风格关键词。老素材没有这个字段，按「兼容」处理 */
  styleTags?: string[];
  /**
   * 这是从哪个角度看这间屋子（v0.46，只有场景板用得上）。
   *
   * 老素材没有这个字段，一律按主视角处理——不能因为加了个字段
   * 就把所有历史场景板作废。
   */
  angle?: SceneAngle;
}

export interface ReferenceSource {
  /** 本镜已有的素材（用来找本镜首帧） */
  ownFrames: RefAsset[];
  /** 上一镜已有的素材（用来找它的尾帧） */
  previousFrames?: RefAsset[] | undefined;
  /** 出场角色的形象图，按出场顺序 */
  characterSheets: RefAsset[][];
  /** 场景板的素材 */
  scenePlates?: RefAsset[] | undefined;
  /**
   * 该场景的主帧素材（v0.60 · P2-b）。
   *
   * 只用于「1 槽跳切首帧」的投递决策；不参与其它帧/承接镜，避免改变既有行为。
   */
  stagingFrames?: RefAsset[] | undefined;
}

/**
 * 一个锚点：一张图 + 它能锁住的维度。
 *
 * `covers` 是**静态事实**（这张图里有什么），与模型能力无关；
 * delivery 需要它来计算「投递之后还缺哪些维度」。
 */
export interface Anchor {
  role: ReferenceRole;
  dataUrl?: string;
  /** 角色形象图才有：这是哪一位角色的 */
  owner?: string;
  /** 角色形象图是全身多视图还是头部特写 */
  detail?: 'full-body' | 'face';
  /** 场景板的角度（只有 scene-plate 用得上） */
  angle?: SceneAngle;
  /** 这张图能锁哪些维度（与模型无关） */
  covers: AnchorDimension[];
}

export interface AnchorSet {
  kind: 'first-frame' | 'action-peak' | 'end-frame';
  /** 已经解析过的景别（缺省 medium），投递阶段复用 */
  shotSize: ShotSize;
  /** 候选顺序，与模型能力无关（含没有 dataUrl 的占位锚点） */
  anchors: Anchor[];
  isContinuous: boolean;
  reason: string;
  /** 因为风格不符被跳过的角色（仍按原顺序，重复由调用方去重） */
  staleSkipped: ReferenceRole[];
  /** 这一镜要反打板但没有，退回了主视角板 */
  scenePlateFellBack?: true;
  /**
   * 该场景的可用主帧（v0.60 · P2-b）。不塞进 anchors 候选，
   * 由 delivery 在「1 槽 + 跳切首帧」时决定是否用它替代角色图/场景板。
   */
  stagingFrame?: Anchor;
}

/**
 * 每个角色能锁的维度（方案 v2.1 §1.3 的四功能表）。
 *
 * `previous-end-frame` 是本项目唯一的「四合一」：它同时锁连续、身份、空间、构图。
 * 动作关键帧/尾帧由本镜首帧提供时，首帧锁身份/空间/构图，不锁「跨镜连续」。
 */
const ANCHOR_COVERS: Record<ReferenceRole, AnchorDimension[]> = {
  'previous-end-frame': ['continuity', 'identity', 'space', 'composition'],
  'own-first-frame': ['identity', 'space', 'composition'],
  'character-sheet': ['identity'],
  'scene-plate': ['space'],
  // 主帧是唯一同时含「人 + 景」的锚点：身份、空间、构图一次给全，但不锁跨镜连续
  'staging-frame': ['identity', 'space', 'composition'],
};

/**
 * 判断这一镜与上一镜是否连续。
 *
 * 判据来自**上一镜的衔接说明**（它描述的是「怎么接到下一镜」，也就是接到当前这一镜）。
 * 没有说明时按「不连续」处理——用错比不用更糟。
 */
export function isContinuousWithPrevious(previous: Shot | undefined): {
  continuous: boolean;
  reason: string;
} {
  if (!previous) {
    return { continuous: false, reason: '这是第一镜，没有上一镜可接。' };
  }

  // 优先看**显式字段**——它是用户（或模型建议、用户确认）明确声明的意图。
  // 关键词推断只在字段缺失时兜底（老项目与手写镜头）。
  if (previous.transitionType === 'continuation') {
    return { continuous: true, reason: '上一镜的转场类型明确标为「承接」。' };
  }
  if (previous.transitionType === 'cut') {
    return { continuous: false, reason: '上一镜的转场类型明确标为「跳切」，是一次有意的断开。' };
  }

  const note = (previous.continuityNote ?? '').trim();
  if (note.length === 0) {
    return {
      continuous: false,
      reason: '上一镜没有写衔接说明，无法确认是否连续，因此不拿它的尾帧当锚点（用错比不用更糟）。',
    };
  }

  // 明确表示「断开」的词：跳切、换时间、换地点
  const cutWords = [
    '直接切', '切到', '切换到', '跳到', '画面一转', '镜头一转', '转场',
    '第二天', '次日', '隔天', '几天后', '一周后', '稍后', '片刻后',
    '与此同时', '另一边', '另一处', '回到', '闪回', '回忆',
    'cut to', 'meanwhile', 'later', 'next day',
  ];
  const hitCut = cutWords.find((w) => note.includes(w));
  if (hitCut) {
    return { continuous: false, reason: `上一镜的衔接说明里写了「${hitCut}」，是一次有意的断开。` };
  }

  // 明确表示「连续」的词：接着、保持、同一机位、不停
  const continuousWords = [
    '接着', '保持', '继续', '同一机位', '同一个机位', '不停', '不断',
    '紧接着', '随即', '顺势', '延续',
    'continues', 'same camera', 'without cutting',
  ];
  const hitContinuous = continuousWords.find((w) => note.includes(w));
  if (hitContinuous) {
    return {
      continuous: true,
      reason: `上一镜的衔接说明里写了「${hitContinuous}」，是连续动作。`,
    };
  }

  return {
    continuous: false,
    reason:
      '上一镜的衔接说明里既没有「接着/保持」这类连续信号，也没有「切到/第二天」这类断开信号，' +
      '判不准，因此不拿它的尾帧当锚点。想用上这个锚点，就在衔接说明里写明「接着」。',
  };
}

/**
 * 两组风格词是不是同一套。
 *
 * 顺序无关（用户可能只调换了两行），大小写无关。
 * 老素材没有记录 styleTags 时**一律算兼容**——否则升级之后
 * 所有历史图都会突然不能当参考图，那是更糟的破坏。
 */
export function sameStyle(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return true;
  const norm = (xs: string[]): string =>
    xs
      .map((x) => x.trim().toLowerCase().replace(/\s+/g, ' '))
      .filter(Boolean)
      .sort()
      .join('|');
  return norm(a) === norm(b);
}

/** 从素材里挑最新一张指定类型 */
function newestOf(
  assets: RefAsset[] | undefined,
  kind: string,
  style?: string[],
): string | undefined {
  if (!assets || assets.length === 0) return undefined;
  return assets
    .filter((a) => a.kind === kind && a.dataUrl && sameStyle(a.styleTags, style))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.dataUrl;
}

/**
 * 角色参考图该用哪一张：全景及更远用全身多视图（锁体型），中景及更近用头部特写（锁脸）。
 * 缺一档时退回另一档——缺图时退回，比干脆不给参考图强。
 */
function pickCharacterSheet(
  assets: RefAsset[],
  style: string[] | undefined,
  preferFullBody: boolean,
): { url: string | undefined; detail: 'full-body' | 'face' } {
  const full = newestOf(assets, 'character-sheet', style);
  const face = newestOf(assets, 'character-sheet-face', style);
  if (preferFullBody) {
    return full ? { url: full, detail: 'full-body' } : { url: face, detail: 'face' };
  }
  return face ? { url: face, detail: 'face' } : { url: full, detail: 'full-body' };
}

/**
 * 哪些景别该用全身图。
 *
 * 判据是「这一档里观众能不能看出体型」。全景、远景、大远景里人是画面的一小部分，
 * 比例错了最刺眼；中景以下身体被裁掉大半，读的是脸。
 */
const FULL_BODY_SHOT_SIZES: ReadonlySet<ShotSize> = new Set<ShotSize>([
  'full',
  'wide',
  'extreme-wide',
]);

/**
 * 哪些景别里**场景参考板比角色形象图更该保住**（v0.48）。
 *
 * 成员与 `FULL_BODY_SHOT_SIZES` 相同，但**刻意分成两个常量**：
 * 一个是「用全身图还是头像」的判据，一个是「槽位不够时先丢谁」的判据。
 * 它们现在恰好同集合，理由却是两条——合用一个常量的话，
 * 以后有人只改了一边，另一边会跟着悄悄变。
 */
export const SCENE_PLATE_PRIORITY_SHOT_SIZES: ReadonlySet<ShotSize> = new Set<ShotSize>([
  'full',
  'wide',
  'extreme-wide',
]);

/**
 * 没传景别时按哪一档处理。
 *
 * 真实调用方（`store/image.ts`）**总是**会传景别，这个默认值只服务于
 * 测试与历史数据。选 `medium` 是为了保持改动前的行为（优先头像），
 * 避免老调用方在不知不觉中换了参考图。
 */
const DEFAULT_SHOT_SIZE: ShotSize = 'medium';

/**
 * 挑这一镜该用哪张场景板（v0.46）：反打镜头优先反打板，没有则退回主视角板并标记；
 * 主视角镜头只认主视角板（不退到反打板）。
 */
/**
 * 挑该场景最新一张可用的主帧（v0.60 · P2-b）。
 *
 * 主帧不参与候选排序/预算裁剪：它只在「1 槽 + 跳切首帧」时由 delivery
 * 作为替代方案使用（见 delivery.planDelivery）。
 */
function pickStagingFrame(
  assets: RefAsset[] | undefined,
  style: string[] | undefined,
): string | undefined {
  if (!assets || assets.length === 0) return undefined;
  return assets
    .filter((a) => a.kind === 'staging-frame' && a.dataUrl && sameStyle(a.styleTags, style))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.dataUrl;
}

function pickScenePlate(
  assets: RefAsset[] | undefined,
  style: string[] | undefined,
  want: SceneAngle,
): { url: string | undefined; angle: SceneAngle | undefined; fellBack: boolean } {
  if (!assets || assets.length === 0) return { url: undefined, angle: undefined, fellBack: false };

  const usable = assets
    .filter((a) => a.kind === 'scene-plate' && a.dataUrl && sameStyle(a.styleTags, style))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const isReverse = (a: RefAsset): boolean => a.angle === 'reverse';

  if (want === 'reverse') {
    const hit = usable.find(isReverse);
    if (hit?.dataUrl) return { url: hit.dataUrl, angle: 'reverse', fellBack: false };
    const master = usable.find((a) => !isReverse(a));
    if (master?.dataUrl) return { url: master.dataUrl, angle: 'master', fellBack: true };
    return { url: undefined, angle: undefined, fellBack: false };
  }

  // 主视角镜头：只认主视角板，**不**退到反打板。
  // 反打板是在主视角板的基础上改出来的，拿它当主视角的参考图只会越改越偏。
  const master = usable.find((a) => !isReverse(a));
  return master?.dataUrl
    ? { url: master.dataUrl, angle: 'master', fellBack: false }
    : { url: undefined, angle: undefined, fellBack: false };
}

/**
 * 收集这一帧理论上需要的锚点（与模型能力无关）。
 *
 * 候选顺序（就是优先级）：
 *  1. 上一镜尾帧 —— 只在连续时放。跨镜接续最强的锚点
 *  2. 本镜首帧 —— 只在出后两帧时放。锁本镜构图
 *  3. 角色形象图 —— 锁外观
 *  4. 场景参考板 —— 锁空间与光线
 *
 * 注意：锚点里包含 `dataUrl: undefined` 的占位（候选存在但没有素材），
 * 投递层要按「有图的才算 present」计算槽位，这样丢掉谁与旧行为完全一致。
 */
export function collectAnchors(args: {
  kind: 'first-frame' | 'action-peak' | 'end-frame';
  previous: Shot | undefined;
  sources: ReferenceSource;
  shotSize?: ShotSize;
  characterNames?: string[];
  styleTags?: string[];
  viewAngle?: SceneAngle;
}): AnchorSet {
  const { kind, previous, sources, styleTags, characterNames } = args;
  const shotSize = args.shotSize ?? DEFAULT_SHOT_SIZE;
  const viewAngle: SceneAngle = args.viewAngle ?? 'master';

  /** 这一批素材里有没有因为风格不符被跳过的，用于如实告知 */
  const staleSkipped: ReferenceRole[] = [];
  const pick = (assets: RefAsset[] | undefined, assetKind: string): string | undefined => {
    const url = newestOf(assets, assetKind, styleTags);
    if (
      !url &&
      assets?.some((a) => a.kind === assetKind && a.dataUrl && !sameStyle(a.styleTags, styleTags))
    ) {
      staleSkipped.push(assetKind === 'scene-plate' ? 'scene-plate' : 'own-first-frame');
    }
    return url;
  };

  const continuity = isContinuousWithPrevious(previous);
  const anchors: Anchor[] = [];

  if (kind === 'first-frame') {
    // 出首帧时，上一镜尾帧是唯一的构图锚点
    if (continuity.continuous) {
      const url = newestOf(sources.previousFrames, 'end-frame', styleTags);
      if (
        !url &&
        sources.previousFrames?.some(
          (a) => a.kind === 'end-frame' && a.dataUrl && !sameStyle(a.styleTags, styleTags),
        )
      ) {
        staleSkipped.push('previous-end-frame');
      }
      anchors.push({
        role: 'previous-end-frame',
        dataUrl: url,
        covers: ANCHOR_COVERS['previous-end-frame'],
      });
    }
  } else {
    // 出后两帧时，本镜首帧是构图锚点
    anchors.push({
      role: 'own-first-frame',
      dataUrl: pick(sources.ownFrames, 'first-frame'),
      covers: ANCHOR_COVERS['own-first-frame'],
    });
  }

  const preferFullBody = FULL_BODY_SHOT_SIZES.has(shotSize);
  sources.characterSheets.forEach((sheet, index) => {
    const picked = pickCharacterSheet(sheet, styleTags, preferFullBody);
    if (!picked.url && sheet.some((a) => a.dataUrl && !sameStyle(a.styleTags, styleTags))) {
      staleSkipped.push('character-sheet');
    }
    const owner = characterNames?.[index];
    anchors.push({
      role: 'character-sheet',
      dataUrl: picked.url,
      detail: picked.detail,
      covers: ANCHOR_COVERS['character-sheet'],
      ...(owner ? { owner } : {}),
    });
  });

  /**
   * 场景板（v0.46 起按朝向挑）。
   *
   * 不能统一取「最新一张 scene-plate」：加了反打板之后，主视角镜头会拿到反打图。
   */
  const plate = pickScenePlate(sources.scenePlates, styleTags, viewAngle);
  if (
    !plate.url &&
    sources.scenePlates?.some(
      (a) => a.kind === 'scene-plate' && a.dataUrl && !sameStyle(a.styleTags, styleTags),
    )
  ) {
    staleSkipped.push('scene-plate');
  }
  anchors.push({
    role: 'scene-plate',
    dataUrl: plate.url,
    covers: ANCHOR_COVERS['scene-plate'],
    ...(plate.angle ? { angle: plate.angle } : {}),
  });

  const stagingUrl = pickStagingFrame(sources.stagingFrames, styleTags);

  return {
    kind,
    shotSize,
    anchors,
    isContinuous: continuity.continuous,
    reason: continuity.reason,
    staleSkipped,
    ...(plate.fellBack ? { scenePlateFellBack: true as const } : {}),
    ...(stagingUrl
      ? {
          stagingFrame: {
            role: 'staging-frame' as const,
            dataUrl: stagingUrl,
            covers: ANCHOR_COVERS['staging-frame'],
          },
        }
      : {}),
  };
}
