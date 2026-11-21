// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ checkVideoProfile: vi.fn() }));

vi.mock('../src/services/gateway/videoAdapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/gateway/videoAdapters')>();
  return { ...actual, checkVideoProfile: mocks.checkVideoProfile };
});
import { SettingsPage } from '../src/pages/SettingsPage';
import { useSettings } from '../src/store/settings';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';
import { CUSTOM_MODELS_STORAGE_KEY, customProfileId } from '../src/data/customModels';
import type { CustomModelConfig } from '../src/types/customModel';

/**
 * 设置页视频接入 UI（v0.65）：
 * 本地 SkyReels 预设、视频模型默认选择、视频测试连接（/models 或 /health）。
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
let root: ReturnType<typeof createRoot> | null = null;

function renderSettings(tab: string): HTMLDivElement {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  act(() => {
    created.render(
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
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

function addVideoConfig(): CustomModelConfig {
  const result = useSettings.getState().addCustomModel({
    name: 'SkyReels V3 R2V（本地）',
    modality: 'video',
    protocol: 'openai-videos',
    baseUrl: 'http://127.0.0.1:8110/v1',
    model: 'skyreels-v3-r2v',
    requiresKey: false,
    timeoutMs: 1_200_000,
    capabilities: { maxReferenceImages: 4 },
  });
  expect(result.ok).toBe(true);
  return result.config!;
}

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.checkVideoProfile.mockReset();
  localStorage.removeItem(CUSTOM_MODELS_STORAGE_KEY);
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
  useSettings.setState({
    ...initialActions,
    prefs: structuredClone(initialPrefs),
    keys: { ...initialKeys },
    customModels: [],
  });
});

afterEach(async () => {
  // React 19 的异步调度可能在用例结束、jsdom 环境销毁之后才跑到下一帧；
  // 不 unmount 就会在 CI 上冒成 “window is not defined” 的 unhandled error。
  if (root) {
    const current = root;
    root = null;
    await act(async () => {
      current.unmount();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  vi.unstubAllGlobals();
});

describe('自定义接入 → 视频：本地预设', () => {
  it('一键预填 SkyReels 视频服务并保存成 video 配置', () => {
    const el = renderSettings('custom');
    switchTab(el, '视频');
    click(rowAction('新建本地视频模型（SkyReels）'));

    expect(dialog().textContent ?? '').toContain('新增自定义接入');
    expect(dialogInput('显示名').value).toBe('SkyReels V3 R2V（本地）');
    expect(dialogInput('接口地址').value).toBe('http://127.0.0.1:8110/v1');
    expect(dialogInput('模型名').value).toBe('skyreels-v3-r2v');
    expect(dialogInput('超时毫秒').value).toBe('1200000');
    expect(dialogInput('参考图上限').value).toBe('4');
    const keyCheckbox = dialog().querySelector<HTMLInputElement>(
      'input[aria-label="需要 API Key"]',
    );
    expect(keyCheckbox?.checked).toBe(false);
    expect(selectValue('自定义接入协议')).toContain('OpenAI Videos');

    saveDialog();
    const config = useSettings.getState().customModels[0]!;
    expect(config.modality).toBe('video');
    expect(config.protocol).toBe('openai-videos');
    expect(config.baseUrl).toBe('http://127.0.0.1:8110/v1');
    expect(config.model).toBe('skyreels-v3-r2v');
    expect(config.requiresKey).toBe(false);
    expect(config.timeoutMs).toBe(1_200_000);
    expect(config.capabilities.maxReferenceImages).toBe(4);
  });
});

describe('自定义接入 → 视频：测试连接（核心 checkVideoProfile）', () => {
  it('GET /models 成功时显示视频服务已就绪', async () => {
    const config = addVideoConfig();
    mocks.checkVideoProfile.mockResolvedValue({
      ok: true,
      status: 'ready',
      message: '视频服务已就绪：skyreels-v3-r2v',
    });
    const el = renderSettings('custom');
    switchTab(el, '视频');
    click(rowAction(`测试「${config.name}」的连接`));
    await flush();

    expect(mocks.checkVideoProfile).toHaveBeenCalledTimes(1);
    expect(mocks.checkVideoProfile.mock.calls[0]![0]).toMatchObject({
      baseUrl: 'http://127.0.0.1:8110/v1',
      model: 'skyreels-v3-r2v',
    });
    expect(el.textContent ?? '').toContain('视频服务已就绪');
    expect(el.textContent ?? '').toContain('测试通过');
  });

  it('CORS/端口失败显示服务没起的人话', async () => {
    const config = addVideoConfig();
    mocks.checkVideoProfile.mockResolvedValue({
      ok: false,
      status: 'cors',
      message: '连不上本地视频服务，先启动服务/确认端口转发。',
    });
    const el = renderSettings('custom');
    switchTab(el, '视频');
    click(rowAction(`测试「${config.name}」的连接`));
    await flush();

    expect(el.textContent ?? '').toContain('连不上本地视频服务');
    expect(el.textContent ?? '').toContain('测试失败');
  });

  it('模型未加载时显示核心的人话', async () => {
    const config = addVideoConfig();
    mocks.checkVideoProfile.mockResolvedValue({
      ok: false,
      status: 'model-not-loaded',
      message: '视频服务已启动，模型还没加载好。等几分钟再测。',
    });
    const el = renderSettings('custom');
    switchTab(el, '视频');
    click(rowAction(`测试「${config.name}」的连接`));
    await flush();

    expect(el.textContent ?? '').toContain('模型还没加载好');
  });

  it('401/403 时显示 Key/权限提示', async () => {
    const config = addVideoConfig();
    mocks.checkVideoProfile.mockResolvedValue({
      ok: false,
      status: 'unauthorized',
      message: '视频服务拒绝了请求（401/403），检查 Key 是否正确。',
    });
    const el = renderSettings('custom');
    switchTab(el, '视频');
    click(rowAction(`测试「${config.name}」的连接`));
    await flush();

    expect(el.textContent ?? '').toContain('401/403');
  });
});

describe('默认模型页：视频模型选择', () => {
  it('没有视频配置时提示先去自定义接入新建', () => {
    const el = renderSettings('models');
    expect(el.querySelector('button[aria-label="生成视频的默认模型"]')).toBeNull();
    expect(el.textContent ?? '').toContain('还没有视频模型');
    expect(el.textContent ?? '').toContain('自定义接入');
  });

  it('有视频配置时能选择并写入 defaultVideoProfileId', () => {
    const config = addVideoConfig();
    const el = renderSettings('models');
    const trigger = el.querySelector<HTMLButtonElement>(
      'button[aria-label="生成视频的默认模型"]',
    );
    expect(trigger).toBeTruthy();
    click(trigger);
    const option = [...el.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find(
      (node) => (node.textContent ?? '').includes(config.name),
    );
    expect(option).toBeTruthy();
    click(option);
    expect(useSettings.getState().prefs.defaultVideoProfileId).toBe(
      customProfileId('video', config.id),
    );
  });
});
