import { useAppStore } from '../store/app';
import { cloneAsNewProject } from '../store/app';
import { sampleProject } from '../data/samples/sampleProject';
import { RichText } from '../components/bits';
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
            <RichText>
              {'这个工具不生成视频，它交付的是**方案**：分镜表、角色与场景设定卡、可直接粘贴的多平台提示词，外加一份穿帮检查单。拿着这些，你去即梦、可灵、Seedance 等平台执行。'}
            </RichText>
          </p>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3 className="card-title">先看一个做完了的例子</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
            不用配置任何 API Key，直接打开示例项目，看看分镜表、设定卡、提示词和穿帮检查单长什么样。
            里面有 7 个镜头和一个真实的风雪山神庙短片方案。
          </p>
          <button type="button" className="btn btn-primary" onClick={() => void openSample()}>
            打开示例项目
          </button>
        </div>

        <div className="card">
          <h3 className="card-title">从零开始做一个</h3>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
            引导向导会一次只问你一个问题，每个问题都说明为什么问。
            不知道该选什么就按默认值走，随时可以回来改。
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
          免注册，没有账号，数据全部存在你浏览器的 IndexedDB 里，不会上传到任何服务器。
          但请注意：<b>浏览器在清理磁盘或隐私数据时可能清空本地存储</b>。
          请养成定期「导出」的习惯，导出的压缩包就是你的备份。
        </p>
      </div>
    </>
  );
}
