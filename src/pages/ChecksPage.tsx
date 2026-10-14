import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { RULE_LABEL, summarizeReport } from '../domain/checks';
import { SummaryBar } from '../components/bits';
import type { CheckIssue, CheckSeverity } from '../types/model';
import { AutoFixPanel } from '../components/AutoFixPanel';

/**
 * M2.5 穿帮检查（方案.md v0.6 §3.2）
 *
 * 这是本项目相对同类工具最独特的地方：不调用任何模型，纯本地逻辑，零成本可反复运行。
 *
 * 设计原则：**报告原因，不报「校验失败」**。
 * 新手需要的是「哪里错了、为什么错、怎么改」，不是错误码。
 * 因此每条问题都必须有三段：标题（哪里）、为什么、怎么改。
 */

const SEVERITY_LABEL: Record<CheckSeverity, string> = {
  error: '必须修',
  warning: '建议修',
  info: '看一眼',
};

const SEVERITY_TAG: Record<CheckSeverity, string> = {
  error: 'tag tag-error',
  warning: 'tag tag-warning',
  info: 'tag tag-info',
};

export function ChecksPage() {
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const report = useAppStore((s) => s.report);
  const refreshChecks = useAppStore((s) => s.refreshChecks);

  if (!project) {
    return <div className="empty">还没有打开任何项目。先去「项目」页新建或打开一个。</div>;
  }
  if (!report) {
    return (
      <div className="empty">
        还没有检查结果。
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-primary" onClick={refreshChecks}>
            立即检查
          </button>
        </div>
      </div>
    );
  }

  function goTo(issue: CheckIssue) {
    const { kind, id, field } = issue.location;
    if (kind === 'shot') {
      const url = field ? `/storyboard?shot=${id}&field=${field}` : `/storyboard?shot=${id}`;
      navigate(url);
      // 让浏览器有时间渲染目标元素
      window.setTimeout(() => {
        document.getElementById(`shot-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 60);
      return;
    }
    if (kind === 'character') navigate('/characters');
    if (kind === 'scene') navigate('/scenes');
    if (kind === 'story') navigate('/guide');
  }

  const groups: CheckSeverity[] = ['error', 'warning', 'info'];

  return (
    <>
      <div className="page-head">
        <div>
          <h2>穿帮检查</h2>
          <p>
            这里检查的是「该一致的地方有没有写下来」，不是「生成出来一定没问题」。
            生成模型仍可能出错，但把事实写清楚，你能在花钱出图之前就看出哪些地方会穿帮。
          </p>
        </div>
        <button type="button" className="btn" onClick={refreshChecks}>
          重新检查
        </button>
      </div>

      <AutoFixPanel report={report} />

      <SummaryBar>
        <b>{summarizeReport(report)}</b>
        <span className="tag tag-error">{report.counts.error} 必须修</span>
        <span className="tag tag-warning">{report.counts.warning} 建议修</span>
        <span className="tag tag-info">{report.counts.info} 看一眼</span>
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          检查时间 {new Date(report.checkedAt).toLocaleTimeString('zh-CN')}
        </span>
      </SummaryBar>

      {report.issues.length === 0 ? (
        <div className="empty">
          没有发现问题。可以开始生成画面了。
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-primary" onClick={() => navigate('/prompts')}>
              去看提示词
            </button>
          </div>
        </div>
      ) : null}

      {groups.map((severity) => {
        const group = report.issues.filter((i) => i.severity === severity);
        if (group.length === 0) return null;
        return (
          <section key={severity} style={{ marginBottom: 26 }}>
            <h3 className="card-title">
              <span className={SEVERITY_TAG[severity]}>{SEVERITY_LABEL[severity]}</span>
              <span style={{ color: 'var(--text-faint)', fontWeight: 400, fontSize: 12 }}>
                {group.length} 条
              </span>
            </h3>
            {group.map((issue) => (
              <div className={`issue ${issue.severity}`} key={issue.id}>
                <div className="issue-title">
                  <span className="tag" style={{ marginRight: 8 }}>
                    {RULE_LABEL[issue.ruleId] ?? issue.ruleId}
                  </span>
                  {issue.title}
                </div>
                <div className="issue-line">
                  <b>为什么：</b>
                  {issue.why}
                </div>
                <div className="issue-line">
                  <b>怎么改：</b>
                  {issue.suggestion}
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-sm" onClick={() => goTo(issue)}>
                    {issue.location.kind === 'shot' ? '跳到这一镜' : '去处理'}
                  </button>
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}
