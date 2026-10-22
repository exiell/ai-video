// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AssetPeek } from '../src/components/ImagePanel';
import { CharactersPage } from '../src/pages/CharactersPage';
import { ScenesPage } from '../src/pages/ScenesPage';
import { StoryboardPage } from '../src/pages/StoryboardPage';
import { useAppStore } from '../src/store/app';
import { useImage } from '../src/store/image';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Asset, AssetKind, Project, SceneAngle } from '../src/types/model';

/**
 * 条目折叠时也能看图（v0.52）
 *
 * ===========================================================================
 * 为什么要做
 * ===========================================================================
 * 在这之前，想看一个角色的图必须点「展开」，把身份、连续性锁、变体、负向词、
 * 种子全翻过去，才在图库那一段看到缩略图。想比两个角色的形象，就得开一个、
 * 关一个、再开一个；镜头一多，「哪一镜出过图」这件事在列表上完全看不出来。
 *
 * 所以按钮要满足三件事：
 *  1. **不展开就能看见**（否则等于没做）
 *  2. 不点开也知道里面有什么（按钮上直接写张数与种类）
 *  3. 一张图都没有时不出现（一个永远点开是空话的按钮比没有更差）
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

function fresh(): Project {
  return structuredClone(sampleProject);
}

function asset(
  refId: string,
  kind: AssetKind,
  extra: { id?: string; angle?: SceneAngle } = {},
): Asset {
  const stamp = new Date(1_700_000_000_000).toISOString();
  return {
    ...extra,
    id: extra.id ?? `a-${kind}-${Math.abs(hash(refId + kind))}`,
    schemaVersion: 1,
    createdAt: stamp,
    updatedAt: stamp,
    projectId: 'p1',
    refId,
    kind,
    mimeType: 'image/png',
    dataUrl: `data:image/png;base64,${kind}`,
    promptSnapshot: 'prompt',
  };
}

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) | 0;
  return value;
}

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function toggleOf(root: HTMLElement): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>('.peek-toggle');
}

beforeEach(() => {
  useAppStore.setState({ project: fresh(), report: null });
  useImage.setState({ gallery: {}, assetCount: 0 });
});

// ---------------------------------------------------------------------------
// 按钮本身
// ---------------------------------------------------------------------------

describe('AssetPeek · 按钮上写了什么', () => {
  it('没有图时不渲染任何东西', () => {
    const el = render(<AssetPeek assets={[]} />);
    expect(el.querySelector('.peek')).toBeNull();
    expect(el.textContent).toBe('');
  });

  it('有图时写清张数，并列出种类', () => {
    const el = render(
      <AssetPeek assets={[asset('s1', 'first-frame'), asset('s1', 'end-frame')]} />,
    );
    expect(textOf(toggleOf(el)!)).toContain('看图 2 张');
    expect(textOf(toggleOf(el)!)).toContain('首帧 / 尾帧');
  });

  it('同一种类有多张时只列一次', () => {
    const el = render(
      <AssetPeek
        assets={[
          asset('s1', 'first-frame', { id: 'a1' }),
          asset('s1', 'first-frame', { id: 'a2' }),
          asset('s1', 'first-frame', { id: 'a3' }),
        ]}
      />,
    );
    const text = textOf(toggleOf(el)!);
    expect(text).toContain('看图 3 张');
    expect(text).toContain('首帧');
    expect(text).not.toContain('首帧 / 首帧');
  });

  it('种类超过三种时折成「等 N 种」，不把整串铺开', () => {
    const el = render(
      <AssetPeek
        assets={[
          asset('s1', 'first-frame', { id: 'a1' }),
          asset('s1', 'action-peak', { id: 'a2' }),
          asset('s1', 'end-frame', { id: 'a3' }),
          asset('s1', 'scene-plate', { id: 'a4' }),
        ]}
      />,
    );
    const text = textOf(toggleOf(el)!);
    expect(text).toContain('等 4 种');
    expect(text).toContain('看图 4 张');
  });

  it('种类「等 N 种」时仍然只列前三种', () => {
    const el = render(
      <AssetPeek
        assets={[
          asset('s1', 'first-frame', { id: 'a1' }),
          asset('s1', 'action-peak', { id: 'a2' }),
          asset('s1', 'end-frame', { id: 'a3' }),
          asset('s1', 'scene-plate', { id: 'a4' }),
        ]}
      />,
    );
    const text = textOf(toggleOf(el)!);
    expect(text).not.toContain('场景参考板');
  });
});

// ---------------------------------------------------------------------------
// 展开与灯箱
// ---------------------------------------------------------------------------

describe('AssetPeek · 点开以后', () => {
  it('默认是收起的，点了才出缩略图', () => {
    const el = render(<AssetPeek assets={[asset('s1', 'first-frame')]} />);
    expect(toggleOf(el)!.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelectorAll('.peek-thumb')).toHaveLength(0);

    act(() => {
      toggleOf(el)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(toggleOf(el)!.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelectorAll('.peek-thumb')).toHaveLength(1);
  });

  it('缩略图数量与张数一致，每张都带种类标签', () => {
    const el = render(
      <AssetPeek
        assets={[asset('s1', 'first-frame', { id: 'a1' }), asset('s1', 'end-frame', { id: 'a2' })]}
      />,
    );
    act(() => {
      toggleOf(el)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const thumbs = [...el.querySelectorAll('.peek-thumb')];
    expect(thumbs).toHaveLength(2);
    expect(thumbs.map((t) => t.getAttribute('title'))).toEqual([
      '点击放大：首帧',
      '点击放大：尾帧',
    ]);
  });

  it('场景板额外标出角度，免得主视角和反打拿混', () => {
    const el = render(
      <AssetPeek assets={[asset('sc1', 'scene-plate', { angle: 'reverse' })]} />,
    );
    act(() => {
      toggleOf(el)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const caption = el.querySelector('.peek-item figcaption');
    expect(textOf(caption!)).toContain('场景参考板');
    expect(textOf(caption!)).toContain('反打视角');
  });

  it('点缩略图进的是同一个灯箱，可以在这一条的图之间翻页', () => {
    const el = render(
      <AssetPeek
        assets={[asset('s1', 'first-frame', { id: 'a1' }), asset('s1', 'end-frame', { id: 'a2' })]}
      />,
    );
    act(() => {
      toggleOf(el)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const first = el.querySelector<HTMLButtonElement>('.peek-thumb');
    act(() => {
      first!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-label')).toBe('放大查看');
    // 两张图 → 灯箱里应该有「1 / 2」这样的计数，说明它拿到了整组而不是单张
    expect(textOf(dialog!)).toContain('1 / 2');
  });
});

// ---------------------------------------------------------------------------
// 三个页面：折叠状态下就应该有入口
// ---------------------------------------------------------------------------

describe('三个页面的条目上都有看图入口', () => {
  it('角色页：不展开也能看到按钮', () => {
    const project = fresh();
    const character = project.characters[0]!;
    useAppStore.setState({ project });
    useImage.setState({
      gallery: { [character.id]: [asset(character.id, 'character-sheet')] },
    });

    const el = render(<CharactersPage />);
    const button = toggleOf(el);
    expect(button).not.toBeNull();
    expect(textOf(button!)).toContain('看图 1 张');
    // 展开面板没被打开 → 里面那个完整图库不该存在，说明按钮不是靠展开才出现的
    expect(el.querySelector('.card-more')).toBeNull();
  });

  it('场景页：不展开也能看到按钮', () => {
    const project = fresh();
    const scene = project.scenes[0]!;
    useAppStore.setState({ project });
    useImage.setState({ gallery: { [scene.id]: [asset(scene.id, 'scene-plate')] } });

    const el = render(<ScenesPage />);
    const button = toggleOf(el);
    expect(button).not.toBeNull();
    expect(textOf(button!)).toContain('看图 1 张');
    expect(el.querySelector('.card-more')).toBeNull();
  });

  it('分镜页：不展开也能看到按钮', () => {
    const project = fresh();
    const shot = project.shots[0]!;
    useAppStore.setState({ project });
    useImage.setState({ gallery: { [shot.id]: [asset(shot.id, 'first-frame')] } });

    const el = render(<StoryboardPage />);
    const button = toggleOf(el);
    expect(button).not.toBeNull();
    expect(textOf(button!)).toContain('看图 1 张');
    expect(el.querySelector('.shot-more')).toBeNull();
  });

  it('没出过图的对象不显示按钮，而不会显示一个点了是空的按钮', () => {
    const project = fresh();
    useAppStore.setState({ project });
    useImage.setState({ gallery: {} });

    const el = render(<StoryboardPage />);
    expect(toggleOf(el)).toBeNull();
  });
});
