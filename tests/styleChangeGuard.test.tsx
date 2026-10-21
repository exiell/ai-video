// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatSidebar } from '../src/components/ChatSidebar';
import { GuidePage } from '../src/pages/GuidePage';
import { useChat } from '../src/store/chat';
import { useAppStore } from '../src/store/app';
import { useImage } from '../src/store/image';
import { useSettings } from '../src/store/settings';
import { sampleProject } from '../src/data/samples/sampleProject';
import { assessStyleChange, styleChangeSummary } from '../src/domain/help/styleChange';

/**
 * 改风格的风险提示（v0.42）
 *
 * ===========================================================================
 * 为什么这件事必须提示
 * ===========================================================================
 * 风格词会进**每一张图**的提示词。所以「换个风格按钮」在已经做出内容之后，
 * 代价不是改一个字段，而是：
 *
 *   1. 角色/场景的英文描述与连续性锁是上一套风格下写的，不会跟着变
 *   2. 已生成的图是旧风格，会不再被当作参考图（跳过它们才好，否则风格会打架）
 *   3. 部分重出会打破镜头内三帧的连续
 *
 * 这三条界面上都不会报错——图照样出得来，只是不对。所以改之前要说清代价，
 * 并给出一条能走通的路径。三条路径（手动改、点预设、问 AI）共用同一份评估。
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

function cleanup(el: HTMLDivElement): void {
  el.remove();
  purgePortals();
}

// ---------------------------------------------------------------------------
// 评估逻辑
// ---------------------------------------------------------------------------

describe('assessStyleChange · 什么时候该提示', () => {
  it('**项目还空着时不提示**（没有投入，改风格没有代价）', () => {
    const impact = assessStyleChange({ characters: 0, scenes: 0, shots: 0, imageCount: 0 });
    expect(impact.needed).toBe(false);
    expect(impact.risks).toEqual([]);
  });

  it('有角色就算「已经做过内容」', () => {
    const impact = assessStyleChange({ characters: 2, scenes: 0, shots: 0, imageCount: 0 });
    expect(impact.needed).toBe(true);
    expect(impact.hasImages).toBe(false);
  });

  it('只有分镜也算（用户可能直接从示例项目改）', () => {
    expect(assessStyleChange({ characters: 0, scenes: 0, shots: 5, imageCount: 0 }).needed).toBe(
      true,
    );
  });

  it('**没出图时只提醒描述会不同步**', () => {
    const impact = assessStyleChange({ characters: 2, scenes: 2, shots: 7, imageCount: 0 });
    expect(impact.risks).toHaveLength(1);
    expect(impact.risks[0]).toContain('英文描述');
  });

  it('**出过图时要额外说清两件事**：旧图会失效、但不会自动删除', () => {
    const impact = assessStyleChange({ characters: 2, scenes: 2, shots: 7, imageCount: 9 });
    expect(impact.hasImages).toBe(true);
    expect(impact.risks.length).toBeGreaterThan(1);
    expect(impact.risks.join('')).toContain('参考图');
    expect(impact.risks.join('')).toContain('不会自动删除');
  });

  it('**步骤里必须写清「不要点拆角色」**（那会让旧图变孤儿）', () => {
    const impact = assessStyleChange({ characters: 2, scenes: 2, shots: 7, imageCount: 9 });
    expect(impact.steps.join('')).toContain('从故事里拆角色与场景');
    expect(impact.steps.join('')).toContain('全部角色形象图');
  });

  it('有分镜时步骤里要提醒「三帧一起重出」', () => {
    const impact = assessStyleChange({ characters: 1, scenes: 1, shots: 3, imageCount: 0 });
    expect(impact.steps.join('')).toContain('三帧');
  });

  it('摘要随「有没有图」变化', () => {
    const noImg = assessStyleChange({ characters: 1, scenes: 0, shots: 0, imageCount: 0 });
    const withImg = assessStyleChange({ characters: 1, scenes: 0, shots: 0, imageCount: 3 });
    expect(styleChangeSummary(noImg)).toContain('描述');
    expect(styleChangeSummary(withImg)).toContain('图');
    expect(styleChangeSummary(assessStyleChange({ characters: 0, scenes: 0, shots: 0, imageCount: 0 }))).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 路径一：引导向导里的常驻提示
// ---------------------------------------------------------------------------

describe('引导向导 · 做过的项目改风格时有常驻提示', () => {
  function goToStyleStep(el: HTMLElement): void {
    const stepBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('风格与规格'),
    );
    if (!stepBtn) throw new Error('找不到「风格与规格」这一步');
    act(() => (stepBtn as HTMLButtonElement).click());
  }

  beforeEach(() => {
    purgePortals();
    useAppStore.setState({ project: structuredClone(sampleProject) });
    useImage.setState({ gallery: {}, assetCount: 0 });
  });

  it('**已经有角色/场景/分镜时，风格这一节显示风险提示**', () => {
    const el = render(<GuidePage />);
    goToStyleStep(el);
    expect(el.textContent).toContain('已经做过内容了');
    expect(el.textContent).toContain('按这个顺序做');
    cleanup(el);
  });

  it('空项目时**不显示**这条提示（否则是在吓唬人）', () => {
    const p = structuredClone(sampleProject);
    p.characters = [];
    p.scenes = [];
    p.shots = [];
    useAppStore.setState({ project: p });
    const el = render(<GuidePage />);
    goToStyleStep(el);
    expect(el.textContent).not.toContain('已经做过内容了');
    cleanup(el);
  });

  it('**「用这段中文生成英文关键词」也要先确认**（它绕过了手动改的那条路）', () => {
    /*
      漏掉这条路径的后果：点「生成关键词」→ store 里 runStyleTags 直接 patchBrief，
      页面的守卫根本拦不到 —— 用户以为会看到提示，结果什么都没发生就换了风格。
    */
    // 让 LLM 就绪，按钮才可用
    useSettings.setState({ keys: { deepseek: 'sk-test' } });
    const el = render(<GuidePage />);
    goToStyleStep(el);

    const genBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('用这段中文生成英文关键词'),
    ) as HTMLButtonElement | undefined;
    expect(genBtn, '找不到生成按钮').toBeTruthy();
    expect(genBtn!.disabled, '按钮应当是可用状态（已配 Key）').toBe(false);

    act(() => genBtn!.click());

    // 闸门拦住 → 弹确认，而不是直接调模型
    expect(document.body.innerHTML).toContain('role="dialog"');
    expect(document.body.textContent).toContain('改风格会影响已经做好的内容');
    expect(document.body.textContent).toContain('按这个顺序做');
    cleanup(el);
  });

  it('空项目时点生成按钮**不弹窗**，直接走（没有投入可损失）', () => {
    useSettings.setState({ keys: { deepseek: 'sk-test' } });
    const empty = structuredClone(sampleProject);
    empty.characters = [];
    empty.scenes = [];
    empty.shots = [];
    useAppStore.setState({ project: empty });
    const el = render(<GuidePage />);
    goToStyleStep(el);
    const genBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('用这段中文生成英文关键词'),
    ) as HTMLButtonElement;
    act(() => genBtn.click());
    expect(document.body.innerHTML).not.toContain('role="dialog"');
    cleanup(el);
  });

  it('**出过图时提示里会点出图的数量**', () => {
    useImage.setState({ assetCount: 9 });
    const el = render(<GuidePage />);
    goToStyleStep(el);
    expect(el.textContent).toContain('9 张图');
    cleanup(el);
  });
});

// ---------------------------------------------------------------------------
// 路径二：问 AI
// ---------------------------------------------------------------------------

describe('问 AI · 改风格的提议也要带风险提示', () => {
  beforeEach(() => {
    useAppStore.setState({ project: structuredClone(sampleProject) });
    useImage.setState({ gallery: {}, assetCount: 4 });
    useChat.setState({
      open: true,
      bubbles: [
        {
          id: 'b1',
          role: 'assistant',
          content: '好，换成水墨风。',
          edits: [
            {
              id: 'e1',
              op: 'set',
              title: '把风格换成水墨写意',
              reason: '你要求换成水墨',
              target: { kind: 'brief', field: 'styleTags' },
              before: 'anime style',
              beforeAtProposal: 'anime style',
              after: 'ink wash painting',
            },
          ],
        },
      ],
      pending: false,
      draft: '',
      activeBubbleId: 'b1',
      selected: new Set(['e1']),
      undoStack: [],
      lastApplied: null,
      notice: null,
    });
  });

  it('**改 styleTags 的提议在卡片上有一行标记**（先让用户知道这条不一样）', () => {
    const el = render(<ChatSidebar />);
    expect(el.textContent).toContain('这条会换掉全片风格');
    cleanup(el);
  });

  it('**点「应用勾选的改动」时弹窗**，弹窗里给出完整风险与顺序', () => {
    /*
      v0.42 调整：卡片上只留一行标记，完整文案放在弹窗里。
      卡片是逐条看的，把四五段话塞进去会把它撑开、反而没人读；
      而弹窗出现在「即将生效」这一刻，正是该停下来想一想的时刻。
    */
    const el = render(<ChatSidebar />);
    const applyBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('应用勾选的改动'),
    );
    expect(applyBtn, '找不到应用按钮').toBeTruthy();
    act(() => (applyBtn as HTMLButtonElement).click());

    // 弹窗出现，且带完整风险清单
    expect(document.body.innerHTML).toContain('role="dialog"');
    expect(document.body.textContent).toContain('这一批改动会换掉全片风格');
    expect(document.body.textContent).toContain('按这个顺序');
    cleanup(el);
  });

  it('弹窗里点「先不应用」不会改动项目', () => {
    const before = structuredClone(useAppStore.getState().project!.brief.styleTags);
    const el = render(<ChatSidebar />);
    const applyBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('应用勾选的改动'),
    ) as HTMLButtonElement;
    act(() => applyBtn.click());
    // 弹窗 portal 到 body
    const cancel = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('先不应用'),
    ) as HTMLButtonElement;
    act(() => cancel.click());
    expect(useAppStore.getState().project!.brief.styleTags).toEqual(before);
    cleanup(el);
  });

  it('改 styleTone 同样提示（中文意图也会变风格）', () => {
    useChat.setState({
      bubbles: [
        {
          id: 'b1',
          role: 'assistant',
          content: '改成水墨调子。',
          edits: [
            {
              id: 'e1',
              op: 'set',
              title: '把风格倾向改成水墨',
              reason: '你要求',
              target: { kind: 'brief', field: 'styleTone' },
              before: '动画风',
              beforeAtProposal: '动画风',
              after: '水墨写意，冷色调',
            },
          ],
        },
      ],
      selected: new Set(['e1']),
    });
    const el = render(<ChatSidebar />);
    expect(el.textContent).toContain('这条会换掉全片风格');
    cleanup(el);
  });

  it('**改别的字段不会带上这条提示**（提示不能变成噪音）', () => {
    useChat.setState({
      bubbles: [
        {
          id: 'b1',
          role: 'assistant',
          content: '好，改动作。',
          edits: [
            {
              id: 'e1',
              op: 'set',
              title: '让第 3 镜的动作更有张力',
              reason: '你说太平',
              target: { kind: 'shot', id: sampleProject.shots[0]!.id, field: 'action' },
              before: '他走进来',
              beforeAtProposal: '他走进来',
              after: '他推门而入，手停在门把上',
            },
          ],
        },
      ],
      selected: new Set(['e1']),
    });
    const el = render(<ChatSidebar />);
    expect(el.textContent).not.toContain('这条会换掉全片风格');
    cleanup(el);
  });

  it('空项目时改风格也不提示（没有投入可损失）', () => {
    const empty = structuredClone(sampleProject);
    empty.characters = [];
    empty.scenes = [];
    empty.shots = [];
    useAppStore.setState({ project: empty });
    const el = render(<ChatSidebar />);
    expect(el.textContent).not.toContain('这条会换掉全片风格');
    cleanup(el);
  });
});
