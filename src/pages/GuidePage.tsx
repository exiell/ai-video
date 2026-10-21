import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { Field, WhyDetails } from '../components/bits';
import { RichText } from '../components/bits';
import { GenerateBar } from '../components/GenerateBar';
import { AiFlowGuide } from '../components/AiFlowGuide';
import { TermHint } from '../components/TermHint';
import { SelectMenu } from '../components/SelectMenu';
import { matchStylePreset, STYLE_PRESETS } from '../domain/help/stylePresets';
import type { StoryScene, TargetPlatform } from '../types/model';
import { PLATFORM_LABEL } from '../types/model';
import { newId } from '../services/storage';

/**
 * M1 引导向导（方案.md v0.6 §3.2）
 *
 * 设计要点：一次只问一个问题。每一步都带「为什么问这个」的折叠说明。
 *
 * P0a 阶段不接 LLM，所以「让工具生成」这条路会明确告知用户：
 * 现在需要你自己填，P0b 接上模型后才会自动生成。
 * 不装作能生成——那会让用户在按下按钮后一头雾水。
 */

const STEPS = ['故事来源', '填写故事', '风格与规格', '完成'] as const;

interface GuideStep {
  title: string;
  how: string;
  done: string;
  why?: string;
  route: string;
  routeLabel: string;
  optional?: boolean;
}

/**
 * 向导结束后的操作顺序。
 *
 * 为什么要有这个：向导做完，用户面临的是「然后呢」。
 * 光给一句「去分镜表」是不够的——他不知道点哪个按钮、不知道做完该看到什么、
 * 更不知道什么时候可以往下走。
 *
 * 所以每一步都写三件事：点哪里、会发生什么、**做完怎么判断可以往下走**。
 * 最后那条最关键：新手卡住往往不是因为不会操作，而是不知道该不该继续。
 */
const STEPS_AFTER_GUIDE: GuideStep[] = [
  {
    title: '建场景',
    how: '去「场景设定」，点右上角「加一个场景」。每个场景至少写三样：固定元素（3-5 个英文短语，例如 rows of wooden desks）、主光方向（例如 傍晚，暖光从右侧窗户斜射）、主色调（例如 暖橙 + 灰绿）。',
    done: '每个场景的卡片上显示「设定完整」而不是「缺：…」就可以往下走。',
    why: '为什么先建场景：分镜里的每一个镜头都要挂到一个场景上。先有场景，写分镜时才能直接选；反过来做会让你在分镜表里反复停下来去建场景。固定元素和光线是场景一致性的锚点——不写下来，模型每个镜头都会重新布置一遍这个空间。',
    route: '/scenes',
    routeLabel: '场景设定',
  },
  {
    title: '建角色',
    how: '去「角色设定」，点「加一个角色」。填身份描述（中文给你自己看 + 英文给模型看），然后**至少加 2 条连续性锁**——只锁不会随剧情改变、而且观众看得出不一致的特征，例如 a worn padded cotton robe in faded indigo。锁面写成能直接贴进提示词的英文短语。',
    done: '每个角色卡片上显示「N 条锁」而不是「没有连续性锁」。',
    why: '为什么锁这么重要：跨镜穿帮多数不是脸变了，而是服装颜色、手里的东西、湿没湿这些变了。锁面会被原样写进每一镜的提示词，这是角色不走样的主要手段。',
    route: '/characters',
    routeLabel: '角色设定',
  },
  {
    title: '生成分镜表',
    how: '去「分镜表」，点卡片里的「② 生成分镜表」。模型会把故事拆成镜头，并自动挂好场景、角色和连续性锁。',
    done: '看到分镜列表出来，并且镜号连续。',
    why: '如果提示里有「模型漏勾了 N 处连续性锁，已自动补上」是正常的——系统按「这一镜有谁、在哪个场景」机械补齐，比漏掉安全。',
    route: '/storyboard',
    routeLabel: '分镜表',
  },
  {
    title: '跑一次穿帮检查',
    how: '去「穿帮检查」看一眼。有问题的话，页面上方会出现「自动修复」卡片——点它可以看见每条修改的前后对照，勾选你认可的，确认后才生效，而且能撤销。',
    done: '「必须修」那一档清零，或剩下的都是你认可的。',
    why: '这是这个工具最能省事的一步：它在你花钱出图之前，把「哪些必须保持一致」写成可核对的清单。',
    route: '/checks',
    routeLabel: '穿帮检查',
  },
  {
    title: '生成角色形象图',
    how: '回「角色设定」，用「批量生成」卡片里的一键按钮，或逐个角色点「① 生成全身多视图」和「② 生成头部特写」。建议先全身再多视图——头部特写会拿全身图当参考，顺序反了效果打折。',
    done: '点开图放大看，六个视角里是同一个人，面部特征一致。不满意就改锁面重出。',
    why: '头部特写是锁脸的关键：全身图里的脸只有几十像素，模型从这里学不到面部特征。',
    route: '/characters',
    routeLabel: '角色设定',
  },
  {
    title: '生成场景参考板',
    how: '去「场景设定」，用「批量生成」一次跑完，或逐个场景点按钮。',
    done: '每张图里能看到你登记的固定元素，光线方向与场景卡一致。',
    optional: true,
    why: '场景板不是必须的，但有了它，后续关键帧的空间感会稳很多。',
    route: '/scenes',
    routeLabel: '场景设定',
  },
  {
    title: '逐镜生成关键帧',
    how: '回「分镜表」，用「批量生成」里的「全部关键帧」，或逐个镜头点「生成关键帧（锁角色）」。带参考图锚定的那一档效果最好。',
    done: '逐张扫一遍：同一个人在不同镜头里认不认得出、同一处地方像不像同一个地方。',
    why: '这是最花时间和钱的一步。先把形象图跑满意再来，能省不少返工。',
    route: '/storyboard',
    routeLabel: '分镜表',
  },
  {
    title: '导出并开始做视频',
    how: '去「导出」点「打包下载」。拿到压缩包后：打开「拍摄进度表.md」逐镜执行；对着「提示词/平台名.md」把英文正文复制到即梦/可灵等平台生成视频；拿不准的地方翻「一致性总览.md」和「穿帮检查单.md」。',
    done: '—— 到这里本工具的部分就结束了。视频生成与剪辑在平台侧完成。',
    why: '导出的压缩包同时也是你唯一的备份：所有数据只在本机浏览器里，浏览器清理磁盘时可能整个清空。',
    route: '/export',
    routeLabel: '导出',
  },
];

const PLATFORM_OPTIONS: TargetPlatform[] = ['jimeng', 'kling', 'seedance'];
const ASPECT_OPTIONS = [
  { value: '9:16', label: '9:16 竖屏（抖音 / 快手 / 视频号）' },
  { value: '16:9', label: '16:9 横屏（B站 / YouTube）' },
  { value: '1:1', label: '1:1 方形' },
  { value: '4:3', label: '4:3' },
];

export function GuidePage() {
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const patchBrief = useAppStore((s) => s.patchBrief);
  const patchStory = useAppStore((s) => s.patchStory);
  const patchProject = useAppStore((s) => s.patchProject);
  const createEmptyProject = useAppStore((s) => s.createEmptyProject);
  const [step, setStep] = useState(0);

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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>故事</h1>
          <p>一次只问一个问题。写完这一段，就能往下拆场次、角色和镜头。</p>
        </div>
      </div>

      <div className="guide-layout">
        <aside className="guide-rail" aria-label="故事步骤">
          <div className="guide-rail-title">
            写故事 · {step + 1} / {STEPS.length}
          </div>
          {STEPS.map((label, index) => (
            <button
              key={label}
              type="button"
              className={`wizard-step${index === step ? ' active' : ''}${index < step ? ' done' : ''}`}
              onClick={() => setStep(index)}
            >
              <span className="wizard-dot" aria-hidden="true" />
              <span>{label}</span>
              <span className="wizard-state">
                {index === step ? '当前' : index < step ? '已完成' : ''}
              </span>
            </button>
          ))}
          <p className="guide-rail-note">
            不知道选哪个就按默认值走。所有内容随时可以回来改，不会因为点了下一步就定死。
          </p>
        </aside>

        <div className="guide-main">
          {step === 0 ? (
            <div className="card">
              <h3 className="card-title">这个故事是你自己的，还是让工具给你一个？</h3>
              <div className="choice-row">
                <button
                  type="button"
                  className={`choice${story.source === 'original' ? ' active' : ''}`}
                  onClick={() => patchStory({ source: 'original' })}
                >
                  <b>我自己的故事</b>
                  <span>直接粘贴或写下你已经想好的故事，不会被模型改写。</span>
                </button>
                <button
                  type="button"
                  className={`choice${story.source === 'generated' ? ' active' : ''}`}
                  onClick={() => patchStory({ source: 'generated' })}
                >
                  <b>给个主题，让工具生成</b>
                  <span>给一句话主题，模型起草，你再逐字改。</span>
                </button>
              </div>
              <WhyDetails>
            这两种来源后面要填的东西不一样。选「我自己的故事」，下一步你直接粘贴或写下来就行；
            选「给工具生成」，你只需要给一个主题，剩下交给模型去写。
            <br />
            <br />
            选「给工具生成」，下一步你只要给一句话主题，模型会把故事写出来，并顺手拆好场次。
            写完的东西你都能逐字改——模型负责起草，你负责决定。
          </WhyDetails>

          {story.source === 'generated' ? (
            <div style={{ marginTop: 14 }}>
              <Field label="你想讲什么主题？" hint="一句话就够，例如：一个外卖员在雨天捡到一只会说话的猫">
                <input
                  type="text"
                  value={story.theme ?? ''}
                  onChange={(e) => patchStory({ theme: e.target.value })}
                  placeholder="一句话主题"
                />
              </Field>
              <GenerateBar
                task="story"
                label="让模型帮我写这个故事"
                hint="会同时拆出场次。写完之后你仍然可以逐字修改。"
              />
            </div>
          ) : null}

          <div className="guide-ahead">
            <div className="guide-ahead-head">
              <h4>下一步会让你写这些</h4>
              <span>现在不用填</span>
            </div>
            <div className="guide-ahead-grid">
              <div>
                <b>故事正文</b>
                <span>一段话就够：谁、在哪、发生了什么、最后怎么了。</span>
              </div>
              <div>
                <b>主要人物</b>
                <span>谁和谁的关系最关键，谁在挡着主角。</span>
              </div>
              <div>
                <b>冲突与结局</b>
                <span>主角想要什么，最后停在哪一帧画面上。</span>
              </div>
            </div>
          </div>

          <div className="guide-sample">
            <div className="aside-label">一个写好的开头长这样</div>
            <p>一个被诬陷的武人被发配草料场，在风雪夜里听见门外三人密谋，推门而出。</p>
            <span>一句话里有主角、处境、转折，和最后一个动作。</span>
          </div>

          <div className="guide-skeleton">
            <div className="aside-label">把它拆成四格，就不会卡住</div>
            <div className="skeleton-grid">
              <div>
                <b>谁</b>
                <span>林冲，被发配的武人</span>
              </div>
              <div>
                <b>想要</b>
                <span>活下去，回到东京</span>
              </div>
              <div>
                <b>挡着</b>
                <span>陆谦带人放火烧草料场</span>
              </div>
              <div>
                <b>停在</b>
                <span>他推门而出，长枪指向三人</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="card">
          <h3 className="card-title">把故事写下来</h3>
          <Field
            label="故事正文"
            hint="可以只写一段话，也可以粘贴整篇小说。写清楚：谁、在哪、发生了什么、最后怎么了。"
          >
            <textarea
              rows={8}
              value={story.body}
              onChange={(e) => patchStory({ body: e.target.value })}
              placeholder="例：林冲被陷害发配沧州，看守草料场。这夜大雪，他沽酒回来见草厅被压塌，只得宿在山神庙。半夜听见门外有人密谋要烧死他……"
            />
          </Field>

          <div className="grid-2">
            <Field label="主要人物" hint="谁在这个故事里，他们是什么关系">
              <textarea
                rows={3}
                value={story.charactersNote}
                onChange={(e) => patchStory({ charactersNote: e.target.value })}
              />
            </Field>
            <Field label="发生在哪 / 什么时候" hint="地点和时代背景">
              <textarea
                rows={3}
                value={story.setting}
                onChange={(e) => patchStory({ setting: e.target.value })}
              />
            </Field>
            <Field label="冲突是什么" hint="主角想要什么，什么挡着他">
              <textarea
                rows={3}
                value={story.conflict}
                onChange={(e) => patchStory({ conflict: e.target.value })}
              />
            </Field>
            <Field label="结局" hint="最后停在哪一帧画面上">
              <textarea
                rows={3}
                value={story.ending}
                onChange={(e) => patchStory({ ending: e.target.value })}
              />
            </Field>
          </div>

          <WhyDetails>
            这四个格子不是形式主义。分镜引擎要靠它们决定「哪些内容必须拍出来」，
            穿帮检查也会拿它们来核对「你说要讲的事，分镜里是不是真的都有镜头承载」。
            如果某一格你还没想好，可以先空着，后面回来补。
          </WhyDetails>

          <h3 className="card-title" style={{ marginTop: 22 }}>
            场次拆分
          </h3>
          <p style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 0 }}>
            按地点或时间切场，防止漏拍一整场。
          </p>
          {story.scenes.length === 0 ? (
            <div className="empty">还没有场次。可以先不分，等写完分镜再回来补。</div>
          ) : (
            story.scenes.map((scene) => (
              <div className="row" key={scene.id} style={{ marginBottom: 8, alignItems: 'flex-start' }}>
                <input
                  type="text"
                  style={{ maxWidth: 220 }}
                  value={scene.label}
                  onChange={(e) => updateStoryScene(scene.id, { label: e.target.value })}
                  placeholder="场次名，例：教室 · 傍晚"
                />
                <input
                  type="text"
                  style={{ flex: 1, minWidth: 200 }}
                  value={scene.summary}
                  onChange={(e) => updateStoryScene(scene.id, { summary: e.target.value })}
                  placeholder="这一场发生了什么"
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => removeStoryScene(scene.id)}
                >
                  删除
                </button>
              </div>
            ))
          )}
          <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={addStoryScene}>
            + 加一场
          </button>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="card">
          <h3 className="card-title">风格与规格</h3>

          <Field
            label="片名"
            hint="只是给你自己看的项目名，可以随时改"
          >
            <input
              type="text"
              value={project.name}
              onChange={(e) => patchProject({ name: e.target.value })}
              placeholder="我的动漫短片"
            />
          </Field>

          <Field label="一句话简介" hint="写完你自己回看时，一眼知道这个项目是干什么的">
            <input
              type="text"
              value={project.logline}
              onChange={(e) => patchProject({ logline: e.target.value })}
            />
          </Field>

          <div className="grid-2">
            <Field
              label="目标时长（秒）"
              hint="新手建议 30–60 秒。按每镜 3 秒算，30 秒大约是 10 个镜头。"
            >
              <input
                type="number"
                min={5}
                max={600}
                value={project.brief.targetDuration}
                onChange={(e) => patchBrief({ targetDuration: Number(e.target.value) || 0 })}
              />
            </Field>

            <Field label="画面比例" hint="竖屏短视频选 9:16，横屏投稿选 16:9。必须在提示词里写明，否则模型可能把竖屏出成横屏。">
              <SelectMenu
                value={project.brief.aspectRatio}
                options={ASPECT_OPTIONS}
                ariaLabel="画面比例"
                onChange={(value) => patchBrief({ aspectRatio: value })}
              />
            </Field>
          </div>

          <Field
            label="打算用哪个平台生成？"
            hint="可以多选。选了之后，提示词会同时按这几个平台的格式各出一份。"
          >
            <div className="row">
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

          <Field
            label="风格倾向（随便写，中文就行）"
            hint="这一段是你自己的备忘，同时也告诉模型「这部片子该是什么调子」——它会据此写出贴合风格的角色与场景描述。"
          >
            <textarea
              rows={2}
              value={project.brief.styleTone}
              onChange={(e) => patchBrief({ styleTone: e.target.value })}
              placeholder="例如：水墨写意 + 国漫赛璐璐，冷色调，大雪，厚重衣物质感"
            />
          </Field>

          {/*
            【为什么要这个按钮】「风格倾向」是中文，而真正进提示词的是下面的英文关键词。
            新手写得出中文、写不出英文，于是这里写了一堆、实际生成时风格词还是空的——
            风格根本没生效。这个按钮把两者接上。
          */}
          <div style={{ marginTop: -4 }}>
            <GenerateBar
              task="style"
              label="用这段中文生成英文关键词"
              hint="会写进下面的「风格关键词」，之后出的图都带上"
            />
          </div>

          <div className="field-label" style={{ marginBottom: 6 }}>选一个风格（决定全片质感的就是它）</div>
          <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            点一下整套风格词都配好，全片共用同一套。再点一下取消。
          </p>
          <div className="row" style={{ marginBottom: 12 }}>
            {STYLE_PRESETS.map((preset) => {
              const active = matchStylePreset(project.brief.styleTags)?.id === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`btn${active ? ' btn-primary' : ''}`}
                  /*
                    【v0.41】选中之后必须能取消。
                    原来点已选中的预设只是把同一套词再写一遍，等于没法退回「不用预设」。
                    用户想改回空白、或想完全手写关键词时就没有出路了。
                  */
                  onClick={() =>
                    patchBrief({ styleTags: active ? [] : [...preset.tags] })
                  }
                  title={active ? '再点一下取消这个预设' : preset.description}
                  aria-pressed={active}
                >
                  {preset.label}
                  {active ? ' · 已选' : ''}
                </button>
              );
            })}
          </div>

          <div className="row" style={{ marginBottom: 8 }}>
            <span className="hint" style={{ marginTop: 0 }}>
              不确定下面这几个词什么意思？旁边的问号点开就能看：
            </span>
            <TermHint term="画幅比例" />
            <TermHint term="主色调" />
            <TermHint term="主光方向" />
          </div>

          <Field
            label="风格关键词（英文，真正进提示词的就是这几行）"
            hint="每行一条。上面的预设就是往这里填内容——你也可以自己改。模型对英文风格词的理解更稳，所以这里是英文。"
          >
            <textarea
              rows={6}
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

          {project.brief.styleTags.length > 0 ? (
            <div className="issue" style={{ borderLeftColor: 'var(--accent)', marginBottom: 12 }}>
              <div className="issue-title">这几行就是全片统一的风格</div>
              <div className="issue-line">
                它们会被<b>原样</b>写进每一张图的提示词——角色形象图、场景参考板、每一镜的关键帧。
                所以只要这几行不变，全片的质感就是一致的。
              </div>
              <div className="issue-line" style={{ marginTop: 6 }}>
                {project.brief.styleTags.map((tag) => (
                  <code key={tag} style={{ marginRight: 6, display: 'inline-block' }}>
                    {tag}
                  </code>
                ))}
              </div>
            </div>
          ) : (
            <div className="issue warning" style={{ marginBottom: 12 }}>
              <div className="issue-title">还没有选风格</div>
              <div className="issue-line">
                不选也能生成，但角色的形象图和关键帧会缺少统一的质感词，看起来可能不像同一部片子。
                上面点一下就好。
              </div>
            </div>
          )}

          <Field
            label="负向词（你不想要的东西）"
            hint="会单独放进平台的负向词框里，不要混进正文。"
          >
            <textarea
              rows={2}
              value={project.brief.negativePrompt}
              onChange={(e) => patchBrief({ negativePrompt: e.target.value })}
            />
          </Field>

          <WhyDetails>
            <RichText>
              {'风格关键词和负向词会被自动附加到**每一镜**的提示词上。这是保证全片风格统一最省力的办法——你不用每一镜都重复写一遍「动漫风、冷色调」。'}
            </RichText>
            <br />
            <br />
            时长和画幅同理：它们不是给你看的，是给模型看的。不写画幅，模型可能把竖屏短视频给你出成横屏。
          </WhyDetails>
        </div>
      ) : null}

      {step === 3 ? (
        <>
          {/*
            AI 生成路线放在**最前面**。
            原来这一页只有手动流程（一个一个建场景、建角色、逐条写锁），
            但实际创作时几乎都会先让模型把场景/角色/分镜拆出来再改。
            新手照着手动流程做到一半才发现旁边有「① 从故事里拆角色与场景」，
            然后就不确定该用哪个、已经做的会不会白费。
          */}
          <AiFlowGuide />

          <div className="card">
            <h3 className="card-title">也可以全程手动：一步步来</h3>
            <p style={{ color: 'var(--text-dim)', marginTop: 0 }}>
              <RichText>
                {'不想让 AI 生成，或者生成结果你不满意想自己重来，就按这个顺序走。每一步都写清了**点哪里、会发生什么、做完怎么判断可以往下走**。卡在哪一步就回到这一步看。'}
              </RichText>
            </p>

            <ol style={{ fontSize: 13, paddingLeft: 0, margin: 0, listStyle: 'none' }}>
              {STEPS_AFTER_GUIDE.map((item, index) => (
                <li
                  key={item.title}
                  style={{
                    borderLeft: '3px solid var(--border-strong)',
                    paddingLeft: 14,
                    marginBottom: 16,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    第 {index + 1} 步 · {item.title}
                    {item.optional ? <span className="tag" style={{ marginLeft: 8 }}>可选</span> : null}
                  </div>
                  <div style={{ color: 'var(--text-dim)', lineHeight: 1.7 }}>
                    <b>怎么做：</b>
                    <RichText>{item.how}</RichText>
                  </div>
                  <div style={{ color: 'var(--text-dim)', lineHeight: 1.7 }}>
                    <b>做完了怎么判断可以往下走：</b>
                    <RichText>{item.done}</RichText>
                  </div>
                  {item.why ? (
                    <div className="hint" style={{ marginTop: 4 }}>
                      {item.why}
                    </div>
                  ) : null}
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => navigate(item.route)}
                    >
                      去「{item.routeLabel}」
                    </button>
                  </div>
                </li>
              ))}
            </ol>

            <div className="row" style={{ marginTop: 6 }}>
              <button type="button" className="btn" onClick={() => navigate('/storyboard')}>
                从 AI 流程第 1 步开始
              </button>
              <Link className="btn" to="/help">
                看帮助与术语
              </Link>
            </div>
          </div>
        </>
      ) : null}

      <div className="wizard-actions">
        <button
          type="button"
          className="btn"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
        >
          上一步
        </button>
        <div className="row">
          <span className="wizard-actions-note">
            {step === STEPS.length - 1 ? '故事写完后，下一步是把故事拆成分镜' : '切换步骤不会提交表单，随时可以回来改'}
          </span>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              className="btn btn-blue"
              onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
            >
              下一步
            </button>
          ) : (
            <button type="button" className="btn btn-blue" onClick={() => navigate('/storyboard')}>
              去分镜表 →
            </button>
          )}
        </div>
      </div>
    </div>

        <aside className="guide-aside">
          <section className="aside-card">
            <div className="aside-label">写完这一段，你会得到</div>
            <ul className="aside-list">
              <li>
                <b>一句话故事</b>
                <span>导出方案和拍摄进度表的开头</span>
              </li>
              <li>
                <b>场次拆分</b>
                <span>按地点或时间切，防止漏拍一整场</span>
              </li>
              <li>
                <b>角色与场景线索</b>
                <span>下一步建卡时直接接着写</span>
              </li>
            </ul>
          </section>

          <section className="aside-card">
            <div className="aside-label">写不出来就先回答</div>
            <p className="aside-question">主角是谁？他想要什么？</p>
            <p className="aside-question">什么挡着他？</p>
            <p className="aside-question">最后停在哪一帧画面？</p>
          </section>

          <p className="aside-note">不用一次写对。所有内容随时可以回来改。</p>
        </aside>
      </div>
    </>
  );
}



