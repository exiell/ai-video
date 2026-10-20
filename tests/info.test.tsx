// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Info } from '../src/components/bits';

/**
 * 按需显示的说明（v0.38）
 *
 * ===========================================================================
 * 为什么要这个组件
 * ===========================================================================
 * 用户对界面的意见是「说明文字还是较为冗余」，要求把非必要说明
 * **鼠标放上去或点一下才显示**，目标是「一目了然知道有什么功能」。
 *
 * 所以判断该不该有它，只有一个问题：**不看它，用户会不会填错？**
 *  - 会 → 必须内联（GOV.UK 的 hint 规则、Vercel 的 "Inline help first, tooltips last"）
 *  - 不会 → 放进这个组件
 *
 * 交互上悬停和点击都要有：只有悬停则触屏用不了，只有点击则桌面每次多点一下。
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  root = null;
  container = null;
});

function dot(el: HTMLElement): HTMLButtonElement {
  const b = el.querySelector('.info-dot');
  if (!b) throw new Error('找不到 ⓘ 按钮');
  return b as HTMLButtonElement;
}

describe('Info · 按需显示', () => {
  it('默认**不显示**内容（不占布局）', () => {
    const el = mount(<Info>这段解释默认不该出现</Info>);
    expect(el.textContent).not.toContain('这段解释默认不该出现');
    expect(el.querySelector('.info-body')).toBeNull();
  });

  it('**点击后显示**（触屏没有悬停，所以点击必须能用）', () => {
    const el = mount(<Info>点开才看到</Info>);
    act(() => dot(el).click());
    expect(el.textContent).toContain('点开才看到');
    expect(dot(el).getAttribute('aria-expanded')).toBe('true');
  });

  it('再点一次收起', () => {
    const el = mount(<Info>再看一次</Info>);
    act(() => dot(el).click());
    act(() => dot(el).click());
    expect(el.textContent).not.toContain('再看一次');
  });

  it('**悬停显示**（桌面少点一下）', () => {
    const el = mount(<Info>悬停就看到</Info>);
    const wrap = el.querySelector('.info')!;
    act(() => {
      wrap.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    // React 的 onMouseEnter 由 mouseover 触发
    expect(el.textContent).toContain('悬停就看到');
    act(() => {
      wrap.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
  });

  it('**Esc 能关掉**（不给键盘用户留一个关不掉的浮层）', () => {
    const el = mount(<Info>按 Esc 关</Info>);
    act(() => dot(el).click());
    expect(el.textContent).toContain('按 Esc 关');
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(el.textContent).not.toContain('按 Esc 关');
  });

  it('点外面也能关', () => {
    const el = mount(<Info>点外面关</Info>);
    act(() => dot(el).click());
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(el.textContent).not.toContain('点外面关');
  });

  it('**用 button 而不是 span**：可聚焦、可被读屏识别', () => {
    const el = mount(<Info label="为什么需要这个字段">说明</Info>);
    expect(dot(el).tagName).toBe('BUTTON');
    expect(dot(el).getAttribute('aria-label')).toBe('为什么需要这个字段');
    expect(dot(el).getAttribute('type')).toBe('button');
  });

  it('展开后把浮层和按钮关联起来（aria-describedby）', () => {
    const el = mount(<Info>关联检查</Info>);
    expect(dot(el).getAttribute('aria-describedby')).toBeNull();
    act(() => dot(el).click());
    const id = dot(el).getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    expect(el.querySelector(`#${CSS.escape(id!)}`)).not.toBeNull();
  });

  it('**放在 label 里点击不触发 label**（否则焦点被抢走，浮层立刻消失）', () => {
    // 这是真实会踩的坑：Info 常跟在字段标签后面，而 Field 整体是个 <label>。
    // 点按钮的默认行为会转发给 label，焦点跳到输入框。
    const el = mount(
      <label>
        <span>字段名 </span>
        <Info>说明内容</Info>
        <input />
      </label>,
    );
    const input = el.querySelector('input')!;
    let focused = false;
    input.addEventListener('focus', () => {
      focused = true;
    });
    act(() => dot(el).click());
    expect(focused).toBe(false);
    expect(el.textContent).toContain('说明内容');
  });
});
