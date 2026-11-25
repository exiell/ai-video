import { useState } from 'react';
import type { Asset, Project } from '../../types/model';
import { buildZip, dataUrlToBytes } from '../../domain/export/bundle';
import { safeFileName } from '../../domain/export';
import { exportToOtioJson } from '../../domain/export/otio';
import { exportToFcpxml } from '../../domain/export/fcpxml';
import { exportToJianyingDraft } from '../../domain/export/jianyingDraft';
import { exportToSrt } from '../../domain/export/srt';
import { renderContactSheetDataUrl } from '../../domain/image/contactSheet';
import { saveExportFile } from '../../platform/fileExport';

/**
 * 剪辑软件时间线与分镜联系表导出卡（Phase 3）
 *
 * 1. 剪映草稿包（含 draft_content.json + draft_meta_info.json）、DaVinci/FCP (.fcpxml)、
 *    OpenTimelineIO (.otio) 与外挂字幕轨 (.srt)；
 * 2. 一张图总览全片的分镜联系表（PNG 拼图），方便审片与配色节奏检查。
 */
export function NleContactSheetCard({
  project,
  assets,
  clipPathsByShotId,
  onNotice,
}: {
  project: Project;
  assets: Asset[];
  clipPathsByShotId: Record<string, string>;
  onNotice: (notice: { text: string; filePath?: string; isError?: boolean }) => void;
}) {
  const [sheetPreview, setSheetPreview] = useState<string | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);

  const baseName = safeFileName(project.name, 'aniguide');
  const localLinkedCount = Object.keys(clipPathsByShotId).length;

  async function saveText(fileName: string, content: string, mime: string) {
    const outcome = await saveExportFile(fileName, content, mime);
    if (outcome.canceled) return;
    if (!outcome.saved) {
      onNotice({ text: outcome.error ?? '保存失败，请重试。', isError: true });
      return;
    }
    onNotice({
      text: outcome.filePath ? `已保存到 ${outcome.filePath}` : `已导出 ${fileName}`,
      ...(outcome.filePath ? { filePath: outcome.filePath } : {}),
    });
  }

  async function downloadJianyingZip() {
    const draft = exportToJianyingDraft(project, { clipPathsByShotId });
    const zip = buildZip([
      { path: 'draft_content.json', content: draft.draftContentJson },
      { path: 'draft_meta_info.json', content: draft.draftMetaInfoJson },
    ]);
    const fileName = `${baseName}_剪映草稿.zip`;
    const outcome = await saveExportFile(fileName, zip, 'application/zip');
    if (outcome.canceled) return;
    if (!outcome.saved) {
      onNotice({ text: outcome.error ?? '保存失败，请重试。', isError: true });
      return;
    }
    onNotice({
      text: outcome.filePath ? `已保存到 ${outcome.filePath}` : `已导出 ${fileName}`,
      ...(outcome.filePath ? { filePath: outcome.filePath } : {}),
    });
  }

  async function generateContactSheet(downloadNow: boolean) {
    setSheetBusy(true);
    try {
      const res = await renderContactSheetDataUrl(project, assets);
      if (!res.ok || !res.dataUrl) {
        onNotice({ text: res.error ?? '生成联系表失败。', isError: true });
        return;
      }
      setSheetPreview(res.dataUrl);
      if (downloadNow) {
        const bytes = dataUrlToBytes(res.dataUrl);
        if (!bytes) {
          onNotice({ text: '联系表图片编码失败。', isError: true });
          return;
        }
        const fileName = `${baseName}_分镜总览联系表.png`;
        const outcome = await saveExportFile(fileName, bytes, 'image/png');
        if (outcome.canceled) return;
        if (!outcome.saved) {
          onNotice({ text: outcome.error ?? '保存失败，请重试。', isError: true });
          return;
        }
        onNotice({
          text: outcome.filePath ? `已保存到 ${outcome.filePath}` : `已导出 ${fileName}`,
          ...(outcome.filePath ? { filePath: outcome.filePath } : {}),
        });
      }
    } finally {
      setSheetBusy(false);
    }
  }

  const srtContent = exportToSrt(project);

  return (
    <div className="card">
      <h2 className="card-title">剪辑时间线与分镜联系表</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        直接把分镜节奏、台词字幕和本地成片路径导入剪映、达芬奇（DaVinci Resolve）或 Final Cut Pro，免去手工逐镜对齐。
        {localLinkedCount > 0 ? ` 当前已自动关联 ${localLinkedCount} 条本机缓存视频路径。` : ''}
      </p>

      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <button type="button" className="btn btn-sm" onClick={() => void downloadJianyingZip()}>
          导出剪映草稿 (.zip)
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            void saveText(
              `${baseName}.fcpxml`,
              exportToFcpxml(project, { clipPathsByShotId }),
              'application/xml;charset=utf-8',
            )
          }
        >
          导出达芬奇 / FCP (.fcpxml)
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            void saveText(
              `${baseName}.otio`,
              exportToOtioJson(project, { clipPathsByShotId }),
              'application/json;charset=utf-8',
            )
          }
        >
          导出专业时间线 (.otio)
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!srtContent}
          title={srtContent ? '导出标准外挂字幕轨' : '当前分镜还没有台词或旁白'}
          onClick={() =>
            void saveText(`${baseName}_字幕.srt`, srtContent, 'text/plain;charset=utf-8')
          }
        >
          导出外挂字幕 (.srt)
        </button>
      </div>

      <div
        style={{
          paddingTop: 12,
          borderTop: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <b style={{ fontSize: 14 }}>分镜总览联系表拼图</b>
            <div className="muted" style={{ fontSize: 12 }}>
              把全部镜头的首帧按镜号、时间码与景别拼成一张总览大图，方便审片与配色检查。
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={sheetBusy || project.shots.length === 0}
              onClick={() => void generateContactSheet(false)}
            >
              {sheetBusy ? '拼图中…' : '预览拼图'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={sheetBusy || project.shots.length === 0}
              onClick={() => void generateContactSheet(true)}
            >
              导出联系表 PNG
            </button>
          </div>
        </div>

        {sheetPreview ? (
          <img
            src={sheetPreview}
            alt="分镜总览联系表预览"
            style={{
              width: '100%',
              borderRadius: 10,
              border: '1px solid var(--line)',
              display: 'block',
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
