import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { buildShotPrompt, buildAllPrompts } from '../src/domain/prompt';
import {
  buildExportManifest,
  buildZip,
  bundleFileName,
} from '../src/domain/export/bundle';
import {
  charactersToMarkdown,
  checkReportToMarkdown,
  safeFileName,
  scenesToMarkdown,
  shootingProgressToMarkdown,
  storyboardToCsv,
  storyboardToMarkdown,
} from '../src/domain/export';
import { runChecks } from '../src/domain/checks';
import { sampleProject } from '../src/data/samples/sampleProject';

describe('提示词适配引擎', () => {
  const project = sampleProject;
  const shot1 = project.shots.find((s) => s.id === 'shot-01')!;

  it('英文正文与中文对照都不为空', () => {
    const prompt = buildShotPrompt(project, shot1, 'kling');
    expect(prompt.en.length).toBeGreaterThan(20);
    expect(prompt.zh.length).toBeGreaterThan(20);
    expect(prompt.notes.length).toBeGreaterThan(3);
  });

  it('连续性锁的内容被写进英文正文（按短语核对，允许与身份描述去重）', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.activeLockIds.length > 0)!;
    const line = buildShotPrompt(project, shot, 'jimeng');

    // 锁面是一个逗号分隔的短语列表；与角色身份描述重复的短语会被去重，
    // 但每一条锁都至少要有实质内容进正文，否则锁就白加了。
    for (const lockPhrase of shot.activeLockIds
      .map((id) => project.characters.flatMap((c) => c.continuityLocks).find((l) => l.id === id))
      .filter(Boolean)) {
      const pieces = lockPhrase!.phrase
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const hit = pieces.filter((p) => line.en.includes(p));
      expect(hit.length, `锁「${lockPhrase!.label}」一个短语都没进正文`).toBeGreaterThan(0);
    }

    // 具体核对一条：棉袍
    expect(line.en).toContain('a worn padded cotton robe in faded indigo');
    // 以及那顶帽子——它正是「镜头之间帽子时有时无」的那条
    expect(line.en).toContain('felt hat');
  });

  it('未声明生效的锁不会被注入', () => {
    const shot = structuredClone(shot1);
    shot.activeLockIds = [];
    const prompt = buildShotPrompt(project, shot, 'jimeng');
    const character = project.characters.find((c) => c.id === 'ch-linchong')!;
    expect(prompt.en).not.toContain(character.continuityLocks[0]!.phrase);
  });

  it('每个片段都有「为什么这么写」的说明', () => {
    const prompt = buildShotPrompt(project, shot1, 'kling');
    for (const note of prompt.notes) {
      expect(note.label.length).toBeGreaterThan(0);
      expect(note.reason.length).toBeGreaterThan(10);
    }
    // 必须解释连续性锁、景别、运镜、画幅
    const labels = prompt.notes.map((n) => n.label).join(' ');
    expect(labels).toContain('连续性锁');
    expect(labels).toContain('景别');
    expect(labels).toContain('运镜');
    expect(labels).toContain('画幅');
  });

  it('Seedance 用分行标注式，即梦用连续散文式', () => {
    const seedance = buildShotPrompt(project, shot1, 'seedance');
    expect(seedance.en).toContain('Camera:');
    expect(seedance.en).toContain('Duration:');

    const jimeng = buildShotPrompt(project, shot1, 'jimeng');
    expect(jimeng.en).not.toContain('Camera:');
    expect(jimeng.en).toContain(',');
  });

  it('一次生成所有目标平台的提示词', () => {
    const bundles = buildAllPrompts(project);
    expect(bundles.map((b) => b.platform)).toEqual(project.brief.platforms);
    for (const bundle of bundles) {
      expect(bundle.lines).toHaveLength(project.shots.length);
    }
  });

  it('画面的地点信息来自场景卡', () => {
    const prompt = buildShotPrompt(project, shot1, 'kling');
    const scene = project.scenes.find((s) => s.id === 'sc-field')!;
    expect(prompt.en).toContain(scene.identity.summaryEn.split(',')[0]!);
  });

  it('中文对照里列出了锁定项，用户能看出自己要固定什么', () => {
    const prompt = buildShotPrompt(project, shot1, 'kling');
    expect(prompt.zh).toContain('【锁定】');
    expect(prompt.zh).toContain('林冲');
  });
});

describe('导出 · 分镜表', () => {
  const project = sampleProject;

  it('CSV 带 BOM 且有表头，行数与镜头数一致', () => {
    const csv = storyboardToCsv(project);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(project.shots.length + 1);
    expect(lines[0]).toContain('镜号');
    expect(lines[0]).toContain('起点');
    expect(lines[0]).toContain('动作');
    expect(lines[0]).toContain('终点');
  });

  it('CSV 里的引号与逗号被正确转义', () => {
    const p = structuredClone(project);
    p.shots[0]!.startState = '他说"走",然后离开';
    const csv = storyboardToCsv(p);
    expect(csv).toContain('"他说""走"",然后离开"');
  });

  it('Markdown 分镜表包含总时长与每一镜', () => {
    const md = storyboardToMarkdown(project);
    expect(md).toContain('分镜表');
    expect(md).toContain('总时长');
    for (const shot of project.shots) {
      expect(md).toContain(`第 ${shot.number} 镜`);
    }
  });
});

describe('导出 · 设定卡与检查单', () => {
  const project = sampleProject;

  it('角色卡把三层结构写清楚，并带出锁面', () => {
    const md = charactersToMarkdown(project);
    expect(md).toContain('身份（不变）');
    expect(md).toContain('连续性锁（必须跨镜保持）');
    expect(md).toContain('变体（随剧情变）');
    const lock = project.characters[0]!.continuityLocks[0]!;
    expect(md).toContain(lock.phrase);
  });

  it('场景卡带出固定元素、光线与色调', () => {
    const md = scenesToMarkdown(project);
    expect(md).toContain('固定元素（跨镜必须出现）');
    expect(md).toContain('光线与色调');
    const scene = project.scenes[0]!;
    expect(md).toContain(scene.fixedElements[0]!);
    expect(md).toContain(scene.mainColor);
  });

  it('检查单分三级，且每条都写了为什么和怎么改', () => {
    const report = runChecks(project);
    const md = checkReportToMarkdown(project, report);
    expect(md).toContain('穿帮检查单');
    expect(md).toContain('必须修');
    expect(md).toContain('**为什么**');
    expect(md).toContain('**怎么改**');
    expect(md).toContain('不是「生成出来一定没问题」');
  });

  it('拍摄进度表是可勾选的清单', () => {
    const md = shootingProgressToMarkdown(project);
    expect(md).toContain('- [ ] 生成关键帧图');
    for (const shot of project.shots) {
      expect(md).toContain(`## [ ] 第 ${shot.number} 镜`);
    }
  });

  it('文件名安全化会去掉非法字符', () => {
    expect(safeFileName('我的/项目:第一集?')).toBe('我的_项目_第一集_');
    expect(safeFileName('   ')).toBe('aniguide');
  });
});

describe('导出 · 压缩包', () => {
  const project = sampleProject;
  const report = runChecks(project);

  it('清单包含全部承诺的交付物', () => {
    const entries = buildExportManifest(project, report);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('分镜表.csv');
    expect(paths).toContain('分镜表.md');
    expect(paths).toContain('角色设定卡.md');
    expect(paths).toContain('场景设定卡.md');
    expect(paths).toContain('穿帮检查单.md');
    expect(paths).toContain('拍摄进度表.md');
    expect(paths).toContain('项目数据.json');
    for (const platform of project.brief.platforms) {
      expect(paths.some((p) => p.startsWith('提示词/'))).toBe(true);
      void platform;
    }
  });

  it('项目数据.json 可被重新解析', () => {
    const entries = buildExportManifest(project, report);
    const json = entries.find((e) => e.path === '项目数据.json')!;
    const parsed = JSON.parse(json.content);
    expect(parsed.id).toBe(project.id);
    expect(parsed.shots).toHaveLength(project.shots.length);
  });

  it('zip 能解开，且内容与清单一致', () => {
    const entries = buildExportManifest(project, report);
    const zipped = buildZip(entries);
    expect(zipped.length).toBeGreaterThan(0);
    const unzipped = unzipSync(zipped);
    expect(Object.keys(unzipped).sort()).toEqual(entries.map((e) => e.path).sort());
    const board = strFromU8(unzipped['分镜表.md']!);
    expect(board).toContain('第 1 镜');
  });

  it('压缩包文件名来自项目名，并带日期便于区分多次备份', () => {
    const name = bundleFileName(project);
    expect(name.startsWith(project.name)).toBe(true);
    expect(name).toMatch(/^.+_\d{4}-\d{2}-\d{2}\.zip$/);
  });
});
