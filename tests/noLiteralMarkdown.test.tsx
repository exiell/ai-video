// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { GuidePage } from '../src/pages/GuidePage';
import { HomePage } from '../src/pages/HomePage';
import { SettingsPage } from '../src/pages/SettingsPage';
import { HelpPage } from '../src/pages/HelpPage';
import { StoryboardPage } from '../src/pages/StoryboardPage';
import { CharactersPage } from '../src/pages/CharactersPage';
import { ScenesPage } from '../src/pages/ScenesPage';
import { useAppStore, makeEmptyProject } from '../src/store/app';
import { useImage } from '../src/store/image';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 全页面「不能出现字面星号」的回归测试（v0.29）
 *
 * ===========================================================================
 * 为什么值得单独测
 * ===========================================================================
 * 项目里很多文案是照 Markdown 习惯写的，例如「这一步会**覆盖**现有内容」。
 * 但 **JSX 不解析 Markdown** —— 直接写进 JSX 文本，用户看到的是字面的星号。
 *
 * 这类问题在源码里读起来完全正常（甚至更好读），只有真渲染出来才看得见。
 * 所以不能靠"看代码"发现，只能靠渲染断言。
 *
 * 这个测试覆盖所有面向用户的主要页面。
 */

let container: HTMLDivElement | null = null;

function renderPage(node: React.ReactElement): string {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  const html = container.innerHTML;
  act(() => root.unmount());
  container.remove();
  container = null;
  return html;
}

const PAGES: Array<[string, React.ReactElement]> = [
  ['首页', <HomePage />],
  ['引导向导', <GuidePage />],
  ['分镜表', <StoryboardPage />],
  ['角色设定', <CharactersPage />],
  ['场景设定', <ScenesPage />],
  ['设置', <SettingsPage />],
  ['帮助', <HelpPage />],
];

describe('渲染结果里不能有字面星号', () => {
  beforeEach(() => {
    useAppStore.setState({ project: null, report: null, dirty: false, revision: 0, saveError: null });
    useImage.setState({ gallery: {}, feedback: {}, batch: null, batchSummary: null });
  });

  for (const [name, node] of PAGES) {
    it(`${name}：无项目时不崩`, () => {
      expect(() => renderPage(node)).not.toThrow();
    });

    it(`**${name}：有项目时渲染结果里没有字面星号**`, () => {
      useAppStore.setState({ project: sampleProject });
      const html = renderPage(node);
      // 找出含 ** 的片段，方便定位
      const offenders = html.match(/.{0,40}\*\*.{0,40}/g) ?? [];
      expect(offenders, `${name} 里出现了字面星号：\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('空项目下也没有字面星号', () => {
    useAppStore.setState({ project: makeEmptyProject('空') });
    for (const [name, node] of PAGES) {
      const offenders = renderPage(node).match(/.{0,30}\*\*.{0,30}/g) ?? [];
      expect(offenders, `${name} 里出现了字面星号`).toEqual([]);
    }
  });
});

/**
 * 把向导切到最后一步（「完成」），返回挂载容器。
 *
 * 原来这条用例只断言 `typeof html === 'string'`——那是个占位断言，
 * 测不到标题里声称的顺序。这里真的点一下最后一步，再按 DOM 顺序断言。
 */
function renderGuideAtFinishStep(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <GuidePage />
      </MemoryRouter>,
    );
  });
  const steps = [...container.querySelectorAll<HTMLButtonElement>('.wizard-step')];
  expect(steps.length).toBeGreaterThan(0);
  act(() => {
    steps[steps.length - 1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return container;
}

describe('引导向导「4. 完成」把 AI 流程放在手动手册之前', () => {
  beforeEach(() => {
    useAppStore.setState({ project: makeEmptyProject('向导'), report: null, dirty: false, revision: 0, saveError: null });
    useImage.setState({ gallery: {}, feedback: {}, batch: null, batchSummary: null });
  });

  it('**AI 生成流程出现在页面上，且排在手动清单前面**', () => {
    const el = renderGuideAtFinishStep();

    const manual = el.querySelector('details.manual-guide');
    expect(manual, '第 4 步应该有「也可以全程手动」的折叠区').toBeTruthy();

    const aiCard =
      [...el.querySelectorAll('.card')].find((card) =>
        (card.textContent ?? '').includes('让 AI 先生成'),
      ) ?? null;
    expect(aiCard, '第 4 步应该有 AI 生成流程卡片').toBeTruthy();

    const relation = aiCard!.compareDocumentPosition(manual!);
    expect(
      relation & Node.DOCUMENT_POSITION_FOLLOWING,
      'AI 生成流程必须排在手动清单前面（新手先看到省事的那条路）',
    ).toBeTruthy();
  });
});
