import { create } from 'zustand';
import type {
  CharacterCard,
  CheckReport,
  Project,
  SceneCard,
  Shot,
  Story,
} from '../types/model';
import { runChecks } from '../domain/checks';
import { SCHEMA_VERSION } from '../types/model';
import { newId, saveProject } from '../services/storage';

/**
 * 应用状态（方案.md v0.6 §5.2：Zustand）
 *
 * 设计取舍：不把 CheckReport 存进 state。
 * 它是 project 的纯函数派生值，存起来就要处理「改了分镜忘了重跑检查」的同步问题。
 * 这里用每次 project 变化就重算的方式，代价是几十毫秒，换来的是永远不会不一致。
 */

interface AppState {
  project: Project | null;
  report: CheckReport | null;
  /** 是否有未保存的改动 */
  dirty: boolean;
  /**
   * 改动计数器：每次修改项目内容都 +1。
   *
   * 【v0.28 新增】存在的唯一理由是**修一个自动保存的竞态**。
   * 原来只能靠 `dirty` 布尔值判断「要不要保存」，而它在保存进行中会被
   * 上一次保存的完成回调置回 false，于是：
   *
   *   编辑 → 计时器到点，persist() 开始 await
   *   → 用户又敲一下（effect 重跑，挂上新计时器）
   *   → 上一次 persist 完成，set({ dirty: false })
   *   → dirty 变化让 effect 重跑，React **先执行 cleanup 把新计时器清掉**
   *   → 再因 !dirty 直接 return → **这次新改动永远不会落盘**
   *
   * 而界面显示的是「已保存到本机」。若丢的正好是最后一次编辑，关掉标签页就没了。
   *
   * 用计数器就没这个问题：保存前后比对，变了就说明期间又改过，
   * 于是**不清 dirty**，effect 会再挂一次计时器把它存下去。
   */
  revision: number;
  /**
   * 保存失败的原因。非空表示磁盘上可能是旧的。
   *
   * 原来 `void persist()` 把异常吞了：IndexedDB 写失败（配额用尽、
   * 隐私模式禁用存储）时是 unhandled rejection，界面永远停在「保存中…」，
   * 没有提示、没有重试、也没告诉用户「你该去导出一份备份」——
   * 而数据其实没落盘。这是会真丢数据的那种静默失败。
   */
  saveError: string | null;

  setProject: (project: Project | null) => void;
  patchProject: (patch: Partial<Project>) => void;
  patchBrief: (patch: Partial<Project['brief']>) => void;
  patchStory: (patch: Partial<Story>) => void;

  upsertShot: (shot: Shot) => void;
  removeShot: (shotId: string) => void;
  moveShot: (shotId: string, direction: -1 | 1) => void;
  renumberShots: () => void;

  upsertCharacter: (character: CharacterCard) => void;
  removeCharacter: (id: string) => void;
  upsertScene: (scene: SceneCard) => void;
  removeScene: (id: string) => void;

  /** 重新运行穿帮检查 */
  refreshChecks: () => void;
  /** 写入本地存储 */
  persist: () => Promise<void>;
  clearSaveError: () => void;

  createEmptyProject: (name?: string) => Project;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 创建一个空项目 */
export function makeEmptyProject(name = '未命名项目'): Project {
  const ts = nowIso();
  const base = { schemaVersion: SCHEMA_VERSION, createdAt: ts, updatedAt: ts };
  return {
    ...base,
    id: newId('proj'),
    name,
    logline: '',
    brief: {
      targetDuration: 30,
      aspectRatio: '9:16',
      platforms: ['jimeng'],
      styleTone: '',
      styleTags: ['anime style'],
      negativePrompt: 'text, watermark, logo, extra fingers, distorted face',
    },
    story: {
      ...base,
      id: newId('story'),
      source: 'original',
      body: '',
      charactersNote: '',
      setting: '',
      conflict: '',
      ending: '',
      scenes: [],
    },
    shots: [],
    characters: [],
    scenes: [],
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  project: null,
  report: null,
  dirty: false,
  revision: 0,
  saveError: null,

  setProject: (project) => {
    set({
      project,
      report: project ? runChecks(project) : null,
      dirty: false,
    });
  },

  patchProject: (patch) => {
    const current = get().project;
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    set((state) => ({
      project: next,
      report: runChecks(next),
      dirty: true,
      revision: state.revision + 1,
    }));
  },

  patchBrief: (patch) => {
    const current = get().project;
    if (!current) return;
    const next = { ...current, brief: { ...current.brief, ...patch }, updatedAt: nowIso() };
    set((state) => ({
      project: next,
      report: runChecks(next),
      dirty: true,
      revision: state.revision + 1,
    }));
  },

  patchStory: (patch) => {
    const current = get().project;
    if (!current) return;
    const next = { ...current, story: { ...current.story, ...patch }, updatedAt: nowIso() };
    set((state) => ({
      project: next,
      report: runChecks(next),
      dirty: true,
      revision: state.revision + 1,
    }));
  },

  upsertShot: (shot) => {
    const current = get().project;
    if (!current) return;
    const exists = current.shots.some((s) => s.id === shot.id);
    const shots = exists
      ? current.shots.map((s) => (s.id === shot.id ? shot : s))
      : [...current.shots, shot];
    const next = { ...current, shots, updatedAt: nowIso() };
    set((state) => ({
      project: next,
      report: runChecks(next),
      dirty: true,
      revision: state.revision + 1,
    }));
  },

  removeShot: (shotId) => {
    const current = get().project;
    if (!current) return;
    const shots = current.shots
      .filter((s) => s.id !== shotId)
      .map((s, index) => ({ ...s, number: index + 1 }));
    const next = { ...current, shots, updatedAt: nowIso() };
    set((state) => ({
      project: next,
      report: runChecks(next),
      dirty: true,
      revision: state.revision + 1,
    }));
  },

  moveShot: (shotId, direction) => {
    const current = get().project;
    if (!current) return;
    const shots = [...current.shots];
    const index = shots.findIndex((s) => s.id === shotId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= shots.length) return;
    const a = shots[index]!;
    const b = shots[target]!;
    shots[index] = b;
    shots[target] = a;
    const renumbered = shots.map((s, i) => ({ ...s, number: i + 1 }));
    const next = { ...current, shots: renumbered, updatedAt: nowIso() };
    set((state) => ({
      project: next,
      report: runChecks(next),
      dirty: true,
      revision: state.revision + 1,
    }));
  },

  renumberShots: () => {
    const current = get().project;
    if (!current) return;
    const shots = current.shots.map((s, i) => ({ ...s, number: i + 1 }));
    const next = { ...current, shots, updatedAt: nowIso() };
    set((state) => ({
      project: next,
      report: runChecks(next),
      dirty: true,
      revision: state.revision + 1,
    }));
  },

  upsertCharacter: (character) => {
    const current = get().project;
    if (!current) return;
    const exists = current.characters.some((c) => c.id === character.id);
    const characters = exists
      ? current.characters.map((c) => (c.id === character.id ? character : c))
      : [...current.characters, character];
    const next = { ...current, characters, updatedAt: nowIso() };
    set((state) => ({
      project: next,
      report: runChecks(next),
      dirty: true,
      revision: state.revision + 1,
    }));
  },

  removeCharacter: (id) => {
    const current = get().project;
    if (!current) return;
    const characters = current.characters.filter((c) => c.id !== id);
    // 同时清掉镜头里对它的引用，避免留下断链
    const shots = current.shots.map((s) => ({
      ...s,
      characterIds: s.characterIds.filter((cid) => cid !== id),
    }));
    const next = { ...current, characters, shots, updatedAt: nowIso() };
    set((state) => ({
      project: next,
      report: runChecks(next),
      dirty: true,
      revision: state.revision + 1,
    }));
  },

  upsertScene: (scene) => {
    const current = get().project;
    if (!current) return;
    const exists = current.scenes.some((s) => s.id === scene.id);
    const scenes = exists
      ? current.scenes.map((s) => (s.id === scene.id ? scene : s))
      : [...current.scenes, scene];
    const next = { ...current, scenes, updatedAt: nowIso() };
    set((state) => ({
      project: next,
      report: runChecks(next),
      dirty: true,
      revision: state.revision + 1,
    }));
  },

  removeScene: (id) => {
    const current = get().project;
    if (!current) return;
    const scenes = current.scenes.filter((s) => s.id !== id);
    const shots = current.shots.map((s) => (s.sceneId === id ? { ...s, sceneId: '' } : s));
    const next = { ...current, scenes, shots, updatedAt: nowIso() };
    set((state) => ({
      project: next,
      report: runChecks(next),
      dirty: true,
      revision: state.revision + 1,
    }));
  },

  refreshChecks: () => {
    const current = get().project;
    if (!current) return;
    set({ report: runChecks(current) });
  },

  persist: async () => {
    const current = get().project;
    if (!current) return;

    // 保存前记下版本号快照
    const snapshot = get().revision;

    try {
      await saveProject(current);
    } catch (error) {
      set({
        saveError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    /**
     * 只有「保存期间没有新的改动」才把 dirty 清掉。
     *
     * 如果保存期间用户又敲了一下（revision 变了），就保持 dirty=true，
     * 让自动保存的 effect 再挂一次计时器——否则那次改动会永远不落盘，
     * 而界面还显示「已保存到本机」。
     */
    if (get().revision === snapshot) {
      set({ dirty: false, saveError: null });
    }
  },

  clearSaveError: () => set({ saveError: null }),

  createEmptyProject: (name) => {
    const project = makeEmptyProject(name);
    set((state) => ({
      project,
      report: runChecks(project),
      dirty: true,
      revision: state.revision + 1,
      saveError: null,
    }));
    return project;
  },
}));

/** 从示例项目深拷贝一份，避免用户编辑污染内置数据 */
export function cloneAsNewProject(source: Project, name: string): Project {
  const ts = nowIso();
  const copy = structuredClone(source);
  return {
    ...copy,
    id: newId('proj'),
    name,
    createdAt: ts,
    updatedAt: ts,
  };
}
