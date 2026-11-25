import { CopyFallbackDialog } from '../components/bits';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { PLATFORM_LABEL, type TargetPlatform } from '../types/model';
import { buildAllPrompts } from '../domain/prompt';
import { compileVideoDialectPrompt } from '../domain/prompt/compilers';
import { ModelExclusionAdapter } from '../domain/prompt/modelExclusion';
import {
  PRESET_VIDEO_DIALECT_IDS,
  VIDEO_MODEL_DIALECTS,
  VIDEO_PROMPT_MODE_LABEL,
  resolveVideoDialect,
  type VideoPromptMode,
} from '../data/models/videoDialects';
import {
  ShotRendererRouter,
  type RenderTier,
} from '../domain/pipeline/shotRendererRouter';
import { resolveVideoMode, VIDEO_MODE_SHORT_LABEL } from '../domain/pipeline/profiles';

/**
 * M5 提示词适配（方案.md v0.6 §3.2 + 用户确认的第 7 条）
 *
 * 界面必须同时给三样东西：
 *  1. 英文正文 —— 直接复制去平台
 *  2. 中文对照 —— 让用户看懂自己将要生成什么
 *  3. 逐项说明 —— 每个片段为什么这么写（这是本工具的教学职能）
 *
 * 用户确认的原话：「接受（默认英文），但是要告诉用户大体内容」。
 * 所以中文对照和说明不是可选项，是必选项。
 */

export function PromptsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [params] = useSearchParams();
  const project = useAppStore((s) => s.project);
  const [platform, setPlatform] = useState<TargetPlatform | null>(null);
  const [dialectOverride, setDialectOverride] = useState<string | null>(null);
  const [promptMode, setPromptMode] = useState<VideoPromptMode>('i2v_motion_only');
  const [renderTier, setRenderTier] = useState<RenderTier>('draft');
  const [copied, setCopied] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(true);
  /** 剪贴板不可用时，把整段内容放进只读弹层，而不是 window.prompt */
  const [copyFallback, setCopyFallback] = useState<string | null>(null);

  const bundles = useMemo(() => (project ? buildAllPrompts(project) : []), [project]);

  if (!project) {
    return <div className="empty">还没有打开任何项目。先去「作品主页」新建或打开一个。</div>;
  }
  if (project.shots.length === 0) {
    return <div className="empty">还没有镜头。先去「分镜表」加上几个。</div>;
  }

  const active = platform ?? project.brief.platforms[0] ?? 'jimeng';
  const activeDialect = resolveVideoDialect(dialectOverride ?? active);
  const bundle = bundles.find((b) => b.platform === active);
  const focusShotId = params.get('shot');
  const videoMode = resolveVideoMode(project);
  const activeSupportsNegative = ModelExclusionAdapter.getCapability(active).supportsNativeNegativePrompt;

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // 剪贴板不可用（非 https 或权限被拒）时，弹只读文本框让用户手动复制
      setCopyFallback(text);
    }
  }

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? '已复制到剪贴板' : ''}
      </span>
      <CopyFallbackDialog text={copyFallback} onClose={() => setCopyFallback(null)} />
      <div className={`page-head${embedded ? ' page-head-compact' : ''}`}>
        {embedded ? (
          videoMode !== 'narrative' ? (
            <span className="tag">{VIDEO_MODE_SHORT_LABEL[videoMode]}模式提示词</span>
          ) : (
            <span />
          )
        ) : (
          <h1>
            提示词
            {videoMode !== 'narrative' ? (
              <span className="tag" style={{ marginLeft: 8, verticalAlign: 'middle' }}>
                {VIDEO_MODE_SHORT_LABEL[videoMode]}
              </span>
            ) : null}
          </h1>
        )}
        <div className="row">
          <label className="row" style={{ gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={showNotes}
              onChange={(e) => setShowNotes(e.target.checked)}
              style={{ width: 'auto' }}
            />
            显示逐项说明
          </label>
        </div>
      </div>

      <div className="steps">
        {project.brief.platforms.map((p) => (
          <button
            key={p}
            type="button"
            className={`step${p === active ? ' active' : ''}`}
            onClick={() => {
              setPlatform(p);
              setDialectOverride(null);
            }}
          >
            {PLATFORM_LABEL[p]}
          </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>视频写法：</span>
            {(['i2v_motion_only', 't2v', 'first_last_bridge', 'r2v_multimodal'] as const).map(
              (m) => (
                <button
                  key={m}
                  type="button"
                  className={`btn btn-sm${promptMode === m ? ' btn-primary' : ''}`}
                  onClick={() => setPromptMode(m)}
                >
                  {VIDEO_PROMPT_MODE_LABEL[m]}
                </button>
              ),
            )}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>档位：</span>
            <button
              type="button"
              className={`btn btn-sm${renderTier === 'draft' ? ' btn-primary' : ''}`}
              onClick={() => setRenderTier('draft')}
            >
              草稿试跑档
            </button>
            <button
              type="button"
              className={`btn btn-sm${renderTier === 'final' ? ' btn-primary' : ''}`}
              onClick={() => setRenderTier('final')}
            >
              终渲成片档
            </button>
          </div>
        </div>

        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>模型方言：</span>
          {PRESET_VIDEO_DIALECT_IDS.map((id) => {
            const d = VIDEO_MODEL_DIALECTS[id]!;
            return (
              <button
                key={id}
                type="button"
                className={`btn btn-sm${activeDialect.dialectId === id ? ' btn-primary' : ' btn-ghost'}`}
                onClick={() => setDialectOverride(id)}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </div>

      {project.brief.negativePrompt && activeSupportsNegative && videoMode === 'narrative' ? (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2 className="prompt-subtitle">负向词（所有镜头共用）</h2>
              <div className="hint">
                贴到平台的「负向词 / 不要出现」框里，<b>不要</b>混进正文。
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void copy(project.brief.negativePrompt, 'negative')}
            >
              {copied === 'negative' ? '已复制' : '复制'}
            </button>
          </div>
          <div className="prompt-text prompt-text-compact">{project.brief.negativePrompt}</div>
        </div>
      ) : null}

      {!bundle ? (
        <div className="empty">这个平台还没有提示词。去「故事」里把目标平台选上。</div>
      ) : (
        bundle.lines.map(({ shot, prompt }) => {
          const dialectCompiled = compileVideoDialectPrompt({
            project,
            shot,
            dialectIdOrPlatform: activeDialect.dialectId,
            promptMode,
          });
          const routeRec = ShotRendererRouter.recommendRoute(shot, project, renderTier);
          const displayEn = dialectCompiled.prompt || prompt.en;
          const displayNeg = dialectCompiled.negativePrompt || prompt.negative || '';
          return (
          <div
            className="card"
            key={shot.id}
            style={
              focusShotId === shot.id
                ? { borderColor: 'var(--accent)' }
                : undefined
            }
          >
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <h2 className="prompt-shot-title" style={{ margin: 0 }}>
                  第 {shot.number} 镜 · {dialectCompiled.apiHints.durationSec} 秒
                </h2>
                <span className="tag" title={routeRec.reason}>
                  推荐：{VIDEO_MODEL_DIALECTS[routeRec.recommendedDialectId]?.label ?? routeRec.recommendedDialectId}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void copy(displayEn, shot.id)}
              >
                {copied === shot.id ? '已复制' : '复制英文正文'}
              </button>
            </div>

            <div className="field-label">
              英文正文（已按 {activeDialect.label} · {VIDEO_PROMPT_MODE_LABEL[promptMode]} 编译）
            </div>
            <div className="prompt-text">{displayEn}</div>

            {dialectCompiled.warnings.length > 0 ? (
              <div className="hint" style={{ marginTop: 6 }}>
                提示：{dialectCompiled.warnings.join('；')}
              </div>
            ) : null}

            {displayNeg ? (
              <div style={{ marginTop: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                  <div className="field-label" style={{ margin: 0 }}>
                    本镜负向词（贴到平台负向词栏）
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void copy(displayNeg, `${shot.id}-neg`)}
                  >
                    {copied === `${shot.id}-neg` ? '已复制' : '复制负向词'}
                  </button>
                </div>
                <div className="prompt-text prompt-text-compact">{displayNeg}</div>
              </div>
            ) : null}

            <details className="why" open>
              <summary>中文对照（看懂要生成什么）</summary>
              <div className="why-body">
                <div className="prompt-text prompt-text-plain">
                  {dialectCompiled.zhSummary}
                  {'\n'}
                  {prompt.zh}
                </div>
              </div>
            </details>

            {showNotes && prompt.notes.length > 0 ? (
              <details className="why">
                <summary>为什么这么写（{prompt.notes.length} 项）</summary>
                <div className="why-body">
                  <table className="simple">
                    <thead>
                      <tr>
                        <th style={{ width: 160 }}>片段</th>
                        <th style={{ width: 130 }}>这是什么</th>
                        <th>为什么这么写</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prompt.notes.map((note, index) => (
                        <tr key={`${shot.id}-${index}`}>
                          <td>
                            <code>{note.fragment}</code>
                          </td>
                          <td>{note.label}</td>
                          <td style={{ color: 'var(--text-dim)' }}>{note.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}
          </div>
          );
        })
      )}
    </>
  );
}



