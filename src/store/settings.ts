import { create } from 'zustand';
import { DEFAULT_REFERENCE_PROFILE_ID, DEFAULT_T2I_PROFILE_ID, MODEL_PROFILES } from '../data/models/profiles';

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
  /** 代理地址（留空 = 直连） */
  proxyBaseUrl: string;
  /** 代理通行口令 */
  proxyPassword: string;
}

const DEFAULT_PREFS: Prefs = {
  dontSaveKeys: false,
  // 默认用 flash：生成分镜会反复重来，速度和成本比一次成型的质量更重要。
  // 需要更强的写作能力时，在设置页切回标准版。
  defaultLlmProfileId: 'deepseek-flash',
  defaultT2iProfileId: DEFAULT_T2I_PROFILE_ID,
  defaultReferenceProfileId: DEFAULT_REFERENCE_PROFILE_ID,
  proxyBaseUrl: '',
  proxyPassword: '',
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

  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  setModelOverride: (profileId: string, model: string) => void;
  setKey: (vendorId: string, apiKey: string) => void;
  clearKey: (vendorId: string) => void;
  getKey: (vendorId: string) => string;
  /** 把当前会话里的 Key 落盘（Key 有变化时由 store 内部调用） */
  persistKeys: () => void;
  /** 从磁盘清除全部 Key */
  forgetKeys: () => void;
}

// 迁移只在模块初始化时做一次。放在这里而不是组件里，
// 是为了保证任何读取 Key 的地方看到的都已经是新格式。
persistMigratedKeys();

export const useSettings = create<SettingsState>((set, get) => ({
  prefs: readPrefs(),
  keys: readKeys(),
  modelOverrides: readOverrides(),

  setPref: (key, value) => {
    const prefs = { ...get().prefs, [key]: value };
    set({ prefs });
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_PREFS, JSON.stringify(prefs));
    }
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
    set({ keys });
    writeKeys(keys, !get().prefs.dontSaveKeys);
  },

  clearKey: (profileId) => {
    const keys = { ...get().keys };
    delete keys[profileId];
    set({ keys });
    writeKeys(keys, !get().prefs.dontSaveKeys);
  },

  getKey: (profileId) => get().keys[profileId] ?? '',

  persistKeys: () => {
    writeKeys(get().keys, true);
  },

  forgetKeys: () => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LS_KEYS);
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SS_KEYS);
  },
}));

function writeKeys(keys: Record<string, string>, remember: boolean): void {
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem(SS_KEYS, JSON.stringify(keys));
  }
  if (typeof localStorage === 'undefined') return;
  if (remember) {
    localStorage.setItem(LS_KEYS, JSON.stringify(keys));
  } else {
    localStorage.removeItem(LS_KEYS);
  }
}

/** 组装给 gateway 用的 transport 配置；没填代理地址就返回 undefined（走直连） */
export function currentTransport(): { proxyBaseUrl?: string; applicationPassword?: string } | undefined {
  const { proxyBaseUrl, proxyPassword } = useSettings.getState().prefs;
  if (!proxyBaseUrl.trim()) return undefined;
  return { proxyBaseUrl: proxyBaseUrl.trim(), applicationPassword: proxyPassword };
}
