import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { useChat } from '../store/chat';
import { ChatSidebar } from './ChatSidebar';

/**
 * 侧边导航（方案.md v0.6 §5.8）
 *
 * 导航按用户流程顺序排列，而不是按模块编号——
 * 目标是新手，他要的是「下一步点哪」，不是「M1 到 M7」。
 */

const FLOW = [
  { to: '/guide', label: '引导向导' },
  { to: '/storyboard', label: '分镜表' },
  { to: '/checks', label: '穿帮检查' },
  { to: '/characters', label: '角色设定' },
  { to: '/scenes', label: '场景设定' },
  { to: '/prompts', label: '提示词' },
  { to: '/export', label: '导出' },
];

export function Layout({ children }: { children: ReactNode }) {
  const project = useAppStore((s) => s.project);
  const report = useAppStore((s) => s.report);
  const dirty = useAppStore((s) => s.dirty);
  const saveError = useAppStore((s) => s.saveError);
  const chatOpen = useChat((s) => s.open);
  const errorCount = report?.counts.error ?? 0;
  const warningCount = report?.counts.warning ?? 0;

  return (
    <div className={`app${chatOpen ? ' chat-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h1>AniGuide</h1>
          <p>把想法变成一份能开拍的方案</p>
        </div>

        <nav className="nav-group">
          <NavLink to="/" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} end>
            <span>项目</span>
          </NavLink>
        </nav>

        {/*
          「创作流程」在没有打开项目时也显示，只是置灰。

          【为什么不做成 project ? … : null】原来没项目时这七项整个消失，
          导航只剩「项目 / 帮助与术语 / 设置 / 关于」——用户看不到这个工具能干什么，
          而这恰恰是「一目了然知道有什么功能」的最基本要求。

          置灰而不是隐藏：让人知道有这七步、它们叫什么、按什么顺序。
          点了会告诉他先去开项目，而不是让他以为自己点错了。
        */}
        <nav className="nav-group">
          <div className="nav-group-title">创作流程</div>
          {FLOW.map((item) => {
            if (!project) {
              return (
                <span
                  key={item.to}
                  className="nav-item nav-item-off"
                  title="先打开一个项目，这一步才能用"
                >
                  <span>{item.label}</span>
                </span>
              );
            }
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              >
                <span>{item.label}</span>
                {item.to === '/checks' && errorCount > 0 ? (
                  <span className="tag tag-error">{errorCount}</span>
                ) : null}
                {item.to === '/checks' && errorCount === 0 && warningCount > 0 ? (
                  <span className="tag tag-warning">{warningCount}</span>
                ) : null}
              </NavLink>
            );
          })}
        </nav>

        <nav className="nav-group">
          <div className="nav-group-title">其他</div>
          <NavLink to="/help" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <span>帮助与术语</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <span>设置</span>
          </NavLink>
          <NavLink to="/about" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <span>关于</span>
          </NavLink>
        </nav>

        {project ? (
          <div style={{ padding: '12px 18px', fontSize: 11, color: 'var(--text-faint)' }}>
            <div style={{ marginBottom: 4, color: 'var(--text-dim)' }}>{project.name}</div>
            {/*
              保存失败必须说出来。
              原来 `void persist()` 把异常吞了：IndexedDB 写失败时
              界面永远停在「保存中…」，用户以为在存，其实数据没落盘。
              这是会真丢数据的那种静默失败，所以这里给颜色、给原因、给出口。
            */}
            {saveError ? (
              <>
                <div style={{ color: 'var(--warning)', fontWeight: 600 }}>⚠ 没能存到本机</div>
                <div style={{ marginTop: 2, lineHeight: 1.5 }}>{saveError}</div>
                <Link
                  to="/export"
                  style={{ display: 'inline-block', marginTop: 4, color: 'var(--accent)' }}
                >
                  先去导出备份 →
                </Link>
              </>
            ) : (
              <div>{dirty ? '保存中…' : '已保存到本机'}</div>
            )}
          </div>
        ) : null}
      </aside>

      <main className="main">{children}</main>

      {/*
        对话式改稿侧栏。
        放在 Layout 而不是各个页面里，是为了让它跨页面保持状态——
        用户在分镜表问了一半，切去角色设定看个东西再切回来，对话还在。
        放在页面里就做不到，切页就没了。
      */}
      <ChatSidebar />
    </div>
  );
}
