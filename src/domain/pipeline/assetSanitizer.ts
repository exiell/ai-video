import type { CharacterCard, Shot, VideoMode, VisualAsset } from '../../types/model';
import {
  isCharacterStageEnabled,
  resolvePipelineProfile,
  resolveVideoMode,
  type ProjectModeContext,
} from './profiles';
import { newId } from '../../services/storage';

/**
 * 确定性后置防呆守卫（Phase 3 · 第四层防呆）
 *
 * 在 LLM 结构化输出入库前执行纯代码校验与自愈：
 * 1. 强策略拦截：当 characterPolicy === 'disabled' 或未开启虚拟讲解员时，
 *    强制清空任何意外返回的角色，同步清理分镜中的 characterIds 并记录告警。
 * 2. 数量上限约束：explainer 开启虚拟讲解员时最多保留 1 个有效讲解员角色。
 * 3. 非生命体/自然要素启发式纠偏：拦截被误标为 character 的自然要素或抽象名词
 *    （水滴、光线、岩石、光子、粒子、公式等），除非剧本存在显式拟人化对白，
 *    否则自动降级迁移至 visualAssets（environment / visual_motif）并同步更新分镜标签引用。
 */

const INANIMATE_ZH_TERMS: readonly string[] = [
  '水滴', '露珠', '水珠', '光线', '阳光', '晨光', '月光', '光束', '光芒',
  '岩石', '石头', '礁石', '青苔', '山峰', '山谷', '山脉', '松针', '树叶',
  '云雾', '薄雾', '云朵', '雾气', '河流', '溪流', '瀑布', '湖面', '海浪',
  '微风', '狂风', '雪花', '雨滴', '火焰', '尘埃', '星云', '星系',
  '分子', '原子', '粒子', '光子', '电子', '质子', '中子', '量子', '黑洞',
  '引力波', '电磁波', '数据', '数据流', '公式', '方程', '图表', '柱状图', '镜头',
];

const INANIMATE_EXACT_ZH = new Set<string>(['风', '雪', '雨', '光', '水', '云', '雾', '火', '树', '石']);

const INANIMATE_EN_RE =
  /\b(water\s*drop|dewdrop|droplet|sunlight|light\s*ray|beam\s+of\s+light|rock|stone|moss|mountain|valley|pine\s*needle|cloud|mist|fog|river|stream|wind|snow|rain|fire|flame|dust|nebula|molecule|atom|particle|photon|electron|quantum|black\s*hole|data\s*stream|formula|equation|chart|graph|camera\s*lens)\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 判断剧本中是否对该名称存在显式拟人化对白 */
export function hasExplicitPersonifiedDialogue(name: string, storyText: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || !storyText.trim()) return false;
  const escaped = escapeRegExp(trimmed);
  const patterns = [
    new RegExp(`${escaped}\\s*(?:开口|笑着|轻声|大声|低声|说道|说|喊道|喊|问道|问|答道|答|叹道|笑道|嘟囔)\\s*[：:「“"]`),
    new RegExp(`${escaped}\\s*[：:]\\s*[「“"]`),
    new RegExp(`[」”"]\\s*${escaped}\\s*(?:说|道|喊|问|笑|叹)`),
    new RegExp(`把\\s*${escaped}\\s*拟人化`),
  ];
  return patterns.some((re) => re.test(storyText));
}

/** 检测角色名或其描述是否属于自然要素/无生命抽象概念 */
export function isInanimateNaturalOrAbstract(
  character: Pick<CharacterCard, 'name' | 'identity'>,
): boolean {
  const name = character.name.trim();
  if (!name) return false;
  if (INANIMATE_EXACT_ZH.has(name)) return true;
  if (INANIMATE_ZH_TERMS.some((term) => name.includes(term))) return true;
  if (INANIMATE_EN_RE.test(name)) return true;

  const species = (character.identity.species ?? '').trim();
  if (
    character.identity.form === 'object' &&
    (INANIMATE_EXACT_ZH.has(species) ||
      INANIMATE_ZH_TERMS.some((term) => species.includes(term)) ||
      INANIMATE_EN_RE.test(`${species} ${character.identity.summaryEn ?? ''}`))
  ) {
    return true;
  }

  return false;
}

function toAssetTag(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `@${ascii || 'visual_motif'}`;
}

export interface SanitizeAssetsInput {
  project: ProjectModeContext;
  characters: CharacterCard[];
  visualAssets?: VisualAsset[];
  shots?: Shot[];
  storyText?: string;
}

export interface SanitizeAssetsResult {
  characters: CharacterCard[];
  visualAssets: VisualAsset[];
  shots: Shot[];
  demotedAssets: VisualAsset[];
  warnings: string[];
}

/**
 * 资产入库前确定性守卫：强制执行角色策略与非生命体降级迁移。
 */
export function sanitizeProjectAssets(input: SanitizeAssetsInput): SanitizeAssetsResult {
  const mode: VideoMode = resolveVideoMode(input.project);
  const profile = resolvePipelineProfile(input.project);
  const charEnabled = isCharacterStageEnabled(input.project);
  const storyText = input.storyText ?? '';

  const warnings: string[] = [];
  const demotedAssets: VisualAsset[] = [];
  const existingVisualAssets: VisualAsset[] = [...(input.visualAssets ?? [])];
  const existingTags = new Set(existingVisualAssets.map((a) => a.tag));
  let shots: Shot[] = (input.shots ?? []).map((s) => ({
    ...s,
    characterIds: [...s.characterIds],
    referencedAssetTags: [...(s.referencedAssetTags ?? [])],
  }));

  const demoteToVisualAsset = (char: CharacterCard, reason: string): VisualAsset => {
    const category = mode === 'scenic' ? 'environment' : 'visual_motif';
    let tag = toAssetTag(char.name);
    if (existingTags.has(tag)) {
      tag = `${tag}_${existingVisualAssets.length + 1}`;
    }
    existingTags.add(tag);

    const visualAsset: VisualAsset = {
      id: newId('va'),
      category,
      name: char.name,
      tag,
      visualPrompt: char.identity.summaryEn || char.identity.summary || char.name,
      referenceImageUrls: [],
      isImmutableAnchor: true,
    };
    existingVisualAssets.push(visualAsset);
    demotedAssets.push(visualAsset);

    // 同步迁移分镜中的角色引用为视觉资产标签引用
    shots = shots.map((shot) => {
      if (!shot.characterIds.includes(char.id)) return shot;
      const nextTags = shot.referencedAssetTags ?? [];
      return {
        ...shot,
        characterIds: shot.characterIds.filter((id) => id !== char.id),
        referencedAssetTags: nextTags.includes(tag) ? nextTags : [...nextTags, tag],
      };
    });

    warnings.push(reason);
    return visualAsset;
  };

  // 规则 1：当前模式禁止角色时，强制清空所有角色
  if (!charEnabled) {
    if (input.characters.length > 0) {
      for (const char of input.characters) {
        if (isInanimateNaturalOrAbstract(char)) {
          demoteToVisualAsset(
            char,
            `当前为「${mode}」无角色模式，已将误标为角色的「${char.name}」自动降级为${mode === 'scenic' ? '环境锚点' : '视觉母题'}。`,
          );
        }
      }
      warnings.push(
        `当前模式（${mode}）已禁用角色提取，已强制清空 ${input.characters.length} 条意外角色记录。`,
      );
    }
    shots = shots.map((shot) => ({
      ...shot,
      characterIds: [],
      offscreenCharacters: [],
    }));
    return {
      characters: [],
      visualAssets: existingVisualAssets,
      shots,
      demotedAssets,
      warnings,
    };
  }

  // 规则 2：允许角色时，过滤被误标为角色的自然要素/无生命抽象概念
  const keptCharacters: CharacterCard[] = [];
  for (const char of input.characters) {
    if (
      isInanimateNaturalOrAbstract(char) &&
      !hasExplicitPersonifiedDialogue(char.name, storyText)
    ) {
      demoteToVisualAsset(
        char,
        `检测到非生命体/自然要素「${char.name}」被误标为角色，已自动降级为视觉母题并更新分镜引用。`,
      );
      continue;
    }
    keptCharacters.push(char);
  }

  // 规则 3：explainer 开启虚拟讲解员时，最多保留 1 个讲解员主体
  let finalCharacters = keptCharacters;
  if (profile.characterPolicy === 'optional_host' && keptCharacters.length > 1) {
    const [primary, ...extras] = keptCharacters;
    finalCharacters = primary ? [primary] : [];
    const removedIds = new Set(extras.map((c) => c.id));
    shots = shots.map((shot) => ({
      ...shot,
      characterIds: shot.characterIds.filter((id) => !removedIds.has(id)),
    }));
    warnings.push(
      `科普模式的虚拟讲解员最多允许 1 个主体，已保留「${primary?.name ?? ''}」并移除其余 ${extras.length} 条多余角色。`,
    );
  }

  return {
    characters: finalCharacters,
    visualAssets: existingVisualAssets,
    shots,
    demotedAssets,
    warnings,
  };
}
