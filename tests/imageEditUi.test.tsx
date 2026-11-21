// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { Asset } from '../src/types/model';
import { sampleProject } from '../src/data/samples/sampleProject';
import { useAppStore } from '../src/store/app';
import { useImage } from '../src/store/image';
import { useSettings } from '../src/store/settings';
import { DEFAULT_REFERENCE_PROFILE_ID } from '../src/data/models/profiles';
import { ImagePanel, type GenerateOption, type PanelTarget } from '../src/components/ImagePanel';

/**
 * 图像编辑 UI（v0.66）：
 * 按钮位置/无模型禁用、参考图选择（项目素材+上传）、修改要求、分镜保存为、
 * 提交参数、失败留在对话框、Esc 与焦点恢复。
 */

const storageMocks = vi.hoisted(() => ({ listAssets: vi.fn() }));

vi.mock('../src/services/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage')>();
  return { ...actual, listAssets: storageMocks.listAssets };
});

const project = structuredClone(sampleProject);
const initialPrefs = structuredClone(useSettings.getState().prefs);
const initialKeys = { ...useSettings.getState().keys };
const initialImageActions = {
  generateEditedImage: useImage.getState().generateEditedImage,
  clearFeedback: useImage.getState().clearFeedback,
};

function asset(
  id: string,
  kind: Asset['kind'],
  refId: string,
  dataUrl = `data:image/png;base64,${id}`,
): Asset {
  return {
    id,
    projectId: project.id,
    kind,
    refId,
    dataUrl,
    mimeType: 'image/png',
    width: 720,
    height: 1280,
    promptSnapshot: 'p',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
  };
}

const PROJECT_ASSETS = [
  asset('char-full', 'character-sheet', 'ch-linchong'),
  asset('char-face', 'character-sheet-face', 'ch-linchong'),
  asset('scene', 'scene-plate', 'sc-field'),
  asset('frame', 'first-frame', 'shot-01'),
];

const PANEL_OPTIONS: Record<PanelTarget, GenerateOption[]> = {
  character: [{ label: '全身多视图', useReference: true, sheetKind: 'turnaround' }],
  scene: [{ label: '主视角', useReference: false, angle: 'master' }],
  frame: [{ label: '① 首帧', useReference: false, frameKind: 'first-frame' }],
};

let container: HTMLDivElement | null = null;

function render(node: React.ReactElement): HTMLDivElement {
  document.body.innerHTML = '';
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

function click(target: Element | null | undefined): void {
  if (!target) return;
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function setSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function renderPanel(target: PanelTarget): HTMLDivElement {
  const refId =
    target === 'character' ? 'ch-linchong' : target === 'scene' ? 'sc-field' : 'shot-01';
  return render(
    <ImagePanel
      refId={refId}
      target={target}
      label="出图"
      options={PANEL_OPTIONS[target]}
    />,
  );
}

function editButton(el: HTMLElement): HTMLButtonElement | undefined {
  return [...el.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    (node.textContent ?? '').includes('图像编辑'),
  );
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.image-edit-dialog');
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    (node.textContent ?? '').includes(text),
  );
}

async function openDialog(el: HTMLElement): Promise<void> {
  click(editButton(el));
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = '';
  storageMocks.listAssets.mockReset();
  storageMocks.listAssets.mockResolvedValue(PROJECT_ASSETS);
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
  useSettings.setState({
    prefs: {
      ...structuredClone(initialPrefs),
      defaultImageEditProfileId: DEFAULT_REFERENCE_PROFILE_ID,
    },
    keys: { ...initialKeys },
  });
  useImage.setState({
    ...initialImageActions,
    pending: null,
    feedback: {},
    gallery: {},
    batch: null,
  });
});

describe('图像编辑按钮', () => {
  it('角色形象图 / 场景参考板 / 分镜三帧的按钮行末尾都有「图像编辑」', () => {
    for (const target of ['character', 'scene', 'frame'] as const) {
      const el = renderPanel(target);
      const button = editButton(el);
      expect(button).toBeTruthy();
      expect(button!.className).toContain('btn-ai');
      expect(button!.disabled).toBe(false);
    }
  });

  it('没有编辑模型时禁用，并提示先去设置里选', () => {
    useSettings.setState({
      prefs: { ...useSettings.getState().prefs, defaultImageEditProfileId: undefined },
    });
    const el = renderPanel('character');
    expect(editButton(el)?.disabled).toBe(true);
    expect(el.textContent ?? '').toContain('先到设置 → 默认模型 → 图像编辑 选一个模型');
  });
});

describe('图像编辑对话框：选参考图与提交', () => {
  it('选项目素材 + 写要求后提交，参数包含顺序、label 与 prompt', async () => {
    const generateEditedImage = vi.fn(async (_input: unknown) => {});
    useImage.setState({ generateEditedImage });
    const el = renderPanel('character');
    await openDialog(el);

    expect(dialog()).toBeTruthy();
    expect(dialog()!.textContent ?? '').toContain('已选 0 / 3');
    click(
      [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
        (node.getAttribute('aria-label') ?? '').includes('林冲 · 全身多视图'),
      ),
    );
    await flush();
    expect(dialog()!.textContent ?? '').toContain('已选 1 / 3');

    setTextarea(
      dialog()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="修改要求"]')!,
      '保持角色不变，把表情改成惊讶。',
    );
    click(findButton('开始生成'));
    await flush();

    expect(generateEditedImage).toHaveBeenCalledTimes(1);
    expect(generateEditedImage.mock.calls[0]![0]).toMatchObject({
      target: 'character',
      refId: 'ch-linchong',
      prompt: '保持角色不变，把表情改成惊讶。',
      referenceImages: ['data:image/png;base64,char-full'],
      referenceLabels: ['林冲 · 全身多视图'],
    });
    expect(dialog()).toBeNull();
  });

  it('分镜上下文可以选保存为动作关键帧，并传给 action', async () => {
    const generateEditedImage = vi.fn(async (_input: unknown) => {});
    useImage.setState({ generateEditedImage });
    const el = renderPanel('frame');
    await openDialog(el);

    click(
      [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
        (node.getAttribute('aria-label') ?? '').includes('首帧'),
      ),
    );
    setTextarea(
      dialog()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="修改要求"]')!,
      '让人物抬手。',
    );
    setSelect(dialog()!.querySelector<HTMLSelectElement>('select[aria-label="保存为"]')!, 'action-peak');
    click(findButton('开始生成'));
    await flush();

    expect(generateEditedImage.mock.calls[0]![0]).toMatchObject({
      target: 'frame',
      refId: 'shot-01',
      frameKind: 'action-peak',
      referenceImages: ['data:image/png;base64,frame'],
    });
  });

  it('参考图为 0 或修改要求为空时「开始生成」禁用', async () => {
    const el = renderPanel('character');
    await openDialog(el);
    const submit = findButton('开始生成')!;
    expect(submit.disabled).toBe(true);

    click(
      [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
        (node.getAttribute('aria-label') ?? '').includes('林冲 · 全身多视图'),
      ),
    );
    await flush();
    expect(findButton('开始生成')!.disabled).toBe(true);

    setTextarea(
      dialog()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="修改要求"]')!,
      '换成夜景。',
    );
    expect(findButton('开始生成')!.disabled).toBe(false);
  });

  it('上传本地图片会计入参考图并给出已选序号', async () => {
    const el = renderPanel('character');
    await openDialog(el);
    const input = dialog()!.querySelector<HTMLInputElement>('input[aria-label="上传本地参考图"]')!;
    const file = new File([new Uint8Array([1, 2, 3])], 'local.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(dialog()!.textContent ?? '').toContain('已选 1 / 3');
    expect(dialog()!.textContent ?? '').toContain('上传图片 · local.png');
  });

  it('生成失败时对话框不关闭，显示人话错误并允许重试', async () => {
    const generateEditedImage = vi.fn(async () => {
      useImage.setState({
        feedback: {
          'edit:ch-linchong': {
            kind: 'error',
            message: '改图模型拒绝了这次请求，换个要求再试。',
            warnings: [],
          },
        },
      });
    });
    useImage.setState({ generateEditedImage });
    const el = renderPanel('character');
    await openDialog(el);
    click(
      [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
        (node.getAttribute('aria-label') ?? '').includes('林冲 · 全身多视图'),
      ),
    );
    setTextarea(
      dialog()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="修改要求"]')!,
      '改成雪夜。',
    );
    click(findButton('开始生成'));
    await flush();

    expect(dialog()).toBeTruthy();
    expect(dialog()!.textContent ?? '').toContain('改图模型拒绝了这次请求');
    expect(findButton('开始生成')?.disabled).toBe(false);
  });

  it('提交时按钮显示「生成中…」并禁用，完成后关闭', async () => {
    let resolveSubmit: (() => void) | null = null;
    const generateEditedImage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    useImage.setState({ generateEditedImage });
    const el = renderPanel('character');
    await openDialog(el);
    click(
      [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
        (node.getAttribute('aria-label') ?? '').includes('林冲 · 全身多视图'),
      ),
    );
    setTextarea(
      dialog()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="修改要求"]')!,
      '换成黄昏。',
    );
    click(findButton('开始生成'));
    await flush();
    expect(findButton('生成中…')?.disabled).toBe(true);

    await act(async () => {
      resolveSubmit?.();
      await Promise.resolve();
    });
    await flush();
    expect(dialog()).toBeNull();
  });

  it('Esc 关闭对话框，焦点回到「图像编辑」按钮', async () => {
    const el = renderPanel('character');
    await openDialog(el);
    expect(dialog()).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(editButton(el));
  });
});
