import type { Project, Shot } from '../../types/model';
import { CAMERA_MOVE_LABEL, SHOT_SIZE_LABEL } from '../../types/model';

/**
 * 纯 TypeScript OpenTimelineIO (.otio) 导出器（Phase 3）
 *
 * 零 Python 依赖，直接生成符合 OpenTimelineIO Timeline.1 规范的 JSON 文件，
 * 可导入 DaVinci Resolve、Premiere Pro（OTIO 插件）、Blender VSE、Nuke 等专业后期工具。
 */

export interface NleExportOptions {
  /** 帧率，默认 30 fps */
  fps?: number;
  /** 可选：各镜头已落盘的本地视频绝对路径（Electron 自动缓存路径） */
  clipPathsByShotId?: Record<string, string>;
}

interface OtioRationalTime {
  OTIO_SCHEMA: 'RationalTime.1';
  rate: number;
  value: number;
}

interface OtioTimeRange {
  OTIO_SCHEMA: 'TimeRange.1';
  start_time: OtioRationalTime;
  duration: OtioRationalTime;
}

function rt(value: number, rate: number): OtioRationalTime {
  return { OTIO_SCHEMA: 'RationalTime.1', rate, value };
}

function tr(startFrames: number, durationFrames: number, rate: number): OtioTimeRange {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: rt(startFrames, rate),
    duration: rt(durationFrames, rate),
  };
}

function normalizePathToFileUrl(path: string): string {
  if (/^file:\/\//i.test(path) || /^https?:\/\//i.test(path)) return path;
  const forward = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(forward)) return `file:///${encodeURI(forward)}`;
  return forward;
}

function buildShotMarkers(shot: Shot, fps: number): Record<string, unknown>[] {
  const markers: Record<string, unknown>[] = [];
  const summaryParts = [
    `${SHOT_SIZE_LABEL[shot.shotSize]} / ${CAMERA_MOVE_LABEL[shot.cameraMove]}`,
    shot.action.trim(),
  ].filter(Boolean);

  if (summaryParts.length > 0) {
    markers.push({
      OTIO_SCHEMA: 'Marker.2',
      name: `第 ${shot.number} 镜：${summaryParts.join(' · ').slice(0, 80)}`,
      color: 'CYAN',
      marked_range: tr(0, 1, fps),
      metadata: {
        aniguide: {
          shotId: shot.id,
          shotSize: shot.shotSize,
          cameraMove: shot.cameraMove,
          ...(shot.stateDeltas && shot.stateDeltas.length > 0
            ? { stateDeltas: shot.stateDeltas }
            : {}),
        },
      },
    });
  }

  if (shot.stateDeltas && shot.stateDeltas.length > 0) {
    markers.push({
      OTIO_SCHEMA: 'Marker.2',
      name: `状态变化：${shot.stateDeltas.map((d) => d.reason || '剧情变更').join('；')}`,
      color: 'ORANGE',
      marked_range: tr(0, 1, fps),
      metadata: {},
    });
  }

  return markers;
}

export function buildOtioTimeline(
  project: Project,
  options: NleExportOptions = {},
): Record<string, unknown> {
  const fps = options.fps ?? 30;
  const ordered = [...project.shots].sort((a, b) => a.number - b.number);
  const clipPaths = options.clipPathsByShotId ?? {};

  const videoChildren: Record<string, unknown>[] = [];
  const audioChildren: Record<string, unknown>[] = [];

  for (const shot of ordered) {
    const durationSec = Number.isFinite(shot.duration) && shot.duration > 0 ? shot.duration : 3;
    const durationFrames = Math.max(1, Math.round(durationSec * fps));
    const scene = project.scenes.find((s) => s.id === shot.sceneId);
    const clipName = `Shot_${String(shot.number).padStart(2, '0')}${scene ? `_${scene.name}` : ''}`;
    const rawPath = clipPaths[shot.id] ?? `media/shot_${String(shot.number).padStart(2, '0')}.mp4`;
    const targetUrl = normalizePathToFileUrl(rawPath);

    videoChildren.push({
      OTIO_SCHEMA: 'Clip.1',
      name: clipName,
      source_range: tr(0, durationFrames, fps),
      media_reference: {
        OTIO_SCHEMA: 'ExternalReference.1',
        name: clipName,
        target_url: targetUrl,
        available_range: tr(0, durationFrames, fps),
        metadata: {},
      },
      markers: buildShotMarkers(shot, fps),
      metadata: {
        aniguide: {
          shotId: shot.id,
          number: shot.number,
          durationSec,
          renderEngine: shot.renderEngine ?? 'ai_video',
        },
      },
    });

    const dialogueText =
      shot.audioSpec && shot.audioSpec.mode !== 'silent' && shot.audioSpec.dialogues.length > 0
        ? shot.audioSpec.dialogues.map((d) => `${d.speakerLabel}: ${d.text}`).join(' / ')
        : (shot.dialogue || shot.narrationText || '').trim();

    if (dialogueText) {
      audioChildren.push({
        OTIO_SCHEMA: 'Clip.1',
        name: `VO_Shot_${String(shot.number).padStart(2, '0')}`,
        source_range: tr(0, durationFrames, fps),
        media_reference: {
          OTIO_SCHEMA: 'MissingReference.1',
          name: dialogueText.slice(0, 60),
          metadata: { text: dialogueText },
        },
        markers: [],
        metadata: { dialogue: dialogueText },
      });
    } else {
      audioChildren.push({
        OTIO_SCHEMA: 'Gap.1',
        name: `Gap_${String(shot.number).padStart(2, '0')}`,
        source_range: tr(0, durationFrames, fps),
        metadata: {},
      });
    }
  }

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: project.name,
    global_start_time: rt(0, fps),
    metadata: {
      aniguide: {
        projectId: project.id,
        aspectRatio: project.brief.aspectRatio || '16:9',
        exportedAt: new Date().toISOString(),
      },
    },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'V1_Video',
          kind: 'Video',
          children: videoChildren,
          metadata: {},
        },
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'A1_Dialogue',
          kind: 'Audio',
          children: audioChildren,
          metadata: {},
        },
      ],
      metadata: {},
    },
  };
}

export function exportToOtioJson(project: Project, options: NleExportOptions = {}): string {
  return JSON.stringify(buildOtioTimeline(project, options), null, 2);
}
