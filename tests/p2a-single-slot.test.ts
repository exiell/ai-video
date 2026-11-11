// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDegradedTextCompensation,
  capabilityNotice,
  degradedWarnings,
  planDelivery,
  referenceCapabilityOf,
} from '../src/domain/image/delivery';
import { collectAnchors, type RefAsset, type ReferenceSource } from '../src/domain/image/anchors';
import { withDeliveryCompensation } from '../src/domain/image/prompts';
import { findProfile } from '../src/data/models/profiles';
import type { Asset, ImageRequest, ModelCapabilities, Shot } from '../src/types/model';

/**
 * P2-a：单槽策略、能力来源、降级补偿
 *
 * ===========================================================================
 * 为什么这一组测试必须存在
 * ===========================================================================
 * P1 是行为等价（旧测试就能证明）；P2-a 开始改变用户可见行为：
 *  - 只有**已核实**的档案才声明能力（qwen-image-edit / 两个 0 槽档案）；
 *  - 其他档案仍走 legacy，**不许把推断当事实**；
 *  - 1 槽跳切会丢一维，必须如实上报并只用**已有数据原文**做文字补偿；
 *  - 编辑模型才写「保留原图其余部分」，且不做任何「左右人物」位置绑定。
 *
 * 这组测试同时覆盖 domain 纯函数与 store 的真实接线（mock 掉出图请求），
 * 防止「函数对了但没接上」。
 */

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function legacyCaps(maxImages: number): ModelCapabilities {
  return {
    negativePrompt: true,
    seed: true,
    referenceImage: maxImages > 0,
    maxReferenceImages: maxImages,
    maxOutputImages: 1,
  };
}

function declaredCaps(reference: ModelCapabilities['reference']): ModelCapabilities {
  const max = reference?.maxImages;
  return {
    negativePrompt: true,
    seed: true,
    referenceImage: reference ? reference.semantics !== 'none' : false,
    maxReferenceImages: typeof max === 'number' ? max : 0,
    maxOutputImages: 1,
    ...(reference ? { reference } : {}),
  };
}

const now = '2026-01-01T00:00:00.000Z';
function asset(kind: string, refId = kind): RefAsset {
  return {
    kind,
    createdAt: now,
    dataUrl: `data:image/png;base64,${refId}`,
    styleTags: ['anime'],
  };
}

function makeShot(overrides: Partial<Shot> & Pick<Shot, 'id' | 'number'>): Shot {
  return {
    duration: 3,
    shotSize: 'medium',
    cameraPosition: '',
    cameraMove: 'static',
    startState: '他站在门口',
    action: '他推开门',
    endState: '他走进屋里',
    dialogue: '',
    sound: '',
    mood: '',
    transition: '硬切',
    sceneId: 'scene-a',
    characterIds: ['char-1'],
    variantIds: [],
    activeLockIds: [],
    offscreenCharacters: [],
    sourceSceneId: '',
    ...overrides,
  };
}

function anchorSetFor(continuous: boolean, shotSize: 'medium' | 'wide' = 'medium') {
  const sources: ReferenceSource = {
    ownFrames: [asset('first-frame')],
    previousFrames: [asset('end-frame')],
    characterSheets: [[asset('character-sheet'), asset('character-sheet-face')]],
    scenePlates: [asset('scene-plate')],
  };
  const previous = makeShot({
    id: 'prev',
    number: 1,
    transitionType: continuous ? 'continuation' : 'cut',
  });
  return collectAnchors({
    kind: 'first-frame',
    previous,
    sources,
    shotSize,
    characterNames: ['林冲'],
    styleTags: ['anime'],
  });
}

describe('① 档案能力声明：只声明已核实的', () => {
  it('**qwen-image-edit 声明 edit/3 槽/dataURI/最后定画幅**（官方文档已核实）', () => {
    const profile = findProfile('qwen-image-edit')!;
    expect(profile.capabilities.reference).toEqual({
      semantics: 'edit',
      maxImages: 3,
      acceptsDataUri: true,
      maxBytesPerImage: 10 * 1024 * 1024,
      aspectFollows: 'last',
    });
    const context = referenceCapabilityOf(profile.capabilities);
    expect(context.source).toBe('declared');
    expect(context.capability.semantics).toBe('edit');
  });

  it('zhipu-image / siliconflow-image 声明 none/0（纯文生图已核实）', () => {
    for (const id of ['zhipu-image', 'siliconflow-image']) {
      const profile = findProfile(id)!;
      expect(profile.capabilities.reference).toMatchObject({
        semantics: 'none',
        maxImages: 0,
        acceptsDataUri: false,
      });
      expect(referenceCapabilityOf(profile.capabilities).source).toBe('declared');
    }
  });

  it('**未核实语义的档案保持 legacy**：minimax-image / qwen 系列不填 reference', () => {
    for (const id of ['minimax-image', 'qwen-image', 'qwen-image-fast', 'qwen-image-2.1']) {
      const profile = findProfile(id)!;
      expect(profile.capabilities.reference, id).toBeUndefined();
      const context = referenceCapabilityOf(profile.capabilities);
      expect(context.source, id).toBe('legacy');
      // legacy 不得把旧字段写成能力事实
      expect(context.capability.semantics, id).toBe('unknown');
      expect(context.capability.acceptsDataUri, id).toBe('unknown');
      expect(context.capability.aspectFollows, id).toBe('unknown');
    }
  });
});

describe('② unknown 不投递；declared 按声明投递', () => {
  it('**能力 unknown 时一张都不投**，全部维度降级', () => {
    const caps = declaredCaps({
      semantics: 'unknown',
      maxImages: 'unknown',
      acceptsDataUri: 'unknown',
    });
    const context = referenceCapabilityOf(caps);
    expect(context.source).toBe('unknown');

    const delivery = planDelivery(anchorSetFor(true), context);
    expect(delivery.mode).toBe('text-only');
    expect(delivery.slots).toEqual([]);
    expect(delivery.degraded).toEqual(['continuity', 'identity', 'space']);
  });

  it('**declared 但 acceptsDataUri 不是 true 时不投递**（管线只有 data URI）', () => {
    for (const acceptsDataUri of [false, 'unknown'] as const) {
      const caps = declaredCaps({
        semantics: 'reference',
        maxImages: 3,
        acceptsDataUri,
        aspectFollows: 'unknown',
      });
      const delivery = planDelivery(anchorSetFor(true), referenceCapabilityOf(caps));
      expect(delivery.mode, String(acceptsDataUri)).toBe('text-only');
      expect(delivery.slots, String(acceptsDataUri)).toEqual([]);
    }
  });

  it('declared none（0 槽档案）同样不投递', () => {
    const caps = declaredCaps({
      semantics: 'none',
      maxImages: 0,
      acceptsDataUri: false,
      aspectFollows: 'param',
    });
    const delivery = planDelivery(anchorSetFor(true), referenceCapabilityOf(caps));
    expect(delivery.mode).toBe('text-only');
    expect(delivery.slots).toEqual([]);
    expect(delivery.degraded).toEqual(['continuity', 'identity', 'space']);
  });

  it('1 槽·跳切·中景：保脸丢空间；1 槽·全景：保景丢身份（与旧 slots 一致）', () => {
    const medium = planDelivery(
      anchorSetFor(false, 'medium'),
      referenceCapabilityOf(legacyCaps(1)),
    );
    expect(medium.slots.map((slot) => slot.role)).toEqual(['character-sheet']);
    expect(medium.degraded).toEqual(['space']);

    const wide = planDelivery(anchorSetFor(false, 'wide'), referenceCapabilityOf(legacyCaps(1)));
    expect(wide.slots.map((slot) => slot.role)).toEqual(['scene-plate']);
    expect(wide.degraded).toEqual(['identity']);
  });
});

describe('③ 文字补偿：只用已有原文、不做位置绑定', () => {
  it('**丢空间**：注入场景固定元素/主光方向/空间结构原文，并说明由文字锁定', () => {
    const lines = buildDegradedTextCompensation(['space'], {
      scene: {
        spatialStructure: '长方形教室，门在短边，窗在左墙',
        fixedElements: ['rows of wooden desks', '绿色黑板'],
        lightDirection: '傍晚，暖光从右侧窗户斜射',
      },
    });
    const text = lines.join('\n');
    expect(text).toContain('Space is locked by the text');
    expect(text).toContain('长方形教室，门在短边，窗在左墙');
    expect(text).toContain('rows of wooden desks');
    expect(text).toContain('绿色黑板');
    expect(text).toContain('傍晚，暖光从右侧窗户斜射');
    // 不做位置绑定：整段里不能出现 left/right/左边/右边
    expect(text).not.toMatch(/left|right|左边|右边/);
  });

  it('**丢身份**：注入角色身份摘要与连续性锁原文', () => {
    const lines = buildDegradedTextCompensation(['identity'], {
      characters: [
        {
          name: '林冲',
          summary: '八十万禁军教头，豹头环眼',
          summaryEn: 'a lean swordsman',
          locks: ['深蓝色长袍', '腰间佩刀'],
        },
      ],
    });
    const text = lines.join('\n');
    expect(text).toContain('林冲: a lean swordsman');
    expect(text).toContain('深蓝色长袍');
    expect(text).toContain('腰间佩刀');
    expect(text).not.toMatch(/left|right|左边|右边/);
  });

  it('没有原始素材时不编内容：返回空数组，而不是空泛描述', () => {
    expect(buildDegradedTextCompensation(['space'], {})).toEqual([]);
    expect(buildDegradedTextCompensation(['identity'], {})).toEqual([]);
  });
});

describe('④ 提示词：edit 保留句只对 declared edit', () => {
  it('**declared edit 才加保留句**', () => {
    const prompt = withDeliveryCompensation('A man walks in.', { editMode: true });
    expect(prompt).toContain('Keep everything in this image unchanged except');
  });

  it('legacy/unknown 不加保留句（editMode=false）', () => {
    const prompt = withDeliveryCompensation('A man walks in.', { editMode: false });
    expect(prompt).toBe('A man walks in.');
    expect(prompt).not.toContain('Keep everything in this image unchanged except');
  });

  it('文字补偿句进入提示词，且不含左右位置绑定', () => {
    const prompt = withDeliveryCompensation('A man walks in.', {
      editMode: false,
      compensation: ['Space is locked by the text: layout: 长方形教室.'],
    });
    expect(prompt).toContain('Space is locked by the text: layout: 长方形教室.');
    expect(prompt).not.toMatch(/left|right|figure on the left|figure on the right/);
  });

  it('编辑语义 + 补偿同时存在：保留句在前、补偿其次、原提示词最后', () => {
    const prompt = withDeliveryCompensation('A man walks in.', {
      editMode: true,
      compensation: ['Space is locked by the text: layout: 长方形教室.'],
    });
    expect(prompt.indexOf('Keep everything in this image unchanged')).toBeLessThan(
      prompt.indexOf('Space is locked by the text'),
    );
    expect(prompt.endsWith('A man walks in.')).toBe(true);
  });
});

describe('⑤ 降级提示文案', () => {
  it('legacy 档案带「能力未核实/保守处理」提示；unknown 带「不投递」提示', () => {
    expect(capabilityNotice('legacy')).toContain('能力未核实');
    expect(capabilityNotice('legacy')).toContain('保守');
    expect(capabilityNotice('unknown')).toContain('不投递');
    expect(capabilityNotice('declared')).toBeUndefined();
  });

  it('降级 warnings 说清哪一维只剩文字、以及补偿方式', () => {
    const warnings = degradedWarnings(['space'], 'declared', ['space']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('空间与光线');
    expect(warnings[0]).toContain('只能靠文字锁定');
    expect(warnings[0]).toContain('已把场景的固定元素');
    // legacy 再追加未核实提示
    expect(degradedWarnings(['space'], 'legacy')[0]).toContain('能力未核实');
  });

  it('**没有注入原文时不说「已写入」**（避免和实际不符）', () => {
    const warnings = degradedWarnings(['space', 'identity'], 'declared')[0]!;
    expect(warnings).not.toContain('已把');
    expect(warnings).toContain('没有可注入');
  });
});

// ---------------------------------------------------------------------------
// store 接线：degradedDimensions / feedback warnings / editMode 有没有真的到达
// ---------------------------------------------------------------------------

const captured: ImageRequest[] = [];
/** 每次请求实际解析到的档案 id（用于断言 0 投递时回退 plain 档案） */
const capturedProfiles: string[] = [];

vi.mock('../src/services/image/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/image/generate')>();
  return {
    ...actual,
    generateImages: async (args: { profile: { id: string }; req: ImageRequest }) => {
      captured.push(args.req);
      capturedProfiles.push(args.profile.id);
      return {
        ok: true,
        warnings: [],
        images: [{ dataUrl: 'data:image/png;base64,AAA', url: 'https://x/y.png' }],
      };
    },
  };
});

import { useImage } from '../src/store/image';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { sampleProject } from '../src/data/samples/sampleProject';
import { saveAssets } from '../src/services/storage';

function imageAsset(id: string, kind: Asset['kind'], refId: string) {
  const stamp = new Date().toISOString();
  return {
    id,
    projectId: sampleProject.id,
    kind,
    refId,
    dataUrl: `data:image/png;base64,${id}`,
    mimeType: 'image/png',
    promptSnapshot: 'x',
    createdAt: stamp,
    updatedAt: stamp,
    schemaVersion: 1,
  };
}

function projectForSingleSlot(transition: 'continuation' | 'cut') {
  const project = structuredClone(sampleProject);
  // 与上一镜是否连续，看的是**上一镜**的 transitionType，不是本镜的
  project.shots[0]!.transitionType = transition;
  const second = project.shots[1]!;
  second.characterIds = ['ch-linchong'];
  second.shotSize = 'medium';
  return project;
}

async function runSecondShot(transition: 'continuation' | 'cut'): Promise<void> {
  useAppStore.setState({ project: projectForSingleSlot(transition) });
  await useImage.getState().generateForFrame('shot-02', 'first-frame', true);
}

function warningsOf(): string[] {
  return useImage.getState().feedback['first-frame:shot-02']?.warnings ?? [];
}

beforeEach(async () => {
  captured.length = 0;
  capturedProfiles.length = 0;
  useImage.setState({
    pending: null,
    feedback: {},
    gallery: {},
    assetCount: 0,
    assetCounts: {},
    batch: null,
    batchSummary: null,
  });
  useSettings.setState({
    keys: { dashscope: 'sk-test', minimax: 'sk-minimax' },
    prefs: { ...useSettings.getState().prefs, defaultReferenceProfileId: 'minimax-image' },
  });
  useAppStore.setState({ project: structuredClone(sampleProject) });
  await saveAssets([
    imageAsset('end-01', 'end-frame', 'shot-01'),
    imageAsset('full-linchong', 'character-sheet', 'ch-linchong'),
    imageAsset('face-linchong', 'character-sheet-face', 'ch-linchong'),
    imageAsset('plate', 'scene-plate', sampleProject.shots[1]!.sceneId),
  ]);
});

describe('⑥ store 接线（legacy 1 槽档案）', () => {
  it('**degradedDimensions 进请求，legacy 提示与降级提示进 feedback**', async () => {
    await runSecondShot('cut');

    const req = captured[0]!;
    expect(req.frameRole?.degradedDimensions).toEqual(['space']);
    expect(req.prompt).toContain('Space is locked by the text');
    expect(req.prompt).not.toContain('Keep everything in this image unchanged');

    const warnings = warningsOf().join('\n');
    expect(warnings).toContain('能力未核实');
    expect(warnings).toContain('只能靠文字锁定');
    expect(warnings).toContain('空间与光线');
  });

  it('承接镜不丢维度：不进 degraded、不写补偿', async () => {
    await runSecondShot('continuation');
    const req = captured[0]!;
    expect(req.frameRole?.degradedDimensions).toBeUndefined();
    expect(req.prompt).not.toContain('Space is locked by the text');
    expect(warningsOf().join('\n')).toContain('能力未核实');
  });
});

describe('⑥b 0 投递：纯文生图不得注入任何 P2-a 句子/警告（blocker 回归）', () => {
  it('**空素材 + qwen-image-edit + useReference=true**：按纯文生图处理，不加 edit/补偿/警告', async () => {
    // 换一个 project id：fake-indexeddb 里已有素材都挂在 sampleProject.id 下，这里查不到图
    const emptyProject = structuredClone(sampleProject);
    emptyProject.id = 'empty-project';
    useAppStore.setState({ project: emptyProject });

    await useImage.getState().generateForFrame('shot-02', 'first-frame', true);

    const req = captured[0]!;
    expect(req.referenceImages).toBeUndefined();
    expect(req.frameRole?.degradedDimensions).toBeUndefined();
    expect(req.prompt).not.toContain('This is an image editing task');
    expect(req.prompt).not.toContain('Space is locked by the text');
    const warnings = warningsOf().join('\n');
    expect(warnings).not.toContain('能力未核实');
    expect(warnings).not.toContain('只能靠文字锁定');
    // 没有参考图 → 回退到 plain 档案（默认 qwen-image），不是 qwen-image-edit
    expect(capturedProfiles[0]).toBe('qwen-image');
  });

  it('**0 槽 declared 档案（zhipu-image）**：即使有素材也不投递、不注入', async () => {
    useSettings.setState({
      keys: { ...useSettings.getState().keys, zhipu: 'sk-zhipu' },
      prefs: { ...useSettings.getState().prefs, defaultReferenceProfileId: 'zhipu-image' },
    });
    await runSecondShot('cut');

    const req = captured[0]!;
    expect(req.referenceImages).toBeUndefined();
    expect(req.frameRole?.degradedDimensions).toBeUndefined();
    expect(req.prompt).not.toContain('This is an image editing task');
    expect(req.prompt).not.toContain('Space is locked by the text');
    expect(warningsOf().join('\n')).not.toContain('能力未核实');
    expect(capturedProfiles[0]).toBe('qwen-image');
  });
});

describe('⑦ store 接线（declared edit 档案）', () => {
  it('**declared edit 才传 editMode，且没有 legacy 提示**', async () => {
    useSettings.setState({
      prefs: { ...useSettings.getState().prefs, defaultReferenceProfileId: 'qwen-image-edit' },
    });
    await runSecondShot('cut');

    const req = captured[0]!;
    expect(req.prompt).toContain('Keep everything in this image unchanged');
    expect(warningsOf().join('\n')).not.toContain('能力未核实');
    // qwen-image-edit 3 槽，跳切中景只缺场景板之外没有缺口 → 不降级
    expect(req.frameRole?.degradedDimensions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ⑥c compensated 必须按「实际注入的文本非空」判断（P2 文案真实性）
// ---------------------------------------------------------------------------

/**
 * 1 槽 + wide + 跳切：保场景板、丢角色形象图 → 身份维降级。
 * 角色卡是「新建角色」时 identity 摘要可能还是空的，此时没有可注入原文。
 */
function projectForIdentityDrop(options: { withIdentity: boolean }) {
  const project = structuredClone(sampleProject);
  // 与上一镜是否连续看上一镜的 transitionType：cut = 本镜跳切
  project.shots[0]!.transitionType = 'cut';
  const second = project.shots[1]!;
  second.characterIds = ['ch-linchong'];
  second.shotSize = 'wide';
  const character = project.characters.find((item) => item.id === 'ch-linchong')!;
  character.identity.summary = '';
  if (options.withIdentity) {
    character.identity.summaryEn = 'a lean swordsman in a dark cloak';
    character.continuityLocks = [
      { id: 'lock-identity', label: '深蓝长袍', phrase: 'deep blue robe', appliesTo: 'look' },
    ];
    second.activeLockIds = ['lock-identity'];
  } else {
    character.identity.summaryEn = '';
    character.continuityLocks = [];
    second.activeLockIds = [];
  }
  return project;
}

describe('⑥c compensated 按实际注入文本判断（文案真实性）', () => {
  it('**新角色 identity 为空 + 1 槽 wide 丢身份**：不说「已写入」，如实说没有可注入原文', async () => {
    useAppStore.setState({ project: projectForIdentityDrop({ withIdentity: false }) });
    await useImage.getState().generateForFrame('shot-02', 'first-frame', true);

    const req = captured[0]!;
    expect(req.frameRole?.degradedDimensions).toEqual(['identity']);
    // 没有可注入原文 → 不应出现身份补偿句
    expect(req.prompt).not.toContain('Character identity is locked by the text');

    const warnings = warningsOf().join('\n');
    expect(warnings).not.toContain('已把角色身份摘要');
    expect(warnings).toContain('没有可注入');
  });

  it('**identity / 生效锁有内容**：compensated=true，提示含项目字段原文片段', async () => {
    useAppStore.setState({ project: projectForIdentityDrop({ withIdentity: true }) });
    await useImage.getState().generateForFrame('shot-02', 'first-frame', true);

    const req = captured[0]!;
    expect(req.frameRole?.degradedDimensions).toEqual(['identity']);
    expect(req.prompt).toContain('Character identity is locked by the text');
    // 原文来自项目字段：identity.summaryEn 与生效 continuityLocks[].phrase
    expect(req.prompt).toContain('a lean swordsman in a dark cloak');
    expect(req.prompt).toContain('deep blue robe');

    const warnings = warningsOf().join('\n');
    expect(warnings).toContain('已把角色身份摘要与连续性锁原文写进提示词');
    expect(warnings).not.toContain('没有可注入');
  });
});
