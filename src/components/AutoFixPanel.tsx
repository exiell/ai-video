import { Info } from './bits';
import { useMemo, useState } from 'react';
import { useAppStore } from '../store/app';
import { RULE_LABEL } from '../domain/checks';
import { applyFixes, buildFixPlan, type FixProposal } from '../domain/checks/autoFix';
import { PLATFORM_MAX_DURATION } from '../domain/checks/storyboard';
import type { CheckReport, Project } from '../types/model';

/**
 * 穿帮自动修复：提议 → 确认 → 落盘
 *
 * ===========================================================================
 * 为什么必须分两步
 * ===========================================================================
 * 分镜是用户的作品，出图要花钱。静默修改比不修改更糟——
 * 他改完发现分镜变了、又不知道哪里变了、更不知道能撤销。
 *
 * 所以这个组件只做三件事：
 *  1. 把每条提议摊开：改哪里、原来是什么、改成什么、为什么这么改、有什么副作用
 *  2. 让用户逐条勾选（默认全选，但要他能剔除不认可的）
 *  3. 确认后才写入，并保留一次撤销
 *
 * 需要审美判断的问题（光线冲突、色调漂移、一镜多动作、总时长）**不提议自动修**，
 * 只说明为什么不能自动修。
 */
export function AutoFixPanel({ report }: { report: CheckReport }) {
  const project = useAppStore((s) => s.project);
  const setProject = useAppStore((s) => s.setProject);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [undoSnapshot, setUndoSnapshot] = useState<Project | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const plan = useMemo(() => {
    if (!project) return null;
    const maxShotDuration = Math.max(
      ...project.brief.platforms.map((p) => PLATFORM_MAX_DURATION[p] ?? 10),
      10,
    );
    return buildFixPlan(project, report, { maxShotDuration });
  }, [project, report]);

  if (!project || !plan) return null;

  // 提议会随分镜变化而失效，所以每次打开都重新全选
  function openPanel() {
    setSelected(new Set(plan!.proposals.map((p) => p.id)));
    setResult(null);
    setOpen(true);
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function apply() {
    const chosen = plan!.proposals.filter((p) => selected.has(p.id));
    if (chosen.length === 0) return;
    const snapshot = project!;
    const applied = applyFixes(project!, chosen);
    setUndoSnapshot(snapshot);
    setProject(applied.project);
    setResult(
      `已修改 ${applied.applied} 处` +
        (applied.skipped > 0 ? `，另有 ${applied.skipped} 处因为目标已不存在被跳过。` : '。'),
    );
    setOpen(false);
  }

  function undo() {
    if (!undoSnapshot) return;
    setProject(undoSnapshot);
    setUndoSnapshot(null);
    setResult('已撤销，分镜恢复成修改前的样子。');
  }

  if (plan.proposals.length === 0 && plan.manualOnly === 0) return null;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 className="card-title" style={{ margin: 0 }}>
          自动修复
          {plan.proposals.length > 0 ? (
            <span className="tag tag-ok">可修 {plan.proposals.length} 处</span>
          ) : null}
          {plan.manualOnly > 0 ? (
            <span className="tag tag-warning">需你决定 {plan.manualOnly} 处</span>
          ) : null}
        </h3>
        {!open && plan.proposals.length > 0 ? (
          <button type="button" className="btn btn-primary" onClick={openPanel}>
            看看能自动改什么
          </button>
        ) : null}
      </div>

      {plan.proposals.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: '10px 0 0' }}>
          这些问题都需要你自己判断，机器改不了。下面「需你决定」一节里逐条写了为什么。
        </p>
      ) : null}

      {plan.manualOnly > 0 ? (
        <div className="hint" style={{ marginTop: 10 }}>
          这几类需要你判断
          <Info label="为什么有些问题不自动改">
            需要审美判断的修改一律不碰：
            {plan.manualRuleIds.map((id) => RULE_LABEL[id] ?? id).join('、')}。
            比如「光线与场景设定不一致」，改成傍晚、还是把场景卡改成白天，只有你知道。
            机器猜错会把你的创作意图改坏，而且你还不知道为什么。
          </Info>
        </div>
      ) : null}

      {result ? (
        <div className="issue" style={{ marginTop: 12, marginBottom: 0, borderLeftColor: 'var(--ok)' }}>
          <div className="issue-line">{result}</div>
          <div className="row" style={{ marginTop: 8 }}>
            {undoSnapshot ? (
              <button type="button" className="btn btn-sm" onClick={undo}>
                撤销这次修改
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setResult(null)}>
              知道了
            </button>
          </div>
        </div>
      ) : null}

      {open ? (
        <div style={{ marginTop: 14 }}>
          <div className="summary-bar" style={{ marginBottom: 12 }}>
            <b>以下修改需要你确认后才会生效。</b>
            <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
              去掉不认可的勾选即可跳过那一条。共影响 {plan.affectedShots} 个镜头。
            </span>
          </div>

          <div className="row" style={{ marginBottom: 10 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setSelected(new Set(plan.proposals.map((p) => p.id)))}
            >
              全选
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set())}>
              全不选
            </button>
            <span className="hint" style={{ marginTop: 0 }}>
              已选 {selected.size} / {plan.proposals.length}
            </span>
          </div>

          {plan.proposals.map((proposal) => (
            <ProposalRow
              key={proposal.id}
              proposal={proposal}
              checked={selected.has(proposal.id)}
              onToggle={() => toggle(proposal.id)}
            />
          ))}

          <div className="row" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={selected.size === 0}
              onClick={apply}
            >
              确认修改这 {selected.size} 处
            </button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProposalRow({
  proposal,
  checked,
  onToggle,
}: {
  proposal: FixProposal;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className="fix-proposal"
      style={{
        display: 'block',
        borderLeft: `3px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
        background: 'var(--bg-card)',
        borderRadius: 'var(--radius)',
        padding: '12px 14px',
        marginBottom: 10,
        cursor: 'pointer',
      }}
    >
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          style={{ width: 'auto', marginTop: 3 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="issue-title" style={{ marginBottom: 6 }}>
            {proposal.title}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '4px 10px',
              fontSize: 13,
              marginBottom: 6,
            }}
          >
            <span style={{ color: 'var(--text-faint)' }}>改前</span>
            <span style={{ color: 'var(--text-dim)' }}>{proposal.before || '（空）'}</span>
            <span style={{ color: 'var(--text-faint)' }}>改后</span>
            <span>
              <b>{proposal.after}</b>
            </span>
          </div>

          <div className="issue-line" style={{ fontSize: 13 }}>
            <b>为什么：</b>
            {proposal.reason}
          </div>

          {proposal.sideEffect ? (
            <div className="issue-line" style={{ fontSize: 13, color: 'var(--warning)' }}>
              <b>注意：</b>
              {proposal.sideEffect}
            </div>
          ) : null}
        </div>
      </div>
    </label>
  );
}
