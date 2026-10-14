import type { ReactNode } from 'react';

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
