import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { SummaryBar, Info } from '../components/bits';
import { RichText } from '../components/bits';
import { GenerateBar } from '../components/GenerateBar';
import { AiFlowGuide } from '../components/AiFlowGuide';
import { useGeneration } from '../store/generation';
import { AssetGallery, ImagePanel } from '../components/ImagePanel';
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

/**
 * M2 分镜表编辑器（方案.md v0.6 §3.2）
 *
 * 这是整个工具用得最久的界面，因此三条设计取舍：
 * 1. 全部字段直接内联编辑，不做「点开弹窗才能改」——新手最怕找不到东西在哪
 * 2. 总时长实时统计并常驻顶部——时长对不上是新手最常见的问题
 * 3. 出问题的字段描边高亮，点一下跳到穿帮检查看原因
 */

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

  if (hasFirstFrame && !hasActionPeak && !hasEndFrame) {
    return (
      <div className="hint" style={{ marginBottom: 8 }}>
        首帧有了。接着出<b>尾帧</b>（做首尾帧视频用）或<b>动作关键帧</b>（加大动作力度）。
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

  if (!project) {
    return <div className="empty">还没有打开任何项目。先去「项目」页新建或打开一个。</div>;
  }

  const total = project.shots.reduce((s, x) => s + (Number.isFinite(x.duration) ? x.duration : 0), 0);
  const target = project.brief.targetDuration;
  const diff = total - target;
  const maxPerShot = Math.max(
    ...project.brief.platforms.map((p) => PLATFORM_MAX_DURATION[p] ?? 10),
    10,
  );

  function isFlagged(shotId: string, field: string): boolean {
    return flaggedFields.get(shotId)?.has(field) ?? false;
  }

  function patch(shot: Shot, changes: Partial<Shot>) {
    upsertShot({ ...shot, ...changes });
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>分镜表</h2>
          <p>一镜只做一件事：起点 → 动作 → 终点。</p>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
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
              : '故事还是空的，先去「引导向导」把故事写出来（或让模型生成）。'
          }
        />
      </div>

      <BatchGenerateCard tasks={['characters', 'scenes', 'first-frame', 'action-peak', 'end-frame']} />

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
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          单镜上限约 {maxPerShot} 秒（按所选平台）
        </span>
        {generatingAssets ? <span className="tag tag-info">正在拆角色与场景</span> : null}
      </SummaryBar>

      {project.shots.length === 0 ? (
        <div className="empty">
          还没有镜头。可以点上面的「② 生成分镜表」让模型拆，也可以点右上角「加一个镜头」手动写，
          或者去「项目」页打开示例项目看看结构。
          {generatingShots ? (
            <div style={{ marginTop: 8 }}>模型正在拆镜头，请稍等…</div>
          ) : null}
        </div>
      ) : null}

      <div className="shot-list">
        {project.shots.map((shot, index) => {
          const scene = project.scenes.find((s) => s.id === shot.sceneId);
          const next = project.shots[index + 1];
          const prevShot = project.shots[index - 1];
          const inferred = prevShot
            ? inferTransitionType(prevShot)
            : undefined;
          const locks = project.characters.flatMap((c) =>
            c.continuityLocks.filter((l) => shot.activeLockIds.includes(l.id)),
          );
          const open = expanded === shot.id;
          return (
            <div className="shot-card" key={shot.id} id={`shot-${shot.id}`}>
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

                <select
                  value={shot.shotSize}
                  onChange={(e) => patch(shot, { shotSize: e.target.value as ShotSize })}
                  style={{ width: 92 }}
                >
                  {SHOT_SIZE_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {SHOT_SIZE_LABEL[s]}
                    </option>
                  ))}
                </select>

                <select
                  value={shot.cameraMove}
                  onChange={(e) => patch(shot, { cameraMove: e.target.value as CameraMove })}
                  style={{ width: 92 }}
                >
                  {CAMERA_MOVE_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {CAMERA_MOVE_LABEL[m]}
                    </option>
                  ))}
                </select>

                <select
                  value={shot.sceneId}
                  onChange={(e) => patch(shot, { sceneId: e.target.value })}
                  className={isFlagged(shot.id, 'sceneId') ? 'field-flagged' : ''}
                  style={{ width: 150 }}
                >
                  <option value="">（未指定场景）</option>
                  {project.scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>

                <span style={{ flex: 1 }} />

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
                  className="btn btn-ghost btn-sm"
                  onClick={() => setExpanded(open ? null : shot.id)}
                >
                  {open ? '收起' : '展开'}
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

              <div className="shot-fields">
                <div className="wide">
                  <div className="field-label">动作（这一镜只做一件事）</div>
                  <input
                    type="text"
                    value={shot.action}
                    onChange={(e) => patch(shot, { action: e.target.value })}
                    className={isFlagged(shot.id, 'action') ? 'field-flagged' : ''}
                    placeholder="谁做了什么。只写一件事——塞两件模型会两个都做不好。"
                  />
                </div>
              </div>

              {open ? (
                <>
                  <div className="shot-fields" style={{ marginTop: 10 }}>
                    <div>
                      <div className="field-label">起点（镜头开始那一瞬间能看见什么）</div>
                      <textarea
                        rows={3}
                        value={shot.startState}
                        onChange={(e) => patch(shot, { startState: e.target.value })}
                        className={isFlagged(shot.id, 'startState') ? 'field-flagged' : ''}
                        placeholder="只写这一瞬间看得见的。终点才出现的动作不要写在这里。"
                      />
                    </div>
                    <div>
                      <div className="field-label">终点（镜头结束画面停在哪）</div>
                      <textarea
                        rows={3}
                        value={shot.endState}
                        onChange={(e) => patch(shot, { endState: e.target.value })}
                        className={isFlagged(shot.id, 'endState') ? 'field-flagged' : ''}
                        placeholder="下一镜要从这里接下去。"
                      />
                    </div>
                  </div>

                  <div className="shot-fields" style={{ marginTop: 10 }}>
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
                      <div className="field-label">景别说明</div>
                      <ShotSizeHint value={shot.shotSize} />
                      <div className="field-label" style={{ marginTop: 8 }}>
                        运镜说明
                      </div>
                      <CameraMoveHint value={shot.cameraMove} />
                    </div>

                    <div>
                      <div className="field-label">机位（观众站在哪看）</div>
                      <input
                        type="text"
                        value={shot.cameraPosition}
                        onChange={(e) => patch(shot, { cameraPosition: e.target.value })}
                        placeholder="例：略低角度，与桌面齐平"
                      />
                      <div className="hint">
                        与视线齐平是平等，仰拍是压迫，俯拍是弱小。
                      </div>
                    </div>

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
                    </div>

                    <div>
                      <div className="field-label">转场（剪辑时用）</div>
                      <input
                        type="text"
                        value={shot.transition}
                        onChange={(e) => patch(shot, { transition: e.target.value })}
                      />
                      <div className="hint">
                        剪辑阶段用，<b>不进生成提示词</b>。多数镜头用硬切就好。
                      </div>
                    </div>

                    <div>
                      <div className="field-label">画外人物（只在声音里出现的人）</div>
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
                    </div>

                    <div>
                      <div className="field-label">
                        与上一镜的转场
                        <span className="hint" style={{ marginLeft: 6, fontWeight: 400 }}>
                          总开关
                        </span>
                      </div>
                      <select
                        value={
                          shot.transitionType ??
                          (index === 0 ? 'cut' : inferTransitionType(prevShot))
                        }
                        disabled={index === 0}
                        onChange={(e) =>
                          patch(shot, {
                            transitionType: e.target.value as 'continuation' | 'cut',
                          })
                        }
                      >
                        <option value="continuation">承接上一镜（连续动作）</option>
                        <option value="cut">跳切（换地方／跳时间／有意断开）</option>
                      </select>
                      <div className="hint">
                        {index === 0 ? (
                          <>这是第一镜，无需承接。</>
                        ) : (
                          <>
                            承接会拿上一镜尾帧当锚点
                            <Info label="承接和跳切有什么区别">
                              「承接」用于连续动作：出这一镜首帧时会自动拿上一镜尾帧当参考图，
                              两镜才真的接得住。「跳切」用于换地方、跳时间、或者有意断开——它不拿锚点，
                              否则会把两个不该相连的镜头焊在一起。
                            </Info>
                            {inferred ? (
                              <>
                                <br />（按上一镜推断为「
                                {inferred === 'continuation' ? '承接' : '跳切'}」，可直接改。）
                              </>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>

                    <div className="wide">
                      <div className="field-label">
                        与下一镜的衔接（这一镜怎么接到下一镜）
                      </div>
                      <input
                        type="text"
                        value={shot.continuityNote ?? ''}
                        onChange={(e) => patch(shot, { continuityNote: e.target.value })}
                        placeholder="例：他保持这个姿势不动，下一镜从同一机位推进；或：直接切到第二天早上"
                      />
                      <div className="hint">
                        {next ? (
                          <>
                            下一镜（第 {next.number} 镜）从
                            <b>{next.startState || '（还没写）'}</b>开始，尾帧要能接住它。
                          </>
                        ) : (
                          <>最后一镜，写一句收尾说明即可。</>
                        )}
                        <Info label="这一栏是干什么的">
                          它同时管三件事：<b>尾帧图该画成什么样</b>、视频提示词里的转场怎么写、
                          剪辑时的落点在哪。所以写清这一镜结束时画面停在哪，
                          而不是写「接下来会发生什么」。
                        </Info>
                      </div>
                    </div>

                    <div>
                      <div className="field-label">来源场次</div>
                      <select
                        value={shot.sourceSceneId}
                        onChange={(e) => patch(shot, { sourceSceneId: e.target.value })}
                      >
                        <option value="">（未指定）</option>
                        {project.story.scenes.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <div className="field-label">
                      连续性锁（这一镜必须保持不变的可见事实）
                      {isFlagged(shot.id, 'activeLockIds') ? (
                        <span className="tag tag-error">有角色没勾锁</span>
                      ) : null}
                    </div>
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
                      <div className="hint" style={{ marginTop: 6 }}>
                        已锁定：
                        {locks.map((l) => (
                          <code key={l.id} style={{ marginLeft: 4 }}>
                            {l.phrase}
                          </code>
                        ))}
                        <br />
                        这些短语会被原样写进每一镜的提示词。
                      </div>
                    ) : null}
                  </div>

                  {scene ? (
                    <div className="hint" style={{ marginTop: 10 }}>
                      当前场景「{scene.name}」的固定元素：
                      {scene.fixedElements.length > 0
                        ? scene.fixedElements.map((el) => (
                            <code key={el} style={{ marginLeft: 4 }}>
                              {el}
                            </code>
                          ))
                        : '（还没登记）'}
                      <br />
                      主光方向：{scene.lightDirection || '（未填）'} · 主色调：
                      {scene.mainColor || '（未填）'}
                    </div>
                  ) : null}

                  <ImagePanel
                    refId={shot.id}
                    target="frame"
                    label="这一镜的三帧"
                    options={[
                      {
                        label: '① 首帧',
                        useReference: false,
                        frameKind: 'first-frame',
                        hint: '纯文生图，不用任何参考图。只在参考图出了问题、想对比一下时才用。',
                      },
                      {
                        label: '① 首帧（锁角色 + 接上一镜）',
                        useReference: true,
                        frameKind: 'first-frame',
                        hint: '带参考图锚定，一致性最好。**建议直接用这个。** 如果上一镜的衔接说明里写了「接着／保持」，它还会自动拿上一镜的尾帧当锚点——那样两镜就真的接得住了。',
                      },
                      {
                        label: '② 动作关键帧',
                        useReference: true,
                        frameKind: 'action-peak',
                        hint: '画动作最有张力的那一瞬，决定动作的力度与节奏。',
                      },
                      {
                        label: '③ 尾帧',
                        useReference: true,
                        frameKind: 'end-frame',
                        hint: '画终点那一格。**下一镜的首帧要接住它**，做首尾帧视频时必须生成。',
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
                          emptyHint="还没有生成过这一镜的帧。建议先出「首帧（锁角色）」。"
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
                </>
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
