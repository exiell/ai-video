import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { useImage } from '../store/image';
import { computeImageCoverage } from '../components/imageCoverage';
import { Icon } from '../components/Icon';
import { CharactersPage } from './CharactersPage';
import { ScenesPage } from './ScenesPage';

export type AssetsTab = 'characters' | 'scenes';

export function AssetsPage({ initialTab = 'characters' }: { initialTab?: AssetsTab }) {
  const location = useLocation();
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const gallery = useImage((s) => s.gallery);
  const loadGallery = useImage((s) => s.loadGallery);

  const routeTab: AssetsTab =
    location.pathname === '/scenes'
      ? 'scenes'
      : location.pathname === '/characters'
        ? 'characters'
        : initialTab;

  const [tab, setTab] = useState<AssetsTab>(routeTab);

  useEffect(() => {
    setTab(routeTab);
  }, [routeTab]);

  useEffect(() => {
    if (!project) return;
    for (const c of project.characters) void loadGallery(c.id);
    for (const s of project.scenes) void loadGallery(s.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (!project) {
    return <div className="empty">先去作品主页打开或新建项目。</div>;
  }

  const coverage = computeImageCoverage(project, gallery);
  const totalLocks =
    project.characters.reduce((n, c) => n + c.continuityLocks.length, 0) +
    project.scenes.reduce((n, s) => n + s.continuityLocks.length, 0);

  function switchTab(next: AssetsTab) {
    setTab(next);
    if (location.pathname === '/characters' || location.pathname === '/scenes') {
      navigate(next === 'characters' ? '/characters' : '/scenes', { replace: true });
    }
  }

  return (
    <div className="workspace-hub assets-hub">
      <header className="hub-hero">
        <h1>设定集</h1>

        <div className="hub-tabs" role="tablist" aria-label="设定集分类">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'characters'}
            className={`hub-tab${tab === 'characters' ? ' active' : ''}`}
            onClick={() => switchTab('characters')}
          >
            <Icon name="users" size={15} />
            <span>角色</span>
            <span className="hub-tab-badge">
              {coverage.charsReady}/{project.characters.length}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'scenes'}
            className={`hub-tab${tab === 'scenes' ? ' active' : ''}`}
            onClick={() => switchTab('scenes')}
          >
            <Icon name="map" size={15} />
            <span>场景</span>
            <span className="hub-tab-badge">
              {coverage.scenesReady}/{project.scenes.length}
            </span>
          </button>
        </div>

        <div className="hub-compact-stat" title="已登记的连续性锁总数">
          <Icon name="lock" size={14} />
          <span>{totalLocks} 锁</span>
        </div>
      </header>

      <div className="hub-stage">
        {tab === 'characters' ? <CharactersPage embedded /> : <ScenesPage embedded />}
      </div>
    </div>
  );
}
