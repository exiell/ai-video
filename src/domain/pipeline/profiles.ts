/**
 * 多模式视频生产能力矩阵（narrative / scenic / explainer）
 *
 * 通过声明式 PipelineProfile 驱动编排器、Schema、提示词编译器与前端工作台，
 * 避免在业务代码里散落零散的 mode 判断；老项目缺失 videoMode 时统一回退 narrative。
 */

export type VideoMode = 'narrative' | 'scenic' | 'explainer';

export const VIDEO_MODES: readonly VideoMode[] = ['narrative', 'scenic', 'explainer'];

export const VIDEO_MODE_LABEL: Record<VideoMode, string> = {
  narrative: '剧情短剧',
  scenic: '自然风光（无角色）',
  explainer: '科普解说（无实景）',
};

export const VIDEO_MODE_SHORT_LABEL: Record<VideoMode, string> = {
  narrative: '剧情短剧',
  scenic: '自然风光',
  explainer: '科普解说',
};

export const VIDEO_MODE_DESC: Record<VideoMode, string> = {
  narrative: '包含人物或拟人角色互动、对白与物理场景的叙事短片。',
  scenic: '自然风光、气象演进、微观生态或建筑空镜，跳过角色提取与人物出图。',
  explainer: '知识科普、原理推演或数据解说，以连续旁白、风格预设与视觉母题驱动。',
};

export type CharacterPolicy = 'enabled' | 'disabled' | 'optional_host';

export type ScenePolicy = 'physical_locations' | 'environment_worlds' | 'abstract_canvas';

export type ShotRenderEngine =
  | 'ai_video'
  | 'ai_first_last_frame'
  | 'ai_ref_to_video'
  | 'ai_image_kenburns'
  | 'html_hyperframes'
  | 'manim';

export const SHOT_RENDER_ENGINES: readonly ShotRenderEngine[] = [
  'ai_video',
  'ai_first_last_frame',
  'ai_ref_to_video',
  'ai_image_kenburns',
  'html_hyperframes',
  'manim',
];

export const SHOT_RENDER_ENGINE_LABEL: Record<ShotRenderEngine, string> = {
  ai_video: 'AI 图生视频',
  ai_first_last_frame: '首尾帧插值视频',
  ai_ref_to_video: '参考图生视频',
  ai_image_kenburns: '静帧推拉动效',
  html_hyperframes: 'HTML 动效渲染（预留）',
  manim: 'Manim 公式渲染（预留）',
};

export type ShotContinuityMode =
  | 'cut'
  | 'prev_tail_frame_offset'
  | 'first_last_frame'
  | 'style_ref_only';

export const SHOT_CONTINUITY_MODES: readonly ShotContinuityMode[] = [
  'cut',
  'prev_tail_frame_offset',
  'first_last_frame',
  'style_ref_only',
];

export type HumanExclusionMode = 'none' | 'strict_dehumanize' | 'subject_driven';

export type ScriptStructureKind = 'dramatic_scenes' | 'visual_beats' | 'narration_chapters';

export type DefaultVideoModelTier = 'action_character' | 'long_take_scenic' | 'fast_explainer';

export type VisualAssetCategory =
  | 'character'
  | 'scene'
  | 'environment'
  | 'style_ref'
  | 'visual_motif'
  | 'diagram_card';

export const VISUAL_ASSET_CATEGORIES: readonly VisualAssetCategory[] = [
  'character',
  'scene',
  'environment',
  'style_ref',
  'visual_motif',
  'diagram_card',
];

export const VISUAL_ASSET_CATEGORY_LABEL: Record<VisualAssetCategory, string> = {
  character: '角色',
  scene: '物理场景',
  environment: '宏观环境',
  style_ref: '风格参考',
  visual_motif: '视觉母题',
  diagram_card: '信息图卡',
};

export interface PipelineProfile {
  mode: VideoMode;
  characterPolicy: CharacterPolicy;
  scenePolicy: ScenePolicy;
  assetTypes: readonly VisualAssetCategory[];
  scriptStructure: ScriptStructureKind;
  audioFirstTiming: boolean;
  continuityAnchors: readonly string[];
  humanExclusionMode: HumanExclusionMode;
  defaultVideoModelTier: DefaultVideoModelTier;
  supportedRenderers: readonly ShotRenderEngine[];
}

export const PIPELINE_PROFILES: Record<VideoMode, PipelineProfile> = {
  narrative: {
    mode: 'narrative',
    characterPolicy: 'enabled',
    scenePolicy: 'physical_locations',
    assetTypes: ['character', 'scene'],
    scriptStructure: 'dramatic_scenes',
    audioFirstTiming: false,
    continuityAnchors: ['char_ref', 'scene_ref'],
    humanExclusionMode: 'none',
    defaultVideoModelTier: 'action_character',
    supportedRenderers: ['ai_video'],
  },
  scenic: {
    mode: 'scenic',
    characterPolicy: 'disabled',
    scenePolicy: 'environment_worlds',
    assetTypes: ['environment', 'style_ref'],
    scriptStructure: 'visual_beats',
    audioFirstTiming: false,
    continuityAnchors: [
      'style_bible',
      'env_ref',
      'lighting_camera_lock',
      'tail_frame_offset',
    ],
    humanExclusionMode: 'strict_dehumanize',
    defaultVideoModelTier: 'long_take_scenic',
    supportedRenderers: ['ai_video', 'ai_first_last_frame'],
  },
  explainer: {
    mode: 'explainer',
    characterPolicy: 'optional_host',
    scenePolicy: 'abstract_canvas',
    assetTypes: ['style_ref', 'visual_motif', 'diagram_card'],
    scriptStructure: 'narration_chapters',
    audioFirstTiming: true,
    continuityAnchors: ['style_preset', 'motif_manifest', 'continuous_tts'],
    humanExclusionMode: 'subject_driven',
    defaultVideoModelTier: 'fast_explainer',
    supportedRenderers: [
      'ai_ref_to_video',
      'ai_image_kenburns',
      'ai_video',
      'html_hyperframes',
      'manim',
    ],
  },
};

/** 前置意图路由输出（扁平对象，兼容全厂商 JSON Schema） */
export interface IntentRouteResult {
  mode: VideoMode;
  enableVirtualHost: boolean;
  confidence: number;
  reasoning: string;
  detectedStyleHint: string | null;
}

/** 视觉圣经 / 风格锁（scenic 与 explainer 跨镜视觉锚定核心） */
export interface VisualBible {
  /** 摄影质感或插画风格锚点，例：35mm documentary cinema, natural film grain */
  styleAnchor: string;
  /** 3–5 个锁定主色调 */
  colorPalette: string[];
  /** 固定光源方向（scenic 必填），例：low golden sunlight from upper-left */
  lightingDirection: string;
  /** 焦段与构图铁律，例：50mm+ mid-telephoto to prevent wide-angle distortion */
  lensAndFramingRule: string;
  /** 大气湿度/天气，或科普图形语汇规则 */
  atmosphereOrMotifRules: string;
  /** 正向风格铁律，例：MUST remain flat vector illustration, not photorealistic */
  styleExclusionRule: string;
}

/** 泛化视觉资产（与既有 characters / scenes 并存兼容） */
export interface VisualAsset {
  id: string;
  category: VisualAssetCategory;
  name: string;
  /** 资产引用标签，例：@alpine_valley 或 @quantum_particle */
  tag: string;
  visualPrompt: string;
  referenceImageUrls: string[];
  isImmutableAnchor: boolean;
}

export type StageRunStatus = 'pending' | 'done' | 'skipped';

export interface StageStatusMap {
  characters?: StageRunStatus;
  scenes?: StageRunStatus;
  visualBible?: StageRunStatus;
  shots?: StageRunStatus;
}

export interface ProjectModeContext {
  videoMode?: VideoMode | undefined;
  enableVirtualHost?: boolean | undefined;
}

/** 获取项目当前生效的视频模式（缺失一律回退 narrative） */
export function resolveVideoMode(project?: ProjectModeContext | null): VideoMode {
  const mode = project?.videoMode;
  if (mode === 'scenic' || mode === 'explainer' || mode === 'narrative') {
    return mode;
  }
  return 'narrative';
}

/** 获取项目当前生效的能力配置 */
export function resolvePipelineProfile(project?: ProjectModeContext | null): PipelineProfile {
  return PIPELINE_PROFILES[resolveVideoMode(project)];
}

/** 判断当前项目是否启用角色提取与角色库 */
export function isCharacterStageEnabled(project?: ProjectModeContext | null): boolean {
  const profile = resolvePipelineProfile(project);
  if (profile.characterPolicy === 'enabled') return true;
  if (profile.characterPolicy === 'optional_host') {
    return Boolean(project?.enableVirtualHost);
  }
  return false;
}

/** 判断当前项目是否启用物理场景提取与场景参考板 */
export function isPhysicalSceneStageEnabled(project?: ProjectModeContext | null): boolean {
  const profile = resolvePipelineProfile(project);
  return profile.scenePolicy !== 'abstract_canvas';
}

/** 创建一个空的视觉圣经默认值 */
export function makeDefaultVisualBible(mode: VideoMode): VisualBible {
  if (mode === 'scenic') {
    return {
      styleAnchor: '35mm documentary cinema, natural film grain, crisp natural detail',
      colorPalette: ['morning mist silver', 'pine deep green', 'warm golden rim'],
      lightingDirection: 'low golden morning sunlight from upper-left',
      lensAndFramingRule: '50mm+ mid-telephoto to prevent wide-angle distortion',
      atmosphereOrMotifRules: 'light drifting valley mist, natural atmospheric depth',
      styleExclusionRule: 'pure natural documentary photography, uninhabited landscape',
    };
  }
  if (mode === 'explainer') {
    return {
      styleAnchor: 'flat geometric vector illustration, clean shapes, no outlines',
      colorPalette: ['deep navy', 'cyan accent', 'warm amber', 'soft ivory'],
      lightingDirection: 'clean even graphic shading with subtle glow accents',
      lensAndFramingRule: 'centered clear infographic framing, generous negative space',
      atmosphereOrMotifRules: 'consistent geometric iconography, visual metaphors for abstract concepts',
      styleExclusionRule: 'MUST remain flat geometric vector illustration, not photorealistic',
    };
  }
  return {
    styleAnchor: '',
    colorPalette: [],
    lightingDirection: '',
    lensAndFramingRule: '',
    atmosphereOrMotifRules: '',
    styleExclusionRule: '',
  };
}
