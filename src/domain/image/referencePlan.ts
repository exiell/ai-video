import type {
  AnchorDimension,
  CapabilitySource,
  ModelCapabilities,
  Project,
  ReferenceSemantics,
  SceneAngle,
  Shot,
  ShotSize,
} from '../../types/model';
import { SCENE_ANGLE_LABEL } from '../../types/model';
import { collectAnchors, type AnchorSet, type ReferenceRole, type ReferenceSource } from './anchors';
import { planDelivery, referenceCapabilityOf, type DeliveryPlan } from './delivery';

/**
 * 跨镜参考图编排（方案.md §7.6.10，【v0.21 新增】；v0.58 P1 拆分）
 *
 * ===========================================================================
 * 现在这里只是「兼容包装」
 * ===========================================================================
 * 锚点收集搬到了 `anchors.ts`（与模型能力无关），槽位/排序/降级搬到了
 * `delivery.ts`（这里才看能力）。本文件保留对外的函数签名、类型、中文标签与
 * `ReferencePlan` 形状——`store/image.ts` 与现有 123 条参考图测试**一行不改**，
 * 作为「拆分行为等价」的证明。
 *
 * 新增的 `planReferenceImagesDetailed()` 只在 P2-a 使用：它额外返回
 * 能力来源、语义与降级维度，供 store 写 feedback/提示词补偿。
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
 *  - 上一镜的空间被搬进一个新场景里
 *
 * 判据在 `anchors.ts` 的 `isContinuousWithPrevious()` 里，保持完全不变。
 */

export const REFERENCE_ROLE_LABEL: Record<ReferenceRole, string> = {
  'own-first-frame': '本镜首帧（锁构图与机位）',
  'previous-end-frame': '上一镜尾帧（锁跨镜连续）',
  'character-sheet': '角色形象图（锁外观）',
  'scene-plate': '场景参考板（锁空间与光线）',
  'staging-frame': '场景主帧（角色已在景里，锁身份、空间与构图）',
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

/**
 * 因为槽位不够而没能放进去的参考图（v0.48）。
 *
 * 带上 `owner` 是为了能说清「是哪一位角色的形象图没放进去」——
 * 只报「少了一张角色形象图」等于什么都没说。
 */
export interface DroppedReference {
  role: ReferenceRole;
  /** 角色形象图才有：这是哪一位角色的 */
  owner?: string;
}

/** 「丢了谁」的中文说法，直接用于界面提示 */
const DROPPED_ROLE_LABEL: Record<ReferenceRole, string> = {
  'own-first-frame': '本镜首帧',
  'previous-end-frame': '上一镜尾帧',
  'character-sheet': '角色形象图',
  'scene-plate': '场景参考板',
  'staging-frame': '场景主帧',
};

export function describeDroppedReference(dropped: DroppedReference): string {
  if (dropped.role === 'character-sheet') {
    return dropped.owner ? `${dropped.owner}的形象图` : '一张角色形象图';
  }
  return DROPPED_ROLE_LABEL[dropped.role];
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
  dropped: DroppedReference[];
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
  /**
   * 这一镜要反打板，但没有反打板，于是退回了主视角板（v0.46）。
   *
   * 界面必须把这件事说出来。悄悄退回的后果是：用户以为自己在看反打，
   * 拿到的却是把主视角构图焊在他身上的图——越看越不明白哪里不对。
   */
  scenePlateFellBack?: boolean;
}

export interface PlanReferenceImagesArgs {
  kind: 'first-frame' | 'action-peak' | 'end-frame';
  capabilities: ModelCapabilities;
  previous: Shot | undefined;
  sources: ReferenceSource;
  /**
   * 这一镜的景别（v0.46）。
   *
   * 只影响一件事：角色参考图用全身多视图还是头部特写。见 anchors.ts 的 pickCharacterSheet。
   */
  shotSize?: ShotSize;
  /** 出场角色的名字，与 `sources.characterSheets` 一一对应（v0.46）。 */
  characterNames?: string[];
  /** 当前项目的风格关键词（v0.41）：风格不一致的旧素材会被跳过并上报。 */
  styleTags?: string[];
  /** 这一镜看的是场景的哪一面（v0.46）。 */
  viewAngle?: SceneAngle;
}

/** 把锚点集合 + 投递计划还原成对外的 `ReferencePlan`（形状与文案保持 v0.48 行为不变） */
function toReferencePlan(anchorSet: AnchorSet, delivery: DeliveryPlan): ReferencePlan {
  const slots: ReferenceSlot[] = delivery.slots.map((anchor) => ({
    role: anchor.role,
    dataUrl: anchor.dataUrl!,
    label:
      anchor.role === 'character-sheet' && anchor.detail
        ? `${anchor.owner ? `${anchor.owner} · ` : ''}${
            anchor.detail === 'full-body' ? '全身多视图（锁体型）' : '头部特写（锁脸）'
          }`
        : anchor.role === 'scene-plate' && anchor.angle === 'reverse'
          ? `${REFERENCE_ROLE_LABEL['scene-plate']}（${SCENE_ANGLE_LABEL.reverse}）`
          : REFERENCE_ROLE_LABEL[anchor.role],
    ...(anchor.owner ? { owner: anchor.owner } : {}),
    ...(anchor.detail ? { detail: anchor.detail } : {}),
  }));

  return {
    slots,
    isContinuous: anchorSet.isContinuous,
    reason: anchorSet.reason,
    dropped: delivery.dropped.map((anchor) => ({
      role: anchor.role,
      ...(anchor.owner ? { owner: anchor.owner } : {}),
    })),
    staleSkipped: [...new Set(anchorSet.staleSkipped)],
    ...(delivery.aspectRatioOwner ? { aspectRatioOwner: delivery.aspectRatioOwner } : {}),
    ...(anchorSet.scenePlateFellBack ? { scenePlateFellBack: true } : {}),
  };
}

/**
 * 编排这一帧的参考图（兼容入口）。
 *
 * 行为与 v0.57 完全一致：内部先 `collectAnchors()`（与能力无关），
 * 再由 `planDelivery()` 按能力裁剪/排序。现有 123 条参考图测试一行不改。
 */
export function planReferenceImages(args: PlanReferenceImagesArgs): ReferencePlan {
  return planReferenceImagesDetailed(args).plan;
}

export interface DetailedReferencePlan {
  plan: ReferencePlan;
  source: CapabilitySource;
  semantics: ReferenceSemantics;
  /** 投递之后仍只能靠文字锁定的维度（P2-a 上报/补偿用） */
  degraded: AnchorDimension[];
  /** P2-b：主帧投递状态（仅 1 槽 + 跳切首帧时有值） */
  staging?: 'used' | 'missing';
}

/**
 * P2-a 入口：在兼容结果之外多返回能力来源/语义/降级维度。
 *
 * **只有 store/image.ts 消费**；不改变 `planReferenceImages` 的返回形状。
 */
export function planReferenceImagesDetailed(args: PlanReferenceImagesArgs): DetailedReferencePlan {
  const { capabilities, previous, sources, shotSize, characterNames, styleTags, viewAngle } = args;
  const anchorSet = collectAnchors({
    kind: args.kind,
    previous,
    sources,
    ...(shotSize !== undefined ? { shotSize } : {}),
    ...(characterNames !== undefined ? { characterNames } : {}),
    ...(styleTags !== undefined ? { styleTags } : {}),
    ...(viewAngle !== undefined ? { viewAngle } : {}),
  });
  const context = referenceCapabilityOf(capabilities);
  const delivery = planDelivery(anchorSet, context);
  return {
    plan: toReferencePlan(anchorSet, delivery),
    source: context.source,
    semantics: context.capability.semantics,
    degraded: delivery.degraded,
    ...(delivery.staging ? { staging: delivery.staging } : {}),
  };
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

// ---- 兼容 re-export（`store/image.ts` 与测试仍从这里 import） ----
export type { ReferenceRole, RefAsset, ReferenceSource } from './anchors';
export { isContinuousWithPrevious, sameStyle } from './anchors';
