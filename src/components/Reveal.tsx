import { useEffect, useState, type ReactNode } from 'react';

/**
 * 高度可过渡的展开容器。
 *
 * 角色/场景卡里的表单很长，只做内容淡入的话，卡片高度会瞬间跳开，
 * 看起来像“没有动画”。这里用 grid-template-rows 0fr → 1fr 做真实高度过渡；
 * 首次打开时才挂载内容，之后保留 DOM，关闭时只收起高度并把焦点挡在外面。
 */
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!open) {
      setExpanded(false);
      return;
    }
    setMounted(true);
    // 先让 0fr 的那一帧真的画出来，下一帧再切到 1fr，grid 高度过渡才会生效。
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setExpanded(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div className={`reveal${expanded ? ' open' : ''}`} inert={!expanded}>
      <div className="reveal-inner">{children}</div>
    </div>
  );
}
