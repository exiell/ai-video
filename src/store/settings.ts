import { create } from 'zustand';
import { DEFAULT_REFERENCE_PROFILE_ID, DEFAULT_T2I_PROFILE_ID, MODEL_PROFILES } from '../data/models/profiles';

/**
 * 设置状态（方案.md v0.6 §3.2 M0 + §0.1 第 4 条 BYOK）
 *
 * 存储策略是刻意分开的：
 *  - **API Key**：默认只存 sessionStorage（关掉浏览器就失效）。
 *    只有用户显式勾选「记住到本机」才写 localStorage。
 *    理由：Key 是用户自己花钱买的东西，默认不该长期躺在磁盘上。
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
  /** 用户是否勾选了「记住到本机」 */
  rememberKeys: boolean;
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
  rememberKeys: false,
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

function readPrefs(): Prefs {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFS;
  return safeParse(localStorage.getItem(LS_PREFS), DEFAULT_PREFS);
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
  /** 把当前会话里的 Key 落盘（用户勾选「记住到本机」时调用） */
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
     * 「记住到本机」的两个方向都要处理。
     *
     * 【v0.28 修】原来只处理了 `value === false`（取消勾选时清盘），
     * 而**勾选时该做的事从来没做过**——`persistKeys()` 在全项目里没有调用点。
     *
     * 后果很隐蔽：用户按正常顺序「填 Key → 测试连接 → 勾选记住到本机」时，
     * Key 只写进了 sessionStorage，localStorage 里一个字节都没有。
     * 关掉浏览器 Key 全没，而 `aniguide:prefs` 已经写入了 `rememberKeys: true`，
     * 下次打开**复选框还是勾选状态、输入框却是空的**——界面在骗人。
     *
     * 测试没抓到是因为它的顺序是先 setPref 再 setKey，
     * 而真实用户几乎总是反过来。这类「顺序相关」的漏洞只能靠审查发现。
     */
    if (key === 'rememberKeys') {
      if (value === true) get().persistKeys();
      else get().forgetKeys();
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
    writeKeys(keys, get().prefs.rememberKeys);
  },

  clearKey: (profileId) => {
    const keys = { ...get().keys };
    delete keys[profileId];
    set({ keys });
    writeKeys(keys, get().prefs.rememberKeys);
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
