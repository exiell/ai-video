import Dexie, { type Table } from 'dexie';
import type {
  Asset,
  CameraMove,
  CharacterCard,
  ContinuityLock,
  LockAspect,
  Project,
  SceneCard,
  Shot,
  ShotSize,
  StoryScene,
  Variant,
} from '../../types/model';
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
 *
 * ===========================================================================
 * 【v0.54 扩到「元素级」】
 * ===========================================================================
 * 只补容器是不够的。`characters: [null]` 这种文件容器是数组、JSON 合法，
 * 但检查引擎在第一处 `character.variants.map(...)` 就会抛异常；
 * 导入方如果没有 catch，用户看到的就是「点了没反应」。
 *
 * 所以这里对每个数组元素也做一次**最小结构修复**：
 *  - `null` 或根本不是对象 → 丢弃（保留它只会让下游每处都要防御）
 *  - 缺 `id` → 补一个本地生成的 id（对象还在，用户的内容不会丢）
 *  - 缺检查引擎与页面都会读的字段 → 补空字符串 / 空数组 / 合法枚举默认值
 *
 * 注意这只是「能跑」的下限，不是完整校验：导入入口会先做元素级校验并给出
 * 明确的错误消息（见 `parseImportedProject`），只有加载本机旧数据才走修复。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

const CHARACTER_ROLES = ['protagonist', 'antagonist', 'supporting', 'cameo'] as const;
const LOCK_ASPECTS: readonly LockAspect[] = ['look', 'geography', 'lighting', 'prop', 'composition'];
const SHOT_SIZES: readonly ShotSize[] = [
  'extreme-wide',
  'wide',
  'full',
  'medium',
  'close-up',
  'extreme-close-up',
];
const CAMERA_MOVES: readonly CameraMove[] = [
  'static',
  'push-in',
  'pull-out',
  'pan-left',
  'pan-right',
  'tilt-up',
  'tilt-down',
  'orbit',
  'tracking',
  'crane-up',
  'crane-down',
  'handheld',
];

function normalizeVariant(value: unknown): Variant | null {
  if (!isRecord(value)) return null;
  return {
    ...(value as unknown as Variant),
    id: text(value.id) || newId('variant'),
    label: text(value.label),
    changedFeatures: textArray(value.changedFeatures),
    shotIds: textArray(value.shotIds),
  };
}

function normalizeLock(value: unknown): ContinuityLock | null {
  if (!isRecord(value)) return null;
  return {
    ...(value as unknown as ContinuityLock),
    id: text(value.id) || newId('lock'),
    label: text(value.label),
    phrase: text(value.phrase),
    appliesTo: oneOf(value.appliesTo, LOCK_ASPECTS, 'look'),
  };
}

function normalizeCharacter(value: unknown, now: string): CharacterCard | null {
  if (!isRecord(value)) return null;
  const identity = isRecord(value.identity) ? value.identity : {};
  return {
    ...(value as unknown as CharacterCard),
    id: text(value.id) || newId('char'),
    name: text(value.name, '未命名角色'),
    role: oneOf(value.role, CHARACTER_ROLES, 'supporting'),
    identity: {
      ...(identity as unknown as CharacterCard['identity']),
      face: text(identity.face),
      hair: text(identity.hair),
      bodyType: text(identity.bodyType),
      ageRange: text(identity.ageRange),
      summary: text(identity.summary),
      summaryEn: text(identity.summaryEn),
    },
    variants: asRecordArray(value.variants)
      .map(normalizeVariant)
      .filter((item): item is Variant => item !== null),
    continuityLocks: asRecordArray(value.continuityLocks)
      .map(normalizeLock)
      .filter((item): item is ContinuityLock => item !== null),
    shotIds: textArray(value.shotIds),
    schemaVersion: finiteNumber(value.schemaVersion, SCHEMA_VERSION),
    createdAt: text(value.createdAt, now),
    updatedAt: text(value.updatedAt, now),
  };
}

function normalizeScene(value: unknown, now: string): SceneCard | null {
  if (!isRecord(value)) return null;
  const identity = isRecord(value.identity) ? value.identity : {};
  return {
    ...(value as unknown as SceneCard),
    id: text(value.id) || newId('scene'),
    name: text(value.name, '未命名场景'),
    identity: {
      ...(identity as unknown as SceneCard['identity']),
      placeType: text(identity.placeType),
      spatialStructure: text(identity.spatialStructure),
      summary: text(identity.summary),
      summaryEn: text(identity.summaryEn),
    },
    variants: asRecordArray(value.variants)
      .map(normalizeVariant)
      .filter((item): item is Variant => item !== null),
    continuityLocks: asRecordArray(value.continuityLocks)
      .map(normalizeLock)
      .filter((item): item is ContinuityLock => item !== null),
    fixedElements: textArray(value.fixedElements),
    lightDirection: text(value.lightDirection),
    mainColor: text(value.mainColor),
    shotIds: textArray(value.shotIds),
    schemaVersion: finiteNumber(value.schemaVersion, SCHEMA_VERSION),
    createdAt: text(value.createdAt, now),
    updatedAt: text(value.updatedAt, now),
  };
}

function normalizeShot(value: unknown, index: number): Shot | null {
  if (!isRecord(value)) return null;
  return {
    ...(value as unknown as Shot),
    id: text(value.id) || newId('shot'),
    // 镜号缺了就按数组位置补，保证列表排序与「第 N 镜」的说法不会变成 NaN/undefined
    number: finiteNumber(value.number, index + 1),
    duration: finiteNumber(value.duration, 3),
    shotSize: oneOf(value.shotSize, SHOT_SIZES, 'medium'),
    cameraPosition: text(value.cameraPosition),
    cameraMove: oneOf(value.cameraMove, CAMERA_MOVES, 'static'),
    startState: text(value.startState),
    action: text(value.action),
    endState: text(value.endState),
    dialogue: text(value.dialogue),
    sound: text(value.sound),
    mood: text(value.mood),
    transition: text(value.transition),
    sceneId: text(value.sceneId),
    characterIds: textArray(value.characterIds),
    variantIds: textArray(value.variantIds),
    activeLockIds: textArray(value.activeLockIds),
    offscreenCharacters: textArray(value.offscreenCharacters),
    sourceSceneId: text(value.sourceSceneId),
  };
}

function normalizeStoryScene(value: unknown): StoryScene | null {
  if (!isRecord(value)) return null;
  return {
    ...(value as unknown as StoryScene),
    id: text(value.id) || newId('story-scene'),
    label: text(value.label, '未命名场次'),
    summary: text(value.summary),
  };
}

export function normalizeProject(input: unknown): Project {
  const raw = isRecord(input) ? input : {};
  const brief = isRecord(raw.brief) ? raw.brief : {};
  const story = isRecord(raw.story) ? raw.story : {};
  const now = new Date().toISOString();
  const platforms = textArray(brief.platforms);

  return {
    ...(raw as unknown as Project),
    id: text(raw.id, 'untitled'),
    name: text(raw.name, '未命名项目'),
    logline: text(raw.logline),
    schemaVersion: finiteNumber(raw.schemaVersion, SCHEMA_VERSION),
    createdAt: text(raw.createdAt, now),
    updatedAt: text(raw.updatedAt, now),
    brief: {
      ...(brief as unknown as Project['brief']),
      platforms:
        platforms.length > 0 ? (platforms as Project['brief']['platforms']) : ['jimeng'],
      aspectRatio: text(brief.aspectRatio, '16:9'),
      targetDuration: finiteNumber(brief.targetDuration, 30),
      styleTone: text(brief.styleTone),
      styleTags: textArray(brief.styleTags),
      negativePrompt: text(brief.negativePrompt),
    },
    story: {
      ...(story as unknown as Project['story']),
      body: text(story.body),
      charactersNote: text(story.charactersNote),
      setting: text(story.setting),
      conflict: text(story.conflict),
      ending: text(story.ending),
      scenes: asRecordArray(story.scenes)
        .map(normalizeStoryScene)
        .filter((item): item is StoryScene => item !== null),
    },
    characters: asRecordArray(raw.characters)
      .map((item) => normalizeCharacter(item, now))
      .filter((item): item is CharacterCard => item !== null),
    scenes: asRecordArray(raw.scenes)
      .map((item) => normalizeScene(item, now))
      .filter((item): item is SceneCard => item !== null),
    shots: asRecordArray(raw.shots)
      .map((item, index) => normalizeShot(item, index))
      .filter((item): item is Shot => item !== null),
  };
}

/**
 * 导入项目 JSON（方案.md §5.5 约束）
 *
 * 只做最小必要的**结构白名单**校验：必须是对象、容器字段必须是数组。
 * 不做完整 Zod 校验的原因：这里的目标是「不能把任意 JSON 当项目直接渲染」，
 * 而不是「拒绝一切不完美的文件」——用户手工改过的项目也该能打开。
 * 所以策略是：**结构不对就明确拒绝，结构对但字段缺失就归一化补齐**。
 *
 * 【v0.54 补元素级校验】容器是数组还不够：`characters: [null]` 也过得了容器检查，
 * 然后检查引擎在 `character.variants.map` 处抛异常，导入方没有 catch 就变成
 * 「点了没反应」。所以这里在归一化之前先逐个检查必需的对象骨架，
 * 并且**指出是第几个对象的哪个字段**——用户拿到的是一句能照着改的话，
 * 而不是一条英文堆栈。
 */
export interface ImportResult {
  ok: boolean;
  project?: Project;
  error?: string;
}

/** 各容器元素至少得有什么。缺失时给用户的消息会带上「第几个 + 缺什么」。 */
const IMPORT_ELEMENT_RULES: { key: string; label: string; requiresName: boolean }[] = [
  { key: 'characters', label: '角色', requiresName: true },
  { key: 'scenes', label: '场景', requiresName: true },
  { key: 'shots', label: '镜头', requiresName: false },
];

function findElementProblem(
  list: unknown[],
  label: string,
  requiresName: boolean,
): string | null {
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (!isRecord(item)) {
      return `第 ${index + 1} 个${label}不是一个对象（这一项的格式坏了）。`;
    }
    if (text(item.id).trim().length === 0) {
      return `第 ${index + 1} 个${label}缺少 id。`;
    }
    if (requiresName && text(item.name).trim().length === 0) {
      return `第 ${index + 1} 个${label}缺少 name。`;
    }
  }
  return null;
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
  // 容器里的元素也要有最小骨架：null / 非对象 / 缺 id 都会让下游崩
  for (const rule of IMPORT_ELEMENT_RULES) {
    const problem = findElementProblem(obj[rule.key] as unknown[], rule.label, rule.requiresName);
    if (problem) return { ok: false, error: problem };
  }
  if (typeof obj.story !== 'object' || obj.story === null || Array.isArray(obj.story)) {
    return { ok: false, error: 'story 字段不是一个对象，文件结构不对。' };
  }
  // story.scenes 曾经漏检，导致检查页直接崩（project.story.scenes is not iterable）
  const storyScenes = (obj.story as Record<string, unknown>).scenes;
  if (storyScenes !== undefined && !Array.isArray(storyScenes)) {
    return { ok: false, error: 'story.scenes 字段不是数组，文件结构不对。' };
  }
  if (Array.isArray(storyScenes)) {
    for (let index = 0; index < storyScenes.length; index += 1) {
      if (!isRecord(storyScenes[index])) {
        return { ok: false, error: `story.scenes 里第 ${index + 1} 个场次不是一个对象。` };
      }
    }
  }

  // 通过校验后仍然归一化一次：缺的可选字段补齐，不让下游各自防御
  return { ok: true, project: normalizeProject(obj) };
}
