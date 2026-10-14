import type { ImageRequest, ModelCapabilities } from '../../types/model';

/**
 * 角色形象图的提示词规格
 *
 * ===========================================================================
 * 为什么是两张图，而不是一张
 * ===========================================================================
 * 一张图里塞的东西越多，每个部分分到的分辨率越低。
 * 实测的参考样例（用户提供的《林薇形象》）把全身多视图、头部特写、
 * 材质细节、色卡全部排在一张图里——作为**给人看的设定稿**很好，
 * 但作为**给模型看的参考图**有问题：
 *
 * 全身图里的脸只占几十像素，模型从这里学不到面部特征。
 * 而「锁脸」恰恰是动漫角色一致性最关键的一环。
 *
 * 所以拆成两张，各自解决一个问题：
 *
 *   ① 全身多视图（turnaround）—— 锁体型、比例、服装轮廓、发型长度
 *   ② 头部特写（face sheet）  —— 锁面部特征。**这张才是锁脸该用的参考图**
 *
 * 生成关键帧时，两张一起传，各管一半。
 */

// ---------------------------------------------------------------------------
// 规格定义
// ---------------------------------------------------------------------------

export interface ViewSpec {
  /** 英文描述，写进提示词 */
  en: string;
  /** 中文标注，写进图下方的标签（也是给用户看的对照） */
  zh: string;
}

/**
 * 全身多视图的六个角度。
 *
 * 比常见的三视图多出三个：
 *  - 四分之三视角：最常见的叙事角度，介于正面与侧面之间
 *  - 俯视 / 仰视：决定「从楼上往下看」这类镜头里角色的样子，
 *    少了它们，模型遇到俯拍镜头就会自己编一个透视
 *  - 背面：动漫里背对镜头是很常用的构图
 */
export const TURNAROUND_VIEWS: ViewSpec[] = [
  { en: 'front view', zh: 'FRONT 正面' },
  { en: 'side profile view', zh: 'SIDE 侧面' },
  { en: 'back view', zh: 'BACK 背面' },
  { en: 'three-quarter view', zh: '3/4 VIEW' },
  { en: 'high angle top view looking down at the character from above', zh: 'TOP 俯视' },
  { en: 'low angle bottom view looking up at the character from below', zh: 'BOTTOM 仰视' },
];

/**
 * 头部特写的三个角度。
 *
 * 为什么必须有「背面」：扎辫子、盘发、戴帽子的角色，
 * 从背后看是什么样，只有这一个角度能说清楚。
 * 少了它，角色一转身模型就会把发型画乱。
 */
export const FACE_VIEWS: ViewSpec[] = [
  { en: 'front view of the head', zh: 'FRONT' },
  { en: 'side profile view of the head', zh: 'SIDE' },
  { en: 'back view of the head showing the hairstyle from behind', zh: 'BACK' },
];

export type CharacterSheetKind = 'turnaround' | 'face';

export const CHARACTER_SHEET_KIND_LABEL: Record<CharacterSheetKind, string> = {
  turnaround: '全身多视图',
  face: '头部特写（锁脸用）',
};

// ---------------------------------------------------------------------------
// 构图指令
// ---------------------------------------------------------------------------

/** 图下方标注视角名称，方便人工核对，也让模型知道每一格该画什么 */
const LABEL_INSTRUCTION =
  'each view labelled underneath with small clean uppercase captions reading FRONT, SIDE, BACK, 3/4 VIEW, TOP, BOTTOM';

const FACE_LABEL_INSTRUCTION =
  'each view labelled underneath with small clean uppercase captions reading FRONT, SIDE, BACK';

const COMMON_SHEET_TAIL =
  'plain flat neutral grey background, even soft studio lighting, no shadow on the background, ' +
  'no watermark, no logo, consistent proportions across all views, ' +
  'photorealistic character reference sheet quality';

export interface CharacterSheetSpec {
  positive: string;
  notes: { fragment: string; label: string; reason: string }[];
  kind: CharacterSheetKind;
}

/**
 * 组装一张形象图的完整提示词。
 *
 * 注意用词：这里刻意用 "character reference sheet" 与 "model sheet"。
 * 这两个词在动漫制作流程里是固定术语，模型对它们的理解比对
 * 「多画几个角度」这种口语描述稳定得多。
 */
export function buildCharacterSheetSpec(
  kind: CharacterSheetKind,
  identityEn: string,
  lockPhrases: string[],
  styleTags: string[],
): CharacterSheetSpec {
  const isFace = kind === 'face';
  const views = isFace ? FACE_VIEWS : TURNAROUND_VIEWS;
  const viewText = views.map((v) => v.en).join(', ');

  const framing = isFace
    ? 'head and shoulders only, tightly cropped at the collarbone, faces large and clearly readable in every panel'
    : 'full body from head to feet, standing upright with arms relaxed at the sides, evenly spaced panels';

  const positive = [
    `anime character model sheet, ${kind === 'face' ? 'head close-up reference sheet' : 'full-body turnaround reference sheet'}`,
    identityEn,
    ...lockPhrases,
    `${views.length} views arranged in one row: ${viewText}`,
    framing,
    isFace ? FACE_LABEL_INSTRUCTION : LABEL_INSTRUCTION,
    COMMON_SHEET_TAIL,
    ...styleTags,
  ]
    .filter(Boolean)
    .join(', ');

  const notes = [
    {
      fragment: viewText,
      label: `${views.length} 个视角`,
      reason: isFace
        ? '正面锁五官，侧面锁鼻梁与下颌线，背面锁发型（扎辫子、盘发、戴帽子的角色尤其需要这一格）。缺了背面，角色一转身模型就会把头发画乱。'
        : '比常见三视图多出三个：四分之三视角是最常用的叙事角度；俯视与仰视决定「从楼上往下看」这类镜头里角色长什么样。少了它们，模型遇到俯拍镜头会自己编一个透视。',
    },
    {
      fragment: framing,
      label: '取景范围',
      reason: isFace
        ? '刻意裁到锁骨，让脸占满画面。全身图里的脸只有几十像素，模型从这里学不到面部特征——锁脸不能靠全身图。'
        : '全身入画、双臂自然下垂。姿态越标准，作为参考图时越不容易把姿态也一起带进去。',
    },
    {
      fragment: COMMON_SHEET_TAIL,
      label: '纯灰背景 + 均匀打光',
      reason:
        '参考图的职责是把角色本身说清楚，不是好看。背景和光影越简单，模型越容易只学到角色。',
    },
  ];

  if (lockPhrases.length > 0) {
    notes.push({
      fragment: lockPhrases.join(', '),
      label: '连续性锁',
      reason:
        '来自角色设定卡。这些短语会被原样写进每一镜的提示词，形象图里也必须带上，图和文字说的才是同一件事。',
    });
  }

  return { positive, notes, kind };
}

// ---------------------------------------------------------------------------
// 参考图挑选策略
// ---------------------------------------------------------------------------

export interface ReferencePick {
  /** 用作参考图的 dataUrl */
  dataUrl: string;
  /** 这张图是什么，用于在界面上说明「用了哪几张」 */
  label: string;
}

/**
 * 从某个角色名下的素材里挑出最适合当参考图的几张。
 *
 * 挑选顺序有讲究：**头部特写优先于全身图**。
 * 因为关键帧里最需要保持一致的是脸；体型和服装已经写在提示词文字里了，
 * 而面部特征很难用文字描述清楚，只能靠图。
 *
 * 上限由模型能力决定（千问图像是 3 张）。
 */
export function pickReferenceImages(
  assets: { dataUrl?: string; kind: string; createdAt: string }[],
  capabilities: ModelCapabilities,
): ReferencePick[] {
  const limit = capabilities.maxReferenceImages || 0;
  if (limit <= 0) return [];

  const usable = assets.filter(
    (a): a is { dataUrl: string; kind: string; createdAt: string } => Boolean(a.dataUrl),
  );
  // 新的优先：用户重生成形象图，说明他对旧的不满意
  const byNewest = [...usable].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const faces = byNewest.filter((a) => a.kind === 'character-sheet-face');
  const fulls = byNewest.filter((a) => a.kind === 'character-sheet');

  const picked: ReferencePick[] = [];
  if (faces[0]) picked.push({ dataUrl: faces[0].dataUrl, label: '头部特写（锁脸）' });
  if (fulls[0]) picked.push({ dataUrl: fulls[0].dataUrl, label: '全身多视图（锁体型与服装）' });
  // 还有余量就再放一张头部特写（不同批次的脸略有差异，多一张更稳）
  if (faces[1] && picked.length < limit) {
    picked.push({ dataUrl: faces[1].dataUrl, label: '头部特写（备选批次）' });
  }

  return picked.slice(0, limit);
}

/** 供界面用：把选中的参考图打包成出图请求的一部分 */
export function withReferences<T extends ImageRequest>(
  request: T,
  picks: ReferencePick[],
): T {
  if (picks.length === 0) return request;
  return { ...request, referenceImages: picks.map((p) => p.dataUrl) };
}

/**
 * 场景参考板也可以当参考图——**空镜与广角镜头尤其需要**。
 *
 * 没有角色的镜头如果只传角色形象图是没用的（画面里根本没有人），
 * 而场景板能锁住空间结构、固定元素与光线方向。
 */
export function pickSceneReference(
  assets: { dataUrl?: string; kind: string; createdAt: string }[],
): ReferencePick | undefined {
  const usable = assets
    .filter((a): a is { dataUrl: string; kind: string; createdAt: string } => Boolean(a.dataUrl))
    .filter((a) => a.kind === 'scene-plate')
    // 新的优先：用户重生成说明他对旧的不满意
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const best = usable[0];
  return best ? { dataUrl: best.dataUrl, label: '场景参考板（锁空间与光线）' } : undefined;
}

/**
 * 同一镜的**首帧**是最强的构图锚点。
 *
 * ===========================================================================
 * 为什么首帧要优先于一切其它参考图
 * ===========================================================================
 * 角色形象图锁的是「这个人长什么样」，但它锁不住「这一镜的空间长什么样」。
 * 动作关键帧与尾帧如果各自独立生成，机位、景别、人物在画面里的位置、
 * 光线方向都可能变——三张图各自都很好看，放一起却不像同一个镜头。
 *
 * 而首帧就是这一镜的视觉基准。把首帧当参考图传给后两帧，
 * 构图、机位、光线、姿态起点全部被锚住，三帧才真的属于同一个镜头。
 *
 * 注意：首帧自己不用它（它就是基准）。
 */
export function pickFirstFrameReference(
  assets: { dataUrl?: string; kind: string; createdAt: string }[],
): ReferencePick | undefined {
  const usable = assets
    .filter((a): a is { dataUrl: string; kind: string; createdAt: string } => Boolean(a.dataUrl))
    .filter((a) => a.kind === 'first-frame')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const best = usable[0];
  return best ? { dataUrl: best.dataUrl, label: '本镜首帧（锁构图与机位）' } : undefined;
}
