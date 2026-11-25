import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEmptyProject, useAppStore } from '../src/store/app';
import { useGeneration } from '../src/store/generation';
import { useSettings } from '../src/store/settings';
import { normalizeProject } from '../src/services/storage';
import { routeVideoIntent } from '../src/services/llm/intentRouter';
import { sanitizeProjectAssets } from '../src/domain/pipeline/assetSanitizer';
import {
  isCharacterStageEnabled,
  isPhysicalSceneStageEnabled,
  makeDefaultVisualBible,
  resolvePipelineProfile,
  resolveVideoMode,
} from '../src/domain/pipeline/profiles';
import { buildShotPrompt } from '../src/domain/prompt';
import {
  ModelExclusionAdapter,
  computeTailFrameOffsetSec,
  sanitizeExplainerSafetyTerms,
} from '../src/domain/prompt/modelExclusion';
import { ShotRendererRouter } from '../src/domain/pipeline/shotRendererRouter';
import { runChecks } from '../src/domain/checks';
import { computeImageCoverage } from '../src/components/imageCoverage';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { CharacterCard, Project, Shot } from '../src/types/model';
import { SCHEMA_VERSION } from '../src/types/model';

function makeMockChar(id: string, name: string, form: 'human' | 'creature' | 'object' = 'object'): CharacterCard {
  const now = new Date().toISOString();
  return {
    id,
    name,
    role: 'supporting',
    identity: {
      form,
      species: name,
      face: '',
      hair: '',
      bodyType: '',
      ageRange: '',
      summary: name,
      summaryEn: name,
    },
    variants: [],
    continuityLocks: [],
    shotIds: [],
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
  };
}

function makeMockShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    number: 1,
    duration: 5,
    shotSize: 'wide',
    cameraPosition: '50mm 中焦，低角度贴近青苔岩石',
    cameraMove: 'push-in',
    startState: '清晨阿尔卑斯山谷，露珠水滴挂在松针尖端，金色光线穿透薄雾',
    action: '露珠从松针缓缓滑落到青苔岩石表面，溅起细微水雾，松针随之轻颤',
    endState: '水珠在青苔上散开，晨光在湿润岩石表面折射出暖金高光',
    dialogue: '',
    sound: '清脆露珠滴落声、松林微风与远山溪流回响',
    mood: '清冽晨光',
    transition: '平滑衔接',
    sceneId: '',
    characterIds: [],
    variantIds: [],
    activeLockIds: [],
    offscreenCharacters: [],
    sourceSceneId: '',
    ...overrides,
  };
}

describe('多模式视频生产架构（TC-01 ~ TC-05）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useGeneration.setState({ pending: null, feedback: {}, pipeline: null });
  });

  it('TC-01 纯风光防幽灵角色：路由为 scenic、物理跳过角色提取且不含水滴/光线/岩石角色', async () => {
    const prompt = '清晨阿尔卑斯山谷，露珠水滴从松针滑落到青苔岩石上，金色光线穿透薄雾';
    const route = await routeVideoIntent(prompt);

    expect(route.mode).toBe('scenic');
    expect(route.enableVirtualHost).toBe(false);

    const project = makeEmptyProject('阿尔卑斯晨雾', { videoMode: route.mode });
    project.story.body = prompt;
    useAppStore.getState().setProject(project);

    const profile = resolvePipelineProfile(project);
    expect(profile.characterPolicy).toBe('disabled');
    expect(isCharacterStageEnabled(project)).toBe(false);

    // 模拟 LLM 结构化输出（即使下游意外塞入水滴/光线/岩石也会被守卫物理清空）
    const rogueChars = [
      makeMockChar('c-1', '水滴'),
      makeMockChar('c-2', '光线'),
      makeMockChar('c-3', '岩石'),
    ];
    const sanitized = sanitizeProjectAssets({
      project,
      characters: rogueChars,
      visualAssets: [],
      shots: [makeMockShot({ characterIds: ['c-1', 'c-2', 'c-3'] })],
      storyText: prompt,
    });

    expect(sanitized.characters).toHaveLength(0);
    expect(sanitized.shots[0]?.characterIds).toHaveLength(0);
    expect(sanitized.visualAssets.length).toBe(3);
    expect(sanitized.visualAssets.every((a) => a.category === 'environment')).toBe(true);

    // 验证编排器物理短路：在 scenic 模式下调用 runAssets 绝不发送角色提取 Schema
    const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const bodyStr = String(init?.body ?? '');
      // 断言请求体使用的是 scenic 视觉圣经 Schema，而非 narrative 角色提取
      expect(bodyStr).toContain('visualBible');
      expect(bodyStr).not.toContain('hasSentientCharacters');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  visualBible: makeDefaultVisualBible('scenic'),
                  scenes: [
                    {
                      slug: 'alpine-valley',
                      name: '阿尔卑斯清晨山谷',
                      identity: {
                        placeType: '高山峡谷',
                        spatialStructure: '前景青苔岩石与松枝，中景薄雾林谷，远景雪峰',
                        summary: '清晨薄雾中的阿尔卑斯山谷',
                        summaryEn: 'misty Alpine valley at dawn with mossy rocks and pine needles',
                      },
                      fixedElements: ['mossy granite rocks', 'pine needles with dewdrops', 'golden mist'],
                      lightDirection: 'low golden morning sunlight from upper-left',
                      mainColor: '松针深绿 + 暖金晨光',
                      continuityLocks: [],
                    },
                  ],
                  visualAssets: [
                    {
                      category: 'environment',
                      name: '阿尔卑斯山谷晨雾',
                      tag: '@alpine_valley',
                      visualPrompt: 'misty Alpine valley at dawn, 50mm documentary lens',
                      isImmutableAnchor: true,
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    useSettings.setState({
      keys: { deepseek: 'test-key', siliconflow: 'test-key' },
      prefs: {
        ...useSettings.getState().prefs,
        defaultLlmProfileId: 'deepseek-chat',
      },
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await useGeneration.getState().runAssets();
    } finally {
      globalThis.fetch = origFetch;
    }

    const updated = useAppStore.getState().project!;
    expect(updated.stageStatus?.characters).toBe('skipped');
    expect(updated.characters).toHaveLength(0);
    expect(updated.visualBible?.styleAnchor).toBeTruthy();
    expect(updated.visualBible?.lightingDirection).toBeTruthy();
    expect(updated.characters.some((c) => /水滴|光线|岩石/.test(c.name))).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('TC-02 模型感知去人化编译：Wan/Kling 输出原生短负向词，Runway Gen-4 剥离否定句并改写正向无人描述', () => {
    const project = makeEmptyProject('山谷风光', { videoMode: 'scenic' });
    project.visualBible = makeDefaultVisualBible('scenic');
    const shot = makeMockShot({
      startState: 'misty alpine pine forest, no people, golden rays through morning fog',
    });

    const wanPrompt = buildShotPrompt(project, shot, 'wan');
    const klingPrompt = buildShotPrompt(project, shot, 'kling');
    const runwayPrompt = buildShotPrompt(project, shot, 'runway');

    expect(wanPrompt.negative).toContain('people');
    expect(wanPrompt.negative).toContain('humans');
    expect(klingPrompt.negative).toContain('people');
    expect(klingPrompt.negative).toContain('humans');

    expect(runwayPrompt.en.toLowerCase()).not.toContain('no people');
    expect(runwayPrompt.en.toLowerCase()).toContain('uninhabited');
    expect(runwayPrompt.negative).toBe('');

    // 冲突检测：正向含 shadow 时负向词过滤冲突项
    const conflictCheck = ModelExclusionAdapter.adapt({
      platform: 'kling',
      positivePrompt: 'dramatic shadow across canyon walls',
      baseNegativePrompt: 'shadow, watermark',
      exclusionMode: 'strict_dehumanize',
    });
    expect(conflictCheck.negativePrompt.toLowerCase()).not.toContain('shadow');
    expect(conflictCheck.negativePrompt.toLowerCase()).toContain('people');
  });

  it('TC-03 无场景纯科普：路由为 explainer、跳过角色与物理场景、产出风格预设与视觉隐喻', async () => {
    const prompt = '3 分钟科普：为什么量子纠缠无法用于超光速通信';
    const route = await routeVideoIntent(prompt);

    expect(route.mode).toBe('explainer');
    expect(route.enableVirtualHost).toBe(false);

    const project = makeEmptyProject('量子纠缠科普', {
      videoMode: route.mode,
      enableVirtualHost: route.enableVirtualHost,
    });
    project.narrationScript = '为什么相隔光年的纠缠粒子瞬间同步，却依然不能超光速传信？';
    project.stageStatus = { characters: 'skipped', scenes: 'skipped', visualBible: 'done' };
    project.visualAssets = [
      {
        id: 'va-1',
        category: 'visual_motif',
        name: '纠缠光子对',
        tag: '@quantum_pair',
        visualPrompt: 'two glowing flat-vector geometric spheres linked by a cyan dashed wave',
        referenceImageUrls: [],
        isImmutableAnchor: true,
      },
    ];
    project.shots = [
      makeMockShot({
        id: 'exp-shot-1',
        sceneId: '',
        characterIds: [],
        renderEngine: 'ai_ref_to_video',
        narrationText: '想象地球和火星上各有一只装满手套的盒子，打开一只就知道另一只。',
        narrationTimeRangeSec: [0, 6],
        visualMetaphor: 'flat geometric vector illustration comparing two glowing gift boxes on Earth and Mars',
        onScreenLabels: ['No FTL Signal'],
        referencedAssetTags: ['@quantum_pair'],
      }),
    ];

    expect(isCharacterStageEnabled(project)).toBe(false);
    expect(isPhysicalSceneStageEnabled(project)).toBe(false);
    expect(project.characters).toHaveLength(0);
    expect(project.scenes).toHaveLength(0);
    expect(project.visualBible?.styleAnchor).toContain('flat geometric vector');

    const compiled = buildShotPrompt(project, project.shots[0]!, 'veo');
    expect(compiled.en).toContain('flat geometric vector');
    expect(compiled.en).toContain('@quantum_pair');
    expect(compiled.zh).toContain('视觉隐喻');

    // 无物理场景的科普项目不应因 sceneId 为空报必改错
    const report = runChecks(project);
    expect(report.issues.some((i) => i.ruleId === 'scene-not-registered')).toBe(false);

    // 图库覆盖度不应被 characters.length === 0 或 scenes.length === 0 阻断
    const coverage = computeImageCoverage(project, { 'exp-shot-1': [] });
    expect(coverage.referencesReady).toBe(true);
  });

  it('TC-04 科普可选虚拟讲解员：最多 1 个主持人，误标为角色的光子/粒子被自动降级为 visual_motif', () => {
    const project = makeEmptyProject('量子纠缠（带讲解员）', {
      videoMode: 'explainer',
      enableVirtualHost: true,
    });
    expect(isCharacterStageEnabled(project)).toBe(true);

    const host = makeMockChar('ch-host', '科普小鸭', 'creature');
    const photon = makeMockChar('ch-photon', '光子', 'object');
    const particle = makeMockChar('ch-particle', '粒子', 'object');
    const extraHost = makeMockChar('ch-host-2', '第二主持人', 'human');

    const shot = makeMockShot({
      characterIds: ['ch-host', 'ch-photon', 'ch-particle', 'ch-host-2'],
    });

    const sanitized = sanitizeProjectAssets({
      project,
      characters: [host, photon, particle, extraHost],
      visualAssets: [],
      shots: [shot],
      storyText: '3 分钟科普：为什么量子纠缠无法用于超光速通信。光子与粒子表现出关联态。',
    });

    expect(sanitized.characters).toHaveLength(1);
    expect(sanitized.characters[0]?.name).toBe('科普小鸭');
    expect(sanitized.demotedAssets.map((a) => a.name)).toEqual(['光子', '粒子']);
    expect(sanitized.demotedAssets.every((a) => a.category === 'visual_motif')).toBe(true);
    expect(sanitized.shots[0]?.characterIds).toEqual(['ch-host']);
    expect(sanitized.shots[0]?.referencedAssetTags?.length).toBeGreaterThanOrEqual(2);
  });

  it('TC-05 存量剧情向后兼容：不含 videoMode 的历史项目默认解析为 narrative 且全链路兼容', () => {
    const legacyRaw = structuredClone(sampleProject) as unknown as Record<string, unknown>;
    delete legacyRaw.videoMode;
    delete legacyRaw.enableVirtualHost;

    const normalized: Project = normalizeProject(legacyRaw);
    expect(resolveVideoMode(normalized)).toBe('narrative');
    expect(isCharacterStageEnabled(normalized)).toBe(true);
    expect(isPhysicalSceneStageEnabled(normalized)).toBe(true);

    const firstShot = normalized.shots[0]!;
    const prompt = buildShotPrompt(normalized, firstShot, 'jimeng');
    expect(prompt.en.length).toBeGreaterThan(20);
    expect(prompt.zh).toContain('【场景】');
  });

  it('扩展能力：ShotRendererRouter 代码渲染路由、敏感教学词清洗与尾帧安全偏移', async () => {
    const project = makeEmptyProject('STEM 科普', { videoMode: 'explainer' });
    const formulaShot = makeMockShot({
      renderEngine: 'manim',
      codeRenderSpec: 'Render Bell inequality derivation animation',
    });

    const unmounted = await ShotRendererRouter.dispatch(project, formulaShot);
    expect(unmounted.handled).toBe(false);
    expect(unmounted.kind).toBe('unimplemented_plugin');
    expect(unmounted.codeRenderSpec).toContain('Bell inequality');

    ShotRendererRouter.registerPlugin('manim', (req) => ({
      handled: true,
      engine: req.engine,
      kind: 'code_plugin',
      message: 'Manim rendered',
      codeRenderSpec: req.codeRenderSpec,
    }));
    try {
      const mounted = await ShotRendererRouter.dispatch(project, formulaShot);
      expect(mounted.handled).toBe(true);
      expect(mounted.kind).toBe('code_plugin');
    } finally {
      ShotRendererRouter.unregisterPlugin('manim');
    }

    expect(sanitizeExplainerSafetyTerms('children in a bright classroom')).toBe(
      'students in a bright classroom',
    );
    expect(computeTailFrameOffsetSec(5, 24)).toBeLessThan(5);
    expect(computeTailFrameOffsetSec(5, 24)).toBeGreaterThanOrEqual(4.5);
  });
});
