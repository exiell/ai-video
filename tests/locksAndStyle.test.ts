import { describe, expect, it } from 'vitest';
import { resolveLockReference, shotsFromGenerated, assetsFromGenerated } from '../src/services/llm/mapping';
import { buildShotsMessages, buildAssetsMessages } from '../src/services/llm/generate';
import { buildCharacterSheetPrompt, buildScenePlatePrompt, buildKeyframePrompt } from '../src/domain/image/prompts';
import { matchStylePreset, STYLE_PRESETS } from '../src/domain/help/stylePresets';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 用户实测反馈的三个问题的回归测试：
 *
 *  1. 28 处「引用了不存在的连续性锁」——模型回抄的是锁面，而索引只按 label 建
 *  2. 不会自动勾选连续性锁
 *  3. 中文风格描述（styleTone）从来没有传给模型
 */

// ---------------------------------------------------------------------------
// 1. 锁引用解析
// ---------------------------------------------------------------------------

describe('锁引用解析 · label 与 phrase 都要认', () => {
  const mapping = assetsFromGenerated({
    characters: [
      {
        slug: 'puppy',
        name: '小狗',
        role: 'protagonist',
        identity: {
          face: '',
          hair: '',
          bodyType: '',
          ageRange: '',
          summary: '一只瘦小的白狗',
          summaryEn: 'a scrawny white puppy',
        },
        continuityLocks: [
          { label: '白色短毛', phrase: 'a scrawny white puppy with short white fur', appliesTo: 'look' },
          { label: '黑色纽扣鼻', phrase: 'a black button nose', appliesTo: 'look' },
        ],
        variants: [{ label: '浑身湿透', changedFeatures: ['毛发贴在一起'] }],
      },
    ],
    scenes: [
      {
        slug: 'kitchen',
        name: '厨房',
        identity: {
          placeType: '厨房',
          spatialStructure: '',
          summary: '一间厨房',
          summaryEn: 'a kitchen',
        },
        fixedElements: [],
        lightDirection: '',
        mainColor: '',
        continuityLocks: [
          { label: '料理台位置', phrase: 'white countertops along the left wall', appliesTo: 'geography' },
        ],
      },
    ],
  });

  it('按 label 能找到', () => {
    expect(resolveLockReference(mapping, '白色短毛')).toBeDefined();
  });

  it('**按锁面也能找到** —— 这正是用户报的那个问题', () => {
    // 模型回抄的是这句英文，而不是中文 label
    expect(resolveLockReference(mapping, 'a scrawny white puppy with short white fur')).toBeDefined();
    expect(resolveLockReference(mapping, 'a black button nose')).toBeDefined();
  });

  it('场景的锁同样按 label 与锁面都能找到', () => {
    expect(resolveLockReference(mapping, '料理台位置')).toBeDefined();
    expect(resolveLockReference(mapping, 'white countertops along the left wall')).toBeDefined();
  });

  it('大小写差异不算错', () => {
    expect(resolveLockReference(mapping, 'A BLACK BUTTON NOSE')).toBeDefined();
  });

  it('多余空格不算错', () => {
    expect(resolveLockReference(mapping, '  a black   button nose  ')).toBeDefined();
  });

  it('标点与空格差异不算错', () => {
    // 模型抄写时常会带上标点或多余空格
    expect(resolveLockReference(mapping, '白色短毛，')).toBeDefined();
    expect(resolveLockReference(mapping, '白色短毛。')).toBeDefined();
    expect(resolveLockReference(mapping, '白色 短毛')).toBeDefined();
    expect(resolveLockReference(mapping, '白色\u3000短毛')).toBeDefined();
    expect(resolveLockReference(mapping, 'white countertops, along the left wall')).toBeDefined();
  });

  it('真的不存在时返回 undefined', () => {
    expect(resolveLockReference(mapping, '从来没写过的锁')).toBeUndefined();
    expect(resolveLockReference(mapping, '')).toBeUndefined();
  });

  it('label 与锁面指向同一条锁时解析出同一个 id', () => {
    expect(resolveLockReference(mapping, '白色短毛')).toBe(
      resolveLockReference(mapping, 'a scrawny white puppy with short white fur'),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. 自动补齐漏勾的锁
// ---------------------------------------------------------------------------

describe('自动补齐漏勾的锁', () => {
  /** 造一个角色 + 一个场景，然后给一镜故意漏勾 */
  function setup(activeLockLabels: string[]) {
    const assets = assetsFromGenerated({
      characters: [
        {
          slug: 'dog',
          name: '小狗',
          role: 'protagonist',
          identity: {
            face: '',
            hair: '',
            bodyType: '',
            ageRange: '',
            summary: '小狗',
            summaryEn: 'a puppy',
          },
          continuityLocks: [{ label: '白色短毛', phrase: 'short white fur', appliesTo: 'look' }],
          variants: [],
        },
      ],
      scenes: [
        {
          slug: 'kitchen',
          name: '厨房',
          identity: {
            placeType: '厨房',
            spatialStructure: '',
            summary: '厨房',
            summaryEn: 'a kitchen',
          },
          fixedElements: [],
          lightDirection: '',
          mainColor: '',
          continuityLocks: [{ label: '料理台', phrase: 'white countertops', appliesTo: 'geography' }],
        },
      ],
    });

    return {
      assets,
      result: shotsFromGenerated(
        {
          shots: [
            {
              duration: 3,
              shotSize: 'medium',
              cameraPosition: '',
              cameraMove: 'static',
              startState: '小狗站在厨房里',
              action: '它抬起头',
              endState: '它看着门口',
              dialogue: '',
              sound: '',
              mood: '',
              transition: '硬切',
              // 注意：这里要用资产生成时的**真实 slug**（dog / kitchen），
              // 而不是提示词里给模型看的 item-N —— 后者只在提示词内部有效
              sceneSlug: 'kitchen',
              characterSlugs: ['dog'],
              activeLockLabels,
              activeVariantLabels: [],
              offscreenCharacters: [],
              sourceSceneIndex: 0,
            },
          ],
        },
        assets,
        [],
      ),
    };
  }

  it('模型完全没勾时，角色锁与场景锁都被自动补上', () => {
    const { assets, result } = setup([]);
    const shot = result.shots[0]!;
    const characterLockId = assets.characters[0]!.continuityLocks[0]!.id;
    const sceneLockId = assets.scenes[0]!.continuityLocks[0]!.id;
    expect(shot.activeLockIds).toContain(characterLockId);
    expect(shot.activeLockIds).toContain(sceneLockId);
    // 并且要如实告诉用户补了什么
    expect(result.warnings.some((w) => w.includes('自动补上'))).toBe(true);
  });

  it('模型只勾了一半时，另一半补上', () => {
    const { assets, result } = setup(['白色短毛']);
    const shot = result.shots[0]!;
    const characterLockId = assets.characters[0]!.continuityLocks[0]!.id;
    const sceneLockId = assets.scenes[0]!.continuityLocks[0]!.id;
    expect(shot.activeLockIds).toEqual(expect.arrayContaining([characterLockId, sceneLockId]));
    expect(shot.activeLockIds).toHaveLength(2);
  });

  it('模型勾对了时不重复添加，也不产生「自动补上」的警告', () => {
    const { result } = setup(['白色短毛', '料理台']);
    // 「白色短毛」是角色锁的 label，「料理台」是场景锁的 label——
    // 模型直接写 label 也能解析，且解析出来的正好覆盖本该补齐的两条
    expect(result.shots[0]!.activeLockIds).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('自动补上'))).toBe(false);
  });

  it('抄错名字时不再刷屏，改成一条汇总提示', () => {
    const { result } = setup(['一个根本不存在的锁']);
    // 合计两条：一条「对不上」，一条「已自动补齐」
    expect(result.warnings).toHaveLength(2);
    // 关键：不是每镜每锁各一条（那正是用户看到的 28 条刷屏）
    expect(result.warnings.filter((w) => w.includes('对不上'))).toHaveLength(1);
    expect(result.warnings.filter((w) => w.includes('自动补上'))).toHaveLength(1);
  });

  it('抄错的引用不影响锁被补齐', () => {
    const { assets, result } = setup(['编出来的锁名']);
    const shot = result.shots[0]!;
    expect(shot.activeLockIds).toContain(assets.characters[0]!.continuityLocks[0]!.id);
    expect(shot.activeLockIds).toContain(assets.scenes[0]!.continuityLocks[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// 3. 提示词呈现方式
// ---------------------------------------------------------------------------

describe('分镜提示词 · 锁的呈现不能有歧义', () => {
  it('锁以「名称=… ｜ 内容=…」三栏呈现，而不是 label("phrase")', () => {
    const all = buildShotsMessages(sampleProject)
      .map((m) => m.content)
      .join('\n');
    expect(all).toContain('名称=');
    expect(all).toContain('内容=');
    // 旧的写法会让模型去抄引号里的英文
    expect(all).not.toContain('("a worn padded cotton robe');
  });

  it('明确要求回传「名称」而不是「内容」', () => {
    const all = buildShotsMessages(sampleProject)
      .map((m) => m.content)
      .join('\n');
    expect(all).toContain('名称');
    expect(all).toContain('不要填「内容」');
  });

  it('场景的锁也一并给出（原来只给了角色的锁）', () => {
    const all = buildShotsMessages(sampleProject)
      .map((m) => m.content)
      .join('\n');
    expect(all).toContain('场景的连续性锁');
    expect(all).toContain(sampleProject.scenes[0]!.continuityLocks[0]!.label);
  });
});

// ---------------------------------------------------------------------------
// 4. 中文风格描述真正传到模型
// ---------------------------------------------------------------------------

describe('风格 · 中文原话要传给模型', () => {
  it('styleTone 出现在资产生成的提示词里（原来完全没用到）', () => {
    const all = buildAssetsMessages(sampleProject)
      .map((m) => m.content)
      .join('\n');
    expect(sampleProject.brief.styleTone.length).toBeGreaterThan(0);
    expect(all).toContain(sampleProject.brief.styleTone);
  });

  it('英文风格关键词也一并给出，让模型知道最终进提示词的是哪些词', () => {
    const all = buildAssetsMessages(sampleProject)
      .map((m) => m.content)
      .join('\n');
    for (const tag of sampleProject.brief.styleTags) {
      expect(all).toContain(tag);
    }
  });

  it('明确要求资产描述与风格一致，并给了反例', () => {
    const all = buildAssetsMessages(sampleProject)
      .map((m) => m.content)
      .join('\n');
    expect(all).toContain('风格一致性');
    expect(all).toContain('水墨写意');
  });

  it('styleTone 也出现在分镜提示词里', () => {
    const all = buildShotsMessages(sampleProject)
      .map((m) => m.content)
      .join('\n');
    expect(all).toContain(sampleProject.brief.styleTone);
  });

  it('分镜提示词里说明「风格由设置统一注入，不要重复写」', () => {
    const all = buildShotsMessages(sampleProject)
      .map((m) => m.content)
      .join('\n');
    expect(all).toContain('风格由项目设置统一注入');
  });
});

describe('风格 · 三种出图都用同一套风格词', () => {
  const project = sampleProject;

  it('角色形象图、场景板、关键帧都带上全部风格词', () => {
    const prompts = [
      buildCharacterSheetPrompt(project, 'ch-linchong', 'turnaround')!,
      buildCharacterSheetPrompt(project, 'ch-linchong', 'face')!,
      buildScenePlatePrompt(project, 'sc-temple')!,
      buildKeyframePrompt(project, 'shot-01')!,
    ];
    for (const prompt of prompts) {
      for (const tag of project.brief.styleTags) {
        expect(prompt.positive).toContain(tag);
      }
    }
  });

  it('风格词在提示词里的位置固定（在画幅之前），便于对照', () => {
    const prompt = buildKeyframePrompt(project, 'shot-01')!;
    const styleIndex = prompt.positive.indexOf(project.brief.styleTags[0]!);
    const ratioIndex = prompt.positive.indexOf(project.brief.aspectRatio);
    expect(styleIndex).toBeGreaterThan(-1);
    expect(styleIndex).toBeLessThan(ratioIndex);
  });
});

describe('风格预设', () => {
  it('每个预设都有中文名、说明与英文风格词', () => {
    expect(STYLE_PRESETS.length).toBeGreaterThanOrEqual(6);
    for (const preset of STYLE_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(10);
      expect(preset.tags.length).toBeGreaterThanOrEqual(3);
      // 英文风格词不能混中文——出图模型对英文更稳
      for (const tag of preset.tags) {
        expect(tag).toMatch(/^[\x20-\x7E]+$/);
      }
    }
  });

  it('预设 id 不重复', () => {
    const ids = STYLE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('能认出当前用的是哪个预设', () => {
    const preset = STYLE_PRESETS[0]!;
    expect(matchStylePreset([...preset.tags])?.id).toBe(preset.id);
  });

  it('示例项目的风格能匹配到「国漫武侠」', () => {
    // 示例项目的 styleTags 就是按这个预设设计的
    const matched = matchStylePreset(sampleProject.brief.styleTags);
    expect(matched).toBeDefined();
    expect(matched!.id).toBe('wuxia-ink');
  });

  it('空风格词匹配不到任何预设', () => {
    expect(matchStylePreset([])).toBeUndefined();
  });

  it('只有一两个词沾边时不算命中（避免误判）', () => {
    const preset = STYLE_PRESETS[0]!;
    expect(matchStylePreset([preset.tags[0]!])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// v0.39：同名锁不能被串到别的角色身上
// ---------------------------------------------------------------------------

describe('锁解析 · 按出场角色限定范围', () => {
  /**
   * 修的是一个静默失效：
   * 两个角色都有叫「外套」的锁时，扁平 Map 里后写的覆盖先写的，
   * 于是所有镜头引用「外套」都挂到后一个角色的锁上，前一个角色的锁从此不生效。
   * 界面上完全看不出来，只有出图时那个角色会变样。
   */
  const generated = {
    characters: [
      {
        slug: 'a',
        name: '甲',
        role: 'protagonist' as const,
        identity: { face: '', hair: '', bodyType: '', ageRange: '', summary: '', summaryEn: '' },
        continuityLocks: [
          { label: '外套', phrase: 'a red coat', appliesTo: 'look' as const },
        ],
        variants: [],
      },
      {
        slug: 'b',
        name: '乙',
        role: 'supporting' as const,
        identity: { face: '', hair: '', bodyType: '', ageRange: '', summary: '', summaryEn: '' },
        continuityLocks: [
          { label: '外套', phrase: 'a blue coat', appliesTo: 'look' as const },
        ],
        variants: [],
      },
    ],
    scenes: [],
  };

  const mapping = assetsFromGenerated(generated);
  const idA = mapping.characterIdBySlug.get('a')!;
  const idB = mapping.characterIdBySlug.get('b')!;

  it('**两个角色可以各有一条同名的锁，id 不同**', () => {
    const lockOfA = mapping.characters.find((c) => c.id === idA)!.continuityLocks[0]!;
    const lockOfB = mapping.characters.find((c) => c.id === idB)!.continuityLocks[0]!;
    expect(lockOfA.phrase).toBe('a red coat');
    expect(lockOfB.phrase).toBe('a blue coat');
    expect(lockOfA.id).not.toBe(lockOfB.id);
  });

  it('**限定范围后，解析到的是本人那条**', () => {
    // 这是修复的核心：同一个 label「外套」，在甲的镜头里必须解析成甲的锁
    expect(resolveLockReference(mapping, '外套', [idA])).toBe(
      mapping.characters.find((c) => c.id === idA)!.continuityLocks[0]!.id,
    );
    expect(resolveLockReference(mapping, '外套', [idB])).toBe(
      mapping.characters.find((c) => c.id === idB)!.continuityLocks[0]!.id,
    );
  });

  it('用锁面（phrase）也能按范围解析', () => {
    expect(resolveLockReference(mapping, 'a red coat', [idA])).toBe(
      mapping.characters.find((c) => c.id === idA)!.continuityLocks[0]!.id,
    );
  });

  it('范围里没有这条锁时退回全局匹配（不因为 scope 传错就全挂）', () => {
    // 甲的场景里引用了乙的锁名——范围里没有，但全局有，仍然解析得到
    expect(resolveLockReference(mapping, 'a blue coat', [idA])).toBeDefined();
  });

  it('不传范围时行为与旧版一致', () => {
    expect(resolveLockReference(mapping, '外套')).toBeDefined();
  });

  it('**镜头解析时自动带上它自己的出场角色**', () => {
    const { shots } = shotsFromGenerated(
      {
        shots: [
          {
            duration: 3,
            shotSize: 'medium',
            cameraPosition: '正面',
            cameraMove: 'static',
            startState: '甲站在门口',
            action: '他抬手',
            endState: '手停在半空',
            dialogue: '',
            sound: '',
            mood: '',
            transition: '',
            continuityNote: '',
            transitionType: 'cut',
            sceneSlug: '',
            characterSlugs: ['a'],
            activeLockLabels: ['外套'],
            activeVariantLabels: [],
            offscreenCharacters: [],
            sourceSceneIndex: 0,
          },
        ],
      },
      // 只给甲出镜
      { ...mapping, sceneIdBySlug: new Map() },
      [],
    );
    const lockIdOfA = mapping.characters.find((c) => c.id === idA)!.continuityLocks[0]!.id;
    expect(shots[0]!.activeLockIds).toContain(lockIdOfA);
  });
});
