import { lazy, Suspense, useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { useAppStore } from './store/app';

/**
 * 路由（方案.md v0.6 §5.8）
 *
 * 用 HashRouter 而不是 BrowserRouter：纯静态托管（GitHub Pages 等）
 * 刷新子路径不会 404，不需要服务端 rewrite 规则。
 *
 * 重构后的 5 阶段主路由：/（主页）→ /guide（故事）→ /assets（设定集）
 * → /storyboard（分镜与质检）→ /delivery（交付中心）。
 * 原有 /characters、/scenes、/checks、/prompts、/export 全部保留兼容。
 */

const GuidePage = lazy(() => import('./pages/GuidePage').then((m) => ({ default: m.GuidePage })));
const AssetsPage = lazy(() =>
  import('./pages/AssetsPage').then((m) => ({ default: m.AssetsPage })),
);
const StoryboardPage = lazy(() =>
  import('./pages/StoryboardPage').then((m) => ({ default: m.StoryboardPage })),
);
const ChecksPage = lazy(() =>
  import('./pages/ChecksPage').then((m) => ({ default: m.ChecksPage })),
);
const DeliveryPage = lazy(() =>
  import('./pages/DeliveryPage').then((m) => ({ default: m.DeliveryPage })),
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
            <Route path="/assets" element={<AssetsPage initialTab="characters" />} />
            <Route path="/characters" element={<AssetsPage initialTab="characters" />} />
            <Route path="/scenes" element={<AssetsPage initialTab="scenes" />} />
            <Route path="/storyboard" element={<StoryboardPage />} />
            <Route path="/checks" element={<ChecksPage />} />
            <Route path="/delivery" element={<DeliveryPage initialTab="prompts" />} />
            <Route path="/prompts" element={<DeliveryPage initialTab="prompts" />} />
            <Route path="/export" element={<DeliveryPage initialTab="export" />} />
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
