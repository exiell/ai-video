// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeDroppedReference,
  planReferenceImages,
  type ReferencePlan,
} from '../src/domain/image/referencePlan';
import { useImage } from '../src/store/image';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { sampleProject } from '../src/data/samples/sampleProject';
import { saveAssets } from '../src/services/storage';
import type { ImageRequest, ModelCapabilities, Project, Shot, ShotSize } from '../src/types/model';

/**
 * 参考图槽位不够时，先丢谁（v0.48）
 *
 * ===========================================================================
 * 这条规则为什么值得单独一组测试
 * ===========================================================================
 * 槽位是硬上限：千问 2.0 / 3.0 系列最多收 3 张参考图。而候选会随内容变多：
 *
 *   两个角色同框 + 承接镜 = 上一镜尾帧 + 甲的形象图 + 乙的形象图 + 场景参考板
 *
 * 4 张候选抢 3 个槽，必然丢一张。原来的丢法是「候选按顺序来，来一张丢一张」，
 * 而场景参考板**永远排在最后**，于是它**必然**第一个被丢。
 *
 * 问题在于：人一多，空间在画面里的比重反而更大，这正是最需要场景板的时候。
 * 用户看到的症状是「角色在动、背景像钉住的」或者「这不是同一个地方」，
 * 而提示词、风格、模型全都改不到点上——因为少的是那张图，不是那句话。
 *
 * 现在的规则按景别分：
 *  - 全景及更远：空间是主体 → **先丢角色形象图，保住场景板**
 *  - 中景及更近：脸是主体 → 形象图一个不少，场景板照旧让位
 *
 * 并且**丢了谁要说出来**（这是后两条断言在盯的事）。
 */

const CAPS: ModelCapabilities = {
  negativePrompt: true,
  seed: true,
  referenceImage: true,
  maxReferenceImages: 3,
  maxOutputImages: 1,
};

function ref(kind: string, tag = kind) {
  return { kind, createdAt: '2026-01-01T00:00:00Z', dataUrl: `data:image/png;base64,${tag}` };
}

const BOTH_SHEETS = [
  ref('character-sheet', 'full'),
  ref('character-sheet-face', 'face'),
];

/** 承接镜的上一镜：只看 transitionType，其余字段不影响判定 */
const CONTINUOUS_PREV: Shot = {
  ...sampleProject.shots[0]!,
  transitionType: 'continuation',
};

function planFor(options: {
  shotSize?: ShotSize;
  characters?: number;
  continuous?: boolean;
  limit?: number;
  withPlate?: boolean;
} = {}): ReferencePlan {
  const {
    shotSize,
    characters = 2,
    continuous = true,
    limit = 3,
    withPlate = true,
  } = options;
  return planReferenceImages({
    kind: 'first-frame',
    capabilities: { ...CAPS, maxReferenceImages: limit },
    previous: continuous
      ? CONTINUOUS_PREV
      : { ...CONTINUOUS_PREV, transitionType: 'cut' },
    ...(shotSize ? { shotSize } : {}),
    characterNames: ['林冲', '陆谦', '高俅'].slice(0, characters),
    sources: {
      ownFrames: [],
      previousFrames: continuous ? [ref('end-frame')] : [],
      characterSheets: Array.from({ length: characters }, () => BOTH_SHEETS),
      scenePlates: withPlate ? [ref('scene-plate')] : [],
    },
  });
}

const rolesOf = (plan: ReferencePlan) => plan.slots.map((slot) => slot.role);
const ownersOf = (plan: ReferencePlan) => plan.dropped.map((item) => item.owner);

describe('① 全景及更远：保住场景参考板，先丢角色形象图', () => {
  it('两个角色同框的承接镜，3 个槽位里场景板还在', () => {
    const plan = planFor({ shotSize: 'wide' });
    expect(rolesOf(plan)).toContain('previous-end-frame');
    expect(rolesOf(plan)).toContain('scene-plate');
    expect(plan.slots).toHaveLength(3);
  });

  it('被丢的是排在后面的那个角色，而且记下了是谁', () => {
    const plan = planFor({ shotSize: 'wide' });
    expect(plan.dropped).toHaveLength(1);
    expect(plan.dropped[0]).toEqual({ role: 'character-sheet', owner: '陆谦' });
    // 第一个角色仍在 —— 项目里角色顺序就是用户排的顺序，主角通常在前
    expect(plan.slots.filter((slot) => slot.role === 'character-sheet')).toHaveLength(1);
  });

  it('full / wide / extreme-wide 三档都按这个规则', () => {
    for (const shotSize of ['full', 'wide', 'extreme-wide'] as ShotSize[]) {
      const plan = planFor({ shotSize });
      expect(rolesOf(plan), `${shotSize} 应该保住场景板`).toContain('scene-plate');
      expect(plan.dropped.map((item) => item.role), `${shotSize} 丢的应该是形象图`).toEqual([
        'character-sheet',
      ]);
    }
  });

  it('远景用全身图，丢掉的也确实是全身那张', () => {
    const plan = planFor({ shotSize: 'wide' });
    const kept = plan.slots.find((slot) => slot.role === 'character-sheet');
    expect(kept?.detail).toBe('full-body');
  });

  it('三个角色时丢两张形象图，仍保住尾帧与场景板', () => {
    const plan = planFor({ shotSize: 'wide', characters: 3 });
    expect(plan.slots).toHaveLength(3);
    // 顺序由 orderSlots 决定（角色图在前、决定画幅的那张在后），这里只关心「谁还在」
    expect(new Set(rolesOf(plan))).toEqual(
      new Set(['previous-end-frame', 'character-sheet', 'scene-plate']),
    );
    expect(ownersOf(plan)).toEqual(['陆谦', '高俅']);
  });
});

describe('② 中景及更近：形象图一个不少，场景板照旧让位', () => {
  it('中景两个角色同框时不放场景板', () => {
    const plan = planFor({ shotSize: 'medium' });
    expect(rolesOf(plan)).not.toContain('scene-plate');
    expect(plan.dropped).toEqual([{ role: 'scene-plate' }]);
    expect(plan.slots.filter((slot) => slot.role === 'character-sheet')).toHaveLength(2);
  });

  it('特写同理', () => {
    const plan = planFor({ shotSize: 'close-up' });
    expect(plan.dropped).toEqual([{ role: 'scene-plate' }]);
  });

  it('不传景别时保持改动前的行为（按中景处理，场景板让位）', () => {
    const plan = planFor({});
    expect(plan.dropped).toEqual([{ role: 'scene-plate' }]);
  });
});

describe('③ 放得下的时候什么都不丢', () => {
  it('跳切的首帧只有三张候选，刚好放满', () => {
    const plan = planFor({ continuous: false });
    expect(plan.dropped).toEqual([]);
    expect(rolesOf(plan)).toContain('scene-plate');
  });

  it('一个角色 + 承接镜，刚好三张', () => {
    const plan = planFor({ characters: 1 });
    expect(plan.dropped).toEqual([]);
    expect(plan.slots).toHaveLength(3);
  });

  it('槽位更多的模型上什么都不丢', () => {
    const plan = planFor({ limit: 10, characters: 3 });
    expect(plan.dropped).toEqual([]);
    // 上一镜尾帧 + 三张形象图 + 场景板
    expect(plan.slots).toHaveLength(5);
  });

  it('场景没有参考板时，不去「丢」一张不存在的图', () => {
    const plan = planFor({ shotSize: 'wide', withPlate: false });
    expect(plan.dropped).toEqual([]);
  });
});

describe('④ 没有场景板可保时，退回按候选顺序丢', () => {
  it('远景 + 两个角色 + 只有两个槽，丢最后一张候选', () => {
    const plan = planFor({ shotSize: 'wide', limit: 2, withPlate: false });
    expect(plan.slots).toHaveLength(2);
    expect(plan.dropped).toEqual([{ role: 'character-sheet', owner: '陆谦' }]);
  });

  it('中景 + 三个角色 + 四个槽：只差一张，丢的是场景板而不是某个角色', () => {
    const plan = planFor({ shotSize: 'medium', characters: 3, limit: 4 });
    expect(plan.dropped).toEqual([{ role: 'scene-plate' }]);
    expect(plan.slots.filter((slot) => slot.role === 'character-sheet')).toHaveLength(3);
  });

  it('缺口比场景板还大时，剩下的缺口从末尾依次补，每个被丢的都记下来', () => {
    // 中景 + 三个角色 + 三个槽：5 张候选差 2 张，场景板先让位，再让位最后一个角色
    const plan = planFor({ shotSize: 'medium', characters: 3 });
    expect(plan.slots).toHaveLength(3);
    expect(plan.dropped).toEqual([
      { role: 'character-sheet', owner: '高俅' },
      { role: 'scene-plate' },
    ]);
  });
});

describe('⑤ 「丢了谁」的中文说法', () => {
  it('角色形象图带上名字', () => {
    expect(describeDroppedReference({ role: 'character-sheet', owner: '陆谦' })).toBe(
      '陆谦的形象图',
    );
  });

  it('不知道是谁时退化成一个通用说法，而不是「undefined的形象图」', () => {
    expect(describeDroppedReference({ role: 'character-sheet' })).toBe('一张角色形象图');
  });

  it('其余三类各有说法', () => {
    expect(describeDroppedReference({ role: 'scene-plate' })).toBe('场景参考板');
    expect(describeDroppedReference({ role: 'previous-end-frame' })).toBe('上一镜尾帧');
    expect(describeDroppedReference({ role: 'own-first-frame' })).toBe('本镜首帧');
  });
});

// ===========================================================================
// store 层：这次取舍有没有真的说出来
// ===========================================================================
//
// 前四组测的是「丢得对不对」，这一组测的是「有没有说」。
// 静默丢一张参考图是这个项目里反复出现的毛病：功能看起来在工作，其实少了一环，
// 用户只能对着「看着像但哪里不对」出图，一个地方都改不到。
// ===========================================================================

const captured: ImageRequest[] = [];

vi.mock('../src/services/image/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/image/generate')>();
  return {
    ...actual,
    generateImages: async (args: { req: ImageRequest }) => {
      captured.push(args.req);
      return {
        ok: true,
        warnings: [],
        images: [{ dataUrl: 'data:image/png;base64,AAA', url: 'https://x/y.png' }],
      };
    },
  };
});

function asset(
  id: string,
  kind: 'scene-plate' | 'end-frame' | 'character-sheet-face' | 'character-sheet',
  refId: string,
) {
  const now = new Date().toISOString();
  return {
    id,
    projectId: sampleProject.id,
    kind,
    refId,
    dataUrl: `data:image/png;base64,${id}`,
    mimeType: 'image/png',
    promptSnapshot: 'x',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

/** 示例项目里第二镜改成「两个角色同框」，并让第一镜承接过来 */
function twoCharacters(shotSize: ShotSize): Project {
  const project = structuredClone(sampleProject);
  project.shots[0]!.transitionType = 'continuation';
  const second = project.shots[1]!;
  second.characterIds = ['ch-linchong', 'ch-luqian'];
  second.shotSize = shotSize;
  return project;
}

async function runSecondShot(shotSize: ShotSize): Promise<string[]> {
  useAppStore.setState({ project: twoCharacters(shotSize) });
  await useImage.getState().generateForFrame('shot-02', 'first-frame', true);
  return useImage.getState().feedback['first-frame:shot-02']?.warnings ?? [];
}

beforeEach(async () => {
  captured.length = 0;
  useImage.setState({
    pending: null,
    feedback: {},
    gallery: {},
    assetCount: 0,
    assetCounts: {},
    batch: null,
    batchSummary: null,
  });
  useSettings.setState({ keys: { dashscope: 'sk-test' } });
  useAppStore.setState({ project: structuredClone(sampleProject) });
  await saveAssets([
    asset('plate-field', 'scene-plate', 'sc-field'),
    asset('plate-temple', 'scene-plate', 'sc-temple'),
    asset('end-01', 'end-frame', 'shot-01'),
    asset('face-linchong', 'character-sheet-face', 'ch-linchong'),
    asset('full-linchong', 'character-sheet', 'ch-linchong'),
    asset('face-luqian', 'character-sheet-face', 'ch-luqian'),
    asset('full-luqian', 'character-sheet', 'ch-luqian'),
  ]);
});

describe('⑥ 少了哪张参考图，出图结果里要说出来', () => {
  it('远景丢了角色形象图，警告里点名是谁、为什么', async () => {
    const warnings = await runSecondShot('wide');
    const joined = warnings.join('\n');
    expect(joined).toContain('陆谦的形象图');
    expect(joined).toContain('这一次没用上');
    // 要能算出「几张要几张给」，否则用户不知道该找谁
    expect(joined).toMatch(/这一镜要 4 张参考图/);
    expect(joined).toContain('最多只收 3 张');
    // 给出的出路要具体到能点的位置
    expect(joined).toContain('多图参考版');
  });

  it('远景里场景板被保住了 —— 警告里不该出现「场景参考板这次没用上」', async () => {
    const warnings = await runSecondShot('wide');
    expect(warnings.join('\n')).not.toContain('「场景参考板」这一次没用上');
  });

  it('中景丢的是场景板，给出的出路是改景别而不是换模型', async () => {
    const warnings = await runSecondShot('medium');
    const joined = warnings.join('\n');
    expect(joined).toContain('「场景参考板」这一次没用上');
    expect(joined).toContain('景别改成全景或更远');
    expect(joined).not.toContain('陆谦的形象图');
  });

  it('没有溢出时不产生这条警告，别让每一镜都响一遍', async () => {
    // 单角色 + 承接镜 = 三张候选，刚好放满
    useAppStore.setState({ project: structuredClone(sampleProject) });
    useAppStore.setState((state) => {
      if (!state.project) return {};
      state.project.shots[0]!.transitionType = 'continuation';
      return {};
    });
    await useImage.getState().generateForFrame('shot-02', 'first-frame', true);
    const warnings = useImage.getState().feedback['first-frame:shot-02']?.warnings ?? [];
    expect(warnings.join('\n')).not.toContain('这一次没用上');
  });
});
