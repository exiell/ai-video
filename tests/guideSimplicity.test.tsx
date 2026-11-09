// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { GuidePage } from '../src/pages/GuidePage';
import { makeEmptyProject, useAppStore } from '../src/store/app';

/**
 * 「填写故事」这一步的第一屏应该只有一件事
 *
 * ===========================================================================
 * 为什么盯这个
 * ===========================================================================
 * 原来这一步一上来是五个输入框：故事正文 + 人物 / 地点 / 冲突 / 结局。
 * 但对新手来说「把故事写下来」就是这一页唯一的任务，四格是给检查引擎核对
 * 「该拍的是不是都拍了」用的，没想好可以空着。
 *
 * 现在它们收进「补充四个格子（可选）」，标题旁边显示已填几格。
 * 三条不能退：正文还在第一屏、四格还能填、已填数量看得见。
 */

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function render(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter>
        <GuidePage />
      </MemoryRouter>,
    );
  });
  return container;
}

function gotoStep(index: number) {
  const buttons = [...container!.querySelectorAll<HTMLButtonElement>('.wizard-step')];
  act(() => {
    buttons[index]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  useAppStore.setState({
    project: makeEmptyProject('向导简洁性'),
    report: null,
    dirty: false,
    revision: 0,
    saveError: null,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('「填写故事」这一步的复杂度', () => {
  it('故事正文在折叠外面，进这一步就能写', () => {
    const el = render();
    gotoStep(1);
    const textarea = el.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).toBeTruthy();
    // 第一个 textarea 不能在被收起的 details 里
    expect(textarea!.closest('details')).toBeNull();
  });

  it('四个补充格子默认收起，但四格都在', () => {
    const el = render();
    gotoStep(1);
    const fold = [...el.querySelectorAll('details.card-fold')].find((node) =>
      (node.querySelector('.card-fold-title')?.textContent ?? '').includes('补充四个格子'),
    );
    expect(fold).toBeTruthy();
    expect(fold!.hasAttribute('open')).toBe(false);
    expect(fold!.querySelectorAll('textarea').length).toBe(4);
  });

  it('收起时标题旁边写着已经填了几格', () => {
    useAppStore.setState({
      project: {
        ...makeEmptyProject('已填两格'),
        story: {
          ...makeEmptyProject('已填两格').story,
          conflict: '他想活命，官府要灭口',
          ending: '雪地里提着枪转身',
        },
      },
    });
    const el = render();
    gotoStep(1);
    const count = [...el.querySelectorAll('.card-fold-count')].map((n) => n.textContent?.trim());
    expect(count.some((text) => text === '2 / 4 已填')).toBe(true);
  });

  it('左栏不再挂那段三句说明', () => {
    const el = render();
    expect(el.querySelector('.guide-rail-note')).toBeNull();
  });
});
