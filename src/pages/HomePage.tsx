import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { cloneAsNewProject, useAppStore } from '../store/app';
import { useImage } from '../store/image';
import { Icon } from '../components/Icon';
import { computeImageCoverage } from '../components/imageCoverage';
import { sampleProject } from '../data/samples/sampleProject';
import {
  CAMERA_MOVE_LABEL,
  PLATFORM_LABEL,
  SHOT_SIZE_LABEL,
} from '../types/model';
import { listProjects, loadProject, type ProjectRecord } from '../services/storage';

/**
 * 作品主页（C 方向）
 *
 * 目标用户是第一次做 AI 动画的人。他打开工具时心里不是「我要用某个模块」，
 * 而是「我现在该做什么」。所以这一页只回答三件事：
 * 1. 这个片子现在到哪了；
 * 2. 下一步做哪一件；
 * 3. 后面还排着哪几件。
 *
 * 没有把仪表盘搬进来：没有 KPI 卡、没有图表库，只有项目本身的数据和两条行动线。
 */

type Tone = 'danger' | 'accent' | 'quiet' | 'done';

interface TaskItem {
  key: string;
  tone: Tone;
  title: string;
  to: string;
  action: string;
}

function fmtSeconds(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function HomePage() {
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const report = useAppStore((s) => s.report);
  const setProject = useAppStore((s) => s.setProject);
  const createEmptyProject = useAppStore((s) => s.createEmptyProject);
  const removeProject = useAppStore((s) => s.removeProject);
  const saveError = useAppStore((s) => s.saveError);
  const dirty = useAppStore((s) => s.dirty);
  const gallery = useImage((s) => s.gallery);
  const loadGallery = useImage((s) => s.loadGallery);

  const [records, setRecords] = useState<ProjectRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** 打开存档失败时的提示。不能静默：点了没反应，用户会以为项目丢了。 */
  const [openError, setOpenError] = useState<string | null>(null);
  /** 存档列表读取失败时保留已有列表，只在上方提示，不清空用户看到的数据。 */
  const [listError, setListError] = useState<string | null>(null);
  /** 删除项目失败时的提示。走 store 的 removeProject，异常已经翻成人话。 */
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function refresh() {
    try {
      setRecords(await listProjects());
      setListError(null);
    } catch {
      // 读不出来时不要把列表清空：已经显示的项目还在，只是这次没刷新成功
      setListError(
        '项目列表没读出来。可能是浏览器本地数据正被别的标签页占用，刷新一下再试；已经打开的项目不受影响。',
      );
    }
    setLoaded(true);
  }

  useEffect(() => {
    void refresh();
  }, []);

  const characters = project?.characters ?? [];
  const scenes = project?.scenes ?? [];
  const shots = project?.shots ?? [];
  const story = project?.story;
  const target = project?.brief.targetDuration ?? 0;
  const total = shots.reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0);
  const diff = total - target;
  const tolerance = Math.max(target * 0.1, 2);
  const durationOff = shots.length > 0 && Math.abs(diff) > tolerance;

  const errorCount = report?.counts.error ?? 0;

  // 图库是懒加载的：角色、场景、镜头都要拉，缺一个都会让「下一步」误判。
  const galleryRefIds = [...characters, ...scenes, ...shots].map((item) => item.id);
  const assetIds = galleryRefIds.join('|');
  useEffect(() => {
    if (!project) return;
    for (const id of galleryRefIds) {
      if (!gallery[id]) void loadGallery(id);
    }
    // 只按项目里的对象集合加载；gallery 变化不重新拉一遍。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, assetIds, loadGallery]);

  const coverage = computeImageCoverage(project, gallery);
  const isSample = !!project && (project.name.startsWith('示例') || project.id.startsWith('sample'));

  async function openSample() {
    const next = cloneAsNewProject(sampleProject, '示例 · 林教头风雪山神庙（副本）');
    setProject(next);
    await useAppStore.getState().persist();
    navigate('/');
  }

  function openBlank() {
    createEmptyProject('我的动漫短片');
    navigate('/guide');
  }

  /**
   * 新建项目（**已经打开一个项目时**也走这里）。
   *
   * 【为什么必须先落盘】切项目会把 store 里的当前项目整个换掉。
   * 自动保存是延迟触发的，如果用户刚改完就点新建，最后一次改动还没写进
   * IndexedDB 就没了——而界面上刚显示过「已保存到本机」，他会以为存住了。
   *
   * 所以：先 await persist()，再切。persist 失败（配额用尽等）就**不切**，
   * 让用户先把备份做掉，而不是带着一个没存住的项目继续往下走。
   */
  async function startNewProject() {
    const { dirty, saveError, persist } = useAppStore.getState();
    if (project && (dirty || saveError)) {
      if (saveError) {
        const go = window.confirm(
          `当前项目没能存到本机：\n${saveError}\n\n` +
            '现在新建项目，这次的改动可能会丢。要先导出备份吗？\n' +
            '（点「取消」回到项目里，去「导出」页做备份）',
        );
        if (!go) return;
      } else {
        await persist();
        const after = useAppStore.getState();
        if (after.saveError) {
          window.alert(`当前项目保存失败：${after.saveError}\n\n先别新建，去「导出」页做个备份。`);
          return;
        }
      }
    }
    openBlank();
  }

  /**
   * 打开一条存档。
   *
   * loadProject 会读 IndexedDB 再走 normalizeProject + setProject；后两步都可能
   * 因为旧数据/坏数据抛异常。原样 void 掉的结果是「点了没反应」，用户以为项目没了。
   * 所以这里整段兜住，失败时在「已有项目」列表上方给人话提示。
   */
  async function open(id: string) {
    setOpenError(null);
    try {
      const next = await loadProject(id);
      if (!next) {
        setOpenError(
          '这个项目读不出来：本机里没有找到它。可能已经被删除，或者浏览器的本地数据被清理过。',
        );
        return;
      }
      setProject(next);
      navigate('/');
    } catch {
      setOpenError(
        '这个项目读不出来。可能是浏览器本地数据损坏，或者项目来自旧版本；可以试试重新导入一次「项目数据.json」。',
      );
    }
  }

  /**
   * 删除存档。
   *
   * 走 store 的 removeProject 而不是直接 deleteProject：store 会把
   * IndexedDB 异常翻成 { ok, error }，页面才有机会告诉用户「没删掉、东西还在」。
   * 直接 void 掉的结果是点了「确认删除」之后什么都不发生。
   */
  async function remove(id: string) {
    const result = await removeProject(id);
    if (!result.ok) {
      setDeleteError(result.error ?? '删除没成功，刷新页面后再试一次。项目和图片都还在。');
      return;
    }
    setDeleteError(null);
    await refresh();
  }

  const storyDone = !!story?.body.trim();
  const settingDone = characters.length > 0 && scenes.length > 0;
  const storyboardDone = shots.length > 0 && !durationOff;
  const framesAll = shots.length > 0 && coverage.framesReady === shots.length;
  // 交付的完成条件纳入图片进度：参考图和每镜三帧都齐了才算能导出
  const deliveryDone = shots.length > 0 && errorCount === 0 && coverage.imagesReady;
  const deliveryState = deliveryDone
    ? '可以导出'
    : !storyDone || !settingDone || shots.length === 0
      ? '待完成'
      : !coverage.referencesReady
        ? '待出图'
        : !framesAll
          ? '待出帧'
          : '待完成';


  // 下一步：按用户真正会卡住的地方排序，而不是按模块编号。
  // 图片没出齐时不能推荐导出：先补参考图，再补三帧，最后才是导出。
  let next: { title: string; cta: string; to: string };
  if (!project) {
    next = { title: '项目', cta: '看示例项目', to: '/' };
  } else if (!storyDone) {
    next = { title: '故事', cta: '去写故事', to: '/guide' };
  } else if (!settingDone) {
    next = {
      title: '角色与场景',
      cta: '去建设定',
      to: characters.length === 0 ? '/characters' : '/scenes',
    };
  } else if (shots.length === 0) {
    next = { title: '分镜', cta: '去生成分镜', to: '/storyboard' };
  } else if (errorCount > 0) {
    next = { title: '穿帮检查', cta: `去修这 ${errorCount} 条`, to: '/checks' };
  } else if (durationOff) {
    next = { title: '时长', cta: '去调分镜', to: '/storyboard' };
  } else if (!coverage.loaded || !coverage.referencesReady) {
    // 懒加载没完成时按「参考图未齐」保守处理：宁可多一步，也不能直接推荐导出
    next = {
      title: '参考图',
      cta: '去出图',
      to: coverage.charsReady < characters.length ? '/characters' : '/scenes',
    };
  } else if (!framesAll) {
    next = { title: '分镜三帧', cta: '去出帧', to: '/storyboard' };
  } else {
    next = { title: '导出', cta: '去导出', to: '/export' };
  }

  const tasks: TaskItem[] = [];
  if (project) {
    if (errorCount > 0) {
      tasks.push({
        key: 'errors',
        tone: 'danger',
        title: `必改项 ${errorCount} 个`,
        to: '/checks',
        action: '去修',
      });
    }
    if (durationOff) {
      tasks.push({
        key: 'duration',
        tone: 'accent',
        title: diff > 0 ? `减 ${fmtSeconds(Math.abs(diff))} 秒镜头` : `再补 ${fmtSeconds(Math.abs(diff))} 秒`,
        to: '/storyboard',
        action: '去改',
      });
    }
    if (!storyDone) {
      tasks.push({
        key: 'story',
        tone: 'accent',
        title: '故事',
        to: '/guide',
        action: '去写',
      });
    }
    if (!settingDone) {
      tasks.push({
        key: 'setting',
        tone: 'quiet',
        title: '角色与场景',
        to: '/characters',
        action: '去定',
      });
    }
    if (shots.length === 0) {
      tasks.push({
        key: 'shots',
        tone: 'quiet',
        title: '分镜',
        to: '/storyboard',
        action: '去拆',
      });
    }
    tasks.push({
      key: 'prompts',
      tone: 'quiet',
      title: '提示词',
      to: '/prompts',
      action: '去看',
    });
    tasks.push({
      key: 'export',
      tone: 'quiet',
      title: '导出',
      to: '/export',
      action: '去导出',
    });
  }
  const visibleTasks = tasks;
  const recentShots = shots.slice(-3);

  return (
    <div className="home">
      {project ? (
        <>
          <header className="home-head">
            <div>
              <div className="home-crumb">
                {isSample ? '示例项目' : '项目'} · {project.brief.aspectRatio}
              </div>
              <h1>{project.name}</h1>
              <p className="home-logline">{project.logline || '还没有一句话简介。'}</p>
              <p className="home-meta">
                {fmtSeconds(target)} 秒目标 · {shots.length} 个镜头 ·{' '}
                {project.brief.platforms.map((p) => PLATFORM_LABEL[p]).join(' / ') || '未选平台'}
              </p>
            </div>
            <div className="home-actions">
              <Link className="btn" to="/storyboard">
                看分镜
              </Link>
              <Link className="btn" to="/export">
                导出
              </Link>
              {/*
                【为什么要这个按钮】原来「新建项目」只在没打开项目时出现，
                一旦打开了一个项目就再也建不了新的——只能去关掉当前项目（而界面上没有这个操作），
                或者清浏览器数据。这是一个死路。
              */}
              <button type="button" className="btn" onClick={() => void startNewProject()}>
                新建项目
              </button>
            </div>
          </header>

          {/*
            四步进度的紧凑版。改之前是四张等高卡片，每张带进度条和两行说明，
            占掉第一屏三分之一的竖向空间；而「现在做什么」在下面已经说了。
            这里只留「走到哪、下一步是谁」，点一下直接进对应页面。
          */}
          <section className="stage-strip" aria-label="四步进度">
            {[
              {
                key: 'story',
                name: '故事',
                to: '/guide',
                done: storyDone,
                prevDone: true,
                state: storyDone ? '完成' : '待写',
              },
              {
                key: 'setting',
                name: '角色与场景',
                to: '/characters',
                done: settingDone,
                prevDone: storyDone,
                state: settingDone ? '完成' : '待定',
              },
              {
                key: 'storyboard',
                name: '分镜',
                to: '/storyboard',
                done: storyboardDone,
                prevDone: settingDone,
                state: storyboardDone
                  ? '时长吻合'
                  : shots.length === 0
                    ? '待开始'
                    : `差 ${fmtSeconds(Math.abs(diff))} 秒`,
              },
              {
                key: 'delivery',
                name: '交付',
                to: '/export',
                done: deliveryDone,
                prevDone: storyboardDone,
                state: deliveryState,
              },
            ].map((step) => (
              <Link
                key={step.key}
                to={step.to}
                className={`stage-step ${step.done ? 'is-done' : step.prevDone ? 'is-now' : 'is-todo'}`}
              >
                <i className="stage-step-dot" aria-hidden="true" />
                <span className="stage-step-name">{step.name}</span>
                <span className="stage-step-state">{step.state}</span>
              </Link>
            ))}
          </section>

          <div className="home-grid">
            <section className="next-card">
              <div className="next-top">
                <span className="next-label">下一步</span>
              </div>
              <h2>{next.title}</h2>
              <div className="next-foot">
                <Link className="btn btn-blue" to={next.to}>
                  {next.cta}
                </Link>
              </div>
            </section>

            <section className="tasks-card">
              <div className="panel-head">
                <h3>待办</h3>
              </div>
              <ul className="task-list">
                {visibleTasks.map((task) => (
                  <li key={task.key}>
                    <Link className="task-row" to={task.to}>
                      <i className={`task-dot ${task.tone}`} aria-hidden="true" />
                      <div className="task-main">
                        <b>{task.title}</b>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="home-lower">
            <section className="panel shots-panel">
              <div className="panel-head">
                <h3>最近镜头</h3>
                <Link to="/storyboard">看全部 {shots.length} 镜 →</Link>
              </div>

              {recentShots.length > 0 ? (
                <div className="shot-grid">
                  {recentShots.map((shot) => {
                    const scene = scenes.find((s) => s.id === shot.sceneId);
                    return (
                      <Link className="shot-tile" to={`/storyboard?shot=${shot.id}`} key={shot.id}>
                        <div className="shot-tile-frame">
                          <div className="shot-tile-top">
                            <span>第 {shot.number} 镜</span>
                            <span>{shot.duration}s</span>
                          </div>
                          <p>{shot.action || shot.startState || '这一镜还没有写动作。'}</p>
                        </div>
                        <div className="shot-tile-meta">
                          <b>{scene?.name ?? '未指定场景'}</b>
                          <span>
                            {SHOT_SIZE_LABEL[shot.shotSize]} · {CAMERA_MOVE_LABEL[shot.cameraMove]}
                          </span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">
                  还没有镜头。
                  <Link to="/storyboard">去分镜表生成第一版 →</Link>
                </div>
              )}

              <div className="runtime">
                <div className="runtime-head">
                  <span>总时长</span>
                  <b>
                    {fmtSeconds(total)} <small>/ {fmtSeconds(target)} 秒</small>
                  </b>
                </div>
                <div className="runtime-bars" aria-hidden="true">
                  {shots.slice(0, 12).map((shot, index, arr) => (
                    <i
                      key={shot.id}
                      className={index === arr.length - 1 ? 'on' : ''}
                      style={{ height: `${Math.min(30, 8 + (Number(shot.duration) || 0) * 3)}px` }}
                    />
                  ))}
                  {shots.length === 0 ? <i style={{ height: 4 }} /> : null}
                </div>
                <div className="runtime-foot">
                  <span>{shots.length} 个镜头</span>
                  <span>
                    {shots.length === 0
                      ? '还没有排时长'
                      : Math.abs(diff) <= tolerance
                        ? '时长吻合'
                        : diff > 0
                          ? `超 ${fmtSeconds(diff)} 秒`
                          : `还差 ${fmtSeconds(-diff)} 秒`}
                  </span>
                </div>
              </div>
            </section>

            <aside className="home-rail">
              <Link className="panel panel-link" to="/checks">
                <div className="panel-head">
                  <h3>穿帮检查</h3>
                </div>
                <div className="check-total">
                  <b className={errorCount > 0 ? 'bad' : ''}>{errorCount}</b>
                  <span>{errorCount > 0 ? '个必改项，修完才能导出' : '个必改项'}</span>
                </div>
              </Link>

              <section className="panel">
                <div className="panel-head">
                  <h3>参考图</h3>
                </div>
                <div className="assets">
                  <Link
                    className="asset"
                    to="/characters"
                    aria-label={`角色设定：角色形象图 ${coverage.charsReady} / ${characters.length}`}
                  >
                    <b>
                      {coverage.charsReady} / {characters.length}
                    </b>
                    <span>角色形象图</span>
                  </Link>
                  <Link
                    className="asset"
                    to="/scenes"
                    aria-label={`场景设定：场景参考板 ${coverage.scenesReady} / ${scenes.length}`}
                  >
                    <b>
                      {coverage.scenesReady} / {scenes.length}
                    </b>
                    <span>场景参考板</span>
                  </Link>
                </div>
              </section>

              <Link className="panel panel-link save-panel" to="/export">
                <div className="panel-head">
                  <h3>存档</h3>
                </div>
                <div className="save-row">
                  <span>保存状态</span>
                  <b className={saveError ? 'bad' : ''}>
                    {saveError ? '没存上' : dirty ? '保存中…' : '已保存'}
                  </b>
                </div>
                {saveError ? <p className="asset-note">{saveError}</p> : null}
              </Link>
            </aside>
          </div>
        </>
      ) : (
        <>
          <header className="start-head">
            <div className="home-crumb">AniGuide · 免注册 · 数据在本机</div>
            <h1>从故事到分镜</h1>
            <p>
              这里只做前期：故事、角色、场景、分镜和提示词。视频生成去即梦、可灵或 Seedance。
            </p>
          </header>

          <div className="start-grid">
            <section className="start-card start-card-sample">
              <div className="start-card-top">
                <span>示例项目</span>
                <span>不用配 API Key</span>
              </div>
              <h2>林教头风雪山神庙</h2>
              <p className="start-quote">一个被诬陷的武人被发配草料场，在风雪夜里听见门外三人密谋，推门而出。</p>
              <div className="start-stats">
                <div>
                  <b>40</b>
                  <span>秒</span>
                </div>
                <div>
                  <b>7</b>
                  <span>个镜头</span>
                </div>
                <div>
                  <b>2 + 2</b>
                  <span>角色 / 场景</span>
                </div>
                <div>
                  <b>23</b>
                  <span>条检查</span>
                </div>
              </div>
              <button type="button" className="btn btn-blue" onClick={() => void openSample()}>
                打开示例项目
              </button>
            </section>

            <section className="start-card">
              <div className="start-card-top">
                <span>新建项目</span>
                <span>约 15 分钟</span>
              </div>
              <h2>新项目</h2>
              <p className="start-quote">
                先回答四个问题：故事从哪来、故事是什么、什么风格、最后怎么交付。每一步都可以回头改。
              </p>
              <div className="start-steps">
                <span>故事</span>
                <span>角色与场景</span>
                <span>分镜</span>
                <span>交付</span>
              </div>
              <button type="button" className="btn btn-primary" onClick={openBlank}>
                新建空项目
              </button>
            </section>
          </div>

          <section className="start-guide">
            <div className="start-guide-copy">
              <h2>四步流程</h2>
              <p>每一步都只问当前必须回答的问题；不知道选哪个，就按默认值走。</p>
            </div>
            <div className="start-guide-steps">
              <div>
                <b>故事</b>
                <span>谁、在哪、发生什么、停在哪一帧</span>
              </div>
              <div>
                <b>角色与场景</b>
                <span>锁住不会变的外观和空间</span>
              </div>
              <div>
                <b>分镜</b>
                <span>一镜只做一件事：起点 → 动作 → 终点</span>
              </div>
              <div>
                <b>交付</b>
                <span>分镜表、提示词、检查单一起带走</span>
              </div>
            </div>
          </section>
        </>
      )}

      <section className="saved">
        <div className="panel-head">
          <h3>已有项目</h3>
        </div>
        {listError ? (
          <div className="issue error" style={{ marginTop: 0, marginBottom: 12 }}>
            <div className="issue-title">项目列表没读出来</div>
            <div className="issue-line">{listError}</div>
          </div>
        ) : null}
        {openError ? (
          <div className="issue error" style={{ marginTop: 0, marginBottom: 12 }}>
            <div className="issue-title">打不开这个项目</div>
            <div className="issue-line">{openError}</div>
          </div>
        ) : null}
        {deleteError ? (
          <div className="issue error" style={{ marginTop: 0, marginBottom: 12 }}>
            <div className="issue-title">删除失败</div>
            <div className="issue-line">{deleteError}</div>
          </div>
        ) : null}
        {!loaded ? (
          <div className="empty">读取中…</div>
        ) : records.length === 0 ? (
          <div className="empty">还没有保存过的项目。</div>
        ) : (
          <div className="saved-table">
            <div className="saved-row saved-head">
              <span>项目</span>
              <span>简介</span>
              <span>最后修改</span>
              <span />
            </div>
            {records.map((record) => (
              <div className="saved-row" key={record.id}>
                <a
                  href="#/"
                  onClick={(e) => {
                    e.preventDefault();
                    void open(record.id);
                  }}
                >
                  {record.name}
                </a>
                <span>{record.logline || '—'}</span>
                <span>{new Date(record.updatedAt).toLocaleString('zh-CN')}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon is-danger"
                  aria-label={`删除项目「${record.name}」`}
                  title="删除"
                  onClick={() => {
                    if (window.confirm(`确定删除「${record.name}」吗？此操作不可撤销。`)) {
                      void remove(record.id);
                    }
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}


