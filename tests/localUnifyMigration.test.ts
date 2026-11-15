// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_MODEL_PROFILES,
  LOCAL_MODEL_PROFILES,
  findProfile,
  resolveAllProfiles,
} from '../src/data/models/profiles';
import {
  MIGRATED_LOCAL_FLUX3_CONFIG_ID,
  applyLocalModelMigration,
  planLocalModelMigration,
  useSettings,
} from '../src/store/settings';
import type { Prefs } from '../src/store/settings';
import type { CustomModelConfig } from '../src/types/customModel';
import {
  CUSTOM_MODELS_STORAGE_KEY,
  customProfileId,
  readCustomModelConfigs,
  writeCustomModelConfigs,
} from '../src/data/customModels';

/**
 * v0.64：本地模型统一进自定义接入 · 核心层
 *
 * 覆盖 hidden 过滤、findProfile 兼容、迁移触发/幂等/默认切换、
 * 写盘失败安全降级、迁移后 resolveAllProfiles 只展示自定义配置。
 */

function basePrefs(overrides: Partial<Prefs> = {}): Prefs {
  return {
    ...useSettings.getState().prefs,
    defaultLlmProfileId: 'deepseek-flash',
    defaultT2iProfileId: 'qwen-image',
    defaultReferenceProfileId: 'qwen-image-edit',
    localModelEndpoint: '',
    localModelTimeoutMs: undefined,
    localModelMigrated: false,
    ...overrides,
  };
}

const migratedProfileId = customProfileId('image', MIGRATED_LOCAL_FLUX3_CONFIG_ID);

function imageConfig(id: string): CustomModelConfig {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    name: `图片 ${id}`,
    modality: 'image',
    protocol: 'openai-images',
    baseUrl: 'https://api.example.com/v1',
    model: 'image-model',
    requiresKey: true,
    capabilities: { maxOutputImages: 1 },
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('hidden 内置本地档案', () => {
  it('local-flux3 标 hidden，但 findProfile 仍能解析', () => {
    const profile = findProfile('local-flux3');
    expect(profile).toBeDefined();
    expect(profile?.hidden).toBe(true);
    expect(profile?.endpoint).toBe('http://127.0.0.1:8099/v1');
  });

  it('resolveAllProfiles 默认过滤 hidden；includeHidden 可拿回；旧导出语义不变', () => {
    expect(resolveAllProfiles().some((profile) => profile.id === 'local-flux3')).toBe(false);
    expect(
      resolveAllProfiles({ includeHidden: true }).some((profile) => profile.id === 'local-flux3'),
    ).toBe(true);
    // 旧静态导出仍包含（兼容旧代码/旧测试）
    expect(LOCAL_MODEL_PROFILES.some((profile) => profile.id === 'local-flux3')).toBe(true);
    expect(ALL_MODEL_PROFILES.some((profile) => profile.id === 'local-flux3')).toBe(true);
  });
});

describe('迁移计划（纯函数）', () => {
  it('无触发条件：不创建配置、不改默认', () => {
    const plan = planLocalModelMigration(basePrefs(), []);
    expect(plan.changed).toBe(false);
    expect(plan.needsConfigWrite).toBe(false);
    expect(plan.configs).toEqual([]);
  });

  it('localModelEndpoint 非空：创建配置并切换默认，字段正确', () => {
    const plan = planLocalModelMigration(
      basePrefs({ localModelEndpoint: 'http://127.0.0.1:9999/v1', localModelTimeoutMs: 123_456 }),
      [],
    );
    expect(plan.changed).toBe(true);
    expect(plan.needsConfigWrite).toBe(true);
    expect(plan.configs).toHaveLength(1);
    const config = plan.configs[0]!;
    expect(config.id).toBe(MIGRATED_LOCAL_FLUX3_CONFIG_ID);
    expect(config.name).toBe('本地 FLUX3（自动迁移）');
    expect(config.modality).toBe('image');
    expect(config.protocol).toBe('vllm-omni-chat-image');
    expect(config.baseUrl).toBe('http://127.0.0.1:9999/v1');
    expect(config.model).toBe('flux-3-image-klein');
    expect(config.requiresKey).toBe(false);
    expect(config.timeoutMs).toBe(123_456);
    expect(config.capabilities.maxReferenceImages).toBe(10);
    expect(config.capabilities.maxOutputImages).toBe(1);
    expect(plan.prefs.defaultT2iProfileId).toBe(migratedProfileId);
    expect(plan.prefs.defaultReferenceProfileId).toBe(migratedProfileId);
    expect(plan.prefs.localModelMigrated).toBe(true);
    // 旧字段保留（deprecated 但可读）
    expect(plan.prefs.localModelEndpoint).toBe('http://127.0.0.1:9999/v1');
  });

  it('默认 id 指向 local-flux3（无 endpoint）也会迁移，使用默认 8099 和 600s', () => {
    const plan = planLocalModelMigration(
      basePrefs({ defaultT2iProfileId: 'local-flux3', defaultReferenceProfileId: 'local-flux3' }),
      [],
    );
    expect(plan.changed).toBe(true);
    expect(plan.configs[0]!.baseUrl).toBe('http://127.0.0.1:8099/v1');
    expect(plan.configs[0]!.timeoutMs).toBe(600_000);
    expect(plan.prefs.defaultT2iProfileId).toBe(migratedProfileId);
  });

  it('标记已存在：幂等，不重复创建', () => {
    const existing = planLocalModelMigration(
      basePrefs({ localModelEndpoint: 'http://127.0.0.1:9999/v1' }),
      [],
    );
    const second = planLocalModelMigration(existing.prefs, existing.configs);
    expect(second.changed).toBe(false);
    expect(second.configs).toHaveLength(1);
    expect(second.prefs.defaultT2iProfileId).toBe(migratedProfileId);
  });

  it('已有迁移配置但标记丢失：复用配置，不重复创建', () => {
    const first = planLocalModelMigration(
      basePrefs({ localModelEndpoint: 'http://127.0.0.1:9999/v1' }),
      [],
    );
    const second = planLocalModelMigration(
      basePrefs({ localModelEndpoint: 'http://127.0.0.1:8888/v1' }),
      first.configs,
    );
    expect(second.needsConfigWrite).toBe(false);
    expect(second.configs).toHaveLength(1);
    expect(second.configs[0]!.baseUrl).toBe('http://127.0.0.1:9999/v1');
  });

  it('端点归一：/v1/models、裸主机、尾斜杠、完整 chat 路径都得到同一 /v1', () => {
    const cases: [string, string][] = [
      ['http://127.0.0.1:9999/v1/models', 'http://127.0.0.1:9999/v1'],
      ['http://127.0.0.1:9999', 'http://127.0.0.1:9999/v1'],
      ['http://127.0.0.1:9999/v1///', 'http://127.0.0.1:9999/v1'],
      ['http://127.0.0.1:9999/v1/chat/completions', 'http://127.0.0.1:9999/v1'],
    ];
    for (const [raw, expected] of cases) {
      const plan = planLocalModelMigration(basePrefs({ localModelEndpoint: raw }), []);
      expect(plan.changed, raw).toBe(true);
      expect(plan.configs[0]!.baseUrl, raw).toBe(expected);
    }
  });

  it('非法/空归一 endpoint 不迁移；默认仍指 local-flux3 且可解析（hidden 显示兼容）', () => {
    const prefs = basePrefs({
      localModelEndpoint: 'https://user:pass@host/v1',
      defaultT2iProfileId: 'local-flux3',
      defaultReferenceProfileId: 'local-flux3',
    });
    const plan = planLocalModelMigration(prefs, []);
    expect(plan.changed).toBe(false);
    expect(plan.configs).toEqual([]);
    expect(plan.prefs.defaultT2iProfileId).toBe('local-flux3');
    const fallback = findProfile(plan.prefs.defaultT2iProfileId);
    expect(fallback?.hidden).toBe(true);
    expect(fallback?.id).toBe('local-flux3');
  });

  it('图片配置已满 10 条且无迁移配置：不创建、保持旧默认', () => {
    const existing = Array.from({ length: 10 }, (_, index) => imageConfig(`img-${index}`));
    const plan = planLocalModelMigration(
      basePrefs({ localModelEndpoint: 'http://127.0.0.1:9999/v1' }),
      existing,
    );
    expect(plan.changed).toBe(false);
    expect(plan.configs).toHaveLength(10);
    expect(plan.prefs.localModelMigrated).toBe(false);
    expect(plan.prefs.defaultT2iProfileId).toBe('qwen-image');
    expect(plan.configs.some((config) => config.id === MIGRATED_LOCAL_FLUX3_CONFIG_ID)).toBe(false);
  });

  it('已有迁移配置时不受 10 条上限影响（复用，不新增）', () => {
    const first = planLocalModelMigration(
      basePrefs({ localModelEndpoint: 'http://127.0.0.1:9999/v1' }),
      [],
    );
    const others = Array.from({ length: 9 }, (_, index) => imageConfig(`other-${index}`));
    const plan = planLocalModelMigration(
      basePrefs({ localModelEndpoint: 'http://127.0.0.1:8888/v1' }),
      [...first.configs, ...others],
    );
    expect(plan.changed).toBe(true);
    expect(plan.needsConfigWrite).toBe(false);
    expect(plan.configs).toHaveLength(10);
    expect(plan.configs.filter((config) => config.id === MIGRATED_LOCAL_FLUX3_CONFIG_ID)).toHaveLength(1);
  });

  it('非法 endpoint：安全降级，不写半截配置', () => {
    const plan = planLocalModelMigration(
      basePrefs({ localModelEndpoint: 'https://user:pass@host/v1' }),
      [],
    );
    expect(plan.changed).toBe(false);
    expect(plan.configs).toEqual([]);
  });
});

describe('迁移执行与写盘失败', () => {
  it('成功：写配置 + 写 prefs，默认切到动态档案', () => {
    const writeConfigs = vi.fn(() => true);
    const writePrefs = vi.fn(() => true);
    const result = applyLocalModelMigration(
      basePrefs({ localModelEndpoint: 'http://127.0.0.1:9999/v1' }),
      [],
      { writeConfigs, writePrefs },
    );
    expect(result.changed).toBe(true);
    expect(result.configWriteFailed).toBe(false);
    expect(result.prefsWriteFailed).toBe(false);
    expect(writeConfigs).toHaveBeenCalledTimes(1);
    expect(writePrefs).toHaveBeenCalledTimes(1);
    expect(result.prefs.defaultT2iProfileId).toBe(migratedProfileId);
    expect(result.configs).toHaveLength(1);
  });

  it('配置写盘失败：保留旧 prefs/配置，不阻塞启动', () => {
    const writePrefs = vi.fn(() => true);
    const result = applyLocalModelMigration(
      basePrefs({ localModelEndpoint: 'http://127.0.0.1:9999/v1' }),
      [],
      { writeConfigs: () => false, writePrefs },
    );
    expect(result.changed).toBe(false);
    expect(result.configWriteFailed).toBe(true);
    expect(result.configs).toEqual([]);
    expect(result.prefs.defaultT2iProfileId).toBe('qwen-image');
    expect(result.prefs.defaultReferenceProfileId).toBe('qwen-image-edit');
    expect(result.prefs.localModelMigrated).toBe(false);
    expect(writePrefs).not.toHaveBeenCalled();
  });

  it('配置写盘失败时默认仍指 hidden local-flux3，findProfile 可显示', () => {
    const result = applyLocalModelMigration(
      basePrefs({
        localModelEndpoint: 'http://127.0.0.1:9999/v1',
        defaultT2iProfileId: 'local-flux3',
        defaultReferenceProfileId: 'local-flux3',
      }),
      [],
      { writeConfigs: () => false, writePrefs: () => true },
    );
    expect(result.changed).toBe(false);
    expect(result.prefs.defaultT2iProfileId).toBe('local-flux3');
    expect(findProfile(result.prefs.defaultT2iProfileId)?.hidden).toBe(true);
    expect(findProfile(result.prefs.defaultT2iProfileId)?.id).toBe('local-flux3');
  });

  it('prefs 写盘失败：配置已写入，返回迁移后的内存值并标记失败', () => {
    const result = applyLocalModelMigration(
      basePrefs({ localModelEndpoint: 'http://127.0.0.1:9999/v1' }),
      [],
      { writeConfigs: () => true, writePrefs: () => false },
    );
    expect(result.changed).toBe(true);
    expect(result.configWriteFailed).toBe(false);
    expect(result.prefsWriteFailed).toBe(true);
    expect(result.prefs.defaultT2iProfileId).toBe(migratedProfileId);
  });

  it('迁移后 resolveAllProfiles：内置 local-flux3 隐藏，动态自定义可见；旧 findProfile 兼容', () => {
    const plan = planLocalModelMigration(
      basePrefs({ localModelEndpoint: 'http://127.0.0.1:9999/v1' }),
      [],
    );
    writeCustomModelConfigs(plan.configs);
    const visible = resolveAllProfiles();
    expect(visible.some((profile) => profile.id === 'local-flux3')).toBe(false);
    expect(visible.some((profile) => profile.id === migratedProfileId)).toBe(true);
    expect(findProfile('local-flux3')?.hidden).toBe(true);
    expect(findProfile(migratedProfileId)?.endpoint).toBe(
      'http://127.0.0.1:9999/v1/chat/completions',
    );
    // 写回 localStorage 的配置可被 store 读取
    expect(readCustomModelConfigs()).toHaveLength(1);
    expect(localStorage.getItem(CUSTOM_MODELS_STORAGE_KEY)).toContain(MIGRATED_LOCAL_FLUX3_CONFIG_ID);
  });
});
