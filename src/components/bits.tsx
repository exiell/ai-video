import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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

/**
 * 需要用户明确点头才继续的对话框。
 *
 * 【为什么不用 window.confirm】这里要说的不是一句「确定吗」，
 * 而是「风险是什么、要改的话按什么顺序做」——多段文字 + 列表。
 * 原生 confirm 只能塞一段纯文本，塞进去会变成一坨没人读的墙。
 *
 * 可访问性照 lightbox 的做法：role="dialog" + aria-modal，
 * Esc 关闭，点背景关闭，打开时焦点落在取消按钮上（默认不鼓励确认）。
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel = '确定',
  cancelLabel = '取消',
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // 打开前记下焦点，关闭后还回去：触发弹窗的可能是侧栏按钮，也可能是卡片里的按钮
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      // 简易焦点陷阱：Tab / Shift+Tab 在弹窗内循环，不跑到背景页面上
      const root = cardRef.current;
      if (!root) return;
      const focusables = [
        ...root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreRef.current?.focus();
    };
  }, [open, onCancel]);

  if (!open) return null;

  /**
   * 必须 portal 到 document.body。
   *
   * 【踩过的坑】`position: fixed` 并**不能保证**相对视口定位 ——
   * 只要任一祖先有非 none 的 `transform` / `filter` / `backdrop-filter` /
   * `will-change`，它就会变成相对那个祖先定位。
   *
   * 实际撞上的是 `.shot-more`：它的入场动画 `animation: ... both` 末帧是
   * `transform: translateY(0)`，`both` 把它永久保留下来 —— 于是弹窗被限制在
   * 一张镜头卡片里，顶部还被裁掉（长内容时滚不到）。
   *
   * 光改动画不够：以后任何一个卡片加动画都会再犯。挂到 body 上才是通解。
   */
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="confirm-backdrop"
      onClick={onCancel}
    >
      <div className="confirm-card" ref={cardRef} onClick={(e) => e.stopPropagation()}>
        <div className="confirm-title">{title}</div>
        <div className="confirm-body">{children}</div>
        <div className="confirm-actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="btn btn-blue" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 复制失败时的兜底弹层。
 *
 * 原来用 window.prompt 把整段提示词塞进原生输入框：上千字符会被截断，
 * 也没法全选。改成只读 textarea 弹层，打开即全选，Ctrl/Cmd+C 就能拿走。
 */
export function CopyFallbackDialog({
  text,
  onClose,
}: {
  text: string | null;
  onClose: () => void;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!text) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // 弹层挂载后聚焦并全选，用户只需要按一次复制快捷键
    const timer = window.setTimeout(() => {
      areaRef.current?.focus();
      areaRef.current?.select();
    }, 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(timer);
    };
  }, [text, onClose]);

  if (!text) return null;

  return createPortal(
    <div className="confirm-backdrop" onClick={onClose}>
      <div
        className="confirm-card"
        style={{ width: 'min(760px, 100%)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-title">复制失败，手动复制下面的内容</div>
        <div className="confirm-body">
          <p className="hint" style={{ marginTop: 0 }}>
            浏览器拒绝了剪贴板权限。下面是完整内容，已经全选，按 Ctrl/Cmd+C 复制。
          </p>
          <textarea
            ref={areaRef}
            readOnly
            value={text}
            rows={10}
            aria-label="要复制的内容"
            style={{ width: '100%', minHeight: 160, fontFamily: 'var(--mono)', fontSize: 12 }}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
        <div className="confirm-actions">
          <button type="button" className="btn btn-blue" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
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
