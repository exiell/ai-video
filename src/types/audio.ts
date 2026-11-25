/**
 * 音画一体与结构化配音数据契约（Phase 2）
 *
 * 面向 2026 原生带音视频模型（Kling 3.0 / Veo 3.1 / Seedance 2.5 / Wan 2.7 / Sora 2）
 * 与外部 TTS / SRT 双轨后期工作流。
 * 全部通过可选字段挂载到 CharacterCard 与 Shot，确保旧项目 JSON 100% 向后兼容。
 */

export type AudioLanguage = 'zh' | 'en' | 'ja' | 'ko' | 'es' | 'auto';

export const AUDIO_LANGUAGE_LABEL: Record<AudioLanguage, string> = {
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  es: '西班牙语',
  auto: '自动识别',
};

export type DialogueDelivery = 'on_screen_lip_sync' | 'off_screen_vo' | 'inner_monologue';

export const DIALOGUE_DELIVERY_LABEL: Record<DialogueDelivery, string> = {
  on_screen_lip_sync: '出镜口型同步',
  off_screen_vo: '画外音/旁白',
  inner_monologue: '内心独白',
};

export type ShotAudioMode = 'native_video_audio' | 'external_tts_dub' | 'silent';

export const SHOT_AUDIO_MODE_LABEL: Record<ShotAudioMode, string> = {
  native_video_audio: '模型原生音画同步',
  external_tts_dub: '外部配音轨（TTS/人工）',
  silent: '纯画面无对白',
};

/** 角色音色档案（可选挂在 CharacterCard.voiceProfile） */
export interface VoiceProfile {
  /** 外部 TTS 音色 ID 或平台音色标识 */
  voiceId?: string;
  /** 角色音色样本链接或本地路径（供 Wan 2.7 reference_voice / Kling Element 使用） */
  referenceVoiceUrl?: string;
  language: AudioLanguage;
  /** 方言或口音，如 Cantonese / Sichuanese / British / 东北话 */
  dialectOrAccent?: string;
  /** 音色文字描述，如「低沉克制、语速偏慢」（已绑定 referenceVoiceUrl 时编译期自动抑制，防冲突） */
  timbreNote: string;
}

/** 单条结构化对白/旁白 */
export interface DialogueLine {
  id: string;
  /** 关联 CharacterCard.id；为空表示画外旁白 */
  speakerCharacterId?: string;
  /** 稳定说话人标签 */
  speakerLabel: string;
  /** 台词原文 */
  text: string;
  /** 情绪与语气，如「克制压抑」「急促质问」 */
  emotionTone?: string;
  delivery: DialogueDelivery;
  startOffsetSec?: number;
  endOffsetSec?: number;
}

/** 分镜音频规格（可选挂在 Shot.audioSpec） */
export interface ShotAudioSpec {
  mode: ShotAudioMode;
  dialogues: DialogueLine[];
  /** 动作与物理音效列表，如 ['木门推开吱呀声', '远处闷雷'] */
  sfx: string[];
  /** 环境底噪，如「细雨拍打玻璃环境音」 */
  ambience?: string;
  /** 背景音乐提示，如「无背景音乐」或「低频弦乐铺底」 */
  bgmCue?: string;
  /** 默认 true：在原生音画模型提示词末尾防画面烤死不可编辑字幕 */
  suppressEmbeddedSubtitles: boolean;
}
