import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { RichText, SummaryBar } from '../components/bits';
import { AiFlowGuide } from '../components/AiFlowGuide';
import { AutoFixPanel } from '../components/AutoFixPanel';
import { Icon } from '../components/Icon';
import { SelectMenu } from '../components/SelectMenu';
import { useGeneration } from '../store/generation';
import { AssetGallery, AssetPeek, ImagePanel } from '../components/ImagePanel';
import { ShotExplainerSection } from '../components/storyboard/ShotExplainerSection';
import { StoryboardToolsDrawer } from '../components/storyboard/StoryboardToolsDrawer';
import { ShotGroupBar } from '../components/storyboard/ShotGroupBar';
import { ShotAudioStateFold } from '../components/storyboard/ShotAudioStateFold';
import { ShotVisualQaFold } from '../components/storyboard/ShotVisualQaFold';
import { useImage } from '../store/image';
import { useVideo, videoClipKey } from '../store/video';
import { VideoPanel } from '../components/VideoPanel';
import { VideoJobStrip } from '../components/VideoJobStrip';
import { CameraMoveHint, ShotSizeHint } from '../components/TermHint';
import {
  CAMERA_MOVE_LABEL,
  SHOT_SIZE_LABEL,
  type CameraMove,
  type CheckIssue,
  type CheckSeverity,
  type Shot,
  type ShotRenderEngine,
  type ShotSize,
} from '../types/model';
import {
  SHOT_RENDER_ENGINE_LABEL,
  SHOT_RENDER_ENGINES,
  VIDEO_MODE_SHORT_LABEL,
  isCharacterStageEnabled,
  isPhysicalSceneStageEnabled,
  resolveVideoMode,
} from '../domain/pipeline/profiles';
import { newId } from '../services/storage';
import { RULE_LABEL, SEVERITY_LABEL, SEVERITY_TAG, worstSeverity } from '../domain/checks';
import { FieldIssues, IssueBody, UnplacedIssues } from '../components/IssueViews';

function formatTimecode(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function closeMenu(event: MouseEvent<HTMLElement>): void {
  const details = event.currentTarget.closest('details');
  if (details) details.open = false;
}

const PLACED_FIELDS: ReadonlySet<string> = new Set([
  'duration',
  'shotSize',
  'sceneId',
  'action',
  'startState',
  'endState',
  'mood',
  'offscreenCharacters',
  'transitionType',
  'continuityNote',
  'activeLockIds',
]);

const SHOT_SIZE_OPTIONS: ShotSize[] = [
  'extreme-wide',
  'wide',
  'full',
  'medium',
  'close-up',
  'extreme-close-up',
];

const CAMERA_MOVE_OPTIONS: CameraMove[] = [
  'static',
  'push-in',
  'pull-out',
  'pan-left',
  'pan-right',
  'tilt-up',
  'tilt-down',
  'orbit',
  'tracking',
  'crane-up',
  'crane-down',
  'handheld',
];

function makeShot(number: number, sceneId: string): Shot {
  return {
    id: newId('shot'),
    number,
    duration: 3,
    shotSize: 'medium',
    cameraPosition: '',
    cameraMove: 'static',
    startState: '',
    action: '',
    endState: '',
    dialogue: '',
    sound: '',
    mood: '',
    transition: '硬切',
    sceneId,
    characterIds: [],
    variantIds: [],
    activeLockIds: [],
    offscreenCharacters: [],
    sourceSceneId: '',
  };
}

function FrameOrderHint({
  hasFirstFrame,
  hasActionPeak,
  hasEndFrame,
}: {
  hasFirstFrame: boolean;
  hasActionPeak: boolean;
  hasEndFrame: boolean;
}) {
  if (!hasFirstFrame && (hasActionPeak || hasEndFrame)) {
    return (
      <div className="issue warning" style={{ marginBottom: 10 }}>
        <div className="issue-title">建议先出首帧</div>
        <div className="issue-line">
          <RichText>
            {'首帧是**后两帧的构图锚点**，现在后两帧已经出了，机位可能对不上。建议先出首帧，再重出后两帧。'}
          </RichText>
        </div>
      </div>
    );
  }
  return null;
}

function inferTransitionType(
  previous:
    | {
        transitionType?: 'continuation' | 'cut';
        continuityNote?: string;
      }
    | undefined,
): 'continuation' | 'cut' {
  if (!previous) return 'cut';
  if (previous.transitionType) return previous.transitionType;
  const note = (previous.continuityNote ?? '').trim();
  if (note.length === 0) return 'cut';
  if (
    /直接切|切到|切换到|跳到|画面一转|镜头一转|第二天|次日|隔天|稍后|与此同时|另一边|回到|闪回/.test(
      note,
    )
  ) {
    return 'cut';
  }
  if (/接着|保持|继续|同一机位|同一个机位|不停|不断|紧接着|随即|顺势/.test(note)) {
    return 'continuation';
  }
  return 'cut';
}

/**
 * 分镜与质检工作台
 *
 * - 顶部吸顶全彩时间轴 + 内置质检与自动修复抽屉；
 * - 展开单镜采用左右双栏：左侧写三步脚本与防穿帮锚点，右侧生成三帧与 5 秒预览视频。
 */
export function StoryboardPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const shotParam = params.get('shot');
  const qcParam = params.get('qc');
  const project = useAppStore((s) => s.project);
  const report = useAppStore((s) => s.report);
  const refreshChecks = useAppStore((s) => s.refreshChecks);
  const upsertShot = useAppStore((s) => s.upsertShot);
  const removeShot = useAppStore((s) => s.removeShot);
  const moveShot = useAppStore((s) => s.moveShot);
  const generatingAssets = useGeneration((s) => s.pending === 'assets');
  const generatingShots = useGeneration((s) => s.pending === 'shots');
  const gallery = useImage((s) => s.gallery);
  const loadGallery = useImage((s) => s.loadGallery);
  const clips = useVideo((s) => s.clips);

  function galleryFor(refId: string) {
    return gallery[refId] ?? [];
  }

  const [expanded, setExpanded] = useState<string | null>(shotParam);
  const [located, setLocated] = useState<string | null>(shotParam);
  const [qcOpen, setQcOpen] = useState<boolean>(qcParam === '1');
  const toolsRef = useRef<HTMLDetailsElement>(null);

  const flaggedFields = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const issue of report?.issues ?? []) {
      if (issue.location.kind !== 'shot' || !issue.location.field) continue;
      const set = map.get(issue.location.id) ?? new Set<string>();
      set.add(issue.location.field);
      map.set(issue.location.id, set);
    }
    return map;
  }, [report]);

  const issuesByShot = useMemo(() => {
    const map = new Map<string, CheckIssue[]>();
    for (const issue of report?.issues ?? []) {
      if (issue.location.kind !== 'shot') continue;
      const list = map.get(issue.location.id) ?? [];
      list.push(issue);
      map.set(issue.location.id, list);
    }
    return map;
  }, [report]);

  useEffect(() => {
    for (const shot of project?.shots ?? []) void loadGallery(shot.id);
    void useVideo.getState().recoverJobs();
    for (const shot of project?.shots ?? []) {
      void useVideo.getState().getClip(project!.id, shot.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  useEffect(() => {
    if (!shotParam) return;
    setExpanded(shotParam);
    setLocated(shotParam);
    const timer = window.setTimeout(() => setLocated(null), 1800);
    return () => window.clearTimeout(timer);
  }, [shotParam]);

  useEffect(() => {
    if (qcParam === '1') setQcOpen(true);
  }, [qcParam]);

  if (!project) {
    return <div className="empty">还没有打开任何项目。先去作品主页新建或打开一个。</div>;
  }

  const total = project.shots.reduce(
    (s, x) => s + (Number.isFinite(x.duration) ? x.duration : 0),
    0,
  );
  const target = project.brief.targetDuration;
  const diff = total - target;
  const errorCount = report?.counts.error ?? 0;
  const warningCount = report?.counts.warning ?? 0;

  const shotSizeOptions = SHOT_SIZE_OPTIONS.map((s) => ({
    value: s,
    label: SHOT_SIZE_LABEL[s],
  }));
  const cameraMoveOptions = CAMERA_MOVE_OPTIONS.map((m) => ({
    value: m,
    label: CAMERA_MOVE_LABEL[m],
  }));
  const videoMode = resolveVideoMode(project);
  const charEnabled = isCharacterStageEnabled(project);
  const sceneEnabled = isPhysicalSceneStageEnabled(project);
  const visualAssets = project.visualAssets ?? [];

  const sceneOptions = [
    { value: '', label: videoMode === 'scenic' ? '（未选环境）' : '（未指定场景）' },
    ...project.scenes.map((s) => ({ value: s.id, label: s.name })),
  ];
  const renderEngineOptions = SHOT_RENDER_ENGINES.map((engine) => ({
    value: engine,
    label: SHOT_RENDER_ENGINE_LABEL[engine],
  }));
  const storySceneOptions = [
    { value: '', label: '（未指定）' },
    ...project.story.scenes.map((s) => ({ value: s.id, label: s.label })),
  ];
  const transitionOptions = [
    { value: 'continuation', label: '承接上一镜（连续动作）' },
    { value: 'cut', label: '跳切（换地方 / 跳时间）' },
  ];

  function isFlagged(shotId: string, field: string): boolean {
    return flaggedFields.get(shotId)?.has(field) ?? false;
  }

  function patch(shot: Shot, changes: Partial<Shot>) {
    upsertShot({ ...shot, ...changes });
  }

  function openShot(id: string) {
    setExpanded(id);
    setLocated(id);
    window.setTimeout(() => {
      document.getElementById(`shot-${id}`)?.scrollIntoView?.({
        block: 'start',
        behavior: 'smooth',
      });
    }, 60);
    window.setTimeout(() => setLocated(null), 1800);
  }

  function locateIssue(issue: CheckIssue) {
    const { kind, id } = issue.location;
    if (kind === 'shot') {
      openShot(id);
      return;
    }
    if (kind === 'character') navigate('/characters');
    else if (kind === 'scene') navigate('/scenes');
    else if (kind === 'story') navigate('/guide');
  }

  const shotStarts = project.shots.reduce<number[]>((starts, shot) => {
    const previous = starts[starts.length - 1] ?? 0;
    starts.push(previous + (Number.isFinite(shot.duration) ? shot.duration : 0));
    return starts;
  }, []);

  const severityGroups: CheckSeverity[] = ['error', 'warning', 'info'];

  return (
    <div className="storyboard-v2">
      <header className="page-head">
        <h1>
          分镜与质检
          {videoMode !== 'narrative' ? (
            <span className="tag" style={{ marginLeft: 8, verticalAlign: 'middle' }}>
              {VIDEO_MODE_SHORT_LABEL[videoMode]}
            </span>
          ) : null}
        </h1>
        <div className="row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              const shot = makeShot(
                project.shots.length + 1,
                sceneEnabled ? (project.scenes[0]?.id ?? '') : '',
              );
              upsertShot(
                videoMode === 'explainer'
                  ? { ...shot, renderEngine: 'ai_ref_to_video' }
                  : shot,
              );
              setExpanded(shot.id);
            }}
          >
            <Icon name="plus" size={14} />
            <span>镜头</span>
          </button>
          <button
            type="button"
            className={`btn btn-sm${qcOpen ? ' btn-primary' : ''}`}
            onClick={() => setQcOpen((v) => !v)}
            aria-expanded={qcOpen}
            title="穿帮质检与自动修复"
          >
            <Icon name="alert-triangle" size={14} />
            <span>质检</span>
            {errorCount > 0 ? (
              <span className="tag tag-error" style={{ marginLeft: 4 }}>
                {errorCount}
              </span>
            ) : warningCount > 0 ? (
              <span className="tag tag-warning" style={{ marginLeft: 4 }}>
                {warningCount}
              </span>
            ) : null}
          </button>
        </div>
      </header>

      <VideoJobStrip
        onLocate={(shotId) => {
          openShot(shotId);
        }}
      />

      <AiFlowGuide variant="compact" />

      <SummaryBar>
        <span>
          <b>{project.shots.length}</b> 镜 · 共 <b>{total}</b> 秒
        </span>
        <span style={{ color: 'var(--text-dim)' }}>目标 {target} 秒</span>
        {Math.abs(diff) > Math.max(target * 0.1, 2) ? (
          <span className={`tag ${diff > 0 ? 'tag-warning' : 'tag-info'}`}>
            {diff > 0 ? `超 ${Math.round(diff)} 秒` : `差 ${Math.round(-diff)} 秒`}
          </span>
        ) : project.shots.length > 0 ? (
          <span className="tag tag-ok">时长吻合</span>
        ) : null}
        {errorCount > 0 ? (
          <button
            type="button"
            className="tag tag-error"
            style={{ cursor: 'pointer' }}
            onClick={() => setQcOpen(true)}
          >
            {errorCount} 个必改项 · 点开处理
          </button>
        ) : project.shots.length > 0 ? (
          <span className="tag tag-ok">检查通过</span>
        ) : null}
        {generatingAssets ? (
          <span className="tag tag-info">
            {videoMode === 'scenic'
              ? '正在锁定视觉圣经与环境'
              : videoMode === 'explainer'
                ? '正在锁定风格预设与母题'
                : '正在拆角色与场景'}
          </span>
        ) : null}
      </SummaryBar>

      {project.shots.length > 0 ? (
        <div className="shot-strip" aria-label="分镜时间轴">
          <div className="shot-strip-ruler">
            <span>00:00</span>
            <span>{formatTimecode(total)}</span>
          </div>
          <div className="shot-strip-track">
            {project.shots.map((shot, index) => {
              const start = shotStarts[index] ?? 0;
              const duration = Number.isFinite(shot.duration) ? shot.duration : 0;
              const mustFix =
                issuesByShot.get(shot.id)?.filter((issue) => issue.severity === 'error').length ?? 0;
              const assets = galleryFor(shot.id);
              const hasFirst = assets.some((asset) => asset.kind === 'first-frame' && asset.dataUrl);
              const hasEnd = assets.some((asset) => asset.kind === 'end-frame' && asset.dataUrl);
              return (
                <button
                  type="button"
                  key={shot.id}
                  className={`shot-strip-seg${expanded === shot.id ? ' is-open' : ''}`}
                  style={{ flexGrow: Math.max(duration, 1) }}
                  onClick={() => openShot(shot.id)}
                  aria-label={`第 ${index + 1} 镜，${duration} 秒${
                    mustFix > 0 ? `，${mustFix} 个必改项` : ''
                  }`}
                  aria-current={expanded === shot.id ? 'true' : undefined}
                  title={`${formatTimecode(start)}–${formatTimecode(start + duration)} · ${duration} 秒 · 首帧${
                    hasFirst ? '有' : '无'
                  } · 尾帧${hasEnd ? '有' : '无'}${mustFix > 0 ? ` · ${mustFix} 个必改项` : ''}`}
                >
                  <span className="shot-strip-no">{String(index + 1).padStart(2, '0')}</span>
                  <span className="shot-strip-dur">{duration}s</span>
                  {mustFix > 0 ? <span className="shot-strip-dot" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <StoryboardToolsDrawer
        drawerRef={toolsRef}
        project={project}
        videoMode={videoMode}
        charEnabled={charEnabled}
      />

      {/* 内置穿帮质检与自动修复面板（折叠滑出，不离开分镜页） */}
      {qcOpen ? (
        <section className="card qc-drawer" aria-label="穿帮质检抽屉">
          <div className="qc-drawer-head">
            <div>
              <h2 className="card-title" style={{ marginBottom: 2 }}>
                穿帮质检与自动修复
              </h2>

            </div>
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={refreshChecks}>
                重新检查
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => navigate('/checks')}
              >
                全屏视图 →
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setQcOpen(false)}
              >
                收起
              </button>
            </div>
          </div>

          {report ? (
            <>
              <AutoFixPanel report={report} />
              {report.issues.length === 0 ? (
                <div className="empty" style={{ marginTop: 10 }}>
                  没有发现穿帮问题，可以继续出图或去交付中心导出。
                </div>
              ) : (
                <div className="qc-issue-list">
                  {severityGroups.map((sev) => {
                    const items = report.issues.filter((i) => i.severity === sev);
                    if (items.length === 0) return null;
                    return (
                      <div key={sev} className="qc-group">
                        <div className="qc-group-head">
                          <span className={SEVERITY_TAG[sev]}>{SEVERITY_LABEL[sev]}</span>
                          <span className="hint" style={{ margin: 0 }}>
                            {items.length} 条
                          </span>
                        </div>
                        {items.map((issue) => (
                          <div className={`issue issue-sev-${issue.severity}`} key={issue.id}>
                            <div className="issue-title">
                              <span className="tag">{RULE_LABEL[issue.ruleId] ?? issue.ruleId}</span>
                              <span className="issue-title-text">{issue.title}</span>
                              <button
                                type="button"
                                className="issue-go"
                                onClick={() => locateIssue(issue)}
                              >
                                {issue.location.kind === 'shot' ? '定位到镜头' : '去处理'}
                                <Icon name="arrow-right" size={12} className="issue-go-arrow" />
                              </button>
                            </div>
                            <IssueBody issue={issue} />
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="empty">
              还没有检查结果。
              <button
                type="button"
                className="btn btn-primary btn-sm"
                style={{ marginLeft: 10 }}
                onClick={refreshChecks}
              >
                立即检查
              </button>
            </div>
          )}
        </section>
      ) : null}

      {project.shots.length >= 2 && videoMode !== 'explainer' ? <ShotGroupBar /> : null}

      {project.shots.length === 0 ? (
        <div className="empty">
          还没有镜头。
          <div className="row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-blue"
              onClick={() => {
                const drawer = toolsRef.current;
                if (!drawer) return;
                drawer.open = true;
                drawer.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
              }}
            >
              用模型生成分镜
            </button>
          </div>
          {generatingShots ? <div style={{ marginTop: 8 }}>模型正在拆镜头，请稍等…</div> : null}
        </div>
      ) : null}

      <div className="shot-list">
        {project.shots.map((shot, index) => {
          const scene = project.scenes.find((s) => s.id === shot.sceneId);
          const prevShot = project.shots[index - 1];
          const locks = [
            ...(charEnabled
              ? project.characters.flatMap((c) =>
                  c.continuityLocks.filter((l) => shot.activeLockIds.includes(l.id)),
                )
              : []),
            ...(sceneEnabled
              ? project.scenes.flatMap((s) =>
                  s.continuityLocks.filter((l) => shot.activeLockIds.includes(l.id)),
                )
              : []),
          ];
          const open = expanded === shot.id;

          const shotIssues = issuesByShot.get(shot.id) ?? [];
          const byField = new Map<string, CheckIssue[]>();
          for (const issue of shotIssues) {
            const key = issue.location.field ?? '';
            const list = byField.get(key) ?? [];
            list.push(issue);
            byField.set(key, list);
          }
          const unplaced = shotIssues.filter(
            (issue) => !PLACED_FIELDS.has(issue.location.field ?? ''),
          );
          const worst = worstSeverity(shotIssues);
          const issuesOf = (field: string) => byField.get(field) ?? [];

          const extraIssuesCount = [
            'sound',
            'mood',
            'offscreenCharacters',
            'transition',
          ].reduce((count, field) => count + issuesOf(field).length, 0);

          const shotAssets = galleryFor(shot.id);
          const hasFirstFrame = shotAssets.some((a) => a.kind === 'first-frame' && a.dataUrl);
          const hasActionPeak = shotAssets.some((a) => a.kind === 'action-peak' && a.dataUrl);
          const hasEndFrame = shotAssets.some((a) => a.kind === 'end-frame' && a.dataUrl);

          return (
            <div
              className={`shot-card${located === shot.id ? ' shot-located' : ''}`}
              key={shot.id}
              id={`shot-${shot.id}`}
            >
              <div className="shot-head">
                <span className="shot-no">第 {shot.number} 镜</span>
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  aria-label="这一镜的时长，单位秒"
                  style={{ width: 68 }}
                  value={shot.duration}
                  onChange={(e) => patch(shot, { duration: Number(e.target.value) || 0 })}
                  className={isFlagged(shot.id, 'duration') ? 'field-flagged' : ''}
                />
                <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>秒</span>

                <SelectMenu
                  className={`shot-select${
                    isFlagged(shot.id, 'shotSize') ? ' field-flagged' : ''
                  }`}
                  value={shot.shotSize}
                  options={shotSizeOptions}
                  ariaLabel={`第 ${shot.number} 镜的景别`}
                  onChange={(value) => patch(shot, { shotSize: value as ShotSize })}
                />

                <SelectMenu
                  className="shot-select"
                  value={shot.cameraMove}
                  options={cameraMoveOptions}
                  ariaLabel={`第 ${shot.number} 镜的运镜`}
                  onChange={(value) => patch(shot, { cameraMove: value as CameraMove })}
                />

                {sceneEnabled ? (
                  <SelectMenu
                    className={`shot-select shot-scene-select${
                      isFlagged(shot.id, 'sceneId') ? ' field-flagged' : ''
                    }`}
                    value={shot.sceneId}
                    options={sceneOptions}
                    ariaLabel={`第 ${shot.number} 镜的${videoMode === 'scenic' ? '宏观环境' : '场景'}`}
                    onChange={(value) => patch(shot, { sceneId: value })}
                  />
                ) : (
                  <SelectMenu
                    className="shot-select shot-scene-select"
                    value={shot.renderEngine ?? 'ai_ref_to_video'}
                    options={renderEngineOptions}
                    ariaLabel={`第 ${shot.number} 镜的渲染方式`}
                    onChange={(value) =>
                      patch(shot, { renderEngine: value as ShotRenderEngine })
                    }
                  />
                )}

                <input
                  type="text"
                  className={`shot-action${isFlagged(shot.id, 'action') ? ' field-flagged' : ''}`}
                  value={shot.action}
                  onChange={(e) => patch(shot, { action: e.target.value })}
                  placeholder="一句话写清这一镜的动作"
                  aria-label={`第 ${shot.number} 镜的动作`}
                  title="这一镜只做一件事"
                />

                <AssetPeek assets={shotAssets} />

                {clips[videoClipKey(project.id, shot.id)] ? (
                  <button
                    type="button"
                    className="video-badge"
                    aria-label={`第 ${shot.number} 镜已有视频，点开查看`}
                    onClick={() => setExpanded(shot.id)}
                  >
                    <Icon name="player-play" size={12} /> 5s
                  </button>
                ) : null}

                {worst ? (
                  <button
                    type="button"
                    className={`${SEVERITY_TAG[worst]} issue-badge`}
                    onClick={() => setExpanded(shot.id)}
                    title="点开查看这一镜的穿帮问题"
                  >
                    {shotIssues.length} 处要改
                  </button>
                ) : null}

                <details className="shot-menu">
                  <summary className="shot-menu-toggle" aria-label="更多操作" title="上移、下移、删除">
                    ⋯
                  </summary>
                  <div className="shot-menu-body">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={(event) => {
                        closeMenu(event);
                        moveShot(shot.id, -1);
                      }}
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      disabled={index === project.shots.length - 1}
                      onClick={(event) => {
                        closeMenu(event);
                        moveShot(shot.id, 1);
                      }}
                    >
                      下移
                    </button>
                    <button
                      type="button"
                      className="shot-menu-danger"
                      onClick={(event) => {
                        closeMenu(event);
                        if (window.confirm(`删除第 ${shot.number} 镜？`)) removeShot(shot.id);
                      }}
                    >
                      删除这一镜
                    </button>
                  </div>
                </details>

                <button
                  type="button"
                  className="btn btn-ghost btn-icon expand-toggle"
                  aria-expanded={open}
                  aria-controls={`shot-more-${shot.id}`}
                  aria-label={open ? '收起这一镜' : '展开这一镜'}
                  title={open ? '收起' : '展开'}
                  onClick={() => setExpanded(open ? null : shot.id)}
                >
                  <Icon name="chevron-right" size={15} className="expand-chevron" />
                </button>
              </div>

              {shotIssues.length > 0 ? (
                <div className="shot-head-issues">
                  <FieldIssues issues={issuesOf('duration')} label="时长" />
                  <FieldIssues issues={issuesOf('shotSize')} label="景别" />
                  <FieldIssues issues={issuesOf('sceneId')} label="场景" />
                  <FieldIssues issues={issuesOf('action')} label="动作" />
                  <UnplacedIssues
                    issues={unplaced}
                    placed={shotIssues.length - unplaced.length}
                  />
                </div>
              ) : null}

              {/* 展开态：左文字脚本 + 右生图生视频 双栏工作台 */}
              {open ? (
                <div className="shot-more shot-workspace" id={`shot-more-${shot.id}`}>
                  {/* 左栏：三步文字脚本 + 防穿帮锚点 + 进阶折叠 */}
                  <div className="shot-script-col">
                    <div className="shot-flow-group">
                      <div className="shot-block-label">
                        <Icon name="photo" size={14} />
                        <span>三步脚本</span>
                      </div>

                      <div className="shot-flow-step">
                        <div className="shot-flow-head">
                          <span className="shot-step-badge">① 起点</span>
                          <span className="shot-step-tip">
                            {videoMode === 'scenic'
                              ? '自然主体初始状态'
                              : videoMode === 'explainer'
                                ? '概念隐喻开场画面'
                                : '开场静止画面'}
                          </span>
                        </div>
                        <textarea
                          rows={2}
                          aria-label="这一镜的起点"
                          value={shot.startState}
                          onChange={(e) => patch(shot, { startState: e.target.value })}
                          className={isFlagged(shot.id, 'startState') ? 'field-flagged' : ''}
                          placeholder={
                            videoMode === 'scenic'
                              ? '例：清晨阿尔卑斯松针尖端悬着一颗露珠，金色光束穿透薄雾'
                              : videoMode === 'explainer'
                                ? '例：深蓝画布中央悬浮两枚发光几何球体，由青色虚线波形相连'
                                : '例：大雪夜山神庙门内，林冲手按花枪杆站在门后'
                          }
                        />
                        <FieldIssues issues={issuesOf('startState')} label="起点" />
                      </div>

                      <div className="shot-flow-step">
                        <div className="shot-flow-head">
                          <span className="shot-step-badge">② 动作</span>
                          <span className="shot-step-tip">
                            {videoMode === 'scenic'
                              ? '主物理与次级环境运动'
                              : videoMode === 'explainer'
                                ? '概念推演或图形动效'
                                : '本镜唯一动作'}
                          </span>
                        </div>
                        <textarea
                          rows={2}
                          aria-label={`第 ${shot.number} 镜的动作详细`}
                          value={shot.action}
                          onChange={(e) => patch(shot, { action: e.target.value })}
                          className={isFlagged(shot.id, 'action') ? 'field-flagged' : ''}
                          placeholder={
                            videoMode === 'scenic'
                              ? '例：露珠滑落至青苔岩石，溅起微雾，松针随之轻颤'
                              : videoMode === 'explainer'
                                ? '例：左侧球体亮起并展开图标标注，右侧球体同步翻面但无信号传递箭头'
                                : '例：他猛地拉开木门，提枪跨出门槛'
                          }
                        />
                        <FieldIssues issues={issuesOf('action')} label="动作" />
                      </div>

                      <div className="shot-flow-step">
                        <div className="shot-flow-head">
                          <span className="shot-step-badge">③ 终点</span>
                          <span className="shot-step-tip">
                            {videoMode === 'scenic'
                              ? '镜头收尾自然状态'
                              : videoMode === 'explainer'
                                ? '本节拍画面定格'
                                : '收尾定格姿态'}
                          </span>
                        </div>
                        <textarea
                          rows={2}
                          aria-label="这一镜的终点"
                          value={shot.endState}
                          onChange={(e) => patch(shot, { endState: e.target.value })}
                          className={isFlagged(shot.id, 'endState') ? 'field-flagged' : ''}
                          placeholder={
                            videoMode === 'scenic'
                              ? '例：湿润青苔在暖金晨光下反光，山谷薄雾缓缓飘散'
                              : videoMode === 'explainer'
                                ? '例：两枚球体并列定格，下方浮现 3 个词的简洁结论标注'
                                : '例：林冲立于门外风雪中，枪尖斜指前方'
                          }
                        />
                        <FieldIssues issues={issuesOf('endState')} label="终点" />
                      </div>
                    </div>

                    {videoMode === 'explainer' ? (
                      <ShotExplainerSection shot={shot} onPatch={(changes) => patch(shot, changes)} />
                    ) : null}

                    {/* 防穿帮锚点区 */}
                    <div className="shot-continuity-box">
                      <div className="shot-block-label">
                        <Icon name="lock" size={14} />
                        <span>
                          {videoMode === 'scenic'
                            ? '风光连贯锚点'
                            : videoMode === 'explainer'
                              ? '视觉母题与风格锚点'
                              : '防穿帮锚点'}
                        </span>
                      </div>

                      {charEnabled ? (
                        <div className="shot-anchor-row">
                          <div className="field-label">
                            {videoMode === 'explainer' ? '虚拟讲解员' : '出镜角色'}
                          </div>
                          <div className="row" style={{ gap: 6 }}>
                            {project.characters.length === 0 ? (
                              <span className="hint">
                                {videoMode === 'explainer'
                                  ? '还没有虚拟讲解员，去设定集新建。'
                                  : '还没有角色，去设定集新建。'}
                              </span>
                            ) : (
                              project.characters.map((c) => {
                                const on = shot.characterIds.includes(c.id);
                                return (
                                  <button
                                    key={c.id}
                                    type="button"
                                    className={`btn btn-sm${on ? ' btn-primary' : ''}`}
                                    onClick={() =>
                                      patch(shot, {
                                        characterIds: on
                                          ? shot.characterIds.filter((x) => x !== c.id)
                                          : [...shot.characterIds, c.id],
                                      })
                                    }
                                  >
                                    {c.name}
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      ) : null}

                      {videoMode !== 'narrative' ? (
                        <div className="shot-anchor-row">
                          <div className="field-label">
                            {videoMode === 'scenic' ? '环境与风格标签' : '引用视觉母题'}
                          </div>
                          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            {visualAssets.length === 0 ? (
                              <span className="hint">
                                {videoMode === 'scenic'
                                  ? '还没有环境锚点标签，去设定集或顶部先锁定视觉圣经。'
                                  : '还没有非人物视觉母题，去设定集或顶部先锁定风格预设与母题。'}
                              </span>
                            ) : (
                              visualAssets.map((asset) => {
                                const tags = shot.referencedAssetTags ?? [];
                                const on = tags.includes(asset.tag);
                                return (
                                  <button
                                    key={asset.id}
                                    type="button"
                                    className={`btn btn-sm${on ? ' btn-primary' : ''}`}
                                    onClick={() =>
                                      patch(shot, {
                                        referencedAssetTags: on
                                          ? tags.filter((t) => t !== asset.tag)
                                          : [...tags, asset.tag],
                                      })
                                    }
                                    title={asset.visualPrompt}
                                  >
                                    {asset.name}（{asset.tag}）
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      ) : null}

                      {charEnabled || sceneEnabled ? (
                        <div className="shot-anchor-row">
                          <div className="field-label">连续性锁</div>
                          <FieldIssues issues={issuesOf('activeLockIds')} label="连续性锁" />
                          <div className="row" style={{ gap: 6 }}>
                            {(!charEnabled ||
                              project.characters.every((c) => c.continuityLocks.length === 0)) &&
                            (!sceneEnabled ||
                              project.scenes.every((s) => s.continuityLocks.length === 0)) ? (
                              <span className="hint">还没有连续性锁，去设定集里添加。</span>
                            ) : (
                              <>
                                {charEnabled
                                  ? project.characters.flatMap((c) =>
                                      c.continuityLocks.map((lock) => {
                                        const on = shot.activeLockIds.includes(lock.id);
                                        return (
                                          <button
                                            key={lock.id}
                                            type="button"
                                            className={`btn btn-sm${on ? ' btn-primary' : ''}`}
                                            onClick={() =>
                                              patch(shot, {
                                                activeLockIds: on
                                                  ? shot.activeLockIds.filter((x) => x !== lock.id)
                                                  : [...shot.activeLockIds, lock.id],
                                              })
                                            }
                                            title={lock.phrase}
                                          >
                                            {c.name}·{lock.label}
                                          </button>
                                        );
                                      }),
                                    )
                                  : null}
                                {sceneEnabled
                                  ? project.scenes.flatMap((s) =>
                                      s.continuityLocks.map((lock) => {
                                        const on = shot.activeLockIds.includes(lock.id);
                                        return (
                                          <button
                                            key={lock.id}
                                            type="button"
                                            className={`btn btn-sm${on ? ' btn-primary' : ''}`}
                                            onClick={() =>
                                              patch(shot, {
                                                activeLockIds: on
                                                  ? shot.activeLockIds.filter((x) => x !== lock.id)
                                                  : [...shot.activeLockIds, lock.id],
                                              })
                                            }
                                            title={lock.phrase}
                                          >
                                            {s.name}·{lock.label}
                                          </button>
                                        );
                                      }),
                                    )
                                  : null}
                              </>
                            )}
                          </div>
                          {locks.length > 0 ? (
                            <details className="why shot-lock-details">
                              <summary>已锁定 {locks.length} 条英文短语</summary>
                              <div className="why-body">
                                {locks.map((l) => (
                                  <code key={l.id} style={{ marginRight: 6 }}>
                                    {l.phrase}
                                  </code>
                                ))}
                              </div>
                            </details>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="grid-2" style={{ marginTop: 10 }}>
                        <div>
                          <div className="field-label">与上一镜转场</div>
                          <SelectMenu
                            className="transition-select"
                            value={
                              shot.transitionType ??
                              (index === 0 ? 'cut' : inferTransitionType(prevShot))
                            }
                            options={transitionOptions}
                            disabled={index === 0}
                            ariaLabel={`第 ${shot.number} 镜与上一镜的转场`}
                            onChange={(value) =>
                              patch(shot, {
                                transitionType: value as 'continuation' | 'cut',
                              })
                            }
                          />
                          <div className="field-help">承接 = 锚定上镜尾帧</div>
                          <FieldIssues issues={issuesOf('transitionType')} label="转场类型" />
                        </div>

                        <div>
                          <div className="field-label">下一镜衔接说明</div>
                          <input
                            type="text"
                            aria-label="这一镜和下一镜的衔接"
                            value={shot.continuityNote ?? ''}
                            onChange={(e) => patch(shot, { continuityNote: e.target.value })}
                            placeholder="例：保持姿势，下一镜从同机位推进"
                          />
                          <FieldIssues issues={issuesOf('continuityNote')} label="衔接" />
                        </div>
                      </div>

                      {sceneEnabled && scene ? (
                        <details className="why shot-scene">
                          <summary>
                            {videoMode === 'scenic' ? '当前宏观环境约束' : '当前场景约束'}：{scene.name}
                          </summary>
                          <div className="why-body">
                            固定元素：
                            {scene.fixedElements.length > 0
                              ? scene.fixedElements.map((el) => (
                                  <code key={el} style={{ marginRight: 6 }}>
                                    {el}
                                  </code>
                                ))
                              : '（未登记）'}
                            <br />
                            主光：{scene.lightDirection || '未填'} · 主色调：
                            {scene.mainColor || '未填'}
                          </div>
                        </details>
                      ) : null}

                      {videoMode !== 'narrative' && project.visualBible ? (
                        <details className="why shot-scene">
                          <summary>
                            {videoMode === 'scenic'
                              ? '全局视觉圣经约束（每镜自动注入）'
                              : '全局风格预设铁律（每镜自动注入）'}
                          </summary>
                          <div className="why-body">
                            风格锚点：{project.visualBible.styleAnchor || '未填'}
                            <br />
                            光源方向：{project.visualBible.lightingDirection || '未填'}
                            <br />
                            风格铁律：{project.visualBible.styleExclusionRule || '未填'}
                          </div>
                        </details>
                      ) : null}
                    </div>

                    {/* 进阶视听与机位：默认折叠，减少初学负担 */}
                    <details className="card-fold shot-extras">
                      <summary>
                        <span className="card-fold-title">
                          {videoMode === 'scenic'
                            ? '机位 · 环境音景 · 氛围'
                            : videoMode === 'explainer'
                              ? '机位 · 音效 · 章节 · 转场'
                              : '机位 · 台词 · 声音 · 情绪'}
                        </span>
                        {extraIssuesCount > 0 ? (
                          <span className="tag tag-warning">{extraIssuesCount} 处要改</span>
                        ) : (
                          <span className="card-fold-count">选填</span>
                        )}
                      </summary>
                      <div className="shot-extras-body">
                        <div className="shot-head-guides" style={{ marginBottom: 10 }}>
                          <ShotSizeHint value={shot.shotSize} />
                          <CameraMoveHint value={shot.cameraMove} />
                        </div>
                        <div className="grid-2">
                          <div>
                            <div className="field-label">机位</div>
                            <input
                              type="text"
                              aria-label="这一镜的机位"
                              value={shot.cameraPosition}
                              onChange={(e) => patch(shot, { cameraPosition: e.target.value })}
                              placeholder={
                                videoMode === 'scenic'
                                  ? '例：50mm 中焦，低角度贴近地面'
                                  : videoMode === 'explainer'
                                    ? '例：居中平视信息图视角'
                                    : '例：略低角度，仰拍人物'
                              }
                            />
                          </div>
                          {videoMode !== 'explainer' ? (
                            <div>
                              <div className="field-label">
                                {videoMode === 'scenic' ? '纪录片旁白（可选）' : '台词 / 旁白'}
                              </div>
                              <input
                                type="text"
                                aria-label="这一镜的台词或旁白"
                                value={shot.dialogue}
                                onChange={(e) => patch(shot, { dialogue: e.target.value })}
                              />
                            </div>
                          ) : null}
                          <div>
                            <div className="field-label">
                              {videoMode === 'scenic' ? '原生环境音景' : '声音'}
                            </div>
                            <input
                              type="text"
                              aria-label="这一镜的声音"
                              value={shot.sound}
                              onChange={(e) => patch(shot, { sound: e.target.value })}
                              placeholder={
                                videoMode === 'scenic'
                                  ? '例：松涛风声、露珠滴落、溪流回响'
                                  : '环境音 / 音效'
                              }
                            />
                          </div>
                          <div>
                            <div className="field-label">
                              {videoMode === 'scenic' ? '光影氛围' : '情绪'}
                            </div>
                            <input
                              type="text"
                              aria-label="这一镜的情绪"
                              value={shot.mood}
                              onChange={(e) => patch(shot, { mood: e.target.value })}
                            />
                            <FieldIssues issues={issuesOf('mood')} label="情绪" />
                          </div>
                          {charEnabled ? (
                            <div>
                              <div className="field-label">画外人物</div>
                              <input
                                type="text"
                                aria-label="这一镜的画外人物，用顿号分隔"
                                value={shot.offscreenCharacters.join('、')}
                                onChange={(e) =>
                                  patch(shot, {
                                    offscreenCharacters: e.target.value
                                      .split(/[、,，\s]+/)
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                  })
                                }
                                placeholder="只在声音里出现的人，用、分隔"
                              />
                              <FieldIssues issues={issuesOf('offscreenCharacters')} label="画外人物" />
                            </div>
                          ) : null}
                          <div>
                            <div className="field-label">
                              {videoMode === 'scenic'
                                ? '所属视觉段落'
                                : videoMode === 'explainer'
                                  ? '所属概念章节'
                                  : '来源场次'}
                            </div>
                            <SelectMenu
                              className="source-scene-select"
                              value={shot.sourceSceneId}
                              options={storySceneOptions}
                              ariaLabel={`第 ${shot.number} 镜的来源场次`}
                              onChange={(value) => patch(shot, { sourceSceneId: value })}
                            />
                          </div>
                          <div>
                            <div className="field-label">剪辑转场备注</div>
                            <input
                              type="text"
                              aria-label="这一镜的转场说明"
                              value={shot.transition}
                              onChange={(e) => patch(shot, { transition: e.target.value })}
                            />
                          </div>
                        </div>
                      </div>
                    </details>

                    <ShotAudioStateFold
                      project={project}
                      shot={shot}
                      onPatch={(changes) => patch(shot, changes)}
                    />
                    <ShotVisualQaFold
                      project={project}
                      shot={shot}
                      shotAssets={gallery[shot.id] ?? []}
                      gallery={gallery}
                    />
                  </div>

                  {/* 右栏：三帧视觉监视器 + 5 秒预览视频 */}
                  <div className="shot-visual-col shot-output">
                    <div className="shot-frame-pipeline" aria-label="三帧生成顺序">
                      <span className={`frame-pip${hasFirstFrame ? ' is-ready' : ''}`}>
                        ① 首帧
                      </span>
                      <span className="frame-pip-arrow" aria-hidden="true">
                        →
                      </span>
                      <span className={`frame-pip${hasActionPeak ? ' is-ready' : ''}`}>
                        ② 关键帧
                      </span>
                      <span className="frame-pip-arrow" aria-hidden="true">
                        →
                      </span>
                      <span className={`frame-pip${hasEndFrame ? ' is-ready' : ''}`}>
                        ③ 尾帧
                      </span>
                    </div>

                    <div className="shot-frames" id={`shot-frames-${shot.id}`}>
                      <ImagePanel
                        refId={shot.id}
                        target="frame"
                        label="这一镜的三帧"
                        options={[
                          {
                            label: '① 首帧',
                            useReference: false,
                            frameKind: 'first-frame',
                          },
                          {
                            label: charEnabled
                              ? '① 首帧（锁角色）'
                              : videoMode === 'scenic'
                                ? '① 首帧（锚定环境）'
                                : '① 首帧（带风格参考）',
                            useReference: true,
                            frameKind: 'first-frame',
                          },
                          {
                            label: '② 动作关键帧',
                            useReference: true,
                            frameKind: 'action-peak',
                          },
                          {
                            label: '③ 尾帧',
                            useReference: true,
                            frameKind: 'end-frame',
                          },
                        ]}
                        footer={
                          <>
                            <FrameOrderHint
                              hasFirstFrame={hasFirstFrame}
                              hasActionPeak={hasActionPeak}
                              hasEndFrame={hasEndFrame}
                            />
                            <AssetGallery
                              assets={shotAssets}
                              emptyHint="先生成 ① 首帧锁住构图，再出动作关键帧与尾帧。"
                            />
                          </>
                        }
                      />
                    </div>

                    <VideoPanel
                      shot={shot}
                      project={project}
                      onJumpToFrames={() => {
                        setExpanded(shot.id);
                        window.requestAnimationFrame(() => {
                          document
                            .getElementById(`shot-frames-${shot.id}`)
                            ?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
                        });
                      }}
                    />

                    <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => navigate(`/prompts?shot=${shot.id}`)}
                      >
                        <Icon name="terminal" size={13} />
                        <span>提示词</span>
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
