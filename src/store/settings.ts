import { create } from 'zustand';
import { DEFAULT_REFERENCE_PROFILE_ID, DEFAULT_T2I_PROFILE_ID, MODEL_PROFILES } from '../data/models/profiles';
import {
  countCustomModels,
  customProfileId,
  customVendorId,
  isCustomProfileId,
  MAX_CUSTOM_MODELS_PER_MODALITY,
  readCustomModelConfigs,
  validateCustomModel,
  writeCustomModelConfigs,
} from '../data/customModels';
import type { CustomModelConfig, CustomModelDraft, CustomModelValidation } from '../types/customModel';
import { DEFAULT_LLM_PROFILE_ID } from '../types/customModel';
import {
  DEFAULT_LOCAL_MODEL_ENDPOINT,
  DEFAULT_LOCAL_TIMEOUT_MS,
  LOCAL_FLUX3_PROFILE_ID,
  normalizeLocalEndpoint,
  probeLocalModel,
  type LocalModelCheckOptions,
  type LocalModelCheckResult,
} from '../services/gateway/localModel';

/**
 * 设置状态（方案.md v0.6 §3.2 M0 + §0.1 第 4 条 BYOK）
 *
 * 存储策略是刻意分开的：
 *  - **API Key**：**默认存 localStorage**（关掉浏览器仍然保留）。
 *    不想留在本机，就勾选「不保存到本机」——那时只存 sessionStorage，
 *    关掉浏览器即失效。
 *
 *    【v0.32 反转移默认值】原来是「默认不存、勾选才存」。
 *    改成「默认就存、勾选不存」的理由是：**每次打开都要重填 Key 是劝退级的摩擦**，
 *    而它带来的安全收益很有限 —— Key 本来就只在这台机器、这个浏览器里，
 *    从不离开浏览器。用一个每次都要付出的代价，换一个边际的安全性，不划算。
 *    真正在意的人可以勾上「不保存到本机」，选择权还在用户手里。
 *  - **偏好项**（默认模型、代理地址等）：存 localStorage，无所谓。
 *
 * 任何情况下都不上传。请求只在「浏览器 → 模型厂商」之间发生；
 * 若用户主动填了代理地址，才会经代理转发（代理侧要求无状态、不落库）。
 */

const LS_PREFS = 'aniguide:prefs';
const LS_MODEL_OVERRIDES = 'aniguide:model-overrides';
const LS_KEYS = 'aniguide:keys';
const SS_KEYS = 'aniguide:keys:session';
/**
 * 「不保存到本机」时，代理口令只留在会话存储里。
 *
 * 为什么不跟 prefs 一起直接进 localStorage：口令和 API Key 一样属于凭据，
 * 用户勾了「不保存」之后，屏幕上、磁盘上都不该继续留着它。
 */
const SS_PROXY_PASSWORD = 'aniguide:proxy-password:session';

export interface Prefs {
  /**
   * 用户是否勾选了「不保存到本机」。
   *
   * 【注意语义是反的】`true` 表示**不落盘**（只用会话存储）。
   * 字段名也跟着反转，而不是沿用 `rememberKeys` 取反 ——
   * 一个叫「记住」的字段存着「不要记住」，是以后必然读错的那种坑。
   */
  dontSaveKeys: boolean;
  /** 当前默认使用的 LLM 档案 id */
  defaultLlmProfileId: string;
  /** 当前默认使用的文生图档案 id */
  defaultT2iProfileId: string;
  /** 当前默认使用的「带参考图」档案 id —— L3 锚定用它 */
  defaultReferenceProfileId: string;
  /** 当前默认视频档案 id（v0.65 视频层）；空/未配置时回退唯一自定义视频 */
  defaultVideoProfileId?: string;
  /** 代理地址（留空 = 直连） */
  proxyBaseUrl: string;
  /** 代理通行口令 */
  proxyPassword: string;
  /**
   * 本地模型端点覆盖（v0.61）。
   * @deprecated v0.64：本地模型已统一进自定义接入；仅保留给未迁移的旧数据/兼容读取。
   * 迁移完成前这一项会用于生成「本地 FLUX3（自动迁移）」配置。
   */
  localModelEndpoint?: string;
  /**
   * 本地模型超时覆盖（毫秒）。
   * @deprecated v0.64：同上，迁移后会写入自定义配置的 timeoutMs。
   */
  localModelTimeoutMs?: number;
  /**
   * 一次性迁移标记（v0.64）。
   * true = 已把旧的本地模型偏好迁移成自定义图片配置，不再重复创建。
   */
  localModelMigrated?: boolean;
}

const DEFAULT_PREFS: Prefs = {
  dontSaveKeys: false,
  // 默认用 flash：生成分镜会反复重来，速度和成本比一次成型的质量更重要。
  // 需要更强的写作能力时，在设置页切回标准版。
  defaultLlmProfileId: DEFAULT_LLM_PROFILE_ID,
  defaultT2iProfileId: DEFAULT_T2I_PROFILE_ID,
  defaultReferenceProfileId: DEFAULT_REFERENCE_PROFILE_ID,
  proxyBaseUrl: '',
  proxyPassword: '',
  localModelEndpoint: '',
  localModelTimeoutMs: undefined,
  localModelMigrated: false,
  defaultVideoProfileId: undefined,
};

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) return { ...fallback, ...(parsed as T) };
  } catch {
    // 损坏的配置直接丢弃，不能让设置页崩掉
  }
  return fallback;
}

/** 会话里的代理口令（「不保存到本机」时用） */
function readSessionProxyPassword(): string {
  if (typeof sessionStorage === 'undefined') return '';
  const parsed = safeParse<{ proxyPassword?: unknown }>(
    sessionStorage.getItem(SS_PROXY_PASSWORD),
    {},
  );
  return typeof parsed.proxyPassword === 'string' ? parsed.proxyPassword : '';
}

/**
 * 把已经落到磁盘上的代理口令抹掉。
 *
 * 触发场景：用户升级前在磁盘上留过口令，升级后已经勾了「不保存到本机」。
 * 只在读到的磁盘口令非空时调用一次，避免每次加载都重写 prefs。
 */
function stripSavedProxyPassword(prefs: Prefs): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_PREFS, JSON.stringify({ ...prefs, proxyPassword: '' }));
  } catch {
    // 写不进去（隐私模式等）不该让设置页崩；内存里的值仍然是会话内可用的
  }
}

/**
 * 写偏好。代理口令跟着「不保存到本机」走：
 *  - 勾选时：磁盘上的 prefs 里置空，真值放 sessionStorage（关掉浏览器就没了）
 *  - 不勾时：跟其它偏好一起写磁盘，并清掉会话里的旧副本
 *
 * 为什么不干脆把口令也塞进 localStorage：它和 API Key 一样是凭据。
 * 用户勾「不保存」的意思是「这台电脑上别留」，只清 Key 不清口令等于没做到。
 */
function persistPrefs(prefs: Prefs): void {
  if (typeof localStorage === 'undefined') return;
  if (prefs.dontSaveKeys) {
    localStorage.setItem(LS_PREFS, JSON.stringify({ ...prefs, proxyPassword: '' }));
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(
        SS_PROXY_PASSWORD,
        JSON.stringify({ proxyPassword: prefs.proxyPassword }),
      );
    }
    return;
  }
  localStorage.setItem(LS_PREFS, JSON.stringify(prefs));
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem(SS_PROXY_PASSWORD);
  }
}

/**
 * 读取偏好，并迁移旧的 `rememberKeys`。
 *
 * ===========================================================================
 * 为什么不能直接把 rememberKeys 丢掉
 * ===========================================================================
 * 旧语义：`rememberKeys: true` = 用户明确要求**把 Key 留在本机**。
 * 新默认已经是「保存」，所以这类用户不需要做任何事。
 *
 * 但**没勾过**的（字段缺失或 false）在新默认下会从「不保存」变成「保存」——
 * 那等于把用户当初那个「不长期留在磁盘上」的选择**静默撤销了**。
 * 安全设置不该被静默放宽，所以这里保守处理：**没明确要保存的，一律视为不要保存。**
 *
 * 对老用户来说结果就是：以前怎么用，升级后还是怎么用。
 * 新用户（没有旧字段）拿到新默认值。
 */
function readPrefs(): Prefs {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFS;
  const raw = localStorage.getItem(LS_PREFS);
  const prefs = safeParse(raw, DEFAULT_PREFS);

  // 只在旧字段真的出现过时才迁移，避免影响全新用户
  if (raw && raw.includes('"rememberKeys"')) {
    try {
      const parsed = JSON.parse(raw) as { rememberKeys?: unknown };
      if (!('dontSaveKeys' in parsed) || parsed.dontSaveKeys === undefined) {
        // 旧字段存在 → 意味着这是升级上来的数据
        prefs.dontSaveKeys = parsed.rememberKeys !== true;
      }
    } catch {
      // 解析失败时保持 safeParse 的结果，不额外处理
    }
  }

  /*
    代理口令也遵守「不保存到本机」（v0.54）。
    顺序很重要：先把磁盘上的旧口令抹掉，再从会话存储取当前会话该用的值。
    否则「升级后勾了不保存、磁盘里还留着旧口令」这种情况会被静默漏过去。
  */
  if (prefs.dontSaveKeys) {
    if (prefs.proxyPassword.length > 0) stripSavedProxyPassword(prefs);
    prefs.proxyPassword = readSessionProxyPassword();
  }
  return prefs;
}

function readOverrides(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  return safeParse<Record<string, string>>(localStorage.getItem(LS_MODEL_OVERRIDES), {});
}

/**
 * 读取 Key，并把旧的「按模型档案存」迁移成「按厂商存」。
 *
 * ===========================================================================
 * 为什么必须迁移，而不是直接换 key
 * ===========================================================================
 * v0.27 之前 Key 存在 `profileId` 下（`qwen-image`、`zhipu-glm`…），
 * 之后改成存在 `vendorId` 下（`dashscope`、`zhipu`…）。
 * 如果不管旧数据，用户升级后会发现**自己填的 Key 全没了**——
 * 那不是「简化了界面」，那是把他的东西删了。
 *
 * 迁移规则：一个厂商下只要有任意一个旧档案有 Key，就把第一个非空的拿过来。
 * 同一个厂商下的多个模型本来就该用同一个 Key，所以取哪一个都一样。
 */
function migrateKeys(raw: Record<string, string>): {
  keys: Record<string, string>;
  migrated: number;
} {
  const vendorIds = new Set(MODEL_PROFILES.map((p) => p.vendorId).filter(Boolean) as string[]);

  const keys: Record<string, string> = {};
  let migrated = 0;

  // 1) 原样保留厂商级的键
  for (const [key, value] of Object.entries(raw)) {
    if (vendorIds.has(key)) keys[key] = value;
  }

  // 2) 把档案级的键搬到厂商级（新格式里已有的不覆盖）
  for (const profile of MODEL_PROFILES) {
    const vendorId = profile.vendorId;
    if (!vendorId) continue;
    const legacy = raw[profile.id];
    if (!legacy?.trim()) continue;
    if (keys[vendorId]?.trim()) continue;
    keys[vendorId] = legacy;
    migrated += 1;
  }

  return { keys, migrated };
}

function readKeys(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  const stored = safeParse<Record<string, string>>(localStorage.getItem(LS_KEYS), {});
  const session =
    typeof sessionStorage === 'undefined'
      ? {}
      : safeParse<Record<string, string>>(sessionStorage.getItem(SS_KEYS), {});
  const merged = { ...session, ...stored };
  const { keys } = migrateKeys(merged);
  return keys;
}

/** 把档案级的旧 Key 写回存储，迁移一次就够（幂等，重复调用无害） */
function persistMigratedKeys(): void {
  if (typeof localStorage === 'undefined') return;
  const raw = safeParse<Record<string, string>>(localStorage.getItem(LS_KEYS), {});
  const { keys, migrated } = migrateKeys(raw);
  if (migrated > 0) localStorage.setItem(LS_KEYS, JSON.stringify(keys));
}

export interface CustomModelMutationResult {
  ok: boolean;
  config?: CustomModelConfig;
  errors?: CustomModelValidation['errors'];
  message?: string;
}

function newCustomId(): string {
  const cryptoObj = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 自动迁移生成的配置使用稳定 id，保证写盘失败/重试时不会重复创建 */
export const MIGRATED_LOCAL_FLUX3_CONFIG_ID = 'migrated-local-flux3';

export interface LocalModelMigrationPlan {
  prefs: Prefs;
  configs: CustomModelConfig[];
  changed: boolean;
  /** 需要新建并写盘（false = 已有迁移配置，只切默认/写标记） */
  needsConfigWrite: boolean;
}

export interface LocalModelMigrationResult extends LocalModelMigrationPlan {
  configWriteFailed: boolean;
  prefsWriteFailed: boolean;
}

function safePersistPrefs(prefs: Prefs): boolean {
  try {
    persistPrefs(prefs);
    return true;
  } catch {
    // 隐私模式/配额等写盘失败不应该让应用启动失败；内存值仍然可用
    return false;
  }
}

/**
 * 计算本地模型 → 自定义接入的迁移计划（纯函数，便于测试）。
 *
 * 触发条件（且没有迁移标记）：
 *  - prefs.localModelEndpoint 非空；或
 *  - defaultT2iProfileId/defaultReferenceProfileId 指向内置 local-flux3。
 *
 * 迁移后内置 local-flux3 仍保留（hidden），旧默认仍可被 findProfile 解析。
 */
export function planLocalModelMigration(
  prefs: Prefs,
  configs: CustomModelConfig[],
): LocalModelMigrationPlan {
  const unchanged: LocalModelMigrationPlan = {
    prefs,
    configs,
    changed: false,
    needsConfigWrite: false,
  };
  if (prefs.localModelMigrated === true) return unchanged;

  const rawEndpoint =
    typeof prefs.localModelEndpoint === 'string' ? prefs.localModelEndpoint.trim() : '';
  const defaultsLocal =
    prefs.defaultT2iProfileId === LOCAL_FLUX3_PROFILE_ID ||
    prefs.defaultReferenceProfileId === LOCAL_FLUX3_PROFILE_ID;
  if (rawEndpoint.length === 0 && !defaultsLocal) return unchanged;

  // 旧本地档案生成时会 normalizeLocalEndpoint + chatCompletionsUrl（裸主机自动补 /v1）；
  // 迁移必须得到同一最终 URL，否则 /v1/models 会变成 /v1/models/chat/completions。
  const normalized = rawEndpoint.length > 0 ? normalizeLocalEndpoint(rawEndpoint) : undefined;
  if (rawEndpoint.length > 0 && normalized === undefined) return unchanged;
  const endpoint =
    rawEndpoint.length > 0 && normalized !== undefined
      ? normalized.endsWith('/v1')
        ? normalized
        : `${normalized}/v1`
      : DEFAULT_LOCAL_MODEL_ENDPOINT;

  const profileId = customProfileId('image', MIGRATED_LOCAL_FLUX3_CONFIG_ID);
  let nextConfigs = configs;
  let needsConfigWrite = false;
  const existing = configs.find((config) => config.id === MIGRATED_LOCAL_FLUX3_CONFIG_ID);
  if (!existing) {
    // 每模态上限 10：已满且没有迁移配置时不创建，保持旧本地默认可用（最安全）
    if (countCustomModels(configs, 'image') >= MAX_CUSTOM_MODELS_PER_MODALITY) {
      return unchanged;
    }
    const timeoutCandidate = prefs.localModelTimeoutMs;
    const timeoutMs =
      typeof timeoutCandidate === 'number' &&
      Number.isInteger(timeoutCandidate) &&
      timeoutCandidate >= 1000 &&
      timeoutCandidate <= 600_000
        ? timeoutCandidate
        : DEFAULT_LOCAL_TIMEOUT_MS;
    const draft: CustomModelDraft = {
      name: '本地 FLUX3（自动迁移）',
      modality: 'image',
      protocol: 'vllm-omni-chat-image',
      baseUrl: endpoint,
      model: 'flux-3-image-klein',
      requiresKey: false,
      timeoutMs,
      capabilities: { maxReferenceImages: 10, maxOutputImages: 1 },
    };
    const validation = validateCustomModel(draft);
    if (!validation.ok || !validation.normalized) {
      // 端点等字段不合法：安全降级，保持旧本地档案，不写半截配置
      return unchanged;
    }
    const config: CustomModelConfig = {
      ...validation.normalized,
      requiresKey: false,
      capabilities: validation.normalized.capabilities ?? { maxReferenceImages: 10, maxOutputImages: 1 },
      id: MIGRATED_LOCAL_FLUX3_CONFIG_ID,
      createdAt: new Date().toISOString(),
    };
    nextConfigs = [...configs, config];
    needsConfigWrite = true;
  }

  return {
    prefs: {
      ...prefs,
      defaultT2iProfileId: profileId,
      defaultReferenceProfileId: profileId,
      localModelMigrated: true,
    },
    configs: nextConfigs,
    changed: true,
    needsConfigWrite,
  };
}

/**
 * 执行迁移；写盘失败时保留旧 prefs/配置（应用照旧可用）。
 * 单测可注入 writer 模拟 localStorage 失败。
 */
export function applyLocalModelMigration(
  prefs: Prefs,
  configs: CustomModelConfig[],
  options: {
    writeConfigs?: (configs: CustomModelConfig[]) => boolean;
    writePrefs?: (prefs: Prefs) => boolean;
  } = {},
): LocalModelMigrationResult {
  const plan = planLocalModelMigration(prefs, configs);
  if (!plan.changed) {
    return { ...plan, configWriteFailed: false, prefsWriteFailed: false };
  }
  const writeConfigs = options.writeConfigs ?? writeCustomModelConfigs;
  const writePrefs = options.writePrefs ?? safePersistPrefs;
  if (plan.needsConfigWrite && !writeConfigs(plan.configs)) {
    return {
      prefs,
      configs,
      changed: false,
      needsConfigWrite: false,
      configWriteFailed: true,
      prefsWriteFailed: false,
    };
  }
  const prefsWriteFailed = !writePrefs(plan.prefs);
  return { ...plan, configWriteFailed: false, prefsWriteFailed };
}

/** 默认档案指向已删除/不存在的自定义配置时，回退到内置默认 */
function fallbackMissingCustomDefaults(
  prefs: Prefs,
  configs: CustomModelConfig[],
): { prefs: Prefs; changed: boolean } {
  const ids = new Set(configs.map((config) => customProfileId(config.modality, config.id)));
  let changed = false;
  const next: Prefs = { ...prefs };
  if (isCustomProfileId(prefs.defaultLlmProfileId) && !ids.has(prefs.defaultLlmProfileId)) {
    next.defaultLlmProfileId = DEFAULT_LLM_PROFILE_ID;
    changed = true;
  }
  if (isCustomProfileId(prefs.defaultT2iProfileId) && !ids.has(prefs.defaultT2iProfileId)) {
    next.defaultT2iProfileId = DEFAULT_T2I_PROFILE_ID;
    changed = true;
  }
  if (
    isCustomProfileId(prefs.defaultReferenceProfileId) &&
    !ids.has(prefs.defaultReferenceProfileId)
  ) {
    next.defaultReferenceProfileId = DEFAULT_REFERENCE_PROFILE_ID;
    changed = true;
  }
  return { prefs: next, changed };
}

interface SettingsState {
  prefs: Prefs;
  /** **vendorId** -> apiKey。一个厂商一个 Key（对话与出图共用）。 */
  keys: Record<string, string>;
  /**
   * profileId -> 用户覆盖的模型名。
   *
   * 为什么需要这个：厂商会下架旧模型、上架新模型。
   * 如果模型名写死在代码里，用户就会在某个时刻突然全部生成失败，
   * 而且只能等作者发新版本。给他一个输入框，他自己就能改。
   * 留空表示用档案里的默认值。
   */
  modelOverrides: Record<string, string>;

  /**
   * 自定义接入配置列表（v0.63 第三批）。
   * 只存配置，不存 Key；Key 复用 keys 存储（vendorId = custom:<configId>）。
   */
  customModels: CustomModelConfig[];
  addCustomModel: (draft: CustomModelDraft) => CustomModelMutationResult;
  updateCustomModel: (id: string, draft: CustomModelDraft) => CustomModelMutationResult;
  removeCustomModel: (id: string) => CustomModelMutationResult;
  setCustomModelKey: (id: string, apiKey: string) => CustomModelMutationResult;
  getCustomModelKey: (id: string) => string;

  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  setModelOverride: (profileId: string, model: string) => void;
  setKey: (vendorId: string, apiKey: string) => boolean;
  clearKey: (vendorId: string) => void;
  getKey: (vendorId: string) => string;
  /** 清除全部 Key（磁盘 + 内存） */
  forgetKeys: () => void;
}

// 迁移只在模块初始化时做一次。放在这里而不是组件里，
// 是为了保证任何读取 Key 的地方看到的都已经是新格式。
persistMigratedKeys();

const rawPrefs = readPrefs();
const migration = applyLocalModelMigration(rawPrefs, readCustomModelConfigs());
const initialFallback = fallbackMissingCustomDefaults(migration.prefs, migration.configs);
if (initialFallback.changed) safePersistPrefs(initialFallback.prefs);

export const useSettings = create<SettingsState>((set, get) => ({
  prefs: initialFallback.prefs,
  keys: readKeys(),
  modelOverrides: readOverrides(),
  customModels: migration.configs,

  addCustomModel: (draft) => {
    const validation = validateCustomModel(draft);
    if (!validation.ok || !validation.normalized) {
      return { ok: false, errors: validation.errors };
    }
    const current = get().customModels;
    if (countCustomModels(current, validation.normalized.modality) >= MAX_CUSTOM_MODELS_PER_MODALITY) {
      return {
        ok: false,
        errors: { modality: `每个模态最多 ${MAX_CUSTOM_MODELS_PER_MODALITY} 条自定义配置。` },
      };
    }
    const config: CustomModelConfig = {
      ...validation.normalized,
      requiresKey: validation.normalized.requiresKey !== false,
      capabilities: validation.normalized.capabilities ?? {},
      id: newCustomId(),
      createdAt: new Date().toISOString(),
    };
    const next = [...current, config];
    if (!writeCustomModelConfigs(next)) {
      return {
        ok: false,
        message: '配置没能保存到本机（localStorage 不可用或已满）。请清理存储后重试。',
      };
    }
    set({ customModels: next });
    return { ok: true, config };
  },

  updateCustomModel: (id, draft) => {
    const current = get().customModels;
    const existing = current.find((config) => config.id === id);
    if (!existing) return { ok: false, message: '这条自定义配置不存在，可能刚被删除。' };
    const validation = validateCustomModel(draft);
    if (!validation.ok || !validation.normalized) {
      return { ok: false, errors: validation.errors };
    }
    if (
      validation.normalized.modality !== existing.modality &&
      countCustomModels(current, validation.normalized.modality) >= MAX_CUSTOM_MODELS_PER_MODALITY
    ) {
      return {
        ok: false,
        errors: { modality: `每个模态最多 ${MAX_CUSTOM_MODELS_PER_MODALITY} 条自定义配置。` },
      };
    }
    const updated: CustomModelConfig = {
      ...validation.normalized,
      requiresKey: validation.normalized.requiresKey !== false,
      capabilities: validation.normalized.capabilities ?? {},
      id: existing.id,
      createdAt: existing.createdAt,
    };
    const next = current.map((config) => (config.id === id ? updated : config));
    if (!writeCustomModelConfigs(next)) {
      return {
        ok: false,
        message: '修改没能保存到本机（localStorage 不可用或已满）。请清理存储后重试。',
      };
    }
    set({ customModels: next });

    // 改 modality 会让档案 id 从 custom:旧模态:<id> 变成 custom:新模态:<id>；
    // 如果默认档案还指着旧 id，它已经解析不到，必须回退到内置默认。
    const oldProfileId = customProfileId(existing.modality, id);
    const newProfileId = customProfileId(updated.modality, id);
    if (oldProfileId !== newProfileId) {
      const prefs = get().prefs;
      if (prefs.defaultLlmProfileId === oldProfileId) {
        get().setPref('defaultLlmProfileId', DEFAULT_LLM_PROFILE_ID);
      }
      if (prefs.defaultT2iProfileId === oldProfileId) {
        get().setPref('defaultT2iProfileId', DEFAULT_T2I_PROFILE_ID);
      }
      if (prefs.defaultReferenceProfileId === oldProfileId) {
        get().setPref('defaultReferenceProfileId', DEFAULT_REFERENCE_PROFILE_ID);
      }
    }
    return { ok: true, config: updated };
  },

  removeCustomModel: (id) => {
    const current = get().customModels;
    const target = current.find((config) => config.id === id);
    if (!target) return { ok: false, message: '这条自定义配置不存在，可能刚被删除。' };
    const next = current.filter((config) => config.id !== id);
    if (!writeCustomModelConfigs(next)) {
      return {
        ok: false,
        message: '删除没能保存到本机（localStorage 不可用或已满）。请清理存储后重试。',
      };
    }
    set({ customModels: next });
    get().clearKey(customVendorId(id));

    const profileId = customProfileId(target.modality, id);
    const prefs = get().prefs;
    if (target.modality === 'text' && prefs.defaultLlmProfileId === profileId) {
      get().setPref('defaultLlmProfileId', DEFAULT_LLM_PROFILE_ID);
    }
    if (target.modality === 'image') {
      if (prefs.defaultT2iProfileId === profileId) get().setPref('defaultT2iProfileId', DEFAULT_T2I_PROFILE_ID);
      if (prefs.defaultReferenceProfileId === profileId) {
        get().setPref('defaultReferenceProfileId', DEFAULT_REFERENCE_PROFILE_ID);
      }
    }
    return { ok: true };
  },

  setCustomModelKey: (id, apiKey) => {
    const ok = get().setKey(customVendorId(id), apiKey);
    return ok
      ? { ok: true }
      : {
          ok: false,
          message: 'Key 没能保存到本机（localStorage 不可用或已满）。请清理存储后重试。',
        };
  },
  getCustomModelKey: (id) => get().getKey(customVendorId(id)),

  setPref: (key, value) => {
    const prefs = { ...get().prefs, [key]: value };
    set({ prefs });
    // 代理口令跟着「不保存到本机」走，见 persistPrefs 的注释
    persistPrefs(prefs);
    /**
     * 「不保存到本机」勾上时，**立刻把已经落盘的 Key 清掉**。
     *
     * 不能只记一个偏好、留到下次写入时才生效 —— 用户勾这个框的意思就是
     * 「现在就把本机上的抹掉」，如果磁盘上还留着，他没得到他要的结果。
     *
     * 默认方向（不勾）不需要做任何事：`setKey` 本来就会落盘。
     */
    if (key === 'dontSaveKeys' && value === true) {
      get().forgetKeys();
    }
  },

  setModelOverride: (profileId, model) => {
    const modelOverrides = { ...get().modelOverrides, [profileId]: model };
    set({ modelOverrides });
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_MODEL_OVERRIDES, JSON.stringify(modelOverrides));
    }
  },

  setKey: (profileId, apiKey) => {
    const keys = { ...get().keys, [profileId]: apiKey };
    const ok = writeKeys(keys, !get().prefs.dontSaveKeys);
    if (!ok) return false;
    set({ keys });
    return true;
  },

  clearKey: (profileId) => {
    const keys = { ...get().keys };
    delete keys[profileId];
    set({ keys });
    writeKeys(keys, !get().prefs.dontSaveKeys);
  },

  getKey: (profileId) => get().keys[profileId] ?? '',

  forgetKeys: () => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LS_KEYS);
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SS_KEYS);
    /*
      内存里的那份也要清。
      原来只删存储：磁盘上没了，但当前会话的 state 还留着 Key，
      设置页输入框继续显示、生成也还能用——用户会以为「不保存到本机」没生效
      （下一次 setKey 还会把整份 keys 写回会话存储）。清掉才和这个开关的语义一致。
    */
    set({ keys: {} });
  },
}));

function writeKeys(keys: Record<string, string>, remember: boolean): boolean {
  let ok = true;
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem(SS_KEYS, JSON.stringify(keys));
    } catch {
      ok = false;
    }
  }
  if (typeof localStorage === 'undefined') return ok;
  try {
    if (remember) localStorage.setItem(LS_KEYS, JSON.stringify(keys));
    else localStorage.removeItem(LS_KEYS);
  } catch {
    ok = false;
  }
  return ok;
}

/**
 * 测试本地模型连接（v0.61，UI 下一批直接调用）。
 *
 * 默认用设置里的 localModelEndpoint（空则用档案默认端点）；
 * 也可传 endpoint 做「先测再保存」。不抛异常，返回可展示的一句话。
 */
export async function checkLocalModel(
  options: LocalModelCheckOptions & { endpoint?: string } = {},
): Promise<LocalModelCheckResult> {
  const prefs = useSettings.getState().prefs;
  const endpoint = options.endpoint ?? prefs.localModelEndpoint?.trim() ?? '';
  const timeoutMs = options.timeoutMs ?? prefs.localModelTimeoutMs;
  return probeLocalModel(endpoint || undefined, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs: Math.min(timeoutMs, 10_000) } : {}),
    ...(options.expectedModel ? { expectedModel: options.expectedModel } : {}),
  });
}

/** 组装给 gateway 用的 transport 配置；没填代理地址就返回 undefined（走直连） */
export function currentTransport(): { proxyBaseUrl?: string; applicationPassword?: string } | undefined {
  const { proxyBaseUrl, proxyPassword } = useSettings.getState().prefs;
  if (!proxyBaseUrl.trim()) return undefined;
  return { proxyBaseUrl: proxyBaseUrl.trim(), applicationPassword: proxyPassword };
}
