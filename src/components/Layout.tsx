import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { useChat } from '../store/chat';
import { ChatSidebar } from './ChatSidebar';
import { Icon } from './Icon';

function navClass({ isActive }: { isActive: boolean }): string {
  return `nav-item${isActive ? ' active' : ''}`;
}

function fmtSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const project = useAppStore((s) => s.project);
  const report = useAppStore((s) => s.report);
  const dirty = useAppStore((s) => s.dirty);
  const saveError = useAppStore((s) => s.saveError);
  const chatOpen = useChat((s) => s.open);

  const errorCount = report?.counts.error ?? 0;
  const shotCount = project?.shots.length ?? 0;
  const assetCount = (project?.characters.length ?? 0) + (project?.scenes.length ?? 0);
  const total = project?.shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0) ?? 0;
  const storyWritten = !!project?.story.body.trim();

  const onAssets =
    location.pathname === '/assets' ||
    location.pathname === '/characters' ||
    location.pathname === '/scenes';
  const onStoryboard = location.pathname === '/storyboard' || location.pathname === '/checks';
  const onDelivery =
    location.pathname === '/delivery' ||
    location.pathname === '/prompts' ||
    location.pathname === '/export';

  const saveLabel = saveError ? '保存失败' : dirty ? '保存中…' : '已存本机';

  return (
    <div className={`app${chatOpen ? ' chat-open' : ''}`}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <Link className="brand-lockup" to="/">
          <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect
              x="2.5"
              y="4"
              width="19"
              height="16"
              rx="3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M4 16 L9 9 L13 14 L16 10 L20 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <circle cx="16.8" cy="7.6" r="1.3" fill="currentColor" />
          </svg>
          <span className="brand-text">
            <b>AniGuide</b>
          </span>
        </Link>

        {project ? (
          <Link className="project-switch" to="/" title={`${project.name} · ${shotCount} 镜 · ${fmtSeconds(total)} 秒`}>
            <b>{project.name}</b>
            <span className="project-switch-meta">
              {shotCount}镜 · {fmtSeconds(total)}s
            </span>
          </Link>
        ) : null}

        <nav className="side-nav" aria-label="主导航">
          <NavLink to="/" end className={navClass}>
            <span className="nav-label">
              <Icon name="home" className="nav-icon" />
              <span>作品主页</span>
            </span>
          </NavLink>

          {project ? (
            <>
              <NavLink to="/guide" className={navClass}>
                <span className="nav-label">
                  <Icon name="book" className="nav-icon" />
                  <span>故事</span>
                </span>
                <span className="nav-count">{storyWritten ? '已写' : '待写'}</span>
              </NavLink>
              <NavLink to="/assets" className={() => `nav-item${onAssets ? ' active' : ''}`}>
                <span className="nav-label">
                  <Icon name="users" className="nav-icon" />
                  <span>设定集</span>
                </span>
                <span className="nav-count">{assetCount}</span>
              </NavLink>
              <NavLink to="/storyboard" className={() => `nav-item${onStoryboard ? ' active' : ''}`}>
                <span className="nav-label">
                  <Icon name="layout-grid" className="nav-icon" />
                  <span>分镜与质检</span>
                </span>
                {errorCount > 0 ? (
                  <span className="nav-count nav-count-danger" title={`${errorCount} 个必改项`}>
                    {shotCount} · {errorCount}
                  </span>
                ) : (
                  <span className="nav-count">{shotCount}</span>
                )}
              </NavLink>
              <NavLink to="/delivery" className={() => `nav-item${onDelivery ? ' active' : ''}`}>
                <span className="nav-label">
                  <Icon name="download" className="nav-icon" />
                  <span>交付中心</span>
                </span>
              </NavLink>
            </>
          ) : null}
        </nav>

        <nav className="side-nav side-nav-utility" aria-label="工具">
          <NavLink
            to="/help"
            className={({ isActive }) => `nav-item nav-icon-only${isActive ? ' active' : ''}`}
            title="帮助与术语"
            aria-label="帮助与术语"
          >
            <Icon name="help" className="nav-icon" />
          </NavLink>
          <NavLink
            to="/settings/models"
            className={({ isActive }) => `nav-item nav-icon-only${isActive ? ' active' : ''}`}
            title="设置"
            aria-label="设置"
          >
            <Icon name="settings" className="nav-icon" />
          </NavLink>
          <NavLink
            to="/about"
            className={({ isActive }) => `nav-item nav-icon-only${isActive ? ' active' : ''}`}
            title="关于"
            aria-label="关于"
          >
            <Icon name="file-text" className="nav-icon" />
          </NavLink>
        </nav>

        {project ? (
          <div className="sidebar-foot">
            <Link
              to="/export"
              className={`save-pill${saveError ? ' bad' : dirty ? ' saving' : ''}`}
              title={saveError ? `保存失败：${saveError}` : saveLabel}
              aria-label={saveLabel}
            >
              <Icon name="device-floppy" size={14} />
              <span className="save-dot" aria-hidden="true" />
            </Link>
          </div>
        ) : null}
      </aside>

      <main className="main" id="main-content" tabIndex={-1}>
        {children}
      </main>

      <ChatSidebar />
    </div>
  );
}
