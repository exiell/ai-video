import { useEffect, useRef, useState } from 'react';
import { useChat, type ChatBubble } from '../store/chat';
import { useAppStore } from '../store/app';
import { fieldLabel, readField, type ChatEditProposal } from '../domain/chat/edits';
import { currentLlmName } from '../services/llm/readiness';
import { RichText } from './bits';

/**
 * 对话式改稿侧栏（方案.md §7.6.20）
 *
 * ===========================================================================
 * 为什么要有它
 * ===========================================================================
 * 表格填不动是这个工具最大的劝退点。「起点 / 动作 / 终点 / 机位 / 运镜 /
 * 台词 / 声音 / 情绪 / 衔接说明」——对做过分镜的人是常识，对新手是一堵墙。
 *
 * 而新手真正的表达方式是**说需求**：「第三镜太闷了」「主角看起来不够狠」。
 * 他不需要知道那对应哪个字段，也不该被迫去学。
 *
 * ===========================================================================
 * 交互上刻意做对的几件事
 * ===========================================================================
 * 1. **提议默认全选。** 用户想要的是这些修改，让他取消掉不要的几条，
 *    比让他逐条勾上要的省事得多。
 * 2. **每条都摊开「改前 / 改后」。** 不能只给结论 —— 他得能判断这个改动对不对。
 * 3. **确认后能撤销。** 改动是他的作品，必须留退路。
 * 4. **被挡掉的提议要说出来。** 模型可能给了 5 条而只有 3 条能应用，
 *    静默丢弃会让用户以为都改了。
 */

const QUICK_ASKS = [
  '第三镜太平了，怎么改得更紧张？',
  '主角看起来不够狠，帮我改改。',
  '整体节奏是不是太快了？',
  '有哪些地方可能出穿帮？',
];

export function ChatSidebar() {
  const open = useChat((s) => s.open);
  const toggle = useChat((s) => s.toggle);
  const bubbles = useChat((s) => s.bubbles);
  const pending = useChat((s) => s.pending);
  const draft = useChat((s) => s.draft);
  const setDraft = useChat((s) => s.setDraft);
  const ask = useChat((s) => s.ask);
  const notice = useChat((s) => s.notice);
  const clearNotice = useChat((s) => s.clearNotice);
  const undoStack = useChat((s) => s.undoStack);
  const lastApplied = useChat((s) => s.lastApplied);
  const undo = useChat((s) => s.undo);
  const reset = useChat((s) => s.reset);

  const project = useAppStore((s) => s.project);
  const [inputFocused, setInputFocused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新消息进来自动滚到底部，否则用户以为没反应
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bubbles.length, pending]);

  function submit() {
    if (!draft.trim() || pending) return;
    void ask(draft);
  }

  return (
    <aside className={`chat-panel${open ? '' : ' collapsed'}`}>
      <button
        type="button"
        className="chat-toggle"
        onClick={toggle}
        title={open ? '收起对话栏' : '展开对话栏'}
        aria-expanded={open}
      >
        <span className="chat-toggle-icon">{open ? '›' : '‹'}</span>
        {!open ? <span className="chat-toggle-label">问 AI</span> : null}
      </button>

      {open ? (
        <div className="chat-body">
          <div className="chat-head">
            <div>
              <b style={{ fontSize: 13 }}>问 AI 怎么改</b>
              <div className="hint" style={{ marginTop: 2 }}>
                用大白话说你想改什么，它给建议，你点头才改。
              </div>
            </div>
            {bubbles.length > 0 ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={reset}
                title="清空这次对话（不会改项目内容）"
              >
                清空
              </button>
            ) : null}
          </div>

          <div className="chat-scroll" ref={scrollRef}>
            {bubbles.length === 0 ? (
              <div className="chat-empty">
                <p style={{ marginTop: 0 }}>
                  不知道该怎么说？可以试试下面这些。它会先告诉你它的理解，
                  再给出具体要改哪些字，<b>你确认了才会改</b>。
                </p>
                {QUICK_ASKS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="chat-quick"
                    onClick={() => void ask(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            ) : null}

            {bubbles.map((b) => (
              <Bubble key={b.id} bubble={b} />
            ))}

            {pending ? (
              <div className="chat-bubble assistant">
                <span className="chat-typing">正在看你的分镜…</span>
              </div>
            ) : null}
          </div>

          {notice ? (
            <div className="chat-notice">
              <span>
                {lastApplied?.gate === 'auto' ? (
                  <b className="chat-auto-tag" title={lastApplied.why}>
                    已自动应用
                  </b>
                ) : null}
                {notice}
              </span>
              {undoStack.length > 0 ? (
                <button type="button" className="btn btn-sm" onClick={undo}>
                  撤销这次修改
                </button>
              ) : null}
              <button type="button" className="btn btn-ghost btn-sm" onClick={clearNotice}>
                知道了
              </button>
            </div>
          ) : null}

          <div className="chat-input-wrap">
            <textarea
              className="chat-input"
              value={draft}
              placeholder={
                project
                  ? `例如：第 3 镜太闷了，能不能更紧张一点？（用 ${currentLlmName()} 回答）`
                  : '先去「项目」页打开一个项目'
              }
              disabled={!project || pending}
              rows={inputFocused || draft.length > 40 ? 3 : 2}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={(e) => {
                // Enter 发送，Shift+Enter 换行 —— 聊天框的通用习惯
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!project || pending || !draft.trim()}
              onClick={submit}
            >
              {pending ? '…' : '发送'}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 6, textAlign: 'center' }}>
            对话内容不会保存，刷新就没了（项目内容照常保存）
          </div>
        </div>
      ) : null}
    </aside>
  );
}

// ---------------------------------------------------------------------------

function Bubble({ bubble }: { bubble: ChatBubble }) {
  const activeBubbleId = useChat((s) => s.activeBubbleId);
  const selected = useChat((s) => s.selected);
  const toggleEdit = useChat((s) => s.toggleEdit);
  const applySelected = useChat((s) => s.applySelected);
  const discardActive = useChat((s) => s.discardActive);
  const project = useAppStore((s) => s.project);

  if (bubble.role === 'user') {
    return (
      <div className="chat-bubble user">
        <RichText>{bubble.content}</RichText>
      </div>
    );
  }

  if (bubble.error) {
    return (
      <div className="chat-bubble assistant">
        <div className="issue error" style={{ margin: 0 }}>
          <div className="issue-title">没能回答</div>
          <div className="issue-line">{bubble.error}</div>
          {bubble.detail ? (
            <details className="why">
              <summary>技术细节</summary>
              <div className="why-body">
                <pre>{bubble.detail}</pre>
              </div>
            </details>
          ) : null}
        </div>
      </div>
    );
  }

  const isActive = bubble.id === activeBubbleId;
  const edits = bubble.edits ?? [];

  return (
    <div className="chat-bubble assistant">
      {bubble.content ? <RichText>{bubble.content}</RichText> : null}

      {bubble.rejected && bubble.rejected > 0 ? (
        <div className="hint" style={{ marginTop: 6, color: 'var(--warning)' }}>
          有 {bubble.rejected} 条建议没法自动应用（{bubble.rejectedReasons?.join('；')}）——
          这些需要在界面上手动改。
        </div>
      ) : null}

      {edits.length > 0 ? (
        <div className="chat-edits">
          <div className="chat-edits-head">
            <b>
              建议改 {edits.length} 处
              {bubble.resolved === 'applied' ? '（已应用）' : ''}
              {bubble.resolved === 'discarded' ? '（已放弃）' : ''}
            </b>
            {isActive ? (
              <span className="hint" style={{ marginTop: 0 }}>
                已勾选 {edits.filter((e) => selected.has(e.id)).length}/{edits.length}
              </span>
            ) : null}
          </div>

          {/*
            确认文案的第四栏：「怎么撤销」。
            调研里的公开数据是——用户对权限确认的批准率高达 93%，
            大多数人不会细看。所以**必须让他知道这一步是可逆的**，
            否则他只有两个选择：盲目相信，或者全部拒绝。两条路都不好。
          */}
          {isActive ? (
            <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
              应用后这一批改动**可以整体撤销**，不会动到别的镜头。
            </div>
          ) : null}

          {edits.map((edit) => {
            const checked = selected.has(edit.id);
            const before = project ? readField(project, edit.target) : '';
            return (
              <label
                key={edit.id}
                className={`chat-edit${isActive && checked ? ' checked' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={isActive && checked}
                  disabled={!isActive}
                  onChange={() => toggleEdit(edit.id)}
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 12.5 }}>{edit.title}</div>
                  <div className="hint" style={{ marginTop: 2 }}>
                    改的是：{whereLabel(edit)}
                  </div>
                  <div className="chat-diff">
                    <div className="chat-diff-row">
                      <span className="chat-diff-tag before">改前</span>
                      <span className="chat-diff-text before">
                        {before || <i>（原本是空的）</i>}
                      </span>
                    </div>
                    <div className="chat-diff-row">
                      <span className="chat-diff-tag after">改后</span>
                      <span className="chat-diff-text after">{edit.after}</span>
                    </div>
                  </div>
                  {edit.reason ? (
                    <div className="hint" style={{ marginTop: 4 }}>
                      {edit.reason}
                    </div>
                  ) : null}
                  {edit.sideEffect ? (
                    <div className="hint" style={{ marginTop: 2, color: 'var(--warning)' }}>
                      副作用：{edit.sideEffect}
                    </div>
                  ) : null}
                </div>
              </label>
            );
          })}

          {isActive ? (
            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={applySelected}>
                应用勾选的修改
              </button>
              <button type="button" className="btn btn-sm" onClick={discardActive}>
                都不要
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 「改的是：第 3 镜 · 动作」 */
function whereLabel(edit: ChatEditProposal): string {
  const project = useAppStore.getState().project;
  const { kind, id, field } = edit.target;
  const what = fieldLabel(kind, field);

  if (!project) return what;
  if (kind === 'shot') {
    const shot = project.shots.find((s) => s.id === id);
    return `第 ${shot?.number ?? '?'} 镜 · ${what}`;
  }
  if (kind === 'character') {
    const c = project.characters.find((x) => x.id === id);
    return `角色「${c?.name ?? '?'}」· ${what}`;
  }
  if (kind === 'scene') {
    const s = project.scenes.find((x) => x.id === id);
    return `场景「${s?.name ?? '?'}」· ${what}`;
  }
  if (kind === 'story') return `故事 · ${what}`;
  return `整体规格 · ${what}`;
}
