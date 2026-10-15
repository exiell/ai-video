import type { Project, Story } from '../../types/model';

/**
 * 对话式改稿（方案.md §7.6.20）
 *
 * ===========================================================================
 * 这个模块解决什么问题
 * ===========================================================================
 * 表格填不动，是这个工具最大的劝退点。
 *
 * 「起点 / 动作 / 终点 / 机位 / 运镜 / 台词 / 声音 / 情绪 / 衔接说明……」——
 * 对做过分镜的人是常识，对新手是一堵墙。他填了也不知道填得对不对，
 * 更不知道「想让第三镜更紧张一点」该怎么落成字段。
 *
 * 所以给一个对话栏：**用大白话说你想改什么，AI 告诉你它的理解，
 * 并给出具体的字段修改，你点头才改。**
 *
 * ===========================================================================
 * 三条设计铁律（每一条都有具体代价）
 * ===========================================================================
 *
 * 1. **AI 不能直接改，只能提议。**
 *    分镜是用户的作品，出图要花钱。静默修改比不修改更糟——
 *    他回头发现内容变了、不知道哪里变了、更不知道能不能撤销。
 *    所以复用「自动修复」那套：提议 → 勾选 → 确认 → 可撤销。
 *
 * 2. **只能改白名单里的字段，且必须校验类型。**
 *    模型返回的 JSON 是不可信输入。如果不加限制，它可能把
 *    `characterIds` 写成字符串、把 `duration` 写成「三秒」、
 *    甚至塞进一个不存在的字段——那会直接破坏项目数据。
 *    所以这里对「改哪个对象的哪个字段」做**逐字段白名单 + 类型校验**，
 *    校验不过就丢掉那条提议，并如实告诉用户丢了几条。
 *
 * 3. **默认只改被问到的那一处，用户明确要求才联动。**
 *    模型很热心地「顺手把相关的也改了」——这恰恰最危险：
 *    改动范围一大，用户没法审阅，只能盲目相信或全部拒绝。
 *    所以单点修改是默认；要联动得用户自己说。
 */

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatEditProposal {
  /** 稳定 id，供界面勾选 */
  id: string;
  /** 一句话说明要改什么（给人看，不是字段名） */
  title: string;
  /** 为什么这么改 —— 不能只给结论 */
  reason: string;
  /** 改哪里 */
  target: EditTarget;
  /** 修改前 */
  before: string;
  /** 修改后 */
  after: string;
  /** 可能的副作用 */
  sideEffect?: string;
  /**
   * **提议生成时**这个字段的值。
   *
   * 【为什么要单独记一份】从「AI 给出提议」到「用户点确认」之间，
   * 用户完全可能自己动手改了同一个字段（看了一眼觉得不对，顺手改了）。
   * 如果这时直接写入，就把他的修改**静默覆盖**了 —— 而他会以为是自己点错了。
   *
   * 所以确认时比对：当前值和它不一致，说明用户手改过，跳过并如实告知，
   * 而不是覆盖掉。这是 BlockNote 的 `rebaseTool.ts` 与 TinaCMS 的
   * `updateSelectively` 解决的同一个问题；这里用最轻的做法
   * （检测到冲突就跳过，不自动合并）—— 因为自动合并的出错方式更难解释。
   */
  beforeAtProposal?: string;
}

export interface EditTarget {
  kind: 'shot' | 'character' | 'scene' | 'story' | 'brief';
  /** shot / character / scene 必填 */
  id?: string;
  /** 字段名，必须在该 kind 的白名单里 */
  field: string;
}

export interface ChatReply {
  /** 给用户的回答（自然语言，先说人话再给提议） */
  reply: string;
  /** 具体的修改提议，可能为空（纯提问就只回答） */
  edits: ChatEditProposal[];
  /** 被校验挡掉的提议条数，大于 0 时要如实告诉用户 */
  rejected: number;
  /** 模型是否要求扩大改动范围（用户没明确要求时我们劝它别这么做） */
  scope: 'single' | 'related';
}

// ---------------------------------------------------------------------------
// 字段白名单
// ---------------------------------------------------------------------------

type FieldType = 'text' | 'enum' | 'number' | 'stringArray';

interface FieldSpec {
  type: FieldType;
  label: string;
  /** enum 用 */
  options?: readonly string[];
  /** 数值范围 */
  min?: number;
  max?: number;
}

/**
 * 允许 AI 改的字段。
 *
 * **故意不包含** `id` / `sceneId` / `characterIds` / `activeLockIds` / `shotIds` ——
 * 这些是对象之间的引用关系。让模型改引用，它会把分镜挂到不存在的场景上，
 * 而且这类错误在界面上不一定看得见（检查引擎会报「场景缺失」，
 * 但用户不知道是 AI 干的）。
 *
 * 改引用关系应该通过界面上的下拉框，那是人做的决定。
 */
export const EDITABLE_FIELDS: Record<EditTarget['kind'], Record<string, FieldSpec>> = {
  shot: {
    startState: { type: 'text', label: '起点画面' },
    action: { type: 'text', label: '动作' },
    endState: { type: 'text', label: '终点画面' },
    dialogue: { type: 'text', label: '台词 / 旁白' },
    sound: { type: 'text', label: '声音设计' },
    mood: { type: 'text', label: '情绪' },
    cameraPosition: { type: 'text', label: '机位' },
    transition: { type: 'text', label: '转场' },
    continuityNote: { type: 'text', label: '与下一镜的衔接说明' },
    duration: { type: 'number', label: '时长（秒）', min: 1, max: 20 },
    shotSize: {
      type: 'enum',
      label: '景别',
      options: ['extreme-wide', 'wide', 'medium', 'close-up', 'extreme-close-up'],
    },
    cameraMove: {
      type: 'enum',
      label: '运镜',
      options: ['static', 'pan', 'tilt', 'dolly', 'zoom', 'handheld', 'crane'],
    },
    transitionType: { type: 'enum', label: '与上一镜的转场类型', options: ['continuation', 'cut'] },
  },
  character: {
    name: { type: 'text', label: '名字' },
    'identity.summary': { type: 'text', label: '身份概述（中文）' },
    'identity.summaryEn': { type: 'text', label: '身份描述（英文，给模型看）' },
    'identity.face': { type: 'text', label: '面部特征' },
    'identity.hair': { type: 'text', label: '发型发色' },
    'identity.bodyType': { type: 'text', label: '体型' },
    'identity.ageRange': { type: 'text', label: '年龄段' },
    negativePrompt: { type: 'text', label: '负向词' },
  },
  scene: {
    name: { type: 'text', label: '名字' },
    'identity.summary': { type: 'text', label: '场景概述（中文）' },
    'identity.summaryEn': { type: 'text', label: '场景描述（英文）' },
    'identity.placeType': { type: 'text', label: '地点类型' },
    'identity.spatialStructure': { type: 'text', label: '空间结构' },
    lightDirection: { type: 'text', label: '主光方向' },
    mainColor: { type: 'text', label: '主色调' },
    timeOfDay: { type: 'text', label: '时段' },
    weather: { type: 'text', label: '天气' },
    fixedElements: { type: 'stringArray', label: '固定元素（英文短语）' },
  },
  story: {
    body: { type: 'text', label: '故事正文' },
    charactersNote: { type: 'text', label: '人物说明' },
    setting: { type: 'text', label: '背景' },
    conflict: { type: 'text', label: '冲突' },
    ending: { type: 'text', label: '结局' },
  },
  brief: {
    styleTone: { type: 'text', label: '风格基调' },
    styleTags: { type: 'stringArray', label: '风格关键词（英文）' },
    negativePrompt: { type: 'text', label: '全局负向词' },
  },
};

/** 这个字段能不能改 */
export function isEditable(kind: EditTarget['kind'], field: string): boolean {
  return Object.prototype.hasOwnProperty.call(EDITABLE_FIELDS[kind], field);
}

/** 字段的中文名，用于界面上说「改的是哪一项」 */
export function fieldLabel(kind: EditTarget['kind'], field: string): string {
  return EDITABLE_FIELDS[kind][field]?.label ?? field;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export interface ValidationOutcome {
  /** 通过校验的值（可能被规整过，例如去空白、转数字） */
  value?: string | number | string[];
  /** 不通过的原因（人话） */
  reason?: string;
}

/**
 * 校验一个值能不能写进某个字段。
 *
 * 只做「结构安全」校验，不判断内容好不好——
 * 内容质量是用户点确认时自己判断的，机器不该替他做审美判断。
 */
export function validateFieldValue(
  kind: EditTarget['kind'],
  field: string,
  raw: unknown,
): ValidationOutcome {
  const spec = EDITABLE_FIELDS[kind][field];
  if (!spec) return { reason: `「${field}」不是可修改的字段` };

  switch (spec.type) {
    case 'text': {
      if (typeof raw !== 'string') return { reason: '内容必须是文字' };
      const v = raw.trim();
      // 上限不是洁癖：模型偶尔会把整段分镜复述一遍塞进来，
      // 那会把一个字段撑成几千字，界面直接没法看。
      if (v.length > 2000) return { reason: '内容超过 2000 字，太长了' };
      if (v.length === 0) return { reason: '内容不能是空的' };
      return { value: v };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { reason: '必须是一个数字' };
      const min = spec.min ?? 0;
      const max = spec.max ?? Number.MAX_SAFE_INTEGER;
      if (n < min || n > max) return { reason: `必须在 ${min} 到 ${max} 之间` };
      return { value: n };
    }
    case 'enum': {
      const v = String(raw).trim();
      if (!spec.options?.includes(v)) {
        return { reason: `只能是：${spec.options?.join(' / ')}` };
      }
      return { value: v };
    }
    case 'stringArray': {
      const arr = Array.isArray(raw)
        ? raw
        : typeof raw === 'string'
          ? // 容忍模型返回 "a, b, c" —— 这很常见，不值得因此丢掉整条提议
            raw.split(/[,，;；\n]/)
          : null;
      if (!arr) return { reason: '必须是短语列表' };
      const cleaned = arr
        .map((x) => String(x).trim())
        .filter((x) => x.length > 0 && x.length <= 200)
        .slice(0, 12);
      if (cleaned.length === 0) return { reason: '至少要有一个短语' };
      return { value: cleaned };
    }
    default:
      return { reason: '未知的字段类型' };
  }
}

// ---------------------------------------------------------------------------
// 应用
// ---------------------------------------------------------------------------

/** 按 `a.b` 路径取值，供界面显示「原来是什么」 */
export function readField(project: Project, target: EditTarget): string {
  const obj = resolveOwner(project, target);
  if (!obj) return '';
  const value = readPath(obj, target.field);
  if (Array.isArray(value)) return value.join('、');
  if (value === undefined || value === null) return '';
  return String(value);
}

function resolveOwner(project: Project, target: EditTarget): unknown {
  switch (target.kind) {
    case 'shot':
      return project.shots.find((s) => s.id === target.id);
    case 'character':
      return project.characters.find((c) => c.id === target.id);
    case 'scene':
      return project.scenes.find((s) => s.id === target.id);
    case 'story':
      return project.story;
    case 'brief':
      return project.brief;
    default:
      return undefined;
  }
}

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function writePath(obj: unknown, path: string, value: unknown): boolean {
  const keys = path.split('.');
  let cur: unknown = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i]!;
    if (typeof cur !== 'object' || cur === null) return false;
    const next = (cur as Record<string, unknown>)[key];
    if (typeof next !== 'object' || next === null) return false;
    cur = next;
  }
  const last = keys[keys.length - 1]!;
  if (typeof cur !== 'object' || cur === null) return false;
  (cur as Record<string, unknown>)[last] = value;
  return true;
}

/** 把值截短到适合放进提示语的长度 */
function truncateForMessage(text: string, max = 40): string {
  return text.length <= max ? text : `${text.slice(0, max)}……`;
}

// ---------------------------------------------------------------------------
// 闸门分级：不是「要不要确认」，而是「哪一档」
// ---------------------------------------------------------------------------

/**
 * 一条改动该怎么处理。
 *
 * ===========================================================================
 * 为什么要分档，而不是「每条都确认」
 * ===========================================================================
 * Anthropic 在 Claude Code 的工程复盘里给了一个数字：**用户对权限确认的
 * 批准率是 93%**。原文——
 *
 *   "Claude Code users approve 93% of permission prompts...
 *    Over time that leads to approval fatigue, where people stop
 *    paying close attention to what they're approving."
 *
 * 也就是说，**每条都弹确认框 ≈ 没有确认**。用户会点「同意」，但不会真的看。
 * 这时确认框提供的安全感是假的，反而比不确认更危险 —— 因为它让人以为
 * 自己审过了。
 *
 * Anthropic 自己的解法是分档，其中关键的一条是**项目内的写入直接放行**，
 * 理由是 *"in-project edits are reviewable via version control"* ——
 * 即**可回退的改动不需要逐条确认**。
 *
 * 我们的 AI 改的是本机 IndexedDB 里的分镜数据，而且**一键可撤销**，
 * 正好属于这一类。所以安全性由「可撤销」保证，而不是由确认框保证。
 *
 * 三档里的前两档在这里：
 *  - `auto`   ：定点小改 → 直接应用 + 回执 + 可撤销
 *  - `confirm`：波及多处、难以逐条审阅 → 必须勾选确认
 *
 * （「重新生成整个故事 / 角色 / 分镜」这类大额且不可逆的操作不在这里，
 *   它们走各自原有的确认流程，本模块不参与。）
 */
export type EditGate = 'auto' | 'confirm';

export interface GateDecision {
  gate: EditGate;
  /** 给人看的理由 —— 必须说清「为什么这次不问你」或「为什么这次要问你」 */
  why: string;
}

/** 超过这个条数就要求确认：多到一定程度，列出来让你扫一眼比直接改更稳妥 */
export const AUTO_APPLY_MAX_EDITS = 3;

/**
 * 判断一批改动该怎么处理。
 *
 * 规则刻意做得**可解释**：用户看完理由应该能预测「下次它会不会问我」。
 * 如果规则说不清，用户就会对「它到底改了什么」失去掌控感 ——
 * 那比多问一次糟得多。
 */
export function decideGate(args: {
  editCount: number;
  /** 模型自称的改动范围 */
  scope: 'single' | 'related';
  /** 涉及多少个不同的对象 */
  touchedTargets: number;
}): GateDecision {
  const { editCount, scope, touchedTargets } = args;

  // 模型自己承认要联动改 —— 这种最难审阅：改动之间有关联，
  // 逐条看反而会漏掉整体效果，所以必须整体过目
  if (scope === 'related') {
    return {
      gate: 'confirm',
      why: '这次改动会连带影响相关的镜头，放在一起看更容易判断整体效果，所以先给你过目。',
    };
  }

  if (editCount > AUTO_APPLY_MAX_EDITS) {
    return {
      gate: 'confirm',
      why: `这次一共改了 ${editCount} 处，条数比较多，所以先列出来给你看一眼。`,
    };
  }

  if (touchedTargets > 1) {
    return {
      gate: 'confirm',
      why: `这次改到了 ${touchedTargets} 个不同的地方，所以先列出来给你看一眼。`,
    };
  }

  return {
    gate: 'auto',
    why:
      editCount === 1
        ? '只改了 1 处，而且随时可以撤销，所以直接改了。'
        : `只改了 ${editCount} 处，而且随时可以撤销，所以直接改了。`,
  };
}

export interface ApplyEditsResult {
  project: Project;
  applied: number;
  skipped: number;
  /** 每条被跳过的原因，用于如实告诉用户 */
  skippedReasons: string[];
}

/**
 * 把用户勾选的提议写进项目。
 *
 * 和「自动修复」用的是同一套「先克隆再逐条应用」的写法：
 * 调用方拿到的是**新对象**，原对象不动，所以撤销只要留住旧引用即可。
 */
export function applyChatEdits(project: Project, edits: ChatEditProposal[]): ApplyEditsResult {
  const next: Project = structuredClone(project);
  let applied = 0;
  const skippedReasons: string[] = [];

  for (const edit of edits) {
    const owner = resolveOwner(next, edit.target);
    if (!owner) {
      skippedReasons.push(`「${edit.title}」的目标已经不存在了`);
      continue;
    }

    /**
     * 冲突检测：提议生成之后，用户是不是自己动手改过这个字段？
     *
     * 如果不查这一步，用户的手改会被**静默覆盖** —— 最糟的那种失败：
     * 他明明改对了，结果发现又变回 AI 那一版，还不知道为什么。
     */
    if (edit.beforeAtProposal !== undefined) {
      const currentRaw = readPath(owner, edit.target.field);
      const current = Array.isArray(currentRaw)
        ? currentRaw.join('、')
        : currentRaw === undefined || currentRaw === null
          ? ''
          : String(currentRaw);
      if (current !== edit.beforeAtProposal) {
        skippedReasons.push(
          `「${edit.title}」没有应用：你在这之后自己改过这一处（现在是「${truncateForMessage(current)}」），` +
            `所以没有用 AI 的版本覆盖你的。`,
        );
        continue;
      }
    }
    const check = validateFieldValue(edit.target.kind, edit.target.field, edit.after);
    if (check.value === undefined) {
      skippedReasons.push(`「${edit.title}」没通过校验：${check.reason ?? '格式不对'}`);
      continue;
    }
    if (!writePath(owner, edit.target.field, check.value)) {
      skippedReasons.push(`「${edit.title}」写不进去：目标字段路径不对`);
      continue;
    }
    applied += 1;
  }

  next.updatedAt = new Date().toISOString();
  return { project: next, applied, skipped: skippedReasons.length, skippedReasons };
}

// ---------------------------------------------------------------------------
// 给模型的上下文
// ---------------------------------------------------------------------------

/**
 * 把项目压缩成一段模型能读的文本。
 *
 * **为什么要压缩而不是直接 JSON.stringify(project)**：
 * 一个 20 镜的项目，加上角色卡与场景卡，JSON 能到几万字符。
 * 那既贵又慢，而且模型在长输入里更容易漏掉关键信息。
 * 这里只给「模型改稿需要知道的」：故事、角色、场景、每一镜的关键字段。
 *
 * 同时**给出 id**，因为模型要在回复里指明「改哪一镜」。
 */
export function buildProjectContext(project: Project, maxShots = 40): string {
  const lines: string[] = [];

  lines.push('# 故事');
  lines.push(`标题：${project.name}`);
  lines.push(`一句话：${project.logline}`);
  if (project.story.body.trim()) {
    lines.push(`正文：${truncate(project.story.body, 1200)}`);
  }
  if (project.story.setting.trim()) lines.push(`背景：${project.story.setting}`);
  if (project.story.conflict.trim()) lines.push(`冲突：${project.story.conflict}`);
  if (project.story.ending.trim()) lines.push(`结局：${project.story.ending}`);

  lines.push('');
  lines.push('# 规格');
  lines.push(
    `画幅 ${project.brief.aspectRatio}，目标时长 ${project.brief.targetDuration} 秒，` +
      `风格基调：${project.brief.styleTone || '未填写'}`,
  );

  if (project.characters.length > 0) {
    lines.push('');
    lines.push('# 角色');
    for (const c of project.characters) {
      lines.push(
        `- id=${c.id} 名字=${c.name}｜${c.identity.summary || '（无身份描述）'}` +
          (c.continuityLocks.length > 0
            ? `｜连续性锁：${c.continuityLocks.map((l) => l.phrase).join('、')}`
            : ''),
      );
    }
  }

  if (project.scenes.length > 0) {
    lines.push('');
    lines.push('# 场景');
    for (const s of project.scenes) {
      lines.push(
        `- id=${s.id} 名字=${s.name}｜${s.identity.summary || '（无描述）'}` +
          `｜固定元素：${s.fixedElements.join('、') || '（未填）'}` +
          `｜光线：${s.lightDirection || '（未填）'}`,
      );
    }
  }

  if (project.shots.length > 0) {
    lines.push('');
    lines.push(`# 分镜（共 ${project.shots.length} 镜）`);
    const shown = project.shots.slice(0, maxShots);
    for (const s of shown) {
      const scene = project.scenes.find((x) => x.id === s.sceneId);
      const cast = project.characters
        .filter((c) => s.characterIds.includes(c.id))
        .map((c) => c.name)
        .join('、');
      lines.push(`## 第 ${s.number} 镜（id=${s.id}）`);
      lines.push(`景别=${s.shotSize} 运镜=${s.cameraMove} 时长=${s.duration}秒`);
      lines.push(`场景=${scene?.name ?? '（未指定）'} 角色=${cast || '（无）'}`);
      lines.push(`起点：${s.startState || '（空）'}`);
      lines.push(`动作：${s.action || '（空）'}`);
      lines.push(`终点：${s.endState || '（空）'}`);
      if (s.dialogue) lines.push(`台词：${s.dialogue}`);
      if (s.mood) lines.push(`情绪：${s.mood}`);
      if (s.continuityNote) lines.push(`衔接说明：${s.continuityNote}`);
    }
    if (project.shots.length > shown.length) {
      lines.push(`（其余 ${project.shots.length - shown.length} 镜省略）`);
    }
  }

  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}……（已截断）`;
}

/** 故事单独取用（聊天可能只谈故事） */
export function storyOf(project: Project): Story {
  return project.story;
}
