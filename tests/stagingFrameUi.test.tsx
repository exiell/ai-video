// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ScenesPage } from '../src/pages/ScenesPage';
import { StoryboardPage } from '../src/pages/StoryboardPage';
import { useAppStore } from '../src/store/app';
import { useImage } from '../src/store/image';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Asset, AssetKind } from '../src/types/model';

/**
 * 主帧 UI 入口（v0.60 · P2-b 二）
 *
 * 场景页：每个场景一个「主帧」区块（缩略图 + 来源 + 生成/重新生成按钮），
 *         场景参考板图库不混入主帧。
 * 分镜页：首帧图上出现「设为主帧」，动作帧/尾帧没有；确认后调 store。
 *
 * 数据/投递逻辑归 feature-impl，这里只测 UI 接线：调用、禁用、确认、feedback、
 * 图库过滤。store 动作全部用 spy 替换，不会真的出图花钱。
 */

const project = structuredClone(sampleProject);
const scene = project.scenes.find((item) =>
  project.shots.some((shot) => shot.sceneId === item.id),
)!;
const shot = project.shots.find((item) => item.sceneId === scene.id)!;

function makeAsset(refId: string, kind: AssetKind, id: string, extra: Partial<Asset> = {}): Asset {
  const ts = '2026-11-12T00:00:00.000Z';
  return {
    schemaVersion: 1,
    createdAt: ts,
    updatedAt: ts,
    id,
    projectId: project.id,
    kind,
    refId,
    mimeType: 'image/png',
    promptSnapshot: 'test',
    dataUrl: 'data:image/png;base64,AAAA',
    ...extra,
  };
}

const plate = makeAsset(scene.id, 'scene-plate', 'plate-1');
const firstFrame = makeAsset(shot.id, 'first-frame', 'first-1');
const actionPeak = makeAsset(shot.id, 'action-peak', 'peak-1');
const endFrame = makeAsset(shot.id, 'end-frame', 'end-1');
const stagingFrame = makeAsset(scene.id, 'staging-frame', 'staging-1', {
  sourceAssetIds: [firstFrame.id],
});

let container: HTMLDivElement | null = null;

function mount(node: React.ReactElement, entries: string[] = ['/']): HTMLDivElement {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter initialEntries={entries}>{node}</MemoryRouter>);
  });
  const el = container;
  container = null;
  return el;
}

function click(target: Element | null | undefined): void {
  if (!target) return;
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** 打开场景页第一个场景的展开区（Reveal 首次打开才挂载内容） */
function openFirstScene(): HTMLDivElement {
  const el = mount(<ScenesPage />);
  const toggle = [...el.querySelectorAll('button')].find((node) =>
    (node.getAttribute('aria-label') ?? '').includes('展开这个场景'),
  );
  click(toggle);
  return el;
}

function stagingButton(el: HTMLElement): HTMLButtonElement | null {
  return [...el.querySelectorAll('button')].find((node) =>
    (node.getAttribute('aria-label') ?? '').includes('主帧'),
  ) as HTMLButtonElement | null;
}

// 页面挂载时会把图库重新拉一遍；测试里用 no-op 覆盖，避免异步查询把预置图库清空
const originalGenerateStagingFrame = useImage.getState().generateStagingFrame;
const originalPromoteStagingFrame = useImage.getState().promoteStagingFrame;

beforeEach(() => {
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
  useImage.setState({
    gallery: {},
    pending: null,
    feedback: {},
    loadGallery: vi.fn(async () => undefined),
    generateStagingFrame: originalGenerateStagingFrame,
    promoteStagingFrame: originalPromoteStagingFrame,
  });
  vi.restoreAllMocks();
});

describe('场景页：主帧区块', () => {
  it('渲染主帧区块、生成按钮（aria-label/title）和费用提示', () => {
    useImage.setState({ gallery: { [scene.id]: [plate] } });
    const el = openFirstScene();
    expect(el.querySelector('.staging-frame')).toBeTruthy();
    expect(el.textContent ?? '').toContain('主帧');
    const button = stagingButton(el);
    expect(button).toBeTruthy();
    expect(button!.getAttribute('aria-label')).toContain(`场景「${scene.name}」`);
    expect(button!.getAttribute('title')).toContain('消耗一次出图费用');
    expect(button!.disabled).toBe(false);
    // 没有主帧时给一句前置说明，不静默
    expect(el.textContent ?? '').toContain('还没有主帧');
  });

  it('没有主帧时点生成直接调用 generateStagingFrame(scene.id)，不弹替换确认', () => {
    const generateStagingFrame = vi.fn(async () => undefined);
    useImage.setState({
      gallery: { [scene.id]: [plate] },
      generateStagingFrame,
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const el = openFirstScene();
    click(stagingButton(el));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(generateStagingFrame).toHaveBeenCalledWith(scene.id);
  });

  it('已有主帧时先二次确认；取消不调用，确认才生成', () => {
    const generateStagingFrame = vi.fn(async () => undefined);
    useImage.setState({
      gallery: { [scene.id]: [plate, stagingFrame], [shot.id]: [firstFrame] },
      generateStagingFrame,
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const el = openFirstScene();
    click(stagingButton(el));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(generateStagingFrame).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    click(stagingButton(el));
    expect(generateStagingFrame).toHaveBeenCalledWith(scene.id);
  });

  it('显示主帧缩略图与来源（来自第 X 镜首帧），pending 时按钮禁用', () => {
    useImage.setState({
      gallery: { [scene.id]: [plate, stagingFrame], [shot.id]: [firstFrame] },
      pending: `staging:${scene.id}`,
    });
    const el = openFirstScene();
    const thumb = el.querySelector<HTMLImageElement>('.staging-frame-thumb img');
    expect(thumb?.getAttribute('alt')).toContain(scene.name);
    expect(el.textContent ?? '').toContain(`来自第 ${shot.number} 镜首帧`);
    const button = stagingButton(el);
    expect(button!.disabled).toBe(true);
    expect((button!.textContent ?? '').trim()).toBe('生成中…');
  });

  it('展示 store feedback（错误人话原样显示）', () => {
    useImage.setState({
      gallery: { [scene.id]: [plate] },
      feedback: {
        [`staging:${scene.id}`]: {
          kind: 'error',
          message: '当前模型不能带参考图，做不了主帧。',
          warnings: ['换一个支持参考图的模型再试。'],
        },
      },
    });
    const el = openFirstScene();
    expect(el.textContent ?? '').toContain('当前模型不能带参考图，做不了主帧。');
    expect(el.textContent ?? '').toContain('换一个支持参考图的模型再试。');
  });

  it('点主帧缩略图能打开灯箱看大图', () => {
    useImage.setState({ gallery: { [scene.id]: [plate, stagingFrame] } });
    const el = openFirstScene();
    click(el.querySelector('.staging-frame-thumb'));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.querySelector('img')?.getAttribute('alt')).toBe('场景主帧');
  });

  it('场景参考板图库过滤掉主帧：主帧只在「主帧」区块出现', () => {
    useImage.setState({ gallery: { [scene.id]: [plate, stagingFrame] } });
    const el = openFirstScene();
    const figures = [...el.querySelectorAll('.asset-figure')];
    expect(figures.length).toBe(1);
    expect(figures[0]!.querySelector('img')?.getAttribute('alt')).toBe('场景参考板');
    // 主帧缩略图在区块里，不在场景板图库
    expect(el.querySelectorAll('.staging-frame-thumb img').length).toBe(1);
  });
});

describe('分镜页：首帧的「设为主帧」', () => {
  function mountStoryboard(): HTMLDivElement {
    useImage.setState({
      gallery: { [shot.id]: [firstFrame, actionPeak, endFrame] },
    });
    return mount(<StoryboardPage />, [`/storyboard?shot=${shot.id}`]);
  }

  it('只有首帧出现「设为主帧」，动作帧/尾帧没有；按钮有 aria-label/title', () => {
    const el = mountStoryboard();
    const buttons = [...el.querySelectorAll('button')].filter((node) =>
      (node.textContent ?? '').includes('设为主帧'),
    );
    expect(buttons.length).toBe(1);
    expect(buttons[0]!.getAttribute('aria-label')).toContain(`第 ${shot.number} 镜的首帧`);
    expect(buttons[0]!.getAttribute('title')).toContain('不额外花钱');
  });

  it('点击弹确认框，确认后调用 promoteStagingFrame(sceneId, assetId)', () => {
    const promoteStagingFrame = vi.fn(async () => undefined);
    useImage.setState({ promoteStagingFrame });
    const el = mountStoryboard();
    const button = [...el.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('设为主帧'),
    );
    click(button);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.textContent ?? '').toContain('不额外花钱');
    const confirmButton = dialog!.querySelector<HTMLButtonElement>('.confirm-actions .btn-blue');
    click(confirmButton);
    expect(promoteStagingFrame).toHaveBeenCalledWith(scene.id, firstFrame.id);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('取消确认框时不调用 store', () => {
    const promoteStagingFrame = vi.fn(async () => undefined);
    useImage.setState({ promoteStagingFrame });
    const el = mountStoryboard();
    const button = [...el.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes('设为主帧'),
    );
    click(button);
    const cancelButton = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] .confirm-actions .btn:not(.btn-blue)',
    );
    click(cancelButton);
    expect(promoteStagingFrame).not.toHaveBeenCalled();
  });

  it('显示该场景的主帧 feedback', () => {
    useImage.setState({
      feedback: {
        [`staging:${scene.id}`]: {
          kind: 'ok',
          message: `已把第 ${shot.number} 镜的首帧设为场景「${scene.name}」的主帧。`,
          warnings: [],
        },
      },
    });
    const el = mountStoryboard();
    expect(el.textContent ?? '').toContain('已把第');
    expect(el.textContent ?? '').toContain('的主帧。');
  });

  it('图片操作区里三张图都还在（设为主帧是额外操作，不吞掉原图）', () => {
    const el = mountStoryboard();
    expect(el.querySelectorAll('.asset-figure').length).toBe(3);
  });
});
