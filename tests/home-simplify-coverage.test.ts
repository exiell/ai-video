import { describe, expect, it } from 'vitest';
import { computeImageCoverage } from '../src/components/imageCoverage';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Asset, AssetKind, Project } from '../src/types/model';

/**
 * 图库覆盖度纯函数矩阵
 *
 * 这里盯的是「gallery 懒加载」这个容易误判的语义：
 *  - key 是 undefined = 还没加载，不是「已齐」也不是「没图」；
 *  - key 是 [] = 已加载，确实一张图都没有。
 * 主页「下一步」和向导页进度都依赖这份判定，规则漂了会直接推荐错步骤。
 */

const project: Project = structuredClone(sampleProject);

function asset(refId: string, kind: AssetKind): Asset {
  return {
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    id: `${refId}-${kind}`,
    projectId: project.id,
    kind,
    refId,
    mimeType: 'image/png',
    promptSnapshot: 'test',
  };
}

/** 所有对象都加载了，但一张图都没有 */
function emptyLoadedGallery(): Record<string, Asset[]> {
  const gallery: Record<string, Asset[]> = {};
  for (const character of project.characters) gallery[character.id] = [];
  for (const scene of project.scenes) gallery[scene.id] = [];
  for (const shot of project.shots) gallery[shot.id] = [];
  return gallery;
}

/** 参考图齐、三帧一张都没有 */
function refsReadyGallery(): Record<string, Asset[]> {
  const gallery = emptyLoadedGallery();
  for (const character of project.characters) {
    gallery[character.id] = [
      asset(character.id, 'character-sheet'),
      asset(character.id, 'character-sheet-face'),
    ];
  }
  for (const scene of project.scenes) gallery[scene.id] = [asset(scene.id, 'scene-plate')];
  return gallery;
}

/** 全部齐 */
function fullGallery(): Record<string, Asset[]> {
  const gallery = refsReadyGallery();
  for (const shot of project.shots) {
    gallery[shot.id] = [
      asset(shot.id, 'first-frame'),
      asset(shot.id, 'action-peak'),
      asset(shot.id, 'end-frame'),
    ];
  }
  return gallery;
}

describe('computeImageCoverage 矩阵', () => {
  it('没有项目：所有计数为 0，loaded 为 true（没有东西可加载）', () => {
    const coverage = computeImageCoverage(null, {});
    expect(coverage.loaded).toBe(true);
    expect(coverage.hasCharacters).toBe(false);
    expect(coverage.charsReady).toBe(0);
    expect(coverage.scenesReady).toBe(0);
    expect(coverage.framesReady).toBe(0);
    expect(coverage.referencesReady).toBe(false);
    expect(coverage.imagesReady).toBe(false);
  });

  it('空项目：没有角色/场景/镜头，参考图与图片都不算齐', () => {
    const empty: Project = {
      ...structuredClone(project),
      characters: [],
      scenes: [],
      shots: [],
    };
    const coverage = computeImageCoverage(empty, {});
    expect(coverage.loaded).toBe(true);
    expect(coverage.referencesReady).toBe(false);
    expect(coverage.imagesReady).toBe(false);
  });

  it('gallery 完全没加载：loaded=false，不能当成已齐', () => {
    const coverage = computeImageCoverage(project, {});
    expect(coverage.loaded).toBe(false);
    expect(coverage.charsReady).toBe(0);
    expect(coverage.framesReady).toBe(0);
    expect(coverage.referencesReady).toBe(false);
    expect(coverage.imagesReady).toBe(false);
  });

  it('已加载但全是空数组：loaded=true，图没出', () => {
    const coverage = computeImageCoverage(project, emptyLoadedGallery());
    expect(coverage.loaded).toBe(true);
    expect(coverage.referencesReady).toBe(false);
    expect(coverage.imagesReady).toBe(false);
  });

  it('部分角色只有全身没有特写：charsReady 少于角色数，参考图不算齐', () => {
    const gallery = refsReadyGallery();
    const first = project.characters[0]!;
    gallery[first.id] = [asset(first.id, 'character-sheet')];
    const coverage = computeImageCoverage(project, gallery);
    expect(coverage.loaded).toBe(true);
    expect(coverage.charsWithSheet).toBe(project.characters.length);
    expect(coverage.charsWithFace).toBe(project.characters.length - 1);
    expect(coverage.charsReady).toBe(project.characters.length - 1);
    expect(coverage.referencesReady).toBe(false);
  });

  it('部分镜头帧不齐：framesReady 少于镜头数，三帧不算齐', () => {
    const gallery = fullGallery();
    const first = project.shots[0]!;
    // 其他镜头三帧都在，只让第一镜缺尾帧
    gallery[first.id] = [asset(first.id, 'first-frame'), asset(first.id, 'action-peak')];
    const coverage = computeImageCoverage(project, gallery);
    expect(coverage.loaded).toBe(true);
    expect(coverage.firstReady).toBe(project.shots.length);
    expect(coverage.peakReady).toBe(project.shots.length);
    expect(coverage.endReady).toBe(project.shots.length - 1);
    expect(coverage.framesReady).toBe(project.shots.length - 1);
    expect(coverage.referencesReady).toBe(true);
    expect(coverage.imagesReady).toBe(false);
  });

  it('参考图齐、三帧没出：referencesReady=true，imagesReady=false', () => {
    const coverage = computeImageCoverage(project, refsReadyGallery());
    expect(coverage.loaded).toBe(true);
    expect(coverage.referencesReady).toBe(true);
    expect(coverage.framesReady).toBe(0);
    expect(coverage.imagesReady).toBe(false);
  });

  it('全齐：imagesReady=true，三帧每类都达到镜头数', () => {
    const coverage = computeImageCoverage(project, fullGallery());
    expect(coverage.loaded).toBe(true);
    expect(coverage.charsReady).toBe(project.characters.length);
    expect(coverage.scenesReady).toBe(project.scenes.length);
    expect(coverage.firstReady).toBe(project.shots.length);
    expect(coverage.peakReady).toBe(project.shots.length);
    expect(coverage.endReady).toBe(project.shots.length);
    expect(coverage.framesReady).toBe(project.shots.length);
    expect(coverage.referencesReady).toBe(true);
    expect(coverage.imagesReady).toBe(true);
  });

  it('参考图齐但没有镜头：三帧与整体图片都不算齐', () => {
    const noShots: Project = { ...structuredClone(project), shots: [] };
    const gallery = emptyLoadedGallery();
    for (const character of noShots.characters) {
      gallery[character.id] = [
        asset(character.id, 'character-sheet'),
        asset(character.id, 'character-sheet-face'),
      ];
    }
    for (const scene of noShots.scenes) gallery[scene.id] = [asset(scene.id, 'scene-plate')];
    const coverage = computeImageCoverage(noShots, gallery);
    expect(coverage.loaded).toBe(true);
    expect(coverage.referencesReady).toBe(true);
    expect(coverage.hasShots).toBe(false);
    expect(coverage.imagesReady).toBe(false);
  });
});
