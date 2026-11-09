// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CharactersPage } from '../src/pages/CharactersPage';
import { ScenesPage } from '../src/pages/ScenesPage';
import { StoryboardPage } from '../src/pages/StoryboardPage';
import { GuidePage } from '../src/pages/GuidePage';
import { ExportPage } from '../src/pages/ExportPage';
import { HelpPage } from '../src/pages/HelpPage';
import { SettingsPage } from '../src/pages/SettingsPage';
import { ChatSidebar } from '../src/components/ChatSidebar';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 每个表单控件都要有可读的名字
 *
 * ===========================================================================
 * 为什么盯这个
 * ===========================================================================
 * 视觉上每个输入框旁边都有「起点」「锁面」「场次名」这样的标签，
 * 但那些标签很多是 `<div className="field-label">`，不是 `<label>`。
 * 对读屏软件来说，这些控件就是「编辑框」「文本区」，用户不知道自己在填什么。
 *
 * 规则（和 iconButtons.test.tsx 的「图标按钮必须有名字」同一类）：
 *   每个 input / textarea / select 必须至少满足一条：
 *     1. 被 <label> 包着（Field 组件走的是这条）
 *     2. 有非空 aria-label / aria-labelledby
 *     3. 有 id，且页面上有 label[for=id]
 *
 * 这是结构契约测试，不验证「标签写得对不对」——那要人看。
 * 它守的是「以后别再往表单里塞一个没有任何名字的控件」。
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

/** 设置页用嵌套路由区分四个子视图，需要把 /settings/:section 真的注册上 */
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

function unnamedControls(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>('input, textarea, select')];
  return all.filter((control) => {
    if (control.closest('label')) return false;
    if (control.getAttribute('aria-label')?.trim()) return false;
    if (control.getAttribute('aria-labelledby')?.trim()) return false;
    const id = control.getAttribute('id');
    if (id) {
      const quoted = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      if (root.querySelector(`label[for="${quoted}"]`)) return false;
    }
    return true;
  });
}

function describeControl(control: HTMLElement): string {
  const tag = control.tagName.toLowerCase();
  const type = control.getAttribute('type');
  const placeholder = control.getAttribute('placeholder');
  return `<${tag}${type ? ` type=${type}` : ''}${placeholder ? ` placeholder=${placeholder}` : ''}>`;
}

beforeEach(() => {
  document.body.innerHTML = '';
  useAppStore.getState().setProject(structuredClone(sampleProject));
});

const PAGES: Array<[string, () => HTMLDivElement]> = [
  [
    '角色页',
    () => {
      const el = render(<CharactersPage />);
      expandFirst(el); // 展开后才会渲染锁名 / 锁面 / 变体名这些输入框
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
      expandFirst(el); // 展开这一镜才会渲染起点 / 终点 / 台词 / 机位等输入框
      return el;
    },
  ],
  [
    '故事向导',
    () => {
      const el = render(<GuidePage />);
      const step = [...el.querySelectorAll('button')].find((node) =>
        (node.textContent ?? '').includes('故事正文'),
      );
      click(step); // 场次行的两个输入框在这一步
      return el;
    },
  ],
  ['导出页', () => render(<ExportPage />)],
  ['帮助页', () => render(<HelpPage />)],
  ['设置页 · 连接与 Key', renderSettings],
  [
    '对话栏',
    () => {
      const el = render(<ChatSidebar />);
      click(el.querySelector('.chat-toggle')); // 收起态不渲染输入框
      return el;
    },
  ],
];

describe('表单控件的可访问名', () => {
  for (const [name, make] of PAGES) {
    it(`${name}：每个输入框都有 label 或 aria-label`, () => {
      const el = make();
      const controls = el.querySelectorAll('input, textarea, select');
      // 先确认这个状态真的渲染出了控件，避免断言空集合变成假覆盖
      expect(controls.length).toBeGreaterThan(0);
      expect(unnamedControls(el).map(describeControl)).toEqual([]);
    });
  }
});
