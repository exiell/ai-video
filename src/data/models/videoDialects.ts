import type { TargetPlatform } from '../../types/model';

/**
 * 2026 主流视频模型提示词方言配置表（Phase 1 核心数据真源）
 *
 * 将 8 大主流视频模型家族（含通义万相 2.6 与 2.7/3.0 双版本，共 9 套预置方言 + custom 兜底）
 * 的官方提示词语法、I2V 静态剥离策略、负向词政策、多模态槽位标记、时长锁与运镜语法数据化，
 * 避免在编译逻辑里到处硬编码 if/else。
 */

export type VideoPromptMode =
  | 't2v'
  | 'i2v_motion_only'
  | 'first_last_bridge'
  | 'r2v_multimodal'
  | 'multi_shot';

export const VIDEO_PROMPT_MODE_LABEL: Record<VideoPromptMode, string> = {
  t2v: '文生视频（完整画面）',
  i2v_motion_only: '图生视频（只写动作与声音）',
  first_last_bridge: '首尾帧过渡',
  r2v_multimodal: '多参考图生视频',
  multi_shot: '多镜头打包',
};

export type NegativePromptPolicy =
  | 'native_field'     // Wan 2.5/2.6 (<=500 字符), Kling (网关支持时)
  | 'positive_rewrite' // Runway Gen-4/4.5, Veo 3.1（把排除意图正向改写进正文）
  | 'drop';            // 自定义端点无负向词时的兜底

export type ReferenceTokenStyle =
  | 'none'
  | 'at_typed_index'    // Seedance 2.0/2.5: @Image1, @Video1, @Audio1
  | 'space_typed_index' // Wan 2.7/3.0: Image 1, Video 1 (省略 first_frame)
  | 'character_index'   // Wan 2.6 R2V: character1, character2
  | 'at_element_name'   // Kling 3.0 Omni 官方: @ElementName（禁止子串碰撞）
  | 'positional_prose'; // Veo 3.1 / Vidu Q3 / Hailuo 自然职责声明

export type VideoVendorFamily =
  | 'kling'
  | 'veo'
  | 'seedance'
  | 'wan'
  | 'runway'
  | 'minimax'
  | 'sora'
  | 'vidu'
  | 'custom';

export interface VideoModelDialect {
  dialectId: string;
  label: string;
  vendorFamily: VideoVendorFamily;
  supportedModes: VideoPromptMode[];
  /** I2V 模式下是否自动剥离首帧已有的人物静态外貌与静止背景 */
  i2vStripStaticAppearance: boolean;
  negativePolicy: NegativePromptPolicy;
  negativeMaxChars?: number;
  promptMaxChars: number;
  preferredWordRange: { t2v: [number, number]; i2v: [number, number] };
  referenceTokenStyle: ReferenceTokenStyle;
  maxRefs: { images: number; videos: number; audios: number };
  /** 首尾帧（frame_images）与多参考（input_references）是否互斥（Seedance 2.0/2.5 为 true） */
  mutuallyExclusiveFirstLastAndRefs: boolean;
  supportsNativeAudio: boolean;
  /** 原生音频是否常开（Veo 3.1 为 true） */
  audioAlwaysOn?: boolean;
  dialogueFormat: 'quoted_inline' | 'kling_speaker_bracket' | 'sora_dialogue_block' | 'none';
  supportsMultiShot: boolean;
  multiShotMaxShots?: number;
  multiShotMaxTotalSec?: number;
  /** 运镜语法：自然英语 或 MiniMax 官方方括号指令 [Push in] */
  cameraSyntax: 'natural' | 'minimax_brackets';
  /** 是否自动剥离正文里误写的分辨率/画幅/时长文本（应改由 API 参数控制） */
  forbidProseParams: boolean;
  /** 特定条件下的时长硬锁（例如 Veo 3.1 带参考图或 1080p/4K 锁 8s；Hailuo 1080p 限 6s） */
  durationLocks?: {
    onRefs?: number[];
    on1080p?: number[];
    on4k?: number[];
  };
  /** MiniMax 官方精确控制开关（避免模型擅自改写方括号运镜） */
  promptOptimizerDefault?: boolean;
  /** 成本分档参考（美元/秒，仅作草稿/终渲路由推荐参考） */
  costTierHint?: { draftUsdPerSec: number; finalUsdPerSec: number };
}

export const VIDEO_MODEL_DIALECTS: Record<string, VideoModelDialect> = {
  kling_3: {
    dialectId: 'kling_3',
    label: '可灵 Kling 3.0 Omni',
    vendorFamily: 'kling',
    supportedModes: ['t2v', 'i2v_motion_only', 'first_last_bridge', 'r2v_multimodal', 'multi_shot'],
    i2vStripStaticAppearance: true,
    negativePolicy: 'native_field',
    negativeMaxChars: 500,
    promptMaxChars: 2500,
    preferredWordRange: { t2v: [45, 110], i2v: [20, 45] },
    referenceTokenStyle: 'at_element_name',
    maxRefs: { images: 9, videos: 5, audios: 1 },
    mutuallyExclusiveFirstLastAndRefs: false,
    supportsNativeAudio: true,
    dialogueFormat: 'kling_speaker_bracket',
    supportsMultiShot: true,
    multiShotMaxShots: 6,
    multiShotMaxTotalSec: 15,
    cameraSyntax: 'natural',
    forbidProseParams: true,
    costTierHint: { draftUsdPerSec: 0.08, finalUsdPerSec: 0.17 },
  },

  veo_3_1: {
    dialectId: 'veo_3_1',
    label: 'Google Veo 3.1',
    vendorFamily: 'veo',
    supportedModes: ['t2v', 'i2v_motion_only', 'first_last_bridge', 'r2v_multimodal'],
    i2vStripStaticAppearance: true,
    negativePolicy: 'positive_rewrite',
    promptMaxChars: 2000,
    preferredWordRange: { t2v: [45, 100], i2v: [20, 40] },
    referenceTokenStyle: 'positional_prose',
    maxRefs: { images: 3, videos: 0, audios: 0 },
    mutuallyExclusiveFirstLastAndRefs: false,
    supportsNativeAudio: true,
    audioAlwaysOn: true,
    dialogueFormat: 'quoted_inline',
    supportsMultiShot: false,
    cameraSyntax: 'natural',
    forbidProseParams: true,
    durationLocks: { onRefs: [8], on1080p: [8], on4k: [8] },
    costTierHint: { draftUsdPerSec: 0.12, finalUsdPerSec: 0.25 },
  },

  seedance_2_5: {
    dialectId: 'seedance_2_5',
    label: '即梦 Seedance 2.5 / 2.0',
    vendorFamily: 'seedance',
    supportedModes: ['t2v', 'i2v_motion_only', 'first_last_bridge', 'r2v_multimodal', 'multi_shot'],
    i2vStripStaticAppearance: true,
    negativePolicy: 'native_field',
    negativeMaxChars: 500,
    promptMaxChars: 3000,
    preferredWordRange: { t2v: [45, 120], i2v: [20, 45] },
    referenceTokenStyle: 'at_typed_index',
    maxRefs: { images: 30, videos: 10, audios: 10 },
    mutuallyExclusiveFirstLastAndRefs: true,
    supportsNativeAudio: true,
    dialogueFormat: 'quoted_inline',
    supportsMultiShot: true,
    multiShotMaxShots: 6,
    multiShotMaxTotalSec: 30,
    cameraSyntax: 'natural',
    forbidProseParams: true,
    costTierHint: { draftUsdPerSec: 0.08, finalUsdPerSec: 0.23 },
  },

  wan_2_6_r2v: {
    dialectId: 'wan_2_6_r2v',
    label: '通义万相 Wan 2.6 R2V',
    vendorFamily: 'wan',
    supportedModes: ['t2v', 'i2v_motion_only', 'first_last_bridge', 'r2v_multimodal'],
    i2vStripStaticAppearance: true,
    negativePolicy: 'native_field',
    negativeMaxChars: 500,
    promptMaxChars: 1500,
    preferredWordRange: { t2v: [40, 100], i2v: [20, 45] },
    referenceTokenStyle: 'character_index',
    maxRefs: { images: 3, videos: 3, audios: 1 },
    mutuallyExclusiveFirstLastAndRefs: false,
    supportsNativeAudio: true,
    dialogueFormat: 'quoted_inline',
    supportsMultiShot: false,
    cameraSyntax: 'natural',
    forbidProseParams: true,
    costTierHint: { draftUsdPerSec: 0.06, finalUsdPerSec: 0.09 },
  },

  wan_2_7_r2v: {
    dialectId: 'wan_2_7_r2v',
    label: '通义万相 Wan 2.7 / 3.0',
    vendorFamily: 'wan',
    supportedModes: ['t2v', 'i2v_motion_only', 'first_last_bridge', 'r2v_multimodal', 'multi_shot'],
    i2vStripStaticAppearance: true,
    negativePolicy: 'native_field',
    negativeMaxChars: 500,
    promptMaxChars: 2000,
    preferredWordRange: { t2v: [40, 110], i2v: [20, 45] },
    referenceTokenStyle: 'space_typed_index',
    maxRefs: { images: 5, videos: 5, audios: 2 },
    mutuallyExclusiveFirstLastAndRefs: false,
    supportsNativeAudio: true,
    dialogueFormat: 'quoted_inline',
    supportsMultiShot: true,
    multiShotMaxShots: 6,
    multiShotMaxTotalSec: 30,
    cameraSyntax: 'natural',
    forbidProseParams: true,
    costTierHint: { draftUsdPerSec: 0.06, finalUsdPerSec: 0.083 },
  },

  runway_gen4_5: {
    dialectId: 'runway_gen4_5',
    label: 'Runway Gen-4.5 / Gen-4',
    vendorFamily: 'runway',
    supportedModes: ['t2v', 'i2v_motion_only'],
    i2vStripStaticAppearance: true,
    negativePolicy: 'positive_rewrite',
    promptMaxChars: 1000,
    preferredWordRange: { t2v: [35, 80], i2v: [20, 40] },
    referenceTokenStyle: 'positional_prose',
    maxRefs: { images: 3, videos: 0, audios: 0 },
    mutuallyExclusiveFirstLastAndRefs: false,
    supportsNativeAudio: false,
    dialogueFormat: 'none',
    supportsMultiShot: false,
    cameraSyntax: 'natural',
    forbidProseParams: true,
    costTierHint: { draftUsdPerSec: 0.08, finalUsdPerSec: 0.16 },
  },

  minimax_hailuo_2_3: {
    dialectId: 'minimax_hailuo_2_3',
    label: 'MiniMax 海螺 2.3 / 02',
    vendorFamily: 'minimax',
    supportedModes: ['t2v', 'i2v_motion_only', 'first_last_bridge'],
    i2vStripStaticAppearance: true,
    negativePolicy: 'positive_rewrite',
    promptMaxChars: 2000,
    preferredWordRange: { t2v: [40, 90], i2v: [20, 40] },
    referenceTokenStyle: 'positional_prose',
    maxRefs: { images: 3, videos: 0, audios: 0 },
    mutuallyExclusiveFirstLastAndRefs: false,
    supportsNativeAudio: false,
    dialogueFormat: 'none',
    supportsMultiShot: false,
    cameraSyntax: 'minimax_brackets',
    forbidProseParams: true,
    durationLocks: { on1080p: [6] },
    promptOptimizerDefault: false,
    costTierHint: { draftUsdPerSec: 0.025, finalUsdPerSec: 0.06 },
  },

  sora_2: {
    dialectId: 'sora_2',
    label: 'OpenAI Sora 2',
    vendorFamily: 'sora',
    supportedModes: ['t2v', 'i2v_motion_only', 'multi_shot'],
    i2vStripStaticAppearance: true,
    negativePolicy: 'positive_rewrite',
    promptMaxChars: 2500,
    preferredWordRange: { t2v: [45, 110], i2v: [20, 45] },
    referenceTokenStyle: 'positional_prose',
    maxRefs: { images: 1, videos: 0, audios: 0 },
    mutuallyExclusiveFirstLastAndRefs: false,
    supportsNativeAudio: true,
    dialogueFormat: 'sora_dialogue_block',
    supportsMultiShot: true,
    multiShotMaxShots: 5,
    multiShotMaxTotalSec: 25,
    cameraSyntax: 'natural',
    forbidProseParams: true,
    costTierHint: { draftUsdPerSec: 0.1, finalUsdPerSec: 0.2 },
  },

  vidu_q3: {
    dialectId: 'vidu_q3',
    label: 'Vidu Q3 Turbo / Pro',
    vendorFamily: 'vidu',
    supportedModes: ['t2v', 'i2v_motion_only', 'first_last_bridge', 'r2v_multimodal'],
    i2vStripStaticAppearance: true,
    negativePolicy: 'native_field',
    negativeMaxChars: 400,
    promptMaxChars: 1500,
    preferredWordRange: { t2v: [40, 95], i2v: [20, 40] },
    referenceTokenStyle: 'positional_prose',
    maxRefs: { images: 7, videos: 0, audios: 1 },
    mutuallyExclusiveFirstLastAndRefs: false,
    supportsNativeAudio: true,
    dialogueFormat: 'quoted_inline',
    supportsMultiShot: false,
    cameraSyntax: 'natural',
    forbidProseParams: true,
    costTierHint: { draftUsdPerSec: 0.048, finalUsdPerSec: 0.12 },
  },

  custom: {
    dialectId: 'custom',
    label: '通用自定义视频模型',
    vendorFamily: 'custom',
    supportedModes: ['t2v', 'i2v_motion_only', 'first_last_bridge', 'r2v_multimodal'],
    i2vStripStaticAppearance: true,
    negativePolicy: 'drop',
    promptMaxChars: 2000,
    preferredWordRange: { t2v: [40, 100], i2v: [20, 45] },
    referenceTokenStyle: 'none',
    maxRefs: { images: 4, videos: 0, audios: 0 },
    mutuallyExclusiveFirstLastAndRefs: false,
    supportsNativeAudio: false,
    dialogueFormat: 'none',
    supportsMultiShot: false,
    cameraSyntax: 'natural',
    forbidProseParams: true,
  },
};

export const PRESET_VIDEO_DIALECT_IDS = [
  'kling_3',
  'veo_3_1',
  'seedance_2_5',
  'wan_2_6_r2v',
  'wan_2_7_r2v',
  'runway_gen4_5',
  'minimax_hailuo_2_3',
  'sora_2',
  'vidu_q3',
] as const;

export type PresetVideoDialectId = (typeof PRESET_VIDEO_DIALECT_IDS)[number];

/** 将现有平台枚举映射至默认视频模型方言 */
export const PLATFORM_DEFAULT_DIALECT: Record<TargetPlatform, string> = {
  jimeng: 'seedance_2_5',
  seedance: 'seedance_2_5',
  kling: 'kling_3',
  veo: 'veo_3_1',
  wan: 'wan_2_7_r2v',
  runway: 'runway_gen4_5',
  hailuo: 'minimax_hailuo_2_3',
  sora: 'sora_2',
  pika: 'custom',
};

export function resolveVideoDialect(dialectOrPlatform?: string): VideoModelDialect {
  if (!dialectOrPlatform) return VIDEO_MODEL_DIALECTS.custom!;
  const direct = VIDEO_MODEL_DIALECTS[dialectOrPlatform];
  if (direct) return direct;
  const byPlatform = PLATFORM_DEFAULT_DIALECT[dialectOrPlatform as TargetPlatform];
  if (byPlatform && VIDEO_MODEL_DIALECTS[byPlatform]) {
    return VIDEO_MODEL_DIALECTS[byPlatform]!;
  }
  return VIDEO_MODEL_DIALECTS.custom!;
}
