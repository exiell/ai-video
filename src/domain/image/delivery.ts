import type {
  AnchorDimension,
  AspectFollows,
  CapabilitySource,
  ModelCapabilities,
  ReferenceCapability,
} from '../../types/model';
import {
  SCENE_PLATE_PRIORITY_SHOT_SIZES,
  type Anchor,
  type AnchorSet,
  type ReferenceRole,
} from './anchors';

/**
 * 投递（v0.58 · P1「锚点与投递分离」）
 *
 * ===========================================================================
 * 这一层才看模型能力
 * ===========================================================================
 * anchors.ts 只回答「这一帧理论上需要哪些锚点」；这里回答：
 *  - 这个模型的槽位上限是多少；
 *  - 槽位不够时先丢谁（与旧行为完全一致：全景先丢角色图、其余从末尾丢）；
 *  - 排完序后谁决定输出画幅；
 *  - 投递之后还有哪些维度只能靠文字（degraded），供 P2-a 上报/补偿。
 *
 * 能力来源分三档，**绝不把推断当事实**：
 *  - `declared`：档案显式声明了 `reference`，按声明投递；
 *  - `legacy`：旧档案只有 `referenceImage/maxReferenceImages`。为了不破坏现有行为
 *    （123 条参考图测试是等价性证明），沿用旧行为，但标记来源、并在界面上提示「未核实」；
 *  - `unknown`：声明里关键字段是 unknown（或未来新档案没声明）→ **不投递**。
 */

export interface CapabilityContext {
  capability: ReferenceCapability;
  source: CapabilitySource;
}

/**
 * 从旧的布尔/数字能力归一化成结构化能力。
 *
 * 关键：legacy 分支**不写** `acceptsDataUri: true` / `aspectFollows:'last'` 这类事实，
 * 它们一律是 'unknown'；legacy 只用于让现有行为保持不变。
 */
export function referenceCapabilityOf(capabilities: ModelCapabilities): CapabilityContext {
  const declared = capabilities.reference;
  if (declared) {
    const unknown =
      declared.semantics === 'unknown' || declared.maxImages === 'unknown';
    return {
      capability: {
        semantics: declared.semantics,
        maxImages: declared.maxImages,
        acceptsDataUri: declared.acceptsDataUri,
        ...(declared.maxBytesPerImage !== undefined
          ? { maxBytesPerImage: declared.maxBytesPerImage }
          : {}),
        ...(declared.aspectFollows !== undefined ? { aspectFollows: declared.aspectFollows } : {}),
      },
      source: unknown ? 'unknown' : 'declared',
    };
  }

  // ---- legacy：旧字段推断（只作兼容，不是能力事实） ----
  if (!capabilities.referenceImage) {
    return {
      capability: {
        semantics: 'none',
        maxImages: 0,
        acceptsDataUri: false,
        aspectFollows: 'unknown',
      },
      source: 'legacy',
    };
  }
  return {
    capability: {
      // 旧字段只能说明「支持参考图」，说不清语义；靠它写 edit/空间提示词就是猜。
      semantics: 'unknown',
      maxImages: capabilities.maxReferenceImages || 0,
      acceptsDataUri: 'unknown',
      aspectFollows: 'unknown',
    },
    source: 'legacy',
  };
}

/** 必填维度顺序固定，便于测试与界面稳定展示 */
const REQUIRED_ORDER: AnchorDimension[] = ['continuity', 'identity', 'space', 'composition'];

/** 这一帧理论上必须锁住的维度（与模型无关） */
function requiredDimensions(
  kind: AnchorSet['kind'],
  isContinuous: boolean,
): AnchorDimension[] {
  if (kind === 'first-frame') {
    return isContinuous ? ['continuity', 'identity', 'space'] : ['identity', 'space'];
  }
  return ['identity', 'space', 'composition'];
}

export interface DeliveryPlan {
  /** direct=真的投递图片；text-only=只能靠文字（0 槽/能力未知） */
  mode: 'direct' | 'text-only';
  /** 已按画幅规则排序；最后一张决定输出画幅（若模型是 `last` 语义） */
  slots: Anchor[];
  /** 因为槽位不够而没能投进去的锚点（按候选顺序） */
  dropped: Anchor[];
  /** 输出画幅由谁决定；能力 unknown/param/fixed 时为 undefined */
  aspectRatioOwner?: ReferenceRole;
  /** 投递之后仍只能靠文字描述的维度 */
  degraded: AnchorDimension[];
  /**
   * P2-b 主帧（MVP）的投递状态：
   *  - 'used'：这一镜已经用场景主帧替代了角色图/场景板；
   *  - 'missing'：条件满足（1 槽 + 跳切首帧）但该场景还没有主帧，已退回原行为；
   *  - undefined：不适用（承接镜/动作帧/多槽模型）。
   */
  staging?: 'used' | 'missing';
}

/**
 * 按能力把锚点投递成参考图槽位。
 *
 * 预算裁剪逻辑与旧 `planReferenceImages` **逐行一致**（这是 P1 行为等价的硬约束）：
 *  - 先算有图的候选（present）；
 *  - 全景及更远且场景板在场时，从后往前丢角色形象图、保住场景板；
 *  - 还差的（或不在那一档）按候选倒序丢，场景板排最后所以它最先被丢；
 *  - 丢掉的按候选顺序记进 dropped。
 */
export function planDelivery(anchorSet: AnchorSet, context: CapabilityContext): DeliveryPlan {
  const { capability, source } = context;
  const slots: Anchor[] = [];
  const dropped: Anchor[] = [];

  /*
    P2-a 单槽策略（显式化，**不改变 slots**）：
    1 槽跳切首帧时，中景及更近保角色形象图（脸是主体），全景及更远保场景板
    （空间是主体）——与旧行为一致，只是从「从末尾丢」的通用逻辑里把这条规则写清楚。
    丢失的那一维由 degraded 如实上报，再由 store 用项目已有文本原文补偿。
  */

  /*
    能力未知/不投递 → 全部锚点都进 degraded，避免把「没投」伪装成「投了」。
    另外：本项目的投递管线只有 data URI 一种输入方式；declared 声明里
    acceptsDataUri 不是 true（false 或 unknown）时同样不投递——否则就是
    把图塞进模型明确不吃的字段，多数厂商会静默忽略，界面却显示成功。
  */
  const cannotDeliver =
    source === 'unknown' ||
    capability.semantics === 'none' ||
    capability.maxImages === 0 ||
    (source === 'declared' && capability.acceptsDataUri !== true);
  if (cannotDeliver) {
    return {
      mode: 'text-only',
      slots: [],
      dropped: anchorSet.anchors.filter((anchor) => anchor.dataUrl !== undefined),
      aspectRatioOwner: undefined,
      degraded: requiredDimensions(anchorSet.kind, anchorSet.isContinuous),
    };
  }

  const required = requiredDimensions(anchorSet.kind, anchorSet.isContinuous);
  const coverageDegraded = (slots: Anchor[]): AnchorDimension[] => {
    const covered = new Set<AnchorDimension>();
    for (const slot of slots) for (const dim of slot.covers) covered.add(dim);
    return REQUIRED_ORDER.filter((dim) => required.includes(dim) && !covered.has(dim));
  };

  /*
    P2-b 主帧（MVP，v0.60）：
    「能力已知 maxImages===1」+「首帧」+「跳切」时，优先用该场景主帧同时锁身份与空间，
    替代原来的角色形象图/场景板。承接镜仍优先上一镜尾帧，动作帧/尾帧仍优先本镜首帧，
    多槽行为完全不变——这些都靠下面这个条件挡住。
  */
  const stagingEligible =
    anchorSet.kind === 'first-frame' &&
    !anchorSet.isContinuous &&
    capability.maxImages === 1;
  if (stagingEligible && anchorSet.stagingFrame) {
    const slot = anchorSet.stagingFrame;
    return {
      mode: 'direct',
      slots: [slot],
      dropped: [],
      ...(capability.aspectFollows === 'param' ? {} : { aspectRatioOwner: slot.role }),
      degraded: coverageDegraded([slot]),
      staging: 'used',
    };
  }
  const stagingHint: 'missing' | undefined = stagingEligible ? 'missing' : undefined;

  const limit =
    capability.maxImages === 'unknown' ? 0 : Math.max(0, Math.floor(capability.maxImages));

  const candidates = anchorSet.anchors;
  const skip = new Set<number>();
  const present = candidates
    .map((candidate, index) => (candidate.dataUrl ? index : -1))
    .filter((index) => index >= 0);
  const overflow = present.length - limit;
  if (overflow > 0) {
    const sacrificed: number[] = [];
    if (
      anchorSet.anchors.some((a) => a.role === 'scene-plate' && a.dataUrl) &&
      SCENE_PLATE_PRIORITY_SHOT_SIZES.has(anchorSet.shotSize)
    ) {
      for (let i = present.length - 1; i >= 0 && sacrificed.length < overflow; i -= 1) {
        const index = present[i]!;
        if (candidates[index]!.role === 'character-sheet') sacrificed.push(index);
      }
    }
    for (let i = present.length - 1; i >= 0 && sacrificed.length < overflow; i -= 1) {
      const index = present[i]!;
      if (!sacrificed.includes(index)) sacrificed.push(index);
    }
    for (const index of sacrificed) skip.add(index);
  }

  candidates.forEach((candidate, index) => {
    if (!candidate.dataUrl) return;
    if (skip.has(index)) {
      dropped.push(candidate);
      return;
    }
    slots.push(candidate);
  });

  orderSlots(slots);
  const aspectFollows: AspectFollows = capability.aspectFollows ?? 'unknown';

  return {
    mode: slots.length > 0 ? 'direct' : 'text-only',
    slots,
    dropped,
    ...(aspectFollows === 'param'
      ? {}
      : slots.length > 0
        ? { aspectRatioOwner: slots[slots.length - 1]!.role }
        : {}),
    degraded: coverageDegraded(slots),
    ...(stagingHint ? { staging: stagingHint } : {}),
  };
}

/**
 * 排定参考图顺序（从旧 `orderSlots` 原样迁移）。
 *
 * 千问多图编辑有一条硬约束：**输出画幅以最后一张参考图为准**。
 * 所以「谁放最后」是在决定「这一镜的画面比例与构图由谁说了算」：
 *  - 承接镜：尾帧放最后（同时锁空间、光线、画幅）；
 *  - 出后两帧：本镜首帧放最后；
 *  - 两者都没有：场景板放最后。
 * 角色形象图永远不放在最后（设定稿的方形/竖构图会绑住整部片子）。
 */
function orderSlots(slots: Anchor[]): void {
  const has = (role: ReferenceRole): boolean => slots.some((s) => s.role === role);
  const hasPrev = has('previous-end-frame');
  const hasOwn = has('own-first-frame');

  const rank = (role: ReferenceRole): number => {
    if (role === 'previous-end-frame') return hasPrev ? 100 : 10;
    if (role === 'own-first-frame') return hasPrev ? 60 : hasOwn ? 100 : 10;
    if (role === 'scene-plate') return hasPrev || hasOwn ? 40 : 100;
    // 主帧本身就是「人已在景里」的基准图，排最后决定画幅没有副作用
    if (role === 'staging-frame') return 100;
    return 20;
  };
  slots.sort((a, b) => rank(a.role) - rank(b.role));
}

// ---------------------------------------------------------------------------
// P2-a：降级上报与文字补偿
// ---------------------------------------------------------------------------

const DIMENSION_LABEL: Record<AnchorDimension, string> = {
  continuity: '跨镜连续',
  identity: '角色身份',
  space: '空间与光线',
  composition: '构图与机位',
};

/** 供界面/feedback 用：把降级维度翻译成人话 */
function describeDimensions(dimensions: readonly AnchorDimension[]): string {
  return dimensions.map((dim) => DIMENSION_LABEL[dim]).join('、');
}

/**
 * 能力来源提示（P2-a）。
 *
 * legacy 档案是「旧字段推断」：沿用旧行为，但必须让用户知道能力没核实过。
 * unknown 档案不投递，提示更直接。
 */
export function capabilityNotice(source: CapabilitySource): string | undefined {
  if (source === 'legacy') {
    return '该模型能力未核实：参考图上限与用法按旧配置保守处理，结果可能与官方能力不一致。';
  }
  if (source === 'unknown') {
    return '该模型的参考图能力未核实，本次不投递参考图（只靠文字与种子）。';
  }
  return undefined;
}

/** 供 feedback warnings 用：这一帧哪些维度只能靠文字 */
export function degradedWarnings(
  degraded: readonly AnchorDimension[],
  source: CapabilitySource,
  /** 真正用已有原文补偿了的维度；没注入原文时不许写「已写入」 */
  compensated: readonly AnchorDimension[] = [],
): string[] {
  if (degraded.length === 0) return [];
  const labels = describeDimensions(degraded);
  const compensations: string[] = [];
  if (degraded.includes('space')) {
    compensations.push(
      compensated.includes('space')
        ? '已把场景的固定元素、主光方向、空间结构原文写进提示词'
        : '场景里没有可注入的原文，空间只能靠简短文字描述',
    );
  }
  if (degraded.includes('identity')) {
    compensations.push(
      compensated.includes('identity')
        ? '已把角色身份摘要与连续性锁原文写进提示词'
        : '项目里没有可注入的角色身份/锁原文，身份只能靠简短文字描述',
    );
  }
  if (degraded.includes('composition')) {
    compensations.push('构图与机位只能靠文字描述，可能仍需多试几次');
  }
  if (degraded.includes('continuity')) {
    compensations.push('与上一镜的连续只能靠文字描述');
  }
  return [
    `这一帧有 ${degraded.length} 项锚点只能靠文字锁定：${labels}。${
      compensations.length > 0 ? `${compensations.join('；')}。` : ''
    }${source === 'legacy' ? '（该模型能力未核实，按旧配置保守处理。）' : ''}`,
  ];
}

/** 文字补偿的原始素材：只接受项目里**已有字段的原文**，不新编内容 */
export interface TextAnchorMaterials {
  scene?: {
    spatialStructure?: string;
    fixedElements?: string[];
    lightDirection?: string;
  };
  characters?: {
    name: string;
    summary?: string;
    summaryEn?: string;
    /** 该角色当前生效的连续性锁锁面（原文） */
    locks?: string[];
  }[];
}

/**
 * 把降级维度写成英文补偿句，注入提示词。
 *
 * 只用调用方给的原文拼接（场景字段、角色身份摘要、锁面）；
 * 不生成新的外观/空间描述，也不做「人物拼图」「左右位置」这类没有事实来源的绑定。
 */
export function buildDegradedTextCompensation(
  degraded: readonly AnchorDimension[],
  materials: TextAnchorMaterials,
): string[] {
  const lines: string[] = [];

  if (degraded.includes('space')) {
    const scene = materials.scene;
    const parts: string[] = [];
    if (scene?.spatialStructure?.trim()) parts.push(`layout: ${scene.spatialStructure.trim()}`);
    if (scene?.fixedElements && scene.fixedElements.length > 0) {
      parts.push(`fixed elements: ${scene.fixedElements.map((x) => x.trim()).filter(Boolean).join('、')}`);
    }
    if (scene?.lightDirection?.trim()) parts.push(`light: ${scene.lightDirection.trim()}`);
    if (parts.length > 0) {
      lines.push(
        'No spatial reference image is used for this frame. Space is locked by the text: ' +
          `${parts.join('; ')}.`,
      );
    }
  }

  if (degraded.includes('identity')) {
    const descriptions = (materials.characters ?? [])
      .map((character) => {
        const summary = character.summaryEn?.trim() || character.summary?.trim() || '';
        const locks = (character.locks ?? []).map((x) => x.trim()).filter(Boolean).join('、');
        const detail = [summary, locks].filter(Boolean).join('; ');
        return detail ? `${character.name}: ${detail}` : '';
      })
      .filter(Boolean);
    if (descriptions.length > 0) {
      lines.push(
        'No character reference image is used for this frame. Character identity is locked by the text: ' +
          `${descriptions.join(' | ')}.`,
      );
    }
  }

  if (degraded.includes('composition')) {
    lines.push(
      'Composition and camera can only be described by the text in this frame; do not copy framing from any other image.',
    );
  }
  if (degraded.includes('continuity')) {
    lines.push(
      'Continuity with the previous shot can only be described by the text in this frame.',
    );
  }

  return lines;
}
