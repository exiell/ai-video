// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AiFlowGuide } from '../src/components/AiFlowGuide';
import { RichText } from '../src/components/bits';
import { useAppStore, makeEmptyProject } from '../src/store/app';
import { useImage } from '../src/store/image';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Asset, AssetKind } from '../src/types/model';

/**
 * AI 流程指引（v0.29）
 *
 * ===========================================================================
 * 这个组件为什么需要测试
 * ===========================================================================
 * 它做的不只是显示文案，而是**从项目数据里数进度**：
 * 「角色 3/5（全身 5/5、特写 2/5）」这类数字如果数错了，
 * 用户会以为自己做完了或者没做完，然后去做错的事。
 *
 * 而且它要在一件事上做对判断：**同一个对象的图可能有好几张**，
 * 进度应该按「覆盖了多少个对象」算，不是「有多少张图」。
 */

function asset(refId: string, kind: AssetKind): Asset {
  return {
    id: `a-${refId}-${kind}`,
    projectId: 'p',
    refId,
    kind,
    mimeType: 'image/png',
    promptSnapshot: '',
    dataUrl: 'data:image/png;base64,x',
    byteSize: 1,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 用**客户端渲染**，不用 renderToStaticMarkup。
 *
 * 踩过的坑：`renderToStaticMarkup` 是服务端渲染，而 Zustand 在 SSR 下会走
 * `getServerSnapshot`（默认返回初始状态），于是测试里 `setState` 之后
 * 组件仍然读到空的 store，渲染出空字符串 —— 看起来像组件坏了，
 * 实际是测试方法不对。客户端渲染读的是真实状态。
 */
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(variant: 'full' | 'compact' = 'full'): string {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter>
        <AiFlowGuide variant={variant} />
      </MemoryRouter>,
    );
  });
  const html = container.innerHTML;
  act(() => root!.unmount());
  container.remove();
  container = null;
  root = null;
  return html;
}

/** 去掉 HTML 标签，只看文案 */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/** RichText 单独渲染（它不依赖 store，两种渲染方式都行） */
function renderText(node: React.ReactElement): string {
  const div = document.createElement('div');
  const r = createRoot(div);
  act(() => r.render(node));
  const html = div.innerHTML;
  act(() => r.unmount());
  return html;
}

describe('RichText · 让 **重点** 真的变成加粗', () => {
  it('**成对的星号渲染成 <b>，不再是字面星号**', () => {
    const html = renderText(<RichText>{'这一步会**覆盖**现有的内容'}</RichText>);
    expect(html).toContain('<b>覆盖</b>');
    // 关键：用户不该看到星号
    expect(html).not.toContain('**');
  });

  it('没有星号的文案原样输出', () => {
    const html = renderText(<RichText>{'普通文案'}</RichText>);
    expect(html).toBe('普通文案');
  });

  it('一段里有多组加粗都能处理', () => {
    const html = renderText(<RichText>{'**甲**和**乙**'}</RichText>);
    expect(html).toContain('<b>甲</b>');
    expect(html).toContain('<b>乙</b>');
    expect(html).not.toContain('**');
  });

  it('落单的星号不会被吃掉（例如乘法或强调号）', () => {
    const html = renderText(<RichText>{'2 * 3 = 6'}</RichText>);
    expect(html).toContain('*');
  });

  it('空字符串不崩', () => {
    expect(() => renderText(<RichText>{''}</RichText>)).not.toThrow();
  });

  it('只有 **** 这种空加粗不会渲染成空 <b>', () => {
    const html = renderText(<RichText>{'****'}</RichText>);
    expect(html).not.toContain('<b></b>');
  });
});

describe('AI 流程指引 · 进度统计', () => {
  beforeEach(() => {
    useAppStore.setState({ project: null, report: null, dirty: false, revision: 0, saveError: null });
    useImage.setState({ gallery: {}, feedback: {}, batch: null, batchSummary: null });
  });

  it('没有项目时不渲染（也不该崩）', () => {
    expect(render()).toBe('');
    expect(render('compact')).toBe('');
  });

  it('空项目：四个步骤都未完成，且不出现「会被覆盖」这种误导话术', () => {
    useAppStore.setState({ project: makeEmptyProject('空项目') });
    const t = text(render());
    expect(t).toContain('第 1 步');
    expect(t).toContain('已完成 0/4');
    // 空项目上不该说「会覆盖现有的角色与场景」
    expect(t).not.toContain('覆盖');
    expect(t).toContain('这是起点');
  });

  it('**同一对象有多个同类型图时，进度按对象数算，不按图片张数算**', () => {
    // 这是最容易数错的地方：一个角色出了 3 张全身图，
    // 如果按张数算就会显示 3/1，看起来像做完了两次。
    const p = makeEmptyProject('进度');
    p.characters = [
      { id: 'c1', name: '甲' } as never,
      { id: 'c2', name: '乙' } as never,
    ];
    useAppStore.setState({ project: p });
    useImage.setState({
      gallery: {
        c1: [asset('c1', 'character-sheet'), asset('c1', 'character-sheet'), asset('c1', 'character-sheet')],
        c2: [asset('c2', 'character-sheet')],
      },
    });
    const t = text(render());
    // 全身应显示 2/2（两个角色都覆盖到了），不是 4/2
    expect(t).toContain('全身 2/2');
    expect(t).not.toContain('4/2');
  });

  it('角色需要有全身 + 特写两张才算完成', () => {
    const p = makeEmptyProject('角色');
    p.characters = [{ id: 'c1', name: '甲' } as never];
    useAppStore.setState({ project: p });

    // 只有全身图 → 未完成
    useImage.setState({ gallery: { c1: [asset('c1', 'character-sheet')] } });
    expect(text(render())).toContain('角色 0/1');

    // 补上特写 → 完成
    useImage.setState({
      gallery: { c1: [asset('c1', 'character-sheet'), asset('c1', 'character-sheet-face')] },
    });
    expect(text(render())).toContain('角色 1/1');
  });

  it('分镜表生成后，第 3 步显示镜头数并打勾', () => {
    const p = makeEmptyProject('分镜');
    p.characters = [{ id: 'c1', name: '甲' } as never];
    p.scenes = [{ id: 's1', name: '场景' } as never];
    p.shots = [{ id: 'sh1' } as never, { id: 'sh2' } as never];
    useAppStore.setState({ project: p });
    const t = text(render());
    expect(t).toContain('已有 2 个镜头');
    expect(t).toContain('已完成 · 第 3 步 · 生成分镜表');
  });

  it('三帧各自统计，不互相顶替', () => {
    const p = makeEmptyProject('三帧');
    p.characters = [{ id: 'c1', name: '甲' } as never];
    p.scenes = [{ id: 's1', name: '场景' } as never];
    p.shots = [{ id: 'sh1' } as never, { id: 'sh2' } as never];
    useAppStore.setState({ project: p });
    useImage.setState({
      gallery: {
        sh1: [asset('sh1', 'first-frame')],
        sh2: [asset('sh2', 'first-frame')],
      },
    });
    const t = text(render());
    expect(t).toContain('首帧 2/2');
    expect(t).toContain('动作关键帧 0/2');
    expect(t).toContain('尾帧 0/2');
  });

  it('示例项目的进度能被正确读出来（不崩）', () => {
    useAppStore.setState({ project: sampleProject });
    expect(() => render()).not.toThrow();
    expect(text(render())).toContain('已完成');
  });
});

describe('AI 流程指引 · 紧凑版', () => {
  beforeEach(() => {
    useAppStore.setState({ project: null, report: null, dirty: false, revision: 0, saveError: null });
    useImage.setState({ gallery: {}, feedback: {}, batch: null, batchSummary: null });
  });

  it('只显示**第一个没做完**的步骤，而不是把所有步骤都铺开', () => {
    const p = makeEmptyProject('紧凑');
    p.characters = [{ id: 'c1', name: '甲' } as never];
    p.scenes = [{ id: 's1', name: '场景' } as never];
    useAppStore.setState({ project: p });
    const t = text(render('compact'));
    /*
      v0.38 紧凑版从「一张四行说明卡」改成「一行：下一步去哪、点哪个」。
      所以这里断言的是条上的步骤标记，不再是「第 N 步」这个措辞。

      「只显示第一个没做完的」这个约束没变，只是换了说法。
    */
    // 第 1 步已完成 → 条上应指向第 2 步
    expect(t).toContain('下一步 2/4');
    expect(t).not.toContain('下一步 3/4');
    expect(t).not.toContain('下一步 4/4');
  });

  it('**一行式**：不管内容多长，标题区只占一行（不再铺开四行）', () => {
    // 这条守的是 v0.38 的核心：说明不再挡在操作之前。
    const p = makeEmptyProject('一行');
    useAppStore.setState({ project: p });
    const html = render('compact');
    // 只保留一个 next-step 条；「怎么做 / 当前进度 / 会看到什么」
    // 这些原来常驻的行现在都收进了 details
    expect((html.match(/class="next-step"/g) ?? []).length).toBe(1);
    expect(html).toContain('<details');
  });

  it('全部做完后紧凑版自动消失（不占用界面）', () => {
    const p = makeEmptyProject('全做完');
    p.characters = [{ id: 'c1', name: '甲' } as never];
    p.scenes = [{ id: 's1', name: '场景' } as never];
    p.shots = [{ id: 'sh1' } as never];
    useAppStore.setState({ project: p });
    useImage.setState({
      gallery: {
        c1: [asset('c1', 'character-sheet'), asset('c1', 'character-sheet-face')],
        s1: [asset('s1', 'scene-plate')],
        sh1: [
          asset('sh1', 'first-frame'),
          asset('sh1', 'action-peak'),
          asset('sh1', 'end-frame'),
        ],
      },
    });
    expect(render('compact')).toBe('');
  });

  it('紧凑版不显示字面星号', () => {
    const p = makeEmptyProject('星号');
    p.characters = [{ id: 'c1', name: '甲' } as never];
    p.scenes = [{ id: 's1', name: '场景' } as never];
    useAppStore.setState({ project: p });
    expect(text(render('compact'))).not.toContain('**');
  });

  it('完整版也不显示字面星号', () => {
    useAppStore.setState({ project: makeEmptyProject('星号2') });
    expect(text(render())).not.toContain('**');
  });
});

