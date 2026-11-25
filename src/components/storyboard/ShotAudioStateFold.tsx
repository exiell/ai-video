import { useState } from 'react';
import {
  SHOT_AUDIO_MODE_LABEL,
  type EntityStateDelta,
  type Project,
  type Shot,
  type ShotAudioMode,
  type ShotAudioSpec,
  type StateDeltaEntityType,
} from '../../types/model';

/**
 * 分镜结构化音画规格、道具引用与跨镜状态变化折叠区（Phase 2）
 *
 * 收纳在分镜卡片折叠区内，保持默认界面清爽，需要时可展开精确配置：
 * - 音频模式 + 防画面烤死字幕开关 + 环境底噪与音效
 * - 本镜绑定的关键道具
 * - 显式跨镜状态变化（换装/淋湿/受伤/道具破损及剧情原因）
 */
export function ShotAudioStateFold({
  project,
  shot,
  onPatch,
}: {
  project: Project;
  shot: Shot;
  onPatch: (changes: Partial<Shot>) => void;
}) {
  const [deltaAttrKey, setDeltaAttrKey] = useState('外观变化');
  const [deltaAttrVal, setDeltaAttrVal] = useState('');
  const [deltaReason, setDeltaReason] = useState('');
  const [deltaTarget, setDeltaTarget] = useState<string>('');

  const audioSpec: ShotAudioSpec = shot.audioSpec ?? {
    mode: 'native_video_audio',
    dialogues: [],
    sfx: [],
    suppressEmbeddedSubtitles: true,
  };
  const propsList = project.props ?? [];
  const boundPropIds = shot.propIds ?? [];
  const stateDeltas = shot.stateDeltas ?? [];

  function patchAudio(patch: Partial<ShotAudioSpec>) {
    onPatch({ audioSpec: { ...audioSpec, ...patch } });
  }

  function toggleProp(propId: string) {
    const exists = boundPropIds.includes(propId);
    const next = exists
      ? boundPropIds.filter((id) => id !== propId)
      : [...boundPropIds, propId];
    onPatch({ propIds: next });
  }

  function addStateDelta() {
    const val = deltaAttrVal.trim();
    if (!val) return;
    const defaultEntityId =
      deltaTarget ||
      shot.characterIds[0] ||
      shot.sceneId ||
      boundPropIds[0] ||
      'scene-state';
    let entityType: StateDeltaEntityType = 'character';
    if (project.scenes.some((s) => s.id === defaultEntityId)) entityType = 'scene';
    else if (propsList.some((p) => p.id === defaultEntityId)) entityType = 'prop';

    const nextItem: EntityStateDelta = {
      entityType,
      entityId: defaultEntityId,
      changeableAttrs: { [deltaAttrKey.trim() || '外观变化']: val },
      reason: deltaReason.trim() || '剧情推进触发',
    };
    onPatch({ stateDeltas: [...stateDeltas, nextItem] });
    setDeltaAttrVal('');
    setDeltaReason('');
  }

  function removeDelta(index: number) {
    onPatch({ stateDeltas: stateDeltas.filter((_, i) => i !== index) });
  }

  const summaryBits = [
    shot.audioSpec ? SHOT_AUDIO_MODE_LABEL[shot.audioSpec.mode] : '',
    boundPropIds.length > 0 ? `${boundPropIds.length} 道具` : '',
    stateDeltas.length > 0 ? `${stateDeltas.length} 条状态变化` : '',
  ].filter(Boolean);

  return (
    <details className="card-fold shot-extras-fold" style={{ marginTop: 8 }}>
      <summary>
        <span>音画配置 · 关键道具 · 跨镜状态变化</span>
        <span className="card-fold-count">
          {summaryBits.length > 0 ? summaryBits.join(' / ') : '选填'}
        </span>
      </summary>
      <div className="shot-extras-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="grid-2">
          <div>
            <div className="field-label">本镜音频工作流</div>
            <select
              aria-label={`第 ${shot.number} 镜的音频工作流`}
              value={audioSpec.mode}
              onChange={(e) => patchAudio({ mode: e.target.value as ShotAudioMode })}
            >
              {(Object.entries(SHOT_AUDIO_MODE_LABEL) as [ShotAudioMode, string][]).map(
                ([val, label]) => (
                  <option key={val} value={val}>
                    {label}
                  </option>
                ),
              )}
            </select>
          </div>
          <div>
            <div className="field-label">防画面烤死乱码字幕</div>
            <label className="row" style={{ gap: 6, marginTop: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={audioSpec.suppressEmbeddedSubtitles}
                onChange={(e) => patchAudio({ suppressEmbeddedSubtitles: e.target.checked })}
              />
              <span>在原生音画提示词末尾声明无内置字幕（推荐开启）</span>
            </label>
          </div>
          <div>
            <div className="field-label">环境底噪（可选）</div>
            <input
              type="text"
              aria-label={`第 ${shot.number} 镜的环境底噪`}
              value={audioSpec.ambience ?? ''}
              onChange={(e) => patchAudio({ ambience: e.target.value })}
              placeholder="例：细雨拍打窗玻璃声"
            />
          </div>
          <div>
            <div className="field-label">动作音效（顿号或逗号分隔）</div>
            <input
              type="text"
              aria-label={`第 ${shot.number} 镜的动作音效`}
              value={audioSpec.sfx.join('、')}
              onChange={(e) =>
                patchAudio({
                  sfx: e.target.value
                    .split(/[、,，]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="例：木门吱呀推开、脚步声"
            />
          </div>
        </div>

        {propsList.length > 0 ? (
          <div>
            <div className="field-label">本镜出现的关键道具</div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              {propsList.map((prop) => {
                const checked = boundPropIds.includes(prop.id);
                return (
                  <label key={prop.id} className="tag" style={{ cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleProp(prop.id)}
                      style={{ marginRight: 4 }}
                    />
                    {prop.name}
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        <div>
          <div className="field-label">跨镜状态变化（换装 / 淋湿 / 受伤 / 道具破损）</div>
          {stateDeltas.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              {stateDeltas.map((delta, idx) => (
                <div
                  key={`${delta.entityId}-${idx}`}
                  className="row"
                  style={{
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    borderRadius: 8,
                    border: '1px solid var(--line)',
                    fontSize: 13,
                  }}
                >
                  <span>
                    {Object.entries(delta.changeableAttrs)
                      .map(([k, v]) => `${k}：${v}`)
                      .join('；')}
                    {delta.reason ? `（原因：${delta.reason}）` : ''}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeDelta(idx)}
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <select
              aria-label="状态变化关联主体"
              value={deltaTarget}
              onChange={(e) => setDeltaTarget(e.target.value)}
            >
              <option value="">自动关联本镜主体</option>
              {project.characters.map((c) => (
                <option key={c.id} value={c.id}>
                  角色：{c.name}
                </option>
              ))}
              {project.scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  场景：{s.name}
                </option>
              ))}
              {propsList.map((p) => (
                <option key={p.id} value={p.id}>
                  道具：{p.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              aria-label="变化属性名"
              style={{ maxWidth: 110 }}
              value={deltaAttrKey}
              onChange={(e) => setDeltaAttrKey(e.target.value)}
              placeholder="属性"
            />
            <input
              type="text"
              aria-label="变化后状态"
              style={{ flex: 1, minWidth: 140 }}
              value={deltaAttrVal}
              onChange={(e) => setDeltaAttrVal(e.target.value)}
              placeholder="例：风衣被暴雨淋湿"
            />
            <input
              type="text"
              aria-label="触发原因"
              style={{ flex: 1, minWidth: 130 }}
              value={deltaReason}
              onChange={(e) => setDeltaReason(e.target.value)}
              placeholder="原因（例：刚冲出雨幕）"
            />
            <button type="button" className="btn btn-sm" onClick={addStateDelta}>
              添加变化
            </button>
          </div>
        </div>
      </div>
    </details>
  );
}
