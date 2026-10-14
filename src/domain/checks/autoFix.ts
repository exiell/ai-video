import type { CheckIssue, Project, Shot } from '../../types/model';

/**
 * 穿帮问题的自动修复提议（方案.md §7.6.5）
 *
 * ===========================================================================
 * 两条铁律
 * ===========================================================================
 * 1. **只提议能机械确定的修改。**
 *    能用现有数据推出来的（补锁、补字段、统一时长）就提议；
 *    需要审美判断的（把这镜的光线改成傍晚、把两个动作拆成两镜）**一律不碰**——
 *    那种"自动修改"会把用户的创作意图改坏，而且他还不知道为什么。
 *
 * 2. **只提议，不直接改。** 每个提议都带修改前后的对照，用户逐条勾选确认后才落盘。
 *    出图要花钱、分镜是他的作品，静默修改比不修改更糟。
 */

export type FixKind =
  | 'set-duration'
  | 'assign-scene'
  | 'register-scene'
  | 'add-lock'
  | 'remove-offscreen'
  | 'fill-start-state'
  | 'fill-end-state'
  | 'fill-action'
  | 'add-shot-for-scene'
  | 'set-brief';

export interface FixProposal {
  /** 稳定 id，供界面勾选 */
  id: string;
  kind: FixKind;
  /** 这条提议对应哪个问题 */
  issueId: string;
  /** 一句话说明要改什么 */
  title: string;
  /** 为什么这么改 —— 不能只给结论 */
  reason: string;
  /** 改哪个对象的哪个字段 */
  target: { shotId?: string; sceneId?: string; characterId?: string; projectField?: string };
  /** 修改前（给用户看，可为空表示原来没填） */
  before: string;
  /** 修改后 */
  after: string;
  /** 可能的副作用，需要用户知道的 */
  sideEffect?: string;
}

export interface FixPlan {
  proposals: FixProposal[];
  /** 有问题的镜头数 / 总镜头数，用于说明「影响范围」 */
  affectedShots: number;
  /** 有多少条问题无法自动修，需要人工处理 */
  manualOnly: number;
  /** 无法自动修的规则 id 列表，用于在界面上解释为什么 */
  manualRuleIds: string[];
}

/**
 * 哪些规则**绝对不能**自动修。
 *
 * 这些都需要判断「用户到底想要什么」，机器猜错会把创作意图改坏：
 *  - scene-light-conflict：改成傍晚还是把场景卡改成白天？只有用户知道
 *  - scene-color-drift：色调漂移可能是有意的情绪转折
 *  - multi-action：拆成几个镜头、怎么拆，是导演决定
 *  - duration-total：删哪一镜、缩短哪一镜，直接影响叙事
 */
export const MANUAL_ONLY_RULES = new Set<string>([
  'scene-light-conflict',
  'scene-color-drift',
  'multi-action',
  'duration-total',
]);

export interface BuildFixPlanOptions {
  /** 用户设定的单镜时长上限（按所选平台推导），用于 set-duration */
  maxShotDuration?: number;
}

export function buildFixPlan(project: Project, report: { issues: CheckIssue[] }, options: BuildFixPlanOptions = {}): FixPlan {
  const proposals: FixProposal[] = [];
  const manualRuleIds = new Set<string>();
  const affected = new Set<string>();

  const shotById = new Map(project.shots.map((s) => [s.id, s]));

  for (const issue of report.issues) {
    if (MANUAL_ONLY_RULES.has(issue.ruleId)) {
      manualRuleIds.add(issue.ruleId);
      if (issue.location.kind === 'shot') affected.add(issue.location.id);
      continue;
    }

    switch (issue.ruleId) {
      // ---------------------------------------------------------------
      // 镜头没归属场景：按文本里提到的场景名找，找不到就用出现最多的那个
      // ---------------------------------------------------------------
      case 'scene-not-registered': {
        if (issue.location.kind !== 'shot') break;
        const shot = shotById.get(issue.location.id);
        if (!shot) break;
        const guess = guessSceneForShot(project, shot);
        if (!guess) break;
        proposals.push({
          id: `fix:${issue.id}`,
          kind: 'assign-scene',
          issueId: issue.id,
          title: `把第 ${shot.number} 镜挂到场景「${guess.scene.name}」`,
          reason: guess.reason,
          target: { shotId: shot.id, sceneId: guess.scene.id },
          before: shot.sceneId ? '指向一个已不存在的场景' : '未指定场景',
          after: `场景「${guess.scene.name}」`,
          ...(guess.confidence === 'low'
            ? { sideEffect: '这是按画面描述里提到的场景名猜的，请确认一下对不对。' }
            : {}),
        });
        affected.add(shot.id);
        break;
      }

      // ---------------------------------------------------------------
      // 镜头时长非法：给一个保守的默认值
      // ---------------------------------------------------------------
      case 'duration-mismatch': {
        if (issue.location.kind !== 'shot') break;
        const shot = shotById.get(issue.location.id);
        if (!shot) break;
        const max = options.maxShotDuration ?? 5;

        // 只修「非正数」这种明确非法的值；超过平台上限的属于取舍，交给用户
        if (Number.isFinite(shot.duration) && shot.duration > 0) break;
        proposals.push({
          id: `fix:${issue.id}`,
          kind: 'set-duration',
          issueId: issue.id,
          title: `把第 ${shot.number} 镜的时长改成 3 秒`,
          reason: `当前值（${String(shot.duration)}）不是有效时长。3 秒是短片里最常用的一档，够放一个动作。`,
          target: { shotId: shot.id },
          before: String(shot.duration),
          after: '3 秒',
          sideEffect: `时长上限按你选的平台是 ${max} 秒，3 秒在范围内。改完总时长会变，需要重新看一遍总时长提示。`,
        });
        affected.add(shot.id);
        break;
      }

      // 漏勾连续性锁的补齐在循环外独立做一遍，原因见下方 addLockProposals 的注释
      case 'character-missing-lock':
        break;

      // ---------------------------------------------------------------
      // 画外人物声明了但正文没提到：从声明里删掉
      // ---------------------------------------------------------------
      case 'offscreen-not-declared': {
        if (issue.location.kind !== 'shot') break;
        const shot = shotById.get(issue.location.id);
        if (!shot || shot.offscreenCharacters.length === 0) break;
        proposals.push({
          id: `fix:${issue.id}`,
          kind: 'remove-offscreen',
          issueId: issue.id,
          title: `从第 ${shot.number} 镜的「画外人物」里移除`,
          reason:
            '这些名字被声明成「只在声音里出现」，但画面描述和台词里都没有提到他们。' +
            '留着这条声明不会有害，但会让检查单一直挂着一条提示。',
          target: { shotId: shot.id },
          before: shot.offscreenCharacters.join('、'),
          after: '（清空）',
          sideEffect: '如果这个人其实该出现在画面里，那应该做的是把他写进起点并勾选他的锁，而不是删掉这条声明。',
        });
        affected.add(shot.id);
        break;
      }

      // ---------------------------------------------------------------
      // 缺字段：只能给占位，需要用户改写
      // ---------------------------------------------------------------
      case 'shot-incomplete': {
        if (issue.location.kind !== 'shot') break;
        const shot = shotById.get(issue.location.id);
        if (!shot) break;
        const field = issue.location.field;
        const placeholder = draftPlaceholder(project, shot, field);
        if (!placeholder) break;

        const kind: FixKind =
          field === 'startState' ? 'fill-start-state' : field === 'endState' ? 'fill-end-state' : 'fill-action';
        proposals.push({
          id: `fix:${issue.id}`,
          kind,
          issueId: issue.id,
          title: `用草稿填上第 ${shot.number} 镜的「${field === 'startState' ? '起点' : field === 'endState' ? '终点' : '动作'}」`,
          reason:
            '这一格是空的。下面这条是从这一镜的其它字段和场景设定里拼出来的**草稿**——' +
            '它能占住位置、让检查通过，但多半不如你手写的好。',
          target: { shotId: shot.id },
          before: '（空）',
          after: placeholder,
          sideEffect: '这是机器拼的草稿，建议改完再拿去生成。',
        });
        affected.add(shot.id);
        break;
      }

      // ---------------------------------------------------------------
      // 提示词不完整：补项目级默认值
      // ---------------------------------------------------------------
      case 'prompt-incomplete': {
        const missingStyle = project.brief.styleTags.length === 0;
        const missingRatio = project.brief.aspectRatio.trim().length === 0;
        if (!missingStyle && !missingRatio) break;
        proposals.push({
          id: `fix:${issue.id}`,
          kind: 'set-brief',
          issueId: issue.id,
          title: missingStyle ? '给项目补上风格关键词' : '给项目补上画幅',
          reason:
            '这两项会注入到**每一张图**的提示词里。缺画幅模型可能给你出成横屏，缺风格词可能出成写实风。',
          target: { projectField: missingStyle ? 'styleTags' : 'aspectRatio' },
          before: missingStyle ? '（空）' : '（空）',
          after: missingStyle ? 'anime style, cel shading, clean line art' : '16:9',
          sideEffect: '风格词是通用的默认值，强烈建议按你的题材在「引导向导」里换成合适的预设。',
        });
        break;
      }

      default:
        // 其余规则（引用对不上之类）在生成阶段就已被修掉，这里不重复提议
        break;
    }
  }

  // -------------------------------------------------------------------------
  // 锁的补齐：独立跑一遍，**不依赖检查规则是否触发**
  // -------------------------------------------------------------------------
  // 为什么不能挂在 character-missing-lock 这条规则上：
  // 那条规则在「角色登记了锁、但某一镜没勾」时会报，但**当一个角色的锁列表本身为空时它不报**
  // （它报的是「这个角色还没有任何连续性锁」，属于另一种问题）。
  // 结果就是最需要自动补齐的场景反而没有提议——这是实测发现的漏洞。
  //
  // 锁的作用是跨镜一致，所以判定应该直接基于事实：
  // 「这一镜出现了谁、在哪个场景，就该带上谁的锁」。与检查规则解耦。
  addLockProposals(project, proposals, affected);

  return {
    proposals,
    affectedShots: affected.size,
    manualOnly: report.issues.filter((i) => MANUAL_ONLY_RULES.has(i.ruleId)).length,
    manualRuleIds: [...manualRuleIds],
  };
}

/**
 * 为「出现了角色却没勾他的锁」的镜头生成补齐提议。
 *
 * 与检查规则解耦：只要事实成立就提议，不管检查引擎有没有报。
 */
function addLockProposals(project: Project, proposals: FixProposal[], affected: Set<string>): void {
  for (const shot of project.shots) {
    for (const characterId of shot.characterIds) {
      const character = project.characters.find((c) => c.id === characterId);
      if (!character || character.continuityLocks.length === 0) continue;

      const missing = character.continuityLocks.filter((l) => !shot.activeLockIds.includes(l.id));
      if (missing.length === 0) continue;

      proposals.push({
        id: `fix:lock:${shot.id}:${character.id}`,
        kind: 'add-lock',
        issueId: 'character-missing-lock',
        title: `第 ${shot.number} 镜补上「${character.name}」的 ${missing.length} 条锁`,
        reason:
          '这一镜出现了这个角色，但没声明他的锁。锁面不会被写进提示词，角色在这一镜就会变样——' +
          '这是最难排查的问题，因为其他镜头都对，只有这一镜不对。',
        target: { shotId: shot.id, characterId: character.id },
        before: shot.activeLockIds.length === 0 ? '没有勾任何锁' : `已勾 ${shot.activeLockIds.length} 条`,
        after: `再补 ${missing.length} 条（${missing.map((l) => l.label).join('、')}）`,
      });
      affected.add(shot.id);
    }

    // 场景的锁同理
    const scene = project.scenes.find((sc) => sc.id === shot.sceneId);
    if (!scene || scene.continuityLocks.length === 0) continue;
    const sceneMissing = scene.continuityLocks.filter((l) => !shot.activeLockIds.includes(l.id));
    if (sceneMissing.length === 0) continue;

    proposals.push({
      id: `fix:lock:${shot.id}:${scene.id}`,
      kind: 'add-lock',
      issueId: 'scene-missing-elements',
      title: `第 ${shot.number} 镜补上场景「${scene.name}」的 ${sceneMissing.length} 条锁`,
      reason:
        '场景锁固定的是空间与固定元素。缺了它，观众会觉得这一镜换了地方——即使桌椅黑板一个没变。',
      target: { shotId: shot.id, sceneId: scene.id },
      before: shot.activeLockIds.length === 0 ? '没有勾任何锁' : `已勾 ${shot.activeLockIds.length} 条`,
      after: `再补 ${sceneMissing.length} 条（${sceneMissing.map((l) => l.label).join('、')}）`,
    });
    affected.add(shot.id);
  }
}

/** 按画面描述里提到的场景名猜这一镜属于哪个场景 */
function guessSceneForShot(
  project: Project,
  shot: Shot,
): { scene: { id: string; name: string }; reason: string; confidence: 'high' | 'low' } | undefined {
  if (project.scenes.length === 0) return undefined;

  const text = [shot.startState, shot.action, shot.endState].join(' ');
  const normalizedText = text.toLowerCase().replace(/\s+/g, ' ');

  // 1) 文本里提到了某个场景名（或名字里有意义的那一段）→ 高置信
  //    注意不能要求逐字相同：场景名常是「草料场外 · 大雪」，
  //    而用户会写成「草料场空地」。所以对名字也做分段匹配。
  for (const scene of project.scenes) {
    const name = scene.name.trim();
    if (name.length === 0) continue;
    if (text.includes(name)) {
      return {
        scene,
        reason: `画面描述里出现了场景名「${name}」，据此判断这一镜发生在那里。`,
        confidence: 'high',
      };
    }
    // 按分隔符与空格切开，取长度 ≥2 的片段做匹配
    const segments = name
      .split(/[\s·・\-—_/、,，()（）]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2);
    const hitSegment = segments.find((part) => text.includes(part));
    if (hitSegment) {
      return {
        scene,
        reason: `画面描述里出现了「${hitSegment}」，与场景名「${name}」相符，据此判断。`,
        confidence: 'high',
      };
    }
  }

  // 2) 文本里提到了某个场景的固定元素 → 高置信
  //    同样用部分匹配：用户手写的描述不会和登记的英文短语逐字相同
  for (const scene of project.scenes) {
    const hit = scene.fixedElements.find((el) => {
      const needle = el.toLowerCase().replace(/\s+/g, ' ').trim();
      if (needle.length <= 3) return false;
      if (normalizedText.includes(needle)) return true;
      // 长短语允许只命中其中一段
      const words = needle.split(' ').filter((w) => w.length > 3);
      if (words.length >= 2) {
        const hits = words.filter((w) => normalizedText.includes(w)).length;
        return hits >= Math.ceil(words.length * 0.6);
      }
      return false;
    });
    if (hit) {
      return {
        scene,
        reason: `画面描述里出现了「${scene.name}」的固定元素「${hit}」，据此判断。`,
        confidence: 'high',
      };
    }
  }

  // 3) 完全没有文本线索时，才考虑按前后镜头推断
  const neighbour = guessFromNeighbours(project, shot);
  if (neighbour) {
    return {
      scene: neighbour,
      reason: `画面描述里没有明确的场景线索，但这一镜前后的镜头都在「${neighbour.name}」，按连续性推断。`,
      confidence: 'low',
    };
  }

  // 4) 实在没有线索就不猜——猜错比空着更糟
  return undefined;
}

function guessFromNeighbours(project: Project, shot: Shot): { id: string; name: string } | undefined {
  const index = project.shots.findIndex((s) => s.id === shot.id);
  const counts = new Map<string, number>();
  for (const offset of [-2, -1, 1, 2]) {
    const other = project.shots[index + offset];
    if (!other?.sceneId) continue;
    counts.set(other.sceneId, (counts.get(other.sceneId) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  const [topId, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  // 要**明确多数**才采用。原来门槛是 2 票，但一个镜头最多只有 4 个邻居，
  // 两票完全可能是巧合（比如刚好前后各一镜在同一场景）。
  // 场景一致性检查的价值在于准确，猜错会让用户失去对整份检查单的信任。
  if (topCount < 3) return undefined;
  const scene = project.scenes.find((s) => s.id === topId);
  return scene ? { id: scene.id, name: scene.name } : undefined;
}

/** 用现有字段拼一段草稿，填上空的字段 */
function draftPlaceholder(project: Project, shot: Shot, field?: string): string | undefined {
  const scene = project.scenes.find((s) => s.id === shot.sceneId);
  const characters = project.characters.filter((c) => shot.characterIds.includes(c.id));
  const who = characters.map((c) => c.name).join('、') || '画面里的人物';

  if (field === 'startState') {
    const parts = [
      scene ? `场景是${scene.name}` : '',
      scene?.lightDirection ? `光线：${scene.lightDirection}` : '',
      `${who}在画面里`,
      scene && scene.fixedElements.length > 0 ? `能看见${scene.fixedElements.slice(0, 2).join('、')}` : '',
    ].filter(Boolean);
    return parts.length > 1 ? `${parts.join('；')}。（草稿，请改写）` : undefined;
  }

  if (field === 'action') {
    return undefined; // 动作是创作核心，机器拼不出来，也不该拼
  }

  if (field === 'endState') {
    return `画面停在这一镜动作结束后的那一刻。（草稿，请改写；它要能接上下一个镜头的起点）`;
  }

  void project;
  return undefined;
}

// ---------------------------------------------------------------------------
// 应用
// ---------------------------------------------------------------------------

export interface ApplyResult {
  project: Project;
  applied: number;
  /** 因为目标已不存在（用户刚删了镜头等）而跳过的条数 */
  skipped: number;
}

/**
 * 把选中的提议应用到项目上。
 *
 * 返回新对象，不原地改——调用方负责把它写回 store，
 * 这样「撤销」只需要保留旧对象即可。
 */
export function applyFixes(project: Project, proposals: FixProposal[]): ApplyResult {
  const next: Project = structuredClone(project);
  let applied = 0;
  let skipped = 0;

  for (const proposal of proposals) {
    const ok = applyOne(next, proposal);
    if (ok) applied += 1;
    else skipped += 1;
  }

  next.updatedAt = new Date().toISOString();
  return { project: next, applied, skipped };
}

function applyOne(project: Project, proposal: FixProposal): boolean {
  const shotIndex = proposal.target.shotId
    ? project.shots.findIndex((s) => s.id === proposal.target.shotId)
    : -1;
  const shot = shotIndex >= 0 ? project.shots[shotIndex] : undefined;

  switch (proposal.kind) {
    case 'assign-scene': {
      if (!shot || !proposal.target.sceneId) return false;
      shot.sceneId = proposal.target.sceneId;
      return true;
    }
    case 'set-duration': {
      if (!shot) return false;
      shot.duration = 3;
      return true;
    }
    case 'add-lock': {
      if (!shot) return false;
      const owner = proposal.target.characterId
        ? project.characters.find((c) => c.id === proposal.target.characterId)
        : proposal.target.sceneId
          ? project.scenes.find((s) => s.id === proposal.target.sceneId)
          : undefined;
      if (!owner) return false;
      const merged = [...shot.activeLockIds];
      for (const lock of owner.continuityLocks) {
        if (!merged.includes(lock.id)) merged.push(lock.id);
      }
      shot.activeLockIds = merged;
      return true;
    }
    case 'remove-offscreen': {
      if (!shot) return false;
      shot.offscreenCharacters = [];
      return true;
    }
    case 'fill-start-state': {
      if (!shot) return false;
      shot.startState = proposal.after;
      return true;
    }
    case 'fill-end-state': {
      if (!shot) return false;
      shot.endState = proposal.after;
      return true;
    }
    case 'fill-action': {
      if (!shot) return false;
      shot.action = proposal.after;
      return true;
    }
    case 'set-brief': {
      if (proposal.target.projectField === 'styleTags' && project.brief.styleTags.length === 0) {
        project.brief.styleTags = ['anime style', 'cel shading', 'clean line art'];
        return true;
      }
      if (proposal.target.projectField === 'aspectRatio' && project.brief.aspectRatio.trim() === '') {
        project.brief.aspectRatio = '16:9';
        return true;
      }
      return false;
    }
    case 'register-scene':
    case 'add-shot-for-scene':
      // 这两类需要用户提供内容，不在自动修复范围内
      return false;
    default:
      return false;
  }
}
