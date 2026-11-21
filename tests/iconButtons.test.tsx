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
  // 新版故事向导默认第一步没有图标按钮（上一步在底部且禁用），不强制数量
  ['故事向导', () => <GuidePage />, false],
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

  it('故事向导：已完成步骤带勾图标，当前步骤有 aria-current', () => {
    const el = render(<GuidePage />);
    // 新版用顶部步骤条：完成步骤的 pill 里有 circle-check 图标
    const donePills = [...el.querySelectorAll('.guide-step-pill.done')];
    expect(donePills.length).toBeGreaterThan(0);
    expect(donePills[0]!.querySelector('.icon')).toBeTruthy();
    const current = el.querySelector('.guide-step-pill[aria-current="step"]');
    expect(current).toBeTruthy();
    expect((current!.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('主页阶段条/镜头/健康度都是语义化链接，且不含嵌套锚点', () => {
    const el = render(<HomePage />);
    const stageLinks = [...el.querySelectorAll<HTMLAnchorElement>('.stage-strip a.stage-step')];
    expect(stageLinks.length).toBe(4);
    for (const link of stageLinks) {
      expect((link.getAttribute('href') ?? '').startsWith('/')).toBe(true);
      expect((link.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(link.querySelector('a')).toBeNull();
    }
    const previewLinks = [...el.querySelectorAll<HTMLAnchorElement>('.shot-grid a.shot-tile')];
    expect(previewLinks.length).toBeGreaterThan(0);
    // 健康度面板整块可点：参考图 / 穿帮 / 存档
    expect(el.querySelector('a.panel-link[href="/storyboard?qc=1"]')).toBeTruthy();
    expect(el.querySelector('a.panel-link[href="/export"]')).toBeTruthy();
    expect(el.querySelector('a.asset[href="/characters"]')).toBeTruthy();
    expect(el.querySelector('a.asset[href="/scenes"]')).toBeTruthy();
    // 页面里没有嵌套锚点（新版用卡片链接，不是旧的整行待办）
    expect(el.querySelectorAll('a a').length).toBe(0);
    expect(el.querySelectorAll('a button, button a').length).toBe(0);
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
