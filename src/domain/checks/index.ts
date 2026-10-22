import type { CheckIssue, CheckReport, CheckSeverity, Project } from '../../types/model';
import { checkCharacters } from './characters';
import { checkScenes } from './scenes';
import { checkStoryboard } from './storyboard';
import { checkContinuity } from './continuity';

/**
 * 穿帮检查引擎总入口（方案.md v0.6 §3.2 / §7.2 任务 5）
 *
 * 本模块**不调用任何模型**，纯本地逻辑，零成本，可反复运行。
 * 它的价值不是给用户打分，而是把「哪些必须保持一致」写成可核对的事实，
 * 让穿帮在出图之前就被看出来。
 *
 * 边界诚实：这些都是文本约束。生成模型仍可能出错，
 * 本引擎不承诺零穿帮，只承诺「该一致的地方有没有写下来」。
 */

const SEVERITY_ORDER: Record<CheckSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * 严重度的显示名与配色（v0.48 从 ChecksPage 提到这里）。
 *
 * 提到领域层的原因：分镜页现在也要就地标出每一处问题，
 * 两个页面各写一份「必须修/建议修/看一眼」，措辞迟早会分叉——
 * 同一个规则在检查页叫「必须修」、在分镜页叫「必须改」，用户会以为是两件事。
 */
export const SEVERITY_LABEL: Record<CheckSeverity, string> = {
  error: '必须修',
  warning: '建议修',
  info: '看一眼',
};

/** 严重度对应的 tag 样式类 */
export const SEVERITY_TAG: Record<CheckSeverity, string> = {
  error: 'tag tag-error',
  warning: 'tag tag-warning',
  info: 'tag tag-info',
};

/**
 * 一组问题里最严重的那一档。
 *
 * 为空的传入返回 null 而不是兜底成 info——调用方借此区分
 * 「没有问题」与「只有可以看一眼的」，前者不该显示出任何标记。
 */
export function worstSeverity(issues: CheckIssue[]): CheckSeverity | null {
  let worst: CheckSeverity | null = null;
  for (const issue of issues) {
    if (worst === null || SEVERITY_ORDER[issue.severity] < SEVERITY_ORDER[worst]) {
      worst = issue.severity;
    }
  }
  return worst;
}

/** 各规则的显示名，用于分组与统计 */
export const RULE_LABEL: Record<string, string> = {
  'character-not-registered': '角色未登记',
  'character-unlocked-feature': '高显著特征未加锁',
  'character-missing-lock': '连续性锁缺失',
  'variant-not-owned': '变体归属',
  'scene-not-registered': '场景未登记',
  'scene-missing-elements': '场景固定元素缺失',
  'scene-missing-space': '场景空间结构缺失',
  'scene-light-conflict': '场景光线冲突',
  'scene-color-drift': '场景色调漂移',
  'duration-mismatch': '单镜时长异常',
  'duration-total': '总时长不符',
  'offscreen-not-declared': '画外人物声明',
  'story-scene-uncovered': '场次未覆盖',
  'shot-incomplete': '分镜字段缺失',
  'multi-action': '一镜多动作',
  'prompt-incomplete': '提示词不完整',
  'continuity-missing-note': '未写衔接',
  'continuity-location-jump': '地点跳跃',
  'continuity-state-conflict': '状态对不上',
  'continuity-large-motion': '单镜位移过大',
  'continuity-light-mismatch': '光线方向冲突',
  'continuity-long-chain': '承接链偏长',
  'continuity-untyped-transition': '未标转场类型',
  'adjacent-same-shot-size': '相邻镜同景别',
  'pronoun-in-visual': '提示词里用了代词',
  'abstract-emotion': '情绪写成抽象词',
};

export function runChecks(project: Project): CheckReport {
  const issues: CheckIssue[] = [
    ...checkCharacters(project),
    ...checkScenes(project),
    ...checkStoryboard(project),
    ...checkContinuity(project),
  ];

  issues.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.ruleId.localeCompare(b.ruleId);
  });

  const counts: Record<CheckSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] += 1;

  return {
    issues,
    checkedAt: new Date().toISOString(),
    counts,
  };
}

/** 一句话总结，用于界面顶部 */
export function summarizeReport(report: CheckReport): string {
  const { error, warning, info } = report.counts;
  if (error === 0 && warning === 0 && info === 0) {
    return '没有发现问题。可以开始生成画面了。';
  }
  const parts: string[] = [];
  if (error > 0) parts.push(`${error} 个必须修的`);
  if (warning > 0) parts.push(`${warning} 个建议修的`);
  if (info > 0) parts.push(`${info} 个可以看一眼的`);
  return `发现 ${parts.join('、')}。`;
}

export { checkCharacters, checkScenes, checkStoryboard, checkContinuity };
