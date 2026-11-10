import type { Asset, AssetKind, Project } from '../types/model';

/**
 * 图库覆盖度判定。
 *
 * 主页、向导页、各操作页都需要回答同一个问题：「这个项目的图出到哪了」。
 * 之前每个页面各数各的，规则迟早会漂；这里抽成纯函数，只依赖 project + gallery。
 *
 * 重要语义：gallery 是按 refId 懒加载的，`undefined` 表示**还没加载**，
 * `[]` 表示已经加载但一张图都没有。调用方不能用「计数为 0」推断「没出图」，
 * 必须先看 loaded——否则页面刚挂载时会把「正在加载」误判成「已齐」或反过来。
 */

export type Gallery = Record<string, Asset[] | undefined>;

export interface ImageCoverage {
  /** 所有角色 / 场景 / 镜头的图库 key 都已加载（[] 也算已加载） */
  loaded: boolean;
  hasCharacters: boolean;
  hasScenes: boolean;
  hasShots: boolean;
  /** 有全身多视图的角色数 */
  charsWithSheet: number;
  /** 有头部特写的角色数 */
  charsWithFace: number;
  /** 两张都有（全身 + 特写）的角色数 */
  charsReady: number;
  /** 有场景参考板的场景数 */
  scenesReady: number;
  firstReady: number;
  peakReady: number;
  endReady: number;
  /** 三帧齐全的镜头数 */
  framesReady: number;
  /** 参考图齐：每个角色都有全身+特写，每个场景都有参考板（角色和场景都不能为空） */
  referencesReady: boolean;
  /** 全部图齐：参考图 + 每镜三帧 */
  imagesReady: boolean;
}

function hasKind(assets: Asset[] | undefined, kind: AssetKind): boolean {
  return (assets ?? []).some((asset) => asset.kind === kind);
}

export function computeImageCoverage(project: Project | null, gallery: Gallery): ImageCoverage {
  const characters = project?.characters ?? [];
  const scenes = project?.scenes ?? [];
  const shots = project?.shots ?? [];

  const loaded = [...characters, ...scenes, ...shots].every(
    (item) => gallery[item.id] !== undefined,
  );

  const charsWithSheet = characters.filter((c) => hasKind(gallery[c.id], 'character-sheet')).length;
  const charsWithFace = characters.filter((c) =>
    hasKind(gallery[c.id], 'character-sheet-face'),
  ).length;
  const charsReady = characters.filter(
    (c) =>
      hasKind(gallery[c.id], 'character-sheet') &&
      hasKind(gallery[c.id], 'character-sheet-face'),
  ).length;
  const scenesReady = scenes.filter((s) => hasKind(gallery[s.id], 'scene-plate')).length;

  const firstReady = shots.filter((s) => hasKind(gallery[s.id], 'first-frame')).length;
  const peakReady = shots.filter((s) => hasKind(gallery[s.id], 'action-peak')).length;
  const endReady = shots.filter((s) => hasKind(gallery[s.id], 'end-frame')).length;
  const framesReady = shots.filter(
    (s) =>
      hasKind(gallery[s.id], 'first-frame') &&
      hasKind(gallery[s.id], 'action-peak') &&
      hasKind(gallery[s.id], 'end-frame'),
  ).length;

  const referencesReady =
    characters.length > 0 &&
    scenes.length > 0 &&
    charsReady === characters.length &&
    scenesReady === scenes.length;
  const imagesReady = referencesReady && shots.length > 0 && framesReady === shots.length;

  return {
    loaded,
    hasCharacters: characters.length > 0,
    hasScenes: scenes.length > 0,
    hasShots: shots.length > 0,
    charsWithSheet,
    charsWithFace,
    charsReady,
    scenesReady,
    firstReady,
    peakReady,
    endReady,
    framesReady,
    referencesReady,
    imagesReady,
  };
}
