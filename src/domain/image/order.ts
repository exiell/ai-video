import type { Asset, Project } from '../../types/model';

/**
 * 出图顺序检查（v0.53）
 *
 * ===========================================================================
 * 为什么要在点「生成」的时候拦一下
 * ===========================================================================
 * 三帧的参考图里，角色形象图与场景参考板是前两位的锚点：
 *
 *   帧 ← 角色形象图（脸与体型）
 *   帧 ← 场景参考板（同一个地方长什么样、光从哪来）
 *
 * 这两样还没出就出帧，工具不会报错——它只是**少放两张参考图**，
 * 然后让模型拿文字去猜。猜出来的脸和场景当然对不上前一张，
 * 用户看到的却是「一致性不好」，找不到原因。
 *
 * 所以顺序错的时候要说一句。但只说话不行，还得让人能继续：
 * 有时候就是想先出一张看看风格，那不是错误。
 *
 * 文案要求（用户明确提过）：**简洁清晰，文字尽可能少**。
 * 所以这里只回答三件事：谁还没有图、为什么需要它、要不要继续。
 * 不讲参考图槽位、不讲重新生成的成本——那些在别的地方说过。
 */
export interface FramePrereq {
  /** 缺形象图的角色名 */
  characters: string[];
  /** 缺参考板的场景名 */
  scenes: string[];
}

function hasImage(
  assets: readonly Pick<Asset, 'refId' | 'kind' | 'dataUrl'>[],
  refId: string,
  kind: Asset['kind'],
): boolean {
  return assets.some((asset) => asset.refId === refId && asset.kind === kind && asset.dataUrl);
}

/**
 * 出三帧之前还缺哪些图。
 *
 * 角色要**全身与特写都有**才算齐：远景靠全身图锁体型，近景靠头像锁脸，
 * 缺哪张就会在对应的景别上掉链子。只有一张也算缺。
 */
export function missingBeforeFrames(
  project: Pick<Project, 'characters' | 'scenes'>,
  assets: readonly Pick<Asset, 'refId' | 'kind' | 'dataUrl'>[],
): FramePrereq {
  return {
    characters: project.characters
      .filter(
        (character) =>
          !hasImage(assets, character.id, 'character-sheet') ||
          !hasImage(assets, character.id, 'character-sheet-face'),
      )
      .map((character) => character.name),
    scenes: project.scenes
      .filter((scene) => !hasImage(assets, scene.id, 'scene-plate'))
      .map((scene) => scene.name),
  };
}

export function isFramePrereqMet(gap: FramePrereq): boolean {
  return gap.characters.length === 0 && gap.scenes.length === 0;
}

/**
 * 名字列表。超过三个就折起来，否则一条提示能占满整屏。
 * 数字照实说，不写「等角色」这种含糊话。
 */
export function describeNames(names: readonly string[]): string {
  const head = names
    .slice(0, 3)
    .map((name) => `「${name}」`)
    .join('');
  return names.length > 3 ? `${head}等 ${names.length} 个` : head;
}

/**
 * 出三帧前的提示语。都齐了返回 null，调用方据此决定要不要问。
 */
export function framePrereqMessage(gap: FramePrereq): string | null {
  const parts: string[] = [];
  if (gap.characters.length > 0) {
    parts.push(`角色${describeNames(gap.characters)}还没有形象图`);
  }
  if (gap.scenes.length > 0) {
    parts.push(`场景${describeNames(gap.scenes)}还没有参考板`);
  }
  if (parts.length === 0) return null;
  return `${parts.join('，')}。\n三帧会拿它们当参考图，缺了只能靠文字猜。\n\n仍然生成？`;
}
