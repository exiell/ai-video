import type { ModelCapabilities, Project, Shot, ShotSize } from '../../types/model';

/**
 * 跨镜参考图编排（方案.md §7.6.10，【v0.21 新增】）
 *
 * ===========================================================================
 * 为什么需要单独一个模块
 * ===========================================================================
 * 参考图槽位是有限的（千问 3 张），所以「放哪几张、按什么顺序」就是取舍本身。
 * 原来这段取舍散在 store 里，看不出规则，也无法测试。抽出来之后：
 *  - 规则是可以读、可以测、可以在界面上解释的
 *  - 每张参考图的**角色**是显式声明的，提示词才能据此分角色写说明
 *
 * ===========================================================================
 * 关键判断：什么时候**不该**用上一镜的尾帧
 * ===========================================================================
 * 上一镜尾帧是最强的跨镜锚点——它同时锁住空间、光线、主体的位置与朝向。
 * 但**只在两个镜头确实连续时才有用**。
 *
 * 如果这一镜是跳切（换了地方、跳了时间、有意断开），把上一镜尾帧当参考图
 * 是把两个不该相连的镜头强行焊在一起，会同时毁掉两边：
 *  - 本镜的构图被拉向上一镜
 *  - 上一镜的空间被搬到一个新场景里
 *
 * 所以判据必须保守：**只有明确读到「连续」的证据才用，读不准就不用。**
 * 不用只是少了一道保险；用错是主动引入错误。
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
  | 'scene-plate';

export const REFERENCE_ROLE_LABEL: Record<ReferenceRole, string> = {
  'own-first-frame': '本镜首帧（锁构图与机位）',
  'previous-end-frame': '上一镜尾帧（锁跨镜连续）',
  'character-sheet': '角色形象图（锁外观）',
  'scene-plate': '场景参考板（锁空间与光线）',
};

export interface ReferenceSlot {
  role: ReferenceRole;
  dataUrl: string;
  /** 界面上显示用的说明 */
  label: string;
  /**
   * 这张形象图是谁的（v0.46）。
   *
   * 【为什么必须带上名字】原来两张角色参考图在提示词里是**同一句话**：
   * 「Image 2 is the character design sheet… Image 3 is the character design sheet…」
   * ——模型不知道哪张是林冲哪张是陆谦。两个角色同框时这正是
   * 「人物和场景错配」的一条具体机制。名字就在角色卡上，用上就行。
   */
  owner?: string;
  /**
   * 角色参考图是全身多视图还是头部特写（v0.46）。
   *
   * 两种图的职责不一样：全身图能锁体型，头像只能锁脸。
   * 职责说明必须跟着变——对着一张只有头的图要求「保持体型比例」，
   * 是在要求模型保持它看不见的东西。
   */
  detail?: 'full-body' | 'face';
}

export interface ReferencePlan {
  slots: ReferenceSlot[];
  /**
   * 这一镜与上一镜是不是连续动作。
   * 它同时决定：要不要用上一镜尾帧当参考图、以及提示词里怎么写转场。
   */
  isContinuous: boolean;
  /** 判定的依据，用于在界面上解释「为什么这么处理」 */
  reason: string;
  /** 因为槽位不够而没能放进去的参考图，如实报告 */
  dropped: ReferenceRole[];
  /**
   * 因为**风格和当前不一致**而主动跳过的参考图。
   *
   * 这不是失败，是取舍：用一张旧风格的图当锚点，会让新图的风格介于两者之间，
   * 看起来就是「崩了」。界面上要把这件事说出来，否则用户只会觉得工具坏了。
   */
  staleSkipped: ReferenceRole[];
  /**
   * 输出画幅由哪张参考图决定（**永远是最靠后的那一张**）。
   *
   * 千问多图编辑的硬约束：输出宽高比随最后一张图。
   * 所以尾帧与场景板在争这一个位置，界面上要把这个取舍显示出来。
   */
  aspectRatioOwner?: ReferenceRole;
}

/**
 * 判断这一镜与上一镜是否连续。
 *
 * 判据来自**上一镜的衔接说明**（它描述的是「怎么接到下一镜」，也就是接到当前这一镜）。
 * 没有说明时按「不连续」处理——见文件顶部的说明。
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

/** 一张能做参考的素材。`styleTags` 是它**生成时**用的风格词。 */
export interface RefAsset {
  dataUrl?: string;
  kind: string;
  createdAt: string;
  /** 生成这张图时项目的风格关键词。老素材没有这个字段，按「兼容」处理 */
  styleTags?: string[];
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
      // 折叠内部连续空格：「Anime  Style」和「anime style」是同一套风格
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
 * 角色参考图该用哪一张。
 *
 * ===========================================================================
 * 【v0.46 改】原来无条件优先头部特写，理由是「脸只能靠图，体型服装文字能说清」
 * ===========================================================================
 * 这句话在近景成立，在**远景不成立**。
 *
 * 头部特写那张图里**根本没有身体**——而它恰恰是「人物大小不合理」的源头：
 * 模型手上关于这个角色的视觉信息只有三个头，身高、肩宽、腿长只能自己猜，
 * 猜出来还要和场景里的桌椅门窗对齐，于是同一个人在 A 镜里到腰高、
 * 在 B 镜里到胸口高。
 *
 * 更浪费的是：每个角色都会出全身多视图（`generateAllCharacterSheets` 先出全身、
 * 再拿它当参考出头像），所以这张画了身体的图**一直存在**，只是从来没被选中过。
 *
 * 现在的规则按景别分档：
 *  - 全景及更远（`full` / `wide` / `extreme-wide`）：用全身多视图。这一档读的就是体型与轮廓。
 *  - 中景及更近：用头部特写。这一档读的是脸，身体已经被画幅裁掉大半。
 *
 * 哪一档缺图就退回另一档——缺图时退回，比干脆不给参考图强得多。
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
 * 没传景别时按哪一档处理。
 *
 * 真实调用方（`store/image.ts`）**总是**会传景别，这个默认值只服务于
 * 测试与历史数据。选 `medium` 是为了保持改动前的行为（优先头像），
 * 避免老调用方在不知不觉中换了参考图。
 */
const DEFAULT_SHOT_SIZE: ShotSize = 'medium';

/**
 * 编排这一帧的参考图。
 *
 * 优先级（槽位不够时从后往前丢）：
 *  1. **上一镜尾帧** —— 只在连续时放。跨镜接续最强的锚点
 *  2. **本镜首帧** —— 只在出后两帧时放。锁本镜构图
 *  3. **角色形象图** —— 锁外观，永远需要
 *  4. **场景参考板** —— 锁空间与光线，槽位有富余时才放
 *
 * 为什么「上一镜尾帧」排在「本镜首帧」前面：
 * 出首帧时本镜首帧还不存在（它就是正在生成的这张），两者不会同时出现。
 * 真正需要取舍的是「角色形象图 vs 场景参考板」——
 * 而角色永远优先，因为脸只能用图锁，空间可以用固定元素与主光方向的文字描述近似。
 */
export function planReferenceImages(args: {
  kind: 'first-frame' | 'action-peak' | 'end-frame';
  capabilities: ModelCapabilities;
  previous: Shot | undefined;
  sources: ReferenceSource;
  /**
   * 这一镜的景别（v0.46）。
   *
   * 只影响一件事：角色参考图用全身多视图还是头部特写。见 `pickCharacterSheet`。
   */
  shotSize?: ShotSize;
  /**
   * 出场角色的名字，与 `sources.characterSheets` 一一对应（v0.46）。
   *
   * 用来把「这一张是谁的形象图」写进提示词。不传时退化成通用说法
   * （「the character turnaround sheet」），比不写强，但多角色时还是会混。
   */
  characterNames?: string[];
  /**
   * 当前项目的风格关键词（v0.41）。
   *
   * 【为什么要有这个参数】踩过一个很贵的坑：改完风格之后重出首尾帧，
   * 图会「崩」——不是模型坏了，而是它收到了**互相矛盾的两个指令**：
   *
   *   文字说：「水墨写意、冷蓝色调」（新的 styleTags）
   *   参考图是：一张暖色赛璐璐的旧图（旧的 styleTags 生成的）
   *
   * 参考图对画面的拉力比文字更强，所以出来的图介于两者之间，
   * 看起来就是「风格崩坏」。而且它只在**改过风格又重出**的时候出现，
   * 第一次生成永远是对的——所以很难归因。
   *
   * 传了它，就会**跳过风格不一致的旧素材**：宁可少一张参考图，
   * 也不要给模型两个打架的指令。
   */
  styleTags?: string[];
}): ReferencePlan {
  const { kind, capabilities, previous, sources, styleTags, characterNames } = args;
  const shotSize = args.shotSize ?? DEFAULT_SHOT_SIZE;
  const limit = capabilities.maxReferenceImages || 0;

  /** 这一批素材里有没有因为风格不符被跳过的，用于如实告知 */
  const staleSkipped: ReferenceRole[] = [];
  const pick = (assets: RefAsset[] | undefined, assetKind: string): string | undefined => {
    const url = newestOf(assets, assetKind, styleTags);
    if (!url && assets?.some((a) => a.kind === assetKind && a.dataUrl && !sameStyle(a.styleTags, styleTags))) {
      staleSkipped.push(assetKind === 'scene-plate' ? 'scene-plate' : 'own-first-frame');
    }
    return url;
  };

  const continuity = isContinuousWithPrevious(previous);
  const candidates: {
    role: ReferenceRole;
    dataUrl: string | undefined;
    owner?: string;
    detail?: 'full-body' | 'face';
  }[] = [];

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
      candidates.push({ role: 'previous-end-frame', dataUrl: url });
    }
  } else {
    // 出后两帧时，本镜首帧是构图锚点
    candidates.push({ role: 'own-first-frame', dataUrl: pick(sources.ownFrames, 'first-frame') });
  }

  const preferFullBody = FULL_BODY_SHOT_SIZES.has(shotSize);
  sources.characterSheets.forEach((sheet, index) => {
    const picked = pickCharacterSheet(sheet, styleTags, preferFullBody);
    if (!picked.url && sheet.some((a) => a.dataUrl && !sameStyle(a.styleTags, styleTags))) {
      staleSkipped.push('character-sheet');
    }
    const owner = characterNames?.[index];
    candidates.push({
      role: 'character-sheet',
      dataUrl: picked.url,
      detail: picked.detail,
      ...(owner ? { owner } : {}),
    });
  });
  candidates.push({ role: 'scene-plate', dataUrl: pick(sources.scenePlates, 'scene-plate') });

  const slots: ReferenceSlot[] = [];
  const dropped: ReferenceRole[] = [];
  for (const candidate of candidates) {
    if (!candidate.dataUrl) continue;
    if (slots.length >= limit) {
      dropped.push(candidate.role);
      continue;
    }
    slots.push({
      role: candidate.role,
      dataUrl: candidate.dataUrl,
      label:
        candidate.role === 'character-sheet' && candidate.detail
          ? `${candidate.owner ? `${candidate.owner} · ` : ''}${
              candidate.detail === 'full-body' ? '全身多视图（锁体型）' : '头部特写（锁脸）'
            }`
          : REFERENCE_ROLE_LABEL[candidate.role],
      ...(candidate.owner ? { owner: candidate.owner } : {}),
      ...(candidate.detail ? { detail: candidate.detail } : {}),
    });
  }

  orderSlots(slots, continuity.continuous);

  return {
    slots,
    isContinuous: continuity.continuous,
    reason: continuity.reason,
    dropped,
    staleSkipped: [...new Set(staleSkipped)],
    aspectRatioOwner: lastRoleOf(slots),
  };
}

/**
 * 排定参考图顺序。
 *
 * ===========================================================================
 * 为什么顺序不只是「重要性排序」
 * ===========================================================================
 * 千问多图编辑有一条**硬约束：输出画幅以最后一张参考图为准**
 * （官方文档：多图输入按数组顺序定义图像顺序）。所以「谁放最后」
 * 实际上是在决定「这一镜的画面比例与构图由谁说了算」。
 *
 * 于是两种转场要排成不同的顺序：
 *
 *  - **承接镜（continuation）**：尾帧必须放最后。
 *    它同时要锁空间、光线与画幅——这正是「接得住」的全部含义。
 *  - **跳切（cut）**：尾帧不参与，场景板放最后。
 *    换了地方就该由新场景决定画幅，否则画面会被拉回上一处的取景。
 *
 * 注意这是**硬约束下无法两全的取舍**：尾帧与场景板在争同一个位置。
 * 所以界面上会显示「这一镜的画幅由谁决定」，让用户看得见这个取舍。
 */
function orderSlots(slots: ReferenceSlot[], continuous: boolean): void {
  const has = (role: ReferenceRole): boolean => slots.some((s) => s.role === role);

  /**
   * 排到最后的那张，实际上决定了输出画幅。
   *
   * 三种情形分开处理，而不是一律按转场类型——因为「谁来定画幅」这件事
   * 只在真正有竞争时才需要取舍：
   *
   *  1. 有上一镜尾帧（承接镜）：尾帧放最后。它同时锁空间、光线与画幅，
   *     这就是「接得住」的全部含义。
   *  2. 有本镜首帧（出后两帧）：首帧放最后。本镜的取景必须由本镜首帧说了算，
   *     三帧才是同一个镜头。
   *  3. 两者都没有（本镜首帧尚未生成，或跳切）：场景板放最后，
   *     由场景决定画幅与空间。角色形象图永远不放在最后——
   *     把它放最后会让一张设定稿的画幅（常常是正方形或竖构图）绑住整部片子。
   */
  // 排序是**升序**，所以「决定画幅的那张」要拿最高 rank 才会落到最后。
  const hasPrev = has('previous-end-frame');
  const hasOwn = has('own-first-frame');

  const rank = (role: ReferenceRole): number => {
    if (role === 'previous-end-frame') return hasPrev ? 100 : 10;
    if (role === 'own-first-frame') return hasPrev ? 60 : hasOwn ? 100 : 10;
    if (role === 'scene-plate') return hasPrev || hasOwn ? 40 : 100;
    // character-sheet：永远不当画幅决定者（设定稿常是方形或竖构图，
    // 让它定画幅会把整部片子带偏）。三种情形下都排在靠前位置。
    return 20;
  };
  slots.sort((a, b) => rank(a.role) - rank(b.role));
  // 尾帧与场景板在争最后一张时，顺序即结论——把它记录下来给界面显示
  void continuous;
}

function lastRoleOf(slots: ReferenceSlot[]): ReferenceRole | undefined {
  return slots.length > 0 ? slots[slots.length - 1]!.role : undefined;
}

/** 供界面与提示词使用：这一镜的参考图角色序列 */
export function referenceRolesOf(plan: ReferencePlan): ReferenceRole[] {
  return plan.slots.map((s) => s.role);
}

/** 这一镜用到了跨镜锚点吗（用于界面提示「这一镜接着上一镜」） */
export function hasCrossShotAnchor(plan: ReferencePlan): boolean {
  return plan.slots.some((s) => s.role === 'previous-end-frame');
}

/** 供导出用：说明每一镜的参考图是怎么分配的 */
export function describeReferencePlan(plan: ReferencePlan): string {
  if (plan.slots.length === 0) return '无参考图（纯文生图）';
  return plan.slots.map((s) => REFERENCE_ROLE_LABEL[s.role]).join(' + ');
}

/** 便捷入口：直接从项目里取上一镜 */
export function previousShotOf(project: Project, shotId: string): Shot | undefined {
  const index = project.shots.findIndex((s) => s.id === shotId);
  return index > 0 ? project.shots[index - 1] : undefined;
}
