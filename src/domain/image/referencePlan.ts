import type { ModelCapabilities, Project, Shot } from '../../types/model';

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

export interface ReferenceSource {
  /** 本镜已有的素材（用来找本镜首帧） */
  ownFrames: { dataUrl?: string; kind: string; createdAt: string }[];
  /** 上一镜已有的素材（用来找它的尾帧） */
  previousFrames?: { dataUrl?: string; kind: string; createdAt: string }[] | undefined;
  /** 出场角色的形象图，按出场顺序 */
  characterSheets: { dataUrl?: string; kind: string; createdAt: string }[][];
  /** 场景板的素材 */
  scenePlates?: { dataUrl?: string; kind: string; createdAt: string }[] | undefined;
}

/** 从素材里挑最新一张指定类型 */
function newestOf(
  assets: { dataUrl?: string; kind: string; createdAt: string }[] | undefined,
  kind: string,
): string | undefined {
  if (!assets || assets.length === 0) return undefined;
  return assets
    .filter((a) => a.kind === kind && a.dataUrl)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.dataUrl;
}

/** 角色_head特写优先于全身图——脸只能靠图，体型服装文字能说清 */
function pickCharacterSheet(assets: { dataUrl?: string; kind: string; createdAt: string }[]):
  | string
  | undefined {
  return newestOf(assets, 'character-sheet-face') ?? newestOf(assets, 'character-sheet');
}

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
}): ReferencePlan {
  const { kind, capabilities, previous, sources } = args;
  const limit = capabilities.maxReferenceImages || 0;

  const continuity = isContinuousWithPrevious(previous);
  const candidates: { role: ReferenceRole; dataUrl: string | undefined }[] = [];

  if (kind === 'first-frame') {
    // 出首帧时，上一镜尾帧是唯一的构图锚点
    if (continuity.continuous) {
      candidates.push({
        role: 'previous-end-frame',
        dataUrl: newestOf(sources.previousFrames, 'end-frame'),
      });
    }
  } else {
    // 出后两帧时，本镜首帧是构图锚点
    candidates.push({
      role: 'own-first-frame',
      dataUrl: newestOf(sources.ownFrames, 'first-frame'),
    });
  }

  for (const sheet of sources.characterSheets) {
    candidates.push({ role: 'character-sheet', dataUrl: pickCharacterSheet(sheet) });
  }
  candidates.push({ role: 'scene-plate', dataUrl: newestOf(sources.scenePlates, 'scene-plate') });

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
      label: REFERENCE_ROLE_LABEL[candidate.role],
    });
  }

  orderSlots(slots, continuity.continuous);

  return {
    slots,
    isContinuous: continuity.continuous,
    reason: continuity.reason,
    dropped,
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
