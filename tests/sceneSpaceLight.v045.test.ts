import { describe, expect, it } from 'vitest';
import {
  buildFramePrompt,
  buildScenePlatePrompt,
  lightSourceLine,
  spatialLayoutLine,
} from '../src/domain/image/prompts';
import { checkScenes } from '../src/domain/checks/scenes';
import { RULE_LABEL } from '../src/domain/checks/index';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Project } from '../src/types/model';

/**
 * v0.45：把「已经收集到的空间结构与主光方向」真的写进图片提示词。
 *
 * 这一组测试守的是一条核心约束：
 * **同一个场景的所有镜头，描述光与空间的那两句必须逐字相同。**
 * 它不靠运行时比对保证，而是靠「只从 scene 推导、不掺镜头级信息」的写法保证——
 * 所以测试要能抓住「有人往里面掺了镜头级判断」这件事。
 */

const project = sampleProject;

const shotIdsOf = (sceneId: string): string[] =>
  project.shots.filter((s) => s.sceneId === sceneId).map((s) => s.id);

describe('v0.45 · 场景板不再抹平光线', () => {
  it('固定指令里不再有 even lighting', () => {
    const prompt = buildScenePlatePrompt(project, 'sc-temple')!;
    expect(prompt.positive).not.toContain('even lighting');
  });

  it('空间板仍然强调「空无一人」与「宽景」', () => {
    const prompt = buildScenePlatePrompt(project, 'sc-temple')!;
    expect(prompt.positive).toContain('no people');
    expect(prompt.positive).toContain('wide establishing view');
  });
});

describe('v0.45 · 场景板带上空间结构与主光', () => {
  const scene = project.scenes.find((s) => s.id === 'sc-temple')!;

  it('空间结构原文进正文', () => {
    const prompt = buildScenePlatePrompt(project, 'sc-temple')!;
    expect(prompt.positive).toContain(spatialLayoutLine(scene.identity.spatialStructure));
    expect(prompt.positive).toContain(scene.identity.spatialStructure);
  });

  it('主光方向原文进正文', () => {
    const prompt = buildScenePlatePrompt(project, 'sc-temple')!;
    expect(prompt.positive).toContain(lightSourceLine(scene.lightDirection));
    expect(prompt.positive).toContain(scene.lightDirection);
  });

  it('两项都有对应的「为什么」说明', () => {
    const prompt = buildScenePlatePrompt(project, 'sc-temple')!;
    const labels = prompt.notes.map((n) => n.label);
    expect(labels).toContain('空间结构');
    expect(labels).toContain('主光方向');
  });

  it('说明里点明了「v0.45 之前从没进过提示词」', () => {
    const prompt = buildScenePlatePrompt(project, 'sc-temple')!;
    const spatialNote = prompt.notes.find((n) => n.label === '空间结构')!;
    expect(spatialNote.reason).toContain('一次都没进过提示词');
  });
});

describe('v0.45 · 镜头三帧同样带上这两项', () => {
  const scene = project.scenes.find((s) => s.id === 'sc-field')!;

  it('首帧正文里有空间结构与主光', () => {
    const prompt = buildFramePrompt(project, 'shot-01', 'first-frame')!;
    expect(prompt.positive).toContain(scene.identity.spatialStructure);
    expect(prompt.positive).toContain(scene.lightDirection);
  });

  it('尾帧与动作关键帧也有', () => {
    for (const kind of ['action-peak', 'end-frame'] as const) {
      const prompt = buildFramePrompt(project, 'shot-02', kind)!;
      expect(prompt.positive).toContain(scene.lightDirection);
    }
  });

  it('帧提示词里同样有说明条目', () => {
    const prompt = buildFramePrompt(project, 'shot-01', 'first-frame')!;
    const labels = prompt.notes.map((n) => n.label);
    expect(labels).toContain('空间结构');
    expect(labels.some((l) => l.startsWith('主光方向'))).toBe(true);
  });
});

describe('v0.45 · 同一场景所有镜头的光线句逐字相同', () => {
  it('同一场景内三帧三镜，光线句只有一个版本', () => {
    for (const sceneId of ['sc-field', 'sc-temple']) {
      const scene = project.scenes.find((s) => s.id === sceneId)!;
      const expected = lightSourceLine(scene.lightDirection);
      const seen = new Set<string>();

      for (const shotId of shotIdsOf(sceneId)) {
        for (const kind of ['first-frame', 'action-peak', 'end-frame'] as const) {
          const prompt = buildFramePrompt(project, shotId, kind)!;
          const found = prompt.positive.split(', ').filter((p) => p.startsWith('key light:'));
          // 一个镜头里这句话只能出现一次
          expect(found).toHaveLength(1);
          seen.add(found[0]!);
        }
      }

      expect([...seen]).toEqual([expected]);
    }
  });

  it('不同场景的光线句不同（否则等于全片一个光）', () => {
    const a = buildFramePrompt(project, 'shot-01', 'first-frame')!.positive;
    const b = buildFramePrompt(project, 'shot-07', 'first-frame')!.positive;
    const grab = (p: string): string => p.split(', ').find((x) => x.startsWith('key light:'))!;
    expect(grab(a)).not.toBe(grab(b));
  });

  it('空间结构句同理：同场景只有一个版本', () => {
    const seen = new Set<string>();
    for (const shotId of shotIdsOf('sc-field')) {
      const prompt = buildFramePrompt(project, shotId, 'first-frame')!;
      const found = prompt.positive.split(', ').filter((p) => p.startsWith('room layout:'));
      expect(found).toHaveLength(1);
      seen.add(found[0]!);
    }
    expect(seen.size).toBe(1);
  });
});

describe('v0.45 · 字段为空时不产生悬空片段', () => {
  const bare: Project = {
    ...project,
    scenes: project.scenes.map((s) =>
      s.id === 'sc-temple'
        ? { ...s, identity: { ...s.identity, spatialStructure: '' }, lightDirection: '' }
        : s,
    ),
  };

  it('空间结构为空 → 没有 room layout 前缀', () => {
    const prompt = buildScenePlatePrompt(bare, 'sc-temple')!;
    expect(prompt.positive).not.toContain('room layout:');
  });

  it('主光为空 → 没有 key light 前缀，也不会留下空冒号', () => {
    const prompt = buildScenePlatePrompt(bare, 'sc-temple')!;
    expect(prompt.positive).not.toContain('key light:');
    expect(prompt.positive).not.toContain(': ,');
    expect(prompt.positive).not.toMatch(/,\s*,/);
  });

  it('对应说明条目也一起消失', () => {
    const prompt = buildScenePlatePrompt(bare, 'sc-temple')!;
    const labels = prompt.notes.map((n) => n.label);
    expect(labels).not.toContain('空间结构');
    expect(labels).not.toContain('主光方向');
  });

  it('老项目字段缺失（undefined）不报错', () => {
    const legacy: Project = {
      ...project,
      scenes: project.scenes.map((s) => {
        const { spatialStructure: _drop, ...restIdentity } = s.identity;
        void _drop;
        return { ...s, identity: restIdentity as typeof s.identity };
      }),
    };
    const prompt = buildScenePlatePrompt(legacy, 'sc-temple')!;
    expect(prompt.positive).not.toContain('room layout:');
    expect(prompt.positive).toContain('no people');
  });
});

describe('v0.45 · 场景板的正向词去重', () => {
  it('结尾的 no text, no watermark 只出现一次', () => {
    const prompt = buildScenePlatePrompt(project, 'sc-temple')!;
    // 这句本身含逗号，按 ', ' 切会被拆成两条，所以直接数字面出现次数
    const occurrences = prompt.positive.split('no watermark').length - 1;
    expect(occurrences).toBe(1);
  });

  it('已被 summaryEn 字面覆盖的固定元素不再重复列', () => {
    const prompt = buildScenePlatePrompt(project, 'sc-temple')!;
    const scene = project.scenes.find((s) => s.id === 'sc-temple')!;
    const summary = scene.identity.summaryEn.toLowerCase();
    const covered = scene.fixedElements.filter((el) => summary.includes(el.toLowerCase()));
    for (const el of covered) {
      const hits = prompt.positive.split(', ').filter((p) => p === el);
      expect(hits).toHaveLength(0);
    }
  });
});

describe('v0.45 · 接触句不再和「无明显投影」打架', () => {
  it('没有「影子落在这个平面上」这种说法', () => {
    const prompt = buildFramePrompt(project, 'shot-01', 'first-frame')!;
    expect(prompt.positive).not.toContain('shadow falling on that plane');
    expect(prompt.positive).toContain('with both feet touching it');
  });

  it('光很散的场景（sc-field 写的是「无明显投影」）里也成立', () => {
    const scene = project.scenes.find((s) => s.id === 'sc-field')!;
    expect(scene.lightDirection).toContain('无明显投影');
    const prompt = buildFramePrompt(project, 'shot-01', 'first-frame')!;
    expect(prompt.positive).toContain('both feet touching');
  });
});

describe('v0.45 · 新增检查规则：场景没写空间结构', () => {
  it('规则名登记在 RULE_LABEL 里', () => {
    expect(RULE_LABEL['scene-missing-space']).toBe('场景空间结构缺失');
  });

  it('空间结构为空时报警，并指向 identity.spatialStructure', () => {
    const bare: Project = {
      ...project,
      scenes: project.scenes.map((s) =>
        s.id === 'sc-temple' ? { ...s, identity: { ...s.identity, spatialStructure: '' } } : s,
      ),
    };
    const issues = checkScenes(bare).filter((i) => i.ruleId === 'scene-missing-space');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.location).toMatchObject({
      kind: 'scene',
      id: 'sc-temple',
      field: 'identity.spatialStructure',
    });
  });

  it('填了就不报', () => {
    const issues = checkScenes(project).filter((i) => i.ruleId === 'scene-missing-space');
    expect(issues).toHaveLength(0);
  });

  it('建议里明确告诉用户写房间坐标、不要写画面左右', () => {
    const bare: Project = {
      ...project,
      scenes: project.scenes.map((s) =>
        s.id === 'sc-temple' ? { ...s, identity: { ...s.identity, spatialStructure: '' } } : s,
      ),
    };
    const issue = checkScenes(bare).find((i) => i.ruleId === 'scene-missing-space')!;
    expect(issue.suggestion).toContain('别写「左边有门」');
  });
});

describe('v0.45 · 两个格式化函数本身的边界', () => {
  it('空白字符串返回空串，不返回半句', () => {
    expect(lightSourceLine('')).toBe('');
    expect(lightSourceLine('   ')).toBe('');
    expect(spatialLayoutLine('')).toBe('');
    expect(spatialLayoutLine('\n\t ')).toBe('');
  });

  it('去掉首尾空白，但不动中间内容', () => {
    expect(lightSourceLine('  傍晚，暖光从右侧窗户斜射  ')).toBe(
      'key light: 傍晚，暖光从右侧窗户斜射',
    );
  });

  it('前缀是固定英文，方便模型认出这是光/空间而不是风格词', () => {
    expect(lightSourceLine('x')).toMatch(/^key light: /);
    expect(spatialLayoutLine('x')).toMatch(/^room layout: /);
  });
});
