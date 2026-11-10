// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from '../src/pages/HomePage';
import { useAppStore } from '../src/store/app';
import { useImage } from '../src/store/image';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Asset, AssetKind, Project } from '../src/types/model';

/**
 * 主页精简 + 「下一步」优先级
 *
 * 两件事一起锁：
 *  1. 说明字段删干净了（下一步正文/时间/建议提示、待办 meta、检查时间与两行统计、
 *     参考图 note、存档常驻说明、最近镜头的固定文案）；
 *  2. 图片没出齐时不能推荐导出：参考图 → 三帧 → 导出。
 *
 * 视觉要实机验收；这里锁结构与文案行为。
 */

const project: Project = structuredClone(sampleProject);

let container: HTMLDivElement | null = null;

function render(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
  });
  const el = container;
  container = null;
  return el;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function asset(refId: string, kind: AssetKind): Asset {
  return {
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    id: `${refId}-${kind}`,
    projectId: project.id,
    kind,
    refId,
    mimeType: 'image/png',
    promptSnapshot: 'test',
  };
}

function emptyLoadedGallery(): Record<string, Asset[]> {
  const gallery: Record<string, Asset[]> = {};
  for (const character of project.characters) gallery[character.id] = [];
  for (const scene of project.scenes) gallery[scene.id] = [];
  for (const shot of project.shots) gallery[shot.id] = [];
  return gallery;
}

function refsReadyGallery(): Record<string, Asset[]> {
  const gallery = emptyLoadedGallery();
  for (const character of project.characters) {
    gallery[character.id] = [
      asset(character.id, 'character-sheet'),
      asset(character.id, 'character-sheet-face'),
    ];
  }
  for (const scene of project.scenes) gallery[scene.id] = [asset(scene.id, 'scene-plate')];
  return gallery;
}

function fullGallery(): Record<string, Asset[]> {
  const gallery = refsReadyGallery();
  for (const shot of project.shots) {
    gallery[shot.id] = [
      asset(shot.id, 'first-frame'),
      asset(shot.id, 'action-peak'),
      asset(shot.id, 'end-frame'),
    ];
  }
  return gallery;
}

function nextTitle(el: HTMLElement): string {
  return (el.querySelector('.next-card h2')?.textContent ?? '').trim();
}

function nextCta(el: HTMLElement): string {
  return (el.querySelector('.next-card .next-foot a')?.textContent ?? '').trim();
}

function deliveryStep(el: HTMLElement): Element | undefined {
  return [...el.querySelectorAll('.stage-step')].find(
    (node) => (node.querySelector('.stage-step-name')?.textContent ?? '').trim() === '交付',
  );
}

function deliveryState(el: HTMLElement): string {
  return (deliveryStep(el)?.querySelector('.stage-step-state')?.textContent ?? '').trim();
}

/** 示例项目的目标时长和镜头总长不相等（它故意埋了问题），这里先对齐，好测图片相关分支 */
function projectWithMatchedDuration(): Project {
  const next = structuredClone(sampleProject);
  next.brief.targetDuration = next.shots.reduce((sum, shot) => sum + shot.duration, 0);
  return next;
}

beforeEach(() => {
  document.body.innerHTML = '';
  useAppStore.setState({ project: projectWithMatchedDuration(), report: null });
  useImage.setState({ gallery: {} });
});

describe('主页说明字段精简', () => {
  it('下一步卡只留标签、标题、按钮；待办/检查/参考图/存档/最近镜头不再挂解释性文案', async () => {
    useImage.setState({ gallery: emptyLoadedGallery() });
    const el = render();
    await flush();

    // 下一步：保留标签 + 标题 + 主按钮
    expect(el.querySelector('.next-label')).toBeTruthy();
    expect(nextTitle(el).length).toBeGreaterThan(0);
    expect(nextCta(el).length).toBeGreaterThan(0);
    // 删掉：正文、时间预估、建议提示
    expect(el.querySelector('.next-card p')).toBeNull();
    expect(el.querySelector('.next-time')).toBeNull();
    expect(el.querySelector('.next-hint')).toBeNull();

    // 待办：只留标题 + 箭头，没有 meta 行
    expect(el.querySelectorAll('.task-row').length).toBeGreaterThan(0);
    expect(el.querySelectorAll('.task-main span').length).toBe(0);

    // 穿帮检查：删掉时间戳与建议/参考两行
    expect(el.querySelector('.check-row')).toBeNull();

    // 参考图：删掉 note，两个跳转改成带 aria-label 的图标按钮
    expect(el.querySelector('.asset-note')).toBeNull();
    const charLink = el.querySelector('a[aria-label="去角色设定"]');
    const sceneLink = el.querySelector('a[aria-label="去场景设定"]');
    expect(charLink?.getAttribute('title')).toBe('去角色设定');
    expect(sceneLink?.getAttribute('title')).toBe('去场景设定');

    // 存档：没有 saveError 时不显示常驻说明
    expect(el.querySelector('.save-panel .asset-note')).toBeNull();

    // 最近镜头：删掉固定文案「文字分镜 · 关键帧未生成」和「按 N 个场次排的」
    expect(el.querySelector('.shot-tile-foot')).toBeNull();
    expect(el.querySelector('.shots-foot')).toBeNull();
    expect(el.textContent ?? '').not.toContain('关键帧未生成');
    expect(el.textContent ?? '').not.toContain('个场次排的');
  });

  it('存档面板只在 saveError 时显示错误原因（错误反馈不是说明字段）', async () => {
    useImage.setState({ gallery: emptyLoadedGallery() });
    useAppStore.setState({ saveError: '没存上：本机存储空间不够。' });
    const el = render();
    await flush();
    const note = el.querySelector('.save-panel .asset-note');
    expect(note?.textContent ?? '').toContain('本机存储空间不够');
  });
});

describe('下一步：图片没出齐不推荐导出', () => {
  it('图库还没加载时保守显示参考图，而不是去导出', async () => {
    // 故意不预置 gallery：页面挂载后会触发懒加载
    const el = render();
    expect(nextTitle(el)).toBe('参考图');
    await flush();
    expect(nextTitle(el)).not.toBe('导出');
  });

  it('已加载但一张图都没有：下一步是参考图 / 去出图', async () => {
    useImage.setState({ gallery: emptyLoadedGallery() });
    const el = render();
    await flush();
    expect(nextTitle(el)).toBe('参考图');
    expect(nextCta(el)).toBe('去出图');
    expect(deliveryState(el)).toBe('待出图');
    expect(deliveryStep(el)?.classList.contains('is-done')).toBe(false);
  });

  it('参考图齐、三帧缺：下一步是分镜三帧 / 去出帧', async () => {
    useImage.setState({ gallery: refsReadyGallery() });
    const el = render();
    await flush();
    expect(nextTitle(el)).toBe('分镜三帧');
    expect(nextCta(el)).toBe('去出帧');
    expect(deliveryState(el)).toBe('待出帧');
  });

  it('全齐：下一步才是导出，交付阶段标记完成', async () => {
    useImage.setState({ gallery: fullGallery() });
    const el = render();
    await flush();
    expect(nextTitle(el)).toBe('导出');
    expect(nextCta(el)).toBe('去导出');
    expect(deliveryState(el)).toBe('可以导出');
    expect(deliveryStep(el)?.classList.contains('is-done')).toBe(true);
  });

  it('更早的阻塞项优先：故事没写时仍然先去写故事', async () => {
    const blank: Project = { ...structuredClone(project), story: { ...project.story, body: '' } };
    useAppStore.setState({ project: blank });
    useImage.setState({ gallery: {} });
    const el = render();
    await flush();
    expect(nextTitle(el)).toBe('故事');
  });
});
