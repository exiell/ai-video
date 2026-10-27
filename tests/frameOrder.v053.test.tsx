// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import {
  describeNames,
  framePrereqMessage,
  isFramePrereqMet,
  missingBeforeFrames,
} from '../src/domain/image/order';
import { BatchGenerateCard } from '../src/components/BatchGenerateCard';
import { useAppStore } from '../src/store/app';
import { useImage } from '../src/store/image';
import { useSettings } from '../src/store/settings';
import { getDb, saveAssets } from '../src/services/storage';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Asset, AssetKind, Project } from '../src/types/model';

/**
 * 出图顺序提示（v0.53）
 *
 * ===========================================================================
 * 为什么要在点「生成」的时候拦一下
 * ===========================================================================
 * 三帧的参考图里，角色形象图与场景参考板是前两位的锚点。这两样没出就出帧，
 * 工具不会报错——它只是**少放两张参考图**，然后让模型拿文字去猜。
 * 猜错的后果用户会记在「一致性不好」上，找不到原因。
 *
 * 所以这里测两件事：
 *   1. 缺什么、怎么用最少的字说清楚
 *   2. 真的会在点按钮的时候问，而且允许继续
 *
 * 用户对文案的要求是「简洁清晰，文字尽可能少」，
 * 所以有一条测试直接卡住长度上限——文案一膨胀就会红。
 */

function withAssets(project: Project, kinds: Partial<Record<'character' | 'scene', AssetKind[]>>): Asset[] {
  const now = new Date().toISOString();
  const assets: Asset[] = [];
  for (const character of project.characters) {
    for (const kind of kinds.character ?? []) {
      assets.push({
        id: `${character.id}-${kind}`,
        projectId: project.id,
        refId: character.id,
        kind,
        mimeType: 'image/png',
        promptSnapshot: '',
        dataUrl: 'data:image/png;base64,x',
        byteSize: 1,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  for (const scene of project.scenes) {
    for (const kind of kinds.scene ?? []) {
      assets.push({
        id: `${scene.id}-${kind}`,
        projectId: project.id,
        refId: scene.id,
        kind,
        mimeType: 'image/png',
        promptSnapshot: '',
        dataUrl: 'data:image/png;base64,x',
        byteSize: 1,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return assets;
}

const ready = (project: Project): Asset[] =>
  withAssets(project, {
    character: ['character-sheet', 'character-sheet-face'],
    scene: ['scene-plate'],
  });

describe('缺什么：missingBeforeFrames', () => {
  const project = structuredClone(sampleProject);
  const firstCharacter = project.characters[0]!.name;
  const firstScene = project.scenes[0]!.name;

  it('角色要全身与特写都有才算齐', () => {
    const onlyFull = withAssets(project, {
      character: ['character-sheet'],
      scene: ['scene-plate'],
    });
    const gap = missingBeforeFrames(project, onlyFull);
    expect(gap.characters).toContain(firstCharacter);
    expect(gap.scenes).toHaveLength(0);
  });

  it('只有特写也算缺（远景要靠全身图锁体型）', () => {
    const onlyFace = withAssets(project, { character: ['character-sheet-face'], scene: ['scene-plate'] });
    expect(missingBeforeFrames(project, onlyFace).characters).toContain(firstCharacter);
  });

  it('场景没有参考板就列出来', () => {
    const noPlate = withAssets(project, {
      character: ['character-sheet', 'character-sheet-face'],
    });
    expect(missingBeforeFrames(project, noPlate).scenes).toContain(firstScene);
  });

  it('都齐了就什么都不缺', () => {
    const gap = missingBeforeFrames(project, ready(project));
    expect(isFramePrereqMet(gap)).toBe(true);
    expect(framePrereqMessage(gap)).toBeNull();
  });

  it('只认真的有图的数据，没有 dataUrl 的记录不算', () => {
    const empty = withAssets(project, {
      character: ['character-sheet', 'character-sheet-face'],
      scene: ['scene-plate'],
    }).map((asset) => ({ ...asset, dataUrl: '' }));
    const gap = missingBeforeFrames(project, empty);
    expect(gap.characters.length).toBe(project.characters.length);
    expect(gap.scenes.length).toBe(project.scenes.length);
  });

  it('空项目不报缺', () => {
    const empty = { ...project, characters: [], scenes: [] };
    expect(isFramePrereqMet(missingBeforeFrames(empty, []))).toBe(true);
  });
});

describe('怎么说：framePrereqMessage', () => {
  it('缺角色也缺场景时两件事都说，一句话说完', () => {
    const message = framePrereqMessage({ characters: ['林冲'], scenes: ['山神庙'] }) ?? '';
    expect(message).toContain('角色「林冲」还没有形象图');
    expect(message).toContain('场景「山神庙」还没有参考板');
    expect(message).toContain('仍然生成？');
  });

  it('只缺一样就不提另一样', () => {
    const onlyChars = framePrereqMessage({ characters: ['林冲'], scenes: [] }) ?? '';
    expect(onlyChars).not.toContain('参考板');
    const onlyScenes = framePrereqMessage({ characters: [], scenes: ['山神庙'] }) ?? '';
    expect(onlyScenes).not.toContain('形象图');
  });

  it('**文案要短**：一条提示不超过 80 个字', () => {
    // 用户明确要求「简洁清晰，文字尽可能少」。这条卡住上限，防止越写越长。
    const worst = framePrereqMessage({ characters: ['林冲', '陆谦'], scenes: ['山神庙', '草料场'] }) ?? '';
    expect(worst.length).toBeLessThanOrEqual(80);
  });

  it('名字太多就折起来，数字照实说', () => {
    expect(describeNames(['甲', '乙', '丙'])).toBe('「甲」「乙」「丙」');
    expect(describeNames(['甲', '乙', '丙', '丁', '戊'])).toBe('「甲」「乙」「丙」等 5 个');
    const many = framePrereqMessage({ characters: ['甲', '乙', '丙', '丁', '戊'], scenes: [] }) ?? '';
    expect(many).toContain('等 5 个');
  });
});

// ---------------------------------------------------------------------------
// store：现查图库，查不到就放行
// ---------------------------------------------------------------------------

describe('framePrereqNotice：查不到就放行', () => {
  beforeEach(async () => {
    await getDb().assets.clear();
    useAppStore.setState({ project: structuredClone(sampleProject) });
    useImage.setState({ pending: null, feedback: {}, batch: null, batchSummary: null });
  });

  it('图库是空的时候列出所有缺的', async () => {
    const notice = await useImage.getState().framePrereqNotice();
    expect(notice).toContain('还没有形象图');
    expect(notice).toContain('还没有参考板');
  });

  it('出齐了就不再提示', async () => {
    const project = useAppStore.getState().project!;
    await saveAssets(ready(project));
    expect(await useImage.getState().framePrereqNotice()).toBeNull();
  });

  it('查询失败不该挡住出图', async () => {
    const spy = vi.spyOn(await import('../src/services/storage'), 'listAssets');
    spy.mockRejectedValueOnce(new Error('db down'));
    expect(await useImage.getState().framePrereqNotice()).toBeNull();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 界面：点按钮的时候真的会问
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;

function render(node: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  const el = container;
  container = null;
  return el;
}

function clickButton(el: HTMLElement, text: string): HTMLButtonElement {
  const button = [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
  if (!button) throw new Error(`找不到「${text}」按钮`);
  return button;
}

describe('批量出帧前会问一句', () => {
  beforeEach(async () => {
    await getDb().assets.clear();
    useImage.setState({
      pending: null,
      feedback: {},
      gallery: {},
      assetCount: 0,
      assetCounts: {},
      batch: null,
      batchSummary: null,
    });
    useAppStore.setState({ project: structuredClone(sampleProject) });
    useSettings.setState({ keys: { dashscope: 'sk-test' } });
  });

  it('**缺角色与场景的图时点「全部三帧」会先弹提示**', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const ran = vi.fn(async () => undefined);
    useImage.setState({ generateAllFramesInOrder: ran });

    const el = render(<BatchGenerateCard tasks={['all-frames']} />);
    await act(async () => {
      clickButton(el, '全部三帧').click();
    });

    expect(confirmSpy).toHaveBeenCalled();
    const message = String(confirmSpy.mock.calls[0]![0]);
    expect(message).toContain('还没有形象图');
    expect(message).toContain('仍然生成？');
    // 点了「取消」就真的不跑
    expect(ran).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
    el.remove();
  });

  it('点「继续」就照常跑', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const ran = vi.fn(async () => undefined);
    useImage.setState({ generateAllFramesInOrder: ran });

    const el = render(<BatchGenerateCard tasks={['all-frames']} />);
    await act(async () => {
      clickButton(el, '全部三帧').click();
    });

    expect(ran).toHaveBeenCalled();
    confirmSpy.mockRestore();
    el.remove();
  });

  it('图都出齐了就不问，直接跑', async () => {
    const project = useAppStore.getState().project!;
    await saveAssets(ready(project));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const ran = vi.fn(async () => undefined);
    useImage.setState({ generateAllFramesInOrder: ran });

    const el = render(<BatchGenerateCard tasks={['all-frames']} />);
    await act(async () => {
      clickButton(el, '全部三帧').click();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(ran).toHaveBeenCalled();
    confirmSpy.mockRestore();
    el.remove();
  });

  it('出角色形象图这一步不该被拦（它本来就是第一张图）', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const ran = vi.fn(async () => undefined);
    useImage.setState({ generateAllCharacterSheets: ran });

    const el = render(<BatchGenerateCard tasks={['characters']} />);
    await act(async () => {
      clickButton(el, '全部角色形象图').click();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(ran).toHaveBeenCalled();
    confirmSpy.mockRestore();
    el.remove();
  });
});
