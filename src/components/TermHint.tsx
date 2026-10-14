import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CAMERA_MOVE_GUIDE, SHOT_SIZE_GUIDE, findTerm } from '../domain/help/terms';
import type { CameraMove, ShotSize } from '../types/model';

/**
 * 术语内联提示
 *
 * 为什么不做成独立的「术语表页面」就完事：
 * 用户卡住的那一刻是在填表——他盯着「景别」下拉框不知道该选哪个，
 * 这时候让他切页面去查，他多半就随便选一个了。
 * 所以提示必须出现在字段旁边。
 *
 * 交互：点击问号展开，不用 hover——hover 在触控板上很难用，
 * 而且用户可能想边看提示边改字段，展开后要能一直留着。
 */

export function TermHint({ term }: { term: string }) {
  const [open, setOpen] = useState(false);
  const entry = findTerm(term);

  if (!entry) {
    return (
      <span className="tag" title="术语表里还没有这一条">
        {term}
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span>{entry.zh}</span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="看这个词是什么意思"
        aria-expanded={open}
        style={{
          width: 15,
          height: 15,
          borderRadius: '50%',
          border: '1px solid var(--border-strong)',
          background: open ? 'var(--accent-dim)' : 'transparent',
          color: open ? '#fff' : 'var(--text-faint)',
          fontSize: 10,
          lineHeight: 1,
          padding: 0,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        ?
      </button>
      {open ? (
        <span
          style={{
            position: 'absolute',
            zIndex: 20,
            marginTop: 8,
            maxWidth: 380,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-strong)',
            borderRadius: 8,
            padding: '10px 12px',
            boxShadow: 'var(--shadow)',
            display: 'block',
          }}
        >
          <b style={{ fontSize: 12.5 }}>
            {entry.zh} · {entry.en}
          </b>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>{entry.summary}</div>
          <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>{entry.whenToUse}</div>
          {entry.example ? (
            <div className="hint" style={{ marginTop: 6 }}>
              例：{entry.example}
            </div>
          ) : null}
          <div style={{ marginTop: 8 }}>
            <Link className="btn btn-ghost btn-sm" to="/help" onClick={() => setOpen(false)}>
              看完整术语表
            </Link>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
              知道了
            </button>
          </div>
        </span>
      ) : null}
    </span>
  );
}

/** 景别下拉框旁的提示：直接给出「什么时候用它」，而不是字典定义 */
export function ShotSizeHint({ value }: { value: ShotSize }) {
  return (
    <div className="hint" style={{ marginTop: 4 }}>
      {SHOT_SIZE_GUIDE[value]}
    </div>
  );
}

/** 运镜下拉框旁的提示 */
export function CameraMoveHint({ value }: { value: CameraMove }) {
  return (
    <div className="hint" style={{ marginTop: 4 }}>
      {CAMERA_MOVE_GUIDE[value]}
    </div>
  );
}
