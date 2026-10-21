import { strToU8, zipSync } from 'fflate';
import type { Asset, CheckReport, Project } from '../../types/model';
import { ASSET_KIND_LABEL } from '../../types/model';
import { continuitySheetMarkdown } from '../checks/continuity';
import {
  charactersToMarkdown,
  checkReportToMarkdown,
  imagePromptsToMarkdown,
  promptsToMarkdown,
  safeFileName,
  scenesToMarkdown,
  shootingProgressToMarkdown,
  storyboardToCsv,
  storyboardToMarkdown,
} from './index';

/**
 * 打包下载（方案.md §1.5 / §7.5 M6）
 *
 * ===========================================================================
 * 为什么图包是这个压缩包里最重要的部分
 * ===========================================================================
 * 数据全部存在浏览器的 IndexedDB 里，而**浏览器可能在清理磁盘或隐私数据时
 * 把它整个清空**。文本资产还能靠复制粘贴留存，图片不行——
 * 几十张形象图和关键帧是一次次真金白银生成的，丢了就是真丢了。
 *
 * 所以在有图片之后，导出不再只是「方便」，而是**唯一可靠的备份手段**。
 * 这一点必须让用户看见，而不是藏在菜单里。
 */

export interface ZipEntry {
  path: string;
  content: string;
  /** 二进制内容（图片）。有它时忽略 content。 */
  bytes?: Uint8Array;
}

// ---------------------------------------------------------------------------
// 图片条目
// ---------------------------------------------------------------------------

/** 从 data URI 里取出原始字节 */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const marker = dataUrl.indexOf(',');
  if (marker < 0) return null;
  const header = dataUrl.slice(0, marker);
  if (!header.includes('base64')) return null;
  try {
    const binary = atob(dataUrl.slice(marker + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** 从 data URI 里取出扩展名 */
export function dataUrlExtension(dataUrl: string, fallback = 'png'): string {
  const match = /^data:image\/([a-z0-9+.-]+)/i.exec(dataUrl);
  if (!match?.[1]) return fallback;
  const type = match[1].toLowerCase();
  if (type === 'jpeg' || type === 'jpg') return 'jpg';
  if (type === 'webp') return 'webp';
  return 'png';
}

/** 图片在压缩包里的目录：按类型分，一眼能找到 */
const ASSET_DIR: Record<Asset['kind'], string> = {
  'character-sheet': '图包/角色/全身多视图',
  'character-sheet-face': '图包/角色/头部特写',
  'scene-plate': '图包/场景',
  'first-frame': '图包/镜头/首帧',
  'action-peak': '图包/镜头/动作关键帧',
  'end-frame': '图包/镜头/尾帧',
};

/** 这张图归属哪个角色 / 场景 / 镜头，用于给图片起个能认出来的名字 */
function describeAssetTarget(project: Project, asset: Asset): string {
  if (asset.kind === 'character-sheet' || asset.kind === 'character-sheet-face') {
    const character = project.characters.find((c) => c.id === asset.refId);
    return character ? character.name : '未知角色';
  }
  if (asset.kind === 'scene-plate') {
    const scene = project.scenes.find((s) => s.id === asset.refId);
    return scene ? scene.name : '未知场景';
  }
  const shot = project.shots.find((s) => s.id === asset.refId);
  return shot ? `第${shot.number}镜` : '未知镜头';
}

/** 压缩包内重名时补序号，避免覆盖 */
function uniquePath(used: Set<string>, path: string): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const base = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : '';
  let index = 2;
  while (used.has(`${base}_${index}${ext}`)) index += 1;
  const next = `${base}_${index}${ext}`;
  used.add(next);
  return next;
}

/**
 * 把素材转成压缩包条目。
 *
 * 只处理有 dataUrl 的素材——**没有再下载一次的余地**，
 * 平台那个链接早就过期了。缺图会由调用方如实统计并告知。
 */
export function assetEntries(
  project: Project,
  assets: Asset[],
): { entries: ZipEntry[]; skipped: number } {
  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  let skipped = 0;

  for (const asset of assets) {
    if (!asset.dataUrl) {
      skipped += 1;
      continue;
    }
    const bytes = dataUrlToBytes(asset.dataUrl);
    if (!bytes) {
      skipped += 1;
      continue;
    }
    const target = safeFileName(describeAssetTarget(project, asset), '未命名');
    const stamp = asset.createdAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const path = uniquePath(
      used,
      `${ASSET_DIR[asset.kind]}/${target}_${stamp}.${dataUrlExtension(asset.dataUrl)}`,
    );
    entries.push({ path, content: '', bytes });
  }

  return { entries, skipped };
}

// ---------------------------------------------------------------------------
// 一致性总览
// ---------------------------------------------------------------------------

/**
 * 一致性总览表。
 *
 * 为什么需要它：用户事后发现「某张关键帧的脸不对」时，
 * 光看图片本身找不出原因——他需要知道**当时到底锁了什么、用了哪张参考图**。
 * 这份表就是为此存在的。
 */
export function consistencyReportMarkdown(project: Project, assets: Asset[]): string {
  const out: string[] = [];
  out.push(`# ${project.name} · 一致性总览`);
  out.push('');
  out.push('> 这张表记录**每张图生成时到底锁了什么、用了哪张参考图**。');
  out.push('> 当你发现某张图的脸不对时，翻回这一行就能看出问题出在哪。');
  out.push('');

  const groups: { kind: Asset['kind']; label: string }[] = [
    { kind: 'character-sheet', label: '角色全身多视图' },
    { kind: 'character-sheet-face', label: '角色头部特写' },
    { kind: 'scene-plate', label: '场景参考板' },
    { kind: 'first-frame', label: '镜头首帧' },
    { kind: 'action-peak', label: '镜头动作关键帧' },
    { kind: 'end-frame', label: '镜头尾帧' },
  ];

  let total = 0;
  for (const group of groups) {
    const list = assets.filter((a) => a.kind === group.kind);
    if (list.length === 0) continue;
    total += list.length;
    out.push(`## ${group.label}（${list.length} 张）`);
    out.push('');
    out.push('| 对象 | 生成时间 | 模型 | 参考图 | 当时生效的连续性锁 |');
    out.push('|---|---|---|---|---|');
    for (const asset of list) {
      const locks =
        asset.lockPhrases && asset.lockPhrases.length > 0
          ? asset.lockPhrases.map((p) => `\`${p}\``).join('<br>')
          : '（无）';
      out.push(
        `| ${describeAssetTarget(project, asset)} | ${new Date(asset.createdAt).toLocaleString('zh-CN')} | ${
          asset.model ?? '—'
        } | ${asset.referenceCount ? `${asset.referenceCount} 张` : '无（纯文生图）'} | ${locks} |`,
      );
    }
    out.push('');
  }

  if (total === 0) {
    out.push('还没有生成过任何图片。');
    out.push('');
  }

  out.push('## 怎么用这份表');
  out.push('');
  out.push('1. 找到出问题的那张图所在的行');
  out.push('2. 看「参考图」一栏：如果是「无」，说明这一张是纯文生图生成的，形象靠不住是正常的');
  out.push('3. 看「当时生效的连续性锁」一栏：如果某个角色的关键锁不在里面，那就是漏勾了');
  out.push('4. 改完重新生成那一张即可，不需要重做全部');
  out.push('');

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 清单与打包
// ---------------------------------------------------------------------------

export interface ExportOptions {
  /** 项目里的图片素材。传了它才会生成图包与一致性总览。 */
  assets?: Asset[];
}

export function buildExportManifest(
  project: Project,
  report: CheckReport,
  options: ExportOptions = {},
): ZipEntry[] {
  const entries: ZipEntry[] = [
    { path: '分镜表.csv', content: storyboardToCsv(project) },
    { path: '分镜表.md', content: storyboardToMarkdown(project) },
    { path: '角色设定卡.md', content: charactersToMarkdown(project) },
    { path: '场景设定卡.md', content: scenesToMarkdown(project) },
    { path: '穿帮检查单.md', content: checkReportToMarkdown(project, report) },
    { path: '拍摄进度表.md', content: shootingProgressToMarkdown(project) },
    // 衔接表单独出一份：做尾帧、写视频提示词、剪辑时对着它走，比来回翻分镜表快
    { path: '镜头衔接表.md', content: continuitySheetMarkdown(project) },
  ];

  for (const { fileName, content } of promptsToMarkdown(project)) {
    entries.push({ path: `提示词/${fileName}`, content });
  }

  /**
   * 图片提示词（v0.43）。
   *
   * 单独一份，因为它和「提示词/」下的视频提示词是两种东西：
   * 那些是每镜一段、拿去生成视频的；这一份是角色/场景/三帧的出图依据。
   * 有了它，用户可以用本工具没接的模型出图。
   */
  entries.push({ path: '图片提示词.md', content: imagePromptsToMarkdown(project) });

  const assets = options.assets ?? [];
  if (assets.length > 0) {
    entries.push({ path: '一致性总览.md', content: consistencyReportMarkdown(project, assets) });
    const { entries: imageEntries } = assetEntries(project, assets);
    entries.push(...imageEntries);
  }

  entries.push({
    path: '项目数据.json',
    content: JSON.stringify(project, null, 2),
  });

  return entries;
}

/** 打包成 zip。图片走二进制，文本走 UTF-8。 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    files[entry.path] = entry.bytes ?? strToU8(entry.content);
  }
  return zipSync(files, { level: 6 });
}

/** 生成下载用的文件名，带日期便于区分多次备份 */
export function bundleFileName(project: Project): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${safeFileName(project.name, 'aniguide-项目')}_${date}.zip`;
}

/** 给界面用：这次导出包含多少文本、多少图、图总共多大 */
export function summarizeBundle(entries: ZipEntry[]): {
  textCount: number;
  imageCount: number;
  imageBytes: number;
} {
  let textCount = 0;
  let imageCount = 0;
  let imageBytes = 0;
  for (const entry of entries) {
    if (entry.bytes) {
      imageCount += 1;
      imageBytes += entry.bytes.length;
    } else {
      textCount += 1;
    }
  }
  return { textCount, imageCount, imageBytes };
}

/** 素材类型的中文名，供界面复用 */
export function assetKindLabel(kind: Asset['kind']): string {
  return ASSET_KIND_LABEL[kind];
}
