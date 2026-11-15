// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * 设置页「自定义接入」UI（v0.63 第三批）
 *
 * 覆盖：三模态列表/新增编辑删除、Key 显示条件、就地校验、测试连接成功与失败、
 * pending 禁用、视频本地接入、默认模型下拉出现自定义项、删除默认回退提示、10 条上限。
 * 核心层（校验/CRUD/localStorage/checkCustomModel）已由 feature 侧测试覆盖；
 * 这里 mock 掉测试连接，只测 UI 接线。
 */

const mocks = vi.hoisted(() => ({ checkCustomModel: vi.fn(), checkVideoProfile: vi.fn() }));

vi.mock('../src/services/customModels/check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/customModels/check')>();
  return { ...actual, checkCustomModel: mocks.checkCustomModel };
});

vi.mock('../src/services/gateway/videoAdapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/gateway/videoAdapters')>();
  return { ...actual, checkVideoProfile: mocks.checkVideoProfile };
});

import { SettingsPage } from '../src/pages/SettingsPage';
import { useSettings } from '../src/store/settings';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';
import { CUSTOM_MODELS_STORAGE_KEY, customProfileId } from '../src/data/customModels';
import type { CustomModelCheckResult } from '../src/services/customModels/check';
import type {
  CustomModelConfig,
  CustomModality,
  CustomProtocol,
} from '../src/types/customModel';
import { DEFAULT_LLM_PROFILE_ID } from '../src/types/customModel';

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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function toggle(input: Element | null): void {
  if (!input) throw new Error('checkbox not found');
  act(() => {
    (input as HTMLInputElement).click();
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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

function saveDialog(): void {
  click(dialog().querySelector('.confirm-actions .btn-blue'));
}

function switchTab(el: HTMLElement, label: string): void {
  const tab = [...el.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find(
    (node) => (node.textContent ?? '').trim().startsWith(label),
  );
  click(tab);
}

function rowAction(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.getAttribute('aria-label') === label,
  );
  expect(button).toBeTruthy();
  return button!;
}

function addConfig(overrides: Partial<CustomModelConfig> = {}): CustomModelConfig {
  const result = useSettings.getState().addCustomModel({
    name: '测试接入',
    modality: 'text',
    protocol: 'openai-chat',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-test',
    requiresKey: true,
    ...overrides,
  });
  expect(result.ok).toBe(true);
  return result.config!;
}

function makeConfig(modality: CustomModality, index: number): CustomModelConfig {
  const protocol: CustomProtocol =
    modality === 'text' ? 'openai-chat' : modality === 'image' ? 'openai-images' : 'openai-videos';
  return {
    id: `config-${index}`,
    createdAt: new Date().toISOString(),
    name: `${modality} ${index}`,
    modality,
    protocol,
    baseUrl: 'https://api.example.com/v1',
    model: `model-${index}`,
    requiresKey: true,
    capabilities: {},
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.removeItem(CUSTOM_MODELS_STORAGE_KEY);
  mocks.checkCustomModel.mockReset();
  mocks.checkVideoProfile.mockReset();
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
  useSettings.setState({
    ...initialActions,
    prefs: structuredClone(initialPrefs),
    keys: { ...initialKeys },
    customModels: [],
  });
});

describe('三模态列表', () => {
  it('渲染文字/图片/视频三个标签与空列表引导', () => {
    const el = renderSettings('custom');
    expect(el.textContent ?? '').toContain('自定义接入');
    for (const label of ['文字', '图片', '视频']) {
      expect(el.textContent ?? '').toContain(label);
    }
    expect(el.textContent ?? '').toContain('还没有文字自定义接入');
    expect(rowAction('新增文字自定义接入')).toBeTruthy();

    const imageTab = [...el.querySelectorAll('button')].find(
      (node) => (node.textContent ?? '').trim().startsWith('图片'),
    );
    click(imageTab);
    expect(el.textContent ?? '').toContain('还没有图片自定义接入');
  });
});

describe('新增 / 编辑 / 删除', () => {
  it('新增文字配置：保存后出现在列表，Key 写入 store 且状态为「已保存未测试」', () => {
    const el = renderSettings('custom');
    click(rowAction('新增文字自定义接入'));
    expect(dialog().textContent ?? '').toContain('新增自定义接入');
    // 默认需要 Key，Key 输入框可见
    const keyInput = dialogInput('自定义接入的 API Key');
    setInput(dialogInput('显示名'), '我的文字服务');
    setInput(dialogInput('接口地址'), 'https://api.example.com/v1');
    setInput(dialogInput('模型名'), 'gpt-test');
    setInput(keyInput, 'sk-test-123');
    saveDialog();

    const configs = useSettings.getState().customModels;
    expect(configs.length).toBe(1);
    expect(configs[0]!.name).toBe('我的文字服务');
    expect(configs[0]!.modality).toBe('text');
    expect(useSettings.getState().getCustomModelKey(configs[0]!.id)).toBe('sk-test-123');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const text = el.textContent ?? '';
    expect(text).toContain('我的文字服务');
    expect(text).toContain('gpt-test');
    expect(text).toContain('已保存未测试');
  });

  it('requiresKey 关掉后不再显示 Key 输入框，保存后状态为「不需要 Key」', () => {
    renderSettings('custom');
    click(rowAction('新增文字自定义接入'));
    expect(dialogInput('自定义接入的 API Key')).toBeTruthy();
    toggle(dialog().querySelector('input[aria-label="需要 API Key"]'));
    expect(dialog().querySelector('input[aria-label="自定义接入的 API Key"]')).toBeNull();

    setInput(dialogInput('显示名'), '本地文字服务');
    setInput(dialogInput('接口地址'), 'http://127.0.0.1:8000/v1');
    setInput(dialogInput('模型名'), 'local-model');
    saveDialog();

    expect(useSettings.getState().customModels[0]!.requiresKey).toBe(false);
    expect(document.body.textContent ?? '').toContain('不需要 Key');
  });

  it('校验错误就地展示，不关闭弹窗、不写配置', () => {
    renderSettings('custom');
    click(rowAction('新增文字自定义接入'));
    saveDialog();
    const d = dialog();
    expect(d.textContent ?? '').toContain('请填写显示名');
    expect(d.textContent ?? '').toContain('请填写 base URL');
    expect(d.textContent ?? '').toContain('请填写模型名');
    expect(useSettings.getState().customModels.length).toBe(0);
  });

  it('编辑：名称更新、id 与 createdAt 不变，类型不可改', () => {
    const config = addConfig();
    renderSettings('custom');
    click(rowAction(`编辑「${config.name}」`));
    expect(dialog().textContent ?? '').toContain('编辑自定义接入');
    // 已有配置类型不可改
    expect(dialog().querySelector('button[aria-label="自定义接入类型"]')?.hasAttribute('disabled')).toBe(true);
    setInput(dialogInput('显示名'), '改过的名字');
    saveDialog();
    const updated = useSettings.getState().customModels[0]!;
    expect(updated.name).toBe('改过的名字');
    expect(updated.id).toBe(config.id);
    expect(updated.createdAt).toBe(config.createdAt);
  });

  it('删除：确认后清掉配置与 Key', () => {
    const config = addConfig();
    useSettings.getState().setCustomModelKey(config.id, 'sk-test-123');
    renderSettings('custom');
    click(rowAction(`删除「${config.name}」`));
    expect(dialog().textContent ?? '').toContain('会删除');
    saveDialog();
    expect(useSettings.getState().customModels).toEqual([]);
    expect(useSettings.getState().getCustomModelKey(config.id)).toBe('');
  });
});

describe('默认模型 / 删除回退', () => {
  it('删除当前默认的自定义模型时提示会回退，确认后写回内置默认', () => {
    const config = addConfig({ name: '默认文字' });
    const profileId = customProfileId('text', config.id);
    useSettings.setState({
      prefs: { ...useSettings.getState().prefs, defaultLlmProfileId: profileId },
    });
    renderSettings('custom');
    click(rowAction('删除「默认文字」'));
    expect(dialog().textContent ?? '').toContain('切回内置默认');
    saveDialog();
    expect(useSettings.getState().prefs.defaultLlmProfileId).toBe(DEFAULT_LLM_PROFILE_ID);
  });

  it('默认模型下拉出现「自定义（文字）」分组，选中后写入 defaultLlmProfileId', () => {
    const config = addConfig({ name: '我的自定义文字' });
    const el = renderSettings('models');
    click(el.querySelector('button[aria-label="写故事与分镜的默认模型"]'));
    const groups = [...el.querySelectorAll('.select-group')].map((node) =>
      (node.textContent ?? '').trim(),
    );
    expect(groups).toContain('自定义（文字）');
    const option = [...el.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find(
      (node) => (node.textContent ?? '').includes('我的自定义文字'),
    );
    expect(option).toBeTruthy();
    click(option);
    expect(useSettings.getState().prefs.defaultLlmProfileId).toBe(
      customProfileId('text', config.id),
    );
  });

  it('删除后的自定义配置不出现在默认模型下拉', () => {
    const config = addConfig({ name: '将被删除' });
    useSettings.getState().removeCustomModel(config.id);
    const el = renderSettings('models');
    click(el.querySelector('button[aria-label="写故事与分镜的默认模型"]'));
    expect(el.textContent ?? '').not.toContain('将被删除');
    const groups = [...el.querySelectorAll('.select-group')].map((node) =>
      (node.textContent ?? '').trim(),
    );
    expect(groups).not.toContain('自定义（文字）');
  });

  it('自定义图片配置出现在「生成画面」下拉的「自定义（图片）」分组', () => {
    addConfig({
      name: '我的自定义图片',
      modality: 'image',
      protocol: 'openai-images',
      model: 'image-model',
    });
    const el = renderSettings('models');
    click(el.querySelector('button[aria-label="生成画面的默认模型"]'));
    const groups = [...el.querySelectorAll('.select-group')].map((node) =>
      (node.textContent ?? '').trim(),
    );
    expect(groups).toContain('自定义（图片）');
    expect(el.textContent ?? '').toContain('我的自定义图片');
  });
});

describe('测试连接', () => {
  it('成功后显示核心层 message 与「测试通过」状态', async () => {
    const config = addConfig({ requiresKey: false, name: '本地图' });
    mocks.checkCustomModel.mockResolvedValue({
      ok: true,
      status: 'ready',
      message: '连接正常：模型 gpt-test 可用（12ms）。',
      latencyMs: 12,
    } satisfies CustomModelCheckResult);
    const el = renderSettings('custom');
    click(rowAction(`测试「${config.name}」的连接`));
    await flush();
    expect(mocks.checkCustomModel).toHaveBeenCalledWith(config, '');
    const text = el.textContent ?? '';
    expect(text).toContain('连接正常：模型 gpt-test 可用');
    expect(text).toContain('测试通过');
  });

  it('401 失败显示人话「API Key 无效或没有权限」', async () => {
    const config = addConfig({ name: '要 Key 的' });
    useSettings.getState().setCustomModelKey(config.id, 'sk-test-401');
    mocks.checkCustomModel.mockResolvedValue({
      ok: false,
      status: 'unauthorized',
      message: 'API Key 无效或没有权限（HTTP 401/403）。检查 Key 是否复制完整。',
    } satisfies CustomModelCheckResult);
    const el = renderSettings('custom');
    click(rowAction(`测试「${config.name}」的连接`));
    await flush();
    const text = el.textContent ?? '';
    expect(text).toContain('API Key 无效或没有权限');
    expect(text).toContain('测试失败');
  });

  it('pending 时按钮禁用并显示「测试中…」，结束后恢复', async () => {
    const config = addConfig({ requiresKey: false, name: '慢服务' });
    let resolveCheck: (value: CustomModelCheckResult) => void = () => undefined;
    mocks.checkCustomModel.mockImplementation(
      () =>
        new Promise<CustomModelCheckResult>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    renderSettings('custom');
    const button = rowAction(`测试「${config.name}」的连接`);
    click(button);
    expect(button.disabled).toBe(true);
    expect((button.textContent ?? '').trim()).toBe('测试中…');
    await act(async () => {
      resolveCheck({ ok: true, status: 'ready', message: '连接正常' });
      await Promise.resolve();
    });
    expect(button.disabled).toBe(false);
    expect((button.textContent ?? '').trim()).toBe('测试连接');
  });

  it('视频配置可保存并测试本地视频服务（核心 checkVideoProfile）', async () => {
    addConfig({
      name: '视频占位',
      modality: 'video',
      protocol: 'openai-videos',
      model: 'video-model',
      requiresKey: false,
    });
    mocks.checkVideoProfile.mockResolvedValue({
      ok: true,
      status: 'ready',
      message: '视频服务已就绪：video-model',
    });
    const el = renderSettings('custom');
    click([...el.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').trim().startsWith('视频'),
    ));
    expect(el.textContent ?? '').toContain('本地视频走异步任务');
    click(rowAction('测试「视频占位」的连接'));
    await flush();
    expect(mocks.checkVideoProfile).toHaveBeenCalledTimes(1);
    expect(el.textContent ?? '').toContain('视频服务已就绪');
    expect(el.textContent ?? '').toContain('测试通过');
  });
});

describe('边界', () => {
  it('每个模态最多 10 条：达到上限后新增按钮禁用并提示', () => {
    useSettings.setState({
      customModels: Array.from({ length: 10 }, (_, index) => makeConfig('text', index)),
    });
    const el = renderSettings('custom');
    const addButton = el.querySelector<HTMLButtonElement>(
      'button[aria-label="新增文字自定义接入"]',
    );
    expect(addButton?.disabled).toBe(true);
    expect(el.textContent ?? '').toContain('已达 10 条上限');
  });

  it('地址过长时列表里截断展示，但 title 保留完整地址', () => {
    const longUrl = `https://api.example.com/${'very-long-segment/'.repeat(6)}v1`;
    addConfig({ name: '长地址', baseUrl: longUrl });
    const el = renderSettings('custom');
    const url = el.querySelector<HTMLElement>('.custom-url');
    expect(url).toBeTruthy();
    expect(url!.getAttribute('title')).toBe(longUrl);
    expect((url!.textContent ?? '').trim()).toBe(longUrl);
  });
});


describe('修复项（task-57）', () => {
  it('image /models 404（ok:true,status:unknown）显示黄色警告，不是绿色成功', async () => {
    const config = addConfig({
      name: '图片 404',
      modality: 'image',
      protocol: 'openai-images',
      model: 'img-model',
      requiresKey: false,
    });
    mocks.checkCustomModel.mockResolvedValue({
      ok: true,
      status: 'unknown',
      message: '服务可达，但没有 /models 接口，无法自动检测模型列表；可以保存配置后直接实跑。',
    } satisfies CustomModelCheckResult);
    const el = renderSettings('custom');
    switchTab(el, '图片');
    click(rowAction(`测试「${config.name}」的连接`));
    await flush();

    const status = el.querySelector('.custom-model .custom-status');
    expect(status?.textContent ?? '').toContain('无法自动检测');
    expect(status?.classList.contains('is-warning')).toBe(true);
    expect(status?.classList.contains('is-ok')).toBe(false);
    const resultBox = el.querySelector('.custom-model .issue');
    expect(resultBox?.classList.contains('warning')).toBe(true);
    expect(resultBox?.getAttribute('data-tone')).toBe('warning');
  });

  it('编辑保存后清空上一次测试连接结果', async () => {
    const config = addConfig({ name: '清旧结果', requiresKey: false });
    mocks.checkCustomModel.mockResolvedValue({
      ok: true,
      status: 'ready',
      message: '连接正常：模型可用（10ms）。',
    } satisfies CustomModelCheckResult);
    const el = renderSettings('custom');
    click(rowAction(`测试「${config.name}」的连接`));
    await flush();
    expect(el.textContent ?? '').toContain('连接正常：模型可用');

    click(rowAction(`编辑「${config.name}」`));
    setInput(dialogInput('显示名'), '清旧结果已改');
    saveDialog();

    expect(el.textContent ?? '').not.toContain('连接正常：模型可用');
    const status = el.querySelector('.custom-model .custom-status');
    expect(status?.textContent ?? '').toContain('不需要 Key');
  });

  it('新增写盘失败时弹窗显示「没能保存到本机」，不显示成功', () => {
    useSettings.setState({
      addCustomModel: (() => ({
        ok: false,
        message: '配置没能保存到本机（localStorage 不可用或已满）。请清理存储后重试。',
      })) as unknown as ReturnType<typeof useSettings.getState>['addCustomModel'],
    });
    renderSettings('custom');
    click(rowAction('新增文字自定义接入'));
    setInput(dialogInput('显示名'), '存不住的配置');
    setInput(dialogInput('接口地址'), 'https://api.example.com/v1');
    setInput(dialogInput('模型名'), 'gpt-test');
    saveDialog();

    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(dialog().textContent ?? '').toContain('没能保存到本机');
    expect(dialog().textContent ?? '').not.toContain('已添加');
  });

  it('删除写盘失败时显示「没能保存到本机」，不显示已删除', () => {
    const config = addConfig({ name: '删不掉' });
    useSettings.setState({
      removeCustomModel: (() => ({
        ok: false,
        message: '删除没能保存到本机（localStorage 不可用或已满）。请清理存储后重试。',
      })) as unknown as ReturnType<typeof useSettings.getState>['removeCustomModel'],
    });
    const el = renderSettings('custom');
    click(rowAction(`删除「${config.name}」`));
    saveDialog();

    expect(el.textContent ?? '').toContain('没能保存到本机');
    expect(el.textContent ?? '').not.toContain('已删除');
    expect(useSettings.getState().customModels.length).toBe(1);
  });

  it('Key 写盘失败时提示存储不可用，不显示已添加', () => {
    useSettings.setState({
      setCustomModelKey: (() => ({
        ok: false,
        message: 'Key 没能保存到本机（localStorage 不可用或已满）。请清理存储后重试。',
      })) as unknown as ReturnType<typeof useSettings.getState>['setCustomModelKey'],
    });
    const el = renderSettings('custom');
    click(rowAction('新增文字自定义接入'));
    setInput(dialogInput('显示名'), 'Key 存不住');
    setInput(dialogInput('接口地址'), 'https://api.example.com/v1');
    setInput(dialogInput('模型名'), 'gpt-test');
    setInput(dialogInput('自定义接入的 API Key'), 'sk-test-123');
    saveDialog();

    expect(el.textContent ?? '').toContain('没能保存到本机');
    expect(el.textContent ?? '').not.toContain('已添加');
  });

  it('文字最大输出 token 的文案说明会用于限制生成长度', () => {
    renderSettings('custom');
    click(rowAction('新增文字自定义接入'));
    expect(dialog().textContent ?? '').toContain('最大输出 token（可选，用于限制生成长度）');
    expect(dialog().textContent ?? '').toContain('留空用任务默认上限');
  });
});
