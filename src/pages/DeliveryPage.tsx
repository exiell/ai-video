import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { Icon } from '../components/Icon';
import { PromptsPage } from './PromptsPage';
import { ExportPage } from './ExportPage';

export type DeliveryTab = 'prompts' | 'export';

export function DeliveryPage({ initialTab = 'prompts' }: { initialTab?: DeliveryTab }) {
  const location = useLocation();
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const report = useAppStore((s) => s.report);

  const routeTab: DeliveryTab =
    location.pathname === '/export'
      ? 'export'
      : location.pathname === '/prompts'
        ? 'prompts'
        : initialTab;

  const [tab, setTab] = useState<DeliveryTab>(routeTab);

  useEffect(() => {
    setTab(routeTab);
  }, [routeTab]);

  if (!project) {
    return <div className="empty">先去作品主页打开或新建项目。</div>;
  }

  const errorCount = report?.counts.error ?? 0;

  function switchTab(next: DeliveryTab) {
    setTab(next);
    if (location.pathname === '/prompts' || location.pathname === '/export') {
      navigate(next === 'prompts' ? '/prompts' : '/export', { replace: true });
    }
  }

  return (
    <div className="workspace-hub delivery-hub">
      <header className="hub-hero">
        <h1>交付中心</h1>

        <div className="hub-tabs" role="tablist" aria-label="交付内容">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'prompts'}
            className={`hub-tab${tab === 'prompts' ? ' active' : ''}`}
            onClick={() => switchTab('prompts')}
          >
            <Icon name="terminal" size={15} />
            <span>提示词</span>
            <span className="hub-tab-badge">{project.shots.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'export'}
            className={`hub-tab${tab === 'export' ? ' active' : ''}`}
            onClick={() => switchTab('export')}
          >
            <Icon name="download" size={15} />
            <span>打包与备份</span>
          </button>
        </div>

        {errorCount > 0 ? (
          <button
            type="button"
            className="tag tag-error"
            style={{ cursor: 'pointer' }}
            onClick={() => navigate('/storyboard?qc=1')}
            title="导出前建议先修完必改项"
          >
            <Icon name="alert-triangle" size={13} />
            <span>{errorCount} 必改</span>
          </button>
        ) : (
          <div className="hub-compact-stat is-ok" title="穿帮必改项已清零">
            <Icon name="circle-check" size={14} />
            <span>可交付</span>
          </div>
        )}
      </header>

      <div className="hub-stage">
        {tab === 'prompts' ? <PromptsPage embedded /> : <ExportPage embedded />}
      </div>
    </div>
  );
}
