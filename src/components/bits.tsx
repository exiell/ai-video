import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

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

/**
 * 折叠说明。
 *
 * `summary` 可改：原来这条一律写「为什么问这个」，但它在**非提问场景**下很怪——
 * 例如设置页的存储用量旁边，那里没有问题可问。
 */
export function WhyDetails({
  children,
  summary = '为什么问这个',
}: {
  children: ReactNode;
  summary?: string;
}) {
  return (
    <details className="why">
      <summary>{summary}</summary>
      <div className="why-body">{children}</div>
    </details>
  );
}

/**
 * 按需显示的一小段解释。
 *
 * ===========================================================================
 * 为什么要做这个（v0.38）
 * ===========================================================================
 * 用户的评价是「说明文字还是较为冗余」，要求把非必要说明**鼠标放上去或点一下才显示**，
 * 目标是「一目了然知道有什么功能、下一步做什么」。
 *
 * 一屏里的说明文字越少，用户越容易看到真正要操作的东西。
 * 但直接删掉会丢掉有用信息，所以改成**不占布局的按需显示**。
 *
 * ## 什么时候该用它，什么时候不该
 *
 * - **用它**：补原理、给例子、解释「为什么」——不看也能填对。
 * - **别用它**：不看你就会填错的信息（格式要求、必填、范围）。
 *   那一类必须内联。GOV.UK 的规则原话是「hint 只能一句话」，
 *   而 Vercel 的界面规范把优先次序写成 "Inline help first, tooltips last"。
 *
 * ## 交互
 *
 * 鼠标悬停显示（桌面）**和**点击切换（触屏没有悬停），Esc 关闭，点外面关闭。
 * 两者都要：只有悬停则触屏用不了，只有点击则桌面每次都要多点一下。
 *
 * 用按钮而不是 span：它可聚焦、可被读屏识别、能用键盘操作。
 */
export function Info({
  children,
  label = '说明',
}: {
  children: ReactNode;
  /** 读屏用的描述，例如「为什么需要连续性锁」 */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const id = useId();
  const shown = open || hover;

  // Esc 关闭 + 点外面关闭。只在打开时挂监听，避免全站常驻一个 document 监听。
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setHover(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setHover(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [shown]);

  return (
    <span
      className="info"
      ref={wrapRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className="info-dot"
        aria-label={label}
        aria-expanded={shown}
        aria-describedby={shown ? id : undefined}
        onClick={(e) => {
          // 这个组件常放在 <label> 里。不阻止默认行为的话，
          // 点它等于点了 label，焦点会跳到输入框，弹出层立刻被抢走。
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⓘ
      </button>
      {shown ? (
        <span className="info-body" id={id} role="tooltip">
          {children}
        </span>
      ) : null}
    </span>
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
