import { create } from 'zustand';
import {
  deleteKnowledgeDoc,
  listKnowledgeDocs,
  newId,
  saveKnowledgeDoc,
  type KnowledgeDoc,
} from '../services/storage';
import { fetchAndExtractWebpage, type WebSearchResult } from '../services/search/webSearch';

interface KnowledgeState {
  docs: KnowledgeDoc[];
  loading: boolean;
  savingUrl: string | null;
  notice: string | null;

  refresh: (projectId?: string) => Promise<void>;
  importTextFile: (file: File, projectId?: string) => Promise<void>;
  addNote: (title: string, content: string, projectId?: string) => Promise<void>;
  saveWebResult: (item: WebSearchResult, projectId?: string) => Promise<boolean>;
  removeDoc: (id: string, projectId?: string) => Promise<void>;
  clearNotice: () => void;
}

export const useKnowledge = create<KnowledgeState>((set) => ({
  docs: [],
  loading: false,
  savingUrl: null,
  notice: null,

  clearNotice: () => set({ notice: null }),

  refresh: async (projectId) => {
    set({ loading: true });
    const docs = await listKnowledgeDocs(projectId);
    set({ docs, loading: false });
  },

  importTextFile: async (file, projectId) => {
    try {
      const text = (await file.text()).trim();
      if (!text) {
        set({ notice: `文件「${file.name}」内容为空，未导入。` });
        return;
      }
      const doc: KnowledgeDoc = {
        id: newId('kb'),
        scope: projectId ?? 'global',
        title: file.name.replace(/\.(txt|md|markdown)$/i, ''),
        content: text.slice(0, 60_000),
        sourceType: 'file',
        createdAt: new Date().toISOString(),
      };
      await saveKnowledgeDoc(doc);
      const docs = await listKnowledgeDocs(projectId);
      set({ docs, notice: `已收入资料库：「${doc.title}」（${doc.content.length} 字）。` });
    } catch (error) {
      set({
        notice: `导入失败：${error instanceof Error ? error.message : '无法读取文件'}`,
      });
    }
  },

  addNote: async (title, content, projectId) => {
    const cleanTitle = title.trim();
    const cleanContent = content.trim();
    if (!cleanTitle || !cleanContent) return;
    const doc: KnowledgeDoc = {
      id: newId('kb'),
      scope: projectId ?? 'global',
      title: cleanTitle,
      content: cleanContent.slice(0, 60_000),
      sourceType: 'note',
      createdAt: new Date().toISOString(),
    };
    await saveKnowledgeDoc(doc);
    const docs = await listKnowledgeDocs(projectId);
    set({ docs, notice: `已收入资料库：「${doc.title}」。` });
  },

  saveWebResult: async (item, projectId) => {
    set({ savingUrl: item.url, notice: null });
    try {
      const extracted = await fetchAndExtractWebpage(item.url);
      const content =
        extracted.ok && extracted.textContent.trim().length > 40
          ? extracted.textContent.trim()
          : item.snippet.trim();

      if (!content) {
        set({ savingUrl: null, notice: `没能提取「${item.title}」的正文内容。` });
        return false;
      }

      const doc: KnowledgeDoc = {
        id: newId('kb'),
        scope: projectId ?? 'global',
        title: extracted.ok && extracted.title ? extracted.title : item.title,
        content,
        sourceType: 'web',
        sourceUrl: item.url,
        createdAt: new Date().toISOString(),
      };
      await saveKnowledgeDoc(doc);
      const docs = await listKnowledgeDocs(projectId);
      set({
        docs,
        savingUrl: null,
        notice: extracted.ok
          ? `已提取网页正文并收入资料库：「${doc.title}」（${content.length} 字）。`
          : `网页正文受限，已将摘要收入资料库：「${doc.title}」。`,
      });
      return true;
    } catch {
      set({ savingUrl: null, notice: `收入「${item.title}」失败，请稍后重试。` });
      return false;
    }
  },

  removeDoc: async (id, projectId) => {
    await deleteKnowledgeDoc(id);
    const docs = await listKnowledgeDocs(projectId);
    set({ docs, notice: '已从资料库移除。' });
  },
}));
