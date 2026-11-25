import type {
  Project,
  PromptLine,
  PromptNote,
  Shot,
  TargetPlatform,
  VideoMode,
  VisualBible,
} from '../../types/model';
import {
  CAMERA_MOVE_EN,
  PLATFORM_LABEL,
  SHOT_SIZE_EN,
  SHOT_SIZE_LABEL,
} from '../../types/model';
import {
  SHOT_RENDER_ENGINE_LABEL,
  makeDefaultVisualBible,
} from '../pipeline/profiles';
import {
  ModelExclusionAdapter,
  computeTailFrameOffsetSec,
  sanitizeExplainerSafetyTerms,
} from './modelExclusion';

/**
 * 策略模式提示词编译器簇（Phase 4 · 第五层防呆）
 *
 * PromptCompilerFactory.get(mode):
 * - narrative -> NarrativePromptCompiler（保留既有短剧编译逻辑）
 * - scenic    -> ScenicPromptCompiler（视觉圣经常量块 + 10 槽位自然摄影 + 模型感知去人化）
 * - explainer -> ExplainerPromptCompiler（风格预设铁律 + 视觉隐喻 + @motif + 敏感词清洗）
 */

export interface ShotPromptCompiler {
  mode: VideoMode;
  compile(project: Project, shot: Shot, platform: TargetPlatform): PromptLine;
}

export type NarrativeLegacyCompilerFn = (
  project: Project,
  shot: Shot,
  platform: TargetPlatform,
) => PromptLine;

function formatVisualBibleConstant(bible: VisualBible): string {
  return [
    bible.styleAnchor,
    bible.colorPalette.length > 0 ? `color palette: ${bible.colorPalette.join(', ')}` : '',
    bible.lightingDirection ? `fixed lighting: ${bible.lightingDirection}` : '',
    bible.lensAndFramingRule,
    bible.atmosphereOrMotifRules,
    bible.styleExclusionRule,
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

export class ScenicPromptCompiler implements ShotPromptCompiler {
  readonly mode: VideoMode = 'scenic';

  compile(project: Project, shot: Shot, platform: TargetPlatform): PromptLine {
    const bible = project.visualBible ?? makeDefaultVisualBible('scenic');
    const bibleConstant = formatVisualBibleConstant(bible);
    const scene = project.scenes.find((s) => s.id === shot.sceneId);
    const envSummary = scene
      ? [scene.identity.summaryEn || scene.name, scene.fixedElements.join(', ')]
          .filter(Boolean)
          .join(', ')
      : '';

    const shotSizeEn = SHOT_SIZE_EN[shot.shotSize];
    const cameraMoveEn = CAMERA_MOVE_EN[shot.cameraMove];
    const cameraPos = (shot.cameraPosition ?? '').trim();
    const assetTags = (shot.referencedAssetTags ?? []).filter(Boolean);
    const tailOffsetSec = computeTailFrameOffsetSec(shot.duration);

    // 10 槽位自然风光摄影提示词（严格屏蔽任何角色槽位）
    const rawPositive = [
      bibleConstant,
      envSummary,
      assetTags.length > 0 ? `Environment reference: ${assetTags.join(' ')}` : '',
      shot.startState.trim(),
      shot.action.trim(),
      shot.endState.trim(),
      `${shotSizeEn}, ${cameraMoveEn}${cameraPos ? `, ${cameraPos}` : ''}`,
      shot.sound.trim() ? `ambient soundscape: ${shot.sound.trim()}` : '',
      ...project.brief.styleTags,
      project.brief.aspectRatio ? `${project.brief.aspectRatio} aspect ratio` : '',
    ]
      .filter((part) => part.trim().length > 0)
      .join(', ');

    const adapted = ModelExclusionAdapter.adapt({
      platform,
      positivePrompt: rawPositive,
      baseNegativePrompt: project.brief.negativePrompt,
      exclusionMode: 'strict_dehumanize',
    });

    const zhLines = [
      `【模式】自然风光无角色模式（scenic）`,
      `【视觉圣经常量】${bibleConstant || '默认自然纪录片质感'}`,
      envSummary ? `【宏观环境】${scene?.name ?? ''}` : '',
      `【镜头】${SHOT_SIZE_LABEL[shot.shotSize]}，${shot.duration} 秒${cameraPos ? `，${cameraPos}` : ''}`,
      shot.startState ? `【自然主体起点】${shot.startState}` : '',
      shot.action ? `【物理与环境运动】${shot.action}` : '',
      shot.endState ? `【画面终点】${shot.endState}` : '',
      shot.sound ? `【原生环境音景】${shot.sound}` : '',
      shot.continuityMode === 'prev_tail_frame_offset'
        ? `【衔接接力】前移尾帧抽帧（建议取 ${tailOffsetSec}s 处清晰帧）`
        : '',
      adapted.negativePrompt
        ? `【模型原生负向词】${adapted.negativePrompt}`
        : `【去人化策略】${PLATFORM_LABEL[platform]} 不使用否定句式，已改为正向无人环境表述`,
      `【目标平台】${PLATFORM_LABEL[platform]}`,
    ].filter(Boolean);

    const notes: PromptNote[] = [
      {
        fragment: bibleConstant,
        label: '视觉圣经常量块',
        reason: '同场景全部镜头逐字复用同一份摄影质感、色板、光源方向与 50mm+ 中焦约束，防止光影与色温漂移。',
      },
      {
        fragment: `${shotSizeEn}, ${cameraMoveEn}`,
        label: '纪录片景别与运镜',
        reason: '明确物理机位与运动轨迹，避免模型随机推拉。',
      },
      {
        fragment:
          adapted.usedStrategy === 'native_negative'
            ? adapted.negativePrompt
            : 'uninhabited untouched natural landscape',
        label: '模型感知去人化',
        reason:
          adapted.usedStrategy === 'native_negative'
            ? `${PLATFORM_LABEL[platform]} 支持原生负向词，已下发精简去人化名词列表并排除与正向词冲突的项。`
            : `${PLATFORM_LABEL[platform]} 排斥否定句式，已剥离 "no people" 并以正向无人景观描述替代。`,
      },
    ];

    return {
      en: adapted.positivePrompt,
      zh: zhLines.join('\n'),
      notes,
      negative: adapted.negativePrompt,
    };
  }
}

export class ExplainerPromptCompiler implements ShotPromptCompiler {
  readonly mode: VideoMode = 'explainer';

  compile(project: Project, shot: Shot, platform: TargetPlatform): PromptLine {
    const bible = project.visualBible ?? makeDefaultVisualBible('explainer');
    const bibleConstant = formatVisualBibleConstant(bible);
    const engine = shot.renderEngine ?? 'ai_ref_to_video';
    const motifTags = (shot.referencedAssetTags ?? []).filter(Boolean);
    const labels = (shot.onScreenLabels ?? []).filter(Boolean);
    const hostChars = project.enableVirtualHost
      ? project.characters.filter((c) => shot.characterIds.includes(c.id))
      : [];
    const hostDesc = hostChars.map((c) => c.identity.summaryEn || c.name).join(', ');

    const rawPositive = sanitizeExplainerSafetyTerms(
      [
        bibleConstant,
        hostDesc,
        motifTags.length > 0 ? `Visual motifs: ${motifTags.join(' ')}` : '',
        shot.visualMetaphor ? `visual metaphor: ${shot.visualMetaphor}` : '',
        shot.startState.trim(),
        shot.action.trim(),
        shot.endState.trim(),
        labels.length > 0 ? `minimal on-screen labels: ${labels.join(' | ')}` : '',
        `${SHOT_SIZE_EN[shot.shotSize]}, ${CAMERA_MOVE_EN[shot.cameraMove]}`,
        ...project.brief.styleTags,
        project.brief.aspectRatio ? `${project.brief.aspectRatio} aspect ratio` : '',
      ]
        .filter((part) => part.trim().length > 0)
        .join(', '),
    );

    const adapted = ModelExclusionAdapter.adapt({
      platform,
      positivePrompt: rawPositive,
      baseNegativePrompt: project.brief.negativePrompt,
      exclusionMode: 'subject_driven',
    });

    const timeRangeText = shot.narrationTimeRangeSec
      ? `${shot.narrationTimeRangeSec[0]}s - ${shot.narrationTimeRangeSec[1]}s`
      : `${shot.duration}s`;

    const zhLines = [
      `【模式】科普解说模式（explainer）`,
      `【风格预设铁律】${bible.styleExclusionRule || bible.styleAnchor}`,
      `【渲染引擎】${SHOT_RENDER_ENGINE_LABEL[engine]}`,
      shot.narrationText ? `【旁白时间轴 (${timeRangeText})】${shot.narrationText}` : '',
      shot.visualMetaphor ? `【视觉隐喻】${shot.visualMetaphor}` : '',
      motifTags.length > 0 ? `【视觉母题】${motifTags.join(' ')}` : '',
      labels.length > 0 ? `【屏幕标注】${labels.join(' / ')}` : '',
      shot.codeRenderSpec ? `【代码渲染指令】${shot.codeRenderSpec}` : '',
      `【画面起点】${shot.startState}`,
      `【概念动效】${shot.action}`,
      `【目标平台】${PLATFORM_LABEL[platform]}`,
    ].filter(Boolean);

    const notes: PromptNote[] = [
      {
        fragment: bible.styleExclusionRule || bible.styleAnchor,
        label: '风格预设锁定',
        reason: '用统一插画或拼贴风格替代物理场景，保持全片几十个概念镜头的视觉连贯。',
      },
      ...(shot.visualMetaphor
        ? [
            {
              fragment: shot.visualMetaphor,
              label: '抽象概念视觉隐喻',
              reason: '将抽象解说词转译为可绘制的物理类比，避免空洞画面。',
            },
          ]
        : []),
      {
        fragment: SHOT_RENDER_ENGINE_LABEL[engine],
        label: '混合渲染路由',
        reason:
          engine === 'html_hyperframes' || engine === 'manim'
            ? '数据图表与公式镜头已标记为确定性代码渲染，预留 HyperFrames / Manim 接口透传 codeRenderSpec。'
            : '视觉隐喻镜头走 AI 图形动效或参考图生视频渲染。',
      },
    ];

    return {
      en: adapted.positivePrompt,
      zh: zhLines.join('\n'),
      notes,
      negative: adapted.negativePrompt,
    };
  }
}

export class NarrativePromptCompiler implements ShotPromptCompiler {
  readonly mode: VideoMode = 'narrative';
  private readonly legacyFn: NarrativeLegacyCompilerFn;

  constructor(legacyFn: NarrativeLegacyCompilerFn) {
    this.legacyFn = legacyFn;
  }

  compile(project: Project, shot: Shot, platform: TargetPlatform): PromptLine {
    return this.legacyFn(project, shot, platform);
  }
}

export class PromptCompilerFactory {
  private static narrativeCompiler: NarrativePromptCompiler | null = null;
  private static readonly scenicCompiler = new ScenicPromptCompiler();
  private static readonly explainerCompiler = new ExplainerPromptCompiler();

  static registerNarrative(fn: NarrativeLegacyCompilerFn): void {
    this.narrativeCompiler = new NarrativePromptCompiler(fn);
  }

  static get(mode: VideoMode): ShotPromptCompiler {
    if (mode === 'scenic') return this.scenicCompiler;
    if (mode === 'explainer') return this.explainerCompiler;
    if (!this.narrativeCompiler) {
      throw new Error('NarrativePromptCompiler is not registered.');
    }
    return this.narrativeCompiler;
  }
}
