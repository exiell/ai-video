import { create } from 'zustand';
import {
  applyChatEdits,
  buildProjectContext,
  decideGate,
  type ChatEditProposal,
  type EditGate,
} from '../domain/chat/edits';
import { askModel, buildChatMessages } from '../services/llm/chat';
import { buildGenerateContext } from '../services/llm/readiness';
import { useAppStore } from './app';
import type { ChatMessage } from '../services/gateway';
import type { Project } from '../types/model';

/**
 * 对话式改稿 · 状态层（方案.md §7.6.20）
 *
 * ===========================================================================
 * 三个设计决定，每个都有具体理由
 * ===========================================================================
 *
 * 1. **对话历史不持久化。**
 *    它只在当前这次会话里有效，刷新页面就没了。
 *    理由：历史是「我们刚才聊了什么」的临时上下文，
 *    而项目本身（故事、分镜、角色）才是要留存的东西 —— 那个已经存在 IndexedDB 里了。
 *    把对话也存下来会带来一个尴尬问题：用户三个月后打开，看到一堆
 *    关于旧版本分镜的讨论，而那些讨论已经不成立了。
 *
 * 2. **提议要重新校验（applyChatEdits 里做）。**
 *    从 AI 给出提议到用户点确认之间，用户可能手工改了同一个字段。
 *    所以确认时以**当前项目**为准重新应用，而不是相信提议生成时的快照。
 *
 * 3. **一次只保留一批待确认的提议。**
 *    如果允许累积多批，用户会看到一堆来自不同问题的修改混在一起，
 *    根本分不清哪条是回答哪个问题的。新问题会替换掉上一批未确认的提议
 *    ——并且会先问一下，避免用户辛苦勾选的成果被静默清掉。
 */

export interface ChatBubble {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 助手消息可能带提议 */
  edits?: ChatEditProposal[];
  /** 被校验挡掉的条数：要如实说，不能假装全都改得了 */
  rejected?: number;
  rejectedReasons?: string[];
  /** 失败时的原因（人话） */
  error?: string;
  /** 开发者细节，收在折叠区 */
  detail?: string;
  /** 这一批提议是否已经被应用或放弃 */
  resolved?: 'applied' | 'discarded';
  /** 为什么这批要你确认（给界面用一句话说清） */
  gateWhy?: string;
}

interface ChatState {
  open: boolean;
  bubbles: ChatBubble[];
  /** 正在等模型回答 */
  pending: boolean;
  /** 输入的草稿（切页面不丢） */
  draft: string;
  /** 当前待确认的提议所属的消息 id */
  activeBubbleId: string | null;
  /** 勾选中的提议 id */
  selected: Set<string>;
  /**
   * 撤销栈：每次应用前压入一份快照。
   *
   * 用栈而不是单个快照，是因为 auto 档会**不询问直接改** ——
   * 如果只留最近一次，用户连着问两个问题时，第一次的改动就撤不回来了。
   * 可撤销是 auto 档敢直接改的**唯一理由**，所以它必须真的可靠。
   */
  undoStack: Project[];
  /** 上一次应用了什么，用于回执文案 */
  lastApplied: { count: number; gate: EditGate; why: string } | null;
  /** 一次性的结果提示 */
  notice: string | null;

  toggle: () => void;
  setOpen: (open: boolean) => void;
  setDraft: (text: string) => void;
  ask: (question: string) => Promise<void>;
  toggleEdit: (editId: string) => void;
  selectAll: (bubbleId: string) => void;
  clearSelection: () => void;
  applySelected: () => void;
  discardActive: () => void;
  undo: () => void;
  clearNotice: () => void;
  reset: () => void;
}

export const useChat = create<ChatState>((set, get) => ({
  open: false,
  bubbles: [],
  pending: false,
  draft: '',
  activeBubbleId: null,
  selected: new Set(),
  undoStack: [],
  lastApplied: null,
  notice: null,

  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
  setDraft: (draft) => set({ draft }),
  clearNotice: () => set({ notice: null }),

  ask: async (question) => {
    const text = question.trim();
    if (!text || get().pending) return;

    const project = useAppStore.getState().project;
    if (!project) {
      set({ notice: '还没有打开项目。先去「项目」页新建或打开一个。' });
      return;
    }

    const gen = buildGenerateContext();
    if ('error' in gen) {
      // 配置不全是最常见的失败，且用户能自己修 —— 所以单独作为一条助手消息，
      // 而不是抛一个通用错误让他猜
      set((s) => ({
        bubbles: [
          ...s.bubbles,
          { id: newId('u'), role: 'user', content: text },
          { id: newId('a'), role: 'assistant', content: '', error: gen.error },
        ],
        draft: '',
        pending: false,
      }));
      return;
    }

    const history: ChatMessage[] = get()
      .bubbles.filter((b) => !b.error)
      .slice(-6)
      .map((b) => ({ role: b.role, content: b.content }));

    set((s) => ({
      bubbles: [...s.bubbles, { id: newId('u'), role: 'user', content: text }],
      draft: '',
      pending: true,
      notice: null,
    }));

    // 把穿帮检查的结论也带上 —— 用户会直接问「哪里会穿帮」，
    // 而那是引擎算出来的确定性结论，比让模型自己读分镜猜准得多
    const context = buildProjectContext(project, useAppStore.getState().report);
    const messages = buildChatMessages(context, history, text);
    const outcome = await askModel(gen.ctx, messages, project);

    set((s) => {
      const bubble: ChatBubble = { id: newId('a'), role: 'assistant', content: '' };

      if (!outcome.ok || !outcome.data) {
        bubble.error = outcome.error ?? '模型没有按格式回答。';
        if (outcome.detail) bubble.detail = outcome.detail;
        return { bubbles: [...s.bubbles, bubble], pending: false };
      }

      const { reply, rejected, rejectedReasons } = outcome.data;
      bubble.content = reply.reply;
      if (reply.edits.length > 0) bubble.edits = reply.edits;
      if (rejected > 0) {
        bubble.rejected = rejected;
        bubble.rejectedReasons = rejectedReasons;
      }

      if (reply.edits.length === 0) {
        return { bubbles: [...s.bubbles, bubble], pending: false, lastApplied: null };
      }

      const gate = decideGate({ editCount: reply.edits.length });

      /**
       * 【v0.35 取消 auto 档】一律走确认，不再直接应用。
       *
       * 原来是「定点小改直接改」，依据是 Anthropic 那条「确认框批准率 93%，
       * 每条都问 ≈ 没问」。用户明确要求改成全部确认，理由也成立：
       * 这是创作工具，每次改动直接决定要花钱生成的成品，用户确实会逐条看。
       *
       * 所以现在 `gate.gate` 恒为 'confirm'，这里不做分流。
       * 保留 `gate` 变量是为了把「为什么让你确认」这句话带给界面。
       */
      bubble.gateWhy = gate.why;

      return {
        bubbles: [...s.bubbles, bubble],
        pending: false,
        activeBubbleId: bubble.id,
        lastApplied: null,
        // 默认全选：绝大多数情况下用户是想要这些修改的，
        // 让他「取消掉不要的几条」比「逐条勾上要的」省事得多。
        selected: new Set(reply.edits.map((e) => e.id)),
      };
    });
  },

  toggleEdit: (editId) =>
    set((s) => {
      const next = new Set(s.selected);
      if (next.has(editId)) next.delete(editId);
      else next.add(editId);
      return { selected: next };
    }),

  selectAll: (bubbleId) =>
    set((s) => {
      const bubble = s.bubbles.find((b) => b.id === bubbleId);
      return { selected: new Set((bubble?.edits ?? []).map((e) => e.id)) };
    }),

  clearSelection: () => set({ selected: new Set() }),

  applySelected: () => {
    const { activeBubbleId, selected, bubbles } = get();
    const project = useAppStore.getState().project;
    if (!project || !activeBubbleId) return;

    const bubble = bubbles.find((b) => b.id === activeBubbleId);
    const chosen = (bubble?.edits ?? []).filter((e) => selected.has(e.id));
    if (chosen.length === 0) {
      set({ notice: '一条都没勾选，所以什么都没改。' });
      return;
    }

    const result = applyChatEdits(project, chosen);
    useAppStore.getState().setProject(result.project);

    set((s) => ({
      undoStack: [...s.undoStack, project],
      bubbles: s.bubbles.map((b) => (b.id === activeBubbleId ? { ...b, resolved: 'applied' } : b)),
      activeBubbleId: null,
      selected: new Set(),
      lastApplied: { count: result.applied, gate: 'confirm', why: '' },
      notice:
        `已修改 ${result.applied} 处。` +
        (result.skipped > 0 ? `另有 ${result.skipped} 处被跳过：${result.skippedReasons.join('；')}` : '') +
        ' 不满意可以点「撤销这次修改」。',
    }));
  },

  discardActive: () =>
    set((s) => ({
      bubbles: s.bubbles.map((b) =>
        b.id === s.activeBubbleId ? { ...b, resolved: 'discarded' } : b,
      ),
      activeBubbleId: null,
      selected: new Set(),
      notice: '已放弃这批修改，项目内容没有变化。',
    })),

  undo: () => {
    const stack = get().undoStack;
    const snapshot = stack[stack.length - 1];
    if (!snapshot) return;
    useAppStore.getState().setProject(snapshot);
    set({
      undoStack: stack.slice(0, -1),
      lastApplied: null,
      // 撤销后清掉「已应用」标记，让提议卡片重新可勾选 ——
      // 否则用户撤销完想改一版再应用，会发现卡片已经不能操作了
      bubbles: get().bubbles.map((b) =>
        b.resolved === 'applied' ? { ...b, resolved: undefined } : b,
      ),
      notice: '已撤销，内容恢复成修改前的样子。',
    });
  },

  reset: () =>
    set({
      bubbles: [],
      pending: false,
      draft: '',
      activeBubbleId: null,
      selected: new Set(),
      undoStack: [],
      lastApplied: null,
      notice: null,
    }),
}));

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
