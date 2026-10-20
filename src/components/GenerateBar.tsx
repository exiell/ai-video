import { Link } from 'react-router-dom';
import { checkLlmReadiness } from '../services/llm/readiness';
import { useGeneration, type GenerationTask } from '../store/generation';

/**
 * 生成按钮 + 结果反馈（方案.md v0.6 §3.2 M1/M2）
 *
 * 三件事必须做到，否则新手会卡在这里：
 *  1. 没配好 Key 时**不是**把按钮灰掉就完事，要说清楚去哪个页面做什么
 *  2. 生成中要能看出在跑（否则用户会连点）
 *  3. 失败时给的不是错误码，是「再点一次 / 手动填写」两条出路
 */
export function GenerateBar({
  task,
  label,
  hint,
}: {
  task: GenerationTask;
  label: string;
  hint?: string;
}) {
  const readiness = checkLlmReadiness();
  const pending = useGeneration((s) => s.pending);
  const feedback = useGeneration((s) => s.feedback[task]);
  const runStory = useGeneration((s) => s.runStory);
  const runAssets = useGeneration((s) => s.runAssets);
  const runShots = useGeneration((s) => s.runShots);

  const busy = pending === task;
  const blockedByOther = pending !== null && pending !== task;

  function run() {
    if (task === 'story') void runStory();
    else if (task === 'assets') void runAssets();
    else void runShots();
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div className="row">
        <button
          type="button"
          className="btn btn-blue"
          disabled={busy || blockedByOther || !readiness.ready}
          onClick={run}
        >
          {busy ? '生成中…' : label}
        </button>
        {hint ? <span className="hint" style={{ marginTop: 0 }}>{hint}</span> : null}
        {!readiness.ready ? (
          <Link to="/settings" className="btn btn-sm">
            去设置
          </Link>
        ) : null}
      </div>

      {!readiness.ready && readiness.reason ? (
        <div className="issue warning" style={{ marginTop: 10, marginBottom: 0 }}>
          <div className="issue-title">还不能生成</div>
          <div className="issue-line">{readiness.reason}</div>
        </div>
      ) : null}

      {readiness.ready && readiness.reason ? (
        <div className="hint" style={{ marginTop: 6 }}>
          {readiness.reason}
        </div>
      ) : null}

      {feedback ? (
        <div
          className={`issue ${feedback.kind === 'error' ? 'error' : feedback.kind === 'info' ? 'warning' : ''}`}
          style={{
            marginTop: 12,
            marginBottom: 0,
            borderLeftColor:
              feedback.kind === 'ok' ? 'var(--ok)' : feedback.kind === 'info' ? undefined : undefined,
          }}
        >
          <div className="issue-title">
            {feedback.kind === 'ok' ? '生成完成' : feedback.kind === 'info' ? '生成完成，但有问题要看一下' : '生成失败'}
            {feedback.attempts && feedback.attempts > 1 ? (
              <span className="tag" style={{ marginLeft: 8 }}>
                重试 {feedback.attempts - 1} 次
              </span>
            ) : null}
          </div>
          <div className="issue-line" style={{ whiteSpace: 'pre-wrap' }}>
            {feedback.message}
          </div>
          {feedback.warnings.length > 0 ? (
            <ul className="issue-line" style={{ paddingLeft: 20, margin: '6px 0 0' }}>
              {feedback.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {feedback.raw ? (
            <details className="why" open={feedback.kind === 'error'}>
              <summary>模型实际返回了什么（排查「格式不对」看这里）</summary>
              <div className="why-body">
                <pre style={{ maxHeight: 320, overflow: 'auto' }}>{feedback.raw}</pre>
                <div className="hint">
                  把这段内容连同你的主题一起反馈，就能定位问题。它通常是三种情况之一：
                  ① 模型把 JSON 包在了说明文字或代码块里（本工具会自动剥离，剥不掉才会失败）；
                  ② 字段名或结构与要求不符；③ 输出被长度上限截断，JSON 不完整。
                </div>
              </div>
            </details>
          ) : null}
          {feedback.detail ? (
            <details className="why">
              <summary>技术细节</summary>
              <div className="why-body">
                <pre>{feedback.detail}</pre>
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}


