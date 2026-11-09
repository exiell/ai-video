// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { StoryboardPage } from '../src/pages/StoryboardPage';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 分镜列表的「一眼」原则
 *
 * ===========================================================================
 * 为什么盯这个
 * ===========================================================================
 * 一屏七八个镜头时，每张卡下面的任何一行小字都会乘以七八倍。
 * 原来每张卡底部有一行「起点：… · 场景：…」——
 * 场景在表头已经选过了，起点展开就能看到，这行只是把同样的信息又说一遍。
 *
 * 现在每张折叠卡只允许有：
 *   表头（镜号 / 时长 / 景别 / 运镜 / 场景 / 动作 / 看图 / 问题数 / 更多 / 展开）
 *   + 有问题的字段各一行
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

describe('分镜折叠行只留核心信息', () => {
  it('每张折叠卡不再有「起点：… 场景：…」这行摘要', () => {
    const el = render(<StoryboardPage />);
    const cards = [...el.querySelectorAll('.shot-card')];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      // 那行摘要原来是 <div className="hint">起点：… · 场景：…</div>
      expect(card.querySelectorAll('.hint').length).toBe(0);
      expect((card.textContent ?? '').includes('起点：')).toBe(false);
    }
  });

  it('折叠卡里没有 field-help 这类字段说明（说明只在展开面板里）', () => {
    const el = render(<StoryboardPage />);
    for (const card of el.querySelectorAll('.shot-card')) {
      expect(card.querySelectorAll('.field-help').length).toBe(0);
    }
  });

  it('动作在表头里就是可编辑输入框，不需要先展开', () => {
    const el = render(<StoryboardPage />);
    const first = el.querySelector('.shot-card')!;
    const action = first.querySelector('.shot-head input.shot-action') as HTMLInputElement;
    expect(action).toBeTruthy();
    expect(action.value.length).toBeGreaterThan(0);
  });

  it('顶栏不再挂「单镜上限约 N 秒」这种参考常量', () => {
    const el = render(<StoryboardPage />);
    expect((el.textContent ?? '').includes('单镜上限')).toBe(false);
  });

  it('展开后四个板块里，声音与剪辑两段默认收起', () => {
    const el = render(<StoryboardPage />);
    const toggle = el.querySelector('.shot-card .expand-toggle') as HTMLButtonElement;
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const sections = [...el.querySelectorAll('.shot-card .shot-section')];
    const closed = sections.filter((node) => node.tagName === 'DETAILS' && !node.hasAttribute('open'));
    expect(sections.length).toBe(4);
    expect(closed.length).toBe(2);
  });
});

describe('没有镜头时，生成入口是一个按钮而不是一句话', () => {
  it('空状态里直接给「用模型生成分镜」，点了就打开抽屉', () => {
    const empty = structuredClone(sampleProject);
    empty.shots = [];
    useAppStore.getState().setProject(empty);

    const el = render(<StoryboardPage />);
    const button = [...el.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('用模型生成分镜'),
    ) as HTMLButtonElement | undefined;
    expect(button).toBeTruthy();
    expect(button!.className).toContain('btn-blue');

    const drawer = el.querySelector('.tools-drawer') as HTMLDetailsElement;
    expect(drawer.open).toBe(false);
    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(drawer.open).toBe(true);
  });
});
