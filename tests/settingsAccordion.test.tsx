// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * 设置页「连接与 Key」厂商条目折叠（v0.65）
 *
 * 目标：每家厂商默认收起，收起态能看出 Key/测试/CORS 状态；
 * 展开后原有 Key 输入、测试连接、模型名覆盖、去申请 Key 全部保留；
 * 代理卡不动。键盘可达靠原生 button + aria-expanded/aria-controls。
 */

const mocks = vi.hoisted(() => ({ testConnection: vi.fn() }));

vi.mock('../src/services/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/gateway')>();
  return { ...actual, testConnection: mocks.testConnection };
});

import { SettingsPage } from '../src/pages/SettingsPage';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { sampleProject } from '../src/data/samples/sampleProject';

const initialPrefs = structuredClone(useSettings.getState().prefs);
const initialKeys = { ...useSettings.getState().keys };

let container: HTMLDivElement | null = null;

function renderConnection(): HTMLDivElement {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/settings/connection']}>
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

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function vendorHeads(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>('button.vendor-head')];
}

function bodyOf(el: HTMLElement, head: HTMLButtonElement): HTMLElement {
  const id = head.getAttribute('aria-controls');
  expect(id).toBeTruthy();
  const body = el.querySelector<HTMLElement>(`#${id}`);
  expect(body).toBeTruthy();
  return body!;
}

beforeEach(() => {
  document.body.innerHTML = '';
  mocks.testConnection.mockReset();
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
  useSettings.setState({ prefs: structuredClone(initialPrefs), keys: { ...initialKeys } });
});

describe('厂商条目：默认收起', () => {
  it('每个厂商都是 button 标题，aria-expanded=false，内容默认 hidden', () => {
    const el = renderConnection();
    const heads = vendorHeads(el);
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) {
      expect(head.tagName).toBe('BUTTON');
      expect(head.getAttribute('type')).toBe('button');
      expect(head.getAttribute('aria-expanded')).toBe('false');
      const body = bodyOf(el, head);
      expect(body.hidden).toBe(true);
    }
  });

  it('收起态摘要显示 Key 状态、测试状态和 CORS 已知状态', () => {
    const el = renderConnection();
    const text = el.textContent ?? '';
    expect(text).toContain('未保存 Key');
    expect(text).toContain('未测试');
    expect(text.includes('CORS 待实测') || text.includes('可直连')).toBe(true);
  });

  it('代理卡保持平铺：地址输入默认可见，没有被折叠', () => {
    const el = renderConnection();
    const proxyInput = el.querySelector<HTMLInputElement>('input[placeholder="留空 = 直连"]');
    expect(proxyInput).toBeTruthy();
    expect(proxyInput!.closest('[hidden]')).toBeNull();
  });
});

describe('厂商条目：展开后功能不丢', () => {
  it('点击展开：aria-expanded=true、内容显示、可填 Key', () => {
    const el = renderConnection();
    const head = vendorHeads(el)[0]!;
    click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(bodyOf(el, head).hidden).toBe(false);

    const keyInput = bodyOf(el, head).querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    expect(keyInput).toBeTruthy();
    setInput(keyInput!, 'sk-test-123');
    expect(Object.values(useSettings.getState().keys)).toContain('sk-test-123');

    // 收起后摘要更新为已保存
    click(head);
    expect(el.textContent ?? '').toContain('Key 已保存');
  });

  it('展开后测试连接可点，收起摘要显示测试结果', async () => {
    mocks.testConnection.mockResolvedValue({
      ok: true,
      via: 'direct',
      elapsedMs: 12,
      sample: 'pong',
    } as never);
    const el = renderConnection();
    const head = vendorHeads(el)[0]!;
    click(head);
    const body = bodyOf(el, head);
    const keyInput = body.querySelector<HTMLInputElement>('input[type="password"]')!;
    setInput(keyInput, 'sk-test-123');
    const testButton = [...body.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => (node.textContent ?? '').trim() === '测试连接',
    );
    expect(testButton).toBeTruthy();
    click(testButton);
    await flush();
    expect(mocks.testConnection).toHaveBeenCalledTimes(1);

    click(head);
    expect(el.textContent ?? '').toContain('测试通过');
  });

  it('展开后原有模型名覆盖与去申请 Key 仍然存在', () => {
    const el = renderConnection();
    const head = vendorHeads(el)[0]!;
    click(head);
    const body = bodyOf(el, head);
    expect(body.textContent ?? '').toContain('去申请 Key');
    expect(body.textContent ?? '').toContain('某个模型报「模型名不支持」时改这里');
  });
});
