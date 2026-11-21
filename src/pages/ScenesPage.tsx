import { useEffect, useState } from 'react';
import { useAppStore } from '../store/app';
import { Field, Info } from '../components/bits';
import { SCHEMA_VERSION, type SceneCard } from '../types/model';
import { newId } from '../services/storage';
import { AssetGallery, AssetPeek, ImagePanel } from '../components/ImagePanel';
import { BatchGenerateCard } from '../components/BatchGenerateCard';
import { AiFlowGuide } from '../components/AiFlowGuide';
import { useImage } from '../store/image';
import { Reveal } from '../components/Reveal';
import { Icon } from '../components/Icon';

/**
 * 场景设定（方案.md v0.6 §3.2 M3 —— 与角色卡同级的一等公民）
 *
 * 这是用户明确要求纳入审查范围的部分：
 * 「除了人物的前后一致性，也要审查场景的一致性」。
 *
 * 场景不走样的关键不是「描述得漂亮」，而是**固定元素**：
 * 观众靠它们认出「还是这间教室」。所以这一栏被放在最显眼的位置。
 */

function makeScene(name: string): SceneCard {
  const ts = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    id: newId('sc'),
    name,
    identity: { placeType: '', spatialStructure: '', summary: '', summaryEn: '' },
    variants: [],
    continuityLocks: [],
    fixedElements: [],
    lightDirection: '',
    mainColor: '',
    shotIds: [],
  };
}

export function ScenesPage({ embedded = false }: { embedded?: boolean } = {}) {
  const project = useAppStore((s) => s.project);
  const upsertScene = useAppStore((s) => s.upsertScene);
  const removeScene = useAppStore((s) => s.removeScene);
  const [openId, setOpenId] = useState<string | null>(null);
  const gallery = useImage((s) => s.gallery);
  const loadGallery = useImage((s) => s.loadGallery);

  function galleryFor(refId: string) {
    return gallery[refId] ?? [];
  }

  useEffect(() => {
    // 只在**项目切换**时重新载入图库。
    //
    // 【v0.28 修】原来的依赖是 `project?.shots` / `project?.characters` 这类数组，
    // 而每次编辑都会产生新数组 → 每敲一个字符都重跑一次；
    // 而这里会为**每一个对象**调一次 listAssetsFor，等于一次按键做 N 次查询。
    // 一张图几 MB base64，20 个对象就是几十 MB 的反序列化，表现为打字卡顿。
    //
    // 依赖收成 project.id 之后：换项目时才重载；出图完成后由出图流程刷新。
    for (const scene of project?.scenes ?? []) void loadGallery(scene.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (!project) {
    return <div className="empty">还没有打开任何项目。先去「作品主页」新建或打开一个。</div>;
  }

  function add() {
    const scene = makeScene(`场景 ${project!.scenes.length + 1}`);
    upsertScene(scene);
    setOpenId(scene.id);
  }

  return (
    <>
      <div className={`page-head${embedded ? ' page-head-compact' : ''}`}>
        {embedded ? <span /> : <h1>场景设定</h1>}
        <button type="button" className="btn btn-primary btn-sm" onClick={add}>
          <Icon name="plus" size={14} />
          <span>场景</span>
        </button>
      </div>

      {/* AI 流程指引：只显示「当前该做哪一步」，全做完就自动消失 */}
      <AiFlowGuide variant="compact" />

      {project.scenes.length > 0 ? <BatchGenerateCard tasks={['scenes']} /> : null}

      {project.scenes.length === 0 ? (
        <div className="empty">还没有场景。点右上角加一个。</div>
      ) : null}

      {project.scenes.map((scene) => {
        const open = openId === scene.id;
        const shots = project.shots.filter((s) => s.sceneId === scene.id);
        const missing: string[] = [];
        if (scene.fixedElements.length === 0) missing.push('固定元素');
        if (!scene.lightDirection.trim()) missing.push('主光方向');
        if (!scene.mainColor.trim()) missing.push('主色调');
        return (
          <div className="card" key={scene.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="row" style={{ flex: 1 }}>
                <input
                  type="text"
                  aria-label="场景名字"
                  style={{ maxWidth: 220 }}
                  value={scene.name}
                  onChange={(e) => upsertScene({ ...scene, name: e.target.value })}
                />
                <span className="tag">{shots.length} 镜</span>
                {missing.length > 0 ? (
                  <span className="tag tag-warning">缺：{missing.join('、')}</span>
                ) : (
                  <span className="tag tag-ok">设定完整</span>
                )}
              </div>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-ghost btn-icon expand-toggle"
                  aria-expanded={open}
                  aria-controls={`scene-more-${scene.id}`}
                  aria-label={open ? '收起这个场景' : '展开这个场景'}
                  title={open ? '收起' : '展开'}
                  onClick={() => setOpenId(open ? null : scene.id)}
                >
                  <Icon name="chevron-right" size={15} className="expand-chevron" />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon is-danger"
                  aria-label={`删除场景「${scene.name}」`}
                  title="删除"
                  onClick={() => {
                    if (window.confirm(`删除场景「${scene.name}」？用到它的镜头会变成「未指定场景」。`)) {
                      removeScene(scene.id);
                    }
                  }}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </div>

            {/* 折叠时也能看图：先看一眼是不是同一个地方，再决定要不要展开改 */}
            <AssetPeek assets={galleryFor(scene.id)} />

            <Reveal open={open}>
              <div
                className="card-more"
                id={`scene-more-${scene.id}`}
                style={{ marginTop: 16 }}
              >
                <h2 style={{ fontSize: 13, margin: '0 0 8px' }}>① 身份（这是哪里）</h2>
                <Field label="地点类型">
                  <input
                    type="text"
                    value={scene.identity.placeType}
                    onChange={(e) =>
                      upsertScene({
                        ...scene,
                        identity: { ...scene.identity, placeType: e.target.value },
                      })
                    }
                    placeholder="例：老式高中教室"
                  />
                </Field>
                <Field
                  label="空间结构"
                  hint="房间形状、门在哪、有什么大件家具。这决定了镜头能怎么摆。"
                >
                  <textarea
                    rows={2}
                    value={scene.identity.spatialStructure}
                    onChange={(e) =>
                      upsertScene({
                        ...scene,
                        identity: { ...scene.identity, spatialStructure: e.target.value },
                      })
                    }
                    placeholder="例：长方形，靠窗一排，讲台在短边，后门在左后方"
                  />
                </Field>
                <Field label="一句话概述（中文）">
                  <input
                    type="text"
                    value={scene.identity.summary}
                    onChange={(e) =>
                      upsertScene({
                        ...scene,
                        identity: { ...scene.identity, summary: e.target.value },
                      })
                    }
                  />
                </Field>
                <Field label="英文概述（会注入提示词）">
                  <input
                    type="text"
                    value={scene.identity.summaryEn}
                    onChange={(e) =>
                      upsertScene({
                        ...scene,
                        identity: { ...scene.identity, summaryEn: e.target.value },
                      })
                    }
                    placeholder="a present-day high school classroom in the late afternoon"
                  />
                </Field>

                <h2 style={{ fontSize: 13, margin: '20px 0 8px' }}>② 固定元素（跨镜必须出现）</h2>
                <Field
                  label="每行一条，用英文短语写"
                  hint="3–5 条就够。挑那些一眼能认出地方的标志物，不用把整个房间写一遍。"
                >
                  <textarea
                    rows={4}
                    value={scene.fixedElements.join('\n')}
                    onChange={(e) =>
                      upsertScene({
                        ...scene,
                        fixedElements: e.target.value
                          .split('\n')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder={'rows of wooden desks facing a green blackboard\nfluorescent ceiling lights\na tall window on the left wall'}
                  />
                </Field>

                <h2 style={{ fontSize: 13, margin: '20px 0 8px' }}>③ 光线与色调</h2>
                <div className="grid-2">
                  <Field label="主光方向" hint="光从哪来、什么颜色、什么时候">
                    <input
                      type="text"
                      value={scene.lightDirection}
                      onChange={(e) => upsertScene({ ...scene, lightDirection: e.target.value })}
                      placeholder="例：傍晚，暖光从右侧窗户斜射"
                    />
                  </Field>
                  <Field label="主色调">
                    <input
                      type="text"
                      value={scene.mainColor}
                      onChange={(e) => upsertScene({ ...scene, mainColor: e.target.value })}
                      placeholder="例：暖橙 + 灰绿"
                    />
                  </Field>
                  <Field label="默认时段">
                    <input
                      type="text"
                      value={scene.timeOfDay ?? ''}
                      onChange={(e) => upsertScene({ ...scene, timeOfDay: e.target.value })}
                      placeholder="例：傍晚"
                    />
                  </Field>
                  <Field label="默认天气">
                    <input
                      type="text"
                      value={scene.weather ?? ''}
                      onChange={(e) => upsertScene({ ...scene, weather: e.target.value })}
                      placeholder="例：晴"
                    />
                  </Field>
                </div>

                <h2 style={{ fontSize: 13, margin: '20px 0 8px' }}>④ 连续性锁</h2>
                <p className="hint" style={{ marginTop: 0 }}>
                  写成能原样贴进提示词的短语
                  <Info label="举个例">
                    <code>a green blackboard with chalk dust at its base</code>
                  </Info>
                </p>
                {scene.continuityLocks.map((lock) => (
                  <div className="row" key={lock.id} style={{ marginBottom: 8 }}>
                    <input
                      type="text"
                      aria-label="这条锁的名字（中文短名）"
                      style={{ maxWidth: 160 }}
                      value={lock.label}
                      onChange={(e) =>
                        upsertScene({
                          ...scene,
                          continuityLocks: scene.continuityLocks.map((l) =>
                            l.id === lock.id ? { ...l, label: e.target.value } : l,
                          ),
                        })
                      }
                      placeholder="锁名"
                    />
                    <input
                      type="text"
                      aria-label="锁面，会原样写进提示词"
                      style={{ flex: 1, minWidth: 220 }}
                      value={lock.phrase}
                      onChange={(e) =>
                        upsertScene({
                          ...scene,
                          continuityLocks: scene.continuityLocks.map((l) =>
                            l.id === lock.id ? { ...l, phrase: e.target.value } : l,
                          ),
                        })
                      }
                      placeholder="锁面"
                    />
                    <button
                      type="button"
                      aria-label={`删除锁「${lock.label}」`}
                      title="删除"
                      className="btn btn-ghost btn-icon is-danger"
                      onClick={() =>
                        upsertScene({
                          ...scene,
                          continuityLocks: scene.continuityLocks.filter((l) => l.id !== lock.id),
                        })
                      }
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    upsertScene({
                      ...scene,
                      continuityLocks: [
                        ...scene.continuityLocks,
                        { id: newId('lock'), label: '新锁', phrase: '', appliesTo: 'geography' },
                      ],
                    })
                  }
                >
                  + 加一条锁
                </button>

                <ImagePanel
                  refId={scene.id}
                  target="scene"
                  label="场景参考板"
                  /*
                    反打板（v0.47 加、v0.47 后撤）：实测效果不好——模型交出来的
                    是原图的左右镜像，而场景卡的方位是按房间坐标写的，一镜像就
                    和文字打架。底层没有删（类型、提示词、按朝向挑板的逻辑都留着），
                    只是界面不再提供入口。想再试的时候把这里加回来即可。
                  */
                  options={[
                    {
                      label: '生成场景参考板',
                      useReference: false,
                      angle: 'master',
                    },
                  ]}
                  footer={
                    <AssetGallery
                      assets={galleryFor(scene.id)}
                      emptyHint="还没有生成过场景板。"
                    />
                  }
                />

                <details className="card-fold">
                  <summary>
                    <span className="card-fold-title">⑤ 变体（随剧情变）</span>
                    <span className="card-fold-count">{scene.variants.length} 个</span>
                  </summary>
                  <p className="card-fold-desc">
                    同一个地方的不同状态，例：窗户被打碎。不填就只用上面写好的那一套。
                  </p>
                {scene.variants.map((variant) => (
                  <div className="row" key={variant.id} style={{ marginBottom: 8 }}>
                    <input
                      type="text"
                      aria-label="变体名字"
                      style={{ maxWidth: 180 }}
                      value={variant.label}
                      onChange={(e) =>
                        upsertScene({
                          ...scene,
                          variants: scene.variants.map((v) =>
                            v.id === variant.id ? { ...v, label: e.target.value } : v,
                          ),
                        })
                      }
                      placeholder="变体名，例：窗户被打碎"
                    />
                    <input
                      type="text"
                      aria-label="变体改变了什么，用顿号分隔"
                      style={{ flex: 1, minWidth: 220 }}
                      value={variant.changedFeatures.join('、')}
                      onChange={(e) =>
                        upsertScene({
                          ...scene,
                          variants: scene.variants.map((v) =>
                            v.id === variant.id
                              ? {
                                  ...v,
                                  changedFeatures: e.target.value
                                    .split(/[、,，]/)
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                                }
                              : v,
                          ),
                        })
                      }
                      placeholder="改变了什么"
                    />
                    <button
                      type="button"
                      aria-label={`删除变体「${variant.label}」`}
                      title="删除"
                      className="btn btn-ghost btn-icon is-danger"
                      onClick={() =>
                        upsertScene({
                          ...scene,
                          variants: scene.variants.filter((v) => v.id !== variant.id),
                        })
                      }
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    upsertScene({
                      ...scene,
                      variants: [
                        ...scene.variants,
                        { id: newId('var'), label: '新变体', changedFeatures: [], shotIds: [] },
                      ],
                    })
                  }
                >
                  + 加一个变体
                </button>
                </details>
              </div>
            </Reveal>
          </div>
        );
      })}
    </>
  );
}
