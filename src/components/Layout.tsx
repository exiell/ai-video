import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { useChat } from '../store/chat';
import { ChatSidebar } from './ChatSidebar';
import { Icon } from './Icon';

/**
 * 应用外壳（C 方向）
 *
 * 侧栏按「作品主页 → 故事 → 设定 → 分镜 → 交付」排，而不是按模块编号。
 * 目标是新手：他要知道「下一步点哪」，不是「一共有几个模块」。
 */

function navClass({ isActive }: { isActive: boolean }): string {
  return `nav-item${isActive ? ' active' : ''}`;
}

function fmtSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function Layout({ children }: { children: ReactNode }) {
  const project = useAppStore((s) => s.project);
  const report = useAppStore((s) => s.report);
  const dirty = useAppStore((s) => s.dirty);
  const saveError = useAppStore((s) => s.saveError);
  const chatOpen = useChat((s) => s.open);

  const errorCount = report?.counts.error ?? 0;
  const warningCount = report?.counts.warning ?? 0;
  const shotCount = project?.shots.length ?? 0;
  const charCount = project?.characters.length ?? 0;
  const sceneCount = project?.scenes.length ?? 0;
  const total = project?.shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0) ?? 0;
  const storyWritten = !!project?.story.body.trim();

  return (
    <div className={`app${chatOpen ? ' chat-open' : ''}`}>
      <aside className="sidebar">
        <Link className="brand-lockup" to="/">
          <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="2.5" y="4" width="19" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M4 16 L9 9 L13 14 L16 10 L20 16" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="16.8" cy="7.6" r="1.3" fill="currentColor" />
          </svg>
          <span className="brand-text">
            <b>AniGuide</b>
            <small>AI 视频制作向导</small>
          </span>
        </Link>

        <div className="project-switch">
          <span className="project-switch-label">当前项目</span>
          <b>{project?.name ?? '还没有打开项目'}</b>
          {project ? (
            <span className="project-switch-meta">
              {shotCount} 镜 · {fmtSeconds(total)} 秒
            </span>
          ) : (
            <span className="project-switch-meta">先打开示例，或新建一个</span>
          )}
          <Link className="project-switch-link" to="/">
            {project ? '项目主页 →' : '打开示例或新建 →'}
          </Link>
        </div>

        <nav className="side-nav" aria-label="主导航">
          <NavLink to="/" end className={navClass}>
            <span className="nav-label">
              <Icon name="home" className="nav-icon" />
              <span>作品主页</span>
            </span>
          </NavLink>

          {project ? (
            <>
              <div className="side-nav-title">制作</div>
              <NavLink to="/guide" className={navClass}>
                <span className="nav-label">
                  <Icon name="book" className="nav-icon" />
                  <span>故事</span>
                </span>
                <span className="nav-count">{storyWritten ? '已写' : '待写'}</span>
              </NavLink>
              <NavLink to="/characters" className={navClass}>
                <span className="nav-label">
                  <Icon name="users" className="nav-icon" />
                  <span>角色</span>
                </span>
                <span className="nav-count">{charCount}</span>
              </NavLink>
              <NavLink to="/scenes" className={navClass}>
                <span className="nav-label">
                  <Icon name="map" className="nav-icon" />
                  <span>场景</span>
                </span>
                <span className="nav-count">{sceneCount}</span>
              </NavLink>
              <NavLink to="/storyboard" className={navClass}>
                <span className="nav-label">
                  <Icon name="layout-grid" className="nav-icon" />
                  <span>分镜</span>
                </span>
                <span className="nav-count">{shotCount} 镜</span>
              </NavLink>
              <NavLink to="/checks" className={navClass}>
                <span className="nav-label">
                  <Icon name="alert-triangle" className="nav-icon" />
                  <span>穿帮检查</span>
                </span>
                {errorCount > 0 ? (
                  <span className="nav-count nav-count-danger">{errorCount}</span>
                ) : warningCount > 0 ? (
                  <span className="nav-count">{warningCount}</span>
                ) : null}
              </NavLink>
              <NavLink to="/prompts" className={navClass}>
                <span className="nav-label">
                  <Icon name="terminal" className="nav-icon" />
                  <span>提示词</span>
                </span>
                <span className="nav-count">{shotCount} 组</span>
              </NavLink>
              <NavLink to="/export" className={navClass}>
                <span className="nav-label">
                  <Icon name="download" className="nav-icon" />
                  <span>导出</span>
                </span>
              </NavLink>
            </>
          ) : null}
        </nav>

        <nav className="side-nav side-nav-utility" aria-label="工具">
          <NavLink to="/help" className={navClass}>
            <span className="nav-label">
              <Icon name="help" className="nav-icon" />
              <span>帮助与术语</span>
            </span>
          </NavLink>
          <NavLink to="/settings/models" className={navClass}>
            <span className="nav-label">
              <Icon name="settings" className="nav-icon" />
              <span>设置</span>
            </span>
          </NavLink>
          <NavLink to="/about" className={navClass}>
            <span className="nav-label">
              <Icon name="file-text" className="nav-icon" />
              <span>关于</span>
            </span>
          </NavLink>
        </nav>

        <div className="sidebar-foot">
          {project ? (
            <>
              <div className="save-line">
                <span>保存</span>
                {saveError ? (
                  <b className="bad">没存上</b>
                ) : (
                  <b className={dirty ? 'saving' : ''}>{dirty ? '保存中…' : '已存到本机'}</b>
                )}
              </div>
              {saveError ? (
                <p className="save-error">
                  {saveError}
                  <Link to="/export">先去导出备份 →</Link>
                </p>
              ) : (
                <p className="save-note">数据只在这台电脑里，清缓存前记得导出。</p>
              )}
            </>
          ) : (
            <p className="save-note">免注册 · 数据只在这台电脑里</p>
          )}
        </div>
      </aside>

      <main className="main">{children}</main>

      {/*
        对话式改稿侧栏。
        放在 Layout 而不是各个页面里，是为了让它跨页面保持状态——
        用户在分镜表问了一半，切去角色设定看个东西再切回来，对话还在。
      */}
      <ChatSidebar />
    </div>
  );
}
