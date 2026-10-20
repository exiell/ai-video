import { describe, expect, it } from 'vitest';
import {
  checkContinuity,
  continuitySheetMarkdown,
  hasNextShot,
  nextShot,
} from '../src/domain/checks/continuity';
import { runChecks } from '../src/domain/checks';
import { buildShotPrompt } from '../src/domain/prompt';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Project, SceneCard, Shot } from '../src/types/model';

/**
 * 镜头衔接检查（v0.19 新增）
 *
 * 盯三件事：
 *  1. 有没有写明衔接
 *  2. 尾帧与下一镜首帧有没有明确矛盾
 *  3. 地点/时间跳跃有没有交代
 *
 * 同时盯**不误报**——误报会让整份检查单失去可信度。
 *
 * ⚠️ 这里刻意**不用**示例项目做主要夹具：示例项目里 shot-02 与 shot-03 本来就不在同一场景，
 * 用它测「状态矛盾」会被无关因素挡住。自造一个只有两镜、同场景的最小项目，
 * 每个测试只验证一件事。
 */

function makeScene(id: string, name: string, summaryEn: string) {
  return {
    id,
    name,
    identity: { summary: '', placeType: '', spatialStructure: '', summaryEn },
    fixedElements: [] as string[],
    lightDirection: '',
    mainColor: '',
    continuityLocks: [] as SceneCard['continuityLocks'],
    variants: [] as SceneCard['variants'],
    shotIds: [] as string[],
    schemaVersion: 1,
    createdAt: '',
    updatedAt: '',
  };
}

function makeShot(overrides: Partial<Shot> & { id: string; number: number }): Shot {
  return {
    duration: 3,
    shotSize: 'medium',
    cameraPosition: '',
    cameraMove: 'static',
    startState: '他站在屋里',
    action: '他抬起头',
    endState: '他看着门口',
    dialogue: '',
    sound: '',
    mood: '',
    transition: '硬切',
    sceneId: 'sc-a',
    characterIds: [],
    activeLockIds: [],
    variantIds: [],
    offscreenCharacters: [],
    sourceSceneId: '',
    ...overrides,
  };
}

/** 两镜、同一场景的最小项目。测状态矛盾时用它，排除一切无关因素。 */
function twoShots(endState: string, startState: string, notes: [string, string] = ['接着往下', '接着往下']): Project {
  const project: Project = {
    id: 'p',
    name: 't',
    logline: '',
    schemaVersion: 1,
    createdAt: '',
    updatedAt: '',
    brief: {
      platforms: ['jimeng'],
      aspectRatio: '16:9',
      targetDuration: 10,
      styleTone: '',
      styleTags: [],
      negativePrompt: '',
    },
    story: {
      id: 'st',
      source: 'generated',
      schemaVersion: 1,
      createdAt: '',
      updatedAt: '',
      body: '',
      charactersNote: '',
      setting: '',
      conflict: '',
      ending: '',
      scenes: [],
    },
    characters: [],
    scenes: [makeScene('sc-a', '屋里', 'a room')],
    shots: [
      makeShot({ id: 'a', number: 1, endState, continuityNote: notes[0] }),
      makeShot({ id: 'b', number: 2, startState, continuityNote: notes[1] }),
    ],
  };
  return project;
}

/** 两镜、不同场景的最小项目。测地点跳跃时用它。 */
function twoScenes(notes: [string, string]): Project {
  const project = twoShots('他停在原地', '他还在原地', notes);
  project.scenes.push(makeScene('sc-b', '院子里', 'a yard'));
  project.shots[1]!.sceneId = 'sc-b';
  return project;
}

function conflicts(project: Project) {
  return checkContinuity(project).filter((i) => i.ruleId === 'continuity-state-conflict');
}

function locationJumps(project: Project) {
  return checkContinuity(project).filter((i) => i.ruleId === 'continuity-location-jump');
}

describe('衔接检查 · 该报的要报', () => {
  it('镜头没写衔接说明时会提示', () => {
    const project = structuredClone(sampleProject);
    for (const s of project.shots) s.continuityNote = '';
    const missing = checkContinuity(project).filter((i) => i.ruleId === 'continuity-missing-note');
    expect(missing.length).toBe(project.shots.length);
    // 提示级，不阻断
    expect(missing.every((i) => i.severity === 'info')).toBe(true);
  });

  it('地点跳了又没交代时会警告', () => {
    const jump = locationJumps(twoScenes(['他站在屋里', '他站在院子里']));
    expect(jump.length).toBe(1);
    expect(jump[0]!.severity).toBe('warning');
    // 要说清是从哪个场景跳到哪个场景
    expect(jump[0]!.title).toContain('屋里');
    expect(jump[0]!.title).toContain('院子里');
  });

  it('下一镜交代了地点切换就不报', () => {
    expect(locationJumps(twoScenes(['他停在门口', '直接切到院子，他已经站在那里'])).length).toBe(0);
  });

  it('**只有上一镜写了「走出去」不算交代**——那句话说的是上一个动作', () => {
    // 这正是判据必须落在下一镜上的原因
    expect(locationJumps(twoScenes(['他推门走出去', '他站在院子里'])).length).toBe(1);
  });

  it('写了「第二天」这类时间跳跃词就不报', () => {
    expect(locationJumps(twoScenes(['直接切到第二天早上', '天亮了'])).length).toBe(0);
  });

  it('同一场景内的切换不算地点跳跃', () => {
    expect(locationJumps(twoShots('他停在原地', '他还在原地'))).toEqual([]);
  });

  it('最后一镜没写收尾说明时会提示', () => {
    const project = structuredClone(sampleProject);
    const last = project.shots[project.shots.length - 1]!;
    last.continuityNote = '';
    const issues = checkContinuity(project).filter(
      (i) =>
        i.ruleId === 'continuity-missing-note' &&
        i.location.kind === 'shot' &&
        i.location.id === last.id,
    );
    expect(issues.length).toBe(1);
    expect(issues[0]!.title).toContain('最后一镜');
  });

  it('最后一镜写了收尾说明就不报', () => {
    const project = structuredClone(sampleProject);
    const last = project.shots[project.shots.length - 1]!;
    last.continuityNote = '画面停在摊开的笔记本上，缓缓淡出';
    const issues = checkContinuity(project).filter(
      (i) =>
        i.ruleId === 'continuity-missing-note' &&
        i.location.kind === 'shot' &&
        i.location.id === last.id,
    );
    expect(issues).toEqual([]);
  });
});

describe('衔接检查 · 状态矛盾', () => {
  it('背对 → 正对 会报', () => {
    const found = conflicts(twoShots('他背对镜头站着', '他正对镜头开口'));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.why).toContain('背对');
  });

  it('正对 → 背对 也会报', () => {
    expect(conflicts(twoShots('他正对着镜头', '他背对镜头走开')).length).toBeGreaterThan(0);
  });

  it('坐着 → 站着 会报', () => {
    expect(conflicts(twoShots('他坐在门槛上', '他站在院子里')).length).toBeGreaterThan(0);
  });

  it('站着 → 坐着 也会报', () => {
    expect(conflicts(twoShots('他站在门口', '他坐在桌边')).length).toBeGreaterThan(0);
  });

  it('手里拿着东西 → 两手空空 会报', () => {
    const found = conflicts(twoShots('他手里握着花枪', '他两手空空地站着'));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.why).toContain('手里');
  });

  it('**状态连贯时不报**——不误报是这份检查单可不可信的关键', () => {
    expect(conflicts(twoShots('他站在门口', '他仍在门口站着'))).toEqual([]);
  });

  it('说明里解释了「状态为什么会变」时不再报', () => {
    const project = twoShots('他背对镜头站着', '他正对镜头开口', [
      '他在这两句之间转过身来',
      '接着往下',
    ]);
    expect(conflicts(project)).toEqual([]);
  });

  it('说明是句废话（没解释变化）时**仍然要报**', () => {
    // 「接着往下」没有交代为什么会从背对变成正对，
    // 这正是一个真实的矛盾，不该因为「有写说明」就放过
    const project = twoShots('他背对镜头站着', '他正对镜头开口', ['接着往下', '接着往下']);
    expect(conflicts(project).length).toBeGreaterThan(0);
  });

  it('跨场景时不做状态推断（地点已经变了，状态本来就该变）', () => {
    const project = twoScenes(['他背对镜头站着', '他正对镜头开口']);
    expect(conflicts(project)).toEqual([]);
  });
});

describe('衔接检查 · 边界', () => {
  it('只有一镜时不报衔接问题', () => {
    const project = structuredClone(sampleProject);
    project.shots = [project.shots[0]!];
    // 单镜项目没有「下一镜」，所以不该有任何衔接问题
    expect(checkContinuity(project)).toEqual([]);
  });

  it('没有镜头时不报', () => {
    const project = structuredClone(sampleProject);
    project.shots = [];
    expect(checkContinuity(project)).toEqual([]);
  });

  it('每条问题都给了可操作的建议，不能只说「有问题」', () => {
    const project = structuredClone(sampleProject);
    for (const s of project.shots) s.continuityNote = '';
    const issues = checkContinuity(project);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.suggestion.length).toBeGreaterThan(10);
      expect(issue.why.length).toBeGreaterThan(20);
    }
  });
});

describe('衔接检查 · 接入总检查', () => {
  it('runChecks 里包含衔接问题', () => {
    const project = structuredClone(sampleProject);
    for (const s of project.shots) s.continuityNote = '';
    const report = runChecks(project);
    expect(report.issues.some((i) => i.ruleId.startsWith('continuity-'))).toBe(true);
    expect(report.counts.info).toBeGreaterThan(0);
  });

  it('衔接问题不阻断导出——它们是提示级与警告级，没有 error', () => {
    const project = structuredClone(sampleProject);
    for (const s of project.shots) s.continuityNote = '';
    const report = runChecks(project);
    const continuityIssues = report.issues.filter((i) => i.ruleId.startsWith('continuity-'));
    expect(continuityIssues.length).toBeGreaterThan(0);
    expect(continuityIssues.every((i) => i.severity !== 'error')).toBe(true);
  });
});

describe('衔接表导出', () => {
  it('生成一份可读的 markdown 表', () => {
    const md = continuitySheetMarkdown(sampleProject);
    expect(md).toContain('镜头衔接表');
    expect(md).toContain('| 镜号 |');
    for (const s of sampleProject.shots) {
      expect(md).toContain(`| ${s.number} |`);
    }
  });

  it('跨场景的切换会被标出来', () => {
    const md = continuitySheetMarkdown(twoScenes(['他走出去', '他走进院子']));
    expect(md).toContain('注意： 换到');
  });

  it('没写衔接说明时如实显示「未写」，不假装有内容', () => {
    const project = structuredClone(sampleProject);
    for (const s of project.shots) s.continuityNote = '';
    expect(continuitySheetMarkdown(project)).toContain('（未写）');
  });

  it('表里的竖线被替换，不会把表格撑破', () => {
    const project = structuredClone(sampleProject);
    project.shots[0]!.endState = '他停住了 | 然后转身';
    const md = continuitySheetMarkdown(project);
    const row = md.split('\n').find((l) => l.startsWith('| 1 |'))!;
    // 7 列 → 8 个竖线分隔符（含首尾）
    expect(row.split('|').length).toBe(9);
  });
});

describe('衔接信息要进视频提示词', () => {
  it('prose 形态（即梦/可灵）把衔接说明拼进正文', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots[0]!;
    shot.continuityNote = '他保持这个姿势，下一镜从同一机位推进';
    const line = buildShotPrompt(project, shot, 'jimeng');
    expect(line.en).toContain('他保持这个姿势');
    /*
      【v0.39】中文衔接用标签式 `ending:`，不再拼英文从句。

      原来无论中英都写 `ending so that ${note}`，于是中文项目里出现
      `ending so that 他保持这个姿势不动` —— 中英夹生，英文那半截
      对模型没有意义，还可能干扰它理解这是「收尾指令」。
    */
    expect(line.en).toContain('ending:');
    expect(line.en).not.toContain('ending so that');
    expect(line.zh).toContain('他保持这个姿势');
  });

  it('**英文**衔接说明仍然用自然从句（修中文不为牺牲英文质量）', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots[0]!;
    shot.continuityNote = 'he holds the pose while the camera pushes in';
    const line = buildShotPrompt(project, shot, 'jimeng');
    expect(line.en).toContain('ending so that he holds the pose');
  });

  it('labelled 形态（seedance）用 Transition 一行表示', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots[0]!;
    shot.continuityNote = '直接切到第二天早上';
    const line = buildShotPrompt(project, shot, 'seedance');
    expect(line.en).toContain('Transition:');
    expect(line.en).toContain('直接切到第二天早上');
  });

  it('没写衔接说明时不产生空的 Transition 行', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots[0]!;
    delete shot.continuityNote;
    const line = buildShotPrompt(project, shot, 'seedance');
    expect(line.en).not.toContain('Transition:');
    expect(line.en).not.toContain('ending so that');
    expect(line.en).not.toContain('ending:');
  });
});

describe('衔接工具函数', () => {
  it('hasNextShot 对最后一镜返回 false', () => {
    const last = sampleProject.shots[sampleProject.shots.length - 1]!;
    expect(hasNextShot(sampleProject, last.id)).toBe(false);
    expect(hasNextShot(sampleProject, sampleProject.shots[0]!.id)).toBe(true);
  });

  it('nextShot 给出下一镜', () => {
    expect(nextShot(sampleProject, sampleProject.shots[0]!.id)?.number).toBe(2);
    const last = sampleProject.shots[sampleProject.shots.length - 1]!;
    expect(nextShot(sampleProject, last.id)).toBeUndefined();
  });
});

