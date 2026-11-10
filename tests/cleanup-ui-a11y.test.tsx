// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { useState, act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from '../src/components/Layout';
import { ImageLightbox } from '../src/components/ImageLightbox';
import { ChatSidebar } from '../src/components/ChatSidebar';
import { ConfirmDialog } from '../src/components/bits';
import { PromptsPage } from '../src/pages/PromptsPage';
import { HomePage } from '../src/pages/HomePage';
import { CharactersPage } from '../src/pages/CharactersPage';
import { ScenesPage } from '../src/pages/ScenesPage';
import { StoryboardPage } from '../src/pages/StoryboardPage';
import { GuidePage } from '../src/pages/GuidePage';
import { ExportPage } from '../src/pages/ExportPage';
import { HelpPage } from '../src/pages/HelpPage';
import { ChecksPage } from '../src/pages/ChecksPage';
import { AboutPage } from '../src/pages/AboutPage';
import { SettingsPage } from '../src/pages/SettingsPage';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Asset } from '../src/types/model';

/**
 * 批次 5b 前端规范清理的可访问性护栏
 *
 * 这里锁四类结构契约：
 *  1. 跳过导航链接与 main 落点
 *  2. 标题层级不跳级（h1 → h2 → h3，不出现 h1 → h4）
 *  3. 灯箱翻页、对话栏开关、确认框焦点这些交互细节
 *  4. 剪贴板降级弹层与读屏播报区域
 *
 * jsdom 看不到布局，这里只断言 DOM 结构与可访问属性；视觉要实机验收。
 */

let container: HTMLDivElement | null = null;

function mount(children: React.ReactNode, entries: string[] = ['/']): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter initialEntries={entries}>{children}</MemoryRouter>);
  });
  const el = container;
  container = null;
  return el;
}

function render(node: React.ReactElement): HTMLDivElement {
  return mount(node);
}

function renderSettings(): HTMLDivElement {
  return mount(
    <Routes>
      <Route path="/settings/:section" element={<SettingsPage />} />
    </Routes>,
    ['/settings/connection'],
  );
}

function click(target: Element | null | undefined): void {
  if (!target) return;
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function expandFirst(root: HTMLElement): void {
  click(root.querySelector('.expand-toggle'));
}

function fakeAsset(id: string): Asset {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    id,
    projectId: 'p1',
    kind: 'first-frame',
    refId: 'shot-1',
    dataUrl: 'data:image/png;base64,AAAA',
    mimeType: 'image/png',
    promptSnapshot: 'test',
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
});

describe('跳过导航与 main 落点', () => {
  it('首元素是跳到主要内容的链接，main 有对应 id 且可聚焦', () => {
    const el = render(
      <Layout>
        <div>正文</div>
      </Layout>,
    );
    const skip = el.querySelector('a.skip-link');
    expect(skip?.getAttribute('href')).toBe('#main-content');
    expect((skip?.textContent ?? '').trim().length).toBeGreaterThan(0);
    const main = el.querySelector('main#main-content');
    expect(main).toBeTruthy();
    expect(main?.getAttribute('tabindex')).toBe('-1');
  });

  it('global.css 里 skip-link 与 sr-only 都有样式', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/styles/global.css'), 'utf8');
    expect(css).toMatch(/\.skip-link\s*\{/);
    expect(css).toMatch(/\.sr-only\s*\{/);
  });
});

describe('标题层级不跳级', () => {
  const PAGES: Array<[string, () => HTMLDivElement]> = [
    ['作品主页', () => render(<HomePage />)],
    [
      '角色页',
      () => {
        const el = render(<CharactersPage />);
        expandFirst(el);
        return el;
      },
    ],
    [
      '场景页',
      () => {
        const el = render(<ScenesPage />);
        expandFirst(el);
        return el;
      },
    ],
    [
      '分镜页',
      () => {
        const el = render(<StoryboardPage />);
        expandFirst(el);
        return el;
      },
    ],
    ['故事向导', () => render(<GuidePage />)],
    ['导出页', () => render(<ExportPage />)],
    ['帮助页', () => render(<HelpPage />)],
    [
      '检查页',
      () => {
        // 正常流程里 report 由 setProject 同步算出；这里直接给一份空报告
        useAppStore.setState({
          report: { issues: [], checkedAt: new Date().toISOString(), counts: { error: 0, warning: 0, info: 0 } },
        });
        return render(<ChecksPage />);
      },
    ],
    ['提示词页', () => render(<PromptsPage />)],
    ['关于页', () => render(<AboutPage />)],
    ['设置页 · 连接与 Key', renderSettings],
  ];

  for (const [name, make] of PAGES) {
    it(`${name}：第一个标题是 h1，且相邻标题层级最多深一级`, () => {
      const el = make();
      const levels = [...el.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((node) =>
        Number(node.tagName.slice(1)),
      );
      expect(levels.length).toBeGreaterThan(0);
      expect(levels[0]).toBe(1);
      for (let i = 1; i < levels.length; i += 1) {
        expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
      }
    });
  }
});

describe('灯箱与对话栏的交互标签', () => {
  it('灯箱上一张 / 下一张有 aria-label，不只靠箭头字符', () => {
    const el = render(
      <ImageLightbox
        state={{ assets: [fakeAsset('a'), fakeAsset('b')], index: 0 }}
        onClose={() => undefined}
        onNavigate={() => undefined}
      />,
    );
    const labels = [...el.querySelectorAll('button')].map((node) => node.getAttribute('aria-label'));
    expect(labels).toContain('上一张');
    expect(labels).toContain('下一张');
  });

  it('对话栏开关通过 aria-controls 指向面板', () => {
    const el = render(<ChatSidebar />);
    const toggle = el.querySelector('.chat-toggle');
    expect(toggle?.getAttribute('aria-controls')).toBe('chat-panel');
    expect(el.querySelector('#chat-panel')).toBeTruthy();
  });
});

describe('确认框焦点', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button id="open-dialog" type="button" onClick={() => setOpen(true)}>
          打开
        </button>
        <ConfirmDialog
          open={open}
          title="确认"
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        >
          内容
        </ConfirmDialog>
      </div>
    );
  }

  it('打开时焦点进弹窗，Tab 不跑出，关闭后回到触发按钮', () => {
    const el = render(<Harness />);
    const trigger = el.querySelector('#open-dialog') as HTMLButtonElement;
    act(() => trigger.focus());
    click(trigger);

    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.confirm-actions button')];
    expect(buttons.length).toBe(2);
    const [cancel, confirm] = buttons as [HTMLButtonElement, HTMLButtonElement];
    expect(document.activeElement).toBe(cancel);

    // 焦点在最后一个按钮时按 Tab，应回到第一个
    act(() => confirm.focus());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(cancel);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('读屏播报与剪贴板降级', () => {
  it('提示词页有 aria-live 的状态区域', () => {
    const el = render(<PromptsPage />);
    expect(el.querySelector('[aria-live="polite"]')).toBeTruthy();
  });

  it('剪贴板不可用时弹只读文本框，而不是 window.prompt', async () => {
    const el = render(<PromptsPage />);
    const copyButton = [...el.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('复制'),
    );
    expect(copyButton).toBeTruthy();
    await act(async () => {
      copyButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const dialogTitle = [...document.querySelectorAll('.confirm-title')].find((node) =>
      (node.textContent ?? '').includes('复制失败'),
    );
    expect(dialogTitle).toBeTruthy();
    const area = document.querySelector('.confirm-card textarea') as HTMLTextAreaElement | null;
    expect(area).toBeTruthy();
    expect((area?.value ?? '').length).toBeGreaterThan(0);
  });

  it('wizard-state 在样式里保持视觉隐藏，不再用 display:none 把状态文字丢掉', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/styles/global.css'), 'utf8');
    const stateBlocks = [...css.matchAll(/\.wizard-state\s*\{[^}]*\}/g)].map((m) => m[0]);
    expect(stateBlocks.length).toBeGreaterThan(0);
    for (const block of stateBlocks) {
      expect(block).not.toContain('display: none');
    }
    expect(css).toMatch(/\.wizard-state\s*\{[^}]*clip:/);
  });
});
