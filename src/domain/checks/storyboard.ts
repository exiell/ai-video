import type { CheckIssue, Project, Shot } from '../../types/model';
import { PLATFORM_LABEL } from '../../types/model';
import { findActionFragments, makeIssue, shotLabel } from './shared';

/**
 * 分镜结构与时长检查（方案.md v0.6 §3.2）
 *
 * 覆盖规则：
 *  - shot-incomplete           必填字段没填
 *  - multi-action              一镜里塞了多个动作
 *  - duration-total            总时长与目标对不上
 *  - duration-mismatch         单镜时长为非法值
 *  - story-scene-uncovered     剧本里的场次没有任何镜头承载
 *  - offscreen-not-declared    画面里提到了不在场的人，但没声明「画外」
 *  - prompt-incomplete         提示词缺关键信息
 */

/** 各视频平台的单镜时长上限（秒）。用于提示新手不要超过平台限制。 */
const PLATFORM_MAX_DURATION: Record<string, number> = {
  jimeng: 12,
  kling: 10,
  seedance: 15,
  runway: 10,
  sora: 20,
  veo: 8,
};

interface RequiredField {
  key: keyof Shot;
  label: string;
  why: string;
  suggestion: string;
}

const REQUIRED_FIELDS: RequiredField[] = [
  {
    key: 'startState',
    label: '起点',
    why: '起点是这一镜的第一格画面。不写清楚，模型会自己决定开场画面，很可能和上一镜接不上。',
    suggestion: '写「镜头开始时能看见什么」：人物在哪、朝向、手里有什么、周围有什么。只写这一瞬间看得见的东西。',
  },
  {
    key: 'action',
    label: '唯一动作',
    why: '这一镜从头到尾只应该发生一件事。没有动作，画面就是静止的；动作不明确，生成出来会乱动。',
    suggestion: '用一句话写清楚「谁做了什么」，只写一件事。',
  },
  {
    key: 'endState',
    label: '终点',
    why: '终点是这一镜的最后一格画面，也是下一镜的接续点。不写，剪辑时会接不上。',
    suggestion: '写「镜头结束时画面停在哪」：人物停在哪、手在哪、画面中心是谁。',
  },
];

export function checkStoryboard(project: Project): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const { shots, brief } = project;

  // ---- 必填字段 ----
  for (const shot of shots) {
    const label = shotLabel(shot.number);
    for (const field of REQUIRED_FIELDS) {
      const value = shot[field.key];
      const isEmpty = typeof value === 'string' && value.trim() === '';
      if (!isEmpty) continue;
      issues.push(
        makeIssue({
          ruleId: 'shot-incomplete',
          severity: 'error',
          title: `${label}的「${field.label}」还是空的`,
          why: field.why,
          suggestion: field.suggestion,
          location: { kind: 'shot', id: shot.id, field: field.key as string },
        }),
      );
    }

    // ---- 一镜一动作 ----
    const fragments = findActionFragments(shot.action);
    if (fragments.length > 1) {
      issues.push(
        makeIssue({
          ruleId: 'multi-action',
          severity: 'warning',
          title: `${label}里疑似塞了 ${fragments.length} 个动作`,
          why: `检测到：${fragments.map((f) => `「${f.text}」`).join('、')}。一镜多动作是新手最常踩的坑——模型在几秒内无法完成两个动作，结果通常是两个都做不好，或者画面直接崩。`,
          suggestion: `把这一镜拆成 ${fragments.length} 个镜头，每个镜头只做一件事。拆完之后每一镜各自写清起点、动作、终点。`,
          location: { kind: 'shot', id: shot.id, field: 'action' },
        }),
      );
    }

    // ---- 单镜时长合法性 ----
    if (!Number.isFinite(shot.duration) || shot.duration <= 0) {
      issues.push(
        makeIssue({
          ruleId: 'duration-mismatch',
          severity: 'error',
          title: `${label}的时长不是有效数字`,
          why: '时长必须是一个大于 0 的数字（秒）。',
          suggestion: `给第 ${shot.number} 镜填一个时长，建议 2–5 秒。`,
          location: { kind: 'shot', id: shot.id, field: 'duration' },
        }),
      );
    } else {
      const max = Math.max(...brief.platforms.map((p) => PLATFORM_MAX_DURATION[p] ?? 10), 10);
      if (shot.duration > max) {
        const platformNames = brief.platforms.map((p) => PLATFORM_LABEL[p]).join(' / ');
        issues.push(
          makeIssue({
            ruleId: 'duration-mismatch',
            severity: 'info',
            title: `${label}的 ${shot.duration} 秒超过了平台单镜上限`,
            why: `你选的平台（${platformNames}）单次生成最长约 ${max} 秒。超过的部分生成不出来，或者会被平台自动截断。`,
            suggestion: `把第 ${shot.number} 镜缩短到 ${max} 秒以内，拆成两镜；或者保留，到时候在平台里分段生成再拼。`,
            location: { kind: 'shot', id: shot.id, field: 'duration' },
          }),
        );
      }
    }

    // ---- 画外人物声明 ----
    for (const name of shot.offscreenCharacters) {
      const text = [shot.startState, shot.action, shot.endState].join(' ');
      if (!text.includes(name)) {
        issues.push(
          makeIssue({
            ruleId: 'offscreen-not-declared',
            severity: 'info',
            title: `${label}声明了画外人物「${name}」，但画面描述里没提到他`,
            why: '如果这个人确实只在声音里出现（比如画外音），那没问题；如果他其实该出现在画面里，那就是漏写了。',
            suggestion: `确认一下：只在声音里 → 保持现状；该出现在画面里 → 把他写进起点或画面描述，并勾选他的连续性锁。`,
            location: { kind: 'shot', id: shot.id, field: 'offscreenCharacters' },
          }),
        );
      }
    }
  }

  // ---- 总时长 ----
  const total = shots.reduce((sum, s) => sum + (Number.isFinite(s.duration) ? s.duration : 0), 0);
  const target = brief.targetDuration;
  if (target > 0 && shots.length > 0) {
    const diff = total - target;
    const tolerance = Math.max(target * 0.1, 2);
    if (Math.abs(diff) > tolerance) {
      const over = diff > 0;
      issues.push(
        makeIssue({
          ruleId: 'duration-total',
          severity: 'warning',
          title: over
            ? `总时长超了 ${Math.round(diff)} 秒`
            : `总时长还差 ${Math.round(-diff)} 秒`,
          why: `你设定的目标是 ${target} 秒，现在 ${shots.length} 个镜头加起来是 ${total} 秒。${
            over
              ? '超出的部分如果不删，成片就比你计划的更长了。'
              : '不够的部分如果不补，成片会比计划的短，可能撑不起你想讲的内容。'
          }`,
          suggestion: over
            ? `找一个 ${Math.round(diff)} 秒左右的镜头删掉或缩短；也可以把几个慢镜头各减 1 秒。分镜表里时长是实时统计的，改完就能看到。`
            : `再加 ${Math.round(-diff)} 秒的内容：给关键情绪补一个反应镜头，或者把某个镜头延长 1–2 秒。`,
          location: { kind: 'project', id: project.id, field: 'brief.targetDuration' },
        }),
      );
    }
  }

  // ---- 剧本场次覆盖 ----
  const coveredSceneIds = new Set(shots.map((s) => s.sourceSceneId).filter(Boolean));
  for (const storyScene of project.story.scenes) {
    if (coveredSceneIds.has(storyScene.id)) continue;
    issues.push(
      makeIssue({
        ruleId: 'story-scene-uncovered',
        severity: 'warning',
        title: `剧本里的「${storyScene.label}」没有任何镜头承载`,
        why: '这场戏在你写的故事里存在，但分镜里没有任何一个镜头在拍它。要么是漏了，要么是你决定不拍。',
        suggestion: `如果是漏了 → 补几个镜头。如果决定不拍 → 在分镜表里为这一场写一行「未拍场次：${storyScene.label}（理由：……）」，把决定记下来，将来回看才不会以为是漏了。`,
        location: { kind: 'story', id: storyScene.id },
      }),
    );
  }

  // ---- 提示词完整性 ----
  for (const shot of shots) {
    const missing: string[] = [];
    if (!shot.cameraMove) missing.push('运镜');
    if (!shot.shotSize) missing.push('景别');
    if (brief.styleTags.length === 0) missing.push('风格词');
    if (!brief.aspectRatio) missing.push('画幅');
    if (missing.length === 0) continue;
    issues.push(
      makeIssue({
        ruleId: 'prompt-incomplete',
        severity: 'warning',
        title: `${shotLabel(shot.number)}的提示词缺少：${missing.join('、')}`,
        why: '这会让模型自己决定这些部分。缺画幅可能给你出成横屏，缺风格词可能出成写实风而不是动漫风。',
        suggestion:
          missing.includes('画幅') || missing.includes('风格词')
            ? '去项目设置里补上画幅和风格关键词，它们会注入到每一镜的提示词里。'
            : `给第 ${shot.number} 镜补上${missing.join('、')}。`,
        location: { kind: 'shot', id: shot.id },
      }),
    );
  }

  return issues;
}

export { PLATFORM_MAX_DURATION };
