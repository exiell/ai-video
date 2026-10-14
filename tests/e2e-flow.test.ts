import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { generateAssets, generateShots, generateStory, type GenerateContext } from '../src/services/llm/generate';
import { assetsFromGenerated, shotsFromGenerated, storyFromGenerated } from '../src/services/llm/mapping';
import { buildExportManifest, buildZip } from '../src/domain/export/bundle';
import { runChecks } from '../src/domain/checks';
import { buildShotPrompt } from '../src/domain/prompt';
import { MODEL_PROFILES } from '../src/data/models/profiles';
import { makeEmptyProject } from '../src/store/app';
import type { Project } from '../src/types/model';

/**
 * 全链路集成测试
 *
 * 目的：证明「一个用户在配置好 Key 之后，能不能真的从一句话想法走到一份可下载的方案」。
 *
 * 这里用一个**模拟的模型服务端**替代真实 API：它按顺序回应三次请求
 * （故事 → 角色与场景 → 分镜），返回与真实模型同构的 JSON。
 * 这样整条链路的逻辑（解析、映射、引用闭环、检查、提示词、导出）都被真实执行了一遍，
 * 只有「HTTP 那一跳」是假的。
 *
 * 真实 API 的那一跳无法在这里验证——那是跨域问题，只能在浏览器里做（见 public/cors-check.html）。
 */

const llm = MODEL_PROFILES.find((p) => p.type === 'llm')!;

// ---------------------------------------------------------------------------
// 模拟模型服务端
// ---------------------------------------------------------------------------

const STORY_JSON = JSON.stringify({
  body:
    '深夜的便利店，值夜班的女孩发现冰柜里多了一盒没有标签的牛奶。' +
    '她打开盒子，里面是一张写着明天的日期的收据。她抬头，门口的风铃响了。',
  charactersNote: '小满：便利店值夜班的女孩。神秘顾客：只在最后出现。',
  setting: '现代城市，深夜便利店',
  conflict: '小满要不要打开那盒没有标签的牛奶',
  ending: '风铃响，她抬头看向门口',
  scenes: [
    { label: '便利店 · 深夜', summary: '小满值夜班，发现异常的牛奶盒' },
    { label: '便利店门口 · 深夜', summary: '风铃响，有人推门进来' },
  ],
});

const ASSETS_JSON = JSON.stringify({
  characters: [
    {
      slug: 'xiaoman',
      name: '小满',
      role: 'protagonist',
      identity: {
        face: '圆脸，单眼皮，眼下有淡淡的黑眼圈',
        hair: '齐肩黑发，用一根皮筋随手扎起',
        bodyType: '偏瘦小',
        ageRange: '二十出头',
        summary: '小满，二十出头的便利店夜班店员',
        summaryEn:
          'Xiaoman, a slight young woman in her early twenties, round face, single-lidded eyes, dark circles, shoulder-length black hair tied back',
      },
      continuityLocks: [
        {
          label: '店员围裙',
          phrase: 'a dark green convenience store apron with a name tag on the chest',
          appliesTo: 'look',
        },
        {
          label: '皮筋扎发',
          phrase: 'shoulder-length black hair tied back with a plain elastic band',
          appliesTo: 'look',
        },
      ],
      variants: [
        {
          label: '翻开盒盖·睁大眼睛',
          changedFeatures: ['眼睛睁大', '呼吸停住'],
        },
      ],
      negativePrompt: 'heavy makeup, glamorous outfit',
    },
  ],
  scenes: [
    {
      slug: 'store',
      name: '便利店 · 深夜',
      identity: {
        placeType: '24 小时便利店',
        spatialStructure: '长方形，进门右手是收银台，左手一整排冰柜，尽头是落地窗',
        summary: '深夜的便利店店内',
        summaryEn:
          'the interior of a 24-hour convenience store at night, checkout counter on the right, a row of glass freezer doors on the left, floor-to-ceiling window at the far end',
      },
      fixedElements: [
        'a row of glass freezer doors',
        'a checkout counter with a small register',
        'fluorescent ceiling lights',
      ],
      lightDirection: '深夜，店内冷白荧光灯从头顶直下，窗外是青蓝色的街灯',
      mainColor: '冷白 + 青蓝',
      timeOfDay: '深夜',
      weather: '晴',
      continuityLocks: [
        {
          label: '冰柜与收银台的位置',
          phrase: 'freezer doors along the left wall, checkout counter on the right',
          appliesTo: 'geography',
        },
      ],
    },
  ],
});

const SHOTS_JSON = JSON.stringify({
  shots: [
    {
      duration: 4,
      shotSize: 'extreme-wide',
      cameraPosition: '店外，隔着落地窗向内',
      cameraMove: 'static',
      startState:
        '深夜的便利店隔着落地窗看进去；左侧一整排冰柜透出白光，右侧收银台后站着一个人影，头顶荧光灯把地面照得发青',
      action: '一个人影从收银台后慢慢直起身',
      endState: '人影站直，侧脸对着窗外',
      dialogue: '',
      sound: '冰柜压缩机的低频嗡鸣，远处车流',
      mood: '空荡，安静',
      transition: '硬切',
      sceneSlug: 'item-1',
      characterSlugs: ['item-1'],
      activeLockLabels: ['店员围裙', '皮筋扎发', '冰柜与收银台的位置'],
      activeVariantLabels: [],
      offscreenCharacters: [],
      sourceSceneIndex: 0,
    },
    {
      duration: 3,
      shotSize: 'close-up',
      cameraPosition: '与视线齐平，略低',
      cameraMove: 'push-in',
      startState:
        '小满的脸部特写，深绿色店员围裙的肩带在画框下缘，齐肩黑发用一根素色皮筋扎在脑后，头顶冷白荧光灯在她的眼下投出淡影',
      action: '她伸手拉开冰柜门',
      endState: '她的手停在门把上，眼睛盯着冰柜内部',
      dialogue: '',
      sound: '冰柜门被拉开的吸力声',
      mood: '疑惑',
      transition: '硬切',
      sceneSlug: 'item-1',
      characterSlugs: ['item-1'],
      activeLockLabels: ['店员围裙', '皮筋扎发'],
      activeVariantLabels: [],
      offscreenCharacters: [],
      sourceSceneIndex: 0,
    },
    {
      duration: 3,
      shotSize: 'medium',
      cameraPosition: '收银台内侧，正面',
      cameraMove: 'static',
      startState:
        '小满站在收银台后，深绿色店员围裙上有胸牌，齐肩黑发仍用素色皮筋扎着，手里捧着一个没有标签的白色牛奶盒，头顶荧光灯照得她脸色发白',
      action: '她翻开盒盖',
      endState: '她的手指停在盒口，眼睛睁大，呼吸停住',
      dialogue: '',
      sound: '纸盒被打开的轻响，压缩机嗡鸣继续',
      mood: '不安',
      transition: '硬切',
      sceneSlug: 'item-1',
      characterSlugs: ['item-1'],
      activeLockLabels: ['店员围裙', '皮筋扎发'],
      activeVariantLabels: ['翻开盒盖·睁大眼睛'],
      offscreenCharacters: [],
      sourceSceneIndex: 0,
    },
    {
      duration: 4,
      shotSize: 'full',
      cameraPosition: '店内看向门口',
      cameraMove: 'pull-out',
      startState:
        '小满站在收银台后抬起头，画面左侧是整排冰柜的白光，右侧收银台上的小收银机亮着红字，尽头落地窗外是青蓝色街灯',
      action: '她抬头望向门口',
      endState: '她保持着抬头的姿势，风铃在画框右上角晃动',
      dialogue: '',
      sound: '门口风铃响起',
      mood: '惊觉',
      transition: '闪白',
      sceneSlug: 'item-1',
      characterSlugs: ['item-1'],
      activeLockLabels: ['店员围裙', '皮筋扎发', '冰柜与收银台的位置'],
      offscreenCharacters: ['神秘顾客'],
      sourceSceneIndex: 1,
    },
  ],
});

/** 一个按顺序吐出三段 JSON 的假模型服务端 */
function mockModelServer(): { fetchImpl: typeof fetch; calls: string[] } {
  const queue = [STORY_JSON, ASSETS_JSON, SHOTS_JSON];
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(String(init.body));
    const content = queue.shift() ?? '{}';
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function ctxOf(fetchImpl: typeof fetch): GenerateContext {
  return { profile: llm, apiKey: 'sk-test', model: 'deepseek-chat', fetchImpl, maxAttempts: 2 };
}

// ---------------------------------------------------------------------------

describe('全链路：从一句话想法到一份可下载的方案', () => {
  it('走完故事 → 角色场景 → 分镜 → 检查 → 提示词 → 导出，且引用闭环', async () => {
    const { fetchImpl, calls } = mockModelServer();
    const ctx = ctxOf(fetchImpl);

    // ---- 起点：一个空项目，用户只给了主题 ----
    let project: Project = makeEmptyProject('便利店之夜');
    project = { ...project, brief: { ...project.brief, targetDuration: 14, aspectRatio: '9:16' } };
    project = { ...project, story: { ...project.story, source: 'generated', theme: '深夜便利店的一盒怪牛奶' } };

    // ---- 第一步：生成故事 ----
    const storyOutcome = await generateStory(project, ctx);
    expect(storyOutcome.ok).toBe(true);
    project = { ...project, story: storyFromGenerated(storyOutcome.data!, project.story) };
    expect(project.story.scenes).toHaveLength(2);

    // ---- 第二步：生成角色与场景 ----
    const assetsOutcome = await generateAssets(project, ctx);
    expect(assetsOutcome.ok).toBe(true);
    const mapping = assetsFromGenerated(assetsOutcome.data!);
    project = { ...project, characters: mapping.characters, scenes: mapping.scenes };
    expect(project.characters).toHaveLength(1);
    expect(project.scenes).toHaveLength(1);

    // ---- 第三步：生成分镜 ----
    const shotsOutcome = await generateShots(project, ctx);
    expect(shotsOutcome.ok).toBe(true);

    const reverseMapping = {
      characters: project.characters,
      scenes: project.scenes,
      characterIdBySlug: new Map(project.characters.map((c, i) => [`item-${i + 1}`, c.id] as const)),
      sceneIdBySlug: new Map(project.scenes.map((s, i) => [`item-${i + 1}`, s.id] as const)),
      lockIdByLabel: new Map([
        ...project.characters.flatMap((c) => c.continuityLocks.map((l) => [l.label, l.id] as const)),
        ...project.scenes.flatMap((s) => s.continuityLocks.map((l) => [l.label, l.id] as const)),
      ]),
      lockIdByPhrase: new Map([
        ...project.characters.flatMap((c) => c.continuityLocks.map((l) => [l.phrase, l.id] as const)),
        ...project.scenes.flatMap((s) => s.continuityLocks.map((l) => [l.phrase, l.id] as const)),
      ]),
      variantIdByLabel: new Map([
        ...project.characters.flatMap((c) => c.variants.map((v) => [v.label, v.id] as const)),
        ...project.scenes.flatMap((s) => s.variants.map((v) => [v.label, v.id] as const)),
      ]),
    };

    const { shots, warnings } = shotsFromGenerated(
      shotsOutcome.data!,
      reverseMapping,
      project.story.scenes.map((s) => ({ id: s.id })),
    );
    project = { ...project, shots };

    // 三次调用，三次都只发一次请求（没有触发重试）
    expect(calls).toHaveLength(3);
    expect(storyOutcome.attempts).toBe(1);
    expect(assetsOutcome.attempts).toBe(1);
    expect(shotsOutcome.attempts).toBe(1);

    // 引用里不该有「对不上」的（那是模型抄错了名字）；
    // 但「自动补上漏勾的锁」是系统的有意行为，会出现
    expect(warnings.filter((w) => w.includes('对不上'))).toEqual([]);

    // 每个镜头都挂上了真实存在的场景与角色
    for (const shot of project.shots) {
      expect(project.scenes.some((s) => s.id === shot.sceneId)).toBe(true);
      expect(shot.characterIds.length).toBeGreaterThan(0);
      expect(project.characters.some((c) => c.id === shot.characterIds[0])).toBe(true);
      expect(shot.activeLockIds.length).toBeGreaterThan(0);
    }

    // 镜号连续、场次都被覆盖
    expect(project.shots.map((s) => s.number)).toEqual([1, 2, 3, 4]);
    const coveredSceneIds = new Set(project.shots.map((s) => s.sourceSceneId));
    expect(coveredSceneIds.size).toBe(2);

    // ---- 变体闭环：模型声明的变体被真的挂到镜头上，并且回填了生效镜头 ----
    const variant = project.characters[0]!.variants[0]!;
    const shotWithVariant = project.shots.find((s) => s.variantIds.includes(variant.id));
    expect(shotWithVariant).toBeDefined();
    expect(variant.shotIds).toContain(shotWithVariant!.id);

    // ---- 第四步：穿帮检查 ----
    const report = runChecks(project);
    // 生成的内容应当是干净的：没有「必须修」级别的问题
    expect(report.counts.error).toBe(0);
    // 也不该出现引用类问题
    const referenceRules = [
      'scene-not-registered',
      'character-not-registered',
      'character-missing-lock',
      'variant-not-owned',
      'story-scene-uncovered',
      'shot-incomplete',
    ];
    for (const rule of referenceRules) {
      expect(report.issues.filter((i) => i.ruleId === rule)).toEqual([]);
    }

    // ---- 第五步：提示词 ----
    const firstShot = project.shots[0]!;
    const prompt = buildShotPrompt(project, firstShot, 'jimeng');
    // 连续性锁的锁面被原样注入
    for (const lock of project.characters[0]!.continuityLocks) {
      if (firstShot.activeLockIds.includes(lock.id)) {
        expect(prompt.en).toContain(lock.phrase);
      }
    }
    // 场景的固定元素也进了正文
    expect(prompt.en).toContain('glass freezer doors');
    // 中文对照与逐项说明都在
    expect(prompt.zh).toContain('【锁定】');
    expect(prompt.notes.length).toBeGreaterThan(3);

    // ---- 第六步：导出 ----
    const entries = buildExportManifest(project, report);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('分镜表.csv');
    expect(paths).toContain('角色设定卡.md');
    expect(paths).toContain('场景设定卡.md');
    expect(paths).toContain('穿帮检查单.md');
    expect(paths).toContain('拍摄进度表.md');
    expect(paths).toContain('项目数据.json');
    expect(paths.some((p) => p.startsWith('提示词/'))).toBe(true);

    // zip 能真的解开，且内容可读
    const zipped = buildZip(entries);
    const unzipped = unzipSync(zipped);
    const board = strFromU8(unzipped['分镜表.md']!);
    expect(board).toContain('便利店之夜');
    expect(board).toContain('第 4 镜');

    const progress = strFromU8(unzipped['拍摄进度表.md']!);
    expect(progress).toContain('- [ ] 生成关键帧图');

    // 导出的项目数据可以再导入回来
    const restored = JSON.parse(strFromU8(unzipped['项目数据.json']!)) as Project;
    expect(restored.shots).toHaveLength(4);
    expect(restored.characters[0]?.continuityLocks).toHaveLength(2);

    const promptFile = entries.find((e) => e.path.startsWith('提示词/'))!;
    expect(promptFile.content).toContain('英文正文');
    expect(promptFile.content).toContain('中文对照');
    expect(promptFile.content).toContain('为什么这么写');
  });

  it('模型第一次输出坏结构时，整条链路仍然能走通（自动重试）', async () => {
    const queue = ['这不是 JSON', STORY_JSON, ASSETS_JSON, SHOTS_JSON];
    const fetchImpl = (async () => {
      const content = queue.shift() ?? '{}';
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const ctx = ctxOf(fetchImpl);
    const project = makeEmptyProject('重试场景');
    const outcome = await generateStory(project, ctx);

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(2);
    expect(outcome.warnings[0]).toContain('已自动重试');
  });

  it('模型两次都输出坏结构时，用户拿到的是可执行的下一步，不是空白', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '我不会' } }] }),
      }) as unknown as Response) as unknown as typeof fetch;

    const outcome = await generateStory(makeEmptyProject('失败场景'), ctxOf(fetchImpl));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
    // 失败必须可解释：error 是给用户看的，detail 是给开发者看的
    expect(outcome.error!.length).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// v0.28：不完整数据不能把页面弄崩
// ---------------------------------------------------------------------------

describe('健壮性 · 残缺项目不该让检查页崩掉', () => {
  it('**story 存在但 story.scenes 不是数组时，导入被明确拒绝**', async () => {
    // 实测过的崩溃：这种情况会让 runChecks 抛
    // `project.story.scenes is not iterable` —— 整个穿帮检查页白屏。
    const { parseImportedProject } = await import('../src/services/storage');
    const broken = JSON.stringify({
      id: 'p',
      name: 'x',
      brief: {},
      story: { body: 'x' }, // 没有 scenes
      shots: [],
      characters: [],
      scenes: [],
    });
    // 缺 scenes 属于「可选字段缺失」→ 归一化补齐，允许导入
    const ok = parseImportedProject(broken);
    expect(ok.ok).toBe(true);
    expect(Array.isArray(ok.project!.story.scenes)).toBe(true);

    // 但 scenes 存在却写成了对象 → 结构不对，明确拒绝
    const wrong = JSON.stringify({
      id: 'p',
      name: 'x',
      brief: {},
      story: { scenes: { not: 'an array' } },
      shots: [],
      characters: [],
      scenes: [],
    });
    const rejected = parseImportedProject(wrong);
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain('story.scenes');
  });

  it('容器字段不是数组时导入被拒绝', async () => {
    const { parseImportedProject } = await import('../src/services/storage');
    for (const key of ['shots', 'characters', 'scenes']) {
      const payload: Record<string, unknown> = {
        id: 'p',
        name: 'x',
        brief: {},
        story: {},
        shots: [],
        characters: [],
        scenes: [],
      };
      payload[key] = { not: 'an array' };
      const result = parseImportedProject(JSON.stringify(payload));
      expect(result.ok, `${key} 非数组时应被拒绝`).toBe(false);
      expect(result.error).toContain(key);
    }
  });

  it('**normalizeProject 补齐缺失的容器字段**', async () => {
    const { normalizeProject } = await import('../src/services/storage');
    const fixed = normalizeProject({ id: 'p', name: 'x' });
    expect(fixed.story.scenes).toEqual([]);
    expect(fixed.characters).toEqual([]);
    expect(fixed.scenes).toEqual([]);
    expect(fixed.shots).toEqual([]);
    expect(fixed.brief.aspectRatio).toBe('16:9');
    expect(fixed.brief.styleTags).toEqual([]);
    expect(fixed.brief.platforms.length).toBeGreaterThan(0);
  });

  it('归一化之后，检查引擎不再崩', async () => {
    const { normalizeProject } = await import('../src/services/storage');
    const broken = {
      id: 'p',
      name: 'x',
      brief: {},
      story: {}, // 原本会让 runChecks 抛异常
      shots: [],
      characters: [],
      scenes: [],
    };
    const fixed = normalizeProject(broken);
    expect(() => runChecks(fixed)).not.toThrow();
  });

  it('归一化对完全不是对象的东西也安全', async () => {
    const { normalizeProject } = await import('../src/services/storage');
    for (const bad of [null, undefined, 42, 'string', []]) {
      expect(() => normalizeProject(bad)).not.toThrow();
      const fixed = normalizeProject(bad);
      expect(Array.isArray(fixed.shots)).toBe(true);
    }
  });

  it('归一化不修改传入的对象', async () => {
    const { normalizeProject } = await import('../src/services/storage');
    const original = { id: 'p', name: 'x', shots: [] };
    const snapshot = JSON.stringify(original);
    normalizeProject(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
