import { describe, expect, it } from 'vitest';
import {
  extractJsonObject,
  parseModelJson,
  repairShape,
} from '../src/services/llm/robustJson';
import { parseStory, parseShots, parseAssets } from '../src/services/llm/schemas';

/**
 * 模型输出的鲁棒解析。
 *
 * 这组测试的每一条都对应一种**真实会发生的模型输出偏差**。
 * 起点是用户报的一个 bug：输入主题「一只狗在吃汉堡」后提示「格式错误」。
 */

describe('抽取 JSON 对象 · 关键场景', () => {
  it('纯 JSON 原样取出', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('前面有说明文字时也能取出', () => {
    expect(extractJsonObject('好的，这是故事：{"a":1}')).toBe('{"a":1}');
  });

  it('**后面有解释、且解释里带花括号时不会切错**（旧实现就是死在这里）', () => {
    const raw = '{"body":"一只狗在吃汉堡"} 故事接下来会发生在 {公园} 和 {厨房} 这两个地方。';
    // 旧实现用「第一个 { 到最后一个 }」，会切出 '{"body":"..."} 故事…{厨房}'
    // 那是非法 JSON，用户看到的报错就是「格式错误」
    expect(extractJsonObject(raw)).toBe('{"body":"一只狗在吃汉堡"}');
  });

  it('嵌套对象按括号配平切完整', () => {
    const raw = '{"a":{"b":{"c":1}},"d":2}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it('字符串里的花括号不会干扰配平', () => {
    const raw = '{"note":"他的台词是 {你好}","x":1}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it('字符串里的转义引号不会干扰配平', () => {
    const raw = '{"note":"他说\\"走\\"，然后 {离开了}","x":1}';
    expect(extractJsonObject(raw)).toBe(raw);
  });

  it('数组里嵌对象也能切完整', () => {
    const raw = '{"scenes":[{"label":"第一场"},{"label":"第二场"}]} 以上。';
    expect(extractJsonObject(raw)).toBe('{"scenes":[{"label":"第一场"},{"label":"第二场"}]}');
  });

  it('输出被截断时返回剩余部分，由上层报「可能被截断」而不是假装成功', () => {
    const truncated = '{"body":"一只狗在吃汉堡","scenes":[{"label":"第一场"';
    expect(extractJsonObject(truncated)).toBe(truncated);
  });

  it('没有花括号时返回 null', () => {
    expect(extractJsonObject('我无法完成这个任务')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });
});

describe('多策略解析', () => {
  it('原文可直接解析时用第一个策略', () => {
    const result = parseModelJson('{"a":1}');
    expect(result.value).toEqual({ a: 1 });
    expect(result.usedStrategy).toBe('原文直接解析');
  });

  it('带代码块围栏时剥掉围栏', () => {
    const result = parseModelJson('```json\n{"a":1}\n```');
    expect(result.value).toEqual({ a: 1 });
  });

  it('前后都有说明文字时用括号配平扫描兜底', () => {
    const result = parseModelJson('好的：{"body":"x"} 希望有帮助 {完}');
    expect(result.value).toEqual({ body: 'x' });
    expect(result.usedStrategy).toBe('括号配平扫描');
  });

  it('顶层是数组时不算成功（我们要的是对象）', () => {
    expect(parseModelJson('[1,2,3]').value).toBeUndefined();
  });

  it('空输出报 empty', () => {
    expect(parseModelJson('   ').error).toBe('empty');
  });

  it('找不到对象与对象非法要能区分，因为给用户的建议不同', () => {
    expect(parseModelJson('我直接用文字回答了').error).toBe('no-object');
    expect(parseModelJson('{"a":1').error).toBe('invalid-json');
  });
});

describe('结构修理 · 只改明确无歧义的偏差', () => {
  it('scenes 被写成字符串数组时补成对象', () => {
    const fixed = repairShape({ body: 'x', scenes: ['第一场：教室', '第二场：操场'] }) as {
      scenes: { label: string; summary: string }[];
    };
    expect(fixed.scenes[0]).toEqual({ label: '第一场：教室', summary: '' });
    expect(fixed.scenes).toHaveLength(2);
  });

  it('场次用 name 而不是 label 时也能接住', () => {
    const fixed = repairShape({ body: 'x', scenes: [{ name: '教室', description: '放学后' }] }) as {
      scenes: { label: string; summary: string }[];
    };
    expect(fixed.scenes[0]).toEqual({ label: '教室', summary: '放学后' });
  });

  it('字段名写成 story / content 时归一到 body（无歧义别名，任何 schema 都替换）', () => {
    expect((repairShape({ story: '一个故事' }) as { body: string }).body).toBe('一个故事');
    expect((repairShape({ content: '一个故事' }) as { body: string }).body).toBe('一个故事');
  });

  it('规范字段已存在时，不会被同义的别名顶替', () => {
    const fixed = repairShape({ body: '正确内容', story: '另一份内容' }) as { body: string };
    expect(fixed.body).toBe('正确内容');
  });

  it('**不声明 schema 时，有歧义的别名一律不替换**（characters 在资产里是合法字段）', () => {
    const fixed = repairShape({ characters: [{ name: 'Lin Chong' }] }) as Record<string, unknown>;
    expect(fixed.characters).toBeDefined();
    expect(fixed.charactersNote).toBeUndefined();
  });

  it('声明是故事时，characters 才被当成 charactersNote 的笔误', () => {
    const fixed = repairShape({ body: 'x', characters: '一只狗' }, 'story') as {
      charactersNote: string;
    };
    expect(fixed.charactersNote).toBe('一只狗');
  });

  it('声明是资产时，characters 是真实字段，绝不能被替换掉', () => {
    const fixed = repairShape({ characters: [{ name: 'Lin Chong' }] }, 'assets') as Record<
      string,
      unknown
    >;
    expect(Array.isArray(fixed.characters)).toBe(true);
    expect(fixed.charactersNote).toBeUndefined();
  });

  it('分镜的动作被写成数组时合并成一句话', () => {
    const fixed = repairShape(
      { shots: [{ action: ['他抬手', '他转身'], startState: 'x', endState: 'y' }] },
      'shots',
    ) as { shots: { action: string }[] };
    expect(fixed.shots[0]!.action).toBe('他抬手，他转身');
  });

  it('该是数组的字段给成字符串时包成数组', () => {
    const fixed = repairShape(
      { shots: [{ characterSlugs: 'lin-chong', activeLockLabels: '外套' }] },
      'shots',
    ) as { shots: { characterSlugs: string[]; activeLockLabels: string[] }[] };
    expect(fixed.shots[0]!.characterSlugs).toEqual(['lin-chong']);
    expect(fixed.shots[0]!.activeLockLabels).toEqual(['外套']);
  });

  it('角色没给 slug 时用 name 生成一个', () => {
    const fixed = repairShape({ characters: [{ name: 'Lin Chong' }] }, 'assets') as {
      characters: { slug: string }[];
    };
    expect(fixed.characters[0]!.slug).toBe('lin-chong');
  });

  it('中文名生成不出 slug 时不硬造，留给 schema 报错', () => {
    const fixed = repairShape({ characters: [{ name: '林冲' }] }, 'assets') as {
      characters: { slug?: string }[];
    };
    expect(fixed.characters[0]!.slug).toBeUndefined();
  });

  it('非对象输入原样返回，不抛异常', () => {
    expect(repairShape(null)).toBeNull();
    expect(repairShape([1, 2])).toEqual([1, 2]);
    expect(repairShape('字符串')).toBe('字符串');
  });
});

describe('端到端 · 用户报的那个 bug 场景', () => {
  const goodStory = {
    body: '一只橘色的狗在厨房偷吃汉堡。它咬下第一口时，主人推门进来。',
    charactersNote: '小狗：贪吃但机灵。主人：刚下班。',
    setting: '现代城市公寓的厨房，傍晚',
    conflict: '小狗能不能在主人发现前把汉堡吃完',
    ending: '主人站在门口，手里还提着外卖袋',
    scenes: [
      { label: '厨房 · 傍晚', summary: '小狗偷吃汉堡' },
      { label: '厨房门口 · 傍晚', summary: '主人推门进来' },
    ],
  };

  it('标准输出照常通过', () => {
    const result = parseStory(JSON.stringify(goodStory));
    expect(result.ok).toBe(true);
    expect(result.data?.scenes).toHaveLength(2);
  });

  it('**输出后面跟了一段带花括号的解释** —— 这一条就是旧实现会失败的情形', () => {
    const raw =
      JSON.stringify(goodStory) +
      '\n\n这个故事接下来会展开在 {厨房} 与 {客厅} 两个空间，希望对你有帮助。';
    const result = parseStory(raw);
    expect(result.ok).toBe(true);
    expect(result.data?.body).toContain('汉堡');
  });

  it('外面套了代码块也能通过', () => {
    const result = parseStory('```json\n' + JSON.stringify(goodStory) + '\n```');
    expect(result.ok).toBe(true);
  });

  it('场次被写成字符串数组时通过结构修理救回来', () => {
    const loose = { ...goodStory, scenes: ['厨房 · 傍晚', '厨房门口 · 傍晚'] };
    const result = parseStory(JSON.stringify(loose));
    expect(result.ok).toBe(true);
    expect(result.data?.scenes).toHaveLength(2);
    expect(result.data?.scenes[0]?.label).toBe('厨房 · 傍晚');
  });

  it('字段名写成 story / content 时救回来', () => {
    const { body, ...rest } = goodStory;
    void body;
    const result = parseStory(JSON.stringify({ content: goodStory.body, ...rest }));
    expect(result.ok).toBe(true);
    expect(result.data?.body).toContain('汉堡');
  });

  it('输出被截断时给出的是「被截断」的原因，不是笼统的格式错误', () => {
    const truncated = JSON.stringify(goodStory).slice(0, 120);
    const result = parseStory(truncated);
    expect(result.ok).toBe(false);
    // 成因要落在「不是合法 JSON / 被截断」上，而不是「模型没用 JSON 回答」——
    // 这两者给用户的下一步完全不同
    expect(result.error).toContain('不是合法 JSON');
    expect(result.error).toContain('截断');
    expect(result.detail).toContain('截断');
  });

  it('模型直接用自然语言回答时，提示它没按 JSON 回答', () => {
    const result = parseStory('好的，这是一个关于一只狗在吃汉堡的故事。从前有一只狗……');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有按 JSON 格式回答');
    expect(result.detail).toContain('自然语言');
  });

  it('失败时必须带回模型原文，否则用户没法反馈也没法自查', () => {
    const raw = '这是一段没有被格式化的回答 {括号}';
    const result = parseStory(raw);
    expect(result.ok).toBe(false);
    expect(result.raw).toBe(raw);
  });

  it('空输出给出的建议是「换模型或写短一些」，而不是重试', () => {
    const result = parseStory('');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('换一个模型');
  });
});

describe('端到端 · 分镜与资产也能吃到同样的鲁棒性', () => {
  const goodShots = {
    shots: [
      {
        duration: 3,
        shotSize: 'medium',
        cameraMove: 'static',
        startState: '小狗蹲在料理台前',
        action: '它咬下一口汉堡',
        endState: '它抬头看向门口',
        sceneSlug: 'kitchen',
        characterSlugs: ['dog'],
        activeLockLabels: ['橘色短毛'],
        sourceSceneIndex: 0,
      },
    ],
  };

  it('分镜输出后面带解释也能解析', () => {
    const result = parseShots(JSON.stringify(goodShots) + '\n\n以上是镜头表。');
    expect(result.ok).toBe(true);
    expect(result.data?.shots).toHaveLength(1);
  });

  it('分镜的 characterSlugs 给成字符串时包成数组', () => {
    const loose = structuredClone(goodShots);
    (loose.shots[0] as unknown as Record<string, unknown>).characterSlugs = 'dog';
    const result = parseShots(JSON.stringify(loose));
    expect(result.ok).toBe(true);
    expect(result.data?.shots[0]?.characterSlugs).toEqual(['dog']);
  });

  it('资产的固定元素给成一段话时切成数组', () => {
    const payload = {
      characters: [],
      scenes: [
        {
          slug: 'kitchen',
          name: '厨房',
          identity: { summaryEn: 'a modern apartment kitchen' },
          fixedElements: 'a white countertop; a stainless steel sink; an open hamburger box',
          lightDirection: '傍晚，暖光从窗户斜射',
          mainColor: '暖黄 + 白',
        },
      ],
    };
    const result = parseAssets(JSON.stringify(payload));
    expect(result.ok).toBe(true);
    // 一整段话会被当成一条，这已经足够让检查引擎工作了
    expect((result.data?.scenes[0]?.fixedElements ?? []).length).toBeGreaterThan(0);
  });
});
