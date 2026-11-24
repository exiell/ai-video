import { useEffect, useRef } from 'react';
import { openExternalUrl } from '../platform';
import { useKnowledge } from '../store/knowledge';
import type { WebSearchResult } from '../services/search/webSearch';
import type { RagHit } from '../services/rag';

/**
 * AI 回复下方的参考来源卡片：
 * - 点击网页标题直接用系统默认浏览器 / 新标签页打开；
 * - 点击「收入资料库」经 @mozilla/readability 提取正文并存入本机 Dexie 资料库。
 */
export function SourceCards({
  webSources,
  ragSources,
  projectId,
  warning,
}: {
  webSources?: WebSearchResult[];
  ragSources?: RagHit[];
  projectId?: string;
  warning?: string;
}) {
  const saveWebResult = useKnowledge((s) => s.saveWebResult);
  const savingUrl = useKnowledge((s) => s.savingUrl);
  const docs = useKnowledge((s) => s.docs);

  const hasWeb = (webSources?.length ?? 0) > 0;
  const hasRag = (ragSources?.length ?? 0) > 0;
  if (!hasWeb && !hasRag && !warning) return null;

  const savedUrls = new Set(docs.map((d) => d.sourceUrl).filter(Boolean));

  return (
    <div className="source-cards">
      {warning ? <div className="source-warning">{warning}</div> : null}

      {hasRag ? (
        <div className="source-rag-row">
          <span className="source-section-label">资料库引用</span>
          <div className="source-tag-list">
            {ragSources!.map((hit) => (
              <span key={hit.id} className="tag" title={hit.snippet}>
                {hit.title}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {hasWeb ? (
        <div className="source-web-list">
          <span className="source-section-label">联网参考网页</span>
          {webSources!.map((item) => {
            const alreadySaved = savedUrls.has(item.url);
            const isSaving = savingUrl === item.url;
            return (
              <div key={item.url} className="source-web-item">
                <button
                  type="button"
                  className="source-web-link"
                  title={`打开网页：${item.url}`}
                  onClick={() => void openExternalUrl(item.url)}
                >
                  <span className="source-web-title">{item.title}</span>
                  <span className="source-web-domain">{item.domain || item.url}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={alreadySaved || isSaving}
                  onClick={() => void saveWebResult(item, projectId)}
                >
                  {isSaving ? '收集中…' : alreadySaved ? '已入库' : '收入资料库'}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 本地 RAG 资料库管理折叠面板：支持导入 .txt / .md 文件、查看已收藏网页与删除。
 */
export function KnowledgePanel({ projectId }: { projectId?: string }) {
  const docs = useKnowledge((s) => s.docs);
  const refresh = useKnowledge((s) => s.refresh);
  const importTextFile = useKnowledge((s) => s.importTextFile);
  const removeDoc = useKnowledge((s) => s.removeDoc);
  const notice = useKnowledge((s) => s.notice);
  const clearNotice = useKnowledge((s) => s.clearNotice);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refresh(projectId);
  }, [refresh, projectId]);

  return (
    <details className="card-fold kb-panel">
      <summary>
        <span className="card-fold-title">参考资料库（RAG）</span>
        <span className="card-fold-count">
          {docs.length > 0 ? `${docs.length} 份自建 + 内置知识` : '内置知识已就绪'}
        </span>
      </summary>
      <div className="kb-body">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
          <span className="hint" style={{ margin: 0 }}>
            支持导入 .txt / .md 资料，或在联网搜索结果中点「收入资料库」。
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => fileInputRef.current?.click()}
          >
            导入本地资料
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importTextFile(file, projectId);
              e.target.value = '';
            }}
          />
        </div>

        {notice ? (
          <div className="kb-notice">
            <span>{notice}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={clearNotice}>
              知道了
            </button>
          </div>
        ) : null}

        {docs.length > 0 ? (
          <div className="kb-list">
            {docs.map((doc) => (
              <div key={doc.id} className="kb-item">
                <div className="kb-item-main">
                  <span className="kb-item-title">{doc.title}</span>
                  <span className="kb-item-meta">
                    {doc.sourceType === 'web' ? '网页' : doc.sourceType === 'file' ? '文件' : '笔记'} ·{' '}
                    {doc.content.length} 字
                  </span>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  {doc.sourceUrl ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void openExternalUrl(doc.sourceUrl!)}
                    >
                      打开
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void removeDoc(doc.id, projectId)}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
