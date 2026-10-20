import { Info } from '../components/bits';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../store/app';
import {
  buildExportManifest,
  buildZip,
  bundleFileName,
  summarizeBundle,
  type ZipEntry,
} from '../domain/export/bundle';
import { deleteProject, listAssets, parseImportedProject, type ImportResult } from '../services/storage';
import { runChecks } from '../domain/checks';
import type { Asset } from '../types/model';
import { ASSET_KIND_LABEL } from '../types/model';

/**
 * M6 导出（方案.md §1.5 / §7.5）
 *
 * 在有图片之后，这一页的定位变了：
 * **它不再是「导出方便」，而是唯一可靠的备份手段。**
 *
 * 因为所有数据都在浏览器的 IndexedDB 里，而浏览器可能在清理磁盘或隐私数据时
 * 把它整个清空。文本还能靠复制粘贴留存，几十张真金白银生成的图不行。
 * 所以「打包下载」被放在最显眼的位置，并且明确写出这次包里有什么、多大。
 */
export function ExportPage() {
  const project = useAppStore((s) => s.project);
  const report = useAppStore((s) => s.report);
  const setProject = useAppStore((s) => s.setProject);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [importOk, setImportOk] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    void listAssets(project.id).then(setAssets);
  }, [project]);

  if (!project) {
    return <div className="empty">还没有打开任何项目。先去「作品主页」新建或打开一个。</div>;
  }

  const currentReport = report ?? runChecks(project);
  const entries = buildExportManifest(project, currentReport, { assets });
  const summary = summarizeBundle(entries);
  const imageAssets = assets.filter((a) => a.dataUrl);

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function download() {
    const zip = buildZip(entries);
    const blob = new Blob([zip.slice().buffer as ArrayBuffer], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = bundleFileName(project!);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadSingle(entry: ZipEntry) {
    const blob = entry.bytes
      ? new Blob([entry.bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' })
      : new Blob([entry.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = entry.path.split('/').pop() ?? 'export';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function importFile(file: File) {
    setImportError(null);
    setImportOk(null);
    const text = await file.text();
    const result: ImportResult = parseImportedProject(text);
    if (!result.ok || !result.project) {
      setImportError(result.error ?? '导入失败。');
      return;
    }
    setProject(result.project);
    setImportOk(
      `已导入「${result.project.name}」。注意：项目数据里不含图片，图片需要从图包里手动查看。`,
    );
  }

  const textEntries = entries.filter((e) => !e.bytes);
  const imageEntries = entries.filter((e) => e.bytes);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>导出</h1>
          <p>
            这个包既是成品，也是<b>唯一的备份</b>。图片只在这个浏览器里，清了就没了。
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={download}>
          打包下载（zip）
        </button>
      </div>

      <div className="summary-bar">
        <span>
          这个包里会有 <b>{summary.textCount}</b> 个文本文件
        </span>
        <span>
          <b>{summary.imageCount}</b> 张图片（{formatBytes(summary.imageBytes)}）
        </span>
        {imageAssets.length === 0 ? (
          <span className="tag tag-warning">还没有生成过图</span>
        ) : (
          <span className="tag tag-ok">含全部 {imageAssets.length} 张已生成的图</span>
        )}
      </div>

      {imageAssets.length === 0 ? (
        <div className="card">
          <h3 className="card-title">现在还没有图片</h3>
          <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
            等你生成了角色形象图或关键帧，它们会一起进图包。
          </p>
          <Link className="btn" to="/characters">
            去生成角色形象图
          </Link>
        </div>
      ) : null}

      <div className="card">
        <h3 className="card-title">压缩包里有什么</h3>
        <div className="scroll-x">
          <table className="simple">
            <thead>
              <tr>
                <th style={{ width: 260 }}>文件</th>
                <th>用途</th>
                <th style={{ width: 100 }} />
              </tr>
            </thead>
            <tbody>
              {textEntries.map((entry) => (
                <tr key={entry.path}>
                  <td>
                    <code>{entry.path}</code>
                  </td>
                  <td style={{ color: 'var(--text-dim)' }}>{describeText(entry.path)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => downloadSingle(entry)}
                    >
                      单独下载
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {imageEntries.length > 0 ? (
          <>
            <h4 style={{ fontSize: 13, margin: '18px 0 8px' }}>
              图包（{imageEntries.length} 张，按类型分目录）
            </h4>
            <div className="scroll-x">
              <table className="simple">
                <thead>
                  <tr>
                    <th>目录</th>
                    <th style={{ width: 90 }}>张数</th>
                  </tr>
                </thead>
                <tbody>
                  {summarizeDirs(imageEntries).map((dir) => (
                    <tr key={dir.path}>
                      <td>
                        <code>{dir.path}</code>
                      </td>
                      <td>{dir.count} 张</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="hint">
              文件名是<code>对象名_生成时间.png</code>
            <Info label="文件名长什么样">
              例如 <code>图包/角色/头部特写/林冲_2026-10-12_18-30-00.png</code>，
              打开文件夹就知道哪张是谁的、什么时候生成的。
            </Info>
            </div>
          </>
        ) : null}
      </div>

      {imageAssets.length > 0 ? (
        <div className="card">
          <h3 className="card-title">你生成的图</h3>
          <div className="scroll-x">
            <table className="simple">
              <thead>
                <tr>
                  <th>类型</th>
                  <th style={{ width: 90 }}>张数</th>
                  <th style={{ width: 110 }}>占用</th>
                </tr>
              </thead>
              <tbody>
                {summarizeByKind(assets).map((row) => (
                  <tr key={row.kind}>
                    <td>{ASSET_KIND_LABEL[row.kind]}</td>
                    <td>{row.count}</td>
                    <td>{formatBytes(row.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hint">
            包里附一份<b>一致性总览.md</b>
            <Info label="这份表有什么用">
              它逐张记录每张图当时锁了什么、用了哪张参考图。
              以后发现某张图脸不对时，翻那份表就能看出问题出在哪。
            </Info>
          </div>
        </div>
      ) : null}

      <div className="card">
        <h3 className="card-title">怎么用这个包</h3>
        <ol style={{ fontSize: 13, color: 'var(--text-dim)', paddingLeft: 20, margin: 0 }}>
          <li>打开「拍摄进度表.md」，从第 1 镜开始做。</li>
          <li>
            对着「提示词/即梦.md」（或你选的平台），把每一镜的<b>英文正文</b>复制过去生成图。
          </li>
          <li>图满意了再拿去生成视频——先出图能省很多钱。</li>
          <li>每一镜做完，在进度表上打勾。</li>
          <li>
            遇到「看起来不像同一个人 / 同一个地方」时，先翻「一致性总览.md」看当时锁了什么，
            再翻「穿帮检查单.md」看有没有哪条锁没带上。
          </li>
        </ol>
      </div>

      <div className="card">
        <h3 className="card-title">导入项目文件</h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
          迁移到另一台电脑用。注意：<b>不含图片</b>，图片在图包里。
        </p>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importFile(file);
          }}
        />
        {importError ? (
          <div className="issue error" style={{ marginTop: 12 }}>
            <div className="issue-title">导入失败</div>
            <div className="issue-line">{importError}</div>
          </div>
        ) : null}
        {importOk ? (
          <div className="issue" style={{ marginTop: 12, borderLeftColor: 'var(--ok)' }}>
            <div className="issue-line">{importOk}</div>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h3 className="card-title">危险操作</h3>
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (
              window.confirm(
                `确定删除项目「${project.name}」吗？\n\n这会连同它的 ${imageAssets.length} 张图片一起删除，且无法撤销。\n建议先打包下载一份备份。`,
              )
            ) {
              void deleteProject(project.id).then(() => setProject(null));
            }
          }}
        >
          删除这个项目
        </button>
        <div className="hint">会连同项目下的全部图片一起删除，无法撤销。</div>
      </div>
    </>
  );
}

function describeText(path: string): string {
  if (path === '分镜表.csv') return '可以用 Excel / 飞书表格打开，方便你改和打印';
  if (path === '分镜表.md') return '带完整字段的分镜表，适合直接看';
  if (path === '角色设定卡.md') return '身份 / 变体 / 连续性锁三层设定';
  if (path === '场景设定卡.md') return '固定元素 / 光线 / 色调，场景不走样的依据';
  if (path === '穿帮检查单.md') return '出图前该核对的全部问题，每条都写了为什么和怎么改';
  if (path === '拍摄进度表.md') return '逐镜执行清单，可以打勾';
  if (path === '镜头衔接表.md') return '每一镜怎么接到下一镜；做尾帧、写转场、剪辑时对着它走';
  if (path === '一致性总览.md') return '逐张记录每张图当时锁了什么、用了哪张参考图';
  if (path === '项目数据.json') return '备份用。导入它可以完整恢复这个项目的文本部分';
  if (path.startsWith('提示词/')) return '可直接粘贴的英文正文 + 中文对照 + 逐项说明';
  return '';
}

/** 按目录统计图片张数 */
function summarizeDirs(entries: ZipEntry[]): { path: string; count: number }[] {
  const map = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.bytes) continue;
    const dir = entry.path.slice(0, entry.path.lastIndexOf('/'));
    map.set(dir, (map.get(dir) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** 按素材类型统计张数与占用 */
function summarizeByKind(
  assets: Asset[],
): { kind: Asset['kind']; count: number; bytes: number }[] {
  const map = new Map<Asset['kind'], { count: number; bytes: number }>();
  for (const asset of assets) {
    if (!asset.dataUrl) continue;
    const current = map.get(asset.kind) ?? { count: 0, bytes: 0 };
    current.count += 1;
    current.bytes += asset.byteSize ?? 0;
    map.set(asset.kind, current);
  }
  return [...map.entries()].map(([kind, v]) => ({ kind, ...v }));
}


