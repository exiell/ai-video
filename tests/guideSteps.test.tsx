// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { GuidePage } from '../src/pages/GuidePage';
import { makeEmptyProject, useAppStore } from '../src/store/app';

/**
 * 故事向导的「已完成」必须来自内容，不来自当前停在第几步。
 *
 * 回归点：旧逻辑用 `index < step` 推导完成态，点一下下一步，
 * 上一步就自动变已完成；再切回去又消失。
 */
let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <GuidePage />
      </MemoryRouter>,
    );
  });
  return container;
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

function rail() {
  return [...container.querySelectorAll<HTMLButtonElement>('.wizard-step')];
}

function stateOf(label: string): string {
  const button = rail().find((item) => item.textContent?.includes(label));
  return button?.querySelector('.wizard-state')?.textContent?.trim() ?? '';
}

function viewStep(index: number) {
  const button = rail()[index];
  if (!button) throw new Error(`找不到第 ${index} 步`);
  click(button);
}

function next() {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === '下一步',
  );
  if (!button) throw new Error('找不到下一步');
  click(button);
}

function writeBody(text: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('找不到故事正文');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  useAppStore.setState({
    project: makeEmptyProject('向导测试'),
    report: null,
    dirty: false,
    revision: 0,
    saveError: null,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('故事向导的完成状态', () => {
  it('点下一步不会把没写完的「填写故事」标成已完成', () => {
    const view = render();
    expect(view.querySelector('.wizard-step.active')?.textContent).toContain('故事来源');

    next();
    expect(stateOf('故事来源')).toBe('已完成');
    expect(stateOf('填写故事')).toBe('当前');
    expect(stateOf('填写故事')).not.toContain('已完成');
  });

  it('空项目手动切到「风格与规格」，不会因为默认值自动算完成', () => {
    render();
    viewStep(2);
    expect(stateOf('风格与规格')).toBe('当前');
    expect(stateOf('风格与规格')).not.toContain('已完成');
  });

  it('填写正文后才算完成，切到别的步骤再切回来仍然是已完成', () => {
    render();
    next();

    writeBody('林冲在风雪夜看守草料场，听见门外有人密谋烧死他。');
    expect(stateOf('填写故事')).toBe('当前 · 已完成');

    // 去风格页，再回故事页：完成态不能因为 index < step 失效
    viewStep(2);
    expect(stateOf('填写故事')).toBe('已完成');

    viewStep(1);
    expect(stateOf('填写故事')).toBe('当前 · 已完成');

    // 回到第 0 步，第 1 步仍然是已完成
    viewStep(0);
    expect(stateOf('填写故事')).toBe('已完成');
  });

  it('删掉正文后完成态跟着消失', () => {
    render();
    next();
    writeBody('先写一段。');
    viewStep(2);
    expect(stateOf('填写故事')).toBe('已完成');

    viewStep(1);
    writeBody('');
    expect(stateOf('填写故事')).toBe('当前');
    viewStep(2);
    expect(stateOf('填写故事')).toBe('未完成');
  });
});

