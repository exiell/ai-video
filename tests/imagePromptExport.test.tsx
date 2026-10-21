// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { CharactersPage } from '../src/pages/CharactersPage';
import { ImagePanel } from '../src/components/ImagePanel';
import {
  collectPromptEntries,
  promptEntryToText,
} from '../src/components/ImagePromptView';
import { imagePromptsToMarkdown } from '../src/domain/export';
import { buildExportManifest } from '../src/domain/export/bundle';
import { runChecks } from '../src/domain/checks';
import { useAppStore } from '../src/store/app';
import { useImage } from '../src/store/image';
import { useSettings } from '../src/store/settings';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Project } from '../src/types/model';

/**
 * 图片提示词要能看见、能导出（v0.43）
 *
 * ===========================================================================
 * 为什么这是功能缺口而不只是「少个按钮」
 * ===========================================================================
 * 这个工具只接了 8 家厂商。提示词算完就进了请求体、界面上从不显示、
 * 导出里也没有 —— 结果是**不接那 8 家，出图部分就完全用不了**。
 *
 * 而提示词本身是可以独立交付的东西：拿到任何模型里都能出图。
 * 所以它必须能看、能复制、能导出。
 */

let container: HTMLDivElement | null = null;

function purgePortals(): void {
  // 弹窗现在是 portal 到 body 的，root 卸载后也要清掉，否则会串到下一条测试
  document.querySelectorAll('.confirm-backdrop').forEach((n) => n.remove());
}


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

function fresh(): Project {
  return structuredClone(sampleProject);
}

beforeEach(() => {
  useAppStore.setState({ project: fresh() });
  useImage.setState({ gallery: {}, assetCount: 0 });
});

// ---------------------------------------------------------------------------
// 收集与文本化
// ---------------------------------------------------------------------------

describe('collectPromptEntries · 该出哪几段提示词', () => {
  const project = fresh();
  const character = project.characters[0]!;
  const scene = project.scenes[0]!;
  const shot = project.shots[0]!;

  it('角色：全身多视图 + 头部特写各一段', () => {
    const entries = collectPromptEntries(project, character.id, 'character', [
      { label: '全身', useReference: false, sheetKind: 'turnaround' },
      { label: '特写', useReference: true, sheetKind: 'face' },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.title)).toEqual(['全身多视图', '头部特写（锁脸）']);
    expect(entries[0]!.input.positive).toContain('model sheet');
  });

  it('**两个按钮指向同一份提示词时只列一次**（首帧有「纯文生图」和「锁角色」两种）', () => {
    const entries = collectPromptEntries(project, shot.id, 'frame', [
      { label: '首帧（纯文生图）', useReference: false, frameKind: 'first-frame' },
      { label: '首帧（锁角色）', useReference: true, frameKind: 'first-frame' },
      { label: '动作关键帧', useReference: true, frameKind: 'action-peak' },
      { label: '尾帧', useReference: true, frameKind: 'end-frame' },
    ]);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.title)).toEqual(['首帧', '动作关键帧', '尾帧']);
  });

  it('场景：一段参考板', () => {
    const entries = collectPromptEntries(project, scene.id, 'scene', [
      { label: '出参考板', useReference: false },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.input.positive).toContain('no people');
  });

  it('没有项目时返回空，不抛', () => {
    expect(collectPromptEntries(null, 'x', 'character', [])).toEqual([]);
  });

  it('对象不存在时返回空', () => {
    expect(
      collectPromptEntries(project, '不存在的id', 'character', [
        { label: '全身', useReference: false, sheetKind: 'turnaround' },
      ]),
    ).toEqual([]);
  });
});

describe('promptEntryToText · 复制出去的内容要完整', () => {
  it('含正向、负向、画幅、逐项说明', () => {
    const project = fresh();
    const shot = project.shots[0]!;
    const [entry] = collectPromptEntries(project, shot.id, 'frame', [
      { label: '首帧', useReference: false, frameKind: 'first-frame' },
    ]);
    const text = promptEntryToText(entry!);
    expect(text).toContain('【正向】');
    expect(text).toContain('【画幅】');
    expect(text).toContain(entry!.input.aspectRatio);
    if (project.brief.negativePrompt) expect(text).toContain('【负向】');
    expect(text).toContain('【逐项说明】');
  });
});

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

describe('导出 · 图片提示词.md', () => {
  it('**三类都收进去了**：角色、场景、镜头三帧', () => {
    const md = imagePromptsToMarkdown(fresh());
    expect(md).toContain('# 角色形象图');
    expect(md).toContain('# 场景参考板');
    expect(md).toContain('# 镜头三帧');
    expect(md).toContain('全身多视图');
    expect(md).toContain('头部特写');
  });

  it('**写清「本工具没接的模型也能用」**（这是这份文件的立身之本）', () => {
    const md = imagePromptsToMarkdown(fresh());
    expect(md).toContain('本工具没接的模型');
    expect(md).toContain('负向');
  });

  it('每一镜的三种帧都在，数量对得上', () => {
    const project = fresh();
    const md = imagePromptsToMarkdown(project);
    for (const shot of project.shots) {
      expect(md).toContain(`第 ${shot.number} 镜 · 首帧`);
      expect(md).toContain(`第 ${shot.number} 镜 · 动作关键帧`);
      expect(md).toContain(`第 ${shot.number} 镜 · 尾帧`);
    }
  });

  it('**同一镜的三帧要一起出**这条提醒也在（否则只重出后两帧就没有构图锚点）', () => {
    expect(imagePromptsToMarkdown(fresh())).toContain('三帧要一起出');
  });

  it('空项目给的是可执行的下一步，不是空白文件', () => {
    const empty = fresh();
    empty.characters = [];
    empty.scenes = [];
    empty.shots = [];
    const md = imagePromptsToMarkdown(empty);
    expect(md).toContain('还没有可出的图');
    expect(md).toContain('角色');
  });

  it('提示词正文是英文（拿去任何模型都能用）', () => {
    const md = imagePromptsToMarkdown(fresh());
    // 至少出现 model sheet / aspect ratio 这类英文短语
    expect(md).toMatch(/anime character|model sheet|aspect ratio/);
  });
});

describe('导出包清单里必须有这份文件', () => {
  it('**压缩包里出现「图片提示词.md」**', () => {
    const project = fresh();
    const entries = buildExportManifest(project, runChecks(project));
    const hit = entries.find((e) => e.path === '图片提示词.md');
    expect(hit, '导出清单里没有 图片提示词.md').toBeTruthy();
    expect(hit!.content).toContain('# 角色形象图');
  });

  it('视频提示词和图片提示词是两份东西，互不覆盖', () => {
    const project = fresh();
    const entries = buildExportManifest(project, runChecks(project));
    const image = entries.filter((e) => e.path === '图片提示词.md');
    const video = entries.filter((e) => e.path.startsWith('提示词/'));
    expect(image).toHaveLength(1);
    expect(video.length).toBeGreaterThan(0);
    // 两者内容不同：视频提示词是每镜一段的动作描述
    expect(image[0]!.content).not.toBe(video[0]!.content);
  });
});

// ---------------------------------------------------------------------------
// 界面
// ---------------------------------------------------------------------------

describe('出图按钮旁边要看得到提示词', () => {
  it('**ImagePanel 上有「显示图片提示词」按钮**', () => {
    const project = fresh();
    const character = project.characters[0]!;
    useSettings.setState({ keys: {} });
    const el = render(
      <ImagePanel
        refId={character.id}
        target="character"
        label="角色形象图"
        options={[{ label: '全身多视图', useReference: false, sheetKind: 'turnaround' }]}
      />,
    );
    const labels = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
    expect(labels.some((t) => t.includes('显示图片提示词'))).toBe(true);
    el.remove();
    purgePortals();
  });

  it('**没配出图 Key 时这个按钮仍然可用**（正是这种时候最需要它）', () => {
    const project = fresh();
    const character = project.characters[0]!;
    useSettings.setState({ keys: {} });
    const el = render(
      <ImagePanel
        refId={character.id}
        target="character"
        label="角色形象图"
        options={[{ label: '全身多视图', useReference: false, sheetKind: 'turnaround' }]}
      />,
    );
    const btn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('显示图片提示词'),
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    // 点开之后能看到英文正文
    act(() => btn.click());
    // 弹窗 portal 到 body，不在组件容器里
    expect(document.body.innerHTML).toContain('role="dialog"');
    expect(document.body.textContent).toContain('复制正向');
    expect(document.body.textContent).toContain('model sheet');
    el.remove();
    purgePortals();
  });

  it('**弹窗挂在 document.body 上，不能留在组件里**', () => {
    /*
      踩过的坑：`position: fixed` 并不保证相对视口定位 —— 只要任一祖先有非 none
      的 transform / filter / backdrop-filter，它就变成相对那个祖先定位。

      实际撞上的是 `.shot-more`：入场动画 `animation: ... both` 的末帧是
      `transform: translateY(0)`，`both` 把它永久保留，于是弹窗被限制在一张
      镜头卡片里，顶部还被裁掉（内容长时滚不到）。

      光改那条动画不够，以后任何一个卡片加动画都会再犯。挂到 body 才是通解，
      所以这条测试守的是「必须 portal」这个决定。
    */
    const project = fresh();
    const character = project.characters[0]!;
    useSettings.setState({ keys: {} });
    const el = render(
      <ImagePanel
        refId={character.id}
        target="character"
        label="角色形象图"
        options={[{ label: '全身多视图', useReference: false, sheetKind: 'turnaround' }]}
      />,
    );
    const btn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('显示图片提示词'),
    ) as HTMLButtonElement;
    act(() => btn.click());

    const backdrop = document.querySelector('.confirm-backdrop');
    expect(backdrop, '弹窗没渲染').toBeTruthy();
    expect(backdrop!.parentElement).toBe(document.body);
    el.remove();
    purgePortals();
  });

  it('角色页上真的渲染出了这个按钮（不是只有组件支持）', () => {
    /*
      角色卡是折叠的：ImagePanel 在展开区里。
      所以先展开一张卡——这也顺带说明按钮不会在没展开的卡片里凭空占位。
    */
    useSettings.setState({ keys: {} });
    const el = render(<CharactersPage />);
    expect(el.textContent).not.toContain('显示图片提示词');

    const expand = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '展开',
    ) as HTMLButtonElement | undefined;
    expect(expand, '找不到展开按钮').toBeTruthy();
    act(() => expand!.click());

    expect(el.textContent).toContain('显示图片提示词');
    el.remove();
    purgePortals();
  });
});
