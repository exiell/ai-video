import { describe, expect, it } from 'vitest';
import {
  parseAssets,
  parseShots,
  parseStory,
  stripCodeFence,
} from '../src/services/llm/schemas';
import {
  assetsFromGenerated,
  shotsFromGenerated,
  storyFromGenerated,
} from '../src/services/llm/mapping';
import {
  buildAssetsMessages,
  buildShotsMessages,
  buildStoryMessages,
  describeFailure,
  generateAssets,
  generateShots,
  generateStory,
  type GenerateContext,
} from '../src/services/llm/generate';
import { MODEL_PROFILES } from '../src/data/models/profiles';
import { sampleProject } from '../src/data/samples/sampleProject';
import { runChecks } from '../src/domain/checks';

const llm = MODEL_PROFILES.find((p) => p.type === 'llm')!;

function ctx(fetchImpl: typeof fetch, maxAttempts = 2): GenerateContext {
  return {
    profile: llm,
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    fetchImpl,
    maxAttempts,
  };
}

/** 造一个「模型返回指定 content」的假 fetch */
function chatFetch(...contents: string[]): typeof fetch {
  let call = 0;
  return (async () => {
    const content = contents[Math.min(call, contents.length - 1)] ?? '';
    call += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------

describe('输出清洗', () => {
  it('剥掉 ```json 围栏', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('剥掉没有语言标记的围栏', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('从解释文字里抠出 JSON', () => {
    expect(stripCodeFence('好的，这是结果：{"a":1} 希望有帮助')).toBe('{"a":1}');
  });
  it('没有 JSON 时原样返回', () => {
    expect(stripCodeFence('抱歉，我无法完成')).toBe('抱歉，我无法完成');
  });
});

describe('故事解析', () => {
  const valid = JSON.stringify({
    body: '一个故事',
    charactersNote: '两个人物',
    setting: '某地',
    conflict: '冲突',
    ending: '结局',
    scenes: [{ label: '第一场', summary: '开场' }],
  });

  it('合法 JSON 解析成功', () => {
    const result = parseStory(valid);
    expect(result.ok).toBe(true);
    expect(result.data?.scenes).toHaveLength(1);
  });

  it('带围栏的输出也能解析', () => {
    expect(parseStory('```json\n' + valid + '\n```').ok).toBe(true);
  });

  it('空输出给出人话原因', () => {
    const result = parseStory('');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有返回任何内容');
  });

  it('模型完全没用 JSON 回答时，指出的是「找不到 JSON 对象」', () => {
    // 输入里连花括号都没有，所以这属于「压根没按格式回答」，
    // 而不是「JSON 写坏了」。两者给用户的下一步不同：
    // 前者是催模型按格式回答或换模型，后者是考虑长度上限被截断。
    const result = parseStory('我觉得这个故事应该这样写：从前有座山');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有按 JSON 格式回答');
    expect(result.error).toContain('找不到 JSON 对象');
    expect(result.detail).toContain('自然语言');
  });

  it('JSON 残缺时，指出的是「不是合法 JSON」并提示可能被截断', () => {
    const result = parseStory('{"body":"从前有座山","scenes":[{"label":"第一场"');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不是合法 JSON');
    expect(result.error).toContain('截断');
  });

  it('字段类型不对时指出具体字段', () => {
    const result = parseStory(JSON.stringify({ body: 123 }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('结构不对');
  });

  it('缺失的可选字段会被补上默认值，而不是解析失败', () => {
    const result = parseStory(JSON.stringify({ body: '只有正文' }));
    expect(result.ok).toBe(true);
    expect(result.data?.scenes).toEqual([]);
    expect(result.data?.setting).toBe('');
  });
});

describe('角色与场景解析', () => {
  const valid = JSON.stringify({
    characters: [
      {
        slug: 'lin-chong',
        name: '林冲',
        role: 'protagonist',
        identity: { summaryEn: 'Lin Chong, a lean tall warrior' },
        continuityLocks: [
          { label: '旧棉袍', phrase: 'a worn padded cotton robe', appliesTo: 'look' },
        ],
      },
    ],
    scenes: [
      {
        slug: 'temple',
        name: '山神庙',
        identity: { summaryEn: 'a derelict mountain shrine' },
        fixedElements: ['weathered double wooden door'],
        lightDirection: '夜晚，冷调',
        mainColor: '冷灰蓝',
      },
    ],
  });

  it('解析成功且默认值生效', () => {
    const result = parseAssets(valid);
    expect(result.ok).toBe(true);
    expect(result.data?.characters[0]?.role).toBe('protagonist');
    expect(result.data?.characters[0]?.variants).toEqual([]);
    expect(result.data?.scenes[0]?.fixedElements).toHaveLength(1);
  });

  it('slug 里出现中文时拒绝，并说明原因', () => {
    const bad = JSON.parse(valid);
    bad.characters[0].slug = '林冲';
    const result = parseAssets(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('slug');
  });

  it('缺少英文描述时拒绝（英文描述是提示词的必需品）', () => {
    const bad = JSON.parse(valid);
    delete bad.characters[0].identity.summaryEn;
    expect(parseAssets(JSON.stringify(bad)).ok).toBe(false);
  });
});

describe('分镜解析', () => {
  const valid = JSON.stringify({
    shots: [
      {
        duration: 3,
        shotSize: 'medium',
        cameraMove: 'push-in',
        startState: '起点',
        action: '动作',
        endState: '终点',
        sceneSlug: 'temple',
        characterSlugs: ['lin-chong'],
        activeLockLabels: ['旧棉袍'],
        sourceSceneIndex: 0,
      },
    ],
  });

  it('解析成功', () => {
    const result = parseShots(valid);
    expect(result.ok).toBe(true);
    expect(result.data?.shots[0]?.cameraMove).toBe('push-in');
  });

  it('枚举值非法时拒绝，并指出是哪个字段', () => {
    const bad = JSON.parse(valid);
    bad.shots[0].shotSize = '超远景';
    const result = parseShots(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('shotSize');
  });

  it('空镜头数组被拒绝（不允许空表）', () => {
    expect(parseShots(JSON.stringify({ shots: [] })).ok).toBe(false);
  });

  it('时长为字符串数字时能自动转成数字', () => {
    const loose = JSON.parse(valid);
    loose.shots[0].duration = '3';
    const result = parseShots(JSON.stringify(loose));
    expect(result.ok).toBe(true);
    expect(result.data?.shots[0]?.duration).toBe(3);
  });

  it('负数时长被拒绝', () => {
    const bad = JSON.parse(valid);
    bad.shots[0].duration = -1;
    expect(parseShots(JSON.stringify(bad)).ok).toBe(false);
  });
});

describe('映射到领域对象', () => {
  it('故事映射保留原 id，并给场次分配新 id', () => {
    const story = storyFromGenerated(
      {
        body: '正文',
        charactersNote: '',
        setting: '',
        conflict: '',
        ending: '',
        scenes: [{ label: '第一场', summary: '' }],
      },
      sampleProject.story,
    );
    expect(story.id).toBe(sampleProject.story.id);
    expect(story.source).toBe('generated');
    expect(story.scenes[0]?.id).toMatch(/^ss-/);
  });

  it('角色与场景映射建立 slug → id 索引，锁也建索引', () => {
    const mapping = assetsFromGenerated({
      characters: [
        {
          slug: 'a',
          name: '甲',
          role: 'protagonist',
          identity: {
            face: '',
            hair: '',
            bodyType: '',
            ageRange: '',
            summary: '',
            summaryEn: 'A',
          },
          continuityLocks: [{ label: '外套', phrase: 'a coat', appliesTo: 'look' }],
          variants: [{ label: '湿透', changedFeatures: ['湿了'] }],
        },
      ],
      scenes: [
        {
          slug: 'room',
          name: '房间',
          identity: { placeType: '', spatialStructure: '', summary: '', summaryEn: 'a room' },
          fixedElements: [],
          lightDirection: '',
          mainColor: '',
          continuityLocks: [],
        },
      ],
    });
    expect(mapping.characterIdBySlug.get('a')).toMatch(/^ch-/);
    expect(mapping.sceneIdBySlug.get('room')).toMatch(/^sc-/);
    expect(mapping.lockIdByLabel.get('外套')).toMatch(/^lock-/);
    expect(mapping.characters[0]?.variants[0]?.shotIds).toEqual([]);
  });

  it('分镜映射补齐镜号，并如实报告不存在的引用', () => {
    const mapping = assetsFromGenerated({
      characters: [],
      scenes: [
        {
          slug: 'room',
          name: '房间',
          identity: { placeType: '', spatialStructure: '', summary: '', summaryEn: 'a room' },
          fixedElements: [],
          lightDirection: '',
          mainColor: '',
          continuityLocks: [],
        },
      ],
    });

    const result = shotsFromGenerated(
      {
        shots: [
          {
            duration: 3,
            shotSize: 'medium',
            cameraPosition: '',
            cameraMove: 'static',
            startState: '起点',
            action: '动作',
            endState: '终点',
            dialogue: '',
            sound: '',
            mood: '',
            transition: '硬切',
            sceneSlug: 'room',
            characterSlugs: ['ghost'],
            activeLockLabels: ['不存在的锁'],
            activeVariantLabels: [],
            offscreenCharacters: [],
            sourceSceneIndex: 0,
          },
        ],
      },
      mapping,
      [{ id: 'ss-1' }],
    );

    expect(result.shots[0]?.number).toBe(1);
    expect(result.shots[0]?.sceneId).toMatch(/^sc-/);
    expect(result.shots[0]?.sourceSceneId).toBe('ss-1');
    // 不存在的角色与锁不进入引用，但要如实告诉用户
    expect(result.shots[0]?.characterIds).toEqual([]);
    expect(result.shots[0]?.activeLockIds).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('ghost');
  });
});

describe('提示词构造', () => {
  it('故事提示词包含平台规格与 JSON 结构说明', () => {
    const messages = buildStoryMessages(sampleProject);
    const all = messages.map((m) => m.content).join('\n');
    expect(all).toContain('只输出一个 JSON 对象');
    expect(all).toContain('"scenes"');
    expect(all).toContain('16:9');
  });

  it('设定提示词把「身份 vs 变体」与「连续性锁」的写法讲清楚', () => {
    const all = buildAssetsMessages(sampleProject).map((m) => m.content).join('\n');
    expect(all).toContain('连续性锁');
    expect(all).toContain('能原样贴进提示词');
    expect(all).toContain('固定元素');
  });

  it('分镜提示词把六条铁律都写进去', () => {
    const all = buildShotsMessages(sampleProject).map((m) => m.content).join('\n');
    expect(all).toContain('一镜一动作');
    expect(all).toContain('起点只写起点');
    expect(all).toContain('必须声明连续性锁');
    expect(all).toContain('场次要覆盖');
  });

  it('分镜提示词把项目里的场景与角色 slug 喂给模型', () => {
    const all = buildShotsMessages(sampleProject).map((m) => m.content).join('\n');
    expect(all).toContain('item-1');
    expect(all).toContain('山神庙');
    expect(all).toContain('林冲');
    // 锁的 label 与锁面都要给出，模型才能原样回抄
    expect(all).toContain('旧棉袍');
    expect(all).toContain(sampleProject.characters[0]!.continuityLocks[1]!.phrase);
  });

  it('故事场次按 index 给出，供 sourceSceneIndex 引用', () => {
    const all = buildShotsMessages(sampleProject).map((m) => m.content).join('\n');
    expect(all).toContain('index 0');
  });
});

describe('生成编排 · 成功与重试', () => {
  const validStory = JSON.stringify({
    body: '正文',
    charactersNote: '',
    setting: '',
    conflict: '',
    ending: '',
    scenes: [],
  });

  it('一次成功时 attempts 为 1', async () => {
    const outcome = await generateStory(sampleProject, ctx(chatFetch(validStory)));
    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(1);
    expect(outcome.warnings).toEqual([]);
  });

  it('第一次结构不对时自动重试，第二次成功', async () => {
    const fetchImpl = chatFetch('这不是 JSON', validStory);
    const outcome = await generateStory(sampleProject, ctx(fetchImpl));
    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(2);
    expect(outcome.warnings[0]).toContain('已自动重试');
  });

  it('两次都失败时如实报告，并保留失败原因', async () => {
    const outcome = await generateStory(sampleProject, ctx(chatFetch('坏', '还是坏')));
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(2);
    expect(outcome.error).toBeTruthy();
  });

  it('重试时会把失败原因回灌给模型', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(String(init.body));
      const content = calls.length === 1 ? '坏输出' : validStory;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await generateStory(sampleProject, ctx(fetchImpl));
    expect(calls).toHaveLength(2);
    // 第二次请求里应当带上「你上一次的输出有问题」
    expect(calls[1]).toContain('上一次的输出有问题');
  });

  it('请求本身失败（跨域 / 401）时不重试，直接返回原因', async () => {
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const outcome = await generateStory(sampleProject, ctx(failing));
    expect(outcome.ok).toBe(false);
    expect(calls).toBe(1);
    expect(outcome.detail).toContain('测试连接');
  });

  it('maxAttempts 可配置为 1，此时不重试', async () => {
    const outcome = await generateStory(sampleProject, ctx(chatFetch('坏'), 1));
    expect(outcome.attempts).toBe(1);
  });

  it('引用了不存在的变体时如实报告，而不是静默丢弃', () => {
    const mapping = {
      characters: sampleProject.characters,
      scenes: sampleProject.scenes,
      characterIdBySlug: new Map<string, string>(),
      sceneIdBySlug: new Map<string, string>(),
      lockIdByLabel: new Map<string, string>(),
      lockIdByPhrase: new Map(),
      variantIdByLabel: new Map<string, string>(),
    };
    const result = shotsFromGenerated(
      {
        shots: [
          {
            duration: 3,
            shotSize: 'medium',
            cameraPosition: '',
            cameraMove: 'static',
            startState: '起点',
            action: '动作',
            endState: '终点',
            dialogue: '',
            sound: '',
            mood: '',
            transition: '硬切',
            sceneSlug: 'x',
            characterSlugs: [],
            activeLockLabels: [],
            activeVariantLabels: ['编出来的变体'],
            offscreenCharacters: [],
            sourceSceneIndex: 0,
          },
        ],
      },
      mapping,
      [],
    );
    expect(result.shots[0]?.variantIds).toEqual([]);
    expect(result.warnings.some((w) => w.includes('编出来的变体'))).toBe(true);
  });

  it('失败文案必须给出下一步动作，不能只说「失败」', () => {
    const text = describeFailure({ ok: false, attempts: 2, warnings: [], error: '结构不对' });
    expect(text).toContain('再点一次');
    expect(text).toContain('手动填写');
    expect(text).toContain('示例项目');
  });
});

describe('生成编排 · 资产与分镜', () => {
  it('资产生成解析成功后能直接映射出可用的角色与场景', async () => {
    const payload = JSON.stringify({
      characters: [
        {
          slug: 'hero',
          name: '主角',
          role: 'protagonist',
          identity: { summaryEn: 'A hero in a red coat' },
          continuityLocks: [{ label: '红外套', phrase: 'a red coat', appliesTo: 'look' }],
        },
      ],
      scenes: [
        {
          slug: 'street',
          name: '街道',
          identity: { summaryEn: 'a rainy street at night' },
          fixedElements: ['wet asphalt'],
          lightDirection: '夜晚，冷调',
          mainColor: '青灰',
        },
      ],
    });
    const outcome = await generateAssets(sampleProject, ctx(chatFetch(payload)));
    expect(outcome.ok).toBe(true);
    const mapping = assetsFromGenerated(outcome.data!);
    expect(mapping.characters[0]?.name).toBe('主角');
    expect(mapping.scenes[0]?.fixedElements).toEqual(['wet asphalt']);
  });

  it('生成出来的分镜能通过穿帮检查（引用闭环）', async () => {
    const payload = JSON.stringify({
      shots: [
        {
          duration: 3,
          shotSize: 'medium',
          cameraPosition: '',
          cameraMove: 'push-in',
          startState: '他站在雪地里，肩上落满雪',
          action: '他缓缓转头',
          endState: '他的视线定在断梁上',
          dialogue: '',
          sound: '风声',
          mood: '警觉',
          transition: '硬切',
          sceneSlug: 'item-1',
          characterSlugs: ['item-1'],
          activeLockLabels: ['林冲 · 旧棉袍'],
          activeVariantLabels: [],
          offscreenCharacters: [],
          sourceSceneIndex: 0,
        },
      ],
    });

    const outcome = await generateShots(sampleProject, ctx(chatFetch(payload)));
    expect(outcome.ok).toBe(true);

    // 用示例项目现成的角色/场景来承接 slug（item-1 对应第一项）
    const mapping = {
      characters: sampleProject.characters,
      scenes: sampleProject.scenes,
      characterIdBySlug: new Map([[ 'item-1', sampleProject.characters[0]!.id ]]),
      sceneIdBySlug: new Map([[ 'item-1', sampleProject.scenes[0]!.id ]]),
      lockIdByLabel: new Map(
        sampleProject.characters.flatMap((c) => c.continuityLocks.map((l) => [l.label, l.id] as const)),
      ),
      lockIdByPhrase: new Map(
        sampleProject.characters.flatMap((c) => c.continuityLocks.map((l) => [l.phrase, l.id] as const)),
      ),
      variantIdByLabel: new Map(
        sampleProject.characters.flatMap((c) => c.variants.map((v) => [v.label, v.id] as const)),
      ),
    };

    const { shots, warnings } = shotsFromGenerated(
      outcome.data!,
      mapping,
      sampleProject.story.scenes,
    );
    // 模型没勾锁，系统会自动补上——这是有意行为，但必须如实报告
    expect(warnings.every((w) => w.includes('自动补上'))).toBe(true);
    expect(shots[0]?.sceneId).toBe(sampleProject.scenes[0]!.id);
    expect(shots[0]?.characterIds).toEqual([sampleProject.characters[0]!.id]);
    expect(shots[0]?.activeLockIds).toContain(sampleProject.characters[0]!.continuityLocks[1]!.id);

    // 引用闭环后，穿帮检查对这条镜头不应报「未登记场景 / 缺锁」
    const project = { ...sampleProject, shots };
    const issues = runChecks(project).issues.filter(
      (i) => i.location.id === shots[0]!.id,
    );
    expect(issues.some((i) => i.ruleId === 'scene-not-registered')).toBe(false);
    expect(issues.some((i) => i.ruleId === 'character-missing-lock')).toBe(false);
  });
});
