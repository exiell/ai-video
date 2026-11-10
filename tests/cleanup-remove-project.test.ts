import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 删除项目 & id 生成的小修（v0.55 · P3-15）
 *
 * ===========================================================================
 * 为什么要给「删除失败」单独立一个入口测
 * ===========================================================================
 * 页面直接 `void deleteProject(id)` 时，IndexedDB 异常会变成 unhandled rejection：
 * 用户点了「确认删除」，然后什么都没发生，也不知道项目还在不在。
 * store 的 `removeProject` 把异常翻成 { ok, error }，页面只需要显示结果。
 *
 * id 生成：优先 crypto.randomUUID（碰撞可忽略），只在测试桩/极老环境退回 Math.random。
 */

const mocks = vi.hoisted(() => ({ deleteProject: vi.fn() }));

vi.mock('../src/services/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage')>();
  return { ...actual, deleteProject: mocks.deleteProject };
});

import { useAppStore } from '../src/store/app';

beforeEach(() => {
  mocks.deleteProject.mockReset();
});

describe('store.removeProject · 删除失败不再静默', () => {
  it('成功时返回 { ok: true }', async () => {
    mocks.deleteProject.mockResolvedValue(undefined);
    await expect(useAppStore.getState().removeProject('proj-1')).resolves.toEqual({ ok: true });
    expect(mocks.deleteProject).toHaveBeenCalledWith('proj-1');
  });

  it('**异常被兜成 { ok: false, error }，不往外抛**', async () => {
    mocks.deleteProject.mockRejectedValue(new Error('blocked by another tab'));
    const result = await useAppStore.getState().removeProject('proj-2');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('删除失败');
    expect(result.error).toContain('都还在'); // 明确告诉用户项目没丢
  });
});
