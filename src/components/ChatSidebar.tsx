import { useEffect, useRef, useState } from 'react';
import { useChat, type ChatBubble } from '../store/chat';
import { useAppStore } from '../store/app';
import { useImage } from '../store/image';
import { assessStyleChange } from '../domain/help/styleChange';
import { fieldLabel, type ChatEditProposal } from '../domain/chat/edits';
import { currentLlmName } from '../services/llm/readiness';
import { ConfirmDialog, RichText } from './bits';
import type { Project } from '../types/model';

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
      {/*
        收起/展开按钮必须**一直在**，而且两种状态下都点得到。

        踩过的坑：第一版把按钮绝对定位到 `left: -30px`（面板外面），
        而面板是 `overflow: hidden` —— 展开时按钮被裁掉，**用户没有收起入口**，
        只能刷新页面。收起时之所以看得见，是因为我给收起态单独设了
        `overflow: visible`。也就是说「能用」纯属巧合，换个状态就废了。

        现在改成 flex 布局：按钮在面板内部，不依赖任何溢出行为。
      */}
      <button
        type="button"
        className="chat-toggle"
        onClick={toggle}
        title={open ? '收起对话栏' : '展开对话栏'}
        aria-label={open ? '收起对话栏' : '展开对话栏'}
        aria-expanded={open}
      >
        <span className="chat-toggle-icon">{open ? '›' : '‹'}</span>
        {!open ? <span className="chat-toggle-label">AI</span> : null}
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
                  它先说出自己的理解，<b>你确认了才会改</b>。试试：
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
                  : '先去「作品主页」打开一个项目'
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

/**
 * 一批改动的审阅区。
 *
 * ===========================================================================
 * 为什么要按对象分组、且可折叠
 * ===========================================================================
 * 改情节时一次可能有二十几条改动。平铺成二十几张卡片有兩個问题：
 *  - 用户根本读不完，只会直接点「全选 → 应用」，确认就失去意义了
 *  - 看不出「这些改动之间的关系」—— 第 3~7 镜是一组连贯的调整，
 *    平铺会把这个整体感打散
 *
 * 所以按对象分组、组内可折叠、组头给一行摘要。
 * 用户先看规模（改了几个镜头、有没有删除），再决定要不要逐条细看。
 */
function EditBatch({ bubble, isActive }: { bubble: ChatBubble; isActive: boolean }) {
  const selected = useChat((s) => s.selected);
  const edits = bubble.edits ?? [];

  const groups = groupEdits(edits);
  const deletes = edits.filter((e) => e.op === 'delete').length;
  const creates = edits.filter((e) => e.op === 'create').length;
  const checkedCount = edits.filter((e) => selected.has(e.id)).length;

  /**
   * 这一批里**勾选了的**改动中有没有改风格。
   *
   * 只算勾选的：用户把那条取消勾选之后，就不该再为它弹窗。
   */
  const styleEdit = edits.find(
    (e) =>
      selected.has(e.id) &&
      e.op === 'set' &&
      e.target.kind === 'brief' &&
      (e.target.field === 'styleTags' || e.target.field === 'styleTone'),
  );

  return (
    <div className="chat-edits">
      <div className="chat-edits-head">
        <b>
          建议改动 {edits.length} 处
          {bubble.resolved === 'applied' ? '（已应用）' : ''}
          {bubble.resolved === 'discarded' ? '（已放弃）' : ''}
        </b>
        {isActive ? (
          <span className="hint" style={{ marginTop: 0 }}>
            已勾选 {checkedCount}/{edits.length}
          </span>
        ) : null}
      </div>

      {/*
        规模摘要：让用户先判断「这次改动有多大」再决定要不要细看。
        删除单独标出来，因为它比改字段重得多。
      */}
      <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
        {/*
          注意： 这里的文案必须走 RichText —— JSX 不解析 Markdown。
          我自己在这里犯过一次「写了 ** 却没包 RichText」的错，
          结果是用户看到字面的星号。测试里有专门一条守这个。
        */}
        <RichText>
          {`涉及 ${groups.length} 个对象` +
            (creates > 0 ? `｜新增 ${creates} 个` : '') +
            (deletes > 0 ? `｜**删除 ${deletes} 个**` : '') +
            (isActive ? '｜应用后可整体撤销' : '')}
        </RichText>
      </div>

      {bubble.gateWhy && isActive ? (
        <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
          {bubble.gateWhy}
        </div>
      ) : null}

      {groups.map((group) => (
        <EditGroup key={group.key} group={group} isActive={isActive} />
      ))}

      {isActive ? (
        <div className="row" style={{ marginTop: 8 }}>
          <ApplyButton guardStyle={Boolean(styleEdit)} />
          <DiscardButton />
        </div>
      ) : null}
    </div>
  );
}

/**
 * 「应用勾选的改动」。
 *
 * 这一批里如果含改风格，先弹确认：
 * 风格词会进每一张图的提示词，在已经做出内容之后换掉它，
 * 已生成的图会变成旧风格、角色描述的措辞也可能对不上新风格。
 *
 * 卡片上只留一行「这条会改风格」的标记；完整的风险与操作顺序放在弹窗里。
 * 原因：卡片是逐条看的，长文案会把它撑开、反而没人看；而弹窗出现在
 * 「即将生效」这一刻，正是需要停下来想一想的时刻。
 */
function ApplyButton({ guardStyle }: { guardStyle: boolean }) {
  const applySelected = useChat((s) => s.applySelected);
  const project = useAppStore((s) => s.project);
  const assetCount = useImage((s) => s.assetCount);
  const [confirming, setConfirming] = useState(false);

  const impact = guardStyle
    ? assessStyleChange({
        characters: project?.characters.length ?? 0,
        scenes: project?.scenes.length ?? 0,
        shots: project?.shots.length ?? 0,
        imageCount: assetCount,
      })
    : null;

  return (
    <>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => {
          if (impact?.needed) setConfirming(true);
          else applySelected();
        }}
      >
        应用勾选的改动
      </button>

      <ConfirmDialog
        open={confirming}
        title="这一批改动会换掉全片风格"
        confirmLabel="我明白，应用"
        cancelLabel="先不应用"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          applySelected();
        }}
      >
        <div>
          你的项目里已经有
          {[
            project?.characters.length ? `${project.characters.length} 个角色` : '',
            project?.scenes.length ? `${project.scenes.length} 个场景` : '',
            project?.shots.length ? `${project.shots.length} 个镜头` : '',
            assetCount > 0 ? `${assetCount} 张图` : '',
          ]
            .filter(Boolean)
            .join('、')}
          。换成新风格之后：
        </div>
        <ul>
          {(impact?.risks ?? []).map((risk, i) => (
            <li key={i}>
              <RichText>{risk}</RichText>
            </li>
          ))}
        </ul>
        <div style={{ marginTop: 12, color: 'var(--text)' }}>要改的话，按这个顺序：</div>
        <ol>
          {(impact?.steps ?? []).map((step, i) => (
            <li key={i}>
              <RichText>{step}</RichText>
            </li>
          ))}
        </ol>
      </ConfirmDialog>
    </>
  );
}

function DiscardButton() {
  const discardActive = useChat((s) => s.discardActive);
  return (
    <button type="button" className="btn btn-sm" onClick={discardActive}>
      都不要
    </button>
  );
}

/** 一个对象下的一组改动。超过 3 条时默认折叠，避免一屏铺满。 */
function EditGroup({ group, isActive }: { group: EditGroupData; isActive: boolean }) {
  const selected = useChat((s) => s.selected);
  const checked = group.edits.filter((e) => selected.has(e.id)).length;
  const collapsible = group.edits.length > 3;

  const body = (
    <>
      {group.edits.map((edit) => (
        <EditCard key={edit.id} edit={edit} isActive={isActive} />
      ))}
    </>
  );

  return (
    <div className="chat-group">
      <div className="chat-group-head">
        <b>{group.label}</b>
        <span className="hint" style={{ marginTop: 0 }}>
          {group.edits.length} 处
          {isActive ? `（已勾选 ${checked}）` : ''}
        </span>
      </div>
      {collapsible ? (
        <details className="why">
          <summary>展开看这 {group.edits.length} 处具体改什么</summary>
          <div className="why-body">{body}</div>
        </details>
      ) : (
        body
      )}
    </div>
  );
}

/** 单条改动。三种操作外观不同：改=前后对照，新增=预览，删除=警示 */
function EditCard({ edit, isActive }: { edit: ChatEditProposal; isActive: boolean }) {
  const selected = useChat((s) => s.selected);
  const toggleEdit = useChat((s) => s.toggleEdit);
  const project = useAppStore((s) => s.project);
  const assetCount = useImage((s) => s.assetCount);
  const checked = selected.has(edit.id);
  const isDelete = edit.op === 'delete';

  /**
   * 这条提议是不是在改风格？
   *
   * 「问 AI」是改风格的第三条路径（前两条是手动改和点预设）。
   * 用户可能只说「换成水墨风」，模型就会提议改 `brief.styleTags`——
   * 而这一条同样会让已生成的图失效。风险提示必须跟他手动改时一样。
   */
  const touchesStyle =
    edit.op === 'set' &&
    edit.target.kind === 'brief' &&
    (edit.target.field === 'styleTags' || edit.target.field === 'styleTone');
  const styleImpact = touchesStyle
    ? assessStyleChange({
        characters: project?.characters.length ?? 0,
        scenes: project?.scenes.length ?? 0,
        shots: project?.shots.length ?? 0,
        imageCount: assetCount,
      })
    : null;

  return (
    <label
      className={`chat-edit${isActive && checked ? ' checked' : ''}${isDelete ? ' chat-edit-danger' : ''}`}
    >
      <input
        type="checkbox"
        checked={isActive && checked}
        disabled={!isActive}
        onChange={() => toggleEdit(edit.id)}
        style={{ marginTop: 3, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 12.5 }}>
          {edit.op === 'create' ? '＋ ' : isDelete ? '－ ' : ''}
          {edit.title}
        </div>
        <div className="hint" style={{ marginTop: 2 }}>
          {whereLabel(edit)}
        </div>

        {/*
          三种操作显示方式不同：
          - 改：前后对照（这是判断「改得对不对」的唯一依据）
          - 新增：只显示要加进去的内容
          - 删除：显示会被删掉的是什么，并明确警示
        */}
        {edit.op === 'set' ? (
          <div className="chat-diff">
            <div className="chat-diff-row">
              <span className="chat-diff-tag before">改前</span>
              <span className="chat-diff-text before">
                {/*
                  「改前」必须用**提议生成时**的快照，不能从当前项目重读。
                  原实现是从 project 里读的，而应用之后项目已经变了 ——
                  两栏显示同一个值，用户完全没法判断动了什么。
                */}
                {edit.beforeAtProposal || edit.before || <i>（原本是空的）</i>}
              </span>
            </div>
            <div className="chat-diff-row">
              <span className="chat-diff-tag after">改后</span>
              <span className="chat-diff-text after">{edit.after}</span>
            </div>
          </div>
        ) : (
          <div className={`chat-diff${isDelete ? ' chat-diff-danger' : ''}`}>
            <div className="chat-diff-row">
              <span className="chat-diff-tag before">{isDelete ? '将删除' : '将新增'}</span>
              <span className={`chat-diff-text ${isDelete ? 'before' : 'after'}`}>
                {isDelete ? edit.before : edit.after}
              </span>
            </div>
          </div>
        )}

        {edit.reason ? (
          <div className="hint" style={{ marginTop: 4 }}>
            {edit.reason}
          </div>
        ) : null}
        {/*
          只留一行标记（v0.42）。

          完整的风险与操作顺序放在「应用勾选的改动」那一刻的弹窗里：
          卡片是逐条看的，把四五段话塞进来会把它撑开，反而没人读。
          但也不能什么都不显示 —— 用户得先知道这条和别的条不一样。
        */}
        {styleImpact?.needed ? (
          <div className="hint" style={{ marginTop: 6, color: 'var(--warning)' }}>
            这条会换掉全片风格 —— 应用时会再确认一次，并告诉你该按什么顺序重做。
          </div>
        ) : null}

        {edit.sideEffect ? (
          <div className="hint" style={{ marginTop: 2, color: 'var(--warning)' }}>
            副作用：{edit.sideEffect}
          </div>
        ) : null}
        {isDelete && !edit.sideEffect ? (
          <div className="hint" style={{ marginTop: 2, color: 'var(--warning)' }}>
            删除比改字段重，请确认这一条确实该删。
          </div>
        ) : null}
      </div>
    </label>
  );
}

interface EditGroupData {
  key: string;
  label: string;
  edits: ChatEditProposal[];
}

/**
 * 把一批改动按对象分组，并排好顺序。
 *
 * 顺序规则刻意固定：**新增 → 修改 → 删除**，组内按镜头顺序。
 * 不按模型给的顺序原样排 —— 那样用户读起来是乱的，
 * 也看不出「先加了角色、再改镜头、最后删掉多余的一镜」这个逻辑。
 */
function groupEdits(edits: ChatEditProposal[]): EditGroupData[] {
  const project = useAppStore.getState().project;
  const byKey = new Map<string, EditGroupData>();

  for (const edit of edits) {
    const { kind, id } = edit.target;
    // 新建时还没有 id，用「新增的角色」这一类作为分组键
    const key = edit.op === 'create' ? `create:${kind}` : `${kind}:${id ?? ''}`;
    if (!byKey.has(key)) {
      byKey.set(key, { key, label: groupLabel(edit, project), edits: [] });
    }
    byKey.get(key)!.edits.push(edit);
  }

  const opRank = (e: ChatEditProposal): number => (e.op === 'create' ? 0 : e.op === 'set' ? 1 : 2);

  return [...byKey.values()].sort((a, b) => {
    const ra = Math.min(...a.edits.map(opRank));
    const rb = Math.min(...b.edits.map(opRank));
    if (ra !== rb) return ra - rb;
    return a.label.localeCompare(b.label, 'zh');
  });
}

function groupLabel(edit: ChatEditProposal, project: Project | null): string {
  const { kind, id } = edit.target;
  if (edit.op === 'create') {
    return kind === 'character' ? '新增角色' : kind === 'scene' ? '新增场景' : '新增镜头';
  }
  if (kind === 'shot') {
    const shot = project?.shots.find((x) => x.id === id);
    return `第 ${shot?.number ?? '?'} 镜`;
  }
  if (kind === 'character') {
    return `角色「${project?.characters.find((x) => x.id === id)?.name ?? '?'}」`;
  }
  if (kind === 'scene') {
    return `场景「${project?.scenes.find((x) => x.id === id)?.name ?? '?'}」`;
  }
  if (kind === 'story') return '故事';
  return '整体规格';
}

function Bubble({ bubble }: { bubble: ChatBubble }) {
  const activeBubbleId = useChat((s) => s.activeBubbleId);

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

      {edits.length > 0 ? <EditBatch bubble={bubble} isActive={isActive} /> : null}
    </div>
  );
}

/** 「改的是：第 3 镜 · 动作」 */
function whereLabel(edit: ChatEditProposal): string {
  const project = useAppStore.getState().project;
  const { kind, id, field } = edit.target;

  // 新建与删除没有「字段」这个概念，说法也不一样
  if (edit.op === 'create') {
    return kind === 'character' ? '新增一个角色' : kind === 'scene' ? '新增一个场景' : '新增一个镜头';
  }
  if (edit.op === 'delete') {
    if (kind === 'character') {
      const c = project?.characters.find((x) => x.id === id);
      return `删除角色「${c?.name ?? '?'}」`;
    }
    if (kind === 'scene') {
      const sc = project?.scenes.find((x) => x.id === id);
      return `删除场景「${sc?.name ?? '?'}」`;
    }
    const sh = project?.shots.find((x) => x.id === id);
    return `删除第 ${sh?.number ?? '?'} 镜`;
  }

  const what = field ? fieldLabel(kind, field) : '内容';

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


