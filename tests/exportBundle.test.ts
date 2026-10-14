// @vitest-environment jsdom
// 需要 atob / Blob 来处理 data URI，用真实实现而不是 mock
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import {
  assetEntries,
  buildExportManifest,
  buildZip,
  bundleFileName,
  consistencyReportMarkdown,
  dataUrlExtension,
  dataUrlToBytes,
  summarizeBundle,
} from '../src/domain/export/bundle';
import { runChecks } from '../src/domain/checks';
import { sampleProject } from '../src/data/samples/sampleProject';
import { SCHEMA_VERSION, type Asset, type AssetKind } from '../src/types/model';

/** 一张 1x1 的真实 PNG，用来验证「图片是以二进制进包的」而不是当成文本 */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9U4AAAAASUVORK5CYII=';

function makeAsset(
  kind: AssetKind,
  refId: string,
  overrides: Partial<Asset> = {},
): Asset {
  const now = new Date('2026-10-12T10:30:00.000Z').toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    id: `asset-${kind}-${refId}`,
    projectId: sampleProject.id,
    kind,
    refId,
    dataUrl: PNG_1PX,
    mimeType: 'image/png',
    promptSnapshot: 'a test prompt',
    byteSize: 68,
    ...overrides,
  };
}

describe('data URI 处理', () => {
  it('能取出原始字节，且确实是 PNG 的魔数', () => {
    const bytes = dataUrlToBytes(PNG_1PX);
    expect(bytes).not.toBeNull();
    // PNG 头：89 50 4E 47
    expect([bytes![0], bytes![1], bytes![2], bytes![3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('扩展名从 MIME 推导', () => {
    expect(dataUrlExtension('data:image/png;base64,AAA')).toBe('png');
    expect(dataUrlExtension('data:image/jpeg;base64,AAA')).toBe('jpg');
    expect(dataUrlExtension('data:image/webp;base64,AAA')).toBe('webp');
    expect(dataUrlExtension('data:image/unknown;base64,AAA')).toBe('png');
  });

  it('不是 data URI 时返回 null，不抛异常', () => {
    expect(dataUrlToBytes('https://example.com/a.png')).toBeNull();
    expect(dataUrlToBytes('')).toBeNull();
    expect(dataUrlToBytes('data:image/png,notbase64')).toBeNull();
  });

  it('base64 内容损坏时不崩', () => {
    expect(dataUrlToBytes('data:image/png;base64,!!!not-valid!!!')).toBeNull();
  });
});

describe('图包 · 目录与命名', () => {
  it('按类型分目录，文件名带对象名与生成时间', () => {
    const { entries } = assetEntries(sampleProject, [
      makeAsset('character-sheet-face', 'ch-linchong'),
    ]);
    expect(entries).toHaveLength(1);
    const path = entries[0]!.path;
    expect(path.startsWith('图包/角色/头部特写/')).toBe(true);
    expect(path).toContain('林冲');
    expect(path).toMatch(/\.png$/);
  });

  it('六种类型各有自己的目录', () => {
    const { entries } = assetEntries(sampleProject, [
      makeAsset('character-sheet', 'ch-linchong'),
      makeAsset('character-sheet-face', 'ch-linchong'),
      makeAsset('scene-plate', 'sc-temple'),
      makeAsset('first-frame', 'shot-01'),
      makeAsset('action-peak', 'shot-01'),
      makeAsset('end-frame', 'shot-01'),
    ]);
    const dirs = entries.map((e) => e.path.slice(0, e.path.lastIndexOf('/')));
    expect(new Set(dirs)).toEqual(
      new Set([
        '图包/角色/全身多视图',
        '图包/角色/头部特写',
        '图包/场景',
        '图包/镜头/首帧',
        '图包/镜头/动作关键帧',
        '图包/镜头/尾帧',
      ]),
    );
  });

  it('场景与镜头用它们的名字/镜号，一眼能认出', () => {
    const { entries } = assetEntries(sampleProject, [
      makeAsset('scene-plate', 'sc-temple'),
      makeAsset('first-frame', 'shot-01'),
    ]);
    const paths = entries.map((e) => e.path).join(' ');
    expect(paths).toContain('山神庙');
    expect(paths).toContain('第1镜');
  });

  it('同名同时间的多张图不会互相覆盖', () => {
    const same = [makeAsset('first-frame', 'shot-01'), makeAsset('first-frame', 'shot-01')];
    same[1]!.id = 'another-id';
    const { entries } = assetEntries(sampleProject, same);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.path).not.toBe(entries[1]!.path);
  });

  it('对象名里的非法字符被清理掉', () => {
    const project = structuredClone(sampleProject);
    project.characters[0]!.name = '林冲/风雪山神庙:第一集?';
    const { entries } = assetEntries(project, [makeAsset('character-sheet', 'ch-linchong')]);
    const name = entries[0]!.path.split('/').pop()!;
    expect(name).not.toContain('/');
    expect(name).not.toContain(':');
    expect(name).not.toContain('?');
  });

  it('没有 dataUrl 的素材被跳过并计数（不拿会过期的链接凑数）', () => {
    const { entries, skipped } = assetEntries(sampleProject, [
      makeAsset('first-frame', 'shot-01'),
      makeAsset('first-frame', 'shot-02', { dataUrl: undefined }),
    ]);
    expect(entries).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('找不到归属对象时用占位名而不是崩掉', () => {
    const { entries } = assetEntries(sampleProject, [makeAsset('first-frame', '不存在的镜头')]);
    expect(entries[0]!.path).toContain('未知镜头');
  });
});

describe('一致性总览', () => {
  it('逐张列出对象、时间、模型、参考图数量与当时生效的锁', () => {
    const md = consistencyReportMarkdown(sampleProject, [
      makeAsset('first-frame', 'shot-01', {
        model: 'qwen-image-3.0-pro',
        referenceCount: 2,
        lockPhrases: ['a worn padded cotton robe', 'square face, thick brows'],
      }),
    ]);
    expect(md).toContain('一致性总览');
    expect(md).toContain('第1镜');
    expect(md).toContain('qwen-image-3.0-pro');
    expect(md).toContain('2 张');
    expect(md).toContain('a worn padded cotton robe');
  });

  it('纯文生图的图明确标成「无」，这是排查时最重要的线索', () => {
    const md = consistencyReportMarkdown(sampleProject, [makeAsset('first-frame', 'shot-01')]);
    expect(md).toContain('无（纯文生图）');
  });

  it('说明了怎么用这份表排查问题', () => {
    const md = consistencyReportMarkdown(sampleProject, [makeAsset('first-frame', 'shot-01')]);
    expect(md).toContain('怎么用这份表');
    expect(md).toContain('参考图');
    expect(md).toContain('漏勾');
  });

  it('没有图片时说明情况而不是给一张空表', () => {
    const md = consistencyReportMarkdown(sampleProject, []);
    expect(md).toContain('还没有生成过任何图片');
  });

  it('按类型分组，没有的类型不出现', () => {
    const md = consistencyReportMarkdown(sampleProject, [makeAsset('scene-plate', 'sc-temple')]);
    expect(md).toContain('场景参考板');
    expect(md).not.toContain('## 关键帧');
  });
});

describe('导出清单 · 含图包', () => {
  const report = runChecks(sampleProject);

  it('没有图片时清单与原来一致（不凭空多出图包）', () => {
    const paths = buildExportManifest(sampleProject, report).map((e) => e.path);
    expect(paths).toContain('分镜表.csv');
    expect(paths).toContain('项目数据.json');
    expect(paths).not.toContain('一致性总览.md');
    expect(paths.some((p) => p.startsWith('图包/'))).toBe(false);
  });

  it('有图片时清单里多出图包与一致性总览', () => {
    const paths = buildExportManifest(sampleProject, report, {
      assets: [makeAsset('character-sheet-face', 'ch-linchong')],
    }).map((e) => e.path);
    expect(paths).toContain('一致性总览.md');
    expect(paths.some((p) => p.startsWith('图包/'))).toBe(true);
  });

  it('图片条目走二进制，文本条目走字符串', () => {
    const entries = buildExportManifest(sampleProject, report, {
      assets: [makeAsset('character-sheet', 'ch-linchong')],
    });
    const image = entries.find((e) => e.bytes);
    const text = entries.find((e) => e.path === '分镜表.md');
    expect(image?.bytes).toBeInstanceOf(Uint8Array);
    expect(text?.bytes).toBeUndefined();
    expect(text?.content.length).toBeGreaterThan(0);
  });

  it('统计结果与清单一致，界面能据此提示', () => {
    const entries = buildExportManifest(sampleProject, report, {
      assets: [makeAsset('character-sheet', 'ch-linchong'), makeAsset('first-frame', 'shot-01')],
    });
    const summary = summarizeBundle(entries);
    expect(summary.imageCount).toBe(2);
    expect(summary.imageBytes).toBeGreaterThan(0);
    expect(summary.textCount).toBeGreaterThan(0);
  });
});

describe('打包 · 图片以真实二进制进 zip', () => {
  const report = runChecks(sampleProject);

  it('zip 能解开，图片是 PNG 字节而不是文本', () => {
    const entries = buildExportManifest(sampleProject, report, {
      assets: [makeAsset('character-sheet-face', 'ch-linchong')],
    });
    const zip = buildZip(entries);
    const unzipped = unzipSync(zip);

    const imagePath = Object.keys(unzipped).find((p) => p.startsWith('图包/'))!;
    expect(imagePath).toBeDefined();
    const imageBytes = unzipped[imagePath]!;
    expect([imageBytes[0], imageBytes[1], imageBytes[2], imageBytes[3]]).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);

    // 文本仍然是可读的中文
    const board = strFromU8(unzipped['分镜表.md']!);
    expect(board).toContain('分镜表');

    const consistency = strFromU8(unzipped['一致性总览.md']!);
    expect(consistency).toContain('一致性总览');
  });

  it('导出文件名带日期，便于区分多次备份', () => {
    expect(bundleFileName(sampleProject)).toMatch(/_\d{4}-\d{2}-\d{2}\.zip$/);
  });

  it('多张图时 zip 里每个路径唯一', () => {
    const assets = Array.from({ length: 6 }, (_, i) =>
      makeAsset('first-frame', 'shot-01', { id: `a${i}` }),
    );
    const zip = buildZip(buildExportManifest(sampleProject, report, { assets }));
    const unzipped = unzipSync(zip);
    const imagePaths = Object.keys(unzipped).filter((p) => p.startsWith('图包/'));
    expect(imagePaths).toHaveLength(6);
    expect(new Set(imagePaths).size).toBe(6);
  });

  it('图很大时也不会出错（模拟 200KB 的图）', () => {
    // 注意：不要断言「zip 一定超过某个体积」——重复字符（如 'AAAA…'）即使 level 6
    // 也能压到极小，那种断言会假失败。真正要验证的是「图片确实进了包」，
    // 所以这里拿带图与不带图的两个包对比。
    const withoutImages = buildZip(buildExportManifest(sampleProject, report));
    const bigAsset = makeAsset('first-frame', 'shot-01', {
      dataUrl: `data:image/png;base64,${'A'.repeat(270_000)}`,
    });
    const withImage = buildZip(
      buildExportManifest(sampleProject, report, { assets: [bigAsset] }),
    );

    expect(withImage.length).toBeGreaterThan(withoutImages.length);
    const unzipped = unzipSync(withImage);
    const imagePath = Object.keys(unzipped).find((p) => p.startsWith('图包/'))!;
    // 200KB 的 base64 解出来应当是 200000 字节左右，且首字节是 0x00（'A' 解码后）
    expect(unzipped[imagePath]!.length).toBeGreaterThan(190_000);
  });
});
