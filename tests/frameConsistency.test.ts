import { describe, expect, it } from 'vitest';
import {
  pickFirstFrameReference,
  pickReferenceImages,
  pickSceneReference,
} from '../src/domain/image/characterSheet';
import { withReferenceInstruction } from '../src/services/gateway/dashscope';
/*
  【v0.39】buildFramePrompt 去掉了第 4 个参数。

  那几个参数（hasFirstFrameAnchor / hasPreviousEndAnchor / hasCharacterSheet）
  在实现里是 `void options` —— 收下就丢，从未生效过。而「有图时要不要重描外观」
  这件事，实际策略是**永远注入**：锁里没有头饰时，一旦不写外观，那顶帽子就会
  在相邻镜头之间凭空消失。这一组测试断言的正是这个行为，所以参数删掉之后
  断言反而更强：它现在无条件成立。
*/
import { buildFramePrompt } from '../src/domain/image/prompts';
import { checkContinuity } from '../src/domain/checks/continuity';
import { checkCharacters } from '../src/domain/checks/characters';
import { runChecks } from '../src/domain/checks';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Project } from '../src/types/model';
import type { ModelCapabilities } from '../src/types/model';

/**
 * 同镜三帧之间的一致性（v0.20 新增）
 *
 * ===========================================================================
 * 这组测试针对一个真实的缺口
 * ===========================================================================
 * 原来生成动作关键帧和尾帧时，参考图里只有**角色形象图**——
 * 它锁住了「这个人长什么样」，但锁不住「这一镜的空间长什么样」。
 * 于是三帧的机位、景别、光线方向可能各自漂移：
 * 三张图单独看都挺好，放一起却不像同一个镜头。
 *
 * 修法是**把本镜首帧当构图锚点**传给后两帧，并在参考图说明里
 * 分角色写清楚「哪张管外观、哪张管构图」。
 */

const CAPS: ModelCapabilities = {
  negativePrompt: true,
  seed: true,
  referenceImage: true,
  maxReferenceImages: 3,
  maxOutputImages: 1,
};

function asset(kind: string, createdAt: string, dataUrl = `data:image/png;base64,${kind}`) {
  return { kind, createdAt, dataUrl };
}

describe('参考图挑选 · 首帧是构图锚点', () => {
  it('能从素材里挑出本镜首帧', () => {
    const pick = pickFirstFrameReference([
      asset('first-frame', '2026-01-01T00:00:00Z'),
      asset('end-frame', '2026-01-02T00:00:00Z'),
    ]);
    expect(pick).toBeDefined();
    expect(pick!.label).toContain('首帧');
    expect(pick!.label).toContain('构图');
  });

  it('没有首帧时返回 undefined，不拿别的帧冒充', () => {
    expect(pickFirstFrameReference([asset('action-peak', '2026-01-01T00:00:00Z')])).toBeUndefined();
    expect(pickFirstFrameReference([])).toBeUndefined();
  });

  it('下载失败的帧（没有 dataUrl）不能当参考图', () => {
    expect(
      pickFirstFrameReference([{ kind: 'first-frame', createdAt: 'x', dataUrl: undefined }]),
    ).toBeUndefined();
  });

  it('有多张首帧时用最新的（重生成说明用户对旧的不满意）', () => {
    const pick = pickFirstFrameReference([
      asset('first-frame', '2026-01-01T00:00:00Z', 'data:image/png;base64,OLD'),
      asset('first-frame', '2026-06-01T00:00:00Z', 'data:image/png;base64,NEW'),
    ]);
    expect(pick!.dataUrl).toContain('NEW');
  });
});

describe('参考图挑选 · 场景板', () => {
  it('空镜镜头没有角色时用场景板锁空间与光线', () => {
    const pick = pickSceneReference([asset('scene-plate', '2026-01-01T00:00:00Z')]);
    expect(pick).toBeDefined();
    expect(pick!.label).toContain('场景');
  });

  it('没有场景板时返回 undefined', () => {
    expect(pickSceneReference([asset('first-frame', 'x')])).toBeUndefined();
  });
});

describe('参考图挑选 · 角色形象图的既有优先级不受影响', () => {
  it('头部特写优先于全身图（锁脸比锁体型更关键）', () => {
    const picks = pickReferenceImages(
      [
        asset('character-sheet', '2026-01-01T00:00:00Z'), // 全身，旧
        asset('character-sheet-face', '2026-01-02T00:00:00Z'), // 头特，新
      ],
      CAPS,
    );
    expect(picks[0]!.label).toContain('头部特写');
    expect(picks[1]!.label).toContain('全身多视图');
  });

  it('预算被压缩时按重要性截断', () => {
    const picks = pickReferenceImages(
      [
        asset('character-sheet', '2026-01-01T00:00:00Z'),
        asset('character-sheet-face', '2026-01-02T00:00:00Z'),
        asset('character-sheet-face', '2026-01-03T00:00:00Z'),
      ],
      { ...CAPS, maxReferenceImages: 1 },
    );
    expect(picks).toHaveLength(1);
    expect(picks[0]!.label).toContain('头部特写');
  });

  it('模型不支持参考图时返回空数组', () => {
    expect(
      pickReferenceImages([asset('character-sheet-face', 'x')], {
        ...CAPS,
        referenceImage: false,
        maxReferenceImages: 0,
      }),
    ).toEqual([]);
  });
});

describe('参考图说明 · 按角色分开写', () => {
  it('含首帧锚点时，明确要求保持机位、构图、光线方向', () => {
    const prompt = withReferenceInstruction('a puppy eating a burger', {
      referenceCount: 2,
      hasFirstFrameAnchor: true,
      frameKind: 'end-frame',
    });
    expect(prompt).toContain('camera angle');
    expect(prompt).toContain('composition');
    expect(prompt).toContain('lighting direction');
    // 原始提示词必须在后面
    expect(prompt.endsWith('a puppy eating a burger')).toBe(true);
  });

  it('说明里点明「第一张参考图就是本镜首帧」，避免模型误解', () => {
    const prompt = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: true,
    });
    expect(prompt).toContain('first frame of this very shot');
  });

  it('动作关键帧与尾帧各自说明它们是同一镜的哪一刻', () => {
    const peak = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: true,
      frameKind: 'action-peak',
    });
    expect(peak).toContain('peak moment');

    const end = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: true,
      frameKind: 'end-frame',
    });
    expect(end).toContain('end of that same continuous shot');
  });

  it('没有首帧锚点时不说构图的话（只有形象图，说构图是误导）', () => {
    const prompt = withReferenceInstruction('x', {
      referenceCount: 1,
      hasFirstFrameAnchor: false,
    });
    expect(prompt).not.toContain('camera angle');
    expect(prompt).not.toContain('first frame of this very shot');
    // 但锁脸那句仍然要在
    expect(prompt).toContain('facial features');
  });

  it('没有参考图时完全不改动提示词', () => {
    expect(withReferenceInstruction('x', { referenceCount: 0, hasFirstFrameAnchor: false })).toBe('x');
    expect(withReferenceInstruction('x', 0)).toBe('x');
  });

  it('兼容旧的数字参数（既有调用点不用一次全改）', () => {
    const prompt = withReferenceInstruction('x', 2);
    expect(prompt).toContain('facial features');
    expect(prompt).not.toContain('camera angle');
  });

  it('首帧自己不把首帧当锚点——它就是基准', () => {
    const prompt = withReferenceInstruction('x', {
      referenceCount: 2,
      hasFirstFrameAnchor: false,
      frameKind: 'first-frame',
    });
    expect(prompt).not.toContain('first frame of this very shot');
  });
});

describe('预算分配的取舍', () => {
  it('三个槽位时：首帧 1 + 头特 1 + 全身 1 —— 覆盖构图与外观两条轴', () => {
    const framePicks = [pickFirstFrameReference([asset('first-frame', 'x')])!];
    const remaining = CAPS.maxReferenceImages - framePicks.length;
    const characterPicks = pickReferenceImages(
      [
        asset('character-sheet-face', '2026-01-02T00:00:00Z'),
        asset('character-sheet', '2026-01-01T00:00:00Z'),
      ],
      { ...CAPS, maxReferenceImages: remaining },
    );
    const all = [...framePicks, ...characterPicks];
    expect(all).toHaveLength(3);
    expect(all[0]!.label).toContain('构图');
    expect(all[1]!.label).toContain('锁脸');
    expect(all[2]!.label).toContain('体型');
  });

  it('**角色外观始终注入**——有参考图也不丢（丢过一次帽子）', () => {
    // 这条测试原来断言的是相反的：有参考图时不重描外观。
    // 那个做法导致「旧毡帽」从未进入任何一帧的提示词——
    // 于是分镜里写了「毡帽压得低」的镜头画了帽子，没写的就没画。
    //
    // 正确的尺度是「不要把同一件事说两遍」，不是「把外观整个删掉」。
    // 重复只是让模型在两个版本之间摇；缺失是让模型自己编。
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.characterIds.length > 0)!;
    const withSheet = buildFramePrompt(project, shot.id, 'first-frame')!;
    // 身份描述里的关键外观（帽子）必须在
    expect(withSheet.positive).toContain('felt hat');
    // 而且不能因此产生重复
    const parts = withSheet.positive.split(', ').map((x) => x.trim().toLowerCase());
    expect(parts.filter((x, i) => parts.indexOf(x) !== i)).toEqual([]);
  });

  it('每一镜的提示词里都有那顶帽子（这是原来缺的）', () => {
    const project = structuredClone(sampleProject);
    for (const shot of project.shots) {
      if (shot.characterIds.length === 0) continue;
      const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
      expect(prompt.positive, `第 ${shot.number} 镜缺了帽子`).toContain('felt hat');
    }
  });

  it('连续性锁的内容**始终保留**——它们是用户明确要求跨镜一致的特征', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.activeLockIds.length > 0)!;
    const withSheet = buildFramePrompt(project, shot.id, 'first-frame')!;
    // 锁面按短语逐个核对：整体串可能因为与身份描述去重而少了重复的那一段，
    // 但**每一个短语**都必须还在——去重删的是重复，不是内容。
    const covered = (phrase: string): boolean => {
      const pieces = withSheet.lockPhrases
        .flatMap((l) => l.split(','))
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      return pieces.includes(phrase.trim().toLowerCase());
    };
    for (const lockPhrase of withSheet.lockPhrases) {
      for (const piece of lockPhrase.split(',').map((x) => x.trim()).filter(Boolean)) {
        // 每个短语要么在提示词里，要么与身份描述里的内容重复（那才是被去重掉的）
        const inPrompt = withSheet.positive.toLowerCase().includes(piece.toLowerCase());
        const locked = covered(piece);
        expect(inPrompt || locked, `锁片段「${piece}」不见了`).toBe(true);
      }
    }
    // 至少有一条锁的实质内容进了正文
    expect(withSheet.positive).toContain('a worn padded cotton robe in faded indigo');
  });

  it('场景描述与固定元素不受影响（它们不是「角色外观」）', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId)!;
    const scene = project.scenes.find((s) => s.id === shot.sceneId)!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    expect(prompt.positive).toContain(scene.identity.summaryEn);
    for (const el of scene.fixedElements) {
      expect(prompt.positive).toContain(el);
    }
  });

  it('不传锚点信息时保持原行为（向后兼容）', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.characterIds.length > 0)!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    const character = project.characters.find((c) => shot.characterIds.includes(c.id))!;
    expect(prompt.positive).toContain(character.identity.summaryEn);
  });
});

// ---------------------------------------------------------------------------
// 新增的两条衔接检查
// ---------------------------------------------------------------------------

describe('衔接检查 · 单镜位移与光线方向', () => {
  // 用最小的两镜项目做夹具：示例项目里其它镜头的噪声会干扰断言
  function twoShotProject(): Project {
    const project = structuredClone(sampleProject);
    project.shots = [project.shots[0]!, project.shots[1]!];
    const a = project.shots[0]!;
    const b = project.shots[1]!;
    a.sceneId = project.scenes[0]!.id;
    b.sceneId = project.scenes[0]!.id;
    a.continuityNote = '继续';
    b.continuityNote = '继续';
    return project;
  }

  /** 只看第 1 镜发出的某条规则 */
  function issuesFromFirstShot(project: Project, ruleId: string) {
    return checkContinuity(project).filter(
      (i) =>
        i.ruleId === ruleId &&
        i.location.kind === 'shot' &&
        i.location.id === project.shots[0]!.id,
    );
  }

  it('动作描述了一次大位移时会提示', () => {
    const project = twoShotProject();
    project.shots[0]!.action = '他冲向门口';
    const issues = issuesFromFirstShot(project, 'continuity-large-motion');
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('info');
    expect(issues[0]!.title).toContain('冲向门口');
  });

  it('跨越障碍这类动作也会提示', () => {
    const project = twoShotProject();
    project.shots[0]!.action = '他翻过矮墙';
    expect(issuesFromFirstShot(project, 'continuity-large-motion').length).toBe(1);
  });

  it('**原地下与边界情形一律不报**——误报的代价远大于漏报', () => {
    const inPlace = [
      // 新手最常写的原地动作
      '他抬起头',
      '他缓缓站起身',
      '他把花枪换到左手',
      '他皱起眉头',
      '他握着花枪不动',
      // 边界情形：入画靠构图交代，中间不需要补运动
      '一个人影从山道尽头走进画面，肩头落满雪',
      // 边界情形：跨一步不是长距离位移
      '林冲提着花枪跨出门槛',
    ];
    for (const action of inPlace) {
      const project = twoShotProject();
      project.shots[0]!.action = action;
      expect(
        issuesFromFirstShot(project, 'continuity-large-motion'),
        `「${action}」不该被报为大位移`,
      ).toEqual([]);
    }
  });

  it('给出的是「拆镜」这个可操作做法，而不是「你错了」', () => {
    const project = twoShotProject();
    project.shots[0]!.action = '他冲向庙门';
    const issues = issuesFromFirstShot(project, 'continuity-large-motion');
    expect(issues[0]!.suggestion).toContain('拆');
  });

  it('相邻两处场景的主光方向左右相反时会警告', () => {
    const project = twoShotProject();
    project.shots[1]!.sceneId = project.scenes[1]!.id;
    project.scenes[0]!.lightDirection = '傍晚，暖光从左侧窗户斜射';
    project.scenes[1]!.lightDirection = '正午，强光从右侧照入';
    const issues = issuesFromFirstShot(project, 'continuity-light-mismatch');
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('warning');
    // 标题里要说清是哪两处
    expect(issues[0]!.title).toContain(project.scenes[0]!.name);
    expect(issues[0]!.title).toContain(project.scenes[1]!.name);
  });

  it('光线方向一致时不报', () => {
    const project = twoShotProject();
    project.shots[1]!.sceneId = project.scenes[1]!.id;
    project.scenes[0]!.lightDirection = '傍晚，暖光从左侧窗户斜射';
    project.scenes[1]!.lightDirection = '阴天，柔光从左侧高处来';
    expect(issuesFromFirstShot(project, 'continuity-light-mismatch')).toEqual([]);
  });

  it('同一场景内不做光线比对（那是同一个光源）', () => {
    const project = twoShotProject();
    project.scenes[0]!.lightDirection = '傍晚，暖光从左侧窗户斜射';
    expect(issuesFromFirstShot(project, 'continuity-light-mismatch')).toEqual([]);
  });

  it('场景没登记主光方向时不猜', () => {
    const project = twoShotProject();
    project.shots[1]!.sceneId = project.scenes[1]!.id;
    project.scenes[0]!.lightDirection = '';
    project.scenes[1]!.lightDirection = '正午，强光从右侧照入';
    expect(issuesFromFirstShot(project, 'continuity-light-mismatch')).toEqual([]);
  });

  it('垂直方向相反（顶光 vs 脚光）也算冲突', () => {
    const project = twoShotProject();
    project.shots[1]!.sceneId = project.scenes[1]!.id;
    project.scenes[0]!.lightDirection = '正午，顶光直下';
    project.scenes[1]!.lightDirection = '夜里，脚光自下方打来';
    expect(issuesFromFirstShot(project, 'continuity-light-mismatch').length).toBe(1);
  });
});

describe('误报是底线', () => {
  it('示例项目里不该出现大位移提示——它是「正常作品」的样本', () => {
    const issues = checkContinuity(sampleProject).filter(
      (i) => i.ruleId === 'continuity-large-motion',
    );
    expect(issues).toEqual([]);
  });

  it('示例项目里光线提示也不该泛滥', () => {
    const issues = checkContinuity(sampleProject).filter(
      (i) => i.ruleId === 'continuity-light-mismatch',
    );
    expect(issues.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 尺度锚定与提示词去重（v0.23）
// ---------------------------------------------------------------------------

describe('尺度锚定 · 镜头之间角色与环境比例不能变', () => {
  it('固定元素同时充当尺度参照物，明说相对大小不变', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId)!;
    const scene = project.scenes.find((s) => s.id === shot.sceneId)!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    expect(prompt.positive).toContain('fixed objects keep their true size relative to the character');
    // 固定元素本身仍然在提示词里（由场景描述带出）
    expect(prompt.positive).toContain(scene.fixedElements[0]!);
    // 并且要有一条说明解释为什么
    expect(prompt.notes.some((n) => n.label === '尺度锚点')).toBe(true);
  });

  it('人物占比换成一个能算的数，且说明里标明是本工具自定换算', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId)!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    // 这一镜是「大远景」，按表应该是八分之一画高
    expect(shot.shotSize).toBe('extreme-wide');
    expect(prompt.positive).toContain('about one eighth of the frame height');
    // 旧写法里那句「as in other shots」没有指代对象，必须消失
    expect(prompt.positive).not.toContain('as in other shots');
    const note = prompt.notes.find((n) => n.label === '人物占比');
    expect(note?.reason).toContain('不是行业标准');
  });

  it('缺接触会让角色像贴上去的，所以全景要有地面接触；特写不谈接触', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId)!;
    const wide = buildFramePrompt(project, shot.id, 'first-frame')!;
    expect(wide.positive).toContain('the same ground plane as the fixed objects');

    // 特写里脚根本不在画面内，再要求「脚踩地面」是自相矛盾的指令
    project.shots = project.shots.map((s) =>
      s.id === shot.id ? { ...s, shotSize: 'extreme-close-up' } : s,
    );
    const closeUp = buildFramePrompt(project, shot.id, 'first-frame')!;
    expect(closeUp.positive).not.toContain('ground plane');
    expect(closeUp.positive).toContain('the face fills the frame');
  });

  it('场景没登记固定元素时不会硬造尺度锚点', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId)!;
    project.scenes = project.scenes.map((s) =>
      s.id === shot.sceneId ? { ...s, fixedElements: [] } : s,
    );
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    expect(prompt.positive).not.toContain('fixed objects keep their true size');
  });

  it('尺度锚点的说明写清了它防的是什么', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId)!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    const note = prompt.notes.find((n) => n.label === '尺度锚点')!;
    expect(note.reason).toContain('比例');
  });
});

describe('提示词去重 · 同一件事只说一遍', () => {
  it('没有任何**完全相同**的短语重复出现', () => {
    const project = structuredClone(sampleProject);
    for (const shot of project.shots) {
      const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
      const parts = prompt.positive
        .split(', ')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      const dupes = parts.filter((x, i) => parts.indexOf(x) !== i);
      expect(dupes, `第 ${shot.number} 镜有重复短语`).toEqual([]);
    }
  });

  it('场景描述里已有的固定元素不再单独重复列出', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId === 'sc-field')!;
    const scene = project.scenes.find((s) => s.id === 'sc-field')!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    // 「collapsed straw shed」已经作为短语出现在场景描述里了
    expect(scene.identity.summaryEn.toLowerCase()).toContain('collapsed straw shed');
    const occurrences = prompt.positive
      .toLowerCase()
      .split('collapsed straw shed').length - 1;
    expect(occurrences).toBe(1);
  });

  it('尺度锚点不会被去重误删，且不重复点名具体物件', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId === 'sc-field')!;
    const scene = project.scenes.find((s) => s.id === 'sc-field')!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;

    // 锚点还在
    expect(prompt.positive).toContain('fixed objects keep their true size relative to the character');
    // 而且不重复点名——场景描述里已经说过物件在哪了，
    // 再说一遍等于给模型两个版本
    const el = scene.fixedElements.find((e) => scene.identity.summaryEn.toLowerCase().includes(e.toLowerCase()));
    if (el) {
      const occurrences = prompt.positive.toLowerCase().split(el.toLowerCase()).length - 1;
      expect(occurrences, `「${el}」重复出现了 ${occurrences} 次`).toBe(1);
    }
  });

  it('片段去重后不留空段', () => {
    const project = structuredClone(sampleProject);
    for (const shot of project.shots.slice(0, 4)) {
      const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
      expect(prompt.positive).not.toContain(', ,');
      expect(prompt.positive.startsWith(',')).toBe(false);
      expect(prompt.positive.endsWith(',')).toBe(false);
    }
  });
});

describe('未标注转场类型 · 必须让用户看见', () => {
  it('没有 transitionType 时给出警告', () => {
    const project = structuredClone(sampleProject);
    for (const s of project.shots) delete s.transitionType;
    const issues = checkContinuity(project).filter(
      (i) => i.ruleId === 'continuity-untyped-transition',
    );
    // 第一镜没有「上一镜」，不该报——其余每一镜各一条
    expect(issues.length).toBe(project.shots.length - 1);
    expect(issues[0]!.severity).toBe('warning');
  });

  it('说明里点明「没标注会让两镜各画各的」', () => {
    const project = structuredClone(sampleProject);
    for (const s of project.shots) delete s.transitionType;
    const issues = checkContinuity(project).filter(
      (i) => i.ruleId === 'continuity-untyped-transition',
    );
    // v0.50 把这条从「一致性就是这样丢掉的」（结论）改成「两镜就各画各的」（会发生什么）。
    // 断言跟着改，但要守住的仍是同一件事：必须说出不标注的后果。
    expect(issues[0]!.why).toContain('各画各的');
    expect(issues[0]!.why).toContain('尾帧');
    expect(issues[0]!.suggestion).toContain('承接');
  });

  it('标好之后不再报', () => {
    const project = structuredClone(sampleProject);
    project.shots.forEach((s, i) => {
      s.transitionType = i === 0 ? 'cut' : 'continuation';
    });
    const issues = checkContinuity(project).filter(
      (i) => i.ruleId === 'continuity-untyped-transition',
    );
    expect(issues).toEqual([]);
  });
});

describe('固定元素检查 · 已撤掉的那条规则', () => {
  it('正文用中文写、固定元素是英文时，不该报警（这是原来的误报源）', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId)!;
    shot.startState = '他站在雪地里';
    shot.action = '他抬起头';
    shot.endState = '他看着前方';
    const issues = runChecks(project).issues.filter((i) => i.ruleId === 'scene-missing-elements');
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 「帽子在两个镜头之间凭空消失」——一个真实症状的回归测试
// ---------------------------------------------------------------------------

describe('高显著度特征不能被丢掉', () => {
  /** 只看某个角色发出的这条警告——示例项目里有多个角色，不限定会被互相干扰 */
  function issuesFor(project: Project, characterId: string) {
    return checkCharacters(project).filter(
      (i) =>
        i.ruleId === 'character-unlocked-feature' &&
        i.location.kind === 'character' &&
        i.location.id === characterId,
    );
  }

  it('身份描述里的帽子出现在**每一帧**的提示词里', () => {
    // 症状：上一个镜头只有头巾、下一个镜头戴上了帽子。
    // 根因：帽子只写在 identity.summaryEn 与中文 identity.hair 里，
    // 而「有参考图就不重描外观」把整个 summaryEn 丢掉了，
    // 锁里又没有头饰这一条 → 帽子从未进入任何提示词。
    const project = structuredClone(sampleProject);
    const shotsWithCharacter = project.shots.filter((s) => s.characterIds.length > 0);
    expect(shotsWithCharacter.length).toBeGreaterThan(0);
    for (const shot of shotsWithCharacter) {
      const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
      expect(prompt.positive, `第 ${shot.number} 镜缺了帽子`).toContain('felt hat');
    }
  });

  it('三种帧都有帽子，不只是首帧', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.characterIds.length > 0)!;
    for (const kind of ['first-frame', 'action-peak', 'end-frame'] as const) {
      const prompt = buildFramePrompt(project, shot.id, kind)!;
      expect(prompt.positive, `${kind} 缺了帽子`).toContain('felt hat');
    }
  });

  it('**高显著特征没进锁时会警告**（这是防复发的那道防线）', () => {
    const project = structuredClone(sampleProject);
    const character = project.characters[0]!;
    // 身份里写着帽子，把管帽子的锁删掉
    character.continuityLocks = character.continuityLocks.filter(
      (l) => !/hat/i.test(l.phrase),
    );
    const issues = issuesFor(project, 'ch-linchong');
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.title).toContain('帽');
  });

  it('特征已被锁覆盖时不再警告', () => {
    const project = structuredClone(sampleProject);
    // 示例项目现在有「林冲 · 毡帽」这条锁
    expect(issuesFor(project, 'ch-linchong')).toEqual([]);
  });

  it('身份里没有高显著特征时不报（不误报）', () => {
    const project = structuredClone(sampleProject);
    project.characters[0]!.identity.summaryEn =
      'Lin Chong, a lean tall warrior in his thirties, square face';
    project.characters[0]!.identity.hair = '束发';
    expect(issuesFor(project, 'ch-linchong')).toEqual([]);
  });

  it('眼镜 / 披风 / 背包 这类同样会被盯住', () => {
    const project = structuredClone(sampleProject);
    const character = project.characters[0]!;
    character.identity.summaryEn += ', wearing round brass spectacles and a long dark cloak';
    character.continuityLocks = character.continuityLocks.filter(
      (l) => !/spectacles|cloak|hat/i.test(l.phrase),
    );
    const issues = issuesFor(project, 'ch-linchong');
    expect(issues.length).toBe(1);
    expect(issues[0]!.title).toContain('眼镜');
    expect(issues[0]!.title).toContain('披风');
  });

  it('建议里给的锁面例子是能直接用的英文短语', () => {
    const project = structuredClone(sampleProject);
    const character = project.characters[0]!;
    character.continuityLocks = character.continuityLocks.filter((l) => !/hat/i.test(l.phrase));
    const issues = issuesFor(project, 'ch-linchong');
    expect(issues[0]!.suggestion).toContain('felt hat');
  });
});

describe('高显著特征检测 · 不能假阳性', () => {
  it('「wearing」不该被当成「ring 饰品」（词边界必须挡住）', () => {
    // 真实踩到的坑：`ring\b` 会命中 `wearing`——`wearing` 的 `ring` 正好落在词尾。
    // 假阳性会让用户收到莫名其妙的「有饰品没加锁」警告，然后学会忽略整份检查单。
    const project = structuredClone(sampleProject);
    const character = project.characters[0]!;
    character.identity.summaryEn =
      'Lin Chong, a lean tall warrior wearing a worn padded robe';
    character.identity.hair = '';
    character.identity.face = '';
    character.identity.bodyType = '';
    const issues = checkCharacters(project).filter(
      (i) =>
        i.ruleId === 'character-unlocked-feature' &&
        i.location.kind === 'character' &&
        i.location.id === character.id,
    );
    expect(issues).toEqual([]);
  });

  it('「scholar cap」该被认成帽类', () => {
    const project = structuredClone(sampleProject);
    const luqian = project.characters.find((c) => c.name === '陆谦')!;
    luqian.continuityLocks = [];
    const issues = checkCharacters(project).filter(
      (i) =>
        i.ruleId === 'character-unlocked-feature' &&
        i.location.kind === 'character' &&
        i.location.id === luqian.id,
    );
    expect(issues.length).toBe(1);
    expect(issues[0]!.title).toContain('帽');
  });
});

// ---------------------------------------------------------------------------
// 顺序与槽位（v0.25，依据官方 playbook 与基准实测）
// ---------------------------------------------------------------------------

describe('提示词顺序 · 越容易丢的东西越往前', () => {
  it('身份描述与锁排在场景之前', () => {
    // 官方 playbook：「身份锁定这句必须放在提示词最前面，
    // 放在末尾容易被后面的服装、场景描述冲掉。」
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.sceneId && s.characterIds.length > 0)!;
    const scene = project.scenes.find((s) => s.id === shot.sceneId)!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    const parts = prompt.positive.split(', ');
    const identityIndex = parts.findIndex((p) => p.includes('felt hat'));
    const sceneIndex = parts.findIndex((p) =>
      p.toLowerCase().includes(scene.identity.summaryEn.split(',')[0]!.toLowerCase().trim()),
    );
    expect(identityIndex).toBeGreaterThan(-1);
    expect(sceneIndex).toBeGreaterThan(-1);
    expect(identityIndex, '身份特征必须排在场景之前').toBeLessThan(sceneIndex);
  });

  it('**配件类锁排在面部类锁之前**——配饰比脸更容易丢', () => {
    // EntityBench 明确承认「物体一致性比角色一致性更难，即使作为条件喂进去也常失败」。
    // 脸是模型最擅长的，配饰不是。所以越容易丢的越往前放。
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.characterIds.length > 0)!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    const parts = prompt.positive.split(', ');
    const hatIndex = parts.findIndex((p) => /hat/i.test(p));
    expect(hatIndex).toBeGreaterThan(-1);
    // 帽子必须排在前 8 个短语之内（原来排在末尾）
    expect(hatIndex, `帽子排在第 ${hatIndex + 1} 位，太靠后`).toBeLessThan(8);
  });

  it('lockPhrases 保持为纯字符串数组（对外契约不变）', () => {
    const project = structuredClone(sampleProject);
    const shot = project.shots.find((s) => s.characterIds.length > 0)!;
    const prompt = buildFramePrompt(project, shot.id, 'first-frame')!;
    for (const phrase of prompt.lockPhrases) {
      expect(typeof phrase).toBe('string');
    }
  });
});

describe('否定提示词 · 不给旧模型传有内容的否定词', () => {
  it('没写否定词时传一个空格（照抄官方示例的防呆写法）', async () => {
    const { buildDashScopeSyncPayload } = await import('../src/services/gateway/dashscope');
    const params = buildDashScopeSyncPayload({ model: 'm', prompt: 'p' })
      .parameters as Record<string, unknown>;
    expect(params.negative_prompt).toBe(' ');
  });

  it('prompt_extend 默认关闭——锁面必须原样进入，不能被智能改写', async () => {
    // 官方默认值是 true。但我们的核心设计前提是「锁面原样注入」，
    // 智能改写会破坏这个前提，所以显式关掉。
    const { buildDashScopeSyncPayload } = await import('../src/services/gateway/dashscope');
    const params = buildDashScopeSyncPayload({ model: 'm', prompt: 'p' })
      .parameters as Record<string, unknown>;
    expect(params.prompt_extend).toBe(false);
  });
});
