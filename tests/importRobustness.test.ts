import { describe, expect, it } from 'vitest';
import { normalizeProject, parseImportedProject } from '../src/services/storage';
import { runChecks } from '../src/domain/checks';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Project } from '../src/types/model';

/**
 * 导入/打开项目的最小健壮性（v0.54 · P1-2）
 *
 * ===========================================================================
 * 这组测试盯的是一条真实的静默失败
 * ===========================================================================
 * 之前 `parseImportedProject` 只检查「容器字段是不是数组」：
 * `characters: [null]` 这种文件 JSON 合法、容器也是数组，于是返回 ok:true。
 * 紧接着 `setProject` 在 `set()` 之前同步调用 `runChecks`，
 * 检查引擎在 `character.variants.map(...)` 处抛异常——而调用方
 * （导入按钮 / 打开项目按钮）没有 catch，用户看到的就是「点了没反应」。
 *
 * 现在要求三件事同时成立：
 *  1. 导入入口能明确拒绝「元素残缺」的文件，并指出第几个对象缺什么；
 *  2. 从本机旧数据加载时（不经过导入入口）能把元素修到「能跑」，不挑崩；
 *  3. 万一检查引擎还是抛异常，`setProject` 不能让项目打不开。
 */

function basePayload(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(sampleProject)) as Record<string, unknown>;
}

function parse(payload: Record<string, unknown>) {
  return parseImportedProject(JSON.stringify(payload));
}

describe('parseImportedProject · 元素级拒绝', () => {
  it('**characters 里有 null → 明确拒绝，并说是第几个**', () => {
    const payload = basePayload();
    payload.characters = [null];
    const result = parse(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('第 1 个角色');
    expect(result.error).toContain('不是一个对象');
  });

  it('**characters 里缺 id → 拒绝并指出缺 id**', () => {
    const payload = basePayload();
    payload.characters = [{ name: '林冲' }];
    const result = parse(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('第 1 个角色缺少 id');
  });

  it('场景缺 name 也要说清楚（检查页会拿它当显示名）', () => {
    const payload = basePayload();
    payload.scenes = [{ id: 'scene-1' }];
    const result = parse(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('第 1 个场景缺少 name');
  });

  it('shots 里的 null 与非对象元素被拒绝', () => {
    const payload = basePayload();
    payload.shots = [{ id: 's1' }, '不是对象'];
    const result = parse(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('第 2 个镜头不是一个对象');
  });

  it('story.scenes 里的 null 被拒绝', () => {
    const payload = basePayload();
    (payload.story as Record<string, unknown>).scenes = [null];
    const result = parse(payload);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('第 1 个场次不是一个对象');
  });

  it('正常的项目文件仍然能导入（不能把校验做成误杀）', () => {
    const result = parse(basePayload());
    expect(result.ok).toBe(true);
    expect(result.project?.characters.length).toBe(sampleProject.characters.length);
    expect(result.project?.shots.length).toBe(sampleProject.shots.length);
  });
});

describe('normalizeProject · 元素级修复（加载本机旧数据时不能挑崩）', () => {
  it('**characters 混入 null 时丢弃，其余角色修到能跑**', () => {
    const project = normalizeProject({
      id: 'p',
      name: 'x',
      brief: {},
      story: {},
      shots: [],
      characters: [null, { id: 'c1', name: '林冲' }],
      scenes: [],
    });
    expect(project.characters).toHaveLength(1);
    const character = project.characters[0]!;
    expect(character.identity.face).toBe('');
    expect(character.variants).toEqual([]);
    expect(character.continuityLocks).toEqual([]);
    expect(() => runChecks(project)).not.toThrow();
  });

  it('**shots 元素缺字段时补默认值**：id / 镜号 / 时长 / 景别 / 数组字段', () => {
    const project = normalizeProject({
      id: 'p',
      name: 'x',
      brief: {},
      story: {},
      characters: [],
      scenes: [],
      shots: [{}],
    });
    const shot = project.shots[0]!;
    expect(shot.id.length).toBeGreaterThan(0);
    expect(shot.number).toBe(1);
    expect(shot.duration).toBe(3);
    expect(shot.shotSize).toBe('medium');
    expect(shot.cameraMove).toBe('static');
    expect(shot.characterIds).toEqual([]);
    expect(shot.offscreenCharacters).toEqual([]);
    expect(() => runChecks(project)).not.toThrow();
  });

  it('story.scenes 非对象元素被丢弃，合法元素保留', () => {
    const project = normalizeProject({
      id: 'p',
      name: 'x',
      brief: {},
      story: { scenes: [null, { label: '开场' }] },
      shots: [],
      characters: [],
      scenes: [],
    });
    expect(project.story.scenes).toHaveLength(1);
    expect(project.story.scenes[0]!.label).toBe('开场');
  });

  it('旧数据的空字符串 / 数字缺省不崩', () => {
    const project = normalizeProject({
      id: 'p',
      name: 'x',
      brief: { targetDuration: 'not-a-number' },
      story: {},
      shots: [],
      characters: [],
      scenes: [],
    });
    expect(project.brief.targetDuration).toBe(30);
  });
});

describe('setProject · 检查引擎再抛也不能让项目打不开', () => {
  it('**元素坏到 runChecks 抛异常时，项目仍然被设置、报告留空**', () => {
    const broken = {
      ...structuredClone(sampleProject),
      characters: [null],
    } as unknown as Project;
    expect(() => useAppStore.getState().setProject(broken)).not.toThrow();
    expect(useAppStore.getState().project).not.toBeNull();
    expect(useAppStore.getState().report).toBeNull();
    useAppStore.setState({ project: null, report: null });
  });
});
