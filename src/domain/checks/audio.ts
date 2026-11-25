import type { CheckIssue, Project, Shot } from '../../types/model';

/**
 * 音画一体与配音契约检查（Phase 2 · 纯本地确定性规则）
 *
 * 1. audio-dialogue-overflow：按可配置语速估算台词耗时，超单镜时长时提前预警，
 *    避免原生带音视频模型（Kling 3.0 / Veo 3.1 / Seedance 2.5）出现语速失控、吞字或口型崩坏。
 * 2. audio-voice-timbre-conflict：角色同时绑定了参考音频（referenceVoiceUrl）与文字音色描述
 *    （timbreNote）时提醒冲突（编译期会自动抑制文字音色，但最好在角色卡里保持口径统一）。
 */

export interface AudioCheckOptions {
  /** 中文平均语速（字/秒），默认 4 字/秒 */
  zhCharsPerSec?: number;
  /** 英文平均语速（词/秒），默认 2.5 词/秒 */
  enWordsPerSec?: number;
  /** 容忍系数，默认 1.15（允许 15% 合理语速浮动） */
  toleranceRatio?: number;
}

const DEFAULT_ZH_CPS = 4;
const DEFAULT_EN_WPS = 2.5;
const DEFAULT_TOLERANCE = 1.15;

/** 估算一段中英混排台词正常语速所需秒数 */
export function estimateSpokenDurationSec(
  text: string,
  options: AudioCheckOptions = {},
): { seconds: number; cjkCount: number; latinWordCount: number } {
  const zhCps = options.zhCharsPerSec ?? DEFAULT_ZH_CPS;
  const enWps = options.enWordsPerSec ?? DEFAULT_EN_WPS;

  const cleaned = text
    .replace(/（[^）]*）|\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[，。！？、；：“”‘’,.!?;:"'—…\-]/g, ' ')
    .trim();

  const cjkMatches = cleaned.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  const latinOnly = cleaned.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').trim();
  const latinWords = latinOnly ? latinOnly.split(/\s+/).filter(Boolean) : [];
  const latinWordCount = latinWords.length;

  const seconds = cjkCount / zhCps + latinWordCount / enWps;
  return { seconds, cjkCount, latinWordCount };
}

function collectSpokenText(shot: Shot): string {
  if (shot.audioSpec) {
    if (shot.audioSpec.mode === 'silent') return '';
    return shot.audioSpec.dialogues
      .map((line) => line.text.trim())
      .filter(Boolean)
      .join(' ');
  }
  return shot.dialogue.trim();
}

export function checkAudio(project: Project, options: AudioCheckOptions = {}): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const tolerance = options.toleranceRatio ?? DEFAULT_TOLERANCE;

  // 1. 单镜台词超长检查
  for (const shot of project.shots) {
    if (!Number.isFinite(shot.duration) || shot.duration <= 0) continue;
    const spoken = collectSpokenText(shot);
    if (!spoken) continue;

    const { seconds, cjkCount, latinWordCount } = estimateSpokenDurationSec(spoken, options);
    // 过短的叹词不误报
    if (cjkCount < 8 && latinWordCount < 4) continue;

    const maxAllowedSec = shot.duration * tolerance;
    if (seconds > maxAllowedSec) {
      const estRounded = Math.round(seconds * 10) / 10;
      const suggestedChars = Math.max(4, Math.floor(shot.duration * (options.zhCharsPerSec ?? DEFAULT_ZH_CPS)));
      issues.push({
        id: `audio-overflow:${shot.id}`,
        ruleId: 'audio-dialogue-overflow',
        severity: 'warning',
        location: { kind: 'shot', id: shot.id, field: 'dialogue' },
        title: `第 ${shot.number} 镜时长 ${shot.duration} 秒，但当前台词正常语速约需 ${estRounded} 秒`,
        why: '原生音画模型在单镜台词过长时容易加速抢词、吞字或导致口型不同步。',
        suggestion: `精简台词到约 ${suggestedChars} 字以内，或拉长本镜时长，或拆成相邻两镜。`,
      });
    }
  }

  // 2. 角色参考音频与文字音色描述冲突检查
  for (const character of project.characters) {
    const vp = character.voiceProfile;
    if (!vp) continue;
    const hasRefAudio = Boolean(vp.referenceVoiceUrl?.trim());
    const hasTimbreText = Boolean(vp.timbreNote?.trim());
    if (hasRefAudio && hasTimbreText) {
      issues.push({
        id: `audio-voice-conflict:${character.id}`,
        ruleId: 'audio-voice-timbre-conflict',
        severity: 'warning',
        location: { kind: 'character', id: character.id, field: 'voiceProfile' },
        title: `角色「${character.name}」同时填了参考音频和文字音色描述`,
        why: '在可灵（Kling）和通义万相（Wan）中，参考音频与文字音色描写同时传入会让模型声线飘移；虽然编译期会自动抑制文字音色，但建议保持角色档案口径一致。',
        suggestion: '若以参考音频为准，可清空文字音色备注；若只想靠提示词控音色，则清空参考音频链接。',
      });
    }
  }

  return issues;
}
