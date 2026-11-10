// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

/**
 * 主页删除存档：失败时不能静默
 *
 * 批次5 里把 store 的 removeProject 改成返回 { ok, error }，但页面还留着
 * 直接 `void deleteProject(id)` 的老写法。这里锁页面的接线：
 *  - 失败：显示人话错误，列表里那条记录不消失
 *  - 成功：刷新列表
 *
 * 存储层用 mock 返回固定记录，删除动作也按结果分别 mock，避免依赖真实 IndexedDB 状态。
 */

const mocks = vi.hoisted(() => ({ listProjects: vi.fn() }));

vi.mock('../src/services/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage')>();
  return { ...actual, listProjects: mocks.listProjects };
});

import { HomePage } from '../src/pages/HomePage';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { ProjectRecord } from '../src/services/storage';

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

function makeRecord(): ProjectRecord {
  return {
    id: sampleProject.id,
    name: sampleProject.name,
    logline: sampleProject.logline,
    updatedAt: new Date().toISOString(),
    data: structuredClone(sampleProject),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function firstDeleteButton(el: HTMLElement): HTMLButtonElement {
  const button = el.querySelector<HTMLButtonElement>('button[aria-label^="删除项目"]');
  expect(button).toBeTruthy();
  return button!;
}

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.listProjects.mockReset();
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('主页删除存档的失败提示', () => {
  it('删除失败时显示人话错误，列表里那条记录还在', async () => {
    mocks.listProjects.mockResolvedValue([makeRecord()]);
    useAppStore.setState({
      removeProject: async () => ({
        ok: false,
        error: '删除失败：本地存储可能被其他标签页占用。项目和图片都还在。',
      }),
    });

    const el = render(<HomePage />);
    await flush();
    expect(el.querySelectorAll('.saved-row:not(.saved-head)').length).toBe(1);

    const button = firstDeleteButton(el);
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const text = el.textContent ?? '';
    expect(text).toContain('删除失败');
    expect(text).toContain('项目和图片都还在');
    expect(el.querySelectorAll('.saved-row:not(.saved-head)').length).toBe(1);
  });

  it('删除成功后刷新列表，空列表显示空状态', async () => {
    mocks.listProjects.mockResolvedValueOnce([makeRecord()]).mockResolvedValueOnce([]);
    useAppStore.setState({ removeProject: async () => ({ ok: true }) });

    const el = render(<HomePage />);
    await flush();
    const button = firstDeleteButton(el);
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(el.textContent ?? '').toContain('还没有保存过的项目。');
  });
});

describe('主页列表读取失败的兜底', () => {
  it('刷新失败时保留已有列表并显示提示', async () => {
    // 首次加载成功 → 列表有一条；删除成功触发的 refresh 失败 → 不能清空已有列表
    mocks.listProjects
      .mockResolvedValueOnce([makeRecord()])
      .mockRejectedValueOnce(new Error('blocked by another tab'));
    useAppStore.setState({ removeProject: async () => ({ ok: true }) });

    const el = render(<HomePage />);
    await flush();
    expect(el.querySelectorAll('.saved-row:not(.saved-head)').length).toBe(1);

    const button = firstDeleteButton(el);
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const text = el.textContent ?? '';
    expect(text).toContain('项目列表没读出来');
    expect(text).toContain('已经打开的项目不受影响');
    // 关键：没把列表清空
    expect(el.querySelectorAll('.saved-row:not(.saved-head)').length).toBe(1);
  });
});
