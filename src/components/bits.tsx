import type { ReactNode } from 'react';

/**
 * 把文案里的 `**重点**` 渲染成加粗。
 *
 * ===========================================================================
 * 为什么需要它
 * ===========================================================================
 * 项目里很多面向用户的文案是照着 Markdown 习惯写的，例如
 * 「这一步会**覆盖**现有的角色与场景」。
 *
 * 但 **JSX 不解析 Markdown** —— 直接放进 JSX 文本里，用户看到的是
 * 字面的两个星号：「这一步会**覆盖**现有的角色与场景」。
 *
 * 这类问题在代码里很难看出来（源码读起来是对的），只有实际渲染才发现。
 * 所以这里做一个极小的解析器，不引入 Markdown 库 ——
 * 为了四个星号拉进来一个依赖，不划算。
 *
 * 只支持 `**加粗**` 这一种语法。故意不支持更多：
 * 需要更复杂排版的地方，请直接用 JSX 写。
 */
export function RichText({ children }: { children: string | undefined | null }) {
  if (!children) return null;
  const parts = children.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        // 奇数个字符开头结尾是 ** —— 那是分隔符本身
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <b key={i}>{part.slice(2, -2)}</b>;
        }
        return part;
      })}
    </>
  );
}

/** 把 `**重点**` 的标记去掉，只留文字。用于原生 title / aria-label 这类只收字符串的地方。 */
export function stripRichMarks(text: string | undefined | null): string {
  if (!text) return '';
  return text.replace(/\*\*([^*]+)\*\*/g, '$1');
}

/** 「为什么问这个」折叠说明 —— 方案.md v0.6 §3.2 M1：这是「引导」与「表单」的分界线 */
export function WhyDetails({ children }: { children: ReactNode }) {
  return (
    <details className="why">
      <summary>为什么问这个</summary>
      <div className="why-body">{children}</div>
    </details>
  );
}

/** 带标签的表单字段 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </label>
  );
}

/** 顶部统计条 */
export function SummaryBar({ children }: { children: ReactNode }) {
  return <div className="summary-bar">{children}</div>;
}
