import { lazy, Suspense, useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { useAppStore } from './store/app';

/**
 * 路由（方案.md v0.6 §5.8）
 *
 * 用 HashRouter 而不是 BrowserRouter：纯静态托管（GitHub Pages 等）
 * 刷新子路径不会 404，不需要服务端 rewrite 规则。这与「不依赖任何服务器」一致。
 *
 * 首页同步加载（用户第一眼就要看到），其余页面懒加载——
 * 首屏只下载首屏需要的代码，符合 §5.9 的「首屏可交互 ≤ 2s」。
 */

const GuidePage = lazy(() => import('./pages/GuidePage').then((m) => ({ default: m.GuidePage })));
const StoryboardPage = lazy(() =>
  import('./pages/StoryboardPage').then((m) => ({ default: m.StoryboardPage })),
);
const ChecksPage = lazy(() =>
  import('./pages/ChecksPage').then((m) => ({ default: m.ChecksPage })),
);
const CharactersPage = lazy(() =>
  import('./pages/CharactersPage').then((m) => ({ default: m.CharactersPage })),
);
const ScenesPage = lazy(() =>
  import('./pages/ScenesPage').then((m) => ({ default: m.ScenesPage })),
);
const PromptsPage = lazy(() =>
  import('./pages/PromptsPage').then((m) => ({ default: m.PromptsPage })),
);
const ExportPage = lazy(() =>
  import('./pages/ExportPage').then((m) => ({ default: m.ExportPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const AboutPage = lazy(() => import('./pages/AboutPage').then((m) => ({ default: m.AboutPage })));
const HelpPage = lazy(() => import('./pages/HelpPage').then((m) => ({ default: m.HelpPage })));

function RouteFallback() {
  return <div className="empty">加载中…</div>;
}

export default function App() {
  const project = useAppStore((s) => s.project);
  const dirty = useAppStore((s) => s.dirty);
  const persist = useAppStore((s) => s.persist);

  /**
   * 自动保存：改动后 800ms 落盘，避免每敲一个字就写一次 IndexedDB。
   *
   * 这里的 `dirty` 与 `project` 都在依赖里，看起来像重复触发，
   * 但两者缺一不可：
   *  - `project` 保证「内容变了就重新计时」
   *  - `dirty` 保证「保存完了就不再挂计时器」
   *
   * 真正防丢改动的是 store 里的 revision 比对（见 `persist`）：
   * 保存期间若又有改动，dirty 不会被清掉，这个 effect 会再挂一次计时器。
   * 没有那一层的话，上一次保存的完成回调会把新挂的计时器清掉，
   * 那次改动就永远不落盘了。
   */
  useEffect(() => {
    if (!project || !dirty) return;
    const timer = window.setTimeout(() => {
      void persist();
    }, 800);
    return () => window.clearTimeout(timer);
  }, [project, dirty, persist]);

  return (
    <HashRouter>
      <Layout>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/guide" element={<GuidePage />} />
            <Route path="/storyboard" element={<StoryboardPage />} />
            <Route path="/checks" element={<ChecksPage />} />
            <Route path="/characters" element={<CharactersPage />} />
            <Route path="/scenes" element={<ScenesPage />} />
            <Route path="/prompts" element={<PromptsPage />} />
            <Route path="/export" element={<ExportPage />} />
            {/*
              设置拆成四个子视图（v0.38）。老地址 /settings 重定向到默认那一区，
              这样之前放在书签或文档里的链接不会失效。
            */}
            <Route path="/settings" element={<Navigate to="/settings/models" replace />} />
            <Route path="/settings/:section" element={<SettingsPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </Layout>
    </HashRouter>
  );
}
