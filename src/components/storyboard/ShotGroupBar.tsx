import { useState } from 'react';
import { useAppStore } from '../../store/app';
import {
  SHOT_GROUP_STRATEGY_LABEL,
  type ShotGroup,
  type ShotGroupRenderStrategy,
} from '../../types/model';
import {
  compileShotGroupPrompt,
  suggestShotGroups,
} from '../../domain/pipeline/shotGrouping';
import { VIDEO_MODEL_DIALECTS } from '../../data/models/videoDialects';

const DIALECT_OPTIONS = Object.values(VIDEO_MODEL_DIALECTS);

/**
 * 同场次多镜头编组栏（Phase 2）
 *
 * 将同场景内连续 2–6 镜编组，支持 Kling 3.0 Multi-Shot / Seedance 2.5 时间戳分段
 * 或尾帧接力连续生成，减少正反打对话中的人脸跳变与打光色差。
 */
export function ShotGroupBar() {
  const project = useAppStore((s) => s.project);
  const patchProject = useAppStore((s) => s.patchProject);
  const [dialectId, setDialectId] = useState<string>('kling_3');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (!project || project.shots.length < 2) return null;

  const groups = project.shotGroups ?? [];

  function autoBuildGroups() {
    if (!project) return;
    const suggested = suggestShotGroups(project);
    patchProject({ shotGroups: suggested });
  }

  function updateStrategy(groupId: string, strategy: ShotGroupRenderStrategy) {
    const next: ShotGroup[] = groups.map((g) =>
      g.id === groupId ? { ...g, renderStrategy: strategy } : g,
    );
    patchProject({ shotGroups: next });
  }

  function removeGroup(groupId: string) {
    patchProject({ shotGroups: groups.filter((g) => g.id !== groupId) });
  }

  async function copyPrompt(groupId: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(groupId);
      window.setTimeout(() => setCopiedId((cur) => (cur === groupId ? null : cur)), 1800);
    } catch {
      // 忽略剪贴板权限受限
    }
  }

  return (
    <details className="card-fold" style={{ marginBottom: 14 }}>
      <summary>
        <span>同场次多镜头编组（Multi-Shot / 尾帧接力）</span>
        <span className="card-fold-count">
          {groups.length > 0 ? `${groups.length} 组` : '未编组'}
        </span>
      </summary>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <span className="muted" style={{ fontSize: 13 }}>
            把同场景内 2–6 个连续对话或承接镜头打包编译，可减少换镜跳脸与色差。
          </span>
          <div className="row" style={{ gap: 8 }}>
            <select
              aria-label="多镜头编组目标模型方言"
              value={dialectId}
              onChange={(e) => setDialectId(e.target.value)}
            >
              {DIALECT_OPTIONS.map((d) => (
                <option key={d.dialectId} value={d.dialectId}>
                  {d.label}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-sm btn-primary" onClick={autoBuildGroups}>
              按同场次自动编组
            </button>
          </div>
        </div>

        {groups.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            点击「按同场次自动编组」后，系统会识别同场景内连续对白或承接镜头并生成分组。
          </p>
        ) : (
          groups.map((group) => {
            const compiled = compileShotGroupPrompt(project, group, dialectId);
            return (
              <div
                key={group.id}
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: 10,
                  background: 'var(--bg-elev)',
                }}
              >
                <div
                  className="row"
                  style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}
                >
                  <div>
                    <b>{group.title}</b>
                    <span className="tag" style={{ marginLeft: 8 }}>
                      {compiled.shotCount} 镜 · {compiled.totalDurationSec} 秒
                    </span>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <select
                      aria-label={`${group.title}的生成策略`}
                      value={group.renderStrategy}
                      onChange={(e) =>
                        updateStrategy(group.id, e.target.value as ShotGroupRenderStrategy)
                      }
                    >
                      {(
                        Object.entries(SHOT_GROUP_STRATEGY_LABEL) as [
                          ShotGroupRenderStrategy,
                          string,
                        ][]
                      ).map(([val, label]) => (
                        <option key={val} value={val}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void copyPrompt(group.id, compiled.prompt)}
                    >
                      {copiedId === group.id ? '已复制' : '复制联合提示词'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => removeGroup(group.id)}
                    >
                      解散
                    </button>
                  </div>
                </div>
                {compiled.warnings.length > 0 ? (
                  <div className="issue warning" style={{ marginTop: 8 }}>
                    {compiled.warnings.map((w, idx) => (
                      <div key={idx} className="issue-line">
                        {w}
                      </div>
                    ))}
                  </div>
                ) : null}
                <pre
                  style={{
                    margin: '8px 0 0',
                    padding: 8,
                    fontSize: 12,
                    whiteSpace: 'pre-wrap',
                    background: 'var(--bg)',
                    borderRadius: 8,
                    border: '1px solid var(--line)',
                  }}
                >
                  {compiled.prompt}
                </pre>
              </div>
            );
          })
        )}
      </div>
    </details>
  );
}
