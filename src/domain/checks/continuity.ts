import type { CheckIssue, Project, Shot } from '../../types/model';
import { makeIssue, shotLabel } from './shared';

/**
 * 镜头衔接检查（方案.md §7.6.8，【v0.19 新增】）
 *
 * ===========================================================================
 * 为什么需要单独一类检查
 * ===========================================================================
 * 单个镜头再完美，接起来别扭整片就废了。而衔接问题**在写分镜时是能提前发现的**——
 * 等到剪辑台上才发现，返工成本已经很高（图要重出、视频要重生成）。
 *
 * 检查的是三类事实：
 *  1. **有没有写明衔接**：没写不等于接不上，但写了才可能接得上
 *  2. **尾帧与下一镜首帧的矛盾**：这一镜写「他站在原地」，下一镜写「他从门口走进来」——
 *     中间缺了一段，观众会觉得跳了
 *  3. **地点与时间的跳跃没有交代**：上一镜在室内、下一镜在室外，
 *     而转场写的是「硬切」且衔接说明是空的，观众会以为漏了一段
 *
 * 刻意**不做**的三件事：
 *  - 不评判转场选得好不好（那是导演的事）
 *  - 不检查「同一场景内的小跳」（那是正常剪辑节奏）
 *  - 不自动改（衔接属于创作决定）
 */

/** 与下一镜的矛盾类型 */
export type ContinuityKind = 'missing-note' | 'location-jump' | 'time-jump' | 'state-conflict';

export const CONTINUITY_KIND_LABEL: Record<ContinuityKind, string> = {
  'missing-note': '没写衔接',
  'location-jump': '地点跳了',
  'time-jump': '时间跳了',
  'state-conflict': '状态对不上',
};

/** 表示「时间在流逝」的词 */
const TIME_SKIP_WORDS = [
  '第二天', '次日', '隔天', '几天后', '一周后', '多年后', '与此同时', '同一时间',
  '稍后', '片刻后', '半小时后', '一小时后', '天亮', '天黑', '入夜', '清晨',
  'next day', 'later', 'meanwhile', 'the following',
];

/**
 * 表示「明确交代了位置切换」的词。
 *
 * 注意必须同时覆盖中英文写法——这个工具的输出以中文为主，
 * 只写英文的 `cut to` 会在中文项目里完全失效（这是一个真实发生过的疏漏）。
 */
const LOCATION_SKIP_WORDS = [
  '切到', '切换到', '跳到', '画面一转', '镜头一转', '转到',
  '另一边', '另一处', '与此同时在', '转场',
  'elsewhere', 'cut to', 'meanwhile at',
];

export function checkContinuity(project: Project): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const shots = project.shots;
  if (shots.length < 2) return issues;

  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index]!;
    const next = shots[index + 1];
    const label = shotLabel(shot.number);

    // 最后一镜没有「下一镜」，只提醒写个收尾说明
    if (!next) {
      if (!shot.continuityNote?.trim()) {
        issues.push(
          makeIssue({
            ruleId: 'continuity-missing-note',
            severity: 'info',
            title: `${label}是全片最后一镜，但没有写收尾说明`,
            why:
              '最后一镜是观众离开这个故事的地方。写一句「画面怎么收住」对剪辑很有帮助——' +
              '是要停在一个定格的脸上，还是拉远到空镜，观感完全不同。',
            suggestion:
              '在「与下一镜的衔接」里写一句收尾说明，例如「画面停在摊开的笔记本上，缓缓淡出」。',
            location: { kind: 'shot', id: shot.id, field: 'continuityNote' },
          }),
        );
      }
      continue;
    }

    const note = shot.continuityNote?.trim() ?? '';
    const nextNote = next.continuityNote?.trim() ?? '';
    const scene = project.scenes.find((s) => s.id === shot.sceneId);
    const nextScene = project.scenes.find((s) => s.id === next.sceneId);
    const sameScene = Boolean(shot.sceneId) && shot.sceneId === next.sceneId;

    /**
     * 「这次跳跃有没有被交代」。
     *
     * 判据必须落在**下一镜的说明**上，而不是把整段文字混在一起找关键词。
     * 教训：原来把 note 也混进来，于是上一镜写「他推门走出去」就抑制了整条跳跃警告——
     * 可那句话说的是上一个动作，并没有交代**怎么切到这个新地点**。
     * 结果是最该提醒的情况反而被静默掉了。
     */
    const mentions = (words: string[]): boolean => words.some((w) => nextNote.includes(w));
    const explainsJump =
      TIME_SKIP_WORDS.some((w) => nextNote.includes(w) || next.startState.includes(w)) ||
      LOCATION_SKIP_WORDS.some((w) => nextNote.includes(w) || next.startState.includes(w));
    void mentions;

    // ---------------------------------------------------------------------
    // 1. 地点跳了但没交代
    // ---------------------------------------------------------------------
    if (!sameScene && scene && nextScene && !explainsJump) {
      issues.push(
        makeIssue({
          ruleId: 'continuity-location-jump',
          severity: 'warning',
          title: `${label}在「${scene.name}」，${shotLabel(next.number)}跳到「${nextScene.name}」，但没写怎么过去的`,
          why:
            '观众会以为漏看了一段。地点切换本身没问题，问题是没有交代——' +
            '是人物走过去了（那中间需要一个过程镜头），还是直接切过去（那是一次有意的跳切）？' +
            `转场写的是「${shot.transition || '未填'}」，这个选择需要一个理由。`,
          suggestion:
            '在「与下一镜的衔接」里写清楚。两种写法都可以：' +
            '① 连续动作 → 「他推门走出去，镜头跟到门外」；' +
            '② 有意跳切 → 「直接切到目的地，观众不需要看路上的过程」。',
          location: { kind: 'shot', id: shot.id, field: 'continuityNote' },
        }),
      );
    }

    // ---------------------------------------------------------------------
    // 2. 状态对不上（同一个地方，但位置/朝向接不上）
    // ---------------------------------------------------------------------
    // 说明里如果解释了「状态为什么会变」（转身、站起、坐下、走过去…），就不再报
    const explainsChange =
      /转过身|转过身来|转身|转过来|回头|站起|起身|站起身|坐下|坐回|坐下身|走过去|走到|走向|上前|退后|伸手|拿起|放下|换上|脱下|举起|收起/.test(
        note,
      );
    if (sameScene && !explainsChange) {
      const endText = shot.endState.trim();
      const startText = next.startState.trim();
      if (endText.length > 0 && startText.length > 0) {
        const conflict = findStateConflict(endText, startText);
        if (conflict) {
          issues.push(
            makeIssue({
              ruleId: 'continuity-state-conflict',
              severity: 'warning',
              title: `${label}的终点与${shotLabel(next.number)}的起点可能接不上`,
              why:
                `这一镜结束在「${endText.slice(0, 40)}」，下一镜却从「${startText.slice(0, 40)}」开始。` +
                `检测到矛盾点：${conflict}。观众会觉得中间跳了一段。`,
              suggestion:
                '两个选择：把下一镜的起点改成接得住上一镜终点的样子；' +
                '或者在这一镜的衔接说明里写清中间发生了什么。',
              location: { kind: 'shot', id: shot.id, field: 'endState' },
            }),
          );
        }
      }
    }

    // ---------------------------------------------------------------------
    // 2.5 转场类型没标注
    // ---------------------------------------------------------------------
    // 这个字段决定「要不要拿上一镜尾帧当参考图」。没标注时工具只能猜，
    // 而猜成「跳切」就会白白丢掉跨镜连续性——那正是镜头之间看起来不连贯的直接原因。
    // 所以不能只是安静地退化成推断，必须让用户看见。
    if (!shot.transitionType) {
      const prev = shots[index - 1];
      const guess = !prev || !(prev.continuityNote ?? '').trim() ? 'cut' : '按说明推断';
      issues.push(
        makeIssue({
          ruleId: 'continuity-untyped-transition',
          severity: 'warning',
          title: `${label}没有标注与${prev ? shotLabel(prev.number) : '上一镜'}的转场类型（当前按「${guess === 'cut' ? '跳切' : '说明'}」处理）`,
          why:
            '转场类型决定出图时要不要拿**上一镜的尾帧**当参考图。' +
            '标成「承接」时，这一镜首帧会继承上一镜的空间、光线与画幅，两镜才接得住；' +
            '标成「跳切」时不会用。' +
            '没标注就只能猜，而猜成「跳切」会让本该连上的两镜各画各的——' +
            '**镜头之间的一致性就是这样丢掉的。**',
          suggestion:
            '在分镜表里给这一镜选一下「承接上一镜」或「跳切」。' +
            '同一处地方、时间向前、动作接着演 → 承接；换了地方、跳了时间、反打换机位 → 跳切。' +
            '重新生成分镜时模型也会自动填这一栏。',
          location: { kind: 'shot', id: shot.id, field: 'transitionType' },
        }),
      );
    }

    // ---------------------------------------------------------------------
    // 3. 单镜位移过大
    // ---------------------------------------------------------------------
    // 【为什么不是「首尾状态差距大」】
    // 我最初写的是「比较这一镜终点与下一镜起点的字面重合度」。
    // 在示例项目上实测报了 6 条，**全部是误报**：
    //     END  =「人影停在空地中央偏右，背对镜头，长枪斜挎在背上」   ← 全景
    //     START=「林冲侧身站在雪地里，旧棉袍肩头积着雪…」           ← 特写
    // 那是同一个瞬间的两种取景，是正常的镜头切换。
    // 字面重合度度量不了「状态差距」，它度量的是「用词差距」，
    // 而换景别、换机位本来就该换用词。
    //
    // 教训：量不准的东西就不要报。在一个正常项目上报 6 条假警报，
    // 比不报更糟——用户会学会忽略这条提示，连带忽略整份检查单。
    //
    // 现在改成只判一件**能确证**的事：这一镜的「唯一动作」本身
    // 是不是描述了一次大位移。这才是「中间不好补」的真正来源。
    const bigMove = detectLargeMotion(shot.action);
    if (bigMove) {
      issues.push(
        makeIssue({
          ruleId: 'continuity-large-motion',
          severity: 'info',
          // 标题里放**用户自己写的原话**而不是分类标签——
          // 他需要一眼看出是哪一镜、哪句话有问题
          title: `${label}的动作「${truncate(shot.action, 18)}」位移偏大（${bigMove}）`,
          why:
            '几秒钟的镜头里主体跨越大段距离，中间那段运动最难补得自然——' +
            '模型要么把它演得像滑行，要么在半路丢掉人物结构。' +
            '这不是硬错误，但成片里这一段最容易看出问题。',
          suggestion:
            '更稳的做法是把这一镜拆成两镜（例如「起势」与「到位」各一镜），' +
            '或者在动作前后各留一点静止。拆镜比硬接好——这是行业里一致的做法。',
          location: { kind: 'shot', id: shot.id, field: 'action' },
        }),
      );
    }

    // ---------------------------------------------------------------------
    // 4. 相邻镜的光线方向冲突
    // ---------------------------------------------------------------------
    // 依据：光源方向不一致是「坏帧对」最常见的特征，成片里表现为
    // 片段中间光源突然跳变，看起来像渲染错误。
    if (!sameScene && scene?.lightDirection && nextScene?.lightDirection) {
      const a = lightKey(scene.lightDirection);
      const b = lightKey(nextScene.lightDirection);
      if (a && b && a.conflictWith(b)) {
        issues.push(
          makeIssue({
            ruleId: 'continuity-light-mismatch',
            severity: 'warning',
            title: `${label}在「${scene.name}」，${shotLabel(next.number)}在「${nextScene.name}」，两处的主光方向相反`,
            why:
              `上一处是「${scene.lightDirection}」，下一处是「${nextScene.lightDirection}」。` +
              '光源方向不一致是观众最容易察觉的破绽之一——' +
              '看起来不像换了个地方，更像同一个镜头里光突然跳了一下。',
            suggestion:
              '三种改法：① 让两处的主光方向一致；② 在中间加一个过渡镜头（例如从窗外看进去）' +
              '把方向变化交代过去；③ 如果是有意为之（比如从白天到夜晚），把这件事写进衔接说明。',
            location: { kind: 'shot', id: shot.id, field: 'sceneId' },
          }),
        );
      }
    }

    // ---------------------------------------------------------------------
    // 5. 没写衔接说明（提示级，不阻断）
    // ---------------------------------------------------------------------
    if (!note) {
      issues.push(
        makeIssue({
          ruleId: 'continuity-missing-note',
          severity: 'info',
          title: `${label}没有写与下一镜的衔接`,
          why:
            '衔接说明是给三件事用的：尾帧图该画成什么样、视频提示词里的转场怎么写、剪辑时的落点在哪。' +
            '不写也能做，但做尾帧和剪辑时会反复回来想这件事。',
          suggestion:
            '一句话就够，例如「他保持这个姿势不动，下一镜从同一个机位推进」' +
            '或「直接切到第二天早上」。也可以用「自动修复」里的建议。',
          location: { kind: 'shot', id: shot.id, field: 'continuityNote' },
        }),
      );
    }
  }

  // ---------------------------------------------------------------------
  // 同一场景内连续承接链过长
  // ---------------------------------------------------------------------
  // 依据：链式生成会累积漂移（有工程实测：每跳残余约 1.02 倍、
  // 纹理每接缝约 1.3 倍棘轮）。缓解办法是在场景切点「重新起锚」——
  // 而场景切点本来就是天然的 cut，重置不花额外代价。
  //
  // 阈值取 6：这是量级参考，不是精确阈值（实测数字来自另一条技术栈）。
  // 所以是提示级，并且明确说「重新起锚」而不是「你错了」。
  const CHAIN_WARN_LENGTH = 6;
  let chainLength = 0;
  for (const [index, shot] of shots.entries()) {
    const isContinuation = shot.transitionType === 'continuation';
    if (index === 0 || !isContinuation) {
      chainLength = 1;
      continue;
    }
    chainLength += 1;
    if (chainLength === CHAIN_WARN_LENGTH) {
      issues.push(
        makeIssue({
          ruleId: 'continuity-long-chain',
          severity: 'info',
          title: `从第 ${shot.number - chainLength + 1} 镜到第 ${shot.number} 镜已经连续承接了 ${chainLength} 镜`,
          why:
            '一路承接下去，画面会一点点偏离最初的样子——每一镜都比上一镜略微偏一点，' +
            '累积到后面会明显看得出（色调、质感、人物都在慢慢漂）。' +
            '这不是错误，是这类生成的固有特性。',
          suggestion:
            '在下一个自然的场景切换点（也就是一次 cut）重新起锚：让那一镜用场景板与角色形象图' +
            '当参考图，而不是继续接上一镜。场景切点本来就要换地方，重置不花额外代价。',
          location: { kind: 'shot', id: shot.id, field: 'transitionType' },
        }),
      );
    }
  }

  return issues;
}

/**
 * 判断这一镜的动作是不是描述了一次「大位移」。
 *
 * 只认**明确的位移动词**，不做语义猜测——宁可不报也不要误报。
 * 中文里这类动作几乎都带位移动词或趋向补语，所以用列举法足够可靠。
 */
function detectLargeMotion(action: string): string | undefined {
  const text = action.trim();
  if (text.length === 0) return undefined;

  // 「入画」不算大位移：从画框边缘进来靠构图就交代了，中间不需要补运动。
  // 实测示例项目里「一个人影从山道尽头走进画面」就属于这种，
  // 它被误报了——这类边界情形一律放过。
  if (/(走进画面|走入画面|走进镜头|入画|出现在画面|从画外)/.test(text)) return undefined;

  // 只认**明确**的大位移。宁可漏报也不要误报：
  // 示例项目里「跨出门槛」只跨一步、「走进画面」是入画，
  // 都被我原来的宽泛正则误报了。这条规则的价值远不抵误报的代价。
  const patterns: { re: RegExp; label: string }[] = [
    { re: /(走过|跑去|跑过|跑向|冲向|冲进|冲出|奔向|闯入|奔逃|追赶|追赶)/, label: '长距离移动' },
    { re: /(穿过|越过|翻过|翻越|跨过)/, label: '跨越障碍' },
    { re: /(扑向|纵身|一跃)/, label: '大幅动作' },
    { re: /(runs? (over|across|through|toward)|charges?|leaps?|dashes?|sprints?)/i, label: 'large movement' },
  ];
  for (const { re, label } of patterns) {
    if (re.test(text)) return label;
  }
  return undefined;
}

/** 把主光方向归成「左 / 右 / 顶 / 底 / 正面 / 逆光」几个方向，便于比对 */
function lightKey(direction: string): { dirs: Set<string>; conflictWith: (other: ReturnType<typeof lightKey>) => boolean } | undefined {
  const text = direction;
  if (text.trim().length === 0) return undefined;
  const dirs = new Set<string>();
  if (/左|left/.test(text)) dirs.add('left');
  if (/右|right/.test(text)) dirs.add('right');
  if (/顶|上方|top/.test(text)) dirs.add('top');
  if (/底|下方|bottom|脚光/.test(text)) dirs.add('bottom');
  if (/正面|前方|front/.test(text)) dirs.add('front');
  if (/逆光|背光|back/.test(text)) dirs.add('back');

  return {
    dirs,
    conflictWith(other) {
      if (!other) return false;
      // 左右相反、正逆相反、顶底相反 —— 这三对是明确的冲突
      const pairs: [string, string][] = [
        ['left', 'right'],
        ['front', 'back'],
        ['top', 'bottom'],
      ];
      return pairs.some(([x, y]) => (dirs.has(x) && other.dirs.has(y)) || (dirs.has(y) && other.dirs.has(x)));
    },
  };
}

/**
 * 找「终点与下一镜起点」的明显矛盾。
 *
 * 只认几种**明确**的矛盾，不做语义理解——误报会让整份检查单失去可信度：
 *  - 站位相反：一个说「站在门口」，另一个说「从桌边起身」
 *  - 朝向相反：一个说「背对镜头」，另一个说「正对镜头」
 *  - 持物矛盾：一个说「手里拿着伞」，另一个说「两手空空」
 */
function findStateConflict(endState: string, startState: string): string | undefined {
  const end = endState;
  const start = startState;

  // 朝向相反
  const endBack = /背对|背朝|背向/.test(end);
  const startFront = /正对|面对镜头|转向镜头/.test(start);
  if (endBack && startFront) return '上一镜结束在背对，下一镜却从正对开始';

  const endFront = /正对|面对/.test(end);
  const startBack = /背对|背朝|背向/.test(start);
  if (endFront && startBack) return '上一镜结束在正对，下一镜却从背对开始';

  // 持物矛盾
  const endHolding = /手里(拿|握|提|捧)|双手(拿|握|捧)/.exec(end);
  const startEmpty = /两手空空|空着双手|手中空无一物/.test(start);
  if (endHolding && startEmpty) return `上一镜结束时${endHolding[0]}，下一镜却写两手空空`;

  // 坐立矛盾
  const endSitting = /坐(在|着)|端坐/.test(end);
  const startStanding = /站(在|着|起)|站立/.test(start);
  if (endSitting && startStanding) return '上一镜结束在坐着，下一镜却从站着开始';

  const endStanding = /站(在|着)/.test(end);
  const startSitting = /坐(在|着|下)/.test(start);
  if (endStanding && startSitting) return '上一镜结束在站着，下一镜却从坐着开始';

  return undefined;
}

/** 供界面用：这个镜头有没有「下一镜」 */
export function hasNextShot(project: Project, shotId: string): boolean {
  const index = project.shots.findIndex((s) => s.id === shotId);
  return index >= 0 && index < project.shots.length - 1;
}

/** 供界面用：这一镜后面的那一镜 */
export function nextShot(project: Project, shotId: string): Shot | undefined {
  const index = project.shots.findIndex((s) => s.id === shotId);
  return index >= 0 ? project.shots[index + 1] : undefined;
}

/** 供导出用：把衔接关系写成一份可读的清单 */
export function continuitySheetMarkdown(project: Project): string {
  const out: string[] = [];
  out.push(`# ${project.name} · 镜头衔接表`);
  out.push('');
  out.push('> 这份表把「每一镜怎么接到下一镜」单独列出来。');
  out.push('> 做尾帧图、写视频提示词、剪辑时对着它走，比来回翻分镜表快。');
  out.push('');
  out.push('| 镜号 | 场景 | 尾帧（这一镜结束在哪） | → | 下一镜首帧（从哪开始） | 转场 | 衔接说明 |');
  out.push('|---|---|---|---|---|---|---|');
  for (const [index, shot] of project.shots.entries()) {
    const scene = project.scenes.find((s) => s.id === shot.sceneId);
    const next = project.shots[index + 1];
    const nextScene = next ? project.scenes.find((s) => s.id === next.sceneId) : undefined;
    out.push(
      `| ${shot.number} | ${scene?.name ?? '—'} | ${truncate(shot.endState)} | → | ${
        next ? truncate(next.startState) : '（全片结束）'
      } | ${shot.transition || '—'} | ${shot.continuityNote || '（未写）'}${next && next.sceneId !== shot.sceneId && nextScene ? ` 注意： 换到「${nextScene.name}」` : ''} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

function truncate(text: string, max = 42): string {
  const clean = text.trim().replace(/\|/g, '／');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean || '—';
}

