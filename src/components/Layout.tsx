import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { useChat } from '../store/chat';
import { isDesktopApp } from '../platform';
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
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const report = useAppStore((s) => s.report);
  const dirty = useAppStore((s) => s.dirty);
  const saveError = useAppStore((s) => s.saveError);
  const persist = useAppStore((s) => s.persist);
  const chatOpen = useChat((s) => s.open);
  const setChatOpen = useChat((s) => s.setOpen);
  const desktop = isDesktopApp();

  // 桌面端快捷键：Ctrl/Cmd+S 立即保存、Ctrl/Cmd+, 打开设置、Ctrl/Cmd+\ 切换 AI 助手、Ctrl/Cmd+E 去交付中心
  useEffect(() => {
    if (!desktop) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        if (project) void persist();
      } else if (key === ',') {
        event.preventDefault();
        navigate('/settings/models');
      } else if (key === '\\') {
        event.preventDefault();
        setChatOpen(!chatOpen);
      } else if (key === 'e' && project) {
        event.preventDefault();
        navigate('/delivery');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [desktop, project, persist, navigate, chatOpen, setChatOpen]);

  const errorCount = report?.counts.error ?? 0;
  const shotCount = project?.shots.length ?? 0;
  const assetCount =
    (project?.characters.length ?? 0) +
    (project?.scenes.length ?? 0) +
    (project?.visualAssets?.length ?? 0);
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
      {desktop ? (
        <div className="desktop-drag-strip" aria-hidden="true">
          AniGuide{project ? ` · ${project.name}` : ''}
        </div>
      ) : null}
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <Link className="brand-lockup" to="/">
          <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
            <defs>
              <linearGradient id="aniguide-brand-grad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="52%" stopColor="#818cf8" />
                <stop offset="100%" stopColor="#f472b6" />
              </linearGradient>
            </defs>
            {/* 分镜取景框四角 */}
            <path
              d="M3.5 8.2V5.5C3.5 4.4 4.4 3.5 5.5 3.5H8.2M15.8 3.5H18.5C19.6 3.5 20.5 4.4 20.5 5.5V8.2M20.5 15.8V18.5C20.5 19.6 19.6 20.5 18.5 20.5H15.8M8.2 20.5H5.5C4.4 20.5 3.5 19.6 3.5 18.5V15.8"
              fill="none"
              stroke="url(#aniguide-brand-grad)"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
            {/* 中心棱镜播放三角 */}
            <path
              d="M9 8.2L15.6 12L9 15.8Z"
              fill="url(#aniguide-brand-grad)"
              stroke="url(#aniguide-brand-grad)"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            {/* 右上 AI 星芒 */}
            <path
              d="M16.2 6.2L16.9 8.1L18.8 8.8L16.9 9.5L16.2 11.4L15.5 9.5L13.6 8.8L15.5 8.1Z"
              fill="#f472b6"
            />
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
