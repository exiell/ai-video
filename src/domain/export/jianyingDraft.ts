import type { Project } from '../../types/model';
import { collectSubtitleCues } from './srt';
import type { NleExportOptions } from './otio';

/**
 * 纯 TypeScript 剪映 / CapCut 草稿工程导出器（Phase 3）
 *
 * 输出符合剪映草稿核心结构（微秒级时间轴：1 秒 = 1,000,000 微秒）的
 * `draft_content.json` 与 `draft_meta_info.json`，包含：
 * - 画布分辨率配置（自动适配 9:16 / 16:9 / 1:1）
 * - 主视频轨（关联已落盘本地视频路径或相对占位文件名）
 * - 文字字幕轨（由结构化对白/旁白自动对齐时间轴）
 */

const US_PER_SEC = 1_000_000;

function resolveCanvas(aspectRatio: string): { width: number; height: number; ratio: string } {
  const norm = aspectRatio.trim();
  if (norm === '9:16') return { width: 1080, height: 1920, ratio: '9:16' };
  if (norm === '1:1') return { width: 1080, height: 1080, ratio: '1:1' };
  if (norm === '3:4') return { width: 1080, height: 1440, ratio: '3:4' };
  if (norm === '4:3') return { width: 1440, height: 1080, ratio: '4:3' };
  return { width: 1920, height: 1080, ratio: '16:9' };
}

export interface JianyingDraftBundle {
  draftContentJson: string;
  draftMetaInfoJson: string;
  totalDurationUs: number;
  videoSegmentCount: number;
  textSegmentCount: number;
}

export function exportToJianyingDraft(
  project: Project,
  options: NleExportOptions = {},
): JianyingDraftBundle {
  const fps = options.fps ?? 30;
  const ordered = [...project.shots].sort((a, b) => a.number - b.number);
  const clipPaths = options.clipPathsByShotId ?? {};
  const canvas = resolveCanvas(project.brief.aspectRatio || '16:9');
  const nowUs = Date.now() * 1000;

  const videoMaterials: Record<string, unknown>[] = [];
  const videoSegments: Record<string, unknown>[] = [];
  let cursorUs = 0;

  for (const shot of ordered) {
    const durationSec = Number.isFinite(shot.duration) && shot.duration > 0 ? shot.duration : 3;
    const durationUs = Math.round(durationSec * US_PER_SEC);
    const matId = `mat-video-${shot.id}`;
    const segId = `seg-video-${shot.id}`;
    const path = clipPaths[shot.id] ?? `media/shot_${String(shot.number).padStart(2, '0')}.mp4`;

    videoMaterials.push({
      id: matId,
      type: 'video',
      material_name: `Shot_${String(shot.number).padStart(2, '0')}.mp4`,
      path,
      duration: durationUs,
      width: canvas.width,
      height: canvas.height,
      category_name: 'local',
    });

    videoSegments.push({
      id: segId,
      material_id: matId,
      target_timerange: { start: cursorUs, duration: durationUs },
      source_timerange: { start: 0, duration: durationUs },
      speed: 1.0,
      volume: 1.0,
      visible: true,
    });

    cursorUs += durationUs;
  }

  const cues = collectSubtitleCues(project);
  const textMaterials: Record<string, unknown>[] = [];
  const textSegments: Record<string, unknown>[] = [];

  for (const cue of cues) {
    const matId = `mat-text-${cue.index}`;
    const segId = `seg-text-${cue.index}`;
    const startUs = Math.round(cue.startSec * US_PER_SEC);
    const durUs = Math.max(300_000, Math.round((cue.endSec - cue.startSec) * US_PER_SEC));

    textMaterials.push({
      id: matId,
      type: 'subtitle',
      content: JSON.stringify({
        text: cue.text,
        styles: [{ fill: { content: { solid: { color: [1, 1, 1] } } }, size: 8.0 }],
      }),
      font_size: 8.0,
    });

    textSegments.push({
      id: segId,
      material_id: matId,
      target_timerange: { start: startUs, duration: durUs },
      visible: true,
    });
  }

  const tracks: Record<string, unknown>[] = [
    {
      id: 'track-video-main',
      type: 'video',
      attribute: 0,
      flag: 0,
      segments: videoSegments,
    },
  ];
  if (textSegments.length > 0) {
    tracks.push({
      id: 'track-text-subtitles',
      type: 'text',
      attribute: 0,
      flag: 0,
      segments: textSegments,
    });
  }

  const draftContent = {
    id: `aniguide-draft-${project.id}`,
    name: project.name,
    version: 360000,
    fps,
    duration: cursorUs,
    canvas_config: {
      width: canvas.width,
      height: canvas.height,
      ratio: canvas.ratio,
    },
    materials: {
      videos: videoMaterials,
      audios: [],
      texts: textMaterials,
    },
    tracks,
  };

  const draftMetaInfo = {
    draft_id: `aniguide-draft-${project.id}`,
    draft_name: project.name,
    tm_draft_create: nowUs,
    tm_draft_modified: nowUs,
    tm_duration: cursorUs,
    draft_removable_storage_device: '',
  };

  return {
    draftContentJson: JSON.stringify(draftContent, null, 2),
    draftMetaInfoJson: JSON.stringify(draftMetaInfo, null, 2),
    totalDurationUs: cursorUs,
    videoSegmentCount: videoSegments.length,
    textSegmentCount: textSegments.length,
  };
}
