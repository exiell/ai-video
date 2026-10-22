import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { SummaryBar } from '../components/bits';
import { RichText } from '../components/bits';
import { GenerateBar } from '../components/GenerateBar';
import { AiFlowGuide } from '../components/AiFlowGuide';
import { Icon } from '../components/Icon';
import { SelectMenu } from '../components/SelectMenu';
import { useGeneration } from '../store/generation';
import { AssetGallery, AssetPeek, ImagePanel } from '../components/ImagePanel';
import { BatchGenerateCard } from '../components/BatchGenerateCard';
import { useImage } from '../store/image';
import { CameraMoveHint, ShotSizeHint } from '../components/TermHint';
import {
  CAMERA_MOVE_LABEL,
  SHOT_SIZE_LABEL,
  type CameraMove,
  type Shot,
  type ShotSize,
} from '../types/model';
import { newId } from '../services/storage';
import { PLATFORM_MAX_DURATION } from '../domain/checks/storyboard';
import { SEVERITY_TAG, worstSeverity } from '../domain/checks';
import { FieldIssues, UnplacedIssues } from '../components/IssueViews';
import type { CheckIssue } from '../types/model';

function formatTimecode(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

/**
 * M2 分镜表编辑器（方案.md v0.6 §3.2）
 *
 * 这是整个工具用得最久的界面，因此三条设计取舍：
 * 1. 全部字段直接内联编辑，不做「点开弹窗才能改」——新手最怕找不到东西在哪
 * 2. 总时长实时统计并常驻顶部——时长对不上是新手最常见的问题
 * 3. 出问题的字段描边高亮，**就在字段下面点开看原因**（v0.48）
 *
 * 第 3 条原来是「点一下跳到穿帮检查看原因」。跳过去要离开这一页，
 * 看完再跳回来，改一镜来回两趟；而检查结果本来就在 store 里，
 * 是纯本地算出来的，没有理由不在出错的地方直接摊开。
 */

/**
 * 这些字段在本页有可编辑控件，问题标记贴在字段下面。
 * 不在这张表里的（比如 `variantIds` 要去角色页改）走 `UnplacedIssues`，
 * 汇总在镜头标题下面——不因为「找不到地方贴」就丢掉。
 */
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

/**
 * 三帧的生成顺序提示。
 *
 * ===========================================================================
 * 为什么顺序重要
 * ===========================================================================
 * 首帧不只是「第一张图」——它是**后两帧的构图锚点**。
 * 生成动作关键帧与尾帧时会把首帧当参考图传进去，从而锁住机位、景别、
 * 光线方向与人物在画面里的位置。
 *
 * 反过来先出尾帧的话，它就没有锚点，机位可能和后来的首帧对不上，
 * 三张图放一起不像同一个镜头。这种情况用户很难自己诊断出来，
 * 所以要在界面上直接说清。
 */
function FrameOrderHint({
  hasFirstFrame,
  hasActionPeak,
  hasEndFrame,
}: {
  hasFirstFrame: boolean;
  hasActionPeak: boolean;
  hasEndFrame: boolean;
}) {
  // 首帧还没有，但已经出了后两帧 —— 顺序反了
  if (!hasFirstFrame && (hasActionPeak || hasEndFrame)) {
    return (
      <div className="issue warning" style={{ marginBottom: 10 }}>
        <div className="issue-title">建议先出「首帧」</div>
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

/**
 * 按上一镜的衔接说明推断转场类型，作为**默认值**。
 *
 * 只是默认值——模型与关键词都可能判错，而判错的代价很实：
 * 跳切时误判为承接，会把上一镜的尾帧当参考图，两个镜头就被焊在一起了。
 * 所以界面上做成一个可一键覆盖的下拉框，而不是隐藏的自动行为。
 */
function inferTransitionType(previous: {
  transitionType?: 'continuation' | 'cut';
  continuityNote?: string;
} | undefined): 'continuation' | 'cut' {
  if (!previous) return 'cut';
  if (previous.transitionType) return previous.transitionType;
  const note = (previous.continuityNote ?? '').trim();
  if (note.length === 0) return 'cut';
  if (/直接切|切到|切换到|跳到|画面一转|镜头一转|第二天|次日|隔天|稍后|与此同时|另一边|回到|闪回/.test(note)) {
    return 'cut';
  }
  if (/接着|保持|继续|同一机位|同一个机位|不停|不断|紧接着|随即|顺势/.test(note)) {
    return 'continuation';
  }
  return 'cut';
}

export function StoryboardPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const shotParam = params.get('shot');
  const project = useAppStore((s) => s.project);
  const report = useAppStore((s) => s.report);
  const upsertShot = useAppStore((s) => s.upsertShot);
  const removeShot = useAppStore((s) => s.removeShot);
  const moveShot = useAppStore((s) => s.moveShot);
  const generatingAssets = useGeneration((s) => s.pending === 'assets');
  const generatingShots = useGeneration((s) => s.pending === 'shots');
  const gallery = useImage((s) => s.gallery);
  const loadGallery = useImage((s) => s.loadGallery);

  function galleryFor(refId: string) {
    return gallery[refId] ?? [];
  }
  const [expanded, setExpanded] = useState<string | null>(params.get('shot'));
  const [located, setLocated] = useState<string | null>(params.get('shot'));

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

  /**
   * 每一镜的全部问题，按镜头 id 分组。
   *
   * `report` 在每次改项目时由 store 重算（不是只在检查页刷新），
   * 所以这里的标记是跟着输入实时变的，不会出现「改完了还标着」。
   */
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
    // 只在**项目切换**时重新载入图库。
    //
    // 【v0.28 修】原来的依赖是 `project?.shots` / `project?.characters` 这类数组，
    // 而每次编辑都会产生新数组 → 每敲一个字符都重跑一次；
    // 而这里会为**每一个对象**调一次 listAssetsFor，等于一次按键做 N 次查询。
    // 一张图几 MB base64，20 个对象就是几十 MB 的反序列化，表现为打字卡顿。
    //
    // 依赖收成 project.id 之后：换项目时才重载；出图完成后由出图流程刷新。
    for (const shot of project?.shots ?? []) void loadGallery(shot.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // 从检查页或作品主页跳到某一镜时，短暂高亮一下，避免用户落地后找不到目标。
  useEffect(() => {
    if (!shotParam) return;
    setExpanded(shotParam);
    setLocated(shotParam);
    const timer = window.setTimeout(() => setLocated(null), 1800);
    return () => window.clearTimeout(timer);
  }, [shotParam]);

  if (!project) {
    return <div className="empty">还没有打开任何项目。先去「作品主页」新建或打开一个。</div>;
  }

  const total = project.shots.reduce((s, x) => s + (Number.isFinite(x.duration) ? x.duration : 0), 0);
  const target = project.brief.targetDuration;
  const diff = total - target;
  const maxPerShot = Math.max(
    ...project.brief.platforms.map((p) => PLATFORM_MAX_DURATION[p] ?? 10),
    10,
  );

  const shotSizeOptions = SHOT_SIZE_OPTIONS.map((s) => ({
    value: s,
    label: SHOT_SIZE_LABEL[s],
  }));
  const cameraMoveOptions = CAMERA_MOVE_OPTIONS.map((m) => ({
    value: m,
    label: CAMERA_MOVE_LABEL[m],
  }));
  const sceneOptions = [
    { value: '', label: '（未指定场景）' },
    ...project.scenes.map((s) => ({ value: s.id, label: s.name })),
  ];
  const storySceneOptions = [
    { value: '', label: '（未指定）' },
    ...project.story.scenes.map((s) => ({ value: s.id, label: s.label })),
  ];
  const transitionOptions = [
    { value: 'continuation', label: '承接上一镜（连续动作）' },
    { value: 'cut', label: '跳切（换地方／跳时间／有意断开）' },
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

  const shotStarts = project.shots.reduce<number[]>((starts, shot) => {
    const previous = starts[starts.length - 1] ?? 0;
    starts.push(previous + (Number.isFinite(shot.duration) ? shot.duration : 0));
    return starts;
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>分镜表</h1>
          <p>一镜只做一件事：起点 → 动作 → 终点。</p>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn"
            onClick={() => {
              const shot = makeShot(
                project.shots.length + 1,
                project.scenes[0]?.id ?? '',
              );
              upsertShot(shot);
              setExpanded(shot.id);
            }}
          >
            + 加一个镜头
          </button>
          <button type="button" className="btn" onClick={() => navigate('/checks')}>
            去穿帮检查
          </button>
        </div>
      </div>

      {/* AI 流程指引：只显示「当前该做哪一步」，全做完就自动消失 */}
      <AiFlowGuide variant="compact" />

      <SummaryBar>
        <span>
          共 <b>{project.shots.length}</b> 镜
        </span>
        <span>
          总时长 <b>{total}</b> 秒
        </span>
        <span style={{ color: 'var(--text-dim)' }}>目标 {target} 秒</span>
        {Math.abs(diff) > Math.max(target * 0.1, 2) ? (
          <span className={`tag ${diff > 0 ? 'tag-warning' : 'tag-info'}`}>
            {diff > 0 ? `超 ${Math.round(diff)} 秒` : `差 ${Math.round(-diff)} 秒`}
          </span>
        ) : project.shots.length > 0 ? (
          <span className="tag tag-ok">时长吻合</span>
        ) : null}
        {report && report.counts.error > 0 ? (
          <span className="tag tag-error">{report.counts.error} 个必须修</span>
        ) : project.shots.length > 0 ? (
          <span className="tag tag-ok">检查通过</span>
        ) : null}
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          单镜上限约 {maxPerShot} 秒（按所选平台）
        </span>
        {generatingAssets ? <span className="tag tag-info">正在拆角色与场景</span> : null}
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
              const lockCount =
                project.characters.reduce(
                  (count, character) =>
                    count +
                    character.continuityLocks.filter((lock) => shot.activeLockIds.includes(lock.id))
                      .length,
                  0,
                ) +
                project.scenes.reduce(
                  (count, scene) =>
                    count +
                    scene.continuityLocks.filter((lock) => shot.activeLockIds.includes(lock.id))
                      .length,
                  0,
                );
              const assets = galleryFor(shot.id);
              const hasFirst = assets.some((asset) => asset.kind === 'first-frame' && asset.dataUrl);
              const hasEnd = assets.some((asset) => asset.kind === 'end-frame' && asset.dataUrl);
              return (
                <button
                  type="button"
                  key={shot.id}
                  className={`shot-strip-seg${expanded === shot.id ? ' is-open' : ''}${
                    mustFix > 0 ? ' has-error' : ''
                  }`}
                  style={{ flexGrow: Math.max(duration, 1) }}
                  onClick={() => openShot(shot.id)}
                  aria-label={`第 ${index + 1} 镜，${duration} 秒${
                    mustFix > 0 ? `，${mustFix} 个必须修` : ''
                  }`}
                  aria-current={expanded === shot.id ? 'true' : undefined}
                  title={`${formatTimecode(start)}–${formatTimecode(start + duration)} · ${duration} 秒 · 首帧${
                    hasFirst ? '有' : '无'
                  } · 尾帧${hasEnd ? '有' : '无'} · ${lockCount} 条锁${
                    mustFix > 0 ? ` · ${mustFix} 个必须修` : ''
                  }`}
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

      {/*
        生成工具收进折叠区。
        页面首先应该是「看和改这 7 个镜头」；没配 Key 时的两条警告不该占满第一屏。
      */}
      <details className="tools-drawer">
        <summary>
          <span className="tools-drawer-title">
            <Icon name="sparkles" size={14} className="tools-icon" />
            用模型生成
          </span>
          <span className="tools-drawer-toggle">展开</span>
        </summary>
        <div className="tools-drawer-body">
          <div className="card">
            <h3 className="card-title">生成分镜</h3>
            <GenerateBar
              task="assets"
              label="① 从故事里拆角色与场景"
              hint={`当前已有 ${project.characters.length} 个角色、${project.scenes.length} 个场景。重新生成会覆盖它们。`}
            />
            <GenerateBar
              task="shots"
              label="② 生成分镜表"
              hint={
                project.story.body.trim()
                  ? '会把故事拆成镜头，并自动挂好场景、角色和连续性锁。'
                  : '故事还是空的，先去「故事」把故事写出来（或让模型生成）。'
              }
            />
          </div>
          <BatchGenerateCard
            tasks={['characters', 'scenes', 'all-frames', 'first-frame', 'action-peak', 'end-frame']}
          />
        </div>
      </details>

      {project.shots.length === 0 ? (
        <div className="empty">
          还没有镜头。展开上面的「用模型生成」让模型拆，或点右上角「加一个镜头」手动写。
          {generatingShots ? (
            <div style={{ marginTop: 8 }}>模型正在拆镜头，请稍等…</div>
          ) : null}
        </div>
      ) : null}

      <div className="shot-list">
        {project.shots.map((shot, index) => {
          const scene = project.scenes.find((s) => s.id === shot.sceneId);
          const prevShot = project.shots[index - 1];
          const locks = project.characters.flatMap((c) =>
            c.continuityLocks.filter((l) => shot.activeLockIds.includes(l.id)),
          );
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
          /**
           * 取某个字段的问题。
           *
           * 刻意**不叫 `on`**：下面「出镜角色」按钮里已经有一个 `const on = shot.characterIds.includes(c.id)`，
           * 同名会在那个块里把外层的函数遮住，将来若在里面调一次就是 `boolean is not a function`。
           */
          const issuesOf = (field: string) => byField.get(field) ?? [];
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
                  style={{ width: 74 }}
                  value={shot.duration}
                  onChange={(e) => patch(shot, { duration: Number(e.target.value) || 0 })}
                  className={isFlagged(shot.id, 'duration') ? 'field-flagged' : ''}
                />
                <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>秒</span>

                <SelectMenu
                  className={`shot-select shot-size-select${
                    isFlagged(shot.id, 'shotSize') ? ' field-flagged' : ''
                  }`}
                  value={shot.shotSize}
                  options={shotSizeOptions}
                  ariaLabel={`第 ${shot.number} 镜的景别`}
                  onChange={(value) => patch(shot, { shotSize: value as ShotSize })}
                />

                <SelectMenu
                  className="shot-select shot-move-select"
                  value={shot.cameraMove}
                  options={cameraMoveOptions}
                  ariaLabel={`第 ${shot.number} 镜的运镜`}
                  onChange={(value) => patch(shot, { cameraMove: value as CameraMove })}
                />

                <SelectMenu
                  className={`shot-select shot-scene-select${
                    isFlagged(shot.id, 'sceneId') ? ' field-flagged' : ''
                  }`}
                  value={shot.sceneId}
                  options={sceneOptions}
                  ariaLabel={`第 ${shot.number} 镜的场景`}
                  onChange={(value) => patch(shot, { sceneId: value })}
                />

                <span style={{ flex: 1 }} />

                {/*
                  这一镜有几处要改。以前这个数字只在检查页有，
                  而且不展开镜头就完全看不到——新手在列表里划过去，不知道哪一镜有问题。
                */}
                {worst ? (
                  <button
                    type="button"
                    className={`${SEVERITY_TAG[worst]} issue-badge`}
                    onClick={() => setExpanded(shot.id)}
                    title="点一下展开这一镜，逐条看哪里不对"
                  >
                    {shotIssues.length} 处要改
                  </button>
                ) : null}

                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={index === 0}
                  onClick={() => moveShot(shot.id, -1)}
                  title="上移"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={index === project.shots.length - 1}
                  onClick={() => moveShot(shot.id, 1)}
                  title="下移"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm expand-toggle"
                  aria-expanded={open}
                  aria-controls={`shot-more-${shot.id}`}
                  onClick={() => setExpanded(open ? null : shot.id)}
                >
                  {open ? '收起' : '展开'}
                  <Icon name="chevron-right" size={13} className="expand-chevron" />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    if (window.confirm(`删除第 ${shot.number} 镜？`)) removeShot(shot.id);
                  }}
                >
                  删除
                </button>
              </div>

              {/*
                折叠时也能看图（v0.52）。放在头部正下面，三页位置一致——
                要比几镜的画面，眼睛不用在每张卡里重新找按钮。
              */}
              <AssetPeek assets={galleryFor(shot.id)} />

              {/*
                表头这三个控件（时长 / 景别 / 场景）挤在同一个 flex 行里，
                展开面板塞不进那一行，所以放在行下面——但仍然是各自一条、
                点哪一条只展开那一条，不会一次糊一大片。
              */}
              {shotIssues.length > 0 ? (
                <div className="shot-head-issues">
                  <FieldIssues issues={issuesOf('duration')} label="时长" />
                  <FieldIssues issues={issuesOf('shotSize')} label="景别" />
                  <FieldIssues issues={issuesOf('sceneId')} label="场景" />
                  <UnplacedIssues
                    issues={unplaced}
                    placed={shotIssues.length - unplaced.length}
                  />
                </div>
              ) : null}

              <div className="shot-primary">
                <div className="field-label">动作</div>
                <input
                  type="text"
                  value={shot.action}
                  onChange={(e) => patch(shot, { action: e.target.value })}
                  className={isFlagged(shot.id, 'action') ? 'field-flagged' : ''}
                  placeholder="例：他抬手拂去肩上的雪"
                />
                <div className="field-help">这一镜只做一件事</div>
                <FieldIssues issues={issuesOf('action')} label="动作" />
              </div>

              {open ? (
                <div className="shot-more" id={`shot-more-${shot.id}`}>
                  <div className="shot-head-guides">
                    <ShotSizeHint value={shot.shotSize} />
                    <CameraMoveHint value={shot.cameraMove} />
                  </div>

                  <div className="shot-sections">
                    <section className="shot-section">
                      <div className="shot-section-rail">
                        <span className="shot-section-icon">
                          <Icon name="photo" size={16} />
                        </span>
                        <h4 className="shot-section-title">画面</h4>
                        <p className="shot-section-desc">起点、终点、人物和机位</p>
                      </div>
                      <div className="shot-section-body">
                        <div>
                          <div className="field-label">起点</div>
                          <textarea
                            rows={3}
                            value={shot.startState}
                            onChange={(e) => patch(shot, { startState: e.target.value })}
                            className={isFlagged(shot.id, 'startState') ? 'field-flagged' : ''}
                            placeholder="只写这一瞬间看得见的东西"
                          />
                          <div className="field-help">镜头开始那一瞬间能看见什么</div>
                          <FieldIssues issues={issuesOf('startState')} label="起点" />
                        </div>
                        <div>
                          <div className="field-label">终点</div>
                          <textarea
                            rows={3}
                            value={shot.endState}
                            onChange={(e) => patch(shot, { endState: e.target.value })}
                            className={isFlagged(shot.id, 'endState') ? 'field-flagged' : ''}
                            placeholder="下一镜要从这里接下去"
                          />
                          <div className="field-help">镜头结束画面停在哪</div>
                          <FieldIssues issues={issuesOf('endState')} label="终点" />
                        </div>
                        <div>
                          <div className="field-label">出镜角色</div>
                          <div className="row" style={{ gap: 6 }}>
                            {project.characters.length === 0 ? (
                              <span className="hint">还没有角色。去「角色设定」里建一个。</span>
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

                        <div>
                          <div className="field-label">台词 / 旁白</div>
                          <input
                            type="text"
                            value={shot.dialogue}
                            onChange={(e) => patch(shot, { dialogue: e.target.value })}
                          />
                        </div>

                        <div>
                          <div className="field-label">机位</div>
                          <input
                            type="text"
                            value={shot.cameraPosition}
                            onChange={(e) => patch(shot, { cameraPosition: e.target.value })}
                            placeholder="例：略低角度，与桌面齐平"
                          />
                          <div className="field-help">
                            观众站在哪看。与视线齐平是平等，仰拍是压迫，俯拍是弱小。
                          </div>
                        </div>

                        {/*
                          反打视角的「朝向」下拉（v0.47 加、v0.47 后撤）。

                          撤掉的原因：实测反打板交出来的是原图的左右镜像，
                          而场景卡的方位是按房间坐标写的，一镜像就和文字打架。
                          底层没有删（Shot.viewAngle、按朝向挑板的逻辑都留着），
                          只是界面不再暴露。已有项目里 viewAngle: 'reverse' 的镜头
                          会自动退回主视角板，并在出图结果里说明这件事。
                        */}

                        <div>
                          <div className="field-label">来源场次</div>
                          <SelectMenu
                            className="source-scene-select"
                            value={shot.sourceSceneId}
                            options={storySceneOptions}
                            ariaLabel={`第 ${shot.number} 镜的来源场次`}
                            onChange={(value) => patch(shot, { sourceSceneId: value })}
                          />
                        </div>
                      </div>
                    </section>

                    <section className="shot-section">
                      <div className="shot-section-rail">
                        <span className="shot-section-icon">
                          <Icon name="volume" size={16} />
                        </span>
                        <h4 className="shot-section-title">声音与情绪</h4>
                        <p className="shot-section-desc">声音、情绪和画外音</p>
                      </div>
                      <div className="shot-section-body">
                        <div>
                          <div className="field-label">声音</div>
                          <input
                            type="text"
                            value={shot.sound}
                            onChange={(e) => patch(shot, { sound: e.target.value })}
                            placeholder="环境音 / 音效"
                          />
                        </div>

                        <div>
                          <div className="field-label">情绪</div>
                          <input
                            type="text"
                            value={shot.mood}
                            onChange={(e) => patch(shot, { mood: e.target.value })}
                          />
                          <FieldIssues issues={issuesOf('mood')} label="情绪" />
                        </div>

                        <div>
                          <div className="field-label">画外人物</div>
                          <input
                            type="text"
                            value={shot.offscreenCharacters.join('、')}
                            onChange={(e) =>
                              patch(shot, {
                                offscreenCharacters: e.target.value
                                  .split(/[、,，\s]+/)
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              })
                            }
                            placeholder="用、分隔"
                          />
                          <div className="field-help">只在声音里出现的人</div>
                          <FieldIssues issues={issuesOf('offscreenCharacters')} label="画外人物" />
                        </div>

                      </div>
                    </section>

                    <section className="shot-section">
                      <div className="shot-section-rail">
                        <span className="shot-section-icon">
                          <Icon name="scissors" size={16} />
                        </span>
                        <h4 className="shot-section-title">剪辑与衔接</h4>
                        <p className="shot-section-desc">镜头之间怎么接</p>
                      </div>
                      <div className="shot-section-body">
                        <div>
                          <div className="field-label">转场</div>
                          <input
                            type="text"
                            value={shot.transition}
                            onChange={(e) => patch(shot, { transition: e.target.value })}
                          />
                          <div className="field-help">剪辑阶段用，不进生成提示词。多数镜头用硬切就好。</div>
                        </div>

                        <div>
                          <div className="field-label">与上一镜的转场</div>
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
                          <div className="field-help">总开关</div>
                          <FieldIssues issues={issuesOf('transitionType')} label="转场类型" />
                        </div>

                        <div>
                          <div className="field-label">下一镜的衔接</div>
                          <input
                            type="text"
                            value={shot.continuityNote ?? ''}
                            onChange={(e) => patch(shot, { continuityNote: e.target.value })}
                            placeholder="例：他保持这个姿势不动，下一镜从同一机位推进"
                          />
                          <div className="field-help">这一镜怎么接到下一镜</div>
                          <FieldIssues issues={issuesOf('continuityNote')} label="衔接" />
                        </div>
                      </div>
                    </section>

                    <section className="shot-section">
                      <div className="shot-section-rail">
                        <span className="shot-section-icon">
                          <Icon name="lock" size={16} />
                        </span>
                        <h4 className="shot-section-title">连续性锁</h4>
                        <p className="shot-section-desc">勾选这一镜不能变的部分</p>
                      </div>
                      <div className="shot-section-body">
                        {/*
                          v0.48：原来这里是一句写死的「有角色没勾锁」，
                          只说有这么回事、不说谁没勾、为什么、怎么改。
                          现在直接把检查给的三段摊开。
                        */}
                        <FieldIssues issues={issuesOf('activeLockIds')} label="连续性锁" />
                        <div className="row" style={{ gap: 6 }}>
                          {project.characters.every((c) => c.continuityLocks.length === 0) &&
                          project.scenes.every((s) => s.continuityLocks.length === 0) ? (
                            <span className="hint">
                              还没有任何连续性锁。去「角色设定」或「场景设定」里加上。
                            </span>
                          ) : (
                            <>
                              {project.characters.flatMap((c) =>
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
                              )}
                              {project.scenes.flatMap((s) =>
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
                              )}
                            </>
                          )}
                        </div>
                        {locks.length > 0 ? (
                          <details className="why shot-lock-details">
                            <summary>已锁定 {locks.length} 条</summary>
                            <div className="why-body">
                              {locks.map((l) => (
                                <code key={l.id} style={{ marginRight: 6 }}>
                                  {l.phrase}
                                </code>
                              ))}
                              <div className="hint" style={{ marginTop: 4 }}>
                                这些短语会被原样写进这一镜的提示词。
                              </div>
                            </div>
                          </details>
                        ) : null}
                        {scene ? (
                          <details className="why shot-scene">
                            <summary>当前场景：{scene.name}</summary>
                            <div className="why-body">
                              固定元素：
                              {scene.fixedElements.length > 0
                                ? scene.fixedElements.map((el) => (
                                    <code key={el} style={{ marginRight: 6 }}>
                                      {el}
                                    </code>
                                  ))
                                : '（还没登记）'}
                              <br />
                              主光方向：{scene.lightDirection || '（未填）'} · 主色调：
                              {scene.mainColor || '（未填）'}
                            </div>
                          </details>
                        ) : null}
                      </div>
                    </section>
                  </div>

                  <div className="shot-output">
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
                          label: '① 首帧（锁角色）',
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
                            hasFirstFrame={galleryFor(shot.id).some(
                              (a) => a.kind === 'first-frame' && a.dataUrl,
                            )}
                            hasActionPeak={galleryFor(shot.id).some(
                              (a) => a.kind === 'action-peak' && a.dataUrl,
                            )}
                            hasEndFrame={galleryFor(shot.id).some(
                              (a) => a.kind === 'end-frame' && a.dataUrl,
                            )}
                          />
                          <AssetGallery
                            assets={galleryFor(shot.id)}
                            emptyHint="还没有生成过这一镜的帧。"
                          />
                        </>
                      }
                    />

                    <div className="row" style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => navigate(`/prompts?shot=${shot.id}`)}
                      >
                        看这一镜的提示词
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="hint" style={{ marginTop: 6 }}>
                  {shot.startState ? `起点：${shot.startState.slice(0, 60)}` : '起点还没写'}
                  {' · '}
                  {scene ? `场景：${scene.name}` : '未指定场景'}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}





