// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

/**
 * 导出页删除项目：失败时要显示人话错误
 *
 * 旧代码是 `void deleteProject(id).then(...)`，没有 catch——IndexedDB 被别的
 * 标签页占住时，用户点了「确认删除」之后没有任何反馈。这里锁 catch 之后的提示。
 */

const mocks = vi.hoisted(() => ({
  deleteProject: vi.fn(),
  listAssets: vi.fn(),
}));

vi.mock('../src/services/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage')>();
  return {
    ...actual,
    deleteProject: mocks.deleteProject,
    listAssets: mocks.listAssets,
  };
});

import { ExportPage } from '../src/pages/ExportPage';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';

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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.deleteProject.mockReset();
  mocks.listAssets.mockReset();
  mocks.listAssets.mockResolvedValue([]);
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('导出页删除项目失败', () => {
  it('显示「删除失败」与原因，不静默吞掉异常', async () => {
    mocks.deleteProject.mockRejectedValue(new Error('blocked by another tab'));

    const el = render(<ExportPage />);
    await flush();

    const button = [...el.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      (node.textContent ?? '').includes('删除这个项目'),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = el.textContent ?? '';
    expect(text).toContain('删除失败');
    expect(text).toContain('项目没删掉');
    expect(mocks.deleteProject).toHaveBeenCalledWith(sampleProject.id);
  });
});
