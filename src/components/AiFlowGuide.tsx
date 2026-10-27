import { useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '../store/app';
import { RichText } from './bits';
import { useImage } from '../store/image';
import type { AssetKind } from '../types/model';

/**
 * AI 生成流程指引（方案.md §7.6.19）
 *
 * ===========================================================================
 * 为什么需要这个组件
 * ===========================================================================
 * 「引导向导」的第 4 步原来只教怎么**手动**建剧本：一个一个加场景、一个一个
 * 加角色、逐条写连续性锁。那条路是对的，但它不是大多数人实际会走的路——
 * 实际创作时几乎都会让模型先把场景、角色、分镜拆出来，人再改。
 *
 * 结果是：新手照着「手动流程」一条条做，做到一半发现旁边有个
 * 「① 从故事里拆角色与场景」的按钮——然后不确定该用哪个、已经做的会不会白费。
 *
 * 所以这里把 AI 流程单独讲清楚，并且：
 *
 *  1. **显示真实进度**（从项目数据里数），而不是让用户自己回忆做到哪了
 *  2. **两条路都承认**：AI 生成是省事的起点，手动补是必要的收尾，不是二选一
 *  3. 同一个组件在向导页与各操作页复用，避免文案各写一份后逐渐不一致
 */

type StepKey = 'split' | 'chars' | 'scenes' | 'shots' | 'frames';

interface FlowStep {
  key: StepKey;
  title: string;
  /** 在哪个界面做 */
  where: string;
  route: string;
  /** 点哪个按钮。一句话，只说动作 */
  action: string;
  /** 做完会看到什么（紧凑版的展开区用） */
  expect: string;
  done: boolean;
  /** 完成度文案，例如「3/5 个角色」 */
  progress?: string;
  /** 没做完时给一句为什么现在别往下走（紧凑版的展开区用） */
  gate?: string;
}

function pct(done: number, total: number): string {
  return `${done}/${total}`;
}

export function AiFlowGuide({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // 注意： 所有 Hook 必须在任何提前 return 之前调用 —— 否则 Hook 调用顺序会随
  // `project` 是否存在而变化，React 会直接抛错。这类错误在只有示例项目时
  // 可能一直不触发，等到用户新建空项目才炸。
  const project = useAppStore((s) => s.project);
  const gallery = useImage((s) => s.gallery);

  if (!project) return null;

  const { characters, scenes, shots } = project;

  /** 数某类素材覆盖了多少个对象（不是数图片张数——一个对象可能出了好几张） */
  const coveredBy = (refIds: string[], kinds: AssetKind[]): number =>
    refIds.filter((id) => (gallery[id] ?? []).some((a) => kinds.includes(a.kind))).length;

  const charsWithSheet = coveredBy(
    characters.map((c) => c.id),
    ['character-sheet'],
  );
  const charsWithFace = coveredBy(
    characters.map((c) => c.id),
    ['character-sheet-face'],
  );
  const charsReady = characters.filter(
    (c) =>
      (gallery[c.id] ?? []).some((a) => a.kind === 'character-sheet') &&
      (gallery[c.id] ?? []).some((a) => a.kind === 'character-sheet-face'),
  ).length;
  const scenesReady = coveredBy(
    scenes.map((s) => s.id),
    ['scene-plate'],
  );
  const firstReady = coveredBy(
    shots.map((s) => s.id),
    ['first-frame'],
  );
  const peakReady = coveredBy(
    shots.map((s) => s.id),
    ['action-peak'],
  );
  const endReady = coveredBy(
    shots.map((s) => s.id),
    ['end-frame'],
  );

  const hasSplit = characters.length > 0 && scenes.length > 0;
  const hasShots = shots.length > 0;

  const steps: FlowStep[] = [
    {
      key: 'split',
      title: '拆出角色与场景',
      where: '分镜表',
      route: '/storyboard',
      action: '点「① 从故事里拆角色与场景」',
      expect:
        '会按故事里的场次生成场景卡与角色卡，并自动填好固定元素、光线、身份描述。之后你可以逐条改。',
      done: hasSplit,
      ...(hasSplit ? { progress: `${characters.length} 角色 · ${scenes.length} 场景` } : {}),
      // 只有真的已经有东西时才提「会被覆盖」——空项目上说这句是误导
      ...(characters.length + scenes.length > 0
        ? {
            gate: '这一步会**覆盖**现有的角色与场景。已经手建过也没关系。它会重新生成，你改过的内容会丢，自己权衡。',
          }
        : {
            gate: '这是起点。故事已经写好了，让模型先按场次拆一遍，比对着空白页一条条想要快得多。',
          }),
    },
    {
      key: 'chars',
      title: '出角色形象图',
      where: '角色设定',
      route: '/characters',
      action: '点「全部角色形象图」',
      expect: '每个角色拿到两张图：全身多视图，再拿它当参考出头部特写。',
      done: characters.length > 0 && charsReady === characters.length,
      progress: `角色 ${pct(charsReady, characters.length)}（全身 ${pct(charsWithSheet, characters.length)}、特写 ${pct(charsWithFace, characters.length)}）`,
      gate: '形象图是后面所有关键帧的**参考图锚点**。这一步不满意就重出。等关键帧跑完再返工，前面花的钱就白花了。',
    },
    {
      key: 'scenes',
      title: '出场景参考板',
      where: '场景设定',
      route: '/scenes',
      action: '点「全部场景参考板」',
      expect: '每个场景拿到一张空镜参考板，写着这地方的空间结构与主光方向。',
      done: scenes.length > 0 && scenesReady === scenes.length,
      progress: `场景 ${pct(scenesReady, scenes.length)}`,
      gate: '参考板决定「这是同一个地方」。同一个场景在不同镜头里长得不一样，观众第一眼就会出戏。',
    },
    {
      key: 'shots',
      title: '生成分镜表',
      where: '分镜表',
      route: '/storyboard',
      action: '点「② 生成分镜表」',
      expect:
        '模型把故事拆成镜头，每镜带起点、唯一动作、终点，并自动挂好场景、角色和连续性锁。',
      done: hasShots,
      ...(hasShots ? { progress: `已有 ${shots.length} 个镜头` } : {}),
      gate: '分镜是后面出图的依据。先看一遍景别和镜号顺不顺，不满意就重生成，比出完图再改省事。',
    },
    {
      key: 'frames',
      title: '出三帧',
      where: '分镜表',
      route: '/storyboard',
      action: '点「全部三帧（按镜头顺序）」',
      expect: '每个镜头三张图：首帧（构图）、动作关键帧（动态顶点）、尾帧（这一镜结束时的状态）。',
      done: shots.length > 0 && firstReady === shots.length && peakReady === shots.length && endReady === shots.length,
      progress: `首帧 ${pct(firstReady, shots.length)} · 动作关键帧 ${pct(peakReady, shots.length)} · 尾帧 ${pct(endReady, shots.length)}`,
      gate: '这是最花时间和钱的一步。**先把形象图跑满意再来**。首帧会拿角色形象图当参考，形象图不行，三帧全都救不回来。',
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;

  /** 在某个页面上时，不再给它一个「去这一页」的按钮 */
  const onThisPage = (route: string): boolean => pathname === route;

  // -------------------------------------------------------------------------
  // 紧凑版：放在各操作页顶部，只显示当前这一步该做什么
  // -------------------------------------------------------------------------

  if (variant === 'compact') {
    // 找到第一个没做完的步骤；全做完了就不显示
    const current = steps.find((s) => !s.done);
    if (!current) return null;
    const stepNo = steps.indexOf(current) + 1;

    /**
     * 【v0.38 从一张卡改成一行】
     *
     * 原来是「标题 + 怎么做 + 进度 + 一段为什么 + 看完整流程」，五行。
     * 而它出现在几乎每个操作页顶部——**说明比页面本身还长**，
     * 用户要先读完一段解释才能看到自己要操作的东西。
     *
     * 现在只留一行：**下一步去哪、点哪个按钮**。
     * 为什么这么做（gate）、当前进度、完整四步，全部收进右边那个展开。
     *
     * 保留的信息一条没少，只是不再挡在路上。
     */
    return (
      <div className="next-step">
        <span className="next-step-tag">下一步 {stepNo}/{steps.length}</span>
        <span className="next-step-text">
          {onThisPage(current.route) ? (
            <b>{current.action}</b>
          ) : (
            <>
              去「{current.where}」，<b>{current.action}</b>
            </>
          )}
        </span>
        {onThisPage(current.route) ? null : (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => navigate(current.route)}
          >
            去做 →
          </button>
        )}
        <details className="next-step-more">
          <summary>为什么</summary>
          <div className="next-step-body">
            {current.progress ? <div>当前进度：{current.progress}</div> : null}
            <div>
              <RichText>{current.gate ?? ''}</RichText>
            </div>
            <div>
              做完会看到：<RichText>{current.expect}</RichText>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: '0 6px' }}
              onClick={() => navigate('/guide')}
            >
              看完整四步 →
            </button>
          </div>
        </details>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // 完整版：放在向导「4. 完成」顶部
  // -------------------------------------------------------------------------

  return (
    <div
      className="card"
      style={{ borderColor: 'var(--accent)', borderWidth: 1, borderStyle: 'solid' }}
    >
      <h3 className="card-title">
        大多数人走的路：让 AI 先生成，你再改
        <span className="tag tag-ok" style={{ marginLeft: 8 }}>
          已完成 {doneCount}/{steps.length}
        </span>
      </h3>

      {/*
        【v0.53 只留「去哪里、做什么」】
        用户的原话：移除底下说明性文字，只写每一步去哪里、做什么，并附带跳转按钮。
        所以引子段、「AI 生成和手动建不是二选一」提示框、「会看到什么」、
        每一步的 gate、以及底部那句「做完这四步材料就齐了」全部删掉。

        这些内容没有真的消失：gate 与 expect 仍然留在数据里，
        紧凑版顶部的「为什么」展开区还在用它们。完整版是**执行清单**，
        不是讲解——要看为什么，那里有。
      */}
      <ol style={{ fontSize: 13, paddingLeft: 0, margin: 0, listStyle: 'none' }}>
        {steps.map((item, index) => (
          <li
            key={item.key}
            style={{
              borderLeft: `3px solid ${item.done ? 'var(--ok)' : 'var(--accent)'}`,
              paddingLeft: 14,
              marginBottom: 12,
              opacity: item.done ? 0.72 : 1,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              {item.done ? '已完成 · ' : ''}
              第 {index + 1} 步 · {item.title}
              {item.progress ? (
                <span className="tag" style={{ marginLeft: 8 }}>
                  {item.progress}
                </span>
              ) : null}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: 'var(--text-dim)',
                lineHeight: 1.7,
              }}
            >
              <span style={{ flex: 1 }}>
                去「{item.where}」，{item.action}
              </span>
              {onThisPage(item.route) ? null : (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => navigate(item.route)}
                >
                  去「{item.where}」
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}


