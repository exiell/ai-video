import type { CameraMove, CheckIssue, Project, Shot } from '../../types/model';
import { CAMERA_MOVE_LABEL } from '../../types/model';

/**
 * 运镜冲突与跨镜状态变化检查（Phase 2 · 纯本地确定性规则）
 *
 * 1. camera-multi-move-conflict：单镜里塞入多个互相冲突的运镜词（如「推近同时拉远」「左摇又环绕」），
 *    会导致视频模型画面眩晕或抖动；可由 autoFix 机械保留主运镜并清理机位备注里的冲突词。
 * 2. state-delta-undeclared：同场景相邻两镜之间出现明显换装/淋湿/受伤/道具破损等状态变化词，
 *    但未通过 EntityStateDelta 或角色变体（variantIds）显式声明时给出温和提醒，
 *    帮助创作者区分「剧情合理变化」与「意外穿帮」。
 */

interface CameraMovePattern {
  family: string;
  label: string;
  moves: CameraMove[];
  regex: RegExp;
}

const CAMERA_MOVE_PATTERNS: CameraMovePattern[] = [
  { family: 'push', label: '推近', moves: ['push-in'], regex: /推近|推进|缓推|急推|push[\s-]?in|dolly[\s-]?in|zoom[\s-]?in/i },
  { family: 'pull', label: '拉远', moves: ['pull-out'], regex: /拉远|拉出|缓拉|急拉|pull[\s-]?out|dolly[\s-]?out|zoom[\s-]?out/i },
  { family: 'pan-left', label: '左摇', moves: ['pan-left'], regex: /左摇|向左摇|pan[\s-]?left/i },
  { family: 'pan-right', label: '右摇', moves: ['pan-right'], regex: /右摇|向右摇|pan[\s-]?right/i },
  { family: 'tilt-up', label: '上摇', moves: ['tilt-up'], regex: /上摇|向上摇|仰摇|tilt[\s-]?up/i },
  { family: 'tilt-down', label: '下摇', moves: ['tilt-down'], regex: /下摇|向下摇|俯摇|tilt[\s-]?down/i },
  { family: 'orbit', label: '环绕', moves: ['orbit'], regex: /环绕|绕拍|orbit|arc[\s-]?shot/i },
  { family: 'crane-up', label: '升镜', moves: ['crane-up'], regex: /升镜|上升拍摄|crane[\s-]?up|pedestal[\s-]?up/i },
  { family: 'crane-down', label: '降镜', moves: ['crane-down'], regex: /降镜|下降拍摄|crane[\s-]?down|pedestal[\s-]?down/i },
  { family: 'handheld', label: '手持晃动', moves: ['handheld'], regex: /手持晃动|剧烈晃动|handheld[\s-]?shake/i },
];

/** 识别一段文本里提及的不同运镜家族 */
export function detectCameraMoveFamilies(text: string): CameraMovePattern[] {
  if (!text.trim()) return [];
  return CAMERA_MOVE_PATTERNS.filter((p) => p.regex.test(text));
}

/** 供 autoFix 调用：剥离 cameraPosition 中与主运镜冲突的多余运镜词 */
export function stripConflictingCameraMoves(cameraPosition: string, primaryMove: CameraMove): string {
  let cleaned = cameraPosition;
  for (const pattern of CAMERA_MOVE_PATTERNS) {
    if (pattern.moves.includes(primaryMove)) continue;
    cleaned = cleaned.replace(new RegExp(pattern.regex.source, 'gi'), '');
  }
  return cleaned
    .replace(/[，,、;；/\s]{2,}/g, '，')
    .replace(/^[，,、;；/\s]+|[，,、;；/\s]+$/g, '')
    .trim();
}

const STATE_CHANGE_SIGNALS: Array<{ keyword: string; regex: RegExp }> = [
  { keyword: '淋湿/湿透', regex: /淋湿|湿透|浑身湿|落汤鸡|drenched|soaked/i },
  { keyword: '换装/脱衣', regex: /换上|换了衣服|换装|脱下|脱掉|撕破|changed into|took off/i },
  { keyword: '受伤/流血', regex: /流血|鲜血|受伤|包扎|淤青|擦伤|bleeding|injured|bandaged/i },
  { keyword: '道具破损', regex: /碎裂|打碎|摔碎|折断|烧焦|破损|shattered|broken|burned/i },
  { keyword: '污渍/泥泞', regex: /满身泥|沾满泥|泥泞|灰头土脸|muddy|stained/i },
];

function shotVisualText(shot: Shot): string {
  return [shot.startState, shot.action, shot.endState].filter(Boolean).join(' ');
}

export function checkStateAndCamera(project: Project): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const ordered = [...project.shots].sort((a, b) => a.number - b.number);

  // 1. 单镜多运镜冲突检查
  for (const shot of ordered) {
    const combinedText = `${shot.cameraPosition} ${shot.action}`;
    const detected = detectCameraMoveFamilies(combinedText);
    const hasPrimaryInText = detected.some((d) => d.moves.includes(shot.cameraMove));

    // 情况 A：文本本身塞进了 2 种及以上不同运镜
    // 情况 B：主运镜为非固定镜（或固定镜），而机位备注里又写了至少 1 个与主运镜相反/不同的运镜，且总计超过 1 种
    const distinctLabels = new Set<string>(detected.map((d) => d.label));
    if (shot.cameraMove !== 'static' && !hasPrimaryInText && detected.length >= 1) {
      distinctLabels.add(CAMERA_MOVE_LABEL[shot.cameraMove]);
    }

    if (detected.length >= 2 || (shot.cameraMove === 'static' && detected.length >= 1 && /同时|又|并/.test(shot.cameraPosition))) {
      issues.push({
        id: `camera-conflict:${shot.id}`,
        ruleId: 'camera-multi-move-conflict',
        severity: 'warning',
        location: { kind: 'shot', id: shot.id, field: 'cameraPosition' },
        title: `第 ${shot.number} 镜同时出现多种运镜指令（${[...distinctLabels].join('、')}）`,
        why: '主流视频模型（Runway / Kling / Veo / Hailuo）单镜只适合 1 个主导运镜，叠加多个运镜容易导致画面畸变或剧烈眩晕。',
        suggestion: `建议保留主运镜「${CAMERA_MOVE_LABEL[shot.cameraMove]}」，清理机位或动作描述里的多余运镜词。`,
      });
    }
  }

  // 2. 相邻同场景未声明的状态突变检查
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const curr = ordered[i]!;
    if (!curr.sceneId || curr.sceneId !== prev.sceneId) continue;
    if (prev.transitionType === 'cut') continue;

    const prevText = shotVisualText(prev);
    const currText = shotVisualText(curr);

    const newlyAppeared = STATE_CHANGE_SIGNALS.filter(
      (sig) => sig.regex.test(currText) && !sig.regex.test(prevText),
    );
    if (newlyAppeared.length === 0) continue;

    const hasExplicitDelta = (curr.stateDeltas ?? []).length > 0;
    const prevVariants = new Set(prev.variantIds);
    const hasNewVariant = curr.variantIds.some((vid) => !prevVariants.has(vid));

    if (!hasExplicitDelta && !hasNewVariant) {
      const labels = newlyAppeared.map((s) => s.keyword).join('、');
      issues.push({
        id: `state-delta-missing:${curr.id}`,
        ruleId: 'state-delta-undeclared',
        severity: 'warning',
        location: { kind: 'shot', id: curr.id, field: 'stateDeltas' },
        title: `第 ${curr.number} 镜相对上一镜出现「${labels}」变化，但尚未记录状态变更原因`,
        why: '如果不显式登记跨镜状态变化（或切换角色变体），图生视频模式可能忽略这个剧情变化，或者在检查时难以区分是有意剧情还是穿帮。',
        suggestion: '在分镜详情的「跨镜状态变化」里补一条变更记录，或为该角色切换对应变体。',
      });
    }
  }

  return issues;
}
