import Dexie, { type Table } from 'dexie';
import type { Asset, Project } from '../../types/model';
import { SCHEMA_VERSION } from '../../types/model';

/**
 * 本地存储层（方案.md v0.6 §5.7）
 *
 * 为什么用 IndexedDB 而不是 localStorage：
 *  - 后期要存关键帧图片的 base64，localStorage 只有几 MB，放不下
 *  - Dexie 提供版本迁移能力，schemaVersion 变化时能平滑升级
 *
 * 数据不出浏览器。没有账号，没有云端。
 */

export interface ProjectRecord {
  id: string;
  name: string;
  updatedAt: string;
  /** 冗余存一份 logline，列表页不用读整份项目 */
  logline: string;
  /** 完整项目数据 */
  data: Project;
}

export class AniGuideDB extends Dexie {
  projects!: Table<ProjectRecord, string>;
  assets!: Table<Asset, string>;

  constructor() {
    super('aniguide');
    this.version(1).stores({
      projects: 'id, name, updatedAt',
      assets: 'id, projectId, kind, refId',
    });
    /**
     * v2：给素材加 `[projectId+refId]` 复合索引。
     *
     * ===========================================================================
     * 为什么必须加（这是一个真实的性能 bug）
     * ===========================================================================
     * `listAssetsFor` 原来是「读整个项目的素材，再在内存里 filter」。
     * 而素材里装的是**全部 base64 图片**——20 镜 + 几十张图就是几十 MB。
     *
     * 分镜表里每个输入框每敲一个字符都会触发一次刷新，
     * 而刷新会为**每一个镜头**调一次 `listAssetsFor`：
     *   一次按键 = N 次全表读 + 反序列化几十 MB + N 次 setState
     * 表现就是打字卡顿，而且越出图越卡。
     *
     * 单列索引 `refId` 不足以同时按 projectId 与 refId 定位，
     * 所以这里加复合索引，让它变成一次精确的区间查询。
     *
     * Dexie 会自动完成 v1 → v2 的升级（只加索引，不动数据）。
     */
    this.version(2).stores({
      projects: 'id, name, updatedAt',
      assets: 'id, projectId, kind, refId, [projectId+refId]',
    });
  }
}

let dbInstance: AniGuideDB | null = null;

/** 惰性创建，避免在非浏览器环境（测试）里报错 */
export function getDb(): AniGuideDB {
  if (!dbInstance) dbInstance = new AniGuideDB();
  return dbInstance;
}

/** 简单的 id 生成，避免引入额外依赖 */
export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36);
  return `${prefix}-${ts}${rand}`;
}

export async function saveProject(project: Project): Promise<void> {
  /**
   * 用项目自己的 `updatedAt`，不要在这里另生成一个。
   *
   * 【v0.28 修】原来这里两次调用 `new Date().toISOString()`，
   * 把项目里的 `updatedAt` 覆盖成了「保存时刻」。
   * 后果：`project.updatedAt` 不再反映「内容最后改动的时间」，
   * 而是「最后一次落盘的时间」——两者不是一回事，
   * 于是任何想靠 `updatedAt` 判断「有没有新改动」的逻辑都失效。
   *
   * 时间戳由 store 的各个改动动作负责更新（它们已经都改了），
   * 存储层只负责存，不负责改语义。
   */
  const stamp = project.updatedAt || new Date().toISOString();
  const record: ProjectRecord = {
    id: project.id,
    name: project.name,
    updatedAt: stamp,
    logline: project.logline,
    data: { ...project, updatedAt: stamp },
  };
  await getDb().projects.put(record);
}

export async function loadProject(id: string): Promise<Project | undefined> {
  const record = await getDb().projects.get(id);
  if (!record) return undefined;
  /**
   * 加载时归一化——**这是最后一道防线**。
   *
   * 存在 IndexedDB 里的数据不一定是我们写进去的那个样子：
   * 用户可能导入了手工改过的 JSON、可能是旧版本导出的、也可能被别的代码写坏过。
   * 而 IndexedDB 不做任何 schema 校验。
   *
   * 归一化的开销可以忽略（几个数组判空），但能挡住
   * 「story.scenes is not iterable → 整个检查页白屏」这类问题。
   * 缺的数据会在检查单里如实报出来，而不是让页面崩掉。
   */
  return normalizeProject(record.data);
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const all = await getDb().projects.toArray();
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteProject(id: string): Promise<void> {
  await getDb().projects.delete(id);
  await getDb().assets.where('projectId').equals(id).delete();
}

// ---------------------------------------------------------------------------
// 素材（图片）
// ---------------------------------------------------------------------------

/**
 * 保存素材。
 *
 * 注意：这里存的是 base64 dataUrl，不是平台返回的临时链接。
 * 阿里云的图链接 24 小时后失效，只存 URL 等于存了一张迟早会裂的图。
 * 这个约束由 services/image/generate.ts 的 toAssets 保证——
 * 它只把已经成功转成 dataUrl 的图交出来。
 */
export async function saveAssets(assets: Asset[]): Promise<void> {
  if (assets.length === 0) return;
  await getDb().assets.bulkPut(assets);
}

export async function listAssets(projectId: string): Promise<Asset[]> {
  const all = await getDb().assets.where('projectId').equals(projectId).toArray();
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * 取某个对象（角色 / 场景 / 镜头）名下的素材。
 *
 * 用 `[projectId+refId]` 复合索引做精确查询，**不再读整个项目再过滤**。
 * 差别很大：素材里装的是全部 base64 图片，全表读一次就是几十 MB。
 */
export async function listAssetsFor(projectId: string, refId: string): Promise<Asset[]> {
  const rows = await getDb().assets.where('[projectId+refId]').equals([projectId, refId]).toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteAsset(id: string): Promise<void> {
  await getDb().assets.delete(id);
}

/** 素材总字节数，用于设置页的用量提示 */
export async function assetsByteSize(projectId: string): Promise<number> {
  const assets = await listAssets(projectId);
  return assets.reduce((sum, asset) => sum + (asset.byteSize ?? 0), 0);
}

/** 估算已用容量（方案.md §5.7：设置页要显示用量） */
export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

/**
 * 把一份「可能不完整」的项目数据补成结构完整的。
 *
 * ===========================================================================
 * 为什么需要在加载时就做，而不只在导入时做
 * ===========================================================================
 * 这一层是**最后一道防线**，防的是三类真实情况：
 *  1. 用户导入一个手工改过的 JSON（缺字段）
 *  2. 旧版本导出的文件，字段比现在少
 *  3. 代码 bug 写进了一份不完整的数据（历史上真发生过）
 *
 * 实测过一个具体崩溃：`story` 存在但 `story.scenes` 不是数组时，
 * 检查引擎直接抛 `project.story.scenes is not iterable`——
 * **整个穿帮检查页白屏**，而用户看到的只是一个「story 字段在」的合法文件。
 *
 * 所以这里不做「校验后拒绝」（那会让用户打不开自己的项目），
 * 而是**补齐缺失的容器字段**：数组补成空数组、对象补成空对象。
 * 缺的东西会在检查单里如实报出来，而不是让页面崩掉。
 */
export function normalizeProject(input: unknown): Project {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

  const brief = obj(raw.brief);
  const story = obj(raw.story);
  const now = new Date().toISOString();

  return {
    ...(raw as unknown as Project),
    id: str(raw.id, 'untitled'),
    name: str(raw.name, '未命名项目'),
    logline: str(raw.logline),
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : SCHEMA_VERSION,
    createdAt: str(raw.createdAt, now),
    updatedAt: str(raw.updatedAt, now),
    brief: {
      ...(brief as unknown as Project['brief']),
      platforms: arr(brief.platforms).length > 0 ? (brief.platforms as Project['brief']['platforms']) : ['jimeng'],
      aspectRatio: str(brief.aspectRatio, '16:9'),
      targetDuration: typeof brief.targetDuration === 'number' ? brief.targetDuration : 30,
      styleTone: str(brief.styleTone),
      styleTags: arr<string>(brief.styleTags),
      negativePrompt: str(brief.negativePrompt),
    },
    story: {
      ...(story as unknown as Project['story']),
      body: str(story.body),
      charactersNote: str(story.charactersNote),
      setting: str(story.setting),
      conflict: str(story.conflict),
      ending: str(story.ending),
      scenes: arr(story.scenes),
    },
    characters: arr(raw.characters),
    scenes: arr(raw.scenes),
    shots: arr(raw.shots),
  };
}

/**
 * 导入项目 JSON（方案.md §5.5 约束）
 *
 * 只做最小必要的**结构白名单**校验：必须是对象、容器字段必须是数组。
 * 不做完整 Zod 校验的原因：这里的目标是「不能把任意 JSON 当项目直接渲染」，
 * 而不是「拒绝一切不完美的文件」——用户手工改过的项目也该能打开。
 * 所以策略是：**结构不对就明确拒绝，结构对但字段缺失就归一化补齐**。
 */
export interface ImportResult {
  ok: boolean;
  project?: Project;
  error?: string;
}

export function parseImportedProject(raw: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: '这个文件不是合法的 JSON，可能已经损坏。' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: '文件内容不是一个项目对象。' };
  }
  const obj = parsed as Record<string, unknown>;
  const required = ['id', 'name', 'brief', 'story', 'shots', 'characters', 'scenes'];
  const missing = required.filter((k) => !(k in obj));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `这个文件缺少必要字段：${missing.join('、')}。它可能不是 AniGuide 的项目文件，或者版本太旧。`,
    };
  }
  // 容器字段必须是数组——不是数组就说明文件结构不对，直接拒绝比事后崩好
  for (const key of ['shots', 'characters', 'scenes']) {
    if (!Array.isArray(obj[key])) {
      return { ok: false, error: `${key} 字段不是数组，文件结构不对。` };
    }
  }
  if (typeof obj.story !== 'object' || obj.story === null || Array.isArray(obj.story)) {
    return { ok: false, error: 'story 字段不是一个对象，文件结构不对。' };
  }
  // story.scenes 曾经漏检，导致检查页直接崩（project.story.scenes is not iterable）
  const storyScenes = (obj.story as Record<string, unknown>).scenes;
  if (storyScenes !== undefined && !Array.isArray(storyScenes)) {
    return { ok: false, error: 'story.scenes 字段不是数组，文件结构不对。' };
  }

  // 通过校验后仍然归一化一次：缺的可选字段补齐，不让下游各自防御
  return { ok: true, project: normalizeProject(obj) };
}
