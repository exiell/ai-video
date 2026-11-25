import { useEffect, useRef, useState } from 'react';
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
import {
  isCharacterStageEnabled,
  isPhysicalSceneStageEnabled,
  resolveVideoMode,
  VIDEO_MODE_SHORT_LABEL,
} from '../domain/pipeline/profiles';
import { listProjects, loadProject, type ProjectRecord } from '../services/storage';
import { importProjectFile } from '../services/storage/importBundle';

/**
 * 作品主页（三区可视化制片总控台）
 *
 * 去掉重复的文字待办，保留三个高信息量区块：
 * 1. 顶部创作主线与唯一行动卡；
 * 2. 中央片子视觉预览台与可点击时长节奏条；
 * 3. 底部连贯性健康度三联卡（参考图、穿帮拦截、本机存档）。
 */

function fmtSeconds(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
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
  const [openError, setOpenError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      setRecords(await listProjects());
      setListError(null);
    } catch {
      setListError('项目列表暂时没读出来，刷新页面再试；当前项目不受影响。');
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

  const shotErrorSet = new Set(
    (report?.issues ?? [])
      .filter((issue) => issue.location.kind === 'shot' && issue.severity === 'error')
      .map((issue) => issue.location.id),
  );

  const galleryRefIds = [...characters, ...scenes, ...shots].map((item) => item.id);
  const assetIds = galleryRefIds.join('|');
  useEffect(() => {
    if (!project) return;
    for (const id of galleryRefIds) {
      if (!gallery[id]) void loadGallery(id);
    }
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

  async function handleImportFile(file: File) {
    setImportError(null);
    setImporting(true);
    try {
      const result = await importProjectFile(file);
      if (!result.ok || !result.project) {
        setImportError(result.error ?? '导入失败，请检查文件格式。');
        return;
      }
      setProject(result.project);
      if ((result.restoredImages ?? 0) > 0) {
        const ids = [
          ...result.project.characters,
          ...result.project.scenes,
          ...result.project.shots,
        ].map((item) => item.id);
        for (const id of ids) void loadGallery(id);
      }
      await refresh();
      navigate('/');
    } finally {
      setImporting(false);
    }
  }

  async function startNewProject() {
    const { dirty: isDirty, saveError: err, persist } = useAppStore.getState();
    if (project && (isDirty || err)) {
      if (err) {
        const go = window.confirm(
          `当前项目没能存到本机：\n${err}\n\n现在新建项目，这次改动可能会丢。要先导出备份吗？`,
        );
        if (!go) return;
      } else {
        await persist();
        const after = useAppStore.getState();
        if (after.saveError) {
          window.alert(`当前项目保存失败：${after.saveError}\n\n先去交付中心做个备份。`);
          return;
        }
      }
    }
    openBlank();
  }

  async function open(id: string) {
    setOpenError(null);
    try {
      const next = await loadProject(id);
      if (!next) {
        setOpenError('本机里没有找到这个项目，可能已被删除或清理。');
        return;
      }
      setProject(next);
      navigate('/');
    } catch {
      setOpenError('项目数据读不出来，可以去交付中心重新导入备份文件。');
    }
  }

  async function remove(id: string) {
    const result = await removeProject(id);
    if (!result.ok) {
      setDeleteError(result.error ?? '删除没成功，刷新页面后再试。');
      return;
    }
    setDeleteError(null);
    await refresh();
  }

  const charEnabled = isCharacterStageEnabled(project);
  const sceneEnabled = isPhysicalSceneStageEnabled(project);
  const videoMode = resolveVideoMode(project);
  const visualAssets = project?.visualAssets ?? [];
  const storyDone = !!story?.body.trim();
  const hasVisualAnchors =
    Boolean(project?.visualBible?.styleAnchor?.trim()) || visualAssets.length > 0;
  const settingDone =
    (!charEnabled || characters.length > 0) &&
    (!sceneEnabled || scenes.length > 0) &&
    (charEnabled || sceneEnabled || hasVisualAnchors || shots.length > 0);
  const storyboardDone = shots.length > 0 && !durationOff && errorCount === 0;
  const framesAll = shots.length > 0 && coverage.framesReady === shots.length;
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

  let next: { label: string; title: string; detail: string; cta: string; to: string };
  if (!project) {
    next = {
      label: '开始',
      title: '先打开示例项目看看成品结构',
      detail: '不用配 API Key，直接浏览完整分镜、设定卡与提示词。',
      cta: '看示例项目',
      to: '/',
    };
  } else if (!storyDone) {
    next = {
      label: '阶段 01 · 故事',
      title: '先写下你的故事与画风',
      detail: '填好故事梗概、画幅和风格后，后续设定和分镜才能对齐。',
      cta: '去写故事',
      to: '/guide',
    };
  } else if (!settingDone) {
    next = {
      label: '阶段 02 · 设定集',
      title:
        videoMode === 'scenic'
          ? '锁定视觉圣经与宏观环境'
          : videoMode === 'explainer'
            ? '锁定风格预设与视觉母题'
            : '补齐角色与场景设定',
      detail:
        videoMode === 'scenic'
          ? '先锁定摄影质感、光源方向与环境锚点，风光画面跨镜更稳定。'
          : videoMode === 'explainer'
            ? '先锁定插画风格预设与核心视觉母题，科普画面前后更统一。'
            : '先锁定角色服装和场景固定元素，跨镜出图更稳定。',
      cta: '去设定集',
      to:
        videoMode !== 'narrative'
          ? '/assets'
          : characters.length === 0
            ? '/characters'
            : '/scenes',
    };
  } else if (shots.length === 0) {
    next = {
      label: '阶段 03 · 分镜',
      title: '把故事拆成可执行分镜',
      detail: '每镜只写起点、一个动作、终点，可用 AI 自动生成初稿。',
      cta: '去生成分镜',
      to: '/storyboard',
    };
  } else if (errorCount > 0) {
    next = {
      label: '质检拦截',
      title: `先修这 ${errorCount} 个必改项`,
      detail: '这些问题会导致角色或场景前后穿帮，修完后再出图更省成本。',
      cta: `去修这 ${errorCount} 条`,
      to: '/storyboard?qc=1',
    };
  } else if (durationOff) {
    next = {
      label: '节奏校准',
      title: diff > 0 ? `总时长超出 ${fmtSeconds(diff)} 秒` : `总时长还差 ${fmtSeconds(-diff)} 秒`,
      detail: `当前 ${fmtSeconds(total)} 秒，目标 ${fmtSeconds(target)} 秒，在分镜时间轴调整。`,
      cta: '去调分镜',
      to: '/storyboard',
    };
  } else if (!coverage.loaded || !coverage.referencesReady) {
    next = {
      label: '阶段 02 · 参考图',
      title:
        videoMode === 'scenic'
          ? '先出齐宏观环境参考板'
          : videoMode === 'explainer'
            ? '先出齐虚拟讲解员形象图'
            : '先出齐角色形象图与场景参考板',
      detail: '参考图是分镜三帧的视觉锚点，先出齐能显著减少返工。',
      cta: '去设定集出图',
      to:
        charEnabled && coverage.charsReady < characters.length
          ? '/characters'
          : sceneEnabled
            ? '/scenes'
            : '/assets',
    };
  } else if (!framesAll) {
    next = {
      label: '阶段 03 · 关键帧',
      title: `补齐分镜三帧（${coverage.framesReady} / ${shots.length} 镜）`,
      detail: '按首帧、动作关键帧、尾帧顺序生成，锁住构图与人物。',
      cta: '去分镜出帧',
      to: '/storyboard',
    };
  } else {
    next = {
      label: '阶段 04 · 交付',
      title: '前期方案齐备，可以复制提示词并导出',
      detail: '在交付中心复制各平台提示词，并下载压缩包做好本机备份。',
      cta: '去交付中心',
      to: '/delivery',
    };
  }

  const previewShots = shots.slice(0, 6);

  return (
    <div className="home home-v2">
      {project ? (
        <>
          <header className="home-head">
            <div>
              <div className="home-crumb">
                {isSample ? '示例项目' : '当前项目'} · {VIDEO_MODE_SHORT_LABEL[videoMode]} ·{' '}
                {project.brief.aspectRatio}
              </div>
              <h1>{project.name}</h1>
              <p className="home-logline">{project.logline || '还没有填写一句话简介。'}</p>
              <p className="home-meta home-meta-icons">
                <span>
                  <Icon name="clock" size={13} />
                  {fmtSeconds(target)}s
                </span>
                <span>
                  <Icon name="movie" size={13} />
                  {shots.length} 镜
                </span>
                <span>{project.brief.platforms.map((p) => PLATFORM_LABEL[p]).join(' / ') || '未选平台'}</span>
              </p>
            </div>
            <div className="home-actions">
              <Link className="btn btn-sm" to="/delivery" title="交付中心">
                <Icon name="download" size={14} />
                <span>导出</span>
              </Link>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void startNewProject()}
                title="新建项目"
              >
                <Icon name="plus" size={14} />
                <span>新建</span>
              </button>
            </div>
          </header>

          {/* 区块 1：创作主线 + 唯一聚焦行动卡 */}
          <section className="home-command" aria-label="创作进度与下一步">
            <div className="stage-strip" aria-label="四步进度">
              {[
                {
                  key: 'story',
                  stepNo: '01',
                  name: '故事',
                  to: '/guide',
                  done: storyDone,
                  prevDone: true,
                  state: storyDone ? '已完成' : '待写',
                },
                {
                  key: 'setting',
                  stepNo: '02',
                  name: '设定集',
                  to: '/assets',
                  done: settingDone,
                  prevDone: storyDone,
                  state: settingDone
                    ? videoMode === 'scenic'
                      ? `${scenes.length}环境 · ${visualAssets.length}锚点`
                      : videoMode === 'explainer'
                        ? `${visualAssets.length}母题${charEnabled ? ` · ${characters.length}讲解员` : ''}`
                        : `${characters.length}角 · ${scenes.length}景`
                    : '待建立',
                },
                {
                  key: 'storyboard',
                  stepNo: '03',
                  name: '分镜与质检',
                  to: '/storyboard',
                  done: storyboardDone,
                  prevDone: settingDone,
                  state:
                    errorCount > 0
                      ? `${errorCount} 处必改`
                      : storyboardDone
                        ? '时长吻合'
                        : shots.length === 0
                          ? '待拆镜'
                          : diff > 0
                            ? `超 ${fmtSeconds(diff)} 秒`
                            : `差 ${fmtSeconds(-diff)} 秒`,
                },
                {
                  key: 'delivery',
                  stepNo: '04',
                  name: '交付中心',
                  to: '/delivery',
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
                  <span className="stage-step-name">
                    {step.stepNo} {step.name}
                  </span>
                  <span className="stage-step-state">{step.state}</span>
                </Link>
              ))}
            </div>

            <div className="next-card home-hero-next">
              <div className="home-hero-next-copy">
                <span className="next-label">{next.label}</span>
                <h2>{next.title}</h2>
                              </div>
              <div className="next-foot">
                <Link className="btn btn-blue" to={next.to}>
                  {next.cta}
                </Link>
              </div>
            </div>
          </section>

          {/* 区块 2：片子视觉预览台 + 可点击节奏条 */}
          <section className="panel shots-panel home-filmstrip-stage" aria-label="片子视觉预览">
            <div className="panel-head">
              <div>
                <h3>镜头预览</h3>
              </div>
              <Link to="/storyboard">全部 {shots.length} 镜 →</Link>
            </div>

            {previewShots.length > 0 ? (
              <div className="shot-grid home-shot-grid">
                {previewShots.map((shot) => {
                  const scene = scenes.find((s) => s.id === shot.sceneId);
                  const assets = gallery[shot.id] ?? [];
                  const thumb =
                    assets.find((a) => a.kind === 'first-frame' && a.dataUrl) ??
                    assets.find((a) => a.dataUrl);
                  const hasErr = shotErrorSet.has(shot.id);
                  return (
                    <Link
                      className={`shot-tile${hasErr ? ' has-error' : ''}`}
                      to={`/storyboard?shot=${shot.id}`}
                      key={shot.id}
                    >
                      <div className={`shot-tile-frame${thumb ? ' has-thumb' : ''}`}>
                        {thumb?.dataUrl ? (
                          <img
                            src={thumb.dataUrl}
                            alt={`第 ${shot.number} 镜首帧`}
                            className="shot-tile-img"
                          />
                        ) : null}
                        <div className="shot-tile-top">
                          <span>S{String(shot.number).padStart(2, '0')}</span>
                          <span>{shot.duration}s</span>
                        </div>
                        {!thumb?.dataUrl ? (
                          <p>{shot.action || shot.startState || '尚未填写这一镜动作。'}</p>
                        ) : null}
                        {hasErr ? <span className="shot-tile-alert">待修</span> : null}
                      </div>
                      <div className="shot-tile-meta">
                        <b>
                          {sceneEnabled
                            ? (scene?.name ?? (videoMode === 'scenic' ? '未选环境' : '未指定场景'))
                            : shot.onScreenLabels?.[0] || shot.visualMetaphor?.slice(0, 14) || '视觉隐喻镜头'}
                        </b>
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
                <Link to="/storyboard">去分镜与质检生成第一版 →</Link>
              </div>
            )}

            <div className="runtime">
              <div className="runtime-head">
                <span>时长节奏</span>
                <b>
                  {fmtSeconds(total)} <small>/ {fmtSeconds(target)} 秒</small>
                </b>
              </div>
              <div className="runtime-bars home-rhythm-track" role="list" aria-label="镜头时长分布">
                {shots.length > 0 ? (
                  shots.map((shot) => {
                    const dur = Math.max(Number(shot.duration) || 1, 0.5);
                    const hasErr = shotErrorSet.has(shot.id);
                    return (
                      <Link
                        key={shot.id}
                        to={`/storyboard?shot=${shot.id}`}
                        className={`home-rhythm-seg${hasErr ? ' is-error' : ''}`}
                        style={{ flexGrow: dur }}
                        title={`第 ${shot.number} 镜 · ${shot.duration} 秒${hasErr ? ' · 有必改项' : ''}`}
                      >
                        <span>{String(shot.number).padStart(2, '0')}</span>
                        <small>{shot.duration}s</small>
                      </Link>
                    );
                  })
                ) : (
                  <div className="home-rhythm-empty">添加镜头后这里会显示时长节奏分布</div>
                )}
              </div>
              <div className="runtime-foot">
                <span>
                  {shots.length} 个镜头 · 已出帧 {coverage.framesReady} 镜
                </span>
                <span>
                  {shots.length === 0
                    ? '尚未排时长'
                    : Math.abs(diff) <= tolerance
                      ? '时长吻合'
                      : diff > 0
                        ? `超出目标 ${fmtSeconds(diff)} 秒`
                        : `距离目标还差 ${fmtSeconds(-diff)} 秒`}
                </span>
              </div>
            </div>
          </section>

          {/* 区块 3：连贯性健康度三联卡 */}
          <section className="home-health-grid" aria-label="连贯性健康度">
            <div className="panel health-card">
              <div className="panel-head">
                <h3 className="icon-title"><Icon name="photo" size={14} />参考图</h3>
                <Link to="/assets">去设定集 →</Link>
              </div>
              <div className="assets">
                {videoMode !== 'narrative' ? (
                  <Link
                    className="asset"
                    to="/assets"
                    aria-label={`${videoMode === 'scenic' ? '视觉圣经与环境锚点' : '风格预设与视觉母题'} ${visualAssets.length} 项`}
                  >
                    <b>{visualAssets.length}</b>
                    <span>{videoMode === 'scenic' ? '视觉圣经/锚点' : '风格/视觉母题'}</span>
                  </Link>
                ) : null}
                {charEnabled ? (
                  <Link
                    className="asset"
                    to="/characters"
                    aria-label={`${videoMode === 'explainer' ? '虚拟讲解员' : '角色设定'}：形象图 ${coverage.charsReady} / ${characters.length}`}
                  >
                    <b>
                      {coverage.charsReady} / {characters.length}
                    </b>
                    <span>{videoMode === 'explainer' ? '虚拟讲解员' : '角色形象图'}</span>
                  </Link>
                ) : null}
                {sceneEnabled ? (
                  <Link
                    className="asset"
                    to="/scenes"
                    aria-label={`${videoMode === 'scenic' ? '宏观环境板' : '场景参考板'} ${coverage.scenesReady} / ${scenes.length}`}
                  >
                    <b>
                      {coverage.scenesReady} / {scenes.length}
                    </b>
                    <span>{videoMode === 'scenic' ? '宏观环境板' : '场景参考板'}</span>
                  </Link>
                ) : null}
              </div>
            </div>

            <Link className="panel panel-link health-card" to="/storyboard?qc=1">
              <div className="panel-head">
                <h3 className="icon-title"><Icon name="alert-triangle" size={14} />穿帮检查</h3>
                <span>打开质检 →</span>
              </div>
              <div className="check-total">
                <b className={errorCount > 0 ? 'bad' : ''}>{errorCount}</b>
                <span>
                  {errorCount > 0
                    ? `个必改项，另有 ${warningCount} 条建议`
                    : `个必改项，${warningCount} 条建议项`}
                </span>
              </div>
            </Link>

            <Link className="panel panel-link health-card save-panel" to="/export">
              <div className="panel-head">
                <h3 className="icon-title"><Icon name="device-floppy" size={14} />本机存档</h3>
                <span>去打包 →</span>
              </div>
              <div className="save-row">
                <span>保存状态</span>
                <b className={saveError ? 'bad' : ''}>
                  {saveError ? '没存上' : dirty ? '保存中…' : '已存本机'}
                </b>
              </div>
              {saveError ? <p className="asset-note">{saveError}</p> : null}
            </Link>
          </section>
        </>
      ) : (
        <>
          <header className="start-head">
            <h1>开始制作</h1>
          </header>

          <div className="start-grid">
            <section className="start-card start-card-create">
              <div className="start-card-top">
                <span>新作品</span>
              </div>
              <h2>创建新项目</h2>
              <div className="start-steps">
                <span>01 故事</span>
                <span>02 设定集</span>
                <span>03 分镜与质检</span>
                <span>04 交付中心</span>
              </div>
              <button type="button" className="btn btn-blue" onClick={openBlank}>
                <Icon name="plus" size={15} />
                <span>创建新项目</span>
              </button>
            </section>

            <section className="start-card start-card-import">
              <div className="start-card-top">
                <span>恢复备份</span>
              </div>
              <h2>导入项目</h2>
              <p className="start-quote">支持本工具导出的 .zip 压缩包或 项目数据.json，导入后自动存至本机。</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,.json,application/zip,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void handleImportFile(f);
                }}
              />
              {importError ? (
                <div className="issue error" style={{ marginBottom: 10 }}>
                  {importError}
                </div>
              ) : null}
              <button
                type="button"
                className="btn btn-primary"
                disabled={importing}
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="download" size={15} />
                <span>{importing ? '导入中…' : '选择文件导入'}</span>
              </button>
            </section>
          </div>

          <div className="start-sample-bar">
            <span>想先看成品结构？</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openSample()}>
              打开示例项目（林教头风雪山神庙） →
            </button>
          </div>
        </>
      )}

      {loaded && (records.length > 0 || listError || openError || deleteError) ? (
        <section className="saved-section" aria-label="本机已有项目">
          <div className="panel-head">
            <h3>本机已有项目（{records.length}）</h3>
          </div>
          {listError ? <div className="issue warning">{listError}</div> : null}
          {openError ? <div className="issue error">{openError}</div> : null}
          {deleteError ? <div className="issue error">{deleteError}</div> : null}
          {records.length > 0 ? (
            <div className="saved-table">
              <div className="saved-head">
                <span>项目名称</span>
                <span>最近修改</span>
                <span>操作</span>
              </div>
              {records.map((rec) => {
                const isCurrent = project?.id === rec.id;
                return (
                  <div className="saved-row" key={rec.id}>
                    <div className="saved-name">
                      <b>{rec.name}</b>
                      {isCurrent ? <span className="tag tag-ok">当前打开</span> : null}
                    </div>
                    <span className="saved-date">{fmtDate(rec.updatedAt)}</span>
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={isCurrent}
                        onClick={() => void open(rec.id)}
                      >
                        {isCurrent ? '已打开' : '打开'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm is-danger"
                        title="删除项目"
                        aria-label={`删除项目 ${rec.name}`}
                        onClick={() => {
                          if (window.confirm(`确定删除项目「${rec.name}」及关联图片？`)) {
                            void remove(rec.id);
                          }
                        }}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
