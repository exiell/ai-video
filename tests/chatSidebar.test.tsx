// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatSidebar } from '../src/components/ChatSidebar';
import { Layout } from '../src/components/Layout';
import { useChat } from '../src/store/chat';
import { useAppStore, makeEmptyProject } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';

/**
 * 对话栏 · 界面冒烟测试
 *
 * 这里不测「问了模型之后怎样」——那要打真实接口。
 * 测的是**渲染不会崩、以及收起/展开的行为正确**：
 * 一个总是在 Layout 里挂载的组件如果渲染就抛，整个应用都白屏，
 * 而那和聊天功能本身对不对无关。
 */

function render(node: React.ReactElement): { html: string; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  const html = container.innerHTML;
  return {
    html,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('对话栏', () => {
  beforeEach(() => {
    useChat.setState({
      open: false,
      bubbles: [],
      pending: false,
      draft: '',
      activeBubbleId: null,
      selected: new Set(),
      undoStack: [],
      lastApplied: null,
      notice: null,
    });
    useAppStore.setState({ project: null, report: null, dirty: false, revision: 0, saveError: null });
  });

  it('**收起时仍然渲染展开按钮**（否则用户找不回来）', () => {
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('chat-toggle');
    expect(html).toContain('问 AI');
    expect(html).not.toContain('chat-body');
    unmount();
  });

  it('展开后显示输入区与引导语', () => {
    useChat.setState({ open: true });
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('chat-body');
    expect(html).toContain('问 AI 怎么改');
    // 空状态给几个示例问题，新手不知道该怎么开口
    expect(html).toContain('chat-quick');
    unmount();
  });

  it('没有项目时输入框禁用，并提示去哪里打开', () => {
    useChat.setState({ open: true });
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('先去「项目」页打开一个项目');
    unmount();
  });

  it('有项目时输入框可用', () => {
    useAppStore.setState({ project: sampleProject });
    useChat.setState({ open: true });
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).not.toContain('disabled=""\n              rows');
    expect(html).toContain('chat-input');
    unmount();
  });

  it('渲染用户气泡与助手气泡', () => {
    useChat.setState({
      open: true,
      bubbles: [
        { id: 'u1', role: 'user', content: '第三镜太平了' },
        { id: 'a1', role: 'assistant', content: '我把它改具体了。' },
      ],
    });
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('第三镜太平了');
    expect(html).toContain('我把它改具体了');
    unmount();
  });

  it('**提议卡片显示「改前 / 改后」对照**', () => {
    useAppStore.setState({ project: sampleProject });
    const shot = sampleProject.shots[0]!;
    useChat.setState({
      open: true,
      bubbles: [
        {
          id: 'a1',
          role: 'assistant',
          content: '建议这样改：',
          edits: [
            {
              id: 'e1',
              op: 'set',
              title: '让动作更具体',
              reason: '原来太笼统',
              target: { kind: 'shot', id: shot.id, field: 'action' },
              before: '',
              after: '他推开门，手停在门把上',
            },
          ],
        },
      ],
      activeBubbleId: 'a1',
      selected: new Set(['e1']),
    });
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('改前');
    expect(html).toContain('改后');
    expect(html).toContain('他推开门，手停在门把上');
    // 「改的是」要说清是第几镜的哪个字段
    expect(html).toContain('动作');
    unmount();
  });

  it('失败时给出人话错误，技术细节收在折叠区', () => {
    useChat.setState({
      open: true,
      bubbles: [
        {
          id: 'a1',
          role: 'assistant',
          content: '',
          error: '还没有填 DeepSeek 的 API Key。',
          detail: 'stack trace',
        },
      ],
    });
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('没能回答');
    expect(html).toContain('还没有填');
    expect(html).toContain('技术细节');
    unmount();
  });

  it('等模型回答时显示进度', () => {
    useChat.setState({ open: true, pending: true });
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('正在看你的分镜');
    unmount();
  });

  it('**渲染结果里没有字面星号**', () => {
    useAppStore.setState({ project: sampleProject });
    useChat.setState({
      open: true,
      bubbles: [
        { id: 'u1', role: 'user', content: '**加粗**试试' },
        { id: 'a1', role: 'assistant', content: '好，**改了**。' },
      ],
    });
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).not.toContain('**');
    expect(html).toContain('<b>改了</b>');
    unmount();
  });
});

describe('Layout 里的对话栏', () => {
  beforeEach(() => {
    useChat.setState({ open: false, bubbles: [], pending: false, draft: '', selected: new Set() });
    useAppStore.setState({ project: null, report: null, dirty: false, revision: 0, saveError: null });
  });

  it('**收起时 .app 不加 chat-open**（第三列宽度为 0）', () => {
    const { html, unmount } = render(
      <Layout>
        <div>内容</div>
      </Layout>,
    );
    expect(html).toContain('class="app"');
    unmount();
  });

  it('展开时 .app 带 chat-open', () => {
    useChat.setState({ open: true });
    const { html, unmount } = render(
      <Layout>
        <div>内容</div>
      </Layout>,
    );
    expect(html).toContain('app chat-open');
    unmount();
  });

  it('有项目但没展开时，也能渲染出切换按钮', () => {
    useAppStore.setState({ project: makeEmptyProject('测试') });
    const { html, unmount } = render(
      <Layout>
        <div>内容</div>
      </Layout>,
    );
    expect(html).toContain('chat-toggle');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// 收起入口必须一直在（真实 bug 的回归测试）
// ---------------------------------------------------------------------------

describe('收起对话栏的入口', () => {
  beforeEach(() => {
    useChat.setState({ open: false, bubbles: [], pending: false, draft: '', selected: new Set() });
    useAppStore.setState({ project: null, report: null, dirty: false, revision: 0, saveError: null });
  });

  it('**展开后仍然有收起入口**（第一版这里坏了：按钮被 overflow 裁掉）', () => {
    useChat.setState({ open: true });
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('chat-toggle');
    expect(html).toContain('收起对话栏');
    unmount();
  });

  it('收起状态下按钮也存在，文案变成展开', () => {
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('chat-toggle');
    expect(html).toContain('展开对话栏');
    unmount();
  });

  it('**点击能在两种状态之间来回切换**（不是只能开不能关）', () => {
    useChat.setState({ open: false });
    const { html, unmount } = render(<ChatSidebar />);
    // 收起 → 有展开提示
    expect(html).toContain('展开对话栏');
    unmount();

    // 模拟用户点了一次
    act(() => {
      useChat.getState().toggle();
    });
    expect(useChat.getState().open).toBe(true);

    const second = render(<ChatSidebar />);
    expect(second.html).toContain('收起对话栏');
    second.unmount();

    // 再点一次
    act(() => {
      useChat.getState().toggle();
    });
    expect(useChat.getState().open).toBe(false);
  });

  it('按钮带 aria-expanded，无障碍工具能读出展开状态', () => {
    useChat.setState({ open: true });
    const open = render(<ChatSidebar />);
    expect(open.html).toContain('aria-expanded="true"');
    open.unmount();

    useChat.setState({ open: false });
    const closed = render(<ChatSidebar />);
    expect(closed.html).toContain('aria-expanded="false"');
    closed.unmount();
  });

  it('**按钮不能是靠负偏移定位的**（那正是它被裁掉的原因）', () => {
    // 这条测的是「实现方式」而不是行为，但有必要：
    // 用 `left: -30px` 把按钮放到容器外、再靠 overflow 露出来，
    // 是「看起来能用、换个状态就废」的典型写法。
    // 这里断言按钮是 chat-panel 的**直接子元素**且排在正文之前，
    // 也就是它处在正常文档流里，不会被裁。
    useChat.setState({ open: true });
    const { html, unmount } = render(<ChatSidebar />);
    const panelIdx = html.indexOf('chat-panel');
    const toggleIdx = html.indexOf('chat-toggle');
    const bodyIdx = html.indexOf('chat-body');
    expect(panelIdx).toBeGreaterThanOrEqual(0);
    expect(toggleIdx).toBeGreaterThan(panelIdx);
    expect(bodyIdx).toBeGreaterThan(toggleIdx);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// 分批显示：改情节时一次二十几条，必须能读
// ---------------------------------------------------------------------------

describe('改动按对象分组显示', () => {
  beforeEach(() => {
    useAppStore.setState({ project: sampleProject });
    useChat.setState({
      open: true,
      bubbles: [],
      pending: false,
      draft: '',
      activeBubbleId: null,
      selected: new Set(),
      undoStack: [],
      lastApplied: null,
      notice: null,
    });
  });

  function bubbleWith(edits: unknown[]): void {
    useChat.setState({
      activeBubbleId: 'b1',
      selected: new Set(edits.map((e) => (e as { id: string }).id)),
      bubbles: [{ id: 'b1', role: 'assistant', content: '改好了。', edits: edits as never }],
    });
  }

  it('**同一个镜头的多条改动归到一组**', () => {
    const id = sampleProject.shots[0]!.id;
    bubbleWith([
      { id: 'e1', op: 'set', title: '改动作', reason: '', target: { kind: 'shot', id, field: 'action' }, before: 'a', beforeAtProposal: 'a', after: 'b' },
      { id: 'e2', op: 'set', title: '改时长', reason: '', target: { kind: 'shot', id, field: 'duration' }, before: '3', beforeAtProposal: '3', after: '2' },
    ]);
    const { html, unmount } = render(<ChatSidebar />);
    // 两条同一镜 → 只有一组
    expect((html.match(/chat-group-head/g) ?? []).length).toBe(1);
    unmount();
  });

  it('**不同镜头的改动分成不同组**', () => {
    const a = sampleProject.shots[0]!.id;
    const b = sampleProject.shots[1]!.id;
    bubbleWith([
      { id: 'e1', op: 'set', title: '改第 1 镜', reason: '', target: { kind: 'shot', id: a, field: 'action' }, before: '', beforeAtProposal: '', after: 'x' },
      { id: 'e2', op: 'set', title: '改第 2 镜', reason: '', target: { kind: 'shot', id: b, field: 'action' }, before: '', beforeAtProposal: '', after: 'y' },
    ]);
    const { html, unmount } = render(<ChatSidebar />);
    expect((html.match(/chat-group-head/g) ?? []).length).toBe(2);
    unmount();
  });

  it('**一条改动都不丢**（分组不能吃掉内容）', () => {
    const id = sampleProject.shots[0]!.id;
    bubbleWith([
      { id: 'e1', op: 'set', title: '甲', reason: '', target: { kind: 'shot', id, field: 'action' }, before: '', beforeAtProposal: '', after: 'x' },
      { id: 'e2', op: 'set', title: '乙', reason: '', target: { kind: 'shot', id, field: 'mood' }, before: '', beforeAtProposal: '', after: 'y' },
      { id: 'e3', op: 'create', title: '丙', reason: '', target: { kind: 'character' }, before: '（新建）', after: '新角色：甲' },
    ]);
    const { html, unmount } = render(<ChatSidebar />);
    // 只数卡片本身 —— 原来用 /class="chat-edit/ 会把 chat-edits、chat-edits-head
    // 和 chat-edit-danger 一起数进去，得到虚高的数字
    expect((html.match(/class="chat-edit[ "]/g) ?? []).length).toBe(3);
    unmount();
  });

  it('**删除有独立的视觉标记**（它比改字段重得多）', () => {
    const id = sampleProject.shots[1]!.id;
    bubbleWith([
      { id: 'e1', op: 'delete', title: '删掉这一镜', reason: '', target: { kind: 'shot', id }, before: '第 2 镜', after: '' },
    ]);
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('chat-edit-danger');
    expect(html).toContain('将删除');
    unmount();
  });

  it('新增显示「将新增」而不是前后对照', () => {
    bubbleWith([
      { id: 'e1', op: 'create', title: '加个反派', reason: '', target: { kind: 'character' }, before: '（新建）', after: '新角色：周薄森' },
    ]);
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('将新增');
    expect(html).not.toContain('改前');
    unmount();
  });

  it('**「改前」用提议时的快照，不是当前值**（这是那个显示相同的 bug）', () => {
    // 关键：beforeAtProposal 与项目里的当前值不同，
    // 界面必须显示 beforeAtProposal（提议时的值），而不是被改过的当前值。
    const id = sampleProject.shots[0]!.id;
    bubbleWith([
      {
        id: 'e1',
        op: 'set',
        title: '改动作',
        reason: '',
        target: { kind: 'shot', id, field: 'action' },
        before: '原始动作内容',
        beforeAtProposal: '原始动作内容',
        after: '改后的动作内容',
      },
    ]);
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('原始动作内容');
    expect(html).toContain('改后的动作内容');
    // 两栏不能是同一个值
    expect(html).not.toMatch(/改前<\/span><span[^>]*>改后的动作内容/);
    unmount();
  });

  it('改动多的组会折叠起来（不然一屏铺满没法读）', () => {
    const id = sampleProject.shots[0]!.id;
    const many = ['action', 'mood', 'dialogue', 'sound', 'cameraPosition'].map((f, i) => ({
      id: `e${i}`,
      op: 'set',
      title: `改 ${f}`,
      reason: '',
      target: { kind: 'shot', id, field: f },
      before: '',
      beforeAtProposal: '',
      after: `新值 ${i}`,
    }));
    bubbleWith(many);
    const { html, unmount } = render(<ChatSidebar />);
    // 5 条 > 3 → 应该折叠
    expect(html).toContain('<details');
    expect(html).toContain('展开看这 5 处');
    unmount();
  });

  it('摘要说明涉及几个对象、有没有增删', () => {
    const id = sampleProject.shots[0]!.id;
    bubbleWith([
      { id: 'e1', op: 'set', title: '改', reason: '', target: { kind: 'shot', id, field: 'action' }, before: '', beforeAtProposal: '', after: 'x' },
      { id: 'e2', op: 'delete', title: '删', reason: '', target: { kind: 'shot', id: sampleProject.shots[1]!.id }, before: '', after: '' },
      { id: 'e3', op: 'create', title: '增', reason: '', target: { kind: 'scene' }, before: '（新建）', after: '新场景：破庙' },
    ]);
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).toContain('新增 1 个');
    expect(html).toContain('删除 1 个');
    unmount();
  });

  it('渲染结果里没有字面星号', () => {
    const id = sampleProject.shots[0]!.id;
    bubbleWith([
      { id: 'e1', op: 'set', title: '改', reason: '', target: { kind: 'shot', id, field: 'action' }, before: '', beforeAtProposal: '', after: 'x' },
      { id: 'e2', op: 'delete', title: '删', reason: '', target: { kind: 'shot', id: sampleProject.shots[1]!.id }, before: '', after: '' },
    ]);
    const { html, unmount } = render(<ChatSidebar />);
    expect(html).not.toContain('**');
    unmount();
  });
});
