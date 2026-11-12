import { describe, expect, it } from 'vitest';
import { ASSET_KIND_LABEL, type Asset, type Project } from '../src/types/model';
import { sampleProject } from '../src/data/samples/sampleProject';
import { runChecks } from '../src/domain/checks';
import {
  buildExportManifest,
  summarizeBundle,
} from '../src/domain/export/bundle';
import { computeImageCoverage } from '../src/components/imageCoverage';
import { framePrereqMessage, isFramePrereqMet, missingBeforeFrames } from '../src/domain/image/order';

/**
 * 主帧的「数据/导出/覆盖度/前置检查」消费点（P2-b · A）
 *
 * 这些点是评审 B5 列出的 AssetKind 扩展 checklist 里不需要 store 的部分：
 * label、导出目录/说明、覆盖度、前置检查。新增一个 AssetKind 时，
 * 任何一处漏掉都会表现成「图库/导出里坏图或统计错」，所以逐项钉住。
 */

const PROJECT: Project = sampleProject;
const scene = PROJECT.scenes[0]!;

function stagingAsset(overrides: Partial<Asset> = {}): Asset {
  const stamp = new Date().toISOString();
  return {
    id: 'staging-1',
    projectId: PROJECT.id,
    kind: 'staging-frame',
    refId: scene.id,
    dataUrl: 'data:image/png;base64,STG',
    mimeType: 'image/png',
    promptSnapshot: 'staging prompt',
    byteSize: 321,
    createdAt: stamp,
    updatedAt: stamp,
    schemaVersion: 1,
    ...overrides,
  };
}

describe('AssetKind：label 与导出目录', () => {
  it('**ASSET_KIND_LABEL 有主帧的中文名**（Record 由 tsc 兜底，这里锁文案）', () => {
    expect(ASSET_KIND_LABEL['staging-frame']).toBe('场景主帧');
  });

  it('**导出包：主帧进「图包★/场景/主帧」**，且说明文件提到主帧', () => {
    const entries = buildExportManifest(PROJECT, runChecks(PROJECT), {
      assets: [stagingAsset()],
    });
    const paths = entries.map((entry) => entry.path);
    expect(paths.some((path) => path.startsWith(`图包★/场景/主帧/${scene.name}`))).toBe(true);
    const readme = entries.find((entry) => entry.path === '先看这里.txt')!;
    expect(readme.content).toContain('主帧');
    expect(readme.content).toContain('单参考图模型会优先用它');
  });

  it('主帧计入导出统计（summarizeBundle 按图片计）', () => {
    const entries = buildExportManifest(PROJECT, runChecks(PROJECT), {
      assets: [stagingAsset()],
    });
    const summary = summarizeBundle(entries);
    expect(summary.imageCount).toBe(1);
    expect(summary.imageBytes).toBeGreaterThan(0);
  });

  it('**无图导出契约不变**：没有图时说明文件不再提图包/主帧', () => {
    const entries = buildExportManifest(PROJECT, runChecks(PROJECT));
    const readme = entries.find((entry) => entry.path === '先看这里.txt')!;
    expect(readme.content).not.toContain('图包★');
    expect(readme.content).not.toContain('主帧');
  });
});

describe('覆盖度：stagingReady 不混入 framesReady', () => {
  function galleryWith(overrides: Record<string, Asset[]>) {
    const gallery: Record<string, Asset[]> = {};
    for (const item of [
      ...PROJECT.characters.map((c) => c.id),
      ...PROJECT.scenes.map((s) => s.id),
      ...PROJECT.shots.map((s) => s.id),
    ]) {
      gallery[item] = overrides[item] ?? [];
    }
    return gallery;
  }

  it('**每个场景都有主帧 → stagingReady=true**，但三帧/图片仍不算齐', () => {
    const overrides: Record<string, Asset[]> = {};
    for (const item of PROJECT.scenes) overrides[item.id] = [stagingAsset({ refId: item.id })];
    const coverage = computeImageCoverage(PROJECT, galleryWith(overrides));
    expect(coverage.scenesWithStaging).toBe(PROJECT.scenes.length);
    expect(coverage.stagingReady).toBe(true);
    // 主帧不是三帧：framesReady/imagesReady 不受影响
    expect(coverage.framesReady).toBe(0);
    expect(coverage.imagesReady).toBe(false);
  });

  it('只有一个场景有主帧 → stagingReady=false', () => {
    const coverage = computeImageCoverage(
      PROJECT,
      galleryWith({ [scene.id]: [stagingAsset()] }),
    );
    expect(coverage.scenesWithStaging).toBe(1);
    expect(coverage.stagingReady).toBe(PROJECT.scenes.length === 1);
  });
});

describe('前置检查：主帧不算「角色形象图/场景板」', () => {
  it('只有主帧时仍提示缺角色形象图与场景参考板', () => {
    const gap = missingBeforeFrames(PROJECT, [stagingAsset()]);
    expect(gap.characters.length).toBe(PROJECT.characters.length);
    expect(gap.scenes.length).toBe(PROJECT.scenes.length);
    expect(isFramePrereqMet(gap)).toBe(false);
    expect(framePrereqMessage(gap)).toContain('还没有形象图');
  });

  it('前置图都齐时，多一张主帧不会把结果变成「缺」', () => {
    const fulfilled: Pick<Asset, 'refId' | 'kind' | 'dataUrl'>[] = [];
    for (const character of PROJECT.characters) {
      fulfilled.push(
        { refId: character.id, kind: 'character-sheet', dataUrl: 'data:image/png;base64,A' },
        { refId: character.id, kind: 'character-sheet-face', dataUrl: 'data:image/png;base64,B' },
      );
    }
    for (const item of PROJECT.scenes) {
      fulfilled.push({ refId: item.id, kind: 'scene-plate', dataUrl: 'data:image/png;base64,C' });
    }
    expect(isFramePrereqMet(missingBeforeFrames(PROJECT, fulfilled))).toBe(true);
    expect(framePrereqMessage(missingBeforeFrames(PROJECT, [...fulfilled, stagingAsset()]))).toBeNull();
  });
});
