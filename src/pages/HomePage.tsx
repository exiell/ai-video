import { useAppStore } from '../store/app';
import { cloneAsNewProject } from '../store/app';
import { sampleProject } from '../data/samples/sampleProject';
import { RichText , Info } from '../components/bits';
import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { deleteProject, listProjects, loadProject, type ProjectRecord } from '../services/storage';

/**
 * 首页 / 项目列表（方案.md v0.6 §5.8）
 *
 * 关键设计：**示例项目入口必须显眼**（方案.md §7.1 P0a 的验收标准）。
 * 用户在配置 API Key 之前，得先看到一个「做完了长什么样」的完整例子，
 * 才可能判断这个工具值不值得他继续折腾。
 */
export function HomePage() {
  const navigate = useNavigate();
  const setProject = useAppStore((s) => s.setProject);
  const createEmptyProject = useAppStore((s) => s.createEmptyProject);
  const [records, setRecords] = useState<ProjectRecord[]>([]);
  const [loaded, setLoaded] = useState(false);

  async function refresh() {
    try {
      setRecords(await listProjects());
    } catch {
      setRecords([]);
    }
    setLoaded(true);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function openSample() {
    const project = cloneAsNewProject(sampleProject, '示例 · 林教头风雪山神庙（副本）');
    setProject(project);
    await useAppStore.getState().persist();
    navigate('/storyboard');
  }

  function openBlank() {
    createEmptyProject('我的动漫短片');
    navigate('/guide');
  }

  async function open(id: string) {
    const project = await loadProject(id);
    if (!project) return;
    setProject(project);
    navigate('/storyboard');
  }

  async function remove(id: string) {
    await deleteProject(id);
    await refresh();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>项目</h2>
          <p>
            <RichText>{'交付一份**能开拍的方案**，不是视频'}</RichText>
            <Info label="具体交付什么">
              分镜表、角色与场景设定卡、可直接粘贴的多平台提示词，外加一份穿帮检查单。
              拿着这些，你去即梦、可灵、Seedance 等平台执行。
            </Info>
          </p>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3 className="card-title">先看一个做完了的例子</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
            不用配 API Key，直接看一份做完的方案长什么样。
          </p>
          <button type="button" className="btn btn-primary" onClick={() => void openSample()}>
            打开示例项目
          </button>
        </div>

        <div className="card">
          <h3 className="card-title">从零开始做一个</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
            
          </p>
          <button type="button" className="btn" onClick={openBlank}>
            新建空项目
          </button>
        </div>
      </div>

      <h3 className="card-title" style={{ marginTop: 24 }}>
        我保存过的项目
      </h3>
      {!loaded ? (
        <div className="empty">读取中…</div>
      ) : records.length === 0 ? (
        <div className="empty">
          还没有保存过的项目。所有数据只存在你自己的浏览器里，不会上传到任何服务器。
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="scroll-x">
            <table className="simple">
              <thead>
                <tr>
                  <th>项目名</th>
                  <th>简介</th>
                  <th>最后修改</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <a
                        href={`#/storyboard`}
                        onClick={(e) => {
                          e.preventDefault();
                          void open(record.id);
                        }}
                      >
                        {record.name}
                      </a>
                    </td>
                    <td style={{ color: 'var(--text-dim)' }}>{record.logline || '—'}</td>
                    <td style={{ color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                      {new Date(record.updatedAt).toLocaleString('zh-CN')}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          if (window.confirm(`确定删除「${record.name}」吗？此操作不可撤销。`)) {
                            void remove(record.id);
                          }
                        }}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 24 }}>
        <h3 className="card-title">关于你的数据</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: 0 }}>
          数据只在这个浏览器里。浏览器清缓存时可能清空，请定期导出备份。
        </p>
      </div>
    </>
  );
}
