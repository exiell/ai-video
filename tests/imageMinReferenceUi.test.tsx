// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SettingsPage } from '../src/pages/SettingsPage';
import { useSettings } from '../src/store/settings';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';
import { CUSTOM_MODELS_STORAGE_KEY } from '../src/data/customModels';

const initialPrefs = structuredClone(useSettings.getState().prefs);
const initialKeys = { ...useSettings.getState().keys };
const initialActions = {
  addCustomModel: useSettings.getState().addCustomModel,
  updateCustomModel: useSettings.getState().updateCustomModel,
  removeCustomModel: useSettings.getState().removeCustomModel,
  setCustomModelKey: useSettings.getState().setCustomModelKey,
  getCustomModelKey: useSettings.getState().getCustomModelKey,
};

function renderSettings(tab = 'custom'): HTMLDivElement {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[`/settings/${tab}`]}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

function click(target: Element | null | undefined): void {
  if (!target) return;
  act(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(found).toBeTruthy();
  return found!;
}

function dialogInput(label: string): HTMLInputElement {
  const input = dialog().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input).toBeTruthy();
  return input!;
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.removeItem(CUSTOM_MODELS_STORAGE_KEY);
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
  useSettings.setState({
    ...initialActions,
    prefs: structuredClone(initialPrefs),
    keys: { ...initialKeys },
    customModels: [],
  });
});

describe('自定义接入 · 最少参考图 / 本地改图预设', () => {
  it('图片表单显示「最少参考图」字段', () => {
    const el = renderSettings();
    const imageTab = [...el.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((node) =>
      (node.textContent ?? '').trim().startsWith('图片'),
    );
    click(imageTab);
    click([...el.querySelectorAll('button')].find((node) => (node.textContent ?? '').trim().startsWith('+ 新增图片')));
    expect(dialogInput('最少参考图')).toBeTruthy();
    expect(dialogInput('最少参考图').value).toBe('0');
    expect(dialog().textContent ?? '').toContain('纯改图模型填 1');
  });

  it('默认模型页「图像编辑」独立下拉：未选择提示 + 只列支持参考图的图片模型', () => {
    useSettings.getState().addCustomModel({
      name: '本地改图模型',
      modality: 'image',
      protocol: 'vllm-omni-chat-image',
      baseUrl: 'http://127.0.0.1:8098/v1',
      model: 'qwen-image-edit-2511',
      requiresKey: false,
      timeoutMs: 600000,
      capabilities: { maxReferenceImages: 3, minReferenceImages: 1 },
    });
    const el = renderSettings('models');
    const trigger = el.querySelector<HTMLButtonElement>('button[aria-label="图像编辑的默认模型"]');
    expect(trigger).toBeTruthy();
    expect(trigger!.textContent ?? '').toContain('未选择');
    expect(el.textContent ?? '').toContain('改图模型需要有参考图能力');
    const listId = trigger!.getAttribute('aria-controls');
    const options = [
      ...(listId ? document.getElementById(listId)?.querySelectorAll<HTMLElement>('[role="option"]') ?? [] : []),
    ].map((node) => (node.textContent ?? '').trim());
    expect(options.some((label) => label.includes('本地改图模型') && label.includes('最多 3 张参考图'))).toBe(true);
    expect(options.some((label) => label.includes('智谱'))).toBe(false);
  });

  it('新建本地改图模型预填 Qwen-Image-Edit-2511 / min=1 / max=3 / 600000', () => {
    const el = renderSettings();
    click([...el.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((node) =>
      (node.textContent ?? '').trim().startsWith('图片'),
    ));
    click(el.querySelector('button[aria-label="新建本地改图模型（Qwen-Image-Edit）"]'));
    expect(dialogInput('显示名').value).toContain('Qwen-Image-Edit-2511');
    expect(dialogInput('最少参考图').value).toBe('1');
    expect(dialogInput('参考图上限').value).toBe('3');
    expect(dialogInput('最少参考图').value).toBe('1');
    const modelInput = dialogInput('模型名');
    expect(modelInput.value).toBe('qwen-image-edit-2511');
    expect(dialog().querySelector<HTMLInputElement>('input[aria-label="超时毫秒"]')?.value).toBe('600000');
  });
});
