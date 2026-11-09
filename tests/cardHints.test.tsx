// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { CharactersPage } from '../src/pages/CharactersPage';
import { ScenesPage } from '../src/pages/ScenesPage';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 卡片底部不再挂一行摘要
 *
 * ===========================================================================
 * 为什么盯这个
 * ===========================================================================
 * 角色卡底部原来是 `身份概述 · 锁：A、B`，场景卡是 `光线 · 色调 · 固定元素`。
 * 这两行在只开一两个条目时不算什么，一屏十来个条目就变成一片灰色小字，
 * 把「这张卡是干什么的」盖掉了。
 *
 * 信息没有丢：角色卡表头已经有「N 镜出镜」「N 条锁 / 没有连续性锁」，
 * 场景卡表头已经有「N 镜」「设定完整 / 缺：…」。要点细节就展开。
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

beforeEach(() => {
  document.body.innerHTML = '';
  useAppStore.getState().setProject(structuredClone(sampleProject));
});

describe('角色卡与场景卡的折叠态', () => {
  it('角色卡底部没有摘要行', () => {
    const el = render(<CharactersPage />);
    const cards = [...el.querySelectorAll('.card')];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.querySelectorAll('.hint').length).toBe(0);
    }
  });

  it('场景卡底部没有摘要行', () => {
    const el = render(<ScenesPage />);
    const cards = [...el.querySelectorAll('.card')];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.querySelectorAll('.hint').length).toBe(0);
    }
  });

  it('摘要行删掉后，表头仍然写清出镜数与锁数', () => {
    const el = render(<CharactersPage />);
    const text = el.textContent ?? '';
    expect(text).toMatch(/\d+ 镜出镜/);
    expect(text).toMatch(/\d+ 条锁|没有连续性锁/);
  });

  it('场景表头仍然写清镜头数与设定是否完整', () => {
    const el = render(<ScenesPage />);
    const text = el.textContent ?? '';
    expect(text).toMatch(/\d+ 镜/);
    expect(text).toMatch(/设定完整|缺：/);
  });
});
