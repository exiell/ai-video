// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from '../src/pages/HomePage';
import { useAppStore } from '../src/store/app';
import { useImage } from '../src/store/image';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 作品主页「条目本身可点」的新契约（新版 UI）
 *
 * 新版主页不再是「待办行/右栏卡片」，改成：
 *  - 四步阶段条：每步是 <Link>，对应 /guide /assets /storyboard /delivery；
 *  - 镜头预览：每个镜头是 <Link to=/storyboard?shot=...>，标题行「全部 N 镜 →」也是链接；
 *  - 健康度三联卡：参考图两条 asset 链接、穿帮检查与存档整卡是 panel-link。
 *
 * 这里锁四件事：
 *  1. 全部是语义化锚点（带 href），不是 onClick 模拟；
 *  2. 链接可访问文本包含用户看到的文字；
 *  3. 页面里没有嵌套锚点（a a / a 内套 button）；
 *  4. 关键 hover/focus 样式仍在 CSS 里（资产条目、阶段条）。
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(REPO_ROOT, 'src/styles/global.css'), 'utf8');
const homeSource = fs.readFileSync(path.join(REPO_ROOT, 'src/pages/HomePage.tsx'), 'utf8');

let container: HTMLDivElement | null = null;

function render(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
  });
  const el = container;
  container = null;
  return el;
}

function assertNoNestedAnchors(el: HTMLElement): void {
  for (const link of el.querySelectorAll('a')) {
    expect(link.querySelector('a')).toBeNull();
    expect(link.querySelector('button')).toBeNull();
  }
  expect(el.querySelectorAll('a a').length).toBe(0);
  expect(el.querySelectorAll('a button, button a').length).toBe(0);
}

beforeEach(() => {
  document.body.innerHTML = '';
  useAppStore.setState({ project: structuredClone(sampleProject), report: null, saveError: null });
  useImage.setState({ gallery: {} });
});

describe('四步阶段条：每一步都是语义化链接', () => {
  it('4 个阶段都有 href，路由与新版页面一致', () => {
    const el = render();
    const links = [...el.querySelectorAll<HTMLAnchorElement>('.stage-strip a.stage-step')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/guide',
      '/assets',
      '/storyboard',
      '/delivery',
    ]);
    const names = links.map((link) =>
      (link.querySelector('.stage-step-name')?.textContent ?? '').trim(),
    );
    expect(names).toEqual(['01 故事', '02 设定集', '03 分镜与质检', '04 交付中心']);
    assertNoNestedAnchors(el);
  });

  it('没有用 onClick 模拟跳转', () => {
    const el = render();
    for (const link of el.querySelectorAll('a')) {
      expect(link.hasAttribute('onclick')).toBe(false);
    }
    expect(homeSource).not.toMatch(/onClick=\{\(\)\s*=>\s*navigate\(/);
  });
});

describe('镜头预览：整卡可点', () => {
  it('镜头卡是 /storyboard?shot= 链接，缩略信息在链接内', () => {
    const el = render();
    const tiles = [...el.querySelectorAll<HTMLAnchorElement>('.shot-grid a.shot-tile')];
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      const href = tile.getAttribute('href') ?? '';
      expect(href.startsWith('/storyboard?shot=')).toBe(true);
      expect((tile.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
    assertNoNestedAnchors(el);
  });

  it('「全部 N 镜」是带 href 的链接', () => {
    const el = render();
    const link = [...el.querySelectorAll<HTMLAnchorElement>('a[href="/storyboard"]')].find((node) =>
      (node.textContent ?? '').includes('全部'),
    );
    expect(link).toBeTruthy();
    expect(link!.textContent ?? '').toContain(`${sampleProject.shots.length} 镜`);
    assertNoNestedAnchors(el);
  });
});

describe('健康度三联卡：整块可点 + 参考图条目可点', () => {
  it('穿帮检查与存档面板是 /storyboard?qc=1 与 /export 链接', () => {
    const el = render();
    const check = el.querySelector<HTMLAnchorElement>('a.panel-link[href="/storyboard?qc=1"]');
    expect(check).toBeTruthy();
    expect(check!.textContent ?? '').toContain('穿帮检查');
    expect(check!.textContent ?? '').toContain('必改项');

    const save = el.querySelector<HTMLAnchorElement>('a.panel-link.save-panel[href="/export"]');
    expect(save).toBeTruthy();
    expect(save!.textContent ?? '').toContain('本机存档');
    expect(save!.textContent ?? '').toContain('保存状态');
    assertNoNestedAnchors(el);
  });

  it('saveError 仍在存档面板里显示', () => {
    useAppStore.setState({ saveError: '没存上：本机存储空间不够。' });
    const el = render();
    const save = el.querySelector<HTMLAnchorElement>('a.panel-link.save-panel[href="/export"]');
    expect(save).toBeTruthy();
    expect(save!.textContent ?? '').toContain('本机存储空间不够');
    expect(save!.querySelector('.asset-note')).toBeTruthy();
  });

  it('角色形象图与场景参考板各自是链接，aria-label 与进度写法可读', () => {
    const el = render();
    const charLink = el.querySelector<HTMLAnchorElement>('a.asset[href="/characters"]');
    const sceneLink = el.querySelector<HTMLAnchorElement>('a.asset[href="/scenes"]');
    expect(charLink).toBeTruthy();
    expect(sceneLink).toBeTruthy();
    expect(charLink!.getAttribute('aria-label')).toContain('角色设定');
    expect(charLink!.getAttribute('aria-label')).toContain('角色形象图');
    expect(sceneLink!.getAttribute('aria-label')).toContain('场景设定');
    expect(sceneLink!.getAttribute('aria-label')).toContain('场景参考板');
    // 进度写法要与可见文字一致（「x / y」）
    expect(charLink!.getAttribute('aria-label')).toMatch(/\d+ \/ \d+/);
    expect(sceneLink!.getAttribute('aria-label')).toMatch(/\d+ \/ \d+/);
    assertNoNestedAnchors(el);
  });
});

describe('hover / focus 样式仍在', () => {
  it('资产条目与阶段条的 hover/focus 规则还在', () => {
    for (const selector of ['.asset:hover', '.asset:focus-visible', '.stage-step:hover']) {
      expect(css).toContain(selector);
    }
    // 整块面板链接有基础样式
    expect(css).toContain('.panel-link');
  });
});
