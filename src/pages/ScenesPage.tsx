import { useEffect, useState } from 'react';
import { useAppStore } from '../store/app';
import { Field, WhyDetails } from '../components/bits';
import { SCHEMA_VERSION, type SceneCard } from '../types/model';
import { newId } from '../services/storage';
import { AssetGallery, ImagePanel } from '../components/ImagePanel';
import { BatchGenerateCard } from '../components/BatchGenerateCard';
import { AiFlowGuide } from '../components/AiFlowGuide';
import { useImage } from '../store/image';

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

export function ScenesPage() {
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
    return <div className="empty">还没有打开任何项目。先去「项目」页新建或打开一个。</div>;
  }

  function add() {
    const scene = makeScene(`场景 ${project!.scenes.length + 1}`);
    upsertScene(scene);
    setOpenId(scene.id);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>场景设定</h2>
          <p>
            <b>固定元素</b>是「这是同一个地方」的依据。
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={add}>
          + 加一个场景
        </button>
      </div>

      {/* AI 流程指引：只显示「当前该做哪一步」，全做完就自动消失 */}
      <AiFlowGuide variant="compact" />

      <div className="card">
        <h3 className="card-title">场景一致性靠什么保证？</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          三个字段，都要写成<b>能直接贴进提示词的短语</b>：
        </p>
        <table className="simple">
          <thead>
            <tr>
              <th style={{ width: 110 }}>字段</th>
              <th>作用</th>
              <th>例子</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>固定元素</td>
              <td>观众认出「还是这地方」的依据，3–5 条</td>
              <td>
                <code>rows of wooden desks facing a green blackboard</code>
              </td>
            </tr>
            <tr>
              <td>主光方向</td>
              <td>决定同一处地方在不同镜头里像不像同一个时刻</td>
              <td>傍晚，暖光从右侧窗户斜射</td>
            </tr>
            <tr>
              <td>主色调</td>
              <td>观众判断「换了地方」最直接的线索</td>
              <td>暖橙 + 灰绿</td>
            </tr>
          </tbody>
        </table>
        <WhyDetails>
          为什么光线和色调也算「场景一致性」？因为观众判断「这是不是同一个地方」，
          靠的主要不是墙上的裂缝，而是<b>光的方向和整体色调</b>。
          <br />
          <br />
          一个傍晚的教室写成「正午顶光」，观众立刻会觉得不对劲——即使桌椅黑板一个没变。
          检查引擎会把这种冲突指出来；如果是剧情有意安排的（比如时间真的从白天到了晚上），
          给它建一个<b>变体</b>，引擎就知道这是有意的，不再报冲突。
        </WhyDetails>
      </div>

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
                  className="btn btn-ghost btn-sm"
                  onClick={() => setOpenId(open ? null : scene.id)}
                >
                  {open ? '收起' : '展开'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    if (window.confirm(`删除场景「${scene.name}」？用到它的镜头会变成「未指定场景」。`)) {
                      removeScene(scene.id);
                    }
                  }}
                >
                  删除
                </button>
              </div>
            </div>

            {open ? (
              <div style={{ marginTop: 16 }}>
                <h4 style={{ fontSize: 13, margin: '0 0 8px' }}>① 身份（这是哪里）</h4>
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

                <h4 style={{ fontSize: 13, margin: '20px 0 8px' }}>② 固定元素（跨镜必须出现）</h4>
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

                <h4 style={{ fontSize: 13, margin: '20px 0 8px' }}>③ 光线与色调</h4>
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

                <h4 style={{ fontSize: 13, margin: '20px 0 8px' }}>④ 连续性锁</h4>
                <p className="hint" style={{ marginTop: 0 }}>
                  和角色锁一样，锁面写成能原样贴进提示词的短语。例：
                  <code>a green blackboard with chalk dust at its base</code>
                </p>
                {scene.continuityLocks.map((lock) => (
                  <div className="row" key={lock.id} style={{ marginBottom: 8 }}>
                    <input
                      type="text"
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
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        upsertScene({
                          ...scene,
                          continuityLocks: scene.continuityLocks.filter((l) => l.id !== lock.id),
                        })
                      }
                    >
                      删除
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
                  options={[
                    {
                      label: '生成场景参考板',
                      useReference: false,
                      hint: '刻意不画人。用来固定空间结构、固定元素与光线。',
                    },
                  ]}
                  footer={
                    <AssetGallery
                      assets={galleryFor(scene.id)}
                      emptyHint="还没有生成过场景板。"
                    />
                  }
                />

                <h4 style={{ fontSize: 13, margin: '20px 0 8px' }}>⑤ 变体（随剧情变）</h4>
                <p className="hint" style={{ marginTop: 0 }}>
                  「被打碎了窗户」是变体，不是新场景。登记后检查引擎会豁免对应冲突。
                </p>
                {scene.variants.map((variant) => (
                  <div className="row" key={variant.id} style={{ marginBottom: 8 }}>
                    <input
                      type="text"
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
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        upsertScene({
                          ...scene,
                          variants: scene.variants.filter((v) => v.id !== variant.id),
                        })
                      }
                    >
                      删除
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
              </div>
            ) : (
              <div className="hint" style={{ marginTop: 6 }}>
                {scene.lightDirection || '（没写光线）'} · {scene.mainColor || '（没写色调）'}
                {scene.fixedElements.length > 0
                  ? ` · 固定元素：${scene.fixedElements.slice(0, 2).join(' / ')}`
                  : ''}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
