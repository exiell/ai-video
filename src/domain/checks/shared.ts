import type { CheckIssue, CheckRuleId, CheckSeverity, CheckLocation } from '../../types/model';

/**
 * 检查引擎共用的构造函数。
 *
 * 设计原则（方案.md v0.6 §3.2）：**报告原因，不报「校验失败」**。
 * 每条问题都必须回答三件事：哪里错了、为什么错、怎么改。
 */

let seq = 0;

export interface IssueInput {
  ruleId: CheckRuleId;
  severity: CheckSeverity;
  title: string;
  why: string;
  suggestion: string;
  location: CheckLocation;
}

export function makeIssue(input: IssueInput): CheckIssue {
  seq += 1;
  return {
    id: `${input.ruleId}:${input.location.id}:${input.location.field ?? '-'}:${seq}`,
    ruleId: input.ruleId,
    severity: input.severity,
    title: input.title,
    why: input.why,
    suggestion: input.suggestion,
    location: input.location,
  };
}

/** 供测试重置，保证问题 id 可预期 */
export function resetIssueSeq(): void {
  seq = 0;
}

/** 镜头在界面上的称呼：优先用镜号 */
export function shotLabel(number: number): string {
  return `第 ${number} 镜`;
}

/**
 * 从一段画面描述里找出「动作片段」，用于「一镜一动作」检查。
 *
 * 做法：按标点切分，每段里若含动作动词，就算一个动作片段。
 * 这是启发式判断，可能误报，因此该规则只给「警告」而不是「错误」，
 * 并且文案写成「疑似」而不是断言。
 */
const ACTION_VERBS = [
  // 移动
  '走', '跑', '跳', '冲', '扑', '逃', '追', '爬', '跪', '蹲', '躺', '站起', '坐下',
  '后退', '前进', '穿过', '穿越', '跨出', '跨过', '迈步', '进门', '出门',
  '转身', '回头', '转头', '扭头',
  // 手部与持物
  '抬手', '伸手', '拂', '按', '握', '抓', '掏出', '拔出', '拿起', '放下',
  '递给', '接过', '推开', '拉开', '抱', '扔', '抛', '挥动', '换到', '提起', '扛起', '背起',
  // 身体与表情
  '低头', '抬头', '点头', '摇头', '睁眼', '闭眼', '皱眉', '咬牙', '喘', '颤抖', '发抖',
  // 交互
  '砍', '刺', '劈', '挡', '躲', '闪避', '拦住', '拽', '撞',
  // 声与说
  '喊', '叫', '问道', '回答', '低声', '开口',
  // 其他离散动作
  '打开', '关上', '转身离开', '跪下', '倒下', '跌坐',
  // 英文
  'walks', 'runs', 'turns', 'reaches', 'grabs', 'picks up', 'puts down', 'opens',
  'closes', 'stands up', 'sits down', 'raises', 'lifts', 'drops', 'throws',
  'glances', 'smiles', 'nods', 'steps', 'enters', 'exits', 'pushes',
  'pulls', 'kneels', 'draws', 'swings', 'blocks', 'dodges',
];

/**
 * 强分隔：分号、句号、顿号、箭头——两侧一定是两个动作。
 */
const SPLIT_RE = /[；;。、→]|\bthen\b|\band then\b/;

/** 弱分隔（逗号）：只有两侧都各自含动作动词时，才算两个动作 */
const WEAK_SPLIT_RE = /[，,]/;

export interface ActionFragment {
  text: string;
  verb: string;
}

export function findActionFragments(action: string): ActionFragment[] {
  const text = action.trim();
  if (!text) return [];

  const verbsIn = (part: string): string | undefined => {
    const lower = part.toLowerCase();
    return ACTION_VERBS.find((v) => lower.includes(v.toLowerCase()));
  };

  const fragments: ActionFragment[] = [];

  // 第一层：按强分隔切开，每一段独立算一个动作
  for (const strongPart of text.split(SPLIT_RE)) {
    const part = strongPart.trim();
    if (!part) continue;

    // 第二层：强分隔内部，若逗号两侧**各自**都含动作动词，才算两个动作。
    // 这样「他缓缓转头，望向草厅」不会被误判成两个动作，
    // 而「抬手拂去肩上的雪，把花枪换到左手」会被正确拆开。
    const pieces = part
      .split(WEAK_SPLIT_RE)
      .map((x) => x.trim())
      .filter(Boolean);
    const withVerbs = pieces.filter((x) => verbsIn(x) !== undefined);

    if (withVerbs.length > 1) {
      for (const piece of withVerbs) {
        const verb = verbsIn(piece);
        if (verb) fragments.push({ text: piece, verb });
      }
    } else {
      const verb = verbsIn(part);
      if (verb) fragments.push({ text: part, verb });
    }
  }

  return fragments;
}

/** 判断一段文本里是否出现了某个名字（大小写不敏感） */
export function mentionsName(text: string, name: string): boolean {
  if (!text || !name) return false;
  return text.toLowerCase().includes(name.toLowerCase());
}
