import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { PLATFORM_LABEL, type TargetPlatform } from '../types/model';
import { buildAllPrompts } from '../domain/prompt';

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

export function PromptsPage() {
  const [params] = useSearchParams();
  const project = useAppStore((s) => s.project);
  const [platform, setPlatform] = useState<TargetPlatform | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showNotes, setShowNotes] = useState(true);

  const bundles = useMemo(() => (project ? buildAllPrompts(project) : []), [project]);

  if (!project) {
    return <div className="empty">还没有打开任何项目。先去「项目」页新建或打开一个。</div>;
  }
  if (project.shots.length === 0) {
    return <div className="empty">还没有镜头。先去「分镜表」加上几个。</div>;
  }

  const active = platform ?? project.brief.platforms[0] ?? 'jimeng';
  const bundle = bundles.find((b) => b.platform === active);
  const focusShotId = params.get('shot');

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // 剪贴板不可用（非 https 或权限被拒）时，退化为选中文本
      window.prompt('复制失败，请手动复制下面的内容：', text);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>提示词</h2>
          <p>
            正文是英文——模型对英文提示词的理解更稳。但每一镜下面都有<b>中文对照</b>和
            <b>逐项说明</b>，你能看懂自己要生成什么、每个词为什么这么写。
          </p>
        </div>
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
            onClick={() => setPlatform(p)}
          >
            {PLATFORM_LABEL[p]}
          </button>
        ))}
      </div>

      {project.brief.negativePrompt ? (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <b style={{ fontSize: 13 }}>负向词（所有镜头共用）</b>
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
          <pre style={{ marginTop: 8 }}>{project.brief.negativePrompt}</pre>
        </div>
      ) : null}

      {!bundle ? (
        <div className="empty">这个平台还没有提示词。去「引导向导」里把目标平台选上。</div>
      ) : (
        bundle.lines.map(({ shot, prompt }) => (
          <div
            className="card"
            key={shot.id}
            style={
              focusShotId === shot.id
                ? { borderColor: 'var(--accent)' }
                : undefined
            }
          >
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <b style={{ fontSize: 14 }}>
                第 {shot.number} 镜 · {shot.duration} 秒
              </b>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void copy(prompt.en, shot.id)}
              >
                {copied === shot.id ? '已复制' : '复制英文正文'}
              </button>
            </div>

            <div className="field-label">英文正文（直接粘贴到平台）</div>
            <pre>{prompt.en}</pre>

            <details className="why" open>
              <summary>中文对照（看懂要生成什么）</summary>
              <div className="why-body">
                <pre style={{ background: 'transparent', border: 'none', padding: 0 }}>
                  {prompt.zh}
                </pre>
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
        ))
      )}
    </>
  );
}
