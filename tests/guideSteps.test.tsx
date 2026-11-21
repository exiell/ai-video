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

function pills() {
  return [...container.querySelectorAll<HTMLButtonElement>('.guide-step-pill')];
}

function pill(label: string): HTMLButtonElement {
  const found = pills().find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`找不到步骤：${label}`);
  return found;
}

function done(label: string): boolean {
  return pill(label).classList.contains('done');
}

function active(label: string): boolean {
  return pill(label).getAttribute('aria-current') === 'step';
}

function viewStep(index: number) {
  const button = pills()[index];
  if (!button) throw new Error(`找不到第 ${index} 步`);
  click(button);
}

function next() {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.textContent?.trim().startsWith('下一步'),
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
  it('点下一步不会把没写完的「定故事」标成已完成', () => {
    render();
    expect(active('定故事')).toBe(true);
    next();
    expect(active('画风与规格')).toBe(true);
    expect(done('定故事')).toBe(false);
  });

  it('空项目手动切到「画风与规格」，不会因为默认值自动算完成', () => {
    const project = makeEmptyProject('风格未填');
    project.brief.styleTags = [];
    project.brief.styleTone = '';
    project.logline = '';
    useAppStore.setState({ project });
    render();
    viewStep(1);
    expect(active('画风与规格')).toBe(true);
    expect(done('画风与规格')).toBe(false);
  });

  it('填写正文后才算完成，切到别的步骤再切回来仍然是已完成', () => {
    render();
    expect(done('定故事')).toBe(false);
    writeBody('林冲在风雪夜看守草料场，听见门外有人密谋烧死他。');
    expect(done('定故事')).toBe(true);

    viewStep(1);
    expect(done('定故事')).toBe(true);

    viewStep(0);
    expect(done('定故事')).toBe(true);
    expect(active('定故事')).toBe(true);
  });

  it('删掉正文后完成态跟着消失', () => {
    render();
    writeBody('先写一段。');
    expect(done('定故事')).toBe(true);
    viewStep(1);
    expect(done('定故事')).toBe(true);

    viewStep(0);
    writeBody('');
    expect(done('定故事')).toBe(false);
  });
});
