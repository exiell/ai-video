// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { BatchGenerateCard } from '../src/components/BatchGenerateCard';
import { useImage } from '../src/store/image';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { sampleProject } from '../src/data/samples/sampleProject';
import { planReferenceImages } from '../src/domain/image/referencePlan';
import type { Project } from '../src/types/model';

/**
 * 批量出图的顺序（v0.44）
 *
 * ===========================================================================
 * 问题
 * ===========================================================================
 * 原来是按「帧类型」分批：先全部首帧，再全部关键帧，再全部尾帧。
 * 但参考图的依赖是：
 *
 *   本镜首帧   ← 上一镜尾帧（承接时）
 *   本镜关键帧 ← 本镜首帧
 *   本镜尾帧   ← 本镜首帧
 *
 * 跑第一批时所有尾帧都还不存在，于是每一镜的首帧都悄悄丢了
 * 「接住上一镜」这个最强的锚点。而首帧又是另外两帧的锚点，
 * 误差一路传到三帧 —— 全部三个批次都受影响，而且不会报错。
 *
 * 正确顺序是**按镜头**：第 1 镜首帧→关键帧→尾帧，再第 2 镜……
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

function twoShots(): Project {
  const project = structuredClone(sampleProject);
  project.shots = project.shots.slice(0, 2);
  return project;
}

beforeEach(() => {
  useImage.setState({
    pending: null,
    feedback: {},
    gallery: {},
    assetCount: 0,
    assetCounts: {},
    batch: null,
    batchSummary: null,
  });
  useAppStore.setState({ project: twoShots() });
  useSettings.setState({ keys: { dashscope: 'sk-test' } });
});

// ---------------------------------------------------------------------------
// 依赖关系本身（这是顺序为什么重要的原因）
// ---------------------------------------------------------------------------

describe('参考图依赖：说明顺序确实会影响一致性', () => {
  const caps = {
    negativePrompt: false,
    seed: false,
    referenceImage: true,
    maxReferenceImages: 3,
    maxOutputImages: 1,
  };
  const sheet = {
    dataUrl: 'data:image/png;base64,SHEET',
    kind: 'character-sheet-face',
    createdAt: '2026-01-01',
  };

  /*
    必须给一个**真的连续**的上一镜：衔接判定看 transitionType / continuityNote。
    先写成 `{ id: 'prev' }` 的时候，两条断言都是因为「判不出连续」而通过的，
    属于假阳性 —— 那条「拿不到锚点」的测试早就该失败。
  */
  const continuousPrevious = {
    ...structuredClone(sampleProject).shots[0]!,
    transitionType: 'continuation' as const,
  };

  it('**上一镜尾帧不存在时，首帧拿不到跨镜锚点**（这就是先跑首帧的代价）', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: caps,
      previous: continuousPrevious,
      sources: { ownFrames: [], characterSheets: [[sheet]], previousFrames: [] },
    });
    expect(plan.isContinuous, '这条测试要求判定为连续').toBe(true);
    expect(plan.slots.some((s) => s.role === 'previous-end-frame')).toBe(false);
  });

  it('上一镜尾帧已存在时，首帧就会用它当锚点', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: caps,
      previous: continuousPrevious,
      sources: {
        ownFrames: [],
        characterSheets: [[sheet]],
        previousFrames: [
          { dataUrl: 'data:image/png;base64,END', kind: 'end-frame', createdAt: '2026-01-02' },
        ],
      },
    });
    expect(plan.isContinuous).toBe(true);
    expect(plan.slots.some((s) => s.role === 'previous-end-frame')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 批量顺序
// ---------------------------------------------------------------------------

describe('全部三帧 · 必须按镜头顺序', () => {
  it('**调用顺序是 第1镜首帧→关键帧→尾帧、第2镜首帧→关键帧→尾帧**', async () => {
    const project = useAppStore.getState().project!;
    const calls: string[] = [];

    // 换成探针，避免真的打接口
    useImage.setState({
      generateForFrame: async (shotId: string, kind: string) => {
        const index = project.shots.findIndex((s) => s.id === shotId);
        calls.push(`${index + 1}:${kind}`);
      },
    });

    await act(async () => {
      await useImage.getState().generateAllFramesInOrder();
    });

    expect(calls).toEqual([
      '1:first-frame',
      '1:action-peak',
      '1:end-frame',
      '2:first-frame',
      '2:action-peak',
      '2:end-frame',
    ]);
  });

  it('**每一镜的尾帧都排在下一镜的首帧之前**（这条是顺序的意义所在）', async () => {
    const project = useAppStore.getState().project!;
    const calls: string[] = [];
    useImage.setState({
      generateForFrame: async (shotId: string, kind: string) => {
        const index = project.shots.findIndex((s) => s.id === shotId);
        calls.push(`${index + 1}:${kind}`);
      },
    });

    await act(async () => {
      await useImage.getState().generateAllFramesInOrder();
    });

    const endOfShot1 = calls.indexOf('1:end-frame');
    const firstOfShot2 = calls.indexOf('2:first-frame');
    expect(endOfShot1).toBeGreaterThanOrEqual(0);
    expect(endOfShot1).toBeLessThan(firstOfShot2);
  });

  it('**每一镜的首帧都排在它自己的关键帧和尾帧之前**', async () => {
    const project = useAppStore.getState().project!;
    const calls: string[] = [];
    useImage.setState({
      generateForFrame: async (shotId: string, kind: string) => {
        const index = project.shots.findIndex((s) => s.id === shotId);
        calls.push(`${index + 1}:${kind}`);
      },
    });

    await act(async () => {
      await useImage.getState().generateAllFramesInOrder();
    });

    for (let i = 1; i <= project.shots.length; i += 1) {
      const first = calls.indexOf(`${i}:first-frame`);
      const peak = calls.indexOf(`${i}:action-peak`);
      const end = calls.indexOf(`${i}:end-frame`);
      expect(first).toBeLessThan(peak);
      expect(first).toBeLessThan(end);
    }
  });

  it('没有镜头时给出可执行的下一步，而不是空跑', async () => {
    useAppStore.setState({ project: { ...twoShots(), shots: [] } });
    await act(async () => {
      await useImage.getState().generateAllFramesInOrder();
    });
    expect(useImage.getState().batchSummary).toContain('还没有镜头');
  });
});

// ---------------------------------------------------------------------------
// 界面
// ---------------------------------------------------------------------------

describe('批量卡片上的按钮', () => {
  it('**「全部三帧（按镜头顺序）」排在帧类按钮的最前面**', () => {
    const el = render(
      <BatchGenerateCard
        tasks={['characters', 'scenes', 'all-frames', 'first-frame', 'action-peak', 'end-frame']}
      />,
    );
    const labels = [...el.querySelectorAll('button')].map((b) => b.textContent ?? '');
    const allIdx = labels.findIndex((t) => t.includes('全部三帧'));
    const firstIdx = labels.findIndex((t) => t.includes('只补首帧'));
    expect(allIdx).toBeGreaterThanOrEqual(0);
    expect(allIdx).toBeLessThan(firstIdx);
    el.remove();
  });

  it('数量是 镜头数 × 3', () => {
    const el = render(
      <BatchGenerateCard tasks={['characters', 'scenes', 'all-frames']} />,
    );
    const label = [...el.querySelectorAll('button')]
      .map((b) => b.textContent ?? '')
      .find((t) => t.includes('全部三帧'));
    expect(label).toContain('（6）');
    el.remove();
  });

  it('**没有尾帧时点「只补首帧」会先弹确认**，说清会丢掉跨镜锚点', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const el = render(<BatchGenerateCard tasks={['all-frames', 'first-frame']} />);
    const btn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('只补首帧'),
    ) as HTMLButtonElement;

    act(() => btn.click());

    expect(confirmSpy).toHaveBeenCalled();
    const message = confirmSpy.mock.calls[0]![0] as string;
    expect(message).toContain('尾帧');
    expect(message).toContain('全部三帧');
    confirmSpy.mockRestore();
    el.remove();
  });

  it('已经有尾帧时不再啰嗦', () => {
    useImage.setState({ assetCounts: { 'end-frame': 2 } });
    const confirmSpy = vi.spyOn(window, 'confirm');
    const el = render(<BatchGenerateCard tasks={['all-frames', 'first-frame']} />);
    const btn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('只补首帧'),
    ) as HTMLButtonElement;

    act(() => btn.click());

    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
    el.remove();
  });
});
