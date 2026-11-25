import type { VideoModelDialect, VideoPromptMode } from '../../data/models/videoDialects';
import type { CameraMove, CharacterCard, Shot } from '../../types/model';
import { CAMERA_MOVE_EN } from '../../types/model';
import { formatMiniMaxCameraCommand } from './refSyntax';

/**
 * I2V 静态外观剥离与动作聚焦过滤器（Phase 1）
 *
 * 2026 主流视频模型（Runway Gen-4.5 / Kling 3.0 / Veo 3.1 / Hailuo 2.3）共识：
 * 「图像是身份契约，文本是动作与声音契约。」
 * 在图生视频（i2v_motion_only）模式下，重复描述首帧图已有的五官、服装、场景布局与光影，
 * 会加重画面僵化（Image Leakage）并诱导模型重绘人脸。
 *
 * 本纯函数负责在 I2V 模式下剥离静态描写，只保留：
 * 1. 主体动作动词（action）
 * 2. 单一主导运镜（含 MiniMax 官方方括号语法）
 * 3. 显式静止锚定（保持服装、五官与建筑结构稳定）
 * 4. 原生音频/对白指令（按方言格式）
 * 仅当显式声明有新元素入画或剧烈状态转场时，才放行增量视觉描述。
 */

export interface I2vMotionFilterInput {
  dialect: VideoModelDialect;
  mode: VideoPromptMode;
  shot: Pick<
    Shot,
    'action' | 'cameraMove' | 'cameraPosition' | 'dialogue' | 'sound' | 'endState' | 'audioSpec'
  >;
  /** 关联角色列表（用于解析结构化对白的 voiceProfile，处理音色样本与文字冲突） */
  characters?: readonly CharacterCard[];
  /** 全量 T2V 提示词（在非 I2V 或模型不剥离时原样返回） */
  fullT2vPrompt: string;
  /** 本镜静态外观/背景描述（仅作审计记录，I2V 模式下会被剥离） */
  staticDescriptions?: string[];
  /** 是否允许增量视觉描述（仅在新元素入画或大幅状态转场时开启） */
  incrementalVisualNote?: string;
  /** 是否在正文末尾追加防烤死字幕提示 */
  suppressEmbeddedSubtitles?: boolean;
  /** 说话人标签（用于 Kling 3.0 / Sora 2 对白格式化） */
  speakerLabel?: string;
}

export interface I2vMotionFilterResult {
  prompt: string;
  strippedStatic: boolean;
  strippedCount: number;
  warnings: string[];
}

export function formatShotAudioCue(args: {
  dialect: VideoModelDialect;
  shot: Pick<Shot, 'dialogue' | 'sound' | 'audioSpec'>;
  characters?: readonly CharacterCard[];
  speakerLabel?: string;
  warnings?: string[];
}): string {
  const { dialect, shot, characters, speakerLabel, warnings } = args;
  if (!dialect.supportsNativeAudio) return '';
  const parts: string[] = [];

  if (shot.audioSpec) {
    const spec = shot.audioSpec;
    if (spec.mode !== 'silent') {
      for (const line of spec.dialogues) {
        const text = line.text.trim();
        if (!text) continue;
        const char = line.speakerCharacterId
          ? characters?.find((c) => c.id === line.speakerCharacterId)
          : undefined;
        const voice = char?.voiceProfile;
        const hasVoiceBinding = Boolean(voice?.referenceVoiceUrl?.trim());
        const suppressTimbre =
          hasVoiceBinding && (dialect.vendorFamily === 'kling' || dialect.vendorFamily === 'wan');
        if (suppressTimbre && voice?.timbreNote?.trim()) {
          warnings?.push(
            `角色「${char?.name ?? line.speakerLabel}」已绑定参考音频，编译 ${dialect.label} 提示词时已自动抑制文字音色描述，防止与参考音色打架。`,
          );
        }

        const voiceTraits = [
          voice?.dialectOrAccent?.trim(),
          !suppressTimbre ? voice?.timbreNote?.trim() : '',
          line.emotionTone?.trim(),
        ].filter(Boolean);
        const traitSuffix = voiceTraits.length > 0 ? ` (${voiceTraits.join(', ')})` : '';
        const speaker = line.speakerLabel.trim() || char?.name || speakerLabel?.trim() || 'Speaker';
        const deliveryPrefix =
          line.delivery === 'off_screen_vo'
            ? 'VO '
            : line.delivery === 'inner_monologue'
              ? 'Inner monologue '
              : '';

        if (dialect.dialogueFormat === 'kling_speaker_bracket') {
          parts.push(`[${deliveryPrefix}${speaker}${traitSuffix}]: "${text}"`);
        } else if (dialect.dialogueFormat === 'sora_dialogue_block') {
          parts.push(`Dialogue — ${deliveryPrefix}${speaker}${traitSuffix}: "${text}"`);
        } else if (dialect.dialogueFormat === 'quoted_inline') {
          parts.push(`${deliveryPrefix}${speaker}${traitSuffix} speaking: "${text}"`);
        }
      }
    }

    if (spec.sfx.length > 0) {
      parts.push(`SFX: ${spec.sfx.join(', ')}`);
    }
    if (spec.ambience?.trim()) {
      parts.push(`Ambience: ${spec.ambience.trim()}`);
    }
    if (spec.bgmCue?.trim()) {
      parts.push(`BGM: ${spec.bgmCue.trim()}`);
    }
    return parts.join('. ');
  }

  const line = shot.dialogue.trim();
  if (line) {
    if (dialect.dialogueFormat === 'kling_speaker_bracket') {
      const speaker = speakerLabel?.trim() || 'Speaker';
      parts.push(`[${speaker}]: "${line}"`);
    } else if (dialect.dialogueFormat === 'sora_dialogue_block') {
      const speaker = speakerLabel?.trim() || 'SPEAKER';
      parts.push(`Dialogue — ${speaker}: "${line}"`);
    } else if (dialect.dialogueFormat === 'quoted_inline') {
      parts.push(`speaking: "${line}"`);
    }
  }
  const sfx = shot.sound.trim();
  if (sfx) {
    parts.push(`SFX: ${sfx}`);
  }
  return parts.join('. ');
}

function formatCameraClause(dialect: VideoModelDialect, move: CameraMove, position?: string): string {
  if (dialect.cameraSyntax === 'minimax_brackets') {
    return formatMiniMaxCameraCommand([move]);
  }
  const moveEn = CAMERA_MOVE_EN[move] || 'static camera';
  const pos = position?.trim();
  return pos ? `${moveEn} (${pos})` : moveEn;
}

export function filterI2vMotionPrompt(input: I2vMotionFilterInput): I2vMotionFilterResult {
  const { dialect, mode, shot } = input;
  const warnings: string[] = [];

  const shouldStrip =
    (mode === 'i2v_motion_only' || mode === 'first_last_bridge') &&
    dialect.i2vStripStaticAppearance;

  if (!shouldStrip) {
    return {
      prompt: input.fullT2vPrompt,
      strippedStatic: false,
      strippedCount: 0,
      warnings,
    };
  }

  const strippedItems = (input.staticDescriptions ?? []).filter((s) => s.trim().length > 0);
  const parts: string[] = [];

  // 1. 主体动作（I2V 核心）
  const action = shot.action.trim();
  if (action) {
    parts.push(action);
  } else {
    warnings.push('I2V 模式下动作描述为空，建议补充明确的主体动作动词。');
    parts.push('Subtle natural motion from the starting frame');
  }

  // 首尾帧过渡模式：补齐终点状态衔接
  if (mode === 'first_last_bridge' && shot.endState.trim()) {
    parts.push(`transitioning smoothly to ${shot.endState.trim()}`);
  }

  // 2. 增量视觉描述（仅在新元素入画或状态剧变时放行）
  if (input.incrementalVisualNote?.trim()) {
    parts.push(input.incrementalVisualNote.trim());
  }

  // 3. 单一主导运镜
  parts.push(formatCameraClause(dialect, shot.cameraMove, shot.cameraPosition));

  // 4. 显式静止锚定（防止首帧外观与场景结构漂移）
  parts.push('keep existing subject identity, clothing, and background structure steady');

  // 5. 原生音频与对白（仅对支持原生音频的模型输出，优先使用结构化 audioSpec）
  const audioCue = formatShotAudioCue({
    dialect,
    shot,
    ...(input.characters ? { characters: input.characters } : {}),
    ...(input.speakerLabel ? { speakerLabel: input.speakerLabel } : {}),
    warnings,
  });
  if (audioCue) {
    parts.push(audioCue);
  }

  // 6. 防画面烤死乱码字幕（尤其针对 Seedance / 原生带音模型）
  const wantSuppressSubtitles =
    shot.audioSpec !== undefined
      ? shot.audioSpec.suppressEmbeddedSubtitles
      : Boolean(input.suppressEmbeddedSubtitles);
  if (wantSuppressSubtitles && dialect.supportsNativeAudio) {
    parts.push('No subtitles.');
  }

  return {
    prompt: parts.filter(Boolean).join('. ').replace(/\.\.+/g, '.'),
    strippedStatic: true,
    strippedCount: strippedItems.length,
    warnings,
  };
}
