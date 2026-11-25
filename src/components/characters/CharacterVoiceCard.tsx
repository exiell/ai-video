import {
  AUDIO_LANGUAGE_LABEL,
  type AudioLanguage,
  type CharacterCard,
  type VoiceProfile,
} from '../../types/model';
import { Field } from '../bits';

const LANGUAGE_OPTIONS = Object.entries(AUDIO_LANGUAGE_LABEL) as [AudioLanguage, string][];

/**
 * 角色音色与参考音频配置（Phase 2 · 折叠模块，不增加主卡片视觉噪音）
 */
export function CharacterVoiceCard({
  character,
  onChange,
}: {
  character: CharacterCard;
  onChange: (next: CharacterCard) => void;
}) {
  const voice: VoiceProfile = character.voiceProfile ?? {
    language: 'zh',
    timbreNote: '',
  };

  function patchVoice(patch: Partial<VoiceProfile>) {
    const merged: VoiceProfile = { ...voice, ...patch };
    const isEmpty =
      !merged.timbreNote.trim() &&
      !merged.dialectOrAccent?.trim() &&
      !merged.referenceVoiceUrl?.trim() &&
      !merged.voiceId?.trim() &&
      merged.language === 'zh';
    if (isEmpty) {
      const { voiceProfile: _omit, ...rest } = character;
      void _omit;
      onChange(rest);
      return;
    }
    onChange({ ...character, voiceProfile: merged });
  }

  const hasConflict = Boolean(voice.referenceVoiceUrl?.trim() && voice.timbreNote.trim());

  return (
    <details className="card-fold" style={{ marginTop: 12 }}>
      <summary>
        <span>音色与配音档案（可选）</span>
        <span className="card-fold-count">
          {voice.referenceVoiceUrl?.trim()
            ? '已绑参考音频'
            : voice.timbreNote.trim()
              ? `${AUDIO_LANGUAGE_LABEL[voice.language]} · 已填音色`
              : '未配置'}
        </span>
      </summary>
      <div className="grid-2" style={{ marginTop: 10 }}>
        <Field label="主要语种">
          <select
            aria-label={`${character.name}的主要语种`}
            value={voice.language}
            onChange={(e) => patchVoice({ language: e.target.value as AudioLanguage })}
          >
            {LANGUAGE_OPTIONS.map(([val, label]) => (
              <option key={val} value={val}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="方言或口音（可选）" hint="例：粤语、四川话、英式口音">
          <input
            type="text"
            aria-label={`${character.name}的方言或口音`}
            value={voice.dialectOrAccent ?? ''}
            onChange={(e) => patchVoice({ dialectOrAccent: e.target.value })}
            placeholder="默认普通话 / 标准口音"
          />
        </Field>
        <Field
          label="文字音色备注"
          hint="供无参考音频时写入提示词，例：低沉克制、语速偏慢"
        >
          <input
            type="text"
            aria-label={`${character.name}的文字音色备注`}
            value={voice.timbreNote}
            onChange={(e) => patchVoice({ timbreNote: e.target.value })}
            placeholder="例：低沉稳重，带轻微沙哑感"
          />
        </Field>
        <Field
          label="参考音频链接或标识（可选）"
          hint="供可灵 Element / 万相 2.7 绑定固定音色样本"
        >
          <input
            type="text"
            aria-label={`${character.name}的参考音频链接`}
            value={voice.referenceVoiceUrl ?? ''}
            onChange={(e) => patchVoice({ referenceVoiceUrl: e.target.value })}
            placeholder="https://... 或本地音色样本路径"
          />
        </Field>
      </div>
      {hasConflict ? (
        <div className="issue warning" style={{ marginTop: 8 }}>
          <div className="issue-line">
            已同时填写参考音频和文字音色备注：编译可灵/万相提示词时会自动忽略文字音色，避免与参考音频冲突。
          </div>
        </div>
      ) : null}
    </details>
  );
}
