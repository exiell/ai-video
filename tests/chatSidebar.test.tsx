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
