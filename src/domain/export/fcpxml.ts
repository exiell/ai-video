import type { Project } from '../../types/model';
import { CAMERA_MOVE_LABEL, SHOT_SIZE_LABEL } from '../../types/model';
import type { NleExportOptions } from './otio';

/**
 * 纯 TypeScript Final Cut Pro / DaVinci Resolve FCPXML v1.10 导出器（Phase 3）
 *
 * 严格遵循 FCPXML 1.10 规范，使用有理数帧时长（如 90/30s）与完整 XML 实体转义，
 * 可直接导入 Final Cut Pro、DaVinci Resolve 与支持 FCPXML 的非线性剪辑软件。
 */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function resolveResolution(aspectRatio: string): { width: number; height: number } {
  const norm = aspectRatio.trim();
  if (norm === '9:16') return { width: 1080, height: 1920 };
  if (norm === '1:1') return { width: 1080, height: 1080 };
  if (norm === '3:4') return { width: 1080, height: 1440 };
  if (norm === '4:3') return { width: 1440, height: 1080 };
  return { width: 1920, height: 1080 };
}

function toFileUri(path: string): string {
  if (/^file:\/\//i.test(path) || /^https?:\/\//i.test(path)) return path;
  const forward = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(forward)) return `file:///${encodeURI(forward)}`;
  return `file://./${encodeURI(forward)}`;
}

export function exportToFcpxml(project: Project, options: NleExportOptions = {}): string {
  const fps = options.fps ?? 30;
  const ordered = [...project.shots].sort((a, b) => a.number - b.number);
  const clipPaths = options.clipPathsByShotId ?? {};
  const { width, height } = resolveResolution(project.brief.aspectRatio || '16:9');

  let totalFrames = 0;
  const assetLines: string[] = [];
  const spineLines: string[] = [];

  for (let i = 0; i < ordered.length; i += 1) {
    const shot = ordered[i]!;
    const durationSec = Number.isFinite(shot.duration) && shot.duration > 0 ? shot.duration : 3;
    const frames = Math.max(1, Math.round(durationSec * fps));
    const offsetFrames = totalFrames;
    totalFrames += frames;

    const refId = `r${i + 2}`;
    const scene = project.scenes.find((s) => s.id === shot.sceneId);
    const clipName = `Shot ${String(shot.number).padStart(2, '0')}${scene ? ` - ${scene.name}` : ''}`;
    const rawPath = clipPaths[shot.id] ?? `media/shot_${String(shot.number).padStart(2, '0')}.mp4`;
    const srcUri = toFileUri(rawPath);

    assetLines.push(
      `    <asset id="${refId}" name="${escapeXml(clipName)}" start="0/${fps}s" duration="${frames}/${fps}s" hasVideo="1" hasAudio="1" format="r1">`,
      `      <media-rep kind="original-media" src="${escapeXml(srcUri)}"/>`,
      `    </asset>`,
    );

    const noteParts = [
      `${SHOT_SIZE_LABEL[shot.shotSize]} / ${CAMERA_MOVE_LABEL[shot.cameraMove]}`,
      shot.action.trim(),
      shot.dialogue.trim() ? `台词：${shot.dialogue.trim()}` : '',
    ].filter(Boolean);

    spineLines.push(
      `          <asset-clip ref="${refId}" offset="${offsetFrames}/${fps}s" name="${escapeXml(clipName)}" duration="${frames}/${fps}s" start="0/${fps}s" format="r1">`,
      `            <marker start="0/${fps}s" duration="1/${fps}s" value="${escapeXml(noteParts.join(' | ').slice(0, 140))}"/>`,
      `          </asset-clip>`,
    );
  }

  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE fcpxml>`,
    `<fcpxml version="1.10">`,
    `  <resources>`,
    `    <format id="r1" name="FFVideoFormat${height}p${fps}" frameDuration="1/${fps}s" width="${width}" height="${height}"/>`,
    ...assetLines,
    `  </resources>`,
    `  <library>`,
    `    <event name="${escapeXml(project.name)}">`,
    `      <project name="${escapeXml(project.name)}">`,
    `        <sequence format="r1" duration="${totalFrames}/${fps}s" tcStart="0s" tcFormat="NDF">`,
    `          <spine>`,
    ...spineLines,
    `          </spine>`,
    `        </sequence>`,
    `      </project>`,
    `    </event>`,
    `  </library>`,
    `</fcpxml>`,
    ``,
  ];

  return lines.join('\n');
}
