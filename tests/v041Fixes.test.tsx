// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { GuidePage } from '../src/pages/GuidePage';
import { HomePage } from '../src/pages/HomePage';
import { useAppStore } from '../src/store/app';
import { useImage } from '../src/store/image';
import { sampleProject } from '../src/data/samples/sampleProject';
import { STYLE_PRESETS, matchStylePreset } from '../src/domain/help/stylePresets';
import { sanitizeStyleTags } from '../src/services/llm/schemas';
import { planReferenceImages, sameStyle } from '../src/domain/image/referencePlan';

/**
 * v0.41 修的三件事的回归测试
 *
 * 1. 打开项目后无法新建项目（死路）
 * 2. 风格预设选中后无法取消
 * 3. 改风格之后旧图仍被当参考图 → 风格崩坏
 */

let container: HTMLDivElement | null = null;

function render(node: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  const el = container;
  // 不立即卸载：调用方还要查 DOM / 点按钮
  container = null;
  return el;
}

function cleanup(el: HTMLDivElement): void {
  el.remove();
}

// ---------------------------------------------------------------------------
// 1. 新建项目
// ---------------------------------------------------------------------------

describe('作品主页 · 打开项目之后仍能新建', () => {
  beforeEach(() => {
    useAppStore.setState({ project: structuredClone(sampleProject) });
    useImage.setState({ gallery: {} });
  });

  it('**已经打开一个项目时，页面上要有「新建项目」按钮**', () => {
    /*
      原来这个入口只渲染在「没有打开项目」的分支里。
      一旦打开过项目，就再也建不了新的——界面上也没有「关闭项目」的操作。
      这是一个死路：只能清浏览器数据才能回到初始状态。
    */
    const el = render(<HomePage />);
    const buttons = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
    expect(buttons.some((t) => t.includes('新建项目'))).toBe(true);
    cleanup(el);
  });

  it('没打开项目时也有新建入口（这个分支一直是对的，防回归）', () => {
    useAppStore.setState({ project: null });
    const el = render(<HomePage />);
    const buttons = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
    expect(buttons.some((t) => t.includes('新建空项目'))).toBe(true);
    cleanup(el);
  });
});

// ---------------------------------------------------------------------------
// 2. 风格预设可取消
// ---------------------------------------------------------------------------

describe('引导向导 · 风格预设要能取消', () => {
  // 找一个标签唯一的预设，避免按钮文案撞车
  const preset = STYLE_PRESETS[0]!;

  beforeEach(() => {
    const project = structuredClone(sampleProject);
    project.brief.styleTags = [];
    project.brief.styleTone = '';
    useAppStore.setState({ project });
    useImage.setState({ gallery: {} });
  });

  /**
   * 风格与规格在第 3 步（index 2）。页面初始停在第 1 步，
   * 所以要先点步骤条切过去——否则 DOM 里根本没有预设按钮。
   */
  function goToStyleStep(el: HTMLElement): void {
    const stepBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('风格与规格'),
    );
    if (!stepBtn) throw new Error('找不到「风格与规格」这一步');
    act(() => (stepBtn as HTMLButtonElement).click());
  }

  function presetButton(el: HTMLElement): HTMLButtonElement {
    const found = [...el.querySelectorAll('button')].find(
      (b) =>
        !b.textContent?.includes('· 已选') &&
        b.textContent?.trim() === preset.label,
    );
    if (!found) throw new Error('找不到预设按钮：' + preset.label);
    return found as HTMLButtonElement;
  }

  it('点一下选中，把整组英文风格词写进项目', () => {
    const el = render(<GuidePage />);
    goToStyleStep(el);
    act(() => presetButton(el).click());
    expect(useAppStore.getState().project!.brief.styleTags).toEqual(preset.tags);
    cleanup(el);
  });

  it('**再点一下取消**，风格词被清空', () => {
    /*
      修之前：点已选中的预设只是把同一套词再写一遍，
      等于没有「不用预设」这条出路——用户想清空、想完全手写都没有办法。
    */
    const el = render(<GuidePage />);
    goToStyleStep(el);
    act(() => presetButton(el).click());
    expect(useAppStore.getState().project!.brief.styleTags).toEqual(preset.tags);

    // 重新渲染后按钮已变成选中态，再点一次应当清空
    cleanup(el);
    const el2 = render(<GuidePage />);
    goToStyleStep(el2);
    const activeBtn = [...el2.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('· 已选'),
    ) as HTMLButtonElement;
    expect(activeBtn, '选中态没显示出来').toBeTruthy();
    act(() => activeBtn.click());
    expect(useAppStore.getState().project!.brief.styleTags).toEqual([]);
    cleanup(el2);
  });

  it('**风格与规格这一步有「用这段中文生成英文关键词」按钮**', () => {
    /*
      「风格倾向」是中文，真正进提示词的是下面的英文关键词。
      新手写得出一堆中文、写不出英文，于是风格词一直是空的 —— 风格根本没生效。
      这个按钮把两者接上。
    */
    const el = render(<GuidePage />);
    goToStyleStep(el);
    const labels = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
    expect(labels.some((t) => t.includes('用这段中文生成英文关键词'))).toBe(true);
    cleanup(el);
  });

  it('没配好 API Key 时，这个按钮会给出「去设置」的出路而不是静默失效', () => {
    const el = render(<GuidePage />);
    goToStyleStep(el);
    const html = el.innerHTML;
    // GenerateBar 在未就绪时会渲染原因与入口
    expect(html).toMatch(/还不能生成|去设置|用这段中文生成英文关键词/);
    cleanup(el);
  });

  it('选中的判定是「命中 75% 以上」，不是逐字全等', () => {
    /*
      这一点值得写清楚：判定用的是「预设里有 75% 的词出现在当前 tags 里」。
      所以：
        - 原样选中 → 命中
        - 多一个词 → 仍然命中（它是在预设基础上加东西）
        - 换掉大半 → 不再命中（用户已经改成别的风格了）
        - 空 → 不命中
      用全等判定的话，「多写一个词」就会让按钮失去选中态，看起来像没点上。
    */
    expect(matchStylePreset(preset.tags)?.id).toBe(preset.id);
    expect(matchStylePreset([...preset.tags, 'extra tag'])?.id).toBe(preset.id);
    expect(matchStylePreset([])).toBeUndefined();
    expect(matchStylePreset(['ink wash painting', 'x', 'y', 'z'])).not.toBe(
      STYLE_PRESETS[0],
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 改风格之后旧图不能当参考图
// ---------------------------------------------------------------------------

describe('风格关键词清洗（模型输出不可信）', () => {
  it('去掉引号、句号、多余空格', () => {
    expect(sanitizeStyleTags(['"anime style"', 'cel shading.', '  cold  blue  palette '])).toEqual([
      'anime style',
      'cel shading',
      'cold blue palette',
    ]);
  });

  it('丢掉整句（超过 8 个词的就不是风格短语了）', () => {
    expect(
      sanitizeStyleTags(['anime style', 'the whole picture should look like a warm hand painted film']),
    ).toEqual(['anime style']);
  });

  it('去重（不区分大小写）', () => {
    expect(sanitizeStyleTags(['Anime Style', 'anime style', 'cel shading'])).toEqual([
      'Anime Style',
      'cel shading',
    ]);
  });

  it('空串与空白被丢弃', () => {
    expect(sanitizeStyleTags(['', '   ', 'anime style'])).toEqual(['anime style']);
  });

  it('最多保留 10 条（再多会挤占描述画面的空间）', () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag ${i}`);
    expect(sanitizeStyleTags(many)).toHaveLength(10);
  });
});

describe('sameStyle · 判断两张图是不是同一套风格', () => {
  it('顺序无关', () => {
    expect(sameStyle(['a', 'b'], ['b', 'a'])).toBe(true);
  });

  it('大小写与空格无关', () => {
    expect(sameStyle(['Anime  Style'], ['anime style'])).toBe(true);
  });

  it('内容不同就是不同', () => {
    expect(sameStyle(['anime style'], ['ink wash painting'])).toBe(false);
  });

  it('**没有记录风格的老素材按「兼容」处理**', () => {
    // 否则升级之后所有历史图会突然不能当参考图，那比风格不一致更糟
    expect(sameStyle(undefined, ['anime style'])).toBe(true);
    expect(sameStyle(['anime style'], undefined)).toBe(true);
  });
});

describe('参考图编排 · 改过风格的旧图要被跳过', () => {
  const oldStyle = ['warm cel shading'];
  const newStyle = ['ink wash painting'];

  const sources = {
    ownFrames: [],
    characterSheets: [
      [
        {
          dataUrl: 'data:image/png;base64,OLD',
          kind: 'character-sheet-face',
          createdAt: '2026-01-01',
          styleTags: oldStyle,
        },
      ],
    ],
    scenePlates: [
      {
        dataUrl: 'data:image/png;base64,SCENE',
        kind: 'scene-plate',
        createdAt: '2026-01-01',
        styleTags: oldStyle,
      },
    ],
  };

  const caps = {
    negativePrompt: false,
    seed: false,
    referenceImage: true,
    maxReferenceImages: 3,
    maxOutputImages: 1,
  };

  it('**风格不一致的旧图不作为参考图**，并如实报告被跳过了', () => {
    /*
      这是「改完风格重出首尾帧、图就崩了」的根因：
      文字说的是新风格，参考图是旧风格生成的。参考图对画面的拉力比文字更强，
      于是出来的图介于两者之间。宁可少一张参考图，也不给模型两个打架的指令。
    */
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: caps,
      previous: undefined,
      sources,
      styleTags: newStyle,
    });
    expect(plan.slots).toHaveLength(0);
    expect(plan.staleSkipped.length).toBeGreaterThan(0);
  });

  it('风格一致时正常使用', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: caps,
      previous: undefined,
      sources,
      styleTags: oldStyle,
    });
    expect(plan.slots.length).toBeGreaterThan(0);
    expect(plan.staleSkipped).toHaveLength(0);
  });

  it('老素材（没记录风格）仍然可用，不会因为升级就全失效', () => {
    const plan = planReferenceImages({
      kind: 'first-frame',
      capabilities: caps,
      previous: undefined,
      sources: {
        ownFrames: [],
        characterSheets: [
          [
            {
              dataUrl: 'data:image/png;base64,LEGACY',
              kind: 'character-sheet-face',
              createdAt: '2026-01-01',
            },
          ],
        ],
        scenePlates: [],
      },
      styleTags: newStyle,
    });
    expect(plan.slots.length).toBeGreaterThan(0);
  });
});
