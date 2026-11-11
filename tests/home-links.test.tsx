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
 * 主页「条目本身可点」的新契约
 *
 * 旧版是「行尾一个 → 箭头 Link」，用户得对准小图标才能点。现在：
 *  - 待办行：整行/标题是 <Link>，href 完整映射到 task.to；
 *  - 穿帮检查、存档：整个面板是 <Link>；
 *  - 参考图：两条进度各自是 <Link>，aria-label 与可见文字一致。
 *
 * 这里锁四件事：
 *  1. 全部是语义化锚点（带 href），不是 onClick 模拟；
 *  2. 链接可访问文本包含用户看到的文字；
 *  3. 页面里没有嵌套锚点（a a / a 内套 button）；
 *  4. 面板 hover/focus 规则经过级联计算后确实生效（不是被后面的
 *     `.home-rail .panel { background: transparent; border: 0 }` 盖掉）。
 *
 * 视觉与鼠标点击手感要实机验收。
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

// ---------------------------------------------------------------------------
// 极简 CSS 解析：只用于验证「整块可点的面板」的 hover/focus 会被级联覆盖
// ---------------------------------------------------------------------------

interface CssRule {
  selector: string;
  decls: Record<string, string>;
  index: number;
}

function rulesOf(source: string): CssRule[] {
  const rules: CssRule[] = [];
  let i = 0;
  let index = 0;
  const matchBrace = (start: number): number => {
    let depth = 0;
    let j = start;
    while (j < source.length) {
      if (source.startsWith('/*', j)) {
        const end = source.indexOf('*/', j + 2);
        j = end < 0 ? source.length : end + 2;
        continue;
      }
      const ch = source[j]!;
      if (ch === '"' || ch === "'") {
        const quote = ch;
        j += 1;
        while (j < source.length && source[j] !== quote) {
          if (source[j] === '\\') j += 1;
          j += 1;
        }
        j += 1;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) return j;
      }
      j += 1;
    }
    throw new Error('CSS 花括号不配平');
  };

  while (i < source.length) {
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    const brace = source.indexOf('{', i);
    if (brace < 0) break;
    const selector = source.slice(i, brace).trim().replace(/\s+/g, ' ');
    const close = matchBrace(brace);
    if (!selector.startsWith('@')) {
      const decls: Record<string, string> = {};
      for (const part of source.slice(brace + 1, close).split(';')) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        const prop = part.slice(0, colon).trim().toLowerCase();
        const value = part.slice(colon + 1).trim();
        if (prop && value) decls[prop] = value;
      }
      rules.push({ selector, decls, index: index++ });
    }
    i = close + 1;
  }
  return rules;
}

/** 极简特异性：只数 id / class（含属性、伪类）/ 元素。本测试的选择器没有 id。 */
function specificity(selector: string): number {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classLike = selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)?.length ?? 0;
  const elements = selector.replace(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g, ' ').match(/(^|[\s>+~])([a-zA-Z][\w-]*)/g)?.length ?? 0;
  return ids * 10000 + classLike * 100 + elements;
}

/**
 * 在「某状态下命中该元素」的候选选择器里，按级联规则（特异性优先、
 * 同特异性后出现者胜）算出某个属性的最终值。
 */
function winningDeclaration(
  rules: CssRule[],
  candidates: string[],
  prop: string,
): { selector: string; value: string } | null {
  let best: { selector: string; value: string; spec: number; index: number } | null = null;
  for (const rule of rules) {
    if (!candidates.includes(rule.selector)) continue;
    const value = rule.decls[prop];
    if (!value) continue;
    const spec = specificity(rule.selector);
    if (!best || spec > best.spec || (spec === best.spec && rule.index > best.index)) {
      best = { selector: rule.selector, value, spec, index: rule.index };
    }
  }
  return best ? { selector: best.selector, value: best.value } : null;
}

const PANEL_BASE_SELECTORS = ['.panel', '.home-rail .panel', '.panel-link'];
const PANEL_HOVER_SELECTORS = [...PANEL_BASE_SELECTORS, '.home-rail .panel.panel-link:hover'];
const PANEL_FOCUS_SELECTORS = [
  ...PANEL_BASE_SELECTORS,
  '.home-rail .panel.panel-link:focus-visible',
];

beforeEach(() => {
  document.body.innerHTML = '';
  useAppStore.setState({ project: structuredClone(sampleProject), report: null, saveError: null });
  useImage.setState({ gallery: {} });
});

describe('待办行：整行是链接', () => {
  it('每个待办行都有带 href 的整行链接，href 与标题的映射完整且无误', () => {
    const el = render();
    const rows = [...el.querySelectorAll('.task-list > li')];
    // 示例项目：时长不符 + 提示词 + 导出，三条待办（顺序固定）
    const expected: Array<[string, string]> = [
      ['再补 12 秒', '/storyboard'],
      ['提示词', '/prompts'],
      ['导出', '/export'],
    ];
    expect(rows.length).toBe(expected.length);
    const actual = rows.map((row) => {
      const link = row.querySelector('a[href]');
      expect(link).toBeTruthy();
      const title = (row.querySelector('.task-main b')?.textContent ?? '').trim();
      return [title, link!.getAttribute('href')] as [string, string];
    });
    expect(actual).toEqual(expected);
    // 旧的行尾箭头已经不存在
    expect(el.querySelector('.task-go')).toBeNull();
  });

  it('没有用 onClick 模拟跳转：四个入口都是语义化链接，且源码里无 onClick', () => {
    const el = render();
    // DOM 层：链接没有内联 onclick 属性
    for (const link of el.querySelectorAll('a')) {
      expect(link.hasAttribute('onclick')).toBe(false);
    }
    // 源码层：task-row / panel-link / asset 的 <Link> 开标签里不应出现 onClick
    const markers = [
      'className="task-row"',
      'className="panel panel-link"',
      'className="panel panel-link save-panel"',
      'className="asset"',
    ];
    for (const marker of markers) {
      let from = 0;
      let found = 0;
      for (;;) {
        const at = homeSource.indexOf(marker, from);
        if (at < 0) break;
        found += 1;
        const tagStart = homeSource.lastIndexOf('<Link', at);
        const tagEnd = homeSource.indexOf('>', at);
        expect(tagStart).toBeGreaterThan(-1);
        const openingTag = homeSource.slice(tagStart, tagEnd + 1);
        expect(openingTag).not.toContain('onClick');
        from = at + marker.length;
      }
      expect(found).toBeGreaterThan(0);
    }
    expect(homeSource).not.toMatch(/onClick=\{\(\)\s*=>\s*navigate\(/);
  });
});

describe('面板：整块可点', () => {
  it('穿帮检查面板是 /checks 链接，链接文本包含标题与必改项', () => {
    const el = render();
    const link = el.querySelector<HTMLAnchorElement>('.home-rail a.panel-link[href="/checks"]');
    expect(link).toBeTruthy();
    const text = (link!.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('穿帮检查');
    expect(text).toContain('必改项');
    assertNoNestedAnchors(el);
  });

  it('存档面板是 /export 链接，链接文本包含标题与保存状态，saveError 仍显示', () => {
    useAppStore.setState({ saveError: '没存上：本机存储空间不够。' });
    const el = render();
    const link = el.querySelector<HTMLAnchorElement>(
      '.home-rail a.panel-link.save-panel[href="/export"]',
    );
    expect(link).toBeTruthy();
    const text = (link!.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('存档');
    expect(text).toContain('保存状态');
    expect(text).toContain('本机存储空间不够');
    assertNoNestedAnchors(el);
  });
});

describe('参考图：两条进度各自可点', () => {
  it('角色形象图条目是 /characters 链接，场景参考板是 /scenes 链接，aria-label 可读', () => {
    const el = render();
    const charLink = el.querySelector<HTMLAnchorElement>('a.asset[href="/characters"]');
    const sceneLink = el.querySelector<HTMLAnchorElement>('a.asset[href="/scenes"]');
    expect(charLink).toBeTruthy();
    expect(sceneLink).toBeTruthy();
    expect(charLink!.getAttribute('aria-label')).toContain('角色设定');
    expect(charLink!.getAttribute('aria-label')).toContain('角色形象图');
    expect(sceneLink!.getAttribute('aria-label')).toContain('场景设定');
    expect(sceneLink!.getAttribute('aria-label')).toContain('场景参考板');
    // aria-label 里的进度写法要与可见文字一致（「x / y」，不是「x/y」）
    expect(charLink!.getAttribute('aria-label')).toMatch(/\d+ \/ \d+/);
    expect(sceneLink!.getAttribute('aria-label')).toMatch(/\d+ \/ \d+/);
    assertNoNestedAnchors(el);
    // 旧的箭头容器已移除
    expect(el.querySelector('.asset-links')).toBeNull();
  });
});

describe('最近镜头的文字链接保持不变', () => {
  it('「看全部 N 镜」仍是带 href 的文字链接', () => {
    const el = render();
    const link = [...el.querySelectorAll<HTMLAnchorElement>('a[href="/storyboard"]')].find((node) =>
      (node.textContent ?? '').includes('看全部'),
    );
    expect(link).toBeTruthy();
    assertNoNestedAnchors(el);
  });
});

describe('hover / focus：级联后确实生效', () => {
  const rules = rulesOf(css);

  it('右栏整块面板 hover 的 background 赢过 .home-rail .panel 的 transparent', () => {
    const baseBg = winningDeclaration(rules, PANEL_BASE_SELECTORS, 'background');
    expect(baseBg?.value).toBe('transparent');

    const hoverBg = winningDeclaration(rules, PANEL_HOVER_SELECTORS, 'background');
    expect(hoverBg).toBeTruthy();
    // 最终生效的选择器必须是 hover 规则，而不是被 .home-rail .panel 盖掉
    expect(hoverBg!.selector).toBe('.home-rail .panel.panel-link:hover');
    expect(hoverBg!.value).toBe('var(--bg-hover)');
    expect(hoverBg!.value).not.toBe(baseBg!.value);

    // 右栏本来没有卡片边框，用 inset box-shadow 画描边，不改变布局
    const hoverShadow = winningDeclaration(rules, PANEL_HOVER_SELECTORS, 'box-shadow');
    expect(hoverShadow?.selector).toBe('.home-rail .panel.panel-link:hover');
    expect(hoverShadow?.value).toContain('inset 0 0 0 1px var(--border-strong)');
  });

  it('右栏整块面板 focus-visible 的 outline 级联后生效', () => {
    const focusOutline = winningDeclaration(rules, PANEL_FOCUS_SELECTORS, 'outline');
    expect(focusOutline?.selector).toBe('.home-rail .panel.panel-link:focus-visible');
    expect(focusOutline?.value).toContain('2px solid var(--accent)');
    // 规则要放在 .home-rail .panel 之后，方便维护
    const railIndex = rules.find((rule) => rule.selector === '.home-rail .panel')?.index ?? -1;
    const hoverIndex =
      rules.find((rule) => rule.selector === '.home-rail .panel.panel-link:hover')?.index ?? -1;
    expect(railIndex).toBeGreaterThan(-1);
    expect(hoverIndex).toBeGreaterThan(railIndex);
  });

  it('待办行 / 参考图条目的 hover 与 focus 样式仍在，旧箭头样式已删', () => {
    for (const selector of [
      '.task-row:hover',
      '.task-row:focus-visible',
      '.asset:hover',
      '.asset:focus-visible',
    ]) {
      expect(css).toContain(selector);
    }
    expect(css).not.toContain('.task-go');
    expect(css).not.toContain('.asset-links');
  });
});
