// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AssetGallery } from '../src/components/ImagePanel';
import type { Asset } from '../src/types/model';

/**
 * 图库里的「删除这张图」从文字改成了图标按钮。
 *
 * iconButtons.test.tsx 覆盖不到这里：那个测试在「没有项目、没有图」的环境里跑，
 * AssetGallery 根本不会渲染。这里直接喂一张假素材，把图库状态的按钮契约锁住：
 * 图标按钮必须有 aria-label + title，且可见文字为空。
 */

function fakeAsset(): Asset {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    id: 'asset-1',
    projectId: 'project-1',
    kind: 'first-frame',
    refId: 'shot-1',
    dataUrl: 'data:image/png;base64,AAAA',
    mimeType: 'image/png',
    promptSnapshot: 'test prompt',
  };
}

function render(node: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return container;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('图库删除按钮', () => {
  it('图标按钮带 aria-label 与 title，且没有可见文字', () => {
    const el = render(<AssetGallery assets={[fakeAsset()]} />);
    const button = el.querySelector<HTMLButtonElement>('button[aria-label="删除这张图"]');
    expect(button).toBeTruthy();
    expect(button?.getAttribute('title')).toBe('删除这张图');
    expect((button?.textContent ?? '').trim()).toBe('');
    expect(button?.className).toContain('btn-icon');
  });

  it('缩略图有 alt，读屏知道这是什么图', () => {
    const el = render(<AssetGallery assets={[fakeAsset()]} />);
    const img = el.querySelector('img');
    expect(img).toBeTruthy();
    expect((img?.getAttribute('alt') ?? '').trim().length).toBeGreaterThan(0);
  });

  it('没有图时不渲染删除按钮（空状态不摆无效操作）', () => {
    const el = render(<AssetGallery assets={[]} />);
    expect(el.querySelector('button[aria-label="删除这张图"]')).toBeNull();
  });
});
