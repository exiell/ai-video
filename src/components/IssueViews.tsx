import { RULE_LABEL, SEVERITY_LABEL, SEVERITY_TAG, worstSeverity } from '../domain/checks';
import type { CheckIssue } from '../types/model';
import { Icon } from './Icon';

/**
 * 显示穿帮检查结果（v0.49 起两页共用，v0.50 改排版）
 *
 * 背景：检查结果原来只存在于「穿帮检查」页。用户改一镜要来回跳两次：
 * 分镜页改 → 检查页看 → 分镜页再改。而检查本身是纯本地计算、零成本的，
 * 结果早就在 store 里，只是没人把它带回到出错的地方。
 *
 * 措辞一个字都不改：检查和显示必须是同一句话，否则用户会以为
 * 「检查页说的」和「分镜页说的」是两个问题。
 *
 * v0.50 改了什么：原来「为什么：」「怎么改：」只是两行正文开头的粗体字，
 * 长条目连着读下来是一片灰。现在这两段各带一个图标与底色标签，并固定成
 * 两列——左边是「你在看什么」，右边是那句话。扫描时先看左列就够了。
 */

/**
 * 一条问题的「为什么 / 怎么改」两段。
 *
 * 图标的选择：为什么用问号（这是解释），怎么改用右箭头（这是往哪走）。
 * 颜色刻意分主次——「怎么改」才是用户要执行的那句，所以它用强调色；
 * 「为什么」用次级文字色，不抢视线。
 */
export function IssueBody({ issue }: { issue: CheckIssue }) {
  return (
    <div className="issue-explain">
      <div className="issue-gloss">
        <span className="issue-mark issue-mark-why">
          <Icon name="help" size={12} />
          <span>为什么</span>
        </span>
        <span className="issue-text">{issue.why}</span>
      </div>
      <div className="issue-gloss">
        <span className="issue-mark issue-mark-fix">
          <Icon name="arrow-right" size={12} />
          <span>怎么改</span>
        </span>
        <span className="issue-text issue-text-fix">{issue.suggestion}</span>
      </div>
    </div>
  );
}

/** 逐条摊开：标题、为什么、怎么改。与穿帮检查页同一套组件、同一段文案。 */
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
          <IssueBody issue={issue} />
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
