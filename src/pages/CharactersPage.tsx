import { useEffect, useState } from 'react';
import { useAppStore } from '../store/app';
import { Field, WhyDetails, Info } from '../components/bits';
import {
  CHARACTER_ROLE_LABEL,
  LOCK_ASPECT_LABEL,
  SCHEMA_VERSION,
  type CharacterCard,
  type ContinuityLock,
  type LockAspect,
} from '../types/model';
import { newId } from '../services/storage';
import { AssetGallery, ImagePanel } from '../components/ImagePanel';
import { BatchGenerateCard } from '../components/BatchGenerateCard';
import { AiFlowGuide } from '../components/AiFlowGuide';
import { useImage } from '../store/image';
import { SelectMenu } from '../components/SelectMenu';
import { Reveal } from '../components/Reveal';
import { Icon } from '../components/Icon';

const ROLE_OPTIONS = Object.entries(CHARACTER_ROLE_LABEL).map(([value, label]) => ({
  value,
  label,
}));

const LOCK_ASPECT_OPTIONS = Object.entries(LOCK_ASPECT_LABEL).map(([value, label]) => ({
  value,
  label,
}));

/**
 * M3 角色设定卡（方案.md v0.6 §6.2）
 *
 * 三层结构，不是平铺的描述 + 参考图 + 种子：
 *  - 身份：这个人是谁，跨集不变
 *  - 变体：随剧情变的状态。「换了件外套」是变体，不是新角色
 *  - 连续性锁：只锁「不随剧情改变、且观众看得出不一致」的可见事实
 *
 * 锁面必须写成能**原样贴进提示词**的短语——这是整套机制的核心。
 */

function makeCharacter(name: string): CharacterCard {
  const ts = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    id: newId('ch'),
    name,
    role: 'supporting',
    identity: {
      face: '',
      hair: '',
      bodyType: '',
      ageRange: '',
      summary: '',
      summaryEn: '',
    },
    variants: [],
    continuityLocks: [],
    shotIds: [],
  };
}

export function CharactersPage() {
  const project = useAppStore((s) => s.project);
  const upsertCharacter = useAppStore((s) => s.upsertCharacter);
  const removeCharacter = useAppStore((s) => s.removeCharacter);
  const [openId, setOpenId] = useState<string | null>(null);
  const gallery = useImage((s) => s.gallery);
  const loadGallery = useImage((s) => s.loadGallery);

  function galleryFor(refId: string) {
    return gallery[refId] ?? [];
  }

  // 角色列表渲染时把每个角色的图库都载进来，页面打开即可见
  useEffect(() => {
    // 只在**项目切换**时重新载入图库。
    //
    // 【v0.28 修】原来的依赖是 `project?.shots` / `project?.characters` 这类数组，
    // 而每次编辑都会产生新数组 → 每敲一个字符都重跑一次；
    // 而这里会为**每一个对象**调一次 listAssetsFor，等于一次按键做 N 次查询。
    // 一张图几 MB base64，20 个对象就是几十 MB 的反序列化，表现为打字卡顿。
    //
    // 依赖收成 project.id 之后：换项目时才重载；出图完成后由出图流程刷新。
    for (const character of project?.characters ?? []) void loadGallery(character.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (!project) {
    return <div className="empty">还没有打开任何项目。先去「作品主页」新建或打开一个。</div>;
  }

  function add() {
    const character = makeCharacter(`角色 ${project!.characters.length + 1}`);
    upsertCharacter(character);
    setOpenId(character.id);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>角色设定</h1>
          <p>角色分三层：身份 / 变体 / 连续性锁。</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={add}>
          + 加一个角色
        </button>
      </div>

      {/* AI 流程指引：只显示「当前该做哪一步」，全做完就自动消失 */}
      <AiFlowGuide variant="compact" />

      {project.characters.length > 0 ? <BatchGenerateCard tasks={['characters']} /> : null}

      {project.characters.length === 0 ? (
        <div className="empty">还没有角色。点右上角加一个。</div>
      ) : null}

      {project.characters.map((character) => {
        const open = openId === character.id;
        const shots = project.shots.filter((s) => s.characterIds.includes(character.id));
        return (
          <div className="card" key={character.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="row" style={{ flex: 1 }}>
                <input
                  type="text"
                  style={{ maxWidth: 200 }}
                  value={character.name}
                  onChange={(e) => upsertCharacter({ ...character, name: e.target.value })}
                />
                <SelectMenu
                  className="character-role-select"
                  value={character.role}
                  options={ROLE_OPTIONS}
                  ariaLabel={`${character.name}的角色类型`}
                  onChange={(value) =>
                    upsertCharacter({
                      ...character,
                      role: value as CharacterCard['role'],
                    })
                  }
                />
                <span className="tag">{shots.length} 镜出镜</span>
                {character.continuityLocks.length === 0 ? (
                  <span className="tag tag-warning">没有连续性锁</span>
                ) : (
                  <span className="tag tag-ok">{character.continuityLocks.length} 条锁</span>
                )}
              </div>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm expand-toggle"
                  aria-expanded={open}
                  aria-controls={`character-more-${character.id}`}
                  onClick={() => setOpenId(open ? null : character.id)}
                >
                  {open ? '收起' : '展开'}
                  <Icon name="chevron-right" size={13} className="expand-chevron" />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    if (window.confirm(`删除角色「${character.name}」？分镜里对他的引用也会一并清掉。`)) {
                      removeCharacter(character.id);
                    }
                  }}
                >
                  删除
                </button>
              </div>
            </div>

            <Reveal open={open}>
              <div
                className="card-more"
                id={`character-more-${character.id}`}
                style={{ marginTop: 16 }}
              >
                <h4 style={{ fontSize: 13, margin: '0 0 8px' }}>① 身份（跨集不变）</h4>
                <div className="grid-2">
                  <Field label="面部特征">
                    <input
                      type="text"
                      value={character.identity.face}
                      onChange={(e) =>
                        upsertCharacter({
                          ...character,
                          identity: { ...character.identity, face: e.target.value },
                        })
                      }
                      placeholder="例：方脸，眉浓而压，眼窝深"
                    />
                  </Field>
                  <Field label="发型发色">
                    <input
                      type="text"
                      value={character.identity.hair}
                      onChange={(e) =>
                        upsertCharacter({
                          ...character,
                          identity: { ...character.identity, hair: e.target.value },
                        })
                      }
                    />
                  </Field>
                  <Field label="体型">
                    <input
                      type="text"
                      value={character.identity.bodyType}
                      onChange={(e) =>
                        upsertCharacter({
                          ...character,
                          identity: { ...character.identity, bodyType: e.target.value },
                        })
                      }
                    />
                  </Field>
                  <Field label="年龄段">
                    <input
                      type="text"
                      value={character.identity.ageRange}
                      onChange={(e) =>
                        upsertCharacter({
                          ...character,
                          identity: { ...character.identity, ageRange: e.target.value },
                        })
                      }
                    />
                  </Field>
                </div>
                <Field label="一句话概述（中文，给你自己看）">
                  <input
                    type="text"
                    value={character.identity.summary}
                    onChange={(e) =>
                      upsertCharacter({
                        ...character,
                        identity: { ...character.identity, summary: e.target.value },
                      })
                    }
                  />
                </Field>
                <Field
                  label="英文身份描述（会注入提示词）"
                  hint="格式建议：名字, 年龄体型, 面部特征。模型对英文的理解更稳。"
                >
                  <input
                    type="text"
                    value={character.identity.summaryEn}
                    onChange={(e) =>
                      upsertCharacter({
                        ...character,
                        identity: { ...character.identity, summaryEn: e.target.value },
                      })
                    }
                    placeholder="Lin Chong, a lean tall warrior in his thirties, square face, thick brows"
                  />
                </Field>

                <h4 style={{ fontSize: 13, margin: '20px 0 8px' }}>
                  ② 连续性锁（必须跨镜保持）
                  <Info label="怎么写、举个例">
                    写成能直接贴进提示词的短语。中文英文都可以，但英文通常更稳。例：
                    <code>pine-green lapel service jacket</code>、
                    <code>a long wooden spear with a tarnished steel head</code>
                  </Info>
                </h4>
                {character.continuityLocks.map((lock) => (
                  <div className="row" key={lock.id} style={{ marginBottom: 8 }}>
                    <input
                      type="text"
                      style={{ maxWidth: 160 }}
                      value={lock.label}
                      onChange={(e) =>
                        upsertCharacter({
                          ...character,
                          continuityLocks: character.continuityLocks.map((l) =>
                            l.id === lock.id ? { ...l, label: e.target.value } : l,
                          ),
                        })
                      }
                      placeholder="锁名，例：旧棉袍"
                    />
                    <input
                      type="text"
                      style={{ flex: 1, minWidth: 220 }}
                      value={lock.phrase}
                      onChange={(e) =>
                        upsertCharacter({
                          ...character,
                          continuityLocks: character.continuityLocks.map((l) =>
                            l.id === lock.id ? { ...l, phrase: e.target.value } : l,
                          ),
                        })
                      }
                      placeholder="锁面，例：a worn padded cotton robe in faded indigo"
                    />
                    <SelectMenu
                      className="lock-aspect-select"
                      value={lock.appliesTo}
                      options={LOCK_ASPECT_OPTIONS}
                      ariaLabel="这条锁锁的是哪个方面"
                      onChange={(value) =>
                        upsertCharacter({
                          ...character,
                          continuityLocks: character.continuityLocks.map((l) =>
                            l.id === lock.id ? { ...l, appliesTo: value as LockAspect } : l,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        upsertCharacter({
                          ...character,
                          continuityLocks: character.continuityLocks.filter((l) => l.id !== lock.id),
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
                  onClick={() => {
                    const lock: ContinuityLock = {
                      id: newId('lock'),
                      label: '新锁',
                      phrase: '',
                      appliesTo: 'look',
                    };
                    upsertCharacter({
                      ...character,
                      continuityLocks: [...character.continuityLocks, lock],
                    });
                  }}
                >
                  + 加一条锁
                </button>

                <h4 style={{ fontSize: 13, margin: '20px 0 8px' }}>③ 变体（随剧情变）</h4>
                {character.variants.map((variant) => (
                  <div className="row" key={variant.id} style={{ marginBottom: 8 }}>
                    <input
                      type="text"
                      style={{ maxWidth: 180 }}
                      value={variant.label}
                      onChange={(e) =>
                        upsertCharacter({
                          ...character,
                          variants: character.variants.map((v) =>
                            v.id === variant.id ? { ...v, label: e.target.value } : v,
                          ),
                        })
                      }
                      placeholder="变体名，例：风雪中·满身落雪"
                    />
                    <input
                      type="text"
                      style={{ flex: 1, minWidth: 220 }}
                      value={variant.changedFeatures.join('、')}
                      onChange={(e) =>
                        upsertCharacter({
                          ...character,
                          variants: character.variants.map((v) =>
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
                      placeholder="改变了什么，用、分隔"
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        upsertCharacter({
                          ...character,
                          variants: character.variants.filter((v) => v.id !== variant.id),
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
                    upsertCharacter({
                      ...character,
                      variants: [
                        ...character.variants,
                        { id: newId('var'), label: '新变体', changedFeatures: [], shotIds: [] },
                      ],
                    })
                  }
                >
                  + 加一个变体
                </button>

                <h4 style={{ fontSize: 13, margin: '20px 0 8px' }}>④ 负向词与种子</h4>
                <Field label="负向词（这个角色不该出现的特征）">
                  <input
                    type="text"
                    value={character.negativePrompt ?? ''}
                    onChange={(e) => upsertCharacter({ ...character, negativePrompt: e.target.value })}
                    placeholder="modern clothing, clean new robe, smiling"
                  />
                </Field>
                <Field
                  label="固定种子（可选）"
                  hint="在支持种子的平台上填同一个数字，可以进一步稳定形象。留空则不用。"
                >
                  <input
                    type="number"
                    value={character.seed ?? ''}
                    onChange={(e) =>
                      upsertCharacter({
                        ...character,
                        seed: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                  />
                </Field>

                <ImagePanel
                  refId={character.id}
                  target="character"
                  label="角色形象图"
                  options={[
                    {
                      label: '① 生成全身多视图',
                      useReference: false,
                      sheetKind: 'turnaround',
                      hint: '六个视角：正、侧、背、四分之三、俯视、仰视。锁体型、比例、服装轮廓、发型长度。',
                    },
                    {
                      label: '② 生成头部特写',
                      useReference: false,
                      sheetKind: 'face',
                      hint: '正、侧、背三个头部特写。脸占满画面，比全身图里的脸大几十倍——锁脸主要靠这张。',
                    },
                    {
                      label: '③ 用已有形象图重出一张',
                      useReference: true,
                      sheetKind: 'face',
                      hint: '拿已有的另一类形象图当参考图再生成，让脸和身体互相锚定，避免两张图不是同一个人。',
                    },
                  ]}
                />
                <AssetGallery
                  assets={galleryFor(character.id)}
                  emptyHint="还没有生成过形象图。建议先出「全身多视图」，再出「头部特写」。"
                />

                <WhyDetails>
                  种子（seed）是模型内部的随机数起点。同一个种子 + 同一段提示词，理论上能复现同一张图。
                  <br />
                  <br />
                  但要注意：<b>换了动作或构图之后，种子也保不住形象</b>。它只能让「同样一段提示词」的结果稳定，
                  不能让「不同提示词」生成同一个人。所以它只是连续性锁的补充，不是替代。
                </WhyDetails>
              </div>
            </Reveal>
            {!open ? (
              <div className="hint" style={{ marginTop: 6 }}>
                {character.identity.summary || '（还没写身份描述）'}
                {character.continuityLocks.length > 0
                  ? ` · 锁：${character.continuityLocks.map((l) => l.label).join('、')}`
                  : ''}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}


