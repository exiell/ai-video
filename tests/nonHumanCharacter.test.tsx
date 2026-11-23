// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { sampleProject } from '../src/data/samples/sampleProject';
import {
  buildCharacterSheetPrompt,
  buildFramePrompt,
} from '../src/domain/image/prompts';
import { characterFormOf } from '../src/domain/image/characterForm';
import { withReferenceInstruction } from '../src/services/gateway/dashscope';
import { parseAssets } from '../src/services/llm/schemas';
import { assetsFromGenerated } from '../src/services/llm/mapping';
import { parseImportedProject } from '../src/services/storage';
import { isEditable, validateFieldValue } from '../src/domain/chat/edits';
import { useAppStore } from '../src/store/app';
import { CharactersPage } from '../src/pages/CharactersPage';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function fishProject() {
  const project = structuredClone(sampleProject);
  const character = project.characters.find((item) => item.id === 'ch-linchong')!;
  character.identity = {
    form: 'animal',
    species: '金鱼',
    face: '',
    hair: '',
    bodyType: 'small round fish body',
    ageRange: '',
    summary: '一条小金鱼',
    summaryEn: 'a small orange goldfish with flowing fins and a round body',
  };
  character.continuityLocks = [];
  character.negativePrompt = 'human arms';
  return project;
}

function objectProject() {
  const project = structuredClone(sampleProject);
  const character = project.characters.find((item) => item.id === 'ch-linchong')!;
  character.identity = {
    form: 'object',
    species: '机械狗',
    face: '',
    hair: '',
    bodyType: 'small wheeled metal body',
    ageRange: '',
    summary: '一只机械狗',
    summaryEn: 'a small mechanical dog with metal panels and a wheel base',
  };
  character.continuityLocks = [];
  return project;
}

function renderCharacters(project = sampleProject) {
  useAppStore.setState({ project: structuredClone(project) });
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter>
        <CharactersPage />
      </MemoryRouter>,
    );
  });
  return container;
}

function click(element: Element | null | undefined): void {
  if (!element) throw new Error('element not found');
  act(() => (element as HTMLElement).click());
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe('非人类角色形象图 prompt', () => {
  it('鱼：用物种主体与解剖措辞，不出现人类取景词，negative 含 human limbs', () => {
    const turn = buildCharacterSheetPrompt(fishProject(), 'ch-linchong', 'turnaround')!;
    expect(turn.positive).toContain('goldfish');
    expect(turn.positive).toMatch(/fins|tail|silhouette|anatomy/i);
    expect(turn.positive).not.toMatch(/anime character model sheet|head to feet|arms relaxed at the sides|collarbone|hairstyle|\bhair\b|\bhead\b/i);
    expect(turn.negative).toContain('human arms');
    expect(turn.negative).toContain('anthropomorphic limbs');
    expect(turn.subjectLabel).toContain('整体多视图');
    const face = buildCharacterSheetPrompt(fishProject(), 'ch-linchong', 'face')!;
    expect(face.subjectLabel).toContain('主体特写');
    expect(face.positive).not.toMatch(/anime character model sheet|hairstyle|\bhair\b|\bhead\b/i);
  });

  it('物体：同样走非人类模板，不出现人类解剖/四肢默认', () => {
    const prompt = buildCharacterSheetPrompt(objectProject(), 'ch-linchong', 'turnaround')!;
    expect(prompt.positive).toContain('mechanical dog');
    expect(prompt.positive).toMatch(/metal|wheel|mechanical|anthropomorphic/i);
    expect(prompt.positive).not.toMatch(/arms relaxed|collarbone|hairstyle|head to feet|\bhead\b/i);
    expect(prompt.negative).toContain('human arms');
  });

  it('人类分支（无 form / form=human）与旧输出逐字一致', () => {
    const withForm = structuredClone(sampleProject);
    withForm.characters[0]!.identity = { ...withForm.characters[0]!.identity, form: 'human', species: '' };
    const legacy = structuredClone(sampleProject);
    const a = buildCharacterSheetPrompt(withForm, 'ch-linchong', 'turnaround')!;
    const b = buildCharacterSheetPrompt(legacy, 'ch-linchong', 'turnaround')!;
    expect(a.positive).toBe(b.positive);
    expect(a.negative).toBe(b.negative);
    expect(a.subjectLabel).toBe(b.subjectLabel);
    expect(a.notes).toEqual(b.notes);
  });
});

describe('非人类角色帧 prompt', () => {
  it('鱼：不回退 an anime character，不写 both feet，含物种，主体占比标签', () => {
    const frame = buildFramePrompt(fishProject(), 'shot-01', 'first-frame')!;
    expect(frame.positive).toContain('goldfish');
    expect(frame.positive).not.toContain('an anime character');
    expect(frame.positive).not.toContain('both feet');
    expect(frame.positive).toContain('without assuming human feet');
    expect(frame.notes.some((note) => note.label === '主体占比')).toBe(true);
    expect(frame.notes.some((note) => note.label === '人物占比')).toBe(false);
    expect(frame.negative).toContain('human arms');
  });

  it('鱼 close-up 帧不含 head，仍保留主体特征/占比', () => {
    const project = fishProject();
    const shot = project.shots.find((item) => item.id === 'shot-01')!;
    shot.shotSize = 'close-up';
    const frame = buildFramePrompt(project, 'shot-01', 'first-frame')!;
    expect(frame.positive).not.toMatch(/\bhead\b/i);
    expect(frame.positive).toMatch(/main identifying features/i);
    expect(frame.notes.some((note) => note.label === '主体占比')).toBe(true);
  });

  it('人类帧 negative / 占比标签保持旧行为', () => {
    const frame = buildFramePrompt(structuredClone(sampleProject), 'shot-01', 'first-frame')!;
    expect(frame.notes.some((note) => note.label === '人物占比')).toBe(true);
    expect(frame.notes.some((note) => note.label === '主体占比')).toBe(false);
    expect(frame.positive).toContain('both feet');
    expect(frame.negative).not.toContain('humanoid limbs');
  });
});

describe('参考图说明 form-aware', () => {
  const baseInput = {
    referenceCount: 1,
    hasFirstFrameAnchor: true,
    sheetDetails: ['full-body'] as ('full-body' | 'face')[],
    roles: ['the character design sheet, defining face, hairstyle, body proportions and outfit'],
  };

  it('人类说明与旧调用逐字一致', () => {
    const old = withReferenceInstruction('BASE', baseInput);
    const human = withReferenceInstruction('BASE', { ...baseInput, characterForms: ['human' as const] });
    expect(human).toBe(old);
  });

  it('鱼说明不含 facial features/hairstyle/person，含物种与解剖护栏', () => {
    const fish = withReferenceInstruction('BASE', {
      ...baseInput,
      characterForms: ['animal'],
      characterSpecies: ['goldfish'],
    });
    expect(fish).not.toMatch(/facial features|hairstyle|body proportions|that person/i);
    expect(fish).toContain('goldfish');
    expect(fish).toMatch(/species|anatomy|silhouette/i);
    expect(fish).toContain('Do not add human arms');
  });
});

describe('LLM schema / storage 兼容', () => {
  it('schema 默认 human/空物种；显式动物保留', () => {
    const parsed = parseAssets(
      JSON.stringify({
        characters: [
          {
            slug: 'legacy',
            name: '老角色',
            role: 'supporting',
            identity: { face: '', hair: '', bodyType: '', ageRange: '', summary: '', summaryEn: 'a person' },
            continuityLocks: [],
            variants: [],
          },
        ],
        scenes: [],
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.data!.characters[0]!.identity.form).toBe('human');
    expect(parsed.data!.characters[0]!.identity.species).toBe('');

    const parsedFish = parseAssets(
      JSON.stringify({
        characters: [
          {
            slug: 'fish',
            name: '金鱼',
            role: 'supporting',
            identity: {
              form: 'animal',
              species: '金鱼',
              face: '',
              hair: '',
              bodyType: '',
              ageRange: '',
              summary: '',
              summaryEn: 'a small orange goldfish',
            },
            continuityLocks: [],
            variants: [],
          },
        ],
        scenes: [],
      }),
    );
    expect(parsedFish.data!.characters[0]!.identity).toMatchObject({ form: 'animal', species: '金鱼' });
  });

  it('mapping 透传，storage normalize 老数据默认 human', () => {
    const mapped = assetsFromGenerated({
      characters: [
        {
          slug: 'fish',
          name: '金鱼',
          role: 'supporting',
          identity: {
            form: 'animal',
            species: '金鱼',
            face: '',
            hair: '',
            bodyType: '',
            ageRange: '',
            summary: '',
            summaryEn: 'a small goldfish',
          },
          continuityLocks: [],
          variants: [],
        },
      ],
      scenes: [],
    });
    expect(mapped.characters[0]!.identity).toMatchObject({ form: 'animal', species: '金鱼' });

    const imported = parseImportedProject(JSON.stringify(structuredClone(sampleProject)));
    expect(imported.ok).toBe(true);
    expect(imported.project!.characters[0]!.identity.form).toBe('human');
    expect(imported.project!.characters[0]!.identity.species).toBe('');
  });
});

describe('对话可改字段', () => {
  it('identity.form / identity.species 可改，form 只接受四种形态', () => {
    expect(isEditable('character', 'identity.form')).toBe(true);
    expect(isEditable('character', 'identity.species')).toBe(true);
    expect(validateFieldValue('character', 'identity.form', 'animal')).toEqual({ value: 'animal' });
    expect(validateFieldValue('character', 'identity.form', 'human')).toEqual({ value: 'human' });
    expect(validateFieldValue('character', 'identity.form', 'fish').reason).toBeTruthy();
    expect(validateFieldValue('character', 'identity.species', '金鱼')).toEqual({ value: '金鱼' });
  });
});

describe('角色页 UI 持久化', () => {
  beforeEach(() => {
    useAppStore.setState({ project: structuredClone(sampleProject) });
  });

  it('选动物/填物种后持久化，形象图按钮文案切到主体/整体', () => {
    const el = renderCharacters(sampleProject);
    click(el.querySelector('button[aria-label="展开这个角色"]'));
    const formTrigger = el.querySelector<HTMLButtonElement>('button[aria-label*="的形态"]');
    expect(formTrigger).toBeTruthy();
    click(formTrigger);
    const listId = formTrigger!.getAttribute('aria-controls');
    const list = listId ? document.getElementById(listId) : null;
    const animalOption = [...(list?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])].find(
      (button) => (button.textContent ?? '').includes('动物'),
    );
    expect(animalOption).toBeTruthy();
    click(animalOption);

    const speciesInput = el.querySelector<HTMLInputElement>('input[aria-label="物种/形态"]');
    expect(speciesInput).toBeTruthy();
    setInput(speciesInput!, '金鱼');
    const identity = useAppStore.getState().project!.characters[0]!.identity;
    expect(identity.form).toBe('animal');
    expect(identity.species).toBe('金鱼');
    expect(characterFormOf(identity)).toBe('animal');

    const labels = [...el.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(labels.some((text) => text.includes('整体多视图'))).toBe(true);
    expect(labels.some((text) => text.includes('生成全身多视图'))).toBe(false);
  });
});
