/**
 * 道具一等资产、跨镜头动态状态变更与多镜头编组契约（Phase 2）
 *
 * 1. PropAsset：将高频关键道具升级为独立资产，绑定受保护的规范主参考图；
 * 2. EntityStateDelta：显式记录「第 N 镜因何发生换装/淋雨/受伤/道具破损」，
 *    兼顾身份锁定与合理剧情演化；
 * 3. ShotGroup：将同场次 2–6 个连续短镜编组，供 Kling 3.0 Multi-Shot / Seedance 2.5
 *    时间戳分段 / 尾帧接力统一渲染，减少跳脸与色差。
 */

export interface PropAsset {
  id: string;
  name: string;
  /** 不可变核心外观特征（英文或中文，供提示词锚定） */
  canonicalTraits: string;
  /** 归属角色 ID（可选） */
  ownerCharacterId?: string;
  /** 受保护的规范主参考图 Asset.id（永不被后续分镜图覆写） */
  canonicalImageAssetId?: string;
  /** 是否锁定不可随意删改 */
  locked?: boolean;
}

export type StateDeltaEntityType = 'character' | 'scene' | 'prop';

/** 某镜头触发的显式视觉状态变化 */
export interface EntityStateDelta {
  entityType: StateDeltaEntityType;
  entityId: string;
  /** 发生变化的可见属性键值，如 { wardrobe: '淋湿的深绿风衣', propState: '表盘碎裂' } */
  changeableAttrs: Record<string, string>;
  /** 剧情触发原因，如「第 4 镜跌入水中」 */
  reason: string;
}

export type ShotGroupRenderStrategy =
  | 'independent_clips'
  | 'native_multi_shot'
  | 'chained_last_frame';

export const SHOT_GROUP_STRATEGY_LABEL: Record<ShotGroupRenderStrategy, string> = {
  independent_clips: '逐镜独立渲染',
  native_multi_shot: '原生多镜头打包（Multi-Shot）',
  chained_last_frame: '尾帧接力连续生成',
};

/** 同场次连续分镜编组（2–6 镜） */
export interface ShotGroup {
  id: string;
  sceneId: string;
  title: string;
  /** 组内有序镜头 ID（建议 2–6 个连续分镜） */
  shotIds: string[];
  renderStrategy: ShotGroupRenderStrategy;
  /** 同组共享的全局视觉锚点（色板/胶片/氛围） */
  masterStyleAnchor?: string;
}
