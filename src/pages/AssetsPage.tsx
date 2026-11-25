import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { useImage } from '../store/image';
import { computeImageCoverage } from '../components/imageCoverage';
import { Field } from '../components/bits';
import { Icon } from '../components/Icon';
import {
  isCharacterStageEnabled,
  isPhysicalSceneStageEnabled,
  makeDefaultVisualBible,
  resolveVideoMode,
  VIDEO_MODE_SHORT_LABEL,
  VISUAL_ASSET_CATEGORY_LABEL,
} from '../domain/pipeline/profiles';
import type { VisualBible } from '../types/model';
import { CharactersPage } from './CharactersPage';
import { ScenesPage } from './ScenesPage';
import { PropsSection } from '../components/assets/PropsSection';

export type AssetsTab = 'characters' | 'scenes' | 'props' | 'visual-bible';

export function AssetsPage({ initialTab = 'characters' }: { initialTab?: AssetsTab }) {
  const location = useLocation();
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const patchProject = useAppStore((s) => s.patchProject);
  const gallery = useImage((s) => s.gallery);
  const loadGallery = useImage((s) => s.loadGallery);

  const videoMode = resolveVideoMode(project);
  const charEnabled = isCharacterStageEnabled(project);
  const sceneEnabled = isPhysicalSceneStageEnabled(project);

  const defaultTabForMode: AssetsTab =
    videoMode === 'narrative'
      ? initialTab
      : videoMode === 'scenic'
        ? 'visual-bible'
        : 'visual-bible';

  const routeTab: AssetsTab =
    location.pathname === '/scenes'
      ? sceneEnabled
        ? 'scenes'
        : 'visual-bible'
      : location.pathname === '/characters'
        ? charEnabled
          ? 'characters'
          : 'visual-bible'
        : defaultTabForMode;

  const [tab, setTab] = useState<AssetsTab>(routeTab);

  useEffect(() => {
    setTab(routeTab);
  }, [routeTab]);

  useEffect(() => {
    if (!project) return;
    for (const c of project.characters) void loadGallery(c.id);
    for (const s of project.scenes) void loadGallery(s.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (!project) {
    return <div className="empty">先去作品主页打开或新建项目。</div>;
  }

  const coverage = computeImageCoverage(project, gallery);
  const totalLocks =
    project.characters.reduce((n, c) => n + c.continuityLocks.length, 0) +
    project.scenes.reduce((n, s) => n + s.continuityLocks.length, 0);
  const visualAssets = project.visualAssets ?? [];
  const bible: VisualBible = project.visualBible ?? makeDefaultVisualBible(videoMode);

  function updateBible(patch: Partial<VisualBible>) {
    patchProject({ visualBible: { ...bible, ...patch } });
  }

  function switchTab(next: AssetsTab) {
    setTab(next);
    if (location.pathname === '/characters' || location.pathname === '/scenes') {
      if (next === 'characters') navigate('/characters', { replace: true });
      else if (next === 'scenes') navigate('/scenes', { replace: true });
      else navigate('/assets', { replace: true });
    }
  }

  return (
    <div className="workspace-hub assets-hub">
      <header className="hub-hero">
        <h1>
          设定集
          {videoMode !== 'narrative' ? (
            <span className="tag" style={{ marginLeft: 8, verticalAlign: 'middle' }}>
              {VIDEO_MODE_SHORT_LABEL[videoMode]}
            </span>
          ) : null}
        </h1>

        <div className="hub-tabs" role="tablist" aria-label="设定集分类">
          {videoMode !== 'narrative' ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'visual-bible'}
              className={`hub-tab${tab === 'visual-bible' ? ' active' : ''}`}
              onClick={() => switchTab('visual-bible')}
            >
              <Icon name="palette" size={15} />
              <span>{videoMode === 'scenic' ? '视觉圣经与环境锚点' : '风格预设与视觉母题'}</span>
              <span className="hub-tab-badge">{visualAssets.length}</span>
            </button>
          ) : null}

          {charEnabled ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'characters'}
              className={`hub-tab${tab === 'characters' ? ' active' : ''}`}
              onClick={() => switchTab('characters')}
            >
              <Icon name="users" size={15} />
              <span>{videoMode === 'explainer' ? '虚拟讲解员' : '角色'}</span>
              <span className="hub-tab-badge">
                {coverage.charsReady}/{project.characters.length}
              </span>
            </button>
          ) : null}

          {sceneEnabled ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'scenes'}
              className={`hub-tab${tab === 'scenes' ? ' active' : ''}`}
              onClick={() => switchTab('scenes')}
            >
              <Icon name="map" size={15} />
              <span>{videoMode === 'scenic' ? '宏观环境板' : '场景'}</span>
              <span className="hub-tab-badge">
                {coverage.scenesReady}/{project.scenes.length}
              </span>
            </button>
          ) : null}

          {videoMode === 'narrative' ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'props'}
              className={`hub-tab${tab === 'props' ? ' active' : ''}`}
              onClick={() => switchTab('props')}
            >
              <Icon name="sparkles" size={15} />
              <span>关键道具</span>
              <span className="hub-tab-badge">{(project.props ?? []).length}</span>
            </button>
          ) : null}
        </div>

        <div className="hub-compact-stat" title="已登记的连续性锁总数">
          <Icon name="lock" size={14} />
          <span>{totalLocks} 锁</span>
        </div>
      </header>

      <div className="hub-stage">
        {tab === 'visual-bible' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <section className="card">
              <h2 className="card-title">
                {videoMode === 'scenic'
                  ? '全局视觉圣经（Visual Bible）'
                  : '全局风格预设（Style Preset）'}
              </h2>
              <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
                {videoMode === 'scenic'
                  ? '当前为自然风光无角色模式：角色阶段已跳过。以下常量会逐字注入每一镜提示词，防止光影、色温与景深漂移。'
                  : '当前为科普解说无实景模式：物理场景已跳过。以下风格铁律与视觉母题将取代教室/实验室实景锁定全片视觉统一。'}
              </p>
              <div className="grid-2">
                <Field label="风格与质感锚点（英文）">
                  <input
                    type="text"
                    value={bible.styleAnchor}
                    onChange={(e) => updateBible({ styleAnchor: e.target.value })}
                    placeholder="35mm documentary cinema, natural film grain"
                  />
                </Field>
                <Field label="锁定色板（逗号分隔）">
                  <input
                    type="text"
                    value={bible.colorPalette.join(', ')}
                    onChange={(e) =>
                      updateBible({
                        colorPalette: e.target.value
                          .split(/[,，]/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="deep navy, cyan accent, warm amber"
                  />
                </Field>
                <Field label="固定光源方向">
                  <input
                    type="text"
                    value={bible.lightingDirection}
                    onChange={(e) => updateBible({ lightingDirection: e.target.value })}
                    placeholder="low golden sunlight from upper-left"
                  />
                </Field>
                <Field label="焦段与构图约束">
                  <input
                    type="text"
                    value={bible.lensAndFramingRule}
                    onChange={(e) => updateBible({ lensAndFramingRule: e.target.value })}
                    placeholder="50mm+ mid-telephoto to prevent wide-angle distortion"
                  />
                </Field>
                <Field label={videoMode === 'scenic' ? '大气湿度与天气规则' : '图形语汇与符号规则'}>
                  <input
                    type="text"
                    value={bible.atmosphereOrMotifRules}
                    onChange={(e) => updateBible({ atmosphereOrMotifRules: e.target.value })}
                  />
                </Field>
                <Field label="正向风格铁律">
                  <input
                    type="text"
                    value={bible.styleExclusionRule}
                    onChange={(e) => updateBible({ styleExclusionRule: e.target.value })}
                  />
                </Field>
              </div>
            </section>

            <section className="card">
              <h2 className="card-title">
                {videoMode === 'scenic' ? '环境与风格参考锚点' : '非人物视觉母题库（Motif Manifest）'}
                <span className="tag" style={{ marginLeft: 8 }}>
                  {visualAssets.length} 项
                </span>
              </h2>
              {visualAssets.length === 0 ? (
                <p className="muted" style={{ fontSize: 13 }}>
                  暂无视觉资产。在故事页或分镜页触发生成后会自动提取，非生命体要素不会再被误注册为角色。
                </p>
              ) : (
                <div className="grid-2">
                  {visualAssets.map((asset) => (
                    <div
                      key={asset.id}
                      style={{
                        padding: 12,
                        border: '1px solid var(--line)',
                        borderRadius: 10,
                        background: 'var(--bg-elev)',
                      }}
                    >
                      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                        <b>{asset.name}</b>
                        <span className="tag">
                          {VISUAL_ASSET_CATEGORY_LABEL[asset.category]} · {asset.tag}
                        </span>
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {asset.visualPrompt || '待补充英文绘制描述'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {videoMode === 'explainer' ? (
              <section className="card">
                <h2 className="card-title">连续旁白时间轴（旁白先行）</h2>
                <Field label="整篇连续解说词">
                  <textarea
                    rows={5}
                    value={project.narrationScript ?? ''}
                    onChange={(e) => patchProject({ narrationScript: e.target.value })}
                    placeholder="按「3秒钩子 → 核心论点 → 概念节拍 → 总结」撰写完整连续旁白，分镜会自动按时间轴切分。"
                  />
                </Field>
              </section>
            ) : null}
          </div>
        ) : tab === 'characters' ? (
          <CharactersPage embedded />
        ) : tab === 'props' ? (
          <PropsSection />
        ) : (
          <ScenesPage embedded />
        )}
      </div>
    </div>
  );
}
