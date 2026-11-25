import type { Project, Shot } from '../../types/model';

/**
 * 标准 UTF-8 SRT 字幕轨导出（Phase 3）
 *
 * 与原生无字幕视频配合使用：画面不烤死乱码文字，字幕通过标准 .srt 进剪辑软件自由排版。
 */

function formatSrtTime(totalSec: number): string {
  const msTotal = Math.max(0, Math.round(totalSec * 1000));
  const ms = msTotal % 1000;
  const sTotal = Math.floor(msTotal / 1000);
  const s = sTotal % 60;
  const mTotal = Math.floor(sTotal / 60);
  const m = mTotal % 60;
  const h = Math.floor(mTotal / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export interface SubtitleCue {
  index: number;
  shotId: string;
  shotNumber: number;
  startSec: number;
  endSec: number;
  speaker?: string;
  text: string;
}

export function collectSubtitleCues(project: Project): SubtitleCue[] {
  const ordered: Shot[] = [...project.shots].sort((a, b) => a.number - b.number);
  const cues: SubtitleCue[] = [];
  let cursor = 0;

  for (const shot of ordered) {
    const dur = Number.isFinite(shot.duration) && shot.duration > 0 ? shot.duration : 3;
    const shotStart = cursor;
    const shotEnd = cursor + dur;
    cursor = shotEnd;

    if (shot.audioSpec) {
      if (shot.audioSpec.mode === 'silent') continue;
      const lines = shot.audioSpec.dialogues.filter((d) => d.text.trim().length > 0);
      if (lines.length > 0) {
        const sliceDur = dur / lines.length;
        lines.forEach((line, idx) => {
          const start =
            line.startOffsetSec !== undefined ? shotStart + line.startOffsetSec : shotStart + idx * sliceDur;
          const end =
            line.endOffsetSec !== undefined
              ? shotStart + line.endOffsetSec
              : Math.min(shotEnd, start + sliceDur);
          cues.push({
            index: cues.length + 1,
            shotId: shot.id,
            shotNumber: shot.number,
            startSec: start,
            endSec: Math.max(start + 0.3, end),
            speaker: line.speakerLabel,
            text: line.text.trim(),
          });
        });
        continue;
      }
    }

    const fallbackText = (shot.dialogue || shot.narrationText || '').trim();
    if (fallbackText) {
      cues.push({
        index: cues.length + 1,
        shotId: shot.id,
        shotNumber: shot.number,
        startSec: shotStart,
        endSec: shotEnd,
        text: fallbackText,
      });
    }
  }

  return cues;
}

export function exportToSrt(project: Project, options: { includeSpeakerPrefix?: boolean } = {}): string {
  const cues = collectSubtitleCues(project);
  if (cues.length === 0) return '';
  return (
    cues
      .map((cue) => {
        const line =
          options.includeSpeakerPrefix && cue.speaker
            ? `${cue.speaker}：${cue.text}`
            : cue.text;
        return `${cue.index}\r\n${formatSrtTime(cue.startSec)} --> ${formatSrtTime(cue.endSec)}\r\n${line}`;
      })
      .join('\r\n\r\n') + '\r\n'
  );
}
