// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from '../src/pages/HomePage';
import { ExportPage } from '../src/pages/ExportPage';
import { StoryboardPage } from '../src/pages/StoryboardPage';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { CheckReport } from '../src/types/model';

/**
 * 批次 5b 的 UX 小修护栏
 *
 * 三条都是「看起来能跑、但边缘状态会露出破绽」的地方：
 *  1. 主页精简后不再有「还有 N 条建议」这类解释提示
 *  2. 导入文件超过 20MB 时先拦下来，不把文件读进内存
 *  3. 「用模型生成」折叠入口改成图标，和分镜卡/角色卡的展开样式一致
 *
 * 视觉部分仍需实机验收；这里锁结构和文案行为。
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

function reportWith(error: number, warning: number): CheckReport {
  return {
    issues: [],
    checkedAt: new Date().toISOString(),
    counts: { error, warning, info: 0 },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
});

describe('主页建议提示', () => {
  it('简版主页不再渲染「还有 N 条建议」', () => {
    useAppStore.setState({ report: reportWith(2, 3) });
    const el = render(<HomePage />);
    expect(el.textContent ?? '').not.toContain('条建议');
  });
});

describe('导入文件大小上限', () => {
  it('超过 20MB 时给出人话提示，不进入解析', () => {
    const el = render(<ExportPage />);
    const input = el.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toBeTruthy();
    const file = new File(['{}'], '项目数据.json', { type: 'application/json' });
    Object.defineProperty(file, 'size', { value: 21 * 1024 * 1024 });
    const textSpy = vi.spyOn(file, 'text');
    Object.defineProperty(input!, 'files', { value: [file], configurable: true });
    act(() => {
      input!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(el.textContent ?? '').toContain('超过 20MB');
    expect(el.textContent ?? '').not.toContain('已导入');
    // 超限时必须在读文件之前返回，不能把 21MB 读进内存
    expect(textSpy).not.toHaveBeenCalled();
  });
});

describe('用模型生成抽屉的展开入口', () => {
  it('用 chevron 图标，而不是「展开 ▾」文字', () => {
    const el = render(<StoryboardPage />);
    const summary = el.querySelector('.tools-drawer > summary');
    expect(summary).toBeTruthy();
    expect(summary?.querySelector('.expand-chevron')).toBeTruthy();
    expect((summary?.textContent ?? '').trim()).toBe('用模型生成');
  });
});
