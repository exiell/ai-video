import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildExportManifest, buildZip, dataUrlToBytes } from '../src/domain/export/bundle';
import { runChecks } from '../src/domain/checks';
import { parseImportedProject } from '../src/services/storage';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Asset, AssetKind, Project } from '../src/types/model';

/**
 * 导出包的目录分工
 *
 * ===========================================================================
 * 为什么这么分
 * ===========================================================================
 * 一个项目导出来是十几二十个文件。用户打开压缩包时只有两个问题：
 *
 *   1. 哪些是我现在就要拿去用的？
 *   2. 哪些是回头才查的？
 *
 * 所以两个目录名后面带 ★（视频提示词★ / 图包★），其余全部收进「参考文档」。
 * 根目录只留三样：一页说明、两个 ★ 目录、以及用来导入的 项目数据.json。
 *
 * 这份测试盯三件事：
 *   - 分工没被后来的改动打乱（★ 只在两个目录上，参考文档不再散在根目录）
 *   - 提示词文件只保留能直接粘的东西
 *   - 导出的 zip 解开后，项目数据.json 仍然能被导入
 */

function fresh(): Project {
  return structuredClone(sampleProject);
}

function asset(refId: string, kind: AssetKind): Asset {
  const stamp = new Date(1_700_000_000_000).toISOString();
  return {
    id: `a-${kind}-${refId}`,
    schemaVersion: 1,
    createdAt: stamp,
    updatedAt: stamp,
    projectId: 'p1',
    refId,
    kind,
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    promptSnapshot: 'prompt',
  };
}

function manifest(project: Project, assets: Asset[] = []) {
  return buildExportManifest(project, runChecks(project), { assets });
}

describe('导出包的目录分工', () => {
  it('根目录只剩说明、两个 ★ 目录和导入用的 json', () => {
    const entries = manifest(fresh(), [asset('c1', 'character-sheet')]);
    const roots = new Set(entries.map((e) => (e.path.includes('/') ? `${e.path.split('/')[0]}/` : e.path)));
    expect([...roots].sort()).toEqual(
      ['先看这里.txt', '图包★/', '参考文档/', '视频提示词★/', '项目数据.json'].sort(),
    );
  });

  it('只有两个目录带 ★', () => {
    const entries = manifest(fresh(), [asset('c1', 'character-sheet')]);
    const starred = new Set(
      entries
        .filter((e) => e.path.includes('★'))
        .map((e) => e.path.split('/')[0]),
    );
    expect([...starred].sort()).toEqual(['图包★', '视频提示词★']);
  });

  it('角色卡、场景卡、检查单这些都在参考文档里', () => {
    const paths = manifest(fresh()).map((e) => e.path);
    for (const name of [
      '角色设定卡.md',
      '场景设定卡.md',
      '分镜表.md',
      '分镜表.csv',
      '穿帮检查单.md',
      '拍摄进度表.md',
      '镜头衔接表.md',
      '图片提示词.md',
    ]) {
      expect(paths).toContain(`参考文档/${name}`);
    }
  });

  it('**没有图时，说明文件不能承诺不存在的图包与一致性总览**', () => {
    const readme = manifest(fresh()).find((e) => e.path === '先看这里.txt');
    expect(readme).toBeTruthy();
    expect(readme!.content).toContain('视频提示词★');
    expect(readme!.content).toContain('项目数据.json');
    expect(readme!.content).not.toContain('图包★');
    expect(readme!.content).not.toContain('一致性总览');
    // 无图时也不该生成这两个目录/文件
    const paths = manifest(fresh()).map((e) => e.path);
    expect(paths.some((p) => p.startsWith('图包★/'))).toBe(false);
    expect(paths).not.toContain('参考文档/一致性总览.md');
  });

  it('有图时，说明文件写清两个 ★ 目录与导入挑哪个文件', () => {
    const project = fresh();
    const readme = manifest(project, [asset(project.characters[0]!.id, 'character-sheet')]).find(
      (e) => e.path === '先看这里.txt',
    );
    expect(readme).toBeTruthy();
    expect(readme!.content).toContain('视频提示词★');
    expect(readme!.content).toContain('图包★');
    expect(readme!.content).toContain('一致性总览');
    expect(readme!.content).toContain('项目数据.json');
  });

  it('**素材里没有任何可打包的图片时，按「无图」写说明并说出跳过了几张**', () => {
    const project = fresh();
    const broken = { ...asset(project.characters[0]!.id, 'character-sheet'), dataUrl: undefined };
    const entries = manifest(project, [broken]);
    const readme = entries.find((e) => e.path === '先看这里.txt');
    expect(readme).toBeTruthy();
    expect(readme!.content).not.toContain('图包★');
    expect(readme!.content).toContain('有 1 张图没能放进包里');
    expect(entries.some((e) => e.path.startsWith('图包★/'))).toBe(false);
    expect(entries.map((e) => e.path)).not.toContain('参考文档/一致性总览.md');
  });
});

describe('提示词文件只留能直接粘的东西', () => {
  it('有英文正文与中文对照，没有逐项说明', () => {
    const file = manifest(fresh()).find((e) => e.path.startsWith('视频提示词★/'));
    expect(file).toBeTruthy();
    expect(file!.content).toContain('英文正文');
    expect(file!.content).toContain('中文对照');
    expect(file!.content).not.toContain('为什么这么写');
    expect(file!.content).not.toContain('逐项说明');
  });

  it('开头仍然交代画幅与负向词怎么用', () => {
    const file = manifest(fresh()).find((e) => e.path.startsWith('视频提示词★/'));
    expect(file!.content).toContain('画幅');
  });
});

describe('导出之后还能导回来', () => {
  it('zip 解开，项目数据.json 能被 parseImportedProject 接受', () => {
    const project = fresh();
    const zip = buildZip(manifest(project, [asset(project.characters[0]!.id, 'character-sheet')]));
    const unzipped = unzipSync(zip);

    const jsonPath = Object.keys(unzipped).find((p) => p.endsWith('项目数据.json'));
    expect(jsonPath).toBeTruthy();

    const result = parseImportedProject(strFromU8(unzipped[jsonPath!]!));
    expect(result.ok).toBe(true);
    expect(result.project?.shots.length).toBe(project.shots.length);
    expect(result.project?.characters.length).toBe(project.characters.length);
  });

  it('图片进 zip 是二进制，不是一串 base64 文本', () => {
    const project = fresh();
    const zip = buildZip(manifest(project, [asset(project.characters[0]!.id, 'character-sheet')]));
    const unzipped = unzipSync(zip);
    const imagePath = Object.keys(unzipped).find((p) => p.startsWith('图包★/'))!;
    expect(imagePath).toBeTruthy();
    const bytes = unzipped[imagePath]!;
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(dataUrlToBytes('not-a-data-url')).toBeNull();
  });
});
