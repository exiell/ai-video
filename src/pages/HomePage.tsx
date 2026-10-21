import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { cloneAsNewProject, useAppStore } from '../store/app';
import { useImage } from '../store/image';
import { sampleProject } from '../data/samples/sampleProject';
import {
  CAMERA_MOVE_LABEL,
  PLATFORM_LABEL,
  SHOT_SIZE_LABEL,
} from '../types/model';
import { deleteProject, listProjects, loadProject, type ProjectRecord } from '../services/storage';

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
  meta: string;
  to: string;
  action: string;
}

function fmtSeconds(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function pct(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

export function HomePage() {
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const report = useAppStore((s) => s.report);
  const setProject = useAppStore((s) => s.setProject);
  const createEmptyProject = useAppStore((s) => s.createEmptyProject);
  const saveError = useAppStore((s) => s.saveError);
  const dirty = useAppStore((s) => s.dirty);
  const gallery = useImage((s) => s.gallery);
  const loadGallery = useImage((s) => s.loadGallery);

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
  const warningCount = report?.counts.warning ?? 0;
  const infoCount = report?.counts.info ?? 0;

  const assetIds = [...characters.map((c) => c.id), ...scenes.map((s) => s.id)].join('|');
  useEffect(() => {
    if (!project) return;
    for (const id of [...characters.map((c) => c.id), ...scenes.map((s) => s.id)]) {
      if (!gallery[id]) void loadGallery(id);
    }
    // 只按项目里的对象集合加载；gallery 变化不重新拉一遍。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, assetIds, loadGallery]);

  const charWithArt = characters.filter((c) => (gallery[c.id]?.length ?? 0) > 0).length;
  const sceneWithArt = scenes.filter((s) => (gallery[s.id]?.length ?? 0) > 0).length;
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

  async function open(id: string) {
    const next = await loadProject(id);
    if (!next) return;
    setProject(next);
    navigate('/');
  }

  async function remove(id: string) {
    await deleteProject(id);
    await refresh();
  }

  const storyDone = !!story?.body.trim();
  const settingDone = characters.length > 0 && scenes.length > 0;
  const storyboardDone = shots.length > 0 && !durationOff;
  const deliveryDone = shots.length > 0 && errorCount === 0;

  const storyPct = storyDone ? 100 : 0;
  const settingPct = settingDone ? 100 : 0;
  const storyboardPct = target > 0 ? (total / target) * 100 : 0;
  const deliveryPct = deliveryDone ? 100 : shots.length > 0 ? 35 : 0;

  // 下一步：按用户真正会卡住的地方排序，而不是按模块编号。
  let next: { title: string; body: string; cta: string; to: string; time: string };
  if (!project) {
    next = {
      title: '先打开一个项目',
      body: '看一个做完了的例子，或者从零开始写你自己的故事。',
      cta: '看示例项目',
      to: '/',
      time: '约 1 分钟',
    };
  } else if (!storyDone) {
    next = {
      title: '先把故事写下来',
      body: '不用写成剧本。谁、在哪、发生了什么、最后停在哪一帧，四句话就够。写完再拆场次。',
      cta: '去写故事',
      to: '/guide',
      time: '约 3 分钟',
    };
  } else if (!settingDone) {
    next = {
      title: '先定下人物和场景',
      body: '每个角色至少锁两条不会变的外观，每个场景记下固定元素和光的方向。后面每一镜都会用到。',
      cta: '去建设定',
      to: characters.length === 0 ? '/characters' : '/scenes',
      time: '约 5 分钟',
    };
  } else if (shots.length === 0) {
    next = {
      title: '把故事拆成分镜',
      body: '让模型先拆一版，每镜只做一件事：起点、动作、终点。拆完再逐镜改，比对着空白页想快得多。',
      cta: '去生成分镜',
      to: '/storyboard',
      time: '约 2 分钟',
    };
  } else if (errorCount > 0) {
    next = {
      title: `先修这 ${errorCount} 个必须修的问题`,
      body: '这些问题会让角色或场景在镜头之间对不上。修完就能导出开拍，其余建议可以边做边看。',
      cta: `去修这 ${errorCount} 条`,
      to: '/checks',
      time: '约 2 分钟',
    };
  } else if (durationOff) {
    next = {
      title: diff > 0 ? `先减掉 ${fmtSeconds(Math.abs(diff))} 秒` : `再补 ${fmtSeconds(Math.abs(diff))} 秒`,
      body: `现在 ${fmtSeconds(total)} 秒，目标 ${fmtSeconds(target)} 秒。先让总时长对上，再进导出。`,
      cta: '去调分镜',
      to: '/storyboard',
      time: '约 5 分钟',
    };
  } else {
    next = {
      title: '导出制作包',
      body: '分镜和检查都过了。压缩包里有拍摄进度表、多平台提示词、一致性总览和检查单。',
      cta: '去导出',
      to: '/export',
      time: '约 1 分钟',
    };
  }

  const tasks: TaskItem[] = [];
  if (project) {
    if (errorCount > 0) {
      tasks.push({
        key: 'errors',
        tone: 'danger',
        title: `修 ${errorCount} 个必须修的问题`,
        meta: '穿帮检查里最要紧的一档',
        to: '/checks',
        action: '去修',
      });
    }
    if (durationOff) {
      tasks.push({
        key: 'duration',
        tone: 'accent',
        title: diff > 0 ? `减 ${fmtSeconds(Math.abs(diff))} 秒镜头` : `再补 ${fmtSeconds(Math.abs(diff))} 秒`,
        meta: `现在 ${fmtSeconds(total)} 秒，目标 ${fmtSeconds(target)} 秒`,
        to: '/storyboard',
        action: '去改',
      });
    }
    if (!storyDone) {
      tasks.push({
        key: 'story',
        tone: 'accent',
        title: '写一句话故事',
        meta: '先有故事，才能拆场次和镜头',
        to: '/guide',
        action: '去写',
      });
    }
    if (!settingDone) {
      tasks.push({
        key: 'setting',
        tone: 'quiet',
        title: '定角色与场景',
        meta: `${characters.length} 个角色 · ${scenes.length} 个场景`,
        to: '/characters',
        action: '去定',
      });
    }
    if (shots.length === 0) {
      tasks.push({
        key: 'shots',
        tone: 'quiet',
        title: '生成第一版分镜',
        meta: '模型起草，你再改',
        to: '/storyboard',
        action: '去拆',
      });
    }
    tasks.push({
      key: 'prompts',
      tone: 'quiet',
      title: '看一遍提示词',
      meta: `${shots.length} 组 · 英文正文 + 中文对照`,
      to: '/prompts',
      action: '去看',
    });
    tasks.push({
      key: 'export',
      tone: 'quiet',
      title: '导出制作包',
      meta: '分镜表、提示词、检查单一起带走',
      to: '/export',
      action: '去导出',
    });
  }
  const visibleTasks = tasks.slice(0, 3);
  const recentShots = shots.slice(-3);

  function stepClass(done: boolean, current: boolean): string {
    if (done) return 'stage-cell done';
    if (current) return 'stage-cell now';
    return 'stage-cell todo';
  }

  return (
    <div className="home">
      {project ? (
        <>
          <header className="home-head">
            <div>
              <div className="home-crumb">
                {isSample ? '示例项目' : '项目'} · {project.brief.aspectRatio} · 数据只在这台电脑
              </div>
              <h1>{project.name}</h1>
              <p className="home-logline">{project.logline || '还没有一句话简介。去「故事」里补上，导出时会用到。'}</p>
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
                导出制作包
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

          <section className="stage-card" aria-label="四步进度">
            <div className={stepClass(storyDone, !storyDone)}>
              <div className="stage-top">
                <span className="stage-name">故事</span>
                <span className="stage-state">{storyDone ? '完成' : '待写'}</span>
              </div>
              <div className="stage-detail">
                {storyDone ? (
                  <>
                    一句话 + {story?.scenes.length ?? 0} 个场次
                    <br />
                    冲突和结局都写清了
                  </>
                ) : (
                  <>
                    还没有故事
                    <br />
                    先写谁、在哪、发生了什么
                  </>
                )}
              </div>
              <div className="stage-bar">
                <i style={{ width: pct(storyPct) }} />
              </div>
            </div>

            <div className={stepClass(settingDone, storyDone && !settingDone)}>
              <div className="stage-top">
                <span className="stage-name">角色与场景</span>
                <span className="stage-state">{settingDone ? '完成' : '待定'}</span>
              </div>
              <div className="stage-detail">
                {characters.length} 个角色 · {scenes.length} 个场景
                <br />
                {characters.length + scenes.length > 0
                  ? `${characters.reduce((n, c) => n + c.continuityLocks.length, 0) + scenes.reduce((n, s) => n + s.continuityLocks.length, 0)} 条连续性锁`
                  : '还没有角色与场景卡'}
              </div>
              <div className="stage-bar">
                <i style={{ width: pct(settingPct) }} />
              </div>
            </div>

            <div className={stepClass(storyboardDone, settingDone && !storyboardDone)}>
              <div className="stage-top">
                <span className="stage-name">分镜</span>
                <span className="stage-state">
                  {shots.length === 0 ? '待开始' : storyboardDone ? '时长吻合' : `差 ${fmtSeconds(Math.abs(diff))} 秒`}
                </span>
              </div>
              <div className="stage-detail">
                {shots.length} 个镜头 · {fmtSeconds(total)} / {fmtSeconds(target)} 秒
                <br />
                {shots.length === 0
                  ? '还没有排时长'
                  : errorCount > 0
                    ? `有 ${errorCount} 个必须修`
                    : '还没有必须修的问题'}
              </div>
              <div className="stage-bar">
                <i style={{ width: pct(storyboardPct) }} />
              </div>
            </div>

            <div className={stepClass(deliveryDone, storyboardDone && !deliveryDone)}>
              <div className="stage-top">
                <span className="stage-name">交付</span>
                <span className="stage-state">{deliveryDone ? '可以导出' : '待完成'}</span>
              </div>
              <div className="stage-detail">
                {shots.length > 0 ? `提示词 ${shots.length} 组已生成` : '分镜出来后生成提示词'}
                <br />
                {deliveryDone ? '导出包里有全套材料' : shots.length === 0 ? '还早，先把分镜排出来' : `导出前还差 ${errorCount} 个必须修`}
              </div>
              <div className="stage-bar">
                <i style={{ width: pct(deliveryPct) }} />
              </div>
            </div>
          </section>

          <div className="home-grid">
            <section className="next-card">
              <div className="next-top">
                <span className="next-label">今天从这里继续</span>
                <span className="next-time">{next.time}</span>
              </div>
              <h2>{next.title}</h2>
              <p>{next.body}</p>
              <div className="next-foot">
                <Link className="btn btn-blue" to={next.to}>
                  {next.cta}
                </Link>
                <span className="next-hint">
                  {errorCount > 0 ? `还有 ${warningCount} 条建议，可以稍后再看` : '先做这一件，别的先放着'}
                </span>
              </div>
            </section>

            <section className="tasks-card">
              <div className="panel-head">
                <h3>接下来三件事</h3>
                <span>按顺序做就行</span>
              </div>
              <ul className="task-list">
                {visibleTasks.map((task) => (
                  <li className="task-row" key={task.key}>
                    <i className={`task-dot ${task.tone}`} aria-hidden="true" />
                    <div className="task-main">
                      <b>{task.title}</b>
                      <span>{task.meta}</span>
                    </div>
                    <Link to={task.to}>{task.action}</Link>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="home-lower">
            <section className="panel shots-panel">
              <div className="panel-head">
                <h3>最近在做的镜头</h3>
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
                          <div className="shot-tile-foot">文字分镜 · 关键帧未生成</div>
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

              <p className="shots-foot">
                <span>
                  {story?.scenes.length ? `按 ${story.scenes.length} 个场次排的` : '还没有拆场次'}
                  {shots.length > 0 ? ' · 点任一镜直接跳到它' : ''}
                </span>
                <Link to="/storyboard">去分镜表 →</Link>
              </p>
            </section>

            <aside className="home-rail">
              <section className="panel">
                <div className="panel-head">
                  <h3>穿帮检查</h3>
                  <span>
                    {report ? new Date(report.checkedAt).toLocaleTimeString('zh-CN') : '还没跑'} 跑的
                  </span>
                </div>
                <div className="check-total">
                  <b className={errorCount > 0 ? 'bad' : ''}>{errorCount}</b>
                  <span>{errorCount > 0 ? '个必须修，修完就能导出' : '个必须修'}</span>
                </div>
                <div className="check-row">
                  <span>建议看</span>
                  <b>{warningCount} 条</b>
                </div>
                <div className="check-row">
                  <span>仅供参考</span>
                  <b>{infoCount} 条</b>
                </div>
                <Link className="panel-link" to="/checks">
                  逐条看，或先修必须的 →
                </Link>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h3>参考图</h3>
                  <span>决定像不像同一个人</span>
                </div>
                <div className="assets">
                  <div className="asset">
                    <b>
                      {charWithArt} / {characters.length}
                    </b>
                    <span>角色形象图</span>
                  </div>
                  <div className="asset">
                    <b>
                      {sceneWithArt} / {scenes.length}
                    </b>
                    <span>场景参考板</span>
                  </div>
                </div>
                <p className="asset-note">
                  {characters.length === 0
                    ? '先建角色，再谈形象图。'
                    : charWithArt < characters.length
                      ? '还没出齐。先出角色多视图，后面每个镜头都能少返工一次。'
                      : '角色和场景的参考图都齐了。'}
                </p>
                <div className="asset-links">
                  <Link to="/characters">角色设定 →</Link>
                  <Link to="/scenes">场景设定 →</Link>
                </div>
              </section>

              <section className="panel save-panel">
                <div className="panel-head">
                  <h3>这份方案</h3>
                  <span>只存在这台电脑</span>
                </div>
                <div className="save-row">
                  <span>保存状态</span>
                  <b className={saveError ? 'bad' : ''}>
                    {saveError ? '没存上' : dirty ? '保存中…' : '已保存'}
                  </b>
                </div>
                <p className="asset-note">
                  {saveError
                    ? saveError
                    : '刷新或清缓存可能丢数据。做完一版就去导出，导出的压缩包也是备份。'}
                </p>
                <Link className="panel-link" to="/export">
                  去导出备份 →
                </Link>
              </section>
            </aside>
          </div>
        </>
      ) : (
        <>
          <header className="start-head">
            <div className="home-crumb">AniGuide · 免注册 · 纯网页</div>
            <h1>把「我想做个动漫视频」，变成一份能开拍的方案。</h1>
            <p>
              不生成视频，也不做剪辑。它用问答把模糊想法变成分镜表、角色与场景设定、可直接粘贴的提示词，
              外加一份穿帮检查单。然后你拿着这些去即梦、可灵、Seedance 执行。
            </p>
          </header>

          <div className="start-grid">
            <section className="start-card start-card-sample">
              <div className="start-card-top">
                <span>先看一个做完了的</span>
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
                <span>从零开始</span>
                <span>约 15 分钟</span>
              </div>
              <h2>新建一个项目</h2>
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
              <p className="start-note">建完可以随时改；所有内容只保存在这台电脑，不会上传。</p>
            </section>
          </div>

          <section className="start-guide">
            <div className="start-guide-copy">
              <h2>它会带你走完这四步</h2>
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
          <h3>我保存过的项目</h3>
          <span>数据只存在这个浏览器里</span>
        </div>
        {!loaded ? (
          <div className="empty">读取中…</div>
        ) : records.length === 0 ? (
          <div className="empty">
            还没有保存过的项目。所有数据只存在你自己的浏览器里，不会上传到任何服务器。
          </div>
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
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    if (window.confirm(`确定删除「${record.name}」吗？此操作不可撤销。`)) {
                      void remove(record.id);
                    }
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}


