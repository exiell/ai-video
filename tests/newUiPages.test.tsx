// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AssetsPage } from '../src/pages/AssetsPage';
import { DeliveryPage } from '../src/pages/DeliveryPage';
import { useAppStore } from '../src/store/app';
import { useImage } from '../src/store/image';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 新版「设定集 / 交付中心」两个聚合页要有真实的渲染回归。
 *
 * 主页测试只能证明阶段条 href 指向 /assets 与 /delivery；这里直接渲染页面，
 * 锁住：
 *  - 两个聚合页的标题与 tab 结构；
 *  - 路由 /assets、/scenes、/delivery、/export 能决定默认 tab；
 *  - 切换 tab 后 aria-selected 跟着变（而不是只有视觉样式）。
 */

let container: HTMLDivElement | null = null;

function render(node: React.ReactElement, initialEntries: string[] = ['/']): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={initialEntries}>
        {node}
      </MemoryRouter>,
    );
  });
  const el = container;
  container = null;
  return el;
}

function tab(el: HTMLElement, name: string): HTMLButtonElement {
  const match = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) =>
    (node.textContent ?? '').includes(name),
  );
  if (!match) throw new Error(`找不到 tab：${name}`);
  return match;
}

function click(target: HTMLElement): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  useAppStore.setState({ project: structuredClone(sampleProject), report: null, saveError: null });
  useImage.setState({ gallery: {}, loadGallery: async () => {} });
});

describe('设定集聚合页', () => {
  it('渲染标题与角色/场景两个 tab，默认显示角色', () => {
    const el = render(<AssetsPage initialTab="characters" />);
    expect(el.querySelector('h1')?.textContent).toContain('设定集');
    expect(tab(el, '角色').getAttribute('aria-selected')).toBe('true');
    expect(tab(el, '场景').getAttribute('aria-selected')).toBe('false');
  });

  it('主路由为 /scenes 时默认选中场景 tab', () => {
    const el = render(<AssetsPage initialTab="characters" />, ['/scenes']);
    expect(tab(el, '场景').getAttribute('aria-selected')).toBe('true');
    expect(tab(el, '角色').getAttribute('aria-selected')).toBe('false');
  });

  it('点场景 tab 后 aria-selected 切到场景', () => {
    const el = render(<AssetsPage initialTab="characters" />);
    click(tab(el, '场景'));
    expect(tab(el, '场景').getAttribute('aria-selected')).toBe('true');
    expect(tab(el, '角色').getAttribute('aria-selected')).toBe('false');
  });
});

describe('交付中心聚合页', () => {
  it('渲染标题与提示词/打包与备份两个 tab，默认显示提示词', () => {
    const el = render(<DeliveryPage initialTab="prompts" />);
    expect(el.querySelector('h1')?.textContent).toContain('交付中心');
    expect(tab(el, '提示词').getAttribute('aria-selected')).toBe('true');
    expect(tab(el, '打包与备份').getAttribute('aria-selected')).toBe('false');
  });

  it('主路由为 /export 时默认选中打包与备份 tab', () => {
    const el = render(<DeliveryPage initialTab="prompts" />, ['/export']);
    expect(tab(el, '打包与备份').getAttribute('aria-selected')).toBe('true');
    expect(tab(el, '提示词').getAttribute('aria-selected')).toBe('false');
  });

  it('点提示词 tab 后 aria-selected 切回提示词', () => {
    const el = render(<DeliveryPage initialTab="export" />);
    click(tab(el, '提示词'));
    expect(tab(el, '提示词').getAttribute('aria-selected')).toBe('true');
    expect(tab(el, '打包与备份').getAttribute('aria-selected')).toBe('false');
  });
});
