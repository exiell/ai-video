// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useImage } from '../src/store/image';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { sampleProject } from '../src/data/samples/sampleProject';
import { saveAssets } from '../src/services/storage';
import { withReferenceInstruction } from '../src/services/gateway/dashscope';
import type { ImageRequest, Project } from '../src/types/model';

/**
 * 参考图说明到底有没有发出去（v0.46）
 *
 * ===========================================================================
 * 这条线曾经整条断着，而且测试全绿
 * ===========================================================================
 * v0.44 把「逐张说明参考图职责」「头像是头像、别再要求它保持体型」
 * 「两个角色同框要明说是不同的人」都写进了 `withReferenceInstruction`，
 * 也写了测试——但那些测试**只测这个函数本身**。
 *
 * 真实调用链是 `generateForFrame` → `runGeneration` → `generateImages`，
 * 而 `runGeneration` 拼请求体时**漏了 `frameRole`**。
 * 于是函数里那条 `sheetDetails === undefined` 的旧分支永远命中，
 * 每一次带参考图的出图都无条件追加那句
 * 「Keep the facial features, hairstyle and body proportions of the person
 * in the character reference image exactly.」
 *
 * 后果很具体：参考图只有一张场景板时，这句话在要求模型保持**画面里没有的人**的
 * 面部和体型；只给头像时，它在要求保持**看不见的**体型。两件事都在把人画坏。
 *
 * 所以这个测试断言的不是「函数写得对不对」，而是
 * **`generateImages` 真正收到的那个 req 里有没有它**。
 */

const captured: ImageRequest[] = [];

vi.mock('../src/services/image/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/image/generate')>();
  return {
    ...actual,
    generateImages: async (args: { req: ImageRequest }) => {
      captured.push(args.req);
      return { ok: true, images: [], warnings: [] };
    },
  };
});

/** 把 req 还原成模型真正看到的那段文字 */
function effectivePrompt(req: ImageRequest): string {
  if (!req.referenceImages || req.referenceImages.length === 0) return req.prompt;
  return withReferenceInstruction(req.prompt, {
    referenceCount: req.referenceImages.length,
    hasFirstFrameAnchor: req.frameRole?.hasFirstFrameAnchor ?? false,
    hasPreviousEndAnchor: req.frameRole?.hasPreviousEndAnchor ?? false,
    ...(req.frameRole?.roles ? { roles: req.frameRole.roles } : {}),
    ...(req.frameRole ? { frameKind: req.frameRole.kind } : {}),
    ...(req.frameRole?.sheetDetails ? { sheetDetails: req.frameRole.sheetDetails } : {}),
    ...(req.frameRole?.characterCount !== undefined
      ? { characterCount: req.frameRole.characterCount }
      : {}),
    ...(req.frameRole?.shotSizeEn ? { shotSizeEn: req.frameRole.shotSizeEn } : {}),
    ...(req.frameRole?.cameraPositionEn ? { cameraPositionEn: req.frameRole.cameraPositionEn } : {}),
  });
}

const LEGACY_SENTENCE =
  'Keep the facial features, hairstyle and body proportions of the person in the character reference image exactly.';

function asset(id: string, kind: 'scene-plate' | 'character-sheet-face' | 'character-sheet', refId: string) {
  const now = new Date().toISOString();
  return {
    id,
    projectId: sampleProject.id,
    kind,
    refId,
    dataUrl: `data:image/png;base64,${id}`,
    mimeType: 'image/png',
    promptSnapshot: 'x',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

/** 出第一镜的首帧（示例项目里它是一镜大远景，有两个角色） */
async function runFirstShot(project: Project): Promise<ImageRequest> {
  useAppStore.setState({ project });
  await useImage.getState().generateForFrame('shot-01', 'first-frame', true);
  const req = captured[captured.length - 1];
  if (!req) throw new Error('没有发出请求');
  return req;
}

beforeEach(async () => {
  captured.length = 0;
  useImage.setState({
    pending: null,
    feedback: {},
    gallery: {},
    assetCount: 0,
    assetCounts: {},
    batch: null,
    batchSummary: null,
  });
  useSettings.setState({ keys: { dashscope: 'sk-test' } });
  useAppStore.setState({ project: structuredClone(sampleProject) });

  // 每个场景一张板、每个角色一张头像 + 一张全身图。
  // 写死下标会取错场景（示例项目里 shot-01 不在 scenes[0]），断言会莫名其妙地少一张图。
  const project = sampleProject;
  await saveAssets([
    ...project.scenes.map((s, i) => asset(`plate-${i}`, 'scene-plate', s.id)),
    ...project.characters.map((c, i) => asset(`face-${i}`, 'character-sheet-face', c.id)),
    ...project.characters.map((c, i) => asset(`full-${i}`, 'character-sheet', c.id)),
  ]);
});

describe('参考图说明真的进了请求体', () => {
  it('req 里有 frameRole —— 这正是当初漏掉的那一行的回归断言', async () => {
    const req = await runFirstShot(structuredClone(sampleProject));
    expect(req.frameRole).toBeDefined();
    expect(req.frameRole?.kind).toBe('first-frame');
  });

  it('每张参考图都有一句自己的职责，而不是两句一模一样的话', async () => {
    const req = await runFirstShot(structuredClone(sampleProject));
    const roles = req.frameRole?.roles ?? [];
    expect(roles.length).toBeGreaterThan(1);
    expect(roles.length).toBe(req.referenceImages?.length);
    // 曾经两张角色图在这里是同一句话
    expect(new Set(roles).size).toBe(roles.length);
    const prompt = effectivePrompt(req);
    expect(prompt).toContain('Image 1 is ');
    expect(prompt).toContain('Image 2 is ');
  });

  it('不再出现「保持人物面部与体型」那句无差别的旧话', async () => {
    const req = await runFirstShot(structuredClone(sampleProject));
    expect(effectivePrompt(req)).not.toContain(LEGACY_SENTENCE);
  });

  it('只给头像时，体型改从场景里的固定物体推，而不是从那张图推', async () => {
    const project = structuredClone(sampleProject);
    // 砍成近景：近景读脸，这时手上只有头像
    project.shots[0]!.shotSize = 'close-up';
    const req = await runFirstShot(project);
    expect(req.frameRole?.sheetDetails).toEqual(['face']);
    const prompt = effectivePrompt(req);
    expect(prompt).toContain('Match the facial features and hairstyle in that head reference exactly.');
    expect(prompt).toContain('Take height, build and the volume of the clothing from the fixed objects');
  });

  it('大远景给全身图时，要求保持的是它**看得见**的体型', async () => {
    const project = structuredClone(sampleProject);
    project.shots[0]!.shotSize = 'extreme-wide';
    project.shots[0]!.characterIds = [sampleProject.characters[0]!.id];
    const req = await runFirstShot(project);
    expect(req.frameRole?.sheetDetails).toEqual(['full-body']);
    expect(effectivePrompt(req)).toContain(
      'Keep the facial features, hairstyle, build and body proportions of that character exactly as drawn in the turnaround reference.',
    );
  });

  it('画面里一个人都没有时，一个字都不提人物', async () => {
    const project = structuredClone(sampleProject);
    project.shots[0]!.characterIds = [];
    const req = await runFirstShot(project);
    expect(req.frameRole?.sheetDetails).toEqual([]);
    const prompt = effectivePrompt(req);
    expect(prompt).not.toContain('facial features');
    expect(prompt).not.toContain('body proportions');
  });

  it('两个角色同框时明说「这是不同的人」', async () => {
    const project = structuredClone(sampleProject);
    if (project.shots[0]!.characterIds.length < 2) {
      project.shots[0]!.characterIds = project.characters.slice(0, 2).map((c) => c.id);
    }
    const req = await runFirstShot(project);
    expect(req.frameRole?.characterCount).toBeGreaterThanOrEqual(2);
    const prompt = effectivePrompt(req);
    expect(prompt).toContain('Those character references are different people.');
    expect(prompt).toContain('never blend them into one person');
  });
});
