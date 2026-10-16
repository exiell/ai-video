import type { CharacterCard, Project, SceneCard, Shot, Story } from '../../types/model';

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
  /**
   * 这一步做什么。
   *
   * 三项操作**地位相同**：模型分析完需求后一次性给出全部方案（改 / 新增 / 删除），
   * 用户确认后一起执行。删除不是特殊情况，不需要单独一轮确认 ——
   * 它在同一批里和其他修改一起被审阅，确认后才生效。
   */
  op: 'set' | 'create' | 'delete';
  /** 一句话说明要改什么（给人看，不是字段名） */
  title: string;
  /** 为什么这么改 —— 不能只给结论 */
  reason: string;
  /** 改哪里 / 新增什么 / 删什么 */
  target: EditTarget;
  /** 修改前（新增时为「（新建）」，删除时为被删对象的内容摘要） */
  before: string;
  /** 修改后（删除时为空） */
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
  /**
   * 新增时的字段内容。**id 不在这里** —— 由代码生成。
   *
   * 为什么不让模型给 id：它会编出重复的、或者格式不对的 id，
   * 而那类错误在界面上不一定看得见，却会让引用悄悄断掉。
   * 模型只负责「这个新角色叫什么、长什么样」，标识符是代码的事。
   */
  createFields?: Record<string, unknown>;
}

export interface EditTarget {
  kind: 'shot' | 'character' | 'scene' | 'story' | 'brief';
  /** set / delete 必填；create 时留空（代码生成） */
  id?: string;
  /** 字段名；set 必填，create / delete 时忽略 */
  field?: string;
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
  if (!target.field) return '';
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
export type EditGate = 'confirm';

export interface GateDecision {
  gate: EditGate;
  /** 给人看的理由 */
  why: string;
}

/**
 * 一次最多接受多少条提议。
 *
 * 【v0.35 从 5 提到 40】原来限制 5 条，理由是「超过 5 条说明改动太大」。
 * 但用户明确要求支持**大段改情节** —— 那天然会牵动十几个镜头。
 * 5 条的上限让这类需求根本表达不出来。
 *
 * 上限仍然存在（防止模型失控输出几百条），但放宽到 40。
 */
export const MAX_EDITS = 40;

/**
 * 判断一批改动该怎么处理。
 *
 * 规则刻意做得**可解释**：用户看完理由应该能预测「下次它会不会问我」。
 * 如果规则说不清，用户就会对「它到底改了什么」失去掌控感 ——
 * 那比多问一次糟得多。
 */
export function decideGate(args: { editCount: number }): GateDecision {
  const { editCount } = args;
  /**
   * 【v0.35 取消 auto 档】任何规模的改动都先列出来给用户确认，不直接应用。
   *
   * 用户的原话是「无论什么规模的修改都要先向用户确认，不要直接改」。
   *
   * 这与 Anthropic 公布的「确认框批准率 93%」那条数据是相反的取向 ——
   * 那条数据的结论是「每条都问 ≈ 没问」。但两者场景不同：
   * 那是给开发者用的 CLI，操作频繁且多数无害；这是创作工具，
   * 每次改动直接决定要花钱生成的成品，用户确实会逐条看。
   *
   * 所以这里保留 `EditGate` 这个类型（以后想放开某一类还有位置），
   * 但当前只有一档：全部确认。
   */
  return {
    gate: 'confirm',
    why:
      editCount > 3
        ? `这次一共 ${editCount} 处改动，列出来给你过目后再动手。`
        : '改动会列出来给你过目，确认后才生效，之后还能撤销。',
  };
}

export interface ApplyEditsResult {
  project: Project;
  applied: number;
  skipped: number;
  /** 每条被跳过的原因，用于如实告诉用户 */
  skippedReasons: string[];
  /** 这次操作会作废多少张已经生成的图 */
  orphanedAssets: number;
}

/**
 * 把用户勾选的提议写进项目。
 *
 * 和「自动修复」用的是同一套「先克隆再逐条应用」的写法：
 * 调用方拿到的是**新对象**，原对象不动，所以撤销只要留住旧引用即可。
 *
 * 三种操作（改 / 新增 / 删除）在**同一批**里按顺序执行 ——
 * 删除不是特例，和其它操作一样：模型一次给全，用户确认后一起生效。
 */
export function applyChatEdits(project: Project, edits: ChatEditProposal[]): ApplyEditsResult {
  const next: Project = structuredClone(project);
  let applied = 0;
  const skippedReasons: string[] = [];
  let orphanedAssets = 0;

  for (const edit of edits) {
    if (edit.op === 'create') {
      const made = applyCreate(next, edit);
      if (made.ok) applied += 1;
      else skippedReasons.push(`「${edit.title}」没能新建：${made.reason}`);
      continue;
    }

    if (edit.op === 'delete') {
      const removed = applyDelete(next, edit);
      if (removed.ok) {
        applied += 1;
        orphanedAssets += removed.orphanedAssets;
      } else {
        skippedReasons.push(`「${edit.title}」没能删除：${removed.reason}`);
      }
      continue;
    }

    // op === 'set'
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
    if (edit.beforeAtProposal !== undefined && edit.target.field) {
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

    const field = edit.target.field;
    if (!field) {
      skippedReasons.push(`「${edit.title}」没说是改哪个字段`);
      continue;
    }
    const check = validateFieldValue(edit.target.kind, field, edit.after);
    if (check.value === undefined) {
      skippedReasons.push(`「${edit.title}」没通过校验：${check.reason ?? '格式不对'}`);
      continue;
    }
    if (!writePath(owner, field, check.value)) {
      skippedReasons.push(`「${edit.title}」写不进去：目标字段路径不对`);
      continue;
    }
    applied += 1;
  }

  next.updatedAt = new Date().toISOString();
  return {
    project: next,
    applied,
    skipped: skippedReasons.length,
    skippedReasons,
    orphanedAssets,
  };
}

// ---------------------------------------------------------------------------
// 新增与删除
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

const stamp = (): { schemaVersion: number; createdAt: string; updatedAt: string } => {
  const now = new Date().toISOString();
  return { schemaVersion: 1, createdAt: now, updatedAt: now };
};

/**
 * 新建一个对象。
 *
 * **id 与结构字段由代码补**，模型只提供内容。为什么不让模型给 id：
 * 它会编出重复的、或格式不对的 id，而这类错误在界面上不一定看得见，
 * 却会让引用悄悄断掉 —— 那是最难查的一类问题。
 *
 * 同理，引用关系（新镜头挂哪个场景、新角色出现在哪些镜头）
 * 也从用户的话里推断不出来，所以新对象一律**先不挂引用**，
 * 由穿帮检查提示用户去挂 —— 那本来就是人在界面上做的决定。
 */
function applyCreate(
  project: Project,
  edit: ChatEditProposal,
): { ok: true } | { ok: false; reason: string } {
  const fields = edit.createFields ?? {};
  const str = (k: string, fallback = ''): string => {
    const v = fields[k];
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
  };

  try {
    if (edit.target.kind === 'character') {
      const c: CharacterCard = {
        id: newId('char'),
        name: str('name', '未命名角色'),
        role: 'supporting',
        identity: {
          face: str('identity.face'),
          hair: str('identity.hair'),
          bodyType: str('identity.bodyType'),
          ageRange: str('identity.ageRange'),
          summary: str('identity.summary'),
          summaryEn: str('identity.summaryEn'),
        },
        variants: [],
        continuityLocks: [],
        shotIds: [],
        ...stamp(),
      };
      project.characters.push(c);
      return { ok: true };
    }

    if (edit.target.kind === 'scene') {
      const s: SceneCard = {
        id: newId('scene'),
        name: str('name', '未命名场景'),
        identity: {
          placeType: str('identity.placeType'),
          spatialStructure: str('identity.spatialStructure'),
          summary: str('identity.summary'),
          summaryEn: str('identity.summaryEn'),
        },
        variants: [],
        continuityLocks: [],
        fixedElements: Array.isArray(fields.fixedElements)
          ? (fields.fixedElements as unknown[]).map(String).filter(Boolean).slice(0, 12)
          : [],
        lightDirection: str('lightDirection'),
        mainColor: str('mainColor'),
        shotIds: [],
        ...stamp(),
      };
      project.scenes.push(s);
      return { ok: true };
    }

    if (edit.target.kind === 'shot') {
      /**
       * 新镜头默认挂到**最后一个镜头用的场景**上。
       *
       * 这是唯一一处代码替用户做的引用决定，理由是：新镜头几乎总是
       * 「接着上一镜」的，挂空场景会让它立刻出现在穿帮检查里，
       * 而用户还得手动去挂。挂最后一个场景至少是个合理的起点，改起来也容易。
       */
      const lastShot = project.shots[project.shots.length - 1];
      const shot: Shot = {
        id: newId('shot'),
        number: project.shots.length + 1,
        duration: typeof fields.duration === 'number' ? fields.duration : 3,
        shotSize: (['extreme-wide', 'wide', 'medium', 'close-up', 'extreme-close-up'] as const).includes(
          fields.shotSize as never,
        )
          ? (fields.shotSize as Shot['shotSize'])
          : 'medium',
        cameraPosition: str('cameraPosition'),
        cameraMove: (['static', 'pan', 'tilt', 'dolly', 'zoom', 'handheld', 'crane'] as const).includes(
          fields.cameraMove as never,
        )
          ? (fields.cameraMove as Shot['cameraMove'])
          : 'static',
        startState: str('startState'),
        action: str('action'),
        endState: str('endState'),
        dialogue: str('dialogue'),
        sound: str('sound'),
        mood: str('mood'),
        transition: str('transition'),
        sceneId: lastShot?.sceneId ?? '',
        characterIds: [],
        variantIds: [],
        activeLockIds: [],
        offscreenCharacters: [],
        sourceSceneId: '',
        ...(str('continuityNote') ? { continuityNote: str('continuityNote') } : {}),
      };
      project.shots.push(shot);
      return { ok: true };
    }

    return { ok: false, reason: '这一类不支持新建（故事与规格是固定的，不能加）' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '未知错误' };
  }
}

/**
 * 删除一个对象，并**级联清理所有指向它的引用**。
 *
 * 为什么必须级联：删掉一个角色，而某个镜头的 `characterIds` 里还留着它的 id，
 * 那条引用就变成了悬空的。悬空引用不一定会立刻报错，但会让
 * 「这一镜谁出镜」显示成空白，而用户不知道是自己删角色造成的。
 *
 * 删除**不可逆**（撤销栈可能被后续操作顶掉），所以界面上必须明确确认。
 */
function applyDelete(
  project: Project,
  edit: ChatEditProposal,
): { ok: true; orphanedAssets: number } | { ok: false; reason: string } {
  const id = edit.target.id;
  if (!id) return { ok: false, reason: '没说是删哪一个' };

  if (edit.target.kind === 'character') {
    const i = project.characters.findIndex((c) => c.id === id);
    if (i < 0) return { ok: false, reason: '这个角色已经不存在了' };
    project.characters.splice(i, 1);
    let orphaned = 0;
    for (const shot of project.shots) {
      if (shot.characterIds.includes(id)) {
        shot.characterIds = shot.characterIds.filter((x) => x !== id);
      }
      if (shot.offscreenCharacters.some((n) => n === id)) {
        shot.offscreenCharacters = shot.offscreenCharacters.filter((n) => n !== id);
      }
    }
    return { ok: true, orphanedAssets: orphaned };
  }

  if (edit.target.kind === 'scene') {
    const i = project.scenes.findIndex((s) => s.id === id);
    if (i < 0) return { ok: false, reason: '这个场景已经不存在了' };
    project.scenes.splice(i, 1);
    // 用了这个场景的镜头变成「未指定场景」，由穿帮检查提示去挂
    for (const shot of project.shots) {
      if (shot.sceneId === id) shot.sceneId = '';
    }
    return { ok: true, orphanedAssets: 0 };
  }

  if (edit.target.kind === 'shot') {
    const i = project.shots.findIndex((s) => s.id === id);
    if (i < 0) return { ok: false, reason: '这个镜头已经不存在了' };
    project.shots.splice(i, 1);
    // 镜号重排，否则删掉第 3 镜后会出现 1 2 4 5
    project.shots.forEach((s, index) => {
      s.number = index + 1;
    });
    for (const c of project.characters) {
      c.shotIds = c.shotIds.filter((x) => x !== id);
    }
    for (const s of project.scenes) {
      s.shotIds = s.shotIds.filter((x) => x !== id);
    }
    // 这个镜头的三帧图会变成孤儿图（图还在库里，但没有镜头指向它了）
    return { ok: true, orphanedAssets: 3 };
  }

  return { ok: false, reason: '故事与规格不能删除' };
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

  lines.push('# 故事（可改字段：body 正文、charactersNote 人物、setting 背景、conflict 冲突、ending 结局）');
  lines.push(`标题：${project.name}`);
  lines.push(`一句话：${project.logline}`);
  if (project.story.body.trim()) lines.push(`正文：${truncate(project.story.body, 1200)}`);
  if (project.story.charactersNote.trim()) lines.push(`人物：${project.story.charactersNote}`);
  if (project.story.setting.trim()) lines.push(`背景：${project.story.setting}`);
  if (project.story.conflict.trim()) lines.push(`冲突：${project.story.conflict}`);
  if (project.story.ending.trim()) lines.push(`结局：${project.story.ending}`);

  lines.push('');
  lines.push('# 规格（可改字段：styleTone 风格基调、styleTags 风格关键词、negativePrompt 负向词）');
  lines.push(
    `画幅 ${project.brief.aspectRatio}，目标时长 ${project.brief.targetDuration} 秒，` +
      `风格基调：${project.brief.styleTone || '（未填）'}，` +
      `风格关键词：${project.brief.styleTags.join('、') || '（未填）'}，` +
      `负向词：${project.brief.negativePrompt || '（未填）'}`,
  );

  if (project.characters.length > 0) {
    lines.push('');
    lines.push('# 角色');
    for (const c of project.characters) {
      lines.push(`## ${c.name}（id=${c.id}）`);
      // 逐字段输出白名单里允许改的内容 —— 模型看不到的字段它改不了
      lines.push(readableFields('character', c));
      if (c.continuityLocks.length > 0) {
        lines.push(`  连续性锁：${c.continuityLocks.map((l) => l.phrase).join('、')}（改锁面需在界面操作）`);
      }
    }
  }

  if (project.scenes.length > 0) {
    lines.push('');
    lines.push('# 场景');
    for (const s of project.scenes) {
      lines.push(`## ${s.name}（id=${s.id}）`);
      lines.push(readableFields('scene', s));
      if (s.continuityLocks.length > 0) {
        lines.push(`  连续性锁：${s.continuityLocks.map((l) => l.phrase).join('、')}（改锁面需在界面操作）`);
      }
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
      lines.push(`  场景：${scene?.name ?? '（未指定）'}｜出镜：${cast || '（无）'}`);
      // 同样逐字段输出 —— 机位、转场、声音原来都漏了，导致模型「不知道有这些字段」
      lines.push(readableFields('shot', s));
    }
    if (project.shots.length > shown.length) {
      lines.push(`（其余 ${project.shots.length - shown.length} 镜省略）`);
    }
  }

  lines.push('');
  lines.push('# 可新建与可删除');
  lines.push('可以新建：角色、场景、镜头。新建时给内容字段即可，id 由程序生成。');
  lines.push('可以删除：角色、场景、镜头（story 与 brief 不能删）。');

  return lines.join('\n');
}

/**
 * 把一个对象上**白名单允许改的字段**渲染成可读文本。
 *
 * 【为什么要用白名单驱动，而不是手写字段名】
 * 原来的上下文是手写字段列表的，而白名单是另一处手写的 ——
 * 两边一旦不同步，模型就会「有权改但看不见」某个字段，
 * 表现是用户明确要求改它、AI 却完全不动（它根本不知道有这个东西）。
 *
 * 实测过这个 bug 的规模：角色的 8 个可改字段里，模型只能看到 2 个。
 *
 * 现在从 `EDITABLE_FIELDS` 直接生成，**加字段会自动出现在上下文里**，
 * 结构上不可能再脱节。测试里还有一条专门守这个不变量。
 */
function readableFields(kind: EditTarget['kind'], obj: unknown): string {
  const spec = EDITABLE_FIELDS[kind];
  const parts: string[] = [];
  for (const [field, def] of Object.entries(spec)) {
    const value = readPath(obj, field);
    const text = Array.isArray(value)
      ? value.join('、')
      : value === undefined || value === null
        ? ''
        : String(value).trim();

    /**
     * **空字段也要列出名字**，只是不给值。
     *
     * 这是被测试抓出来的：原来空值直接跳过，于是模型看不到这个字段的名字，
     * 也就不知道它存在 —— 而**空字段恰恰最需要被填**。
     * 「这一镜还没写衔接说明」和「这个工具没有衔接说明这个字段」是两回事，
     * 模型必须能区分，否则用户说「补上衔接说明」它会答「没有这个字段」。
     */
    parts.push(text ? `${def.label}（${field}）= ${truncate(text, 300)}` : `${def.label}（${field}）= 空`);
  }
  return `  ${parts.join('｜')}`;
}


function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}……（已截断）`;
}

/** 故事单独取用（聊天可能只谈故事） */
export function storyOf(project: Project): Story {
  return project.story;
}
