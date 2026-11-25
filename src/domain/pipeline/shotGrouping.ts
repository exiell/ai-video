import type { Project, Shot, ShotGroup, ShotGroupRenderStrategy } from '../../types/model';
import { CAMERA_MOVE_EN, SHOT_SIZE_EN } from '../../types/model';
import {
  resolveVideoDialect,
  type VideoModelDialect,
} from '../../data/models/videoDialects';

/**
 * 同场次多镜头编组与 Multi-Shot 联合编译（Phase 2）
 *
 * 1. 自动发现同场景内 2–6 个连续对话或承接短镜，编组为 ShotGroup；
 * 2. Kling 3.0 Custom Multi-Shot 支持单次打包最多 6 个镜头、总时长不超过 15 秒；
 * 3. Seedance 2.5 支持单条提示词内按时间戳分段 `[0.0s-3.0s] ...`；
 * 4. 不原生支持多镜头打包的模型（如 Runway / Hailuo / Veo）自动提示改用「尾帧接力」或「逐镜独立渲染」。
 */

const MAX_GROUP_SHOTS = 6;
const KLING_MULTI_SHOT_MAX_SEC = 15;

function shotHasDialogue(shot: Shot): boolean {
  if (shot.audioSpec && shot.audioSpec.mode !== 'silent' && shot.audioSpec.dialogues.length > 0) {
    return true;
  }
  return shot.dialogue.trim().length > 0;
}

function isContinuationPair(prev: Shot, curr: Shot): boolean {
  if (!prev.sceneId || prev.sceneId !== curr.sceneId) return false;
  if (prev.transitionType === 'cut') return false;
  if (prev.transitionType === 'continuation') return true;
  // 同场景内连续对白（正反打对话）适合同组打包，保持人脸、打光和声线稳定
  if (shotHasDialogue(prev) && shotHasDialogue(curr)) return true;
  return false;
}

/**
 * 自动从当前项目分镜中提取建议的多镜头编组（2–6 镜/组，不修改原项目对象）。
 */
export function suggestShotGroups(project: Project): ShotGroup[] {
  const ordered = [...project.shots].sort((a, b) => a.number - b.number);
  const groups: ShotGroup[] = [];
  let bucket: Shot[] = [];

  const flushBucket = (): void => {
    if (bucket.length < 2) {
      bucket = [];
      return;
    }
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    const scene = project.scenes.find((s) => s.id === first.sceneId);
    const hasDialogue = bucket.some(shotHasDialogue);
    const totalDuration = bucket.reduce((sum, s) => sum + s.duration, 0);
    const renderStrategy: ShotGroupRenderStrategy =
      hasDialogue && totalDuration <= KLING_MULTI_SHOT_MAX_SEC
        ? 'native_multi_shot'
        : 'chained_last_frame';

    groups.push({
      id: `grp-${first.sceneId}-${first.number}-${last.number}`,
      sceneId: first.sceneId,
      title: `${scene?.name || '同场次'} · 第 ${first.number}-${last.number} 镜`,
      shotIds: bucket.map((s) => s.id),
      renderStrategy,
      ...(project.brief.styleTags.length > 0
        ? { masterStyleAnchor: project.brief.styleTags.join(', ') }
        : {}),
    });
    bucket = [];
  };

  for (const shot of ordered) {
    if (bucket.length === 0) {
      if (shot.sceneId) bucket.push(shot);
      continue;
    }
    const prev = bucket[bucket.length - 1]!;
    if (bucket.length < MAX_GROUP_SHOTS && isContinuationPair(prev, shot)) {
      bucket.push(shot);
    } else {
      flushBucket();
      if (shot.sceneId) bucket.push(shot);
    }
  }
  flushBucket();
  return groups;
}

export interface CompiledShotGroupPrompt {
  ok: boolean;
  dialect: VideoModelDialect;
  strategy: ShotGroupRenderStrategy;
  totalDurationSec: number;
  shotCount: number;
  prompt: string;
  warnings: string[];
}

function formatDialogueSnippet(shot: Shot, project: Project, dialect: VideoModelDialect): string {
  if (!dialect.supportsNativeAudio) return '';
  if (shot.audioSpec) {
    if (shot.audioSpec.mode === 'silent') return '';
    return shot.audioSpec.dialogues
      .map((line) => {
        const speaker = line.speakerLabel || 'Speaker';
        const tone = line.emotionTone ? `(${line.emotionTone})` : '';
        if (dialect.dialogueFormat === 'kling_speaker_bracket') {
          return `[${speaker}${tone}]: "${line.text}"`;
        }
        return `${speaker}${tone}: "${line.text}"`;
      })
      .join(' ');
  }
  const line = shot.dialogue.trim();
  if (!line) return '';
  const firstChar = project.characters.find((c) => shot.characterIds.includes(c.id));
  const speaker = firstChar?.name || 'Speaker';
  if (dialect.dialogueFormat === 'kling_speaker_bracket') {
    return `[${speaker}]: "${line}"`;
  }
  return `speaking: "${line}"`;
}

/**
 * 将一个 ShotGroup 编译为面向目标方言的多镜头联合提示词（或尾帧接力指引）。
 */
export function compileShotGroupPrompt(
  project: Project,
  group: ShotGroup,
  dialectIdOrPlatform: string,
): CompiledShotGroupPrompt {
  const dialect = resolveVideoDialect(dialectIdOrPlatform);
  const warnings: string[] = [];
  const shots = group.shotIds
    .map((id) => project.shots.find((s) => s.id === id))
    .filter((s): s is Shot => Boolean(s));

  if (shots.length === 0) {
    return {
      ok: false,
      dialect,
      strategy: group.renderStrategy,
      totalDurationSec: 0,
      shotCount: 0,
      prompt: '',
      warnings: ['当前编组内没有有效分镜。'],
    };
  }

  const totalDurationSec = shots.reduce((sum, s) => sum + s.duration, 0);
  const maxMulti = dialect.multiShotMaxShots ?? 0;

  let effectiveStrategy = group.renderStrategy;
  if (group.renderStrategy === 'native_multi_shot' && !dialect.supportsMultiShot) {
    warnings.push(
      `${dialect.label} 不支持原生多镜头打包（Multi-Shot），已自动降级为「尾帧接力连续生成」方案。`,
    );
    effectiveStrategy = 'chained_last_frame';
  }
  if (
    effectiveStrategy === 'native_multi_shot' &&
    maxMulti > 0 &&
    shots.length > maxMulti
  ) {
    warnings.push(
      `${dialect.label} 单次多镜头打包上限为 ${maxMulti} 镜，当前编组包含 ${shots.length} 镜，建议拆分为两组。`,
    );
  }
  const maxTotalSec = dialect.multiShotMaxTotalSec ?? KLING_MULTI_SHOT_MAX_SEC;
  if (
    dialect.dialectId === 'kling_3' &&
    effectiveStrategy === 'native_multi_shot' &&
    totalDurationSec > maxTotalSec
  ) {
    warnings.push(
      `Kling 3.0 原生多镜头单次总时长建议不超过 ${maxTotalSec} 秒（当前 ${totalDurationSec} 秒），请拆组或缩短单镜时长。`,
    );
  }

  const scene = project.scenes.find((s) => s.id === group.sceneId);
  const masterAnchor =
    group.masterStyleAnchor?.trim() || project.brief.styleTags.join(', ');
  const suppressSubtitles = shots.some(
    (s) => s.audioSpec?.suppressEmbeddedSubtitles !== false,
  );

  let cursor = 0;
  const segments = shots.map((shot, idx) => {
    const start = cursor;
    const end = cursor + shot.duration;
    cursor = end;
    const sizeEn = SHOT_SIZE_EN[shot.shotSize];
    const moveEn = CAMERA_MOVE_EN[shot.cameraMove];
    const dialogue = formatDialogueSnippet(shot, project, dialect);
    const body = [
      `${sizeEn}, ${moveEn}`,
      shot.action.trim() || shot.startState.trim(),
      dialogue,
    ]
      .filter(Boolean)
      .join('. ');

    if (dialect.dialectId === 'seedance_2_5') {
      return `[${start.toFixed(1)}s-${end.toFixed(1)}s] ${body}`;
    }
    return `Shot ${idx + 1} (${start}s-${end}s): ${body}`;
  });

  const headerParts = [
    effectiveStrategy === 'native_multi_shot'
      ? `Multi-Shot Sequence (${shots.length} shots, ${totalDurationSec}s total)`
      : `Chained Last-Frame Sequence (${shots.length} shots, ${totalDurationSec}s total)`,
    scene ? `Scene: ${scene.identity.summaryEn || scene.name}` : '',
    masterAnchor ? `Style lock: ${masterAnchor}` : '',
  ].filter(Boolean);

  const footer =
    suppressSubtitles && dialect.supportsNativeAudio ? 'No subtitles.' : '';

  const prompt = [headerParts.join(' | '), ...segments, footer]
    .filter(Boolean)
    .join('\n');

  return {
    ok: true,
    dialect,
    strategy: effectiveStrategy,
    totalDurationSec,
    shotCount: shots.length,
    prompt,
    warnings,
  };
}
