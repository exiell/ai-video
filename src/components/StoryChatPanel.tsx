import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/app';
import { useGeneration } from '../store/generation';
import { currentLlmName } from '../services/llm/readiness';
import { GenerateBar } from './GenerateBar';
import { KnowledgePanel, SourceCards } from './ResearchWidgets';
import { Field, RichText } from './bits';
import { Icon } from './Icon';

const STORY_QUICK_STARTS = [
  '我想做一个 45 秒科普动漫：用比喻讲清楚黑洞为什么连光都逃不出去',
  '雨夜里外卖员在巷口捡到一只会说话的猫，想要个温暖的小反转',
  '古代侠客在风雪客栈里发现同桌竟是宿敌，30 秒内完成对峙与出剑',
];

/**
 * 故事页嵌入式多轮共创对话面板（Batch 1）
 *
 * 与侧边栏「问 AI」保持一致的对话交互，对话内容持久化在 project.creativeContext 中，
 * 并在后续「生成故事」「拆角色与场景」「生成镜头」时自动作为上下文注入。
 */
export function StoryChatPanel() {
  const project = useAppStore((s) => s.project);
  const sendStoryChat = useGeneration((s) => s.sendStoryChat);
  const clearStoryChat = useGeneration((s) => s.clearStoryChat);
  const setConsensusSummary = useGeneration((s) => s.setConsensusSummary);
  const storyChatPending = useGeneration((s) => s.storyChatPending);
  const storyChatError = useGeneration((s) => s.storyChatError);

  const [draft, setDraft] = useState('');
  const [useRag, setUseRag] = useState(true);
  const [useWebSearch, setUseWebSearch] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const turns = project?.creativeContext?.storyChat ?? [];
  const summary = project?.creativeContext?.consensusSummary ?? '';

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, storyChatPending]);

  if (!project) return null;

  function submit() {
    const text = draft.trim();
    if (!text || storyChatPending) return;
    setDraft('');
    void sendStoryChat(text, { useRag, useWebSearch });
  }

  return (
    <div className="story-chat-shell">
      <div className="story-chat-box">
        <div className="story-chat-head">
          <div className="row" style={{ gap: 6 }}>
            <Icon name="sparkles" size={15} />
            <b style={{ fontSize: 13 }}>故事共创对话</b>
            <span className="tag">{turns.length > 0 ? `已聊 ${turns.length} 条` : '新会话'}</span>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn btn-sm${useRag ? ' btn-primary' : ' btn-ghost'}`}
              onClick={() => setUseRag((v) => !v)}
              title="开启后自动检索资料库与内置创作知识"
            >
              资料库 {useRag ? '开' : '关'}
            </button>
            <button
              type="button"
              className={`btn btn-sm${useWebSearch ? ' btn-primary' : ' btn-ghost'}`}
              onClick={() => setUseWebSearch((v) => !v)}
              title="开启后联网检索科普或题材资料，并支持打开与收藏网页"
            >
              联网搜索 {useWebSearch ? '开' : '关'}
            </button>
            {turns.length > 0 ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={clearStoryChat}
                disabled={storyChatPending}
                title="清空共创对话"
              >
                清空对话
              </button>
            ) : null}
          </div>
        </div>

        <div className="story-chat-scroll" ref={scrollRef}>
          {turns.length === 0 ? (
            <div className="chat-empty">
              <p style={{ marginTop: 0 }}>
                先和 AI 聊清楚题材、情节反转、画面氛围或科普思路，聊完直接生成故事大纲，对话内容会自动带入后续角色、场景与分镜。
              </p>
              {STORY_QUICK_STARTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="chat-quick"
                  disabled={storyChatPending}
                  onClick={() => void sendStoryChat(prompt, { useRag, useWebSearch })}
                >
                  {prompt}
                </button>
              ))}
            </div>
          ) : null}

          {turns.map((turn) => (
            <div key={turn.id} className={`chat-bubble ${turn.role}`}>
              <div className="story-chat-text">
                <RichText>{turn.content}</RichText>
              </div>
              {turn.role === 'assistant' && (turn.webSources?.length || turn.ragCount) ? (
                <SourceCards
                  webSources={turn.webSources}
                  projectId={project.id}
                />
              ) : null}
            </div>
          ))}

          {storyChatPending ? (
            <div className="chat-bubble assistant">
              <span className="chat-typing">正在整理思路…</span>
            </div>
          ) : null}
        </div>

        {storyChatError ? (
          <div className="issue error" style={{ margin: '0 12px 10px' }}>
            <div className="issue-title">对话发送失败</div>
            <div className="issue-line">{storyChatError}</div>
          </div>
        ) : null}

        <div className="story-chat-input-wrap">
          <textarea
            className="chat-input"
            aria-label="和 AI 探讨你的故事思路"
            value={draft}
            rows={2}
            disabled={storyChatPending}
            placeholder={`说说你的想法、想拍的题材或参考风格（用 ${currentLlmName()} 对话）`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={storyChatPending || !draft.trim()}
            onClick={submit}
          >
            {storyChatPending ? '…' : '发送'}
          </button>
        </div>
      </div>

      <div className="story-chat-actions">
        <GenerateBar
          task="story"
          label={turns.length > 0 ? '根据以上对话生成故事大纲' : '让模型直接起草故事大纲'}
        />
      </div>

      <KnowledgePanel projectId={project.id} />

      <details className="card-fold" style={{ marginTop: 10 }}>
        <summary>
          <span className="card-fold-title">创作共识备忘（自动带入角色、场景与分镜）</span>
          <span className="card-fold-count">{summary.trim() ? '已填写' : '可选'}</span>
        </summary>
        <div style={{ marginTop: 8 }}>
          <Field label="想重点保留的剧情细节、角色特点或视觉偏好">
            <textarea
              rows={3}
              value={summary}
              onChange={(e) => setConsensusSummary(e.target.value)}
              placeholder="例：主角全程戴红色围巾；科普解说用黑板粉笔动画比喻；结尾留 2 秒悬念定格"
            />
          </Field>
        </div>
      </details>
    </div>
  );
}
