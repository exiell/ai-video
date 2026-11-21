import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { ConfirmDialog, Field } from '../components/bits';
import { GenerateBar } from '../components/GenerateBar';
import { AiFlowGuide } from '../components/AiFlowGuide';
import { Icon } from '../components/Icon';
import { TermHint } from '../components/TermHint';
import { matchStylePreset, STYLE_PRESETS } from '../domain/help/stylePresets';
import { assessStyleChange } from '../domain/help/styleChange';
import { useImage } from '../store/image';
import { useGeneration } from '../store/generation';
import type { StoryScene, TargetPlatform } from '../types/model';
import { PLATFORM_LABEL } from '../types/model';
import { newId } from '../services/storage';

/**
 * 故事立项向导（3 步聚焦流 + 右侧实时立项预览卡）
 *
 * 第 1 步：写故事（自己写 / AI 起草，可选补四格与场次）；
 * 第 2 步：画风与规格（视觉化画幅比例框、时长胶囊、平台点选、画风预设）；
 * 第 3 步：启动制作（直接进入 AI 拆镜或手动设定集）。
 */

const STEPS = ['定故事', '画风与规格', '启动制作'] as const;

const PLATFORM_OPTIONS: TargetPlatform[] = ['jimeng', 'kling', 'seedance'];
const DURATION_PRESETS = [15, 30, 45, 60];

const ASPECT_CARDS = [
  { value: '9:16', label: '9:16 竖屏', sub: '抖音 / 视频号', w: 18, h: 30 },
  { value: '16:9', label: '16:9 横屏', sub: 'B站 / YouTube', w: 32, h: 18 },
  { value: '1:1', label: '1:1 方形', sub: '社交方图', w: 24, h: 24 },
  { value: '4:3', label: '4:3 经典', sub: '复古番剧', w: 28, h: 21 },
];

export function GuidePage() {
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const patchBrief = useAppStore((s) => s.patchBrief);
  const patchStory = useAppStore((s) => s.patchStory);
  const patchProject = useAppStore((s) => s.patchProject);
  const createEmptyProject = useAppStore((s) => s.createEmptyProject);
  const assetCount = useImage((s) => s.assetCount);
  const refreshAssetCount = useImage((s) => s.refreshAssetCount);
  const runStyleTags = useGeneration((s) => s.runStyleTags);

  const [step, setStep] = useState(0);
  const [pendingStyle, setPendingStyle] = useState<
    { kind: 'preset'; tags: string[] } | { kind: 'generate' } | null
  >(null);

  useEffect(() => {
    void refreshAssetCount();
  }, [refreshAssetCount]);

  if (!project) {
    return (
      <div className="empty">
        还没有打开任何项目。
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-primary" onClick={() => createEmptyProject()}>
            新建一个项目
          </button>
        </div>
      </div>
    );
  }

  const story = project.story;

  function addStoryScene() {
    const scene: StoryScene = {
      id: newId('ss'),
      label: `第 ${story.scenes.length + 1} 场`,
      summary: '',
    };
    patchStory({ scenes: [...story.scenes, scene] });
  }

  function updateStoryScene(id: string, patch: Partial<StoryScene>) {
    patchStory({
      scenes: story.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  }

  function removeStoryScene(id: string) {
    patchStory({ scenes: story.scenes.filter((s) => s.id !== id) });
  }

  const matchedPreset = matchStylePreset(project.brief.styleTags);
  const completed = [
    story.body.trim().length > 0,
    project.logline.trim().length > 0 ||
      project.brief.styleTone.trim().length > 0 ||
      matchedPreset !== undefined ||
      project.brief.styleTags.length > 0,
    false,
  ];

  const styleImpact = assessStyleChange({
    characters: project.characters.length,
    scenes: project.scenes.length,
    shots: project.shots.length,
    imageCount: assetCount,
  });

  const storyFilledCount = [
    story.charactersNote,
    story.setting,
    story.conflict,
    story.ending,
  ].filter((value) => value.trim().length > 0).length;

  const estShots = Math.max(1, Math.round((project.brief.targetDuration || 30) / 4));
  const activeAspect =
    ASPECT_CARDS.find((a) => a.value === project.brief.aspectRatio) ?? ASPECT_CARDS[0]!;

  return (
    <div className="guide-v2">
      <header className="hub-hero guide-hero">
        <h1>故事</h1>

        <nav className="guide-stepper" aria-label="故事步骤">
          {STEPS.map((label, index) => {
            const done = completed[index];
            return (
              <button
                key={label}
                type="button"
                className={`guide-step-pill${index === step ? ' active' : ''}${done ? ' done' : ''}`}
                aria-current={index === step ? 'step' : undefined}
                onClick={() => setStep(index)}
              >
                <span className="guide-step-no">0{index + 1}</span>
                <span>{label}</span>
                {done ? <Icon name="circle-check" size={14} /> : null}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="guide-workspace">
        <div className="guide-main">
          {step === 0 ? (
            <div className="card">
              <div className="guide-section-head">
                <h2 className="card-title">写下你的故事</h2>
                <div className="guide-source-switch" role="group" aria-label="故事来源">
                  <button
                    type="button"
                    className={`btn btn-sm${story.source === 'original' ? ' btn-primary' : ''}`}
                    onClick={() => patchStory({ source: 'original' })}
                  >
                    自己写
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm${story.source === 'generated' ? ' btn-primary' : ''}`}
                    onClick={() => patchStory({ source: 'generated' })}
                  >
                    AI 帮我起草
                  </button>
                </div>
              </div>

              {story.source === 'generated' ? (
                <div className="guide-ai-box">
                  <Field label="一句话主题" hint="例如：雨夜里外卖员在巷口捡到一只会说话的猫">
                    <input
                      type="text"
                      value={story.theme ?? ''}
                      onChange={(e) => patchStory({ theme: e.target.value })}
                      placeholder="输入想讲的主题，让模型先起草初稿"
                    />
                  </Field>
                  <GenerateBar
                    task="story"
                    label="让模型帮我写故事并拆场次"
                   
                  />
                </div>
              ) : null}

              <Field
                label="故事正文"
               
              >
                <textarea
                  rows={8}
                  value={story.body}
                  onChange={(e) => patchStory({ body: e.target.value })}
                  placeholder="例：林冲被陷害发配沧州看守草料场。风雪夜沽酒回来见草厅压塌，宿进山神庙，听见门外三人密谋后提枪推门而出……"
                />
              </Field>

              <details className="card-fold">
                <summary>
                  <span className="card-fold-title">四要素（可选）</span>
                  <span className="card-fold-count">{storyFilledCount} / 4 已填</span>
                </summary>
                <div className="grid-2" style={{ marginTop: 10 }}>
                  <Field label="主要人物">
                    <textarea
                      rows={2}
                      value={story.charactersNote}
                      onChange={(e) => patchStory({ charactersNote: e.target.value })}
                    />
                  </Field>
                  <Field label="时间与地点">
                    <textarea
                      rows={2}
                      value={story.setting}
                      onChange={(e) => patchStory({ setting: e.target.value })}
                    />
                  </Field>
                  <Field label="核心冲突">
                    <textarea
                      rows={2}
                      value={story.conflict}
                      onChange={(e) => patchStory({ conflict: e.target.value })}
                    />
                  </Field>
                  <Field label="结局定格">
                    <textarea
                      rows={2}
                      value={story.ending}
                      onChange={(e) => patchStory({ ending: e.target.value })}
                    />
                  </Field>
                </div>
              </details>

              <details className="card-fold" style={{ marginTop: 10 }}>
                <summary>
                  <span className="card-fold-title">场次拆分（可选）</span>
                  <span className="card-fold-count">{story.scenes.length} 场</span>
                </summary>
                <div style={{ marginTop: 10 }}>
                  {story.scenes.map((scene) => (
                    <div
                      className="row"
                      key={scene.id}
                      style={{ marginBottom: 8, alignItems: 'flex-start' }}
                    >
                      <input
                        type="text"
                        aria-label="场次名"
                        style={{ maxWidth: 200 }}
                        value={scene.label}
                        onChange={(e) => updateStoryScene(scene.id, { label: e.target.value })}
                        placeholder="例：山神庙 · 风雪夜"
                      />
                      <input
                        type="text"
                        aria-label="这一场发生了什么"
                        style={{ flex: 1, minWidth: 180 }}
                        value={scene.summary}
                        onChange={(e) => updateStoryScene(scene.id, { summary: e.target.value })}
                        placeholder="这一场发生了什么"
                      />
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon is-danger"
                        aria-label={`删除场次 ${scene.label}`}
                        title={`删除场次 ${scene.label}`}
                        onClick={() => removeStoryScene(scene.id)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  ))}
                  <button type="button" className="btn btn-sm" onClick={addStoryScene}>
                    + 加一场
                  </button>
                </div>
              </details>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="card">
              <h2 className="card-title">画风与成片规格</h2>

              <div className="grid-2">
                <Field label="片名">
                  <input
                    type="text"
                    value={project.name}
                    onChange={(e) => patchProject({ name: e.target.value })}
                    placeholder="我的动漫短片"
                  />
                </Field>
                <Field label="一句话简介">
                  <input
                    type="text"
                    value={project.logline}
                    onChange={(e) => patchProject({ logline: e.target.value })}
                    placeholder="主角、处境与转折"
                  />
                </Field>
              </div>

              <div className="guide-spec-block">
                <span className="field-label">画面比例</span>
                <div className="aspect-card-grid">
                  {ASPECT_CARDS.map((item) => {
                    const active = project.brief.aspectRatio === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        className={`aspect-card${active ? ' active' : ''}`}
                        onClick={() => patchBrief({ aspectRatio: item.value })}
                        aria-pressed={active}
                      >
                        <span
                          className="aspect-frame-icon"
                          style={{ width: item.w, height: item.h }}
                          aria-hidden="true"
                        />
                        <b>{item.label}</b>
                        <small>{item.sub}</small>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid-2" style={{ marginTop: 14 }}>
                <Field label="目标时长（秒）">
                  <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                    {DURATION_PRESETS.map((sec) => (
                      <button
                        key={sec}
                        type="button"
                        className={`btn btn-sm${project.brief.targetDuration === sec ? ' btn-primary' : ''}`}
                        onClick={() => patchBrief({ targetDuration: sec })}
                      >
                        {sec}s
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    min={5}
                    max={600}
                    value={project.brief.targetDuration}
                    onChange={(e) => patchBrief({ targetDuration: Number(e.target.value) || 0 })}
                  />
                </Field>

                <Field label="目标视频平台">
                  <div className="row" style={{ marginTop: 2 }}>
                    {PLATFORM_OPTIONS.map((p) => {
                      const on = project.brief.platforms.includes(p);
                      return (
                        <button
                          key={p}
                          type="button"
                          className={`btn${on ? ' btn-primary' : ''}`}
                          onClick={() => {
                            const next = on
                              ? project.brief.platforms.filter((x) => x !== p)
                              : [...project.brief.platforms, p];
                            patchBrief({ platforms: next });
                          }}
                        >
                          {PLATFORM_LABEL[p]}
                        </button>
                      );
                    })}
                  </div>
                </Field>
              </div>

              {styleImpact.needed ? (
                <div className="issue warning" style={{ margin: '12px 0' }}>
                  <div className="issue-title">已有设定或图片，改风格不会自动更新旧图</div>
                  <div className="issue-line">切换风格后，建议重新核对角色、场景与关键帧。</div>
                </div>
              ) : null}

              <div className="guide-spec-block" style={{ marginTop: 14 }}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                  <span className="field-label" style={{ marginBottom: 0 }}>
                    画风预设
                  </span>
                  <div className="row" style={{ gap: 6 }}>
                    <TermHint term="画幅比例" />
                    <TermHint term="主色调" />
                    <TermHint term="主光方向" />
                  </div>
                </div>
                <div className="row" style={{ marginBottom: 12 }}>
                  {STYLE_PRESETS.map((preset) => {
                    const active = matchedPreset?.id === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={`btn${active ? ' btn-primary' : ''}`}
                        onClick={() => {
                          const next = active ? [] : [...preset.tags];
                          if (styleImpact.needed) setPendingStyle({ kind: 'preset', tags: next });
                          else patchBrief({ styleTags: next });
                        }}
                        title={preset.description}
                        aria-pressed={active}
                      >
                        {preset.label}
                        {active ? ' · 已选' : ''}
                      </button>
                    );
                  })}
                </div>
              </div>

              <Field label="中文风格描述">
                <textarea
                  rows={2}
                  value={project.brief.styleTone}
                  onChange={(e) => patchBrief({ styleTone: e.target.value })}
                  placeholder="例：水墨写意混合国漫赛璐璐，冷蓝灰主调，大雪，厚重布料质感"
                />
              </Field>

              <GenerateBar
                task="style"
                label="用这段中文生成英文风格词"
               
                gate={() => {
                  if (styleImpact.needed) {
                    setPendingStyle({ kind: 'generate' });
                    return false;
                  }
                  return true;
                }}
              />

              <details className="card-fold" style={{ marginTop: 12 }}>
                <summary>
                  <span className="card-fold-title">英文风格词与负向词</span>
                  <span className="card-fold-count">{project.brief.styleTags.length} 条风格词</span>
                </summary>
                <div style={{ marginTop: 10 }}>
                  <Field label="风格关键词（英文，每行一条）">
                    <textarea
                      rows={5}
                      value={project.brief.styleTags.join('\n')}
                      onChange={(e) =>
                        patchBrief({
                          styleTags: e.target.value
                            .split('\n')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder={'anime style\ncel shading\ncold blue palette'}
                    />
                  </Field>
                  <Field label="负向词（所有镜头共用）">
                    <textarea
                      rows={2}
                      value={project.brief.negativePrompt}
                      onChange={(e) => patchBrief({ negativePrompt: e.target.value })}
                    />
                  </Field>
                </div>
              </details>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="guide-launch">
              <AiFlowGuide />

              <div className="guide-launch-cards">
                <div className="card guide-launch-primary">
                  <span className="next-label">推荐路径</span>
                  <h3>进入分镜与质检，让 AI 拆设定与分镜</h3>

                  <button
                    type="button"
                    className="btn btn-blue"
                    onClick={() => navigate('/storyboard')}
                  >
                    进入分镜与质检 →
                  </button>
                </div>

                <div className="card">
                  <span className="next-label">手动路径</span>
                  <h3>先去设定集，亲手定制角色与场景</h3>

                  <div className="row">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => navigate('/assets')}
                    >
                      去设定集 →
                    </button>
                    <Link className="btn btn-ghost" to="/help">
                      查看分镜术语
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div className="wizard-actions">
            <button
              type="button"
              className="btn btn-icon"
              disabled={step === 0}
              title="上一步"
              aria-label="上一步"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
            >
              <Icon name="chevron-left" size={16} />
            </button>
            <div className="row">
              {step < STEPS.length - 1 ? (
                <button
                  type="button"
                  className="btn btn-blue"
                  onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
                >
                  下一步：{STEPS[step + 1]}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-blue"
                  onClick={() => navigate('/storyboard')}
                >
                  进入分镜与质检 →
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 右侧常驻：实时立项摘要卡 */}
        <aside className="card guide-preview" aria-label="立项实时预览">
          <div className="guide-preview-head">
                        <h3>{project.name || '未命名短片'}</h3>
            <p>{project.logline || '填写简介后会显示在这里。'}</p>
          </div>

          <div className="guide-preview-stage">
            <div
              className="guide-preview-frame"
              style={{ aspectRatio: project.brief.aspectRatio.replace(':', ' / ') }}
            >
              <span>{activeAspect.label}</span>
              <small>预计约 {estShots} 镜</small>
            </div>
          </div>

          <dl className="guide-preview-meta">
            <div>
              <dt>故事字数</dt>
              <dd>{story.body.trim().length} 字</dd>
            </div>
            <div>
              <dt>目标时长</dt>
              <dd>{project.brief.targetDuration} 秒</dd>
            </div>
            <div>
              <dt>目标平台</dt>
              <dd>
                {project.brief.platforms.map((p) => PLATFORM_LABEL[p]).join(' / ') || '未选择'}
              </dd>
            </div>
            <div>
              <dt>风格预设</dt>
              <dd>{matchedPreset?.label ?? (project.brief.styleTags.length > 0 ? '自定义' : '未选')}</dd>
            </div>
          </dl>

          {project.brief.styleTags.length > 0 ? (
            <div className="guide-preview-tags">
              {project.brief.styleTags.slice(0, 6).map((tag) => (
                <span key={tag} className="tag tag-info">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </aside>
      </div>

      <ConfirmDialog
        open={pendingStyle !== null}
        title="改风格会影响已经做好的内容"
        confirmLabel={pendingStyle?.kind === 'generate' ? '我明白，生成并应用' : '我明白，改吧'}
        cancelLabel="先不改"
        onCancel={() => setPendingStyle(null)}
        onConfirm={() => {
          const pending = pendingStyle;
          setPendingStyle(null);
          if (!pending) return;
          if (pending.kind === 'preset') patchBrief({ styleTags: pending.tags });
          else void runStyleTags();
        }}
      >
        <div>
          当前项目已有
          {[
            project.characters.length > 0 ? `${project.characters.length} 个角色` : '',
            project.scenes.length > 0 ? `${project.scenes.length} 个场景` : '',
            project.shots.length > 0 ? `${project.shots.length} 个镜头` : '',
            assetCount > 0 ? `${assetCount} 张图` : '',
          ]
            .filter(Boolean)
            .join('、')}
          ，更换风格后旧图不会自动重画。
        </div>
      </ConfirmDialog>
    </div>
  );
}
