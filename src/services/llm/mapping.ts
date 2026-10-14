import type { CharacterCard, Project, SceneCard, Shot, Story } from '../../types/model';
import { CAMERA_MOVE_LABEL, SCHEMA_VERSION, SHOT_SIZE_LABEL } from '../../types/model';
import { newId } from '../storage';
import type { GeneratedAssets, GeneratedShots, GeneratedStory } from './schemas';

/**
 * 生成结果 → 领域对象的映射（方案.md v0.6 §3.2 M2）
 *
 * 模型只负责「内容」，id、镜号、时间戳这些机械的事由这里补齐。
 * 让模型生成 id 是常见的错误做法：它会重复、会漏、会编出不存在的引用。
 */

function base() {
  const ts = new Date().toISOString();
  return { schemaVersion: SCHEMA_VERSION, createdAt: ts, updatedAt: ts };
}

// ---------------------------------------------------------------------------
// 故事
// ---------------------------------------------------------------------------

export function storyFromGenerated(generated: GeneratedStory, previous?: Story | null): Story {
  const storyBase = previous
    ? { schemaVersion: previous.schemaVersion, createdAt: previous.createdAt, updatedAt: new Date().toISOString() }
    : base();

  return {
    ...storyBase,
    id: previous?.id ?? newId('story'),
    source: 'generated',
    ...(previous?.theme !== undefined ? { theme: previous.theme } : {}),
    body: generated.body,
    charactersNote: generated.charactersNote,
    setting: generated.setting,
    conflict: generated.conflict,
    ending: generated.ending,
    scenes: generated.scenes.map((s) => ({
      id: newId('ss'),
      label: s.label,
      summary: s.summary,
    })),
  };
}

// ---------------------------------------------------------------------------
// 角色与场景
// ---------------------------------------------------------------------------

export interface AssetMapping {
  characters: CharacterCard[];
  scenes: SceneCard[];
  /** slug → 真实 id */
  characterIdBySlug: Map<string, string>;
  sceneIdBySlug: Map<string, string>;
  /** 锁的 label → 真实 id */
  lockIdByLabel: Map<string, string>;
  /**
   * 锁面（phrase）→ 真实 id。
   *
   * 为什么必须有这个回退：模型经常把锁面当成「要照抄的值」回给我们，
   * 而不是我们要求的 label。实测就是这样——
   * 提示词里写 `旧棉袍("a worn padded cotton robe")`，
   * 模型回抄的是那个英文短语。与其和模型的取向对着干（那注定会反复失手），
   * 不如两种都认。
   */
  lockIdByPhrase: Map<string, string>;
  /** 变体的 label → 真实 id */
  variantIdByLabel: Map<string, string>;
}

export function assetsFromGenerated(generated: GeneratedAssets): AssetMapping {
  const characterIdBySlug = new Map<string, string>();
  const sceneIdBySlug = new Map<string, string>();
  const lockIdByLabel = new Map<string, string>();
  const lockIdByPhrase = new Map<string, string>();
  const variantIdByLabel = new Map<string, string>();

  const characters: CharacterCard[] = generated.characters.map((c) => {
    const id = newId('ch');
    characterIdBySlug.set(c.slug, id);
    const continuityLocks = c.continuityLocks.map((lock) => {
      const lockId = newId('lock');
      lockIdByLabel.set(lock.label, lockId);
      lockIdByPhrase.set(lock.phrase, lockId);
      return { id: lockId, label: lock.label, phrase: lock.phrase, appliesTo: lock.appliesTo };
    });
    return {
      ...base(),
      id,
      name: c.name,
      role: c.role,
      identity: c.identity,
      variants: c.variants.map((v) => {
        const variantId = newId('var');
        variantIdByLabel.set(v.label, variantId);
        return {
          id: variantId,
          label: v.label,
          changedFeatures: v.changedFeatures,
          shotIds: [],
        };
      }),
      continuityLocks,
      shotIds: [],
      ...(c.negativePrompt ? { negativePrompt: c.negativePrompt } : {}),
    };
  });

  const scenes: SceneCard[] = generated.scenes.map((s) => {
    const id = newId('sc');
    sceneIdBySlug.set(s.slug, id);
    const continuityLocks = s.continuityLocks.map((lock) => {
      const lockId = newId('lock');
      lockIdByLabel.set(lock.label, lockId);
      lockIdByPhrase.set(lock.phrase, lockId);
      return { id: lockId, label: lock.label, phrase: lock.phrase, appliesTo: lock.appliesTo };
    });
    return {
      ...base(),
      id,
      name: s.name,
      identity: s.identity,
      variants: [],
      continuityLocks,
      fixedElements: s.fixedElements,
      lightDirection: s.lightDirection,
      mainColor: s.mainColor,
      ...(s.timeOfDay ? { timeOfDay: s.timeOfDay } : {}),
      ...(s.weather ? { weather: s.weather } : {}),
      shotIds: [],
    };
  });

  return {
    characters,
    scenes,
    characterIdBySlug,
    sceneIdBySlug,
    lockIdByLabel,
    lockIdByPhrase,
    variantIdByLabel,
  };
}

// ---------------------------------------------------------------------------
// 分镜
// ---------------------------------------------------------------------------

export interface ShotMappingResult {
  shots: Shot[];
  /** 引用了不存在的场景 / 角色的镜头编号，用于如实告知用户 */
  warnings: string[];
}

export function shotsFromGenerated(
  generated: GeneratedShots,
  mapping: AssetMapping,
  storyScenes: { id: string }[],
): ShotMappingResult {
  const warnings: string[] = [];
  const unresolvedByShot: string[] = [];

  const shots: Shot[] = generated.shots.map((g, index) => {
    const sceneId = mapping.sceneIdBySlug.get(g.sceneSlug);
    if (!sceneId) warnings.push(`第 ${index + 1} 镜引用了不存在的场景「${g.sceneSlug}」`);

    const characterIds: string[] = [];
    for (const characterSlug of g.characterSlugs) {
      const id = mapping.characterIdBySlug.get(characterSlug);
      if (id) characterIds.push(id);
      else warnings.push(`第 ${index + 1} 镜引用了不存在的角色「${characterSlug}」`);
    }

    const activeLockIds: string[] = [];
    const unresolved: string[] = [];
    for (const reference of g.activeLockLabels) {
      const resolved = resolveLockReference(mapping, reference);
      if (resolved) {
        if (!activeLockIds.includes(resolved)) activeLockIds.push(resolved);
      } else {
        unresolved.push(reference);
      }
    }

    const variantIds: string[] = [];
    for (const label of g.activeVariantLabels) {
      const id = mapping.variantIdByLabel.get(label);
      if (id) variantIds.push(id);
      else warnings.push(`第 ${index + 1} 镜引用了不存在的变体「${label}」`);
    }

    // 未解析的锁引用汇总成一条提示（原来每镜每锁各报一条，28 条刷屏且没有信息量）
    if (unresolved.length > 0) {
      unresolvedByShot.push(`第 ${index + 1} 镜：${unresolved.join('、')}`);
    }

    return {
      id: newId('shot'),
      number: index + 1,
      duration: g.duration,
      shotSize: g.shotSize,
      cameraPosition: g.cameraPosition,
      cameraMove: g.cameraMove,
      startState: g.startState,
      action: g.action,
      endState: g.endState,
      dialogue: g.dialogue,
      sound: g.sound,
      mood: g.mood,
      transition: g.transition,
      ...(g.continuityNote ? { continuityNote: g.continuityNote } : {}),
      ...(g.transitionType ? { transitionType: g.transitionType } : {}),
      sceneId: sceneId ?? '',
      characterIds,
      variantIds,
      activeLockIds,
      offscreenCharacters: g.offscreenCharacters,
      sourceSceneId: storyScenes[g.sourceSceneIndex]?.id ?? '',
    };
  });

  // -------------------------------------------------------------------------
  // 自动补齐漏勾的锁
  // -------------------------------------------------------------------------
  // 为什么必须做这一步（而不是靠提示词让模型每次都勾对）：
  // 锁的作用是「必须跨镜保持一致」。只要有一镜漏勾，那一镜的提示词里就没有锁面，
  // 角色就会在那里变样——而这恰恰是最难排查的问题。
  //
  // 判定是机械的、不靠模型：这一镜出现了谁、在哪个场景，就该带上谁的锁。
  // 模型给对了就尊重模型的选择；漏了才补，并在界面上如实说明补了什么。
  let autoAddedCount = 0;
  for (const shot of shots) {
    const expected = new Set<string>(shot.activeLockIds);

    for (const characterId of shot.characterIds) {
      const character = mapping.characters.find((c) => c.id === characterId);
      for (const lock of character?.continuityLocks ?? []) expected.add(lock.id);
    }
    const scene = mapping.scenes.find((s) => s.id === shot.sceneId);
    for (const lock of scene?.continuityLocks ?? []) expected.add(lock.id);

    const originalCount = shot.activeLockIds.length;
    // 保持原有顺序，再补上新发现的，便于用户对照
    const merged = [...shot.activeLockIds, ...[...expected].filter((id) => !shot.activeLockIds.includes(id))];
    if (merged.length !== originalCount) {
      shot.activeLockIds = merged;
      autoAddedCount += merged.length - originalCount;
    }
  }
  if (autoAddedCount > 0) {
    warnings.push(
      `模型漏勾了 ${autoAddedCount} 处连续性锁，已按「这一镜有谁、在哪个场景」自动补上。` +
        '补上比漏掉安全——漏勾的那一镜角色会变样。如果你想去掉某一条，在分镜表里取消勾选即可。',
    );
  }

  // 回填变体的生效镜头。不做这一步，检查引擎会一直报「变体没有分配给任何镜头」。
  for (const character of mapping.characters) {
    for (const variant of character.variants) {
      variant.shotIds = shots.filter((s) => s.variantIds.includes(variant.id)).map((s) => s.id);
    }
  }
  for (const scene of mapping.scenes) {
    for (const variant of scene.variants) {
      variant.shotIds = shots.filter((s) => s.variantIds.includes(variant.id)).map((s) => s.id);
    }
  }

  if (unresolvedByShot.length > 0) {
    warnings.push(
      `模型写的 ${unresolvedByShot.length} 处锁引用对不上（可能是抄错了名字）。` +
        '这些镜头的锁已由系统按「有谁、在哪个场景」自动补齐，不影响使用：' +
        unresolvedByShot.slice(0, 3).join('；') +
        (unresolvedByShot.length > 3 ? ` …还有 ${unresolvedByShot.length - 3} 镜` : ''),
    );
  }

  return { shots, warnings };
}

/**
 * 把模型给出的锁引用解析成真实的锁 id。
 *
 * 依次尝试：精确 label → 精确 phrase → 归一化后的 label/phrase。
 * 最后那一步是为了容忍大小写、中英文标点、多余空格的差异——
 * 模型抄写时这点偏差很常见，不值得因此报一条错。
 */
export function resolveLockReference(
  mapping: Pick<AssetMapping, 'lockIdByLabel' | 'lockIdByPhrase'>,
  reference: string,
): string | undefined {
  const raw = reference.trim();
  if (raw.length === 0) return undefined;

  const direct = mapping.lockIdByLabel.get(raw) ?? mapping.lockIdByPhrase.get(raw);
  if (direct) return direct;

  // 归一化的目的只有一个：模型抄写时的大小写、空格、标点差异不该导致匹配失败。
  // 做法是「统一 → 去掉标点 → 压缩空格」，而不是把标点换成另一种标点——
  // 后者会把「白色短毛，」变成「白色短毛,」，与「白色短毛」仍然不等。
  const normalize = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[\u3000\s]+/g, ' ')
      .replace(/[，。、；：！？·…—～「」『』（）【】《》〈〉“”‘’"'.,;:!?()\[\]<>]/g, '')
      .replace(/\s+/g, '')
      .trim();

  const target = normalize(raw);
  for (const map of [mapping.lockIdByLabel, mapping.lockIdByPhrase]) {
    for (const [key, id] of map) {
      if (normalize(key) === target) return id;
    }
  }
  return undefined;
}

/** 一次生成完，把三部分拼进项目 */
export function applyGeneration(
  project: Project,
  parts: { story?: Story; assets?: AssetMapping; shots?: Shot[] },
): Project {
  const next: Project = { ...project, updatedAt: new Date().toISOString() };
  if (parts.story) next.story = parts.story;
  if (parts.assets) {
    next.characters = parts.assets.characters;
    next.scenes = parts.assets.scenes;
  }
  if (parts.shots) next.shots = parts.shots;
  return next;
}

/** 给界面用：把枚举值翻成中文，便于在错误提示里说明 */
export function describeShotSize(value: string): string {
  return SHOT_SIZE_LABEL[value as keyof typeof SHOT_SIZE_LABEL] ?? value;
}

export function describeCameraMove(value: string): string {
  return CAMERA_MOVE_LABEL[value as keyof typeof CAMERA_MOVE_LABEL] ?? value;
}
