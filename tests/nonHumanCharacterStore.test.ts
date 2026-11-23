// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleProject } from '../src/data/samples/sampleProject';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { useImage } from '../src/store/image';
import { getDb, saveAssets } from '../src/services/storage';
import type { Asset } from '../src/types/model';

const PROJECT = structuredClone(sampleProject);
const SHOT_ID = 'shot-01';

function fishProject() {
  const project = structuredClone(sampleProject);
  const character = project.characters.find((item) => item.id === 'ch-linchong')!;
  character.identity = {
    form: 'animal',
    species: '金鱼',
    face: '',
    hair: '',
    bodyType: 'small round body',
    ageRange: '',
    summary: '一条金鱼',
    summaryEn: 'a small orange goldfish with flowing fins and a round body',
  };
  character.continuityLocks = [];
  character.negativePrompt = '';
  // 让镜头引用这条鱼
  for (const shot of project.shots) {
    shot.characterIds = shot.characterIds.length > 0 ? [character.id] : shot.characterIds;
  }
  return project;
}

function humanProject() {
  const project = structuredClone(sampleProject);
  for (const character of project.characters) {
    character.identity = { ...character.identity, form: 'human', species: '' };
    character.continuityLocks = [];
  }
  return project;
}

function fullBodyAsset(): Asset {
  return {
    id: 'fish-full-body',
    projectId: PROJECT.id,
    kind: 'character-sheet',
    refId: 'ch-linchong',
    dataUrl: 'data:image/png;base64,FULL',
    mimeType: 'image/png',
    promptSnapshot: 'full body',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
  };
}

let prompts: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch() {
  prompts = [];
  fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages?: { content?: { type: string; text?: string }[] }[];
    };
    prompts.push(body.messages?.[0]?.content?.find((item) => item.type === 'text')?.text ?? '');
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: [
                { type: 'image_url', image_url: { url: 'data:image/png;base64,OUT' } },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(async () => {
  await getDb().assets.clear();
  useAppStore.setState({ project: structuredClone(fishProject()) });
  useSettings.setState({
    customModels: [],
    keys: {},
    prefs: {
      ...useSettings.getState().prefs,
      defaultReferenceProfileId: 'local-flux3',
      defaultT2iProfileId: 'local-flux3',
      defaultImageEditProfileId: 'local-flux3',
    },
  });
  useImage.setState({
    pending: null,
    feedback: {},
    gallery: {},
    assetCount: 0,
    assetCounts: {},
    batch: null,
    batchSummary: null,
  });
  await saveAssets([fullBodyAsset()]);
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('store 参考图路径 form-aware', () => {
  it('generateForCharacter 非人类 + 全身图参考：最终 prompt 不含人脸/发型，含 species/anatomy', async () => {
    await useImage.getState().generateForCharacter('ch-linchong', true, 'face');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain('金鱼');
    expect(prompts[0]).toMatch(/species|anatomy|silhouette/i);
    expect(prompts[0]).not.toMatch(/facial features|hairstyle|body proportions/i);
    expect(useImage.getState().feedback['character-sheet-face:ch-linchong']?.kind).toBe('ok');
  });

  it('generateForCharacter 人类目标保持旧 human 参考说明', async () => {
    useAppStore.setState({ project: humanProject() });
    await saveAssets([{ ...fullBodyAsset(), refId: 'ch-linchong' }]);
    await useImage.getState().generateForCharacter('ch-linchong', true, 'face');
    expect(prompts[0]).toContain('facial features');
    expect(prompts[0]).toContain('hairstyle');
    expect(prompts[0]).not.toContain('Do not add human arms');
  });

  it('generateEditedImage 非人类角色：最终 prompt 不含人脸/发型，含 species/非人类护栏', async () => {
    useAppStore.setState({ project: structuredClone(fishProject()) });
    await useImage.getState().generateEditedImage({
      target: 'character',
      refId: 'ch-linchong',
      prompt: '把鱼鳍改成红色',
      referenceImages: ['data:image/png;base64,IN'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain('金鱼');
    expect(prompts[0]).toMatch(/species|anatomy|silhouette/i);
    expect(prompts[0]).not.toMatch(/facial features|hairstyle|body proportions/i);
  });

  it('generateEditedImage 非人类镜头：带本镜角色 forms/species，不套人类说明', async () => {
    useAppStore.setState({ project: structuredClone(fishProject()) });
    await useImage.getState().generateEditedImage({
      target: 'frame',
      refId: SHOT_ID,
      frameKind: 'first-frame',
      prompt: '让鱼继续向前游',
      referenceImages: ['data:image/png;base64,IN'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain('金鱼');
    expect(prompts[0]).not.toMatch(/facial features|hairstyle|body proportions/i);
    expect(prompts[0]).toContain('Do not add human arms');
  });
});
