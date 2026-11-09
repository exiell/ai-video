// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from '../src/pages/HomePage';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 作品主页的四步进度：一行，不是四张卡片
 *
 * ===========================================================================
 * 为什么盯这个
 * ===========================================================================
 * 原来第一屏是四张等高卡片（名称 / 状态 / 两行说明 / 进度条），
 * 1280 宽的屏幕上占掉三分之一竖向，而「现在做什么」在它下面已经说了同一件事。
 * 改成一行之后有三件事不能丢：
 *
 *  1. **四步都在**（少一步，用户就不知道后面还有别的）
 *  2. **能点进对应页面**（原来是死卡片，只能靠侧栏找）
 *  3. **状态可读**（完成 / 当前 / 待做，靠点的颜色和文字区分）
 */

let container: HTMLDivElement | null = null;

function render(node: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  const el = container;
  container = null;
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
});

function steps(el: Element): Element[] {
  return [...el.querySelectorAll('.stage-strip .stage-step')];
}

describe('工作主页四步进度', () => {
  it('压成一行，不再是四张卡片', () => {
    const el = render(<HomePage />);
    expect(el.querySelector('.stage-card')).toBeNull();
    expect(steps(el).length).toBe(4);
  });

  it('四步的名字按制作顺序排', () => {
    const el = render(<HomePage />);
    const names = steps(el).map((node) =>
      (node.querySelector('.stage-step-name')?.textContent ?? '').trim(),
    );
    expect(names).toEqual(['故事', '角色与场景', '分镜', '交付']);
  });

  it('每一步都能点进对应页面', () => {
    const el = render(<HomePage />);
    const hrefs = steps(el).map((node) => node.getAttribute('href'));
    expect(hrefs).toEqual(['/guide', '/characters', '/storyboard', '/export']);
  });

  it('已完成 / 当前 / 待做三档有各自的类名', () => {
    const el = render(<HomePage />);
    for (const node of steps(el)) {
      const marks = ['is-done', 'is-now', 'is-todo'].filter((name) => node.classList.contains(name));
      expect(marks.length).toBe(1);
    }
  });

  it('没有项目时不渲染进度条（空状态优先）', () => {
    useAppStore.setState({ project: null, report: null });
    const el = render(<HomePage />);
    expect(el.querySelector('.stage-strip')).toBeNull();
  });
});
