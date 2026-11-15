// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * v0.64 迁移在 settings store 初始化时真实执行（动态 import 重跑模块）。
 * 覆盖：触发、默认切换、幂等、写盘失败安全降级。
 */

const PREFS_KEY = 'aniguide:prefs';
const CUSTOM_KEY = 'aniguide:custom-models';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
});

describe('settings 初始化迁移', () => {
  it('localModelEndpoint 非空 → 初始化时创建配置并切默认；重载幂等', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ localModelEndpoint: 'http://127.0.0.1:9999/v1' }));

    const first = await import('../src/store/settings');
    const state = first.useSettings.getState();
    const profileId = 'custom:image:migrated-local-flux3';
    expect(state.prefs.defaultT2iProfileId).toBe(profileId);
    expect(state.prefs.defaultReferenceProfileId).toBe(profileId);
    expect(state.prefs.localModelMigrated).toBe(true);
    expect(state.customModels).toHaveLength(1);
    expect(state.customModels[0]!.id).toBe('migrated-local-flux3');
    expect(state.customModels[0]!.baseUrl).toBe('http://127.0.0.1:9999/v1');
    expect(localStorage.getItem(CUSTOM_KEY)).toContain('migrated-local-flux3');

    // 模拟刷新：重新加载模块，不重复创建
    vi.resetModules();
    const second = await import('../src/store/settings');
    const reloaded = second.useSettings.getState();
    expect(reloaded.customModels).toHaveLength(1);
    expect(reloaded.prefs.defaultT2iProfileId).toBe(profileId);
    expect(reloaded.prefs.defaultReferenceProfileId).toBe(profileId);
  });

  it('端点写 /v1/models：初始化迁移时归一为 /v1', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ localModelEndpoint: 'http://127.0.0.1:9999/v1/models' }));
    const loaded = await import('../src/store/settings');
    const state = loaded.useSettings.getState();
    expect(state.customModels).toHaveLength(1);
    expect(state.customModels[0]!.baseUrl).toBe('http://127.0.0.1:9999/v1');
  });

  it('写盘失败：应用仍可启动，保留旧默认与空配置', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ localModelEndpoint: 'http://127.0.0.1:9999/v1' }));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    const loaded = await import('../src/store/settings');
    const state = loaded.useSettings.getState();
    expect(state.customModels).toEqual([]);
    expect(state.prefs.defaultT2iProfileId).toBe('qwen-image');
    expect(state.prefs.defaultReferenceProfileId).toBe('qwen-image-edit');
    expect(state.prefs.localModelMigrated).toBe(false);
  });

  it('默认 id 指向 local-flux3（无 endpoint）→ 用默认 8099 迁移', async () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        defaultT2iProfileId: 'local-flux3',
        defaultReferenceProfileId: 'local-flux3',
      }),
    );
    const loaded = await import('../src/store/settings');
    const state = loaded.useSettings.getState();
    expect(state.customModels).toHaveLength(1);
    expect(state.customModels[0]!.baseUrl).toBe('http://127.0.0.1:8099/v1');
    expect(state.prefs.defaultT2iProfileId).toBe('custom:image:migrated-local-flux3');
  });

  it('无 endpoint 且默认不是 local-flux3 → 不迁移', async () => {
    const loaded = await import('../src/store/settings');
    const state = loaded.useSettings.getState();
    expect(state.customModels).toEqual([]);
    expect(state.prefs.localModelMigrated).toBe(false);
  });
});
