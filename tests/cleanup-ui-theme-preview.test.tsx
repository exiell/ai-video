// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SettingsPage } from '../src/pages/SettingsPage';
import { THEMES } from '../src/store/theme';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 主题预览 CSS 的回归护栏
 *
 * ===========================================================================
 * 为什么单独盯这个
 * ===========================================================================
 * 批次5 清死 CSS 时，脚本按「全 src 静态引用」判断，把 .preview-night /
 * .preview-blueprint / .preview-blueprint .tp-card b 删了——但 SettingsPage
 * 的类名是 `theme-preview preview-${item.id}` 动态拼的，静态扫描看不到。
 * 结果：设置页外观里的夜间、蓝图两张预览卡退回了工作台配色。
 *
 * 这条测试同时锁两件事：
 *  1. CSS 里必须存在这三块规则（否则主题预览就退化了）；
 *  2. 页面渲染出的预览类名必须和 THEMES 的 id 一一对应。
 * 以后再有「无引用类清理」，删到这里会直接红。
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(REPO_ROOT, 'src/styles/global.css'), 'utf8');

function cssBlock(selector: string): string | null {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
    css,
  );
  return match?.[1] ?? null;
}

let container: HTMLDivElement | null = null;

function renderAppearance(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/settings/appearance']}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  const el = container;
  container = null;
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
});

describe('主题预览的动态类名', () => {
  it('CSS 保留夜间/蓝图配色与蓝图 serif 标题，页面类名和主题 id 对得上', () => {
    // 1) 三块规则必须存在，且关键变量不能丢
    const night = cssBlock('.preview-night');
    expect(night).toBeTruthy();
    expect(night).toContain('--tp-bg: #0b0d10;');
    expect(night).toContain('--tp-accent: #d6a45e;');

    const blueprint = cssBlock('.preview-blueprint');
    expect(blueprint).toBeTruthy();
    expect(blueprint).toContain('--tp-bg: #edf1f4;');
    expect(blueprint).toContain('--tp-accent: #0b5578;');

    const serifTitle = cssBlock('.preview-blueprint .tp-card b');
    expect(serifTitle).toBeTruthy();
    expect(serifTitle).toContain('font-family: var(--serif);');

    // 注释也要在：告诉下一次清理的人这是动态拼的类名
    expect(css).toContain('preview-${item.id}');
    expect(css).toMatch(/别按「无引用」删/);

    // 2) 页面渲染的预览类名 = THEMES 的 id，且夜间/蓝图都有对应 CSS 规则
    const el = renderAppearance();
    const previews = [...el.querySelectorAll('.theme-preview')];
    expect(previews.length).toBe(THEMES.length);
    const previewClasses = previews.map((node) =>
      [...node.classList].find((name) => name.startsWith('preview-')),
    );
    expect(previewClasses).toEqual(THEMES.map((theme) => `preview-${theme.id}`));
    expect(THEMES.map((theme) => theme.id)).toEqual(['studio', 'night', 'blueprint']);
    expect(cssBlock('.preview-night')).toBeTruthy();
    expect(cssBlock('.preview-blueprint')).toBeTruthy();
  });
});
