import type { Asset, Project, Shot } from '../../types/model';
import { SHOT_SIZE_LABEL } from '../../types/model';

/**
 * 分镜总览联系表拼图（Phase 3 · Contact Sheet）
 *
 * 将全片分镜的关键帧按镜号顺序拼成一张高清总览图（附镜号、时间码、景别、时长与动作摘要），
 * 方便：
 * 1. 导演或客户一眼审阅全片色彩、光线、景别节奏与角色连贯性；
 * 2. 导出 PNG 存档或发给多模态模型做全局视觉复核。
 *
 * 布局计算（computeContactSheetLayout）为纯函数，零 DOM 依赖，可独立单测；
 * Canvas 绘制（renderContactSheetDataUrl）在浏览器 / Electron 渲染进程中按需执行。
 */

export interface ContactSheetOptions {
  columns?: number;
  cellWidth?: number;
  cellHeight?: number;
  padding?: number;
  gap?: number;
  headerHeight?: number;
  footerHeight?: number;
}

export interface ContactSheetCell {
  shotId: string;
  shotNumber: number;
  startSec: number;
  durationSec: number;
  timecode: string;
  label: string;
  caption: string;
  dataUrl?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  imageHeight: number;
}

export interface ContactSheetLayout {
  width: number;
  height: number;
  columns: number;
  rows: number;
  headerHeight: number;
  padding: number;
  title: string;
  subtitle: string;
  totalDurationSec: number;
  coveredShots: number;
  totalShots: number;
  cells: ContactSheetCell[];
}

function formatMmSs(sec: number): string {
  const safe = Math.max(0, Math.round(sec));
  const mm = String(Math.floor(safe / 60)).padStart(2, '0');
  const ss = String(safe % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function pickBestFrameForShot(assets: Asset[], shotId: string): string | undefined {
  const candidates = assets
    .filter(
      (a) =>
        a.refId === shotId &&
        Boolean(a.dataUrl) &&
        (a.kind === 'first-frame' || a.kind === 'action-peak' || a.kind === 'end-frame'),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    candidates.find((a) => a.kind === 'first-frame')?.dataUrl ??
    candidates.find((a) => a.kind === 'action-peak')?.dataUrl ??
    candidates[0]?.dataUrl
  );
}

function defaultCellDimensions(aspectRatio: string): { width: number; height: number } {
  const norm = aspectRatio.trim();
  if (norm === '9:16') return { width: 270, height: 480 };
  if (norm === '1:1') return { width: 320, height: 320 };
  if (norm === '3:4') return { width: 280, height: 374 };
  if (norm === '4:3') return { width: 360, height: 270 };
  // 默认 16:9 或宽屏
  return { width: 384, height: 216 };
}

export function computeContactSheetLayout(
  project: Project,
  assets: Asset[],
  options: ContactSheetOptions = {},
): ContactSheetLayout {
  const ordered: Shot[] = [...project.shots].sort((a, b) => a.number - b.number);
  const ratio = project.brief.aspectRatio || '16:9';
  const baseDims = defaultCellDimensions(ratio);
  const columns = Math.max(
    1,
    options.columns ?? (ratio === '9:16' ? 4 : 3),
  );
  const cellWidth = options.cellWidth ?? baseDims.width;
  const imageHeight = options.cellHeight ?? baseDims.height;
  const footerHeight = options.footerHeight ?? 58;
  const cellTotalHeight = imageHeight + footerHeight;
  const padding = options.padding ?? 28;
  const gap = options.gap ?? 18;
  const headerHeight = options.headerHeight ?? 76;

  let cursorSec = 0;
  let coveredShots = 0;
  const cells: ContactSheetCell[] = ordered.map((shot, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    const x = padding + col * (cellWidth + gap);
    const y = headerHeight + padding + row * (cellTotalHeight + gap);
    const startSec = cursorSec;
    const durationSec = Number.isFinite(shot.duration) && shot.duration > 0 ? shot.duration : 3;
    cursorSec += durationSec;
    const dataUrl = pickBestFrameForShot(assets, shot.id);
    if (dataUrl) coveredShots += 1;

    const scene = project.scenes.find((s) => s.id === shot.sceneId);
    const label = `#${String(shot.number).padStart(2, '0')} · ${formatMmSs(startSec)} · ${SHOT_SIZE_LABEL[shot.shotSize]} · ${durationSec}s`;
    const rawCaption = [scene?.name, shot.action || shot.startState].filter(Boolean).join(' · ');
    const caption = rawCaption.length > 26 ? `${rawCaption.slice(0, 25)}…` : rawCaption;

    return {
      shotId: shot.id,
      shotNumber: shot.number,
      startSec,
      durationSec,
      timecode: formatMmSs(startSec),
      label,
      caption,
      ...(dataUrl ? { dataUrl } : {}),
      x,
      y,
      width: cellWidth,
      height: cellTotalHeight,
      imageHeight,
    };
  });

  const rows = Math.max(1, Math.ceil(ordered.length / columns));
  const width = padding * 2 + columns * cellWidth + Math.max(0, columns - 1) * gap;
  const height =
    headerHeight + padding * 2 + rows * cellTotalHeight + Math.max(0, rows - 1) * gap;

  return {
    width,
    height,
    columns,
    rows,
    headerHeight,
    padding,
    title: `${project.name} · 分镜总览联系表`,
    subtitle: `共 ${ordered.length} 镜 · 总计 ${cursorSec} 秒 · 画幅 ${ratio} · 已出图 ${coveredShots}/${ordered.length}`,
    totalDurationSec: cursorSec,
    coveredShots,
    totalShots: ordered.length,
    cells,
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/**
 * 在浏览器 / Electron 渲染进程中将联系表合成为 PNG dataUrl。
 */
export async function renderContactSheetDataUrl(
  project: Project,
  assets: Asset[],
  options: ContactSheetOptions = {},
): Promise<{ ok: boolean; dataUrl?: string; layout: ContactSheetLayout; error?: string }> {
  const layout = computeContactSheetLayout(project, assets, options);
  if (typeof document === 'undefined') {
    return { ok: false, layout, error: '当前环境不支持画布渲染。' };
  }
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { ok: false, layout, error: '无法初始化画布上下文。' };
  }

  // 深色制片底板
  ctx.fillStyle = '#11141a';
  ctx.fillRect(0, 0, layout.width, layout.height);

  // 顶部标题栏
  ctx.fillStyle = '#1a1f29';
  ctx.fillRect(0, 0, layout.width, layout.headerHeight);
  ctx.fillStyle = '#f4f6fa';
  ctx.font = 'bold 22px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(layout.title, layout.padding, 34);
  ctx.fillStyle = '#9aa4b2';
  ctx.font = '14px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(layout.subtitle, layout.padding, 58);

  for (const cell of layout.cells) {
    // 卡片外框
    ctx.fillStyle = '#1c222d';
    ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
    ctx.strokeStyle = '#2d3646';
    ctx.lineWidth = 1;
    ctx.strokeRect(cell.x, cell.y, cell.width, cell.height);

    // 图像区
    if (cell.dataUrl) {
      try {
        const img = await loadImage(cell.dataUrl);
        const scale = Math.min(cell.width / img.width, cell.imageHeight / img.height);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        const dx = cell.x + (cell.width - drawW) / 2;
        const dy = cell.y + (cell.imageHeight - drawH) / 2;
        ctx.fillStyle = '#0b0e13';
        ctx.fillRect(cell.x, cell.y, cell.width, cell.imageHeight);
        ctx.drawImage(img, dx, dy, drawW, drawH);
      } catch {
        ctx.fillStyle = '#242b38';
        ctx.fillRect(cell.x, cell.y, cell.width, cell.imageHeight);
        ctx.fillStyle = '#7e8899';
        ctx.font = '13px "Segoe UI", "PingFang SC", sans-serif';
        ctx.fillText('图片解码失败', cell.x + 12, cell.y + cell.imageHeight / 2);
      }
    } else {
      ctx.fillStyle = '#151a23';
      ctx.fillRect(cell.x, cell.y, cell.width, cell.imageHeight);
      ctx.fillStyle = '#6b7586';
      ctx.font = '13px "Segoe UI", "PingFang SC", sans-serif';
      ctx.fillText('待出图', cell.x + 14, cell.y + cell.imageHeight / 2);
    }

    // 底部信息条
    const textY = cell.y + cell.imageHeight + 20;
    ctx.fillStyle = '#e6ebf5';
    ctx.font = 'bold 13px "Segoe UI", "PingFang SC", sans-serif';
    ctx.fillText(cell.label, cell.x + 10, textY);

    ctx.fillStyle = '#9aa4b2';
    ctx.font = '12px "Segoe UI", "PingFang SC", sans-serif';
    ctx.fillText(cell.caption || '（未填动作）', cell.x + 10, textY + 22);
  }

  return {
    ok: true,
    dataUrl: canvas.toDataURL('image/png'),
    layout,
  };
}
