/**
 * 角色形态工具（v0.66）
 *
 * 背景：鱼被生成出人类四肢。根因是提示词层默认所有角色都是人类，
 * 形态/物种从未进入提示词。这里集中判定，供形象图、帧提示词、参考图说明复用。
 * **人类分支必须保持旧输出逐字不变**。
 */
import type { CharacterForm } from '../../types/model';

export interface CharacterFormInfo {
  form?: CharacterForm;
  species?: string;
}

export function characterFormOf(identity: CharacterFormInfo | undefined): CharacterForm {
  const form = identity?.form;
  return form === 'animal' || form === 'creature' || form === 'object' ? form : 'human';
}

export function isHumanForm(identity: CharacterFormInfo | undefined): boolean {
  return characterFormOf(identity) === 'human';
}

/** 非人类负向词：不能只靠 negative，但它是必要护栏。 */
export function nonHumanNegative(identity: CharacterFormInfo | undefined): string {
  const form = characterFormOf(identity);
  if (form === 'human' || form === 'creature') return '';
  return 'human arms, human legs, humanoid hands, humanoid torso, anthropomorphic limbs';
}

/** 提示词里的主体名词；人类仍用 character。 */
export function subjectNoun(identity: CharacterFormInfo | undefined): string {
  const form = characterFormOf(identity);
  const species = identity?.species?.trim();
  if (form === 'human') return 'character';
  if (form === 'animal') return species || 'animal';
  if (form === 'object') return species || 'object';
  return species || 'non-human creature';
}

/** 帧提示词里的角色描述：人类逐字保持旧兜底，非人类绝不回退 an anime character。 */
export function characterSubjectDescription(character: {
  name: string;
  identity: CharacterFormInfo & { summaryEn?: string };
}): string {
  const identity = character.identity;
  const form = characterFormOf(identity);
  const summaryEn = identity.summaryEn?.trim() ?? '';
  if (form === 'human') {
    return summaryEn || `${character.name}, an anime character`;
  }
  const species = identity.species?.trim() ?? '';
  const parts = [character.name];
  if (species) parts.push(species);
  if (summaryEn) parts.push(summaryEn);
  if (parts.length > 1) return parts.join(', ');
  return `${character.name}, a non-human ${form}`;
}
