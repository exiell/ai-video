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
import { LOCAL_FLUX3_PROFILE_ID } from '../src/services/gateway/localModel';
import { resolveAllProfiles } from '../src/data/models/profiles';
import { CUSTOM_MODELS_STORAGE_KEY } from '../src/data/customModels';
import type { CustomModelConfig, CustomModality } from '../src/types/customModel';

/**
 * 本地模型统一到「自定义接入」（v0.65）
 *
 * 1. 连接页不再有独立的本地模型卡；
 * 2. 默认模型页不再有「当前使用本地模型」分支，内置 local-flux3 已 hidden；
 * 3. 自定义接入里提供「新建本地文字/图片模型」快捷预填。
 *
 * 老文件 tests/localModelSettings.test.tsx 测的是被移除的本地模型卡，
 * 已由本文件替代（新流程测试）。
 */

const initialPrefs = structuredClone(useSettings.getState().prefs);
const initialKeys = { ...useSettings.getState().keys };
const initialActions = {
  addCustomModel: useSettings.getState().addCustomModel,
  updateCustomModel: useSettings.getState().updateCustomModel,
  removeCustomModel: useSettings.getState().removeCustomModel,
  setCustomModelKey: useSettings.getState().setCustomModelKey,
  getCustomModelKey: useSettings.getState().getCustomModelKey,
};

let container: HTMLDivElement | null = null;

function renderSettings(tab: string): HTMLDivElement {
  document.body.innerHTML = '';
  container = document.createElement('div');
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

function switchTab(el: HTMLElement, label: string): void {
  const tab = [...el.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((node) =>
    (node.textContent ?? '').trim().startsWith(label),
  );
  expect(tab).toBeTruthy();
  click(tab);
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

function rowAction(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.getAttribute('aria-label') === label,
  );
  expect(button).toBeTruthy();
  return button!;
}

function saveDialog(): void {
  click(dialog().querySelector('.confirm-actions .btn-blue'));
}

function selectValue(ariaLabel: string): string {
  return (
    dialog().querySelector(`button[aria-label="${ariaLabel}"] .select-value`)?.textContent ?? ''
  ).trim();
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

describe('移除独立本地模型入口', () => {
  it('连接与 Key 里不再有本地模型卡（端点/测试/帮助都没有）', () => {
    const el = renderSettings('connection');
    expect(el.querySelector('input[aria-label="本地模型服务地址"]')).toBeNull();
    const text = el.textContent ?? '';
    expect(text).not.toContain('用本地模型前要准备什么');
    expect(text).not.toContain('本地 FLUX3（需本机 vLLM-Omni）');
  });

  it('默认模型页不再显示「当前使用本地模型」状态', () => {
    useSettings.setState({
      prefs: {
        ...useSettings.getState().prefs,
        defaultReferenceProfileId: LOCAL_FLUX3_PROFILE_ID,
        defaultT2iProfileId: LOCAL_FLUX3_PROFILE_ID,
      },
    });
    const el = renderSettings('models');
    expect(el.textContent ?? '').not.toContain('当前使用本地模型');
  });

  it('内置 local-flux3 已被核心层 hidden，resolveAllProfiles 默认不返回它', () => {
    expect(resolveAllProfiles().some((profile) => profile.id === LOCAL_FLUX3_PROFILE_ID)).toBe(
      false,
    );
  });
});

describe('自定义接入里的本地快捷入口', () => {
  it('文字标签页：预填本机文字模型字段并保存成自定义文字配置', () => {
    const el = renderSettings('custom');
    expect(el.textContent ?? '').toContain('FLUX3、本机 vLLM 等本地模型也在这里配置');

    click(rowAction('新建本地文字模型'));
    expect(dialog().textContent ?? '').toContain('新增自定义接入');
    expect(dialogInput('显示名').value).toBe('本地文字模型');
    expect(dialogInput('接口地址').value).toBe('http://127.0.0.1:8100/v1');
    expect(dialogInput('模型名').value).toBe('qwen3.6-27b');
    expect(dialogInput('超时毫秒').value).toBe('600000');
    const keyCheckbox = dialog().querySelector<HTMLInputElement>(
      'input[aria-label="需要 API Key"]',
    );
    expect(keyCheckbox?.checked).toBe(false);
    expect(selectValue('自定义接入协议')).toContain('OpenAI 兼容 chat');

    saveDialog();
    const config = useSettings.getState().customModels[0]!;
    expect(config.name).toBe('本地文字模型');
    expect(config.modality).toBe('text');
    expect(config.protocol).toBe('openai-chat');
    expect(config.baseUrl).toBe('http://127.0.0.1:8100/v1');
    expect(config.model).toBe('qwen3.6-27b');
    expect(config.requiresKey).toBe(false);
    expect(config.timeoutMs).toBe(600000);
  });

  it('图片标签页：预填本机 FLUX3 字段（含参考图上限 10）并保存', () => {
    const el = renderSettings('custom');
    switchTab(el, '图片');
    click(rowAction('新建本地图片模型'));
    expect(dialogInput('显示名').value).toBe('本地图片模型');
    expect(dialogInput('接口地址').value).toBe('http://127.0.0.1:8099/v1');
    expect(dialogInput('模型名').value).toBe('flux-3-image-klein');
    expect(dialogInput('超时毫秒').value).toBe('600000');
    expect(dialogInput('参考图上限').value).toBe('10');
    const keyCheckbox = dialog().querySelector<HTMLInputElement>(
      'input[aria-label="需要 API Key"]',
    );
    expect(keyCheckbox?.checked).toBe(false);
    expect(selectValue('自定义接入协议')).toContain('vLLM-Omni');

    saveDialog();
    const config = useSettings.getState().customModels[0]!;
    expect(config.modality).toBe('image');
    expect(config.protocol).toBe('vllm-omni-chat-image');
    expect(config.baseUrl).toBe('http://127.0.0.1:8099/v1');
    expect(config.model).toBe('flux-3-image-klein');
    expect(config.requiresKey).toBe(false);
    expect(config.timeoutMs).toBe(600000);
    expect(config.capabilities.maxReferenceImages).toBe(10);
    expect(config.capabilities.maxOutputImages).toBe(1);
  });

  it('保存的本地图片配置会出现在默认模型下拉的「自定义（图片）」分组', () => {
    const el = renderSettings('custom');
    switchTab(el, '图片');
    click(rowAction('新建本地图片模型'));
    saveDialog();

    const modelsEl = renderSettings('models');
    click(modelsEl.querySelector('button[aria-label="生成画面的默认模型"]'));
    const groups = [...modelsEl.querySelectorAll('.select-group')].map((node) =>
      (node.textContent ?? '').trim(),
    );
    expect(groups).toContain('自定义（图片）');
    expect(modelsEl.textContent ?? '').toContain('本地图片模型');
  });

  it('模型下拉里不再出现 hidden 的内置本地档案', () => {
    const el = renderSettings('models');
    click(el.querySelector('button[aria-label="生成画面的默认模型"]'));
    const optionTexts = [...el.querySelectorAll<HTMLButtonElement>('button[role="option"]')].map(
      (node) => node.textContent ?? '',
    );
    expect(optionTexts.some((text) => text.includes('本地 FLUX3'))).toBe(false);
    expect(el.textContent ?? '').not.toContain('本地 FLUX3（需本机 vLLM-Omni）');
  });
});


function makeConfig(modality: CustomModality, index: number): CustomModelConfig {
  return {
    id: `config-${modality}-${index}`,
    createdAt: new Date().toISOString(),
    name: `${modality} ${index}`,
    modality,
    protocol: modality === 'text' ? 'openai-chat' : 'openai-images',
    baseUrl: 'https://api.example.com/v1',
    model: `model-${index}`,
    requiresKey: true,
    capabilities: {},
  };
}

describe('hidden 旧设置与上限（task-72）', () => {
  it('prefs 仍指向 hidden 的本地 FLUX3 时，下拉回显「本地 FLUX3（旧设置）」而不是首个云模型', () => {
    useSettings.setState({
      prefs: {
        ...useSettings.getState().prefs,
        defaultReferenceProfileId: LOCAL_FLUX3_PROFILE_ID,
        defaultT2iProfileId: LOCAL_FLUX3_PROFILE_ID,
      },
    });
    const el = renderSettings('models');
    const trigger = el.querySelector<HTMLButtonElement>(
      'button[aria-label="生成画面的默认模型"]',
    )!;
    expect(trigger.querySelector('.select-value')?.textContent ?? '').toContain(
      '本地 FLUX3（旧设置）',
    );
    expect(trigger.querySelector('.select-value')?.textContent ?? '').not.toContain('智谱');

    click(trigger);
    const optionTexts = [...el.querySelectorAll<HTMLButtonElement>('button[role="option"]')].map(
      (node) => node.textContent ?? '',
    );
    expect(optionTexts.some((text) => text.includes('本地 FLUX3（旧设置）'))).toBe(true);
    expect(el.textContent ?? '').toContain('旧设置');
    expect(el.textContent ?? '').toContain('重建');
  });

  it('达到每模态 10 条上限时，两个本地快捷按钮禁用并提示先删一条', () => {
    useSettings.setState({
      customModels: Array.from({ length: 10 }, (_, index) => makeConfig('text', index)),
    });
    const textEl = renderSettings('custom');
    const textQuick = rowAction('新建本地文字模型');
    expect(textQuick.disabled).toBe(true);
    expect(textQuick.getAttribute('title')).toContain('已达 10 条上限，先删一条');
    expect(textEl.textContent ?? '').toContain('已达 10 条上限，先删一条');

    useSettings.setState({
      customModels: Array.from({ length: 10 }, (_, index) => makeConfig('image', index)),
    });
    const imageEl = renderSettings('custom');
    switchTab(imageEl, '图片');
    const imageQuick = rowAction('新建本地图片模型');
    expect(imageQuick.disabled).toBe(true);
    expect(imageEl.textContent ?? '').toContain('已达 10 条上限，先删一条');
  });
});
