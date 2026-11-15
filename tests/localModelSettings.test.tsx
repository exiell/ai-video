// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * 设置页「本地模型」入口（v0.61 · unified-model-ui）
 *
 * 只测 UI 接线：
 *  - 本地区块渲染、端点默认值/保存、能力展示、不需要 Key；
 *  - 「测试连接」成功/失败/格式不对都显示人话；pending 时禁用；
 *  - 模型候选里本地档案单独一组，选中后设置页有明确状态。
 *
 * 真正的本地服务探测在 core 层，测试统一 mock `checkLocalModel`，不打网络。
 */

const mocks = vi.hoisted(() => ({ checkLocalModel: vi.fn() }));

vi.mock('../src/store/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/store/settings')>();
  return { ...actual, checkLocalModel: mocks.checkLocalModel };
});

import { SettingsPage } from '../src/pages/SettingsPage';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { sampleProject } from '../src/data/samples/sampleProject';
import {
  DEFAULT_LOCAL_MODEL_ENDPOINT,
  LOCAL_FLUX3_PROFILE_ID,
  type LocalModelCheckResult,
} from '../src/services/gateway/localModel';

const initialPrefs = structuredClone(useSettings.getState().prefs);

let container: HTMLDivElement | null = null;

function renderTab(tab: 'connection' | 'models'): HTMLDivElement {
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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function localCard(el: HTMLElement): HTMLElement | undefined {
  return [...el.querySelectorAll<HTMLElement>('.card')].find((card) =>
    (card.querySelector('.card-title')?.textContent ?? '').includes('本地模型'),
  );
}

function localTestButton(el: HTMLElement): HTMLButtonElement {
  const button = el.querySelector<HTMLButtonElement>('button[aria-label="测试本地模型连接"]');
  expect(button).toBeTruthy();
  return button!;
}

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.checkLocalModel.mockReset();
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
  useSettings.setState({ prefs: structuredClone(initialPrefs) });
});

describe('连接页：本地模型区块', () => {
  it('渲染区块、能力说明和地址输入（默认空 + 档案默认 placeholder），不需要 Key', () => {
    const el = renderTab('connection');
    const card = localCard(el);
    expect(card).toBeTruthy();
    const text = card!.textContent ?? '';
    expect(text).toContain('本地 FLUX3（需本机 vLLM-Omni）');
    expect(text).toContain('不需要 API Key');
    expect(text).toContain('最多 10 张参考图');
    expect(text).toContain('每次出 1 张');
    expect(text).toContain('不支持负向词');

    const input = card!.querySelector<HTMLInputElement>('input[aria-label="本地模型服务地址"]');
    expect(input).toBeTruthy();
    expect(input!.value).toBe('');
    expect(input!.placeholder).toBe(DEFAULT_LOCAL_MODEL_ENDPOINT);

    const button = localTestButton(card!);
    expect(button.getAttribute('title')?.trim().length ?? 0).toBeGreaterThan(0);
    // 本地档案不需要 Key：区块里没有 password 输入框
    expect(card!.querySelector('input[type="password"]')).toBeNull();
  });

  it('地址输入写入 prefs.localModelEndpoint', () => {
    const el = renderTab('connection');
    const input = el.querySelector<HTMLInputElement>('input[aria-label="本地模型服务地址"]')!;
    setInputValue(input, 'http://127.0.0.1:9000/v1');
    expect(useSettings.getState().prefs.localModelEndpoint).toBe('http://127.0.0.1:9000/v1');
  });

  it('测试连接成功：显示 store 的人话结果与模型名', async () => {
    mocks.checkLocalModel.mockResolvedValue({
      ok: true,
      message: '本地模型可用：flux-3-image-klein（12ms）',
      endpoint: DEFAULT_LOCAL_MODEL_ENDPOINT,
      models: ['flux-3-image-klein'],
      latencyMs: 12,
    } satisfies LocalModelCheckResult);
    const el = renderTab('connection');
    click(localTestButton(el));
    await flush();
    expect(mocks.checkLocalModel).toHaveBeenCalledTimes(1);
    const text = el.textContent ?? '';
    expect(text).toContain('本地模型可用：flux-3-image-klein');
    expect(text).toContain('模型：');
    expect(text).toContain('flux-3-image-klein');
  });

  it('测试连接失败：显示「连不上」的人话提示，不甩英文/状态码', async () => {
    mocks.checkLocalModel.mockResolvedValue({
      ok: false,
      message:
        '连不上本地服务。确认地址/端口正确、vLLM-Omni 已启动；浏览器直连需要端口转发，并且 vLLM 要允许应用 origin。',
      endpoint: DEFAULT_LOCAL_MODEL_ENDPOINT,
    } satisfies LocalModelCheckResult);
    const el = renderTab('connection');
    click(localTestButton(el));
    await flush();
    const text = el.textContent ?? '';
    expect(text).toContain('连不上本地服务');
    expect(text).toContain('vLLM-Omni 已启动');
    expect(text).toContain('端口转发');
  });

  it('pending 时按钮禁用并显示「测试中…」', async () => {
    let resolveCheck: (value: LocalModelCheckResult) => void = () => undefined;
    mocks.checkLocalModel.mockImplementation(
      () =>
        new Promise<LocalModelCheckResult>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const el = renderTab('connection');
    const button = localTestButton(el);
    click(button);
    expect(button.disabled).toBe(true);
    expect((button.textContent ?? '').trim()).toBe('测试中…');
    await act(async () => {
      resolveCheck({ ok: true, message: '本地模型可用', endpoint: DEFAULT_LOCAL_MODEL_ENDPOINT });
      await Promise.resolve();
    });
    expect(button.disabled).toBe(false);
    expect((button.textContent ?? '').trim()).toBe('测试连接');
  });

  it('地址格式不对时先拦下，不调用网络', () => {
    useSettings.setState({
      prefs: { ...useSettings.getState().prefs, localModelEndpoint: 'localhost:8099' },
    });
    const el = renderTab('connection');
    click(localTestButton(el));
    expect(mocks.checkLocalModel).not.toHaveBeenCalled();
    expect(el.textContent ?? '').toContain('这个地址看起来不对');
    expect(el.textContent ?? '').toContain('http://127.0.0.1:8099/v1');
  });

  it('已填地址时，测试连接把该地址传给 checkLocalModel', async () => {
    mocks.checkLocalModel.mockResolvedValue({
      ok: true,
      message: '本地模型可用',
      endpoint: 'http://127.0.0.1:9000/v1',
    } satisfies LocalModelCheckResult);
    useSettings.setState({
      prefs: { ...useSettings.getState().prefs, localModelEndpoint: 'http://127.0.0.1:9000/v1' },
    });
    const el = renderTab('connection');
    click(localTestButton(el));
    await flush();
    expect(mocks.checkLocalModel).toHaveBeenCalledWith({ endpoint: 'http://127.0.0.1:9000/v1' });
  });
});

describe('默认模型页：本地档案单独一组 + 选中状态', () => {
  it('默认档案仍是云端，不默认启用本地模型', () => {
    const el = renderTab('models');
    expect(useSettings.getState().prefs.defaultReferenceProfileId).not.toBe(LOCAL_FLUX3_PROFILE_ID);
    expect(useSettings.getState().prefs.defaultT2iProfileId).not.toBe(LOCAL_FLUX3_PROFILE_ID);
    // 没有选中本地时，不显示「当前使用本地模型」
    expect(el.textContent ?? '').not.toContain('当前使用本地模型');
  });

  it('候选里本地档案在「本地（需自己启动服务）」分组，选中后状态明确', () => {
    const el = renderTab('models');
    const trigger = el.querySelector<HTMLButtonElement>(
      'button[aria-label="生成画面的默认模型"]',
    )!;
    click(trigger);
    // 分组标题出现，云端档案不在本地组里
    const groups = [...el.querySelectorAll('.select-group')].map((node) =>
      (node.textContent ?? '').trim(),
    );
    expect(groups).toContain('本地（需自己启动服务）');

    const localOption = [...el.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find(
      (option) => (option.textContent ?? '').includes('本地 FLUX3（需本机 vLLM-Omni）'),
    );
    expect(localOption).toBeTruthy();
    click(localOption);

    expect(useSettings.getState().prefs.defaultReferenceProfileId).toBe(LOCAL_FLUX3_PROFILE_ID);
    expect(useSettings.getState().prefs.defaultT2iProfileId).toBe(LOCAL_FLUX3_PROFILE_ID);
    expect(el.textContent ?? '').toContain('当前使用本地模型');
    expect(el.textContent ?? '').toContain('不需要 API Key');
    // 触发器上显示本地档案名
    expect((trigger.querySelector('.select-value')?.textContent ?? '').trim()).toContain(
      '本地 FLUX3',
    );
  });
});
