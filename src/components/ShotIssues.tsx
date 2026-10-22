import { RULE_LABEL, SEVERITY_LABEL, SEVERITY_TAG, worstSeverity } from '../domain/checks';
import type { CheckIssue } from '../types/model';

/**
 * 就地显示穿帮检查结果（v0.49）
 *
 * 背景：检查结果原来只存在于「穿帮检查」页。用户改一镜要来回跳两次：
 * 分镜页改 → 检查页看 → 分镜页再改。而检查本身是纯本地计算、零成本的，
 * 结果早就在 store 里，只是没人把它带回到出错的地方。
 *
 * 这里只做一件事：把一条 issue 的**标题 / 为什么 / 怎么改**三段原样摊开，
 * 措辞一个字都不改。检查和显示必须是同一句话，否则用户会以为
 * 「检查页说的」和「分镜页说的」是两个问题。
 */

/** 逐条摊开：标题、为什么、怎么改。与穿帮检查页同一套文案。 */
export function IssueItems({ issues }: { issues: CheckIssue[] }) {
  return (
    <>
      {issues.map((issue) => (
        <div className="issue-mini" key={issue.id}>
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
        </div>
      ))}
    </>
  );
}

/**
 * 字段下面那一行「必须修 · 「动作」这里有 2 个问题」。
 *
 * 用原生 `<details>` 而不是自己管开关状态：键盘可达、点外部不会误关、
 * 也不需要为每个字段各存一份 state（一页可能有几十个字段）。
 */
export function FieldIssues({ issues, label }: { issues: CheckIssue[]; label?: string }) {
  if (issues.length === 0) return null;
  const worst = worstSeverity(issues) ?? 'info';
  return (
    <details className="why field-issues">
      <summary>
        <span className={SEVERITY_TAG[worst]}>{SEVERITY_LABEL[worst]}</span>
        <span className="field-issues-text">
          {label ? `「${label}」这里有 ${issues.length} 个问题` : `${issues.length} 个问题`}
        </span>
      </summary>
      <div className="why-body">
        <IssueItems issues={issues} />
      </div>
    </details>
  );
}

/**
 * 装不进任何字段的那些问题。
 *
 * 有些 issue 指向的字段在这个页面上没有可编辑控件（比如 `variantIds`
 * 要在角色页改），还有的干脆没写 `field`。不能因为「找不到地方贴」
 * 就把它们丢掉——丢掉等于回到「必须去检查页才能看见」。
 */
export function UnplacedIssues({ issues, placed }: { issues: CheckIssue[]; placed: number }) {
  if (issues.length === 0) return null;
  const worst = worstSeverity(issues) ?? 'info';
  return (
    <details className="why shot-issues">
      <summary>
        <span className={SEVERITY_TAG[worst]}>{SEVERITY_LABEL[worst]}</span>
        <span className="field-issues-text">
          这一镜还有 {issues.length} 处不在这几个字段上
        </span>
      </summary>
      <div className="why-body">
        <IssueItems issues={issues} />
        {placed > 0 ? (
          <div className="hint">另外 {placed} 处已经标在对应的字段下面了。</div>
        ) : null}
      </div>
    </details>
  );
}
