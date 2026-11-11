// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { CharactersPage } from '../src/pages/CharactersPage';
import { ScenesPage } from '../src/pages/ScenesPage';
import { StoryboardPage } from '../src/pages/StoryboardPage';
import { GuidePage } from '../src/pages/GuidePage';
import { HomePage } from '../src/pages/HomePage';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 纯图标按钮必须有无障碍名
 *
 * ===========================================================================
 * 为什么盯这个
 * ===========================================================================
 * 「展开」「删除」「上一步」这类动作的语义是通用的，文字换成图标之后界面更整齐，
 * 但**可读的名字不能一起消失**：读屏软件念不出图标，鼠标悬停也看不到提示，
 * 用户就只能靠猜。
 *
 * 所以规则是：只要用了 .btn-icon，就必须同时有 aria-label 和 title。
 * 这条测试同时也在防止「以后又把文字塞回图标按钮里」——
 * 纯图标按钮的可见文字应该是空的。
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
  useAppStore.getState().setProject(structuredClone(sampleProject));
});

/**
 * 第三个字段：这一页在「示例项目 + 没有本地存档」的状态下是否一定会有图标按钮。
 * 作品主页的图标按钮长在「我保存过的项目」列表里，测试环境没有存档，所以可能一个都没有；
 * 它不在这个状态下出现时，只校验「出现了的必须合规」，不强制数量。
 */
const PAGES: Array<[string, () => React.ReactElement, boolean]> = [
  ['角色页', () => <CharactersPage />, true],
  ['场景页', () => <ScenesPage />, true],
  ['分镜页', () => <StoryboardPage />, true],
  ['故事向导', () => <GuidePage />, true],
  ['作品主页', () => <HomePage />, false],
];

describe('纯图标按钮的可访问性', () => {
  for (const [name, make, expected] of PAGES) {
    it(`${name}：每个图标按钮都有 aria-label 与 title`, () => {
      const el = render(make());
      const buttons = [...el.querySelectorAll('.btn-icon')];
      if (expected) expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.getAttribute('aria-label')?.trim().length ?? 0).toBeGreaterThan(0);
        expect(button.getAttribute('title')?.trim().length ?? 0).toBeGreaterThan(0);
      }
    });

    it(`${name}：图标按钮里不残留可见文字`, () => {
      const el = render(make());
      for (const button of el.querySelectorAll('.btn-icon')) {
        expect((button.textContent ?? '').trim()).toBe('');
      }
    });
  }

  it('展开按钮保留 aria-expanded，读屏能读出当前是展开还是收起', () => {
    const el = render(<StoryboardPage />);
    const toggle = el.querySelector('.expand-toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('故事向导：已完成的步骤用勾图标，状态文字仍在 DOM 里给读屏', () => {
    const el = render(<GuidePage />);
    const icon = el.querySelector('.wizard-state-icon');
    expect(icon).toBeTruthy();
    // 视觉隐藏，但读屏还能念出「当前 · 已完成」这类状态
    const states = [...el.querySelectorAll('.wizard-state')].map((n) => n.textContent?.trim());
    expect(states.some((text) => (text ?? '').includes('完成'))).toBe(true);
  });

  it('主页待办行整行是链接：点标题就跳对应页面，且不含嵌套锚点', () => {
    const el = render(<HomePage />);
    const rows = [...el.querySelectorAll('.task-list > li')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const link = row.querySelector('a[href]');
      expect(link).toBeTruthy();
      expect((link!.getAttribute('href') ?? '').startsWith('/')).toBe(true);
      expect((link!.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(link!.querySelector('a')).toBeNull();
    }
    // 行尾箭头已移除
    expect(el.querySelector('a.task-go')).toBeNull();
  });

  it('删除按钮带上是删哪个对象，而不是只有一个「删除」', () => {
    const el = render(<CharactersPage />);
    const labels = [...el.querySelectorAll('.btn-icon.is-danger')].map((node) =>
      node.getAttribute('aria-label'),
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label).toMatch(/删除.+「.+」/);
    }
  });
});
