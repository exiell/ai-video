import type { EntityStateDelta, StateDeltaEntityType } from '../../types/state';
import { sameStyle, type RefAsset } from './anchors';

/**
 * 受保护的规范主参考池（Phase 2 · 防图改图漂移）
 *
 * 核心原则：
 * 1. 每个角色 / 场景 / 关键道具都保有不可被下游分镜帧覆写的 canonicalAnchor（规范主参考）。
 * 2. 下游分镜帧（first-frame / action-peak / end-frame）永远只作为补充锚点（supplementaryAnchors），
 *    不会反客为主替代角色或场景主参考，避免「图改图改到第 4 轮完全跑脸/跑色」。
 * 3. 只有当镜头存在显式 EntityStateDelta（例如换装/淋雨/道具破损）时，才启用对应补充参考。
 */

export type ImageEditMode = 'surgical_edit' | 'canonical_redraw';

export const IMAGE_EDIT_MODE_LABEL: Record<ImageEditMode, string> = {
  surgical_edit: '局部微调（只改指定项，锁其余画面）',
  canonical_redraw: '回溯主参考重绘（防多轮修图漂移）',
};

const DOWNSTREAM_SHOT_KINDS = new Set(['first-frame', 'action-peak', 'end-frame']);

export interface CanonicalAnchorItem {
  role: 'canonical' | 'supplementary';
  kind: string;
  dataUrl: string;
  label: string;
  immutable: boolean;
}

export interface CanonicalReferencePool {
  /** 受保护的规范主参考（永远不取自下游分镜帧） */
  canonicalAnchor?: CanonicalAnchorItem;
  /** 仅在连续接戏或显式状态变更时启用的补充参考 */
  supplementaryAnchors: CanonicalAnchorItem[];
  /** 是否检测到潜在的多轮图改图漂移风险 */
  driftRisk: boolean;
  /** 给界面或日志展示的中文提示 */
  warnings: string[];
}

/**
 * 断言下游分镜帧不能覆写主参考（canonicalAnchor）。
 * 返回 false 表示该资产类型属于下游分镜帧，禁止覆盖规范主参考。
 */
export function canServeAsCanonicalAnchor(assetKind: string): boolean {
  return !DOWNSTREAM_SHOT_KINDS.has(assetKind);
}

/**
 * 为角色 / 场景 / 道具规划「受保护主参考 + 补充参考池」。
 */
export function planCanonicalReferencePool(args: {
  entityType: StateDeltaEntityType;
  entityName: string;
  /** 主参考候选（如角色形象图、场景参考板、道具主图） */
  canonicalCandidates: RefAsset[];
  /** 下游补充候选（如上一镜尾帧、已修分镜帧） */
  supplementaryCandidates?: RefAsset[];
  /** 本镜针对该实体的显式状态变化 */
  stateDeltas?: EntityStateDelta[];
  /** 当前项目风格标签 */
  styleTags?: string[];
  /** 是否属于同场连续承接 */
  isContinuous?: boolean;
}): CanonicalReferencePool {
  const warnings: string[] = [];
  const validCanonical = args.canonicalCandidates
    .filter(
      (asset) =>
        Boolean(asset.dataUrl) &&
        canServeAsCanonicalAnchor(asset.kind) &&
        sameStyle(asset.styleTags, args.styleTags),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const rejectedDownstreamInCanonical = args.canonicalCandidates.some(
    (asset) => Boolean(asset.dataUrl) && !canServeAsCanonicalAnchor(asset.kind),
  );
  if (rejectedDownstreamInCanonical) {
    warnings.push(
      `已拦截将下游分镜帧写入「${args.entityName}」规范主参考的请求，避免多轮图改图漂移。`,
    );
  }

  const chosenCanonical = validCanonical[0];
  const canonicalAnchor: CanonicalAnchorItem | undefined = chosenCanonical?.dataUrl
    ? {
        role: 'canonical',
        kind: chosenCanonical.kind,
        dataUrl: chosenCanonical.dataUrl,
        label: `${args.entityName} · 规范主参考（已锁定）`,
        immutable: true,
      }
    : undefined;

  const supplementaryAnchors: CanonicalAnchorItem[] = [];
  const hasStateDelta = (args.stateDeltas ?? []).length > 0;
  const allowSupplementary = Boolean(args.isContinuous) || hasStateDelta;

  if (allowSupplementary && args.supplementaryCandidates && args.supplementaryCandidates.length > 0) {
    const picked = args.supplementaryCandidates
      .filter((asset) => Boolean(asset.dataUrl) && sameStyle(asset.styleTags, args.styleTags))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (picked?.dataUrl) {
      supplementaryAnchors.push({
        role: 'supplementary',
        kind: picked.kind,
        dataUrl: picked.dataUrl,
        label: hasStateDelta
          ? `${args.entityName} · 状态变化补充参考`
          : `${args.entityName} · 连续承接补充参考`,
        immutable: false,
      });
    }
  }

  // 没有规范主参考、却直接拿下游分镜帧作为唯一参考时，存在明显漂移风险
  const driftRisk =
    !canonicalAnchor &&
    Boolean(args.supplementaryCandidates?.some((asset) => Boolean(asset.dataUrl)));
  if (driftRisk) {
    warnings.push(
      `「${args.entityName}」尚未绑定规范主参考图，仅用分镜帧反复修图容易出现外观漂移。`,
    );
  }

  return {
    ...(canonicalAnchor ? { canonicalAnchor } : {}),
    supplementaryAnchors,
    driftRisk,
    warnings,
  };
}

/**
 * 局部微调 / 回溯主参考重绘提示词格式化器。
 * 遵循「只写变化项 + 显式声明保留项」的手术式修图规范。
 */
export function formatSurgicalEditPrompt(args: {
  mode: ImageEditMode;
  changeInstruction: string;
  preserveNote?: string;
}): string {
  const change = args.changeInstruction.trim();
  if (!change) return '';

  const preserve = (args.preserveNote ?? '').trim();
  if (args.mode === 'canonical_redraw') {
    const base = `以规范主参考图为准重新生成，严格锁定主体五官、体型、服装与画风一致，仅应用以下调整：${change}`;
    return preserve ? `${base}。其余保留项：${preserve}` : base;
  }

  const preserveClause =
    preserve || '主体身份特征、构图机位、光影色温与背景结构保持原图不变';
  return `仅修改以下指定项：${change}。严格保留不变项：${preserveClause}。不要重绘未提及区域。`;
}
