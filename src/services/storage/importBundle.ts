import { strFromU8, unzipSync } from 'fflate';
import { safeFileName } from '../../domain/export';
import { SCHEMA_VERSION, type Asset, type AssetKind, type Project } from '../../types/model';
import { newId, parseImportedProject, saveAssets, saveProject } from './index';

export interface ImportFileResult {
  ok: boolean;
  project?: Project;
  restoredImages?: number;
  error?: string;
}

const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_BYTES = 150 * 1024 * 1024;

const DIR_TO_KIND: { prefix: string; kind: AssetKind }[] = [
  { prefix: '图包★/角色/全身多视图/', kind: 'character-sheet' },
  { prefix: '图包★/角色/头部特写/', kind: 'character-sheet-face' },
  { prefix: '图包★/场景/', kind: 'scene-plate' },
  { prefix: '图包★/镜头/首帧/', kind: 'first-frame' },
  { prefix: '图包★/镜头/动作关键帧/', kind: 'action-peak' },
  { prefix: '图包★/镜头/尾帧/', kind: 'end-frame' },
];

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function extToMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

function matchRefId(project: Project, kind: AssetKind, fileName: string): string | null {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const target = stem.replace(/_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_\d+)?$/, '');

  if (kind === 'character-sheet' || kind === 'character-sheet-face') {
    const ch = project.characters.find((c) => safeFileName(c.name, '未命名') === target);
    return ch?.id ?? null;
  }
  if (kind === 'scene-plate') {
    const sc = project.scenes.find((s) => safeFileName(s.name, '未命名') === target);
    return sc?.id ?? null;
  }
  const m = /^第(\d+)镜$/.exec(target);
  if (m) {
    const num = Number(m[1]);
    const shot = project.shots.find((s) => s.number === num);
    return shot?.id ?? null;
  }
  return null;
}

function extractAssetsFromZip(project: Project, files: Record<string, Uint8Array>): Asset[] {
  const now = new Date().toISOString();
  const restored: Asset[] = [];

  for (const [rawPath, bytes] of Object.entries(files)) {
    if (!bytes || bytes.length === 0) continue;
    const normalized = rawPath.replace(/\\/g, '/');
    const hit = DIR_TO_KIND.find(({ prefix }) => normalized.includes(prefix));
    if (!hit) continue;

    const idx = normalized.indexOf(hit.prefix);
    const fileName = normalized.slice(idx + hit.prefix.length);
    if (!fileName || fileName.includes('/')) continue;

    const refId = matchRefId(project, hit.kind, fileName);
    if (!refId) continue;

    const mimeType = extToMime(fileName);
    const dataUrl = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
    restored.push({
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      id: newId('asset'),
      projectId: project.id,
      kind: hit.kind,
      refId,
      dataUrl,
      mimeType,
      promptSnapshot: '',
      byteSize: bytes.length,
    });
  }

  return restored;
}

function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/**
 * 统一的项目导入入口：同时支持导出的 .zip 压缩包与单独的 项目数据.json，
 * 解析后立即写入 IndexedDB，确保重启或刷新工具后仍可正常显示和操作。
 */
export async function importProjectFile(file: File): Promise<ImportFileResult> {
  try {
    const lowerName = file.name.toLowerCase();
    const looksZip = lowerName.endsWith('.zip') || file.type === 'application/zip';

    if (looksZip) {
      if (file.size > MAX_ZIP_BYTES) {
        return { ok: false, error: '压缩包超过 150MB，无法在浏览器内直接解压。' };
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isZipBytes(bytes)) {
        return { ok: false, error: '文件扩展名是 .zip，但内容不是有效的压缩包。' };
      }
      let unzipped: Record<string, Uint8Array>;
      try {
        unzipped = unzipSync(bytes);
      } catch {
        return { ok: false, error: '压缩包解压失败，请确认文件完整且由本工具导出。' };
      }

      const paths = Object.keys(unzipped);
      const jsonPath =
        paths.find((p) => p === '项目数据.json' || p.endsWith('/项目数据.json')) ??
        paths.find((p) => p.toLowerCase().endsWith('.json') && !p.startsWith('__MACOSX/'));

      if (!jsonPath || !unzipped[jsonPath]) {
        return { ok: false, error: '压缩包里找不到 项目数据.json，请确认选的是本工具导出的文件。' };
      }

      const parsed = parseImportedProject(strFromU8(unzipped[jsonPath]));
      if (!parsed.ok || !parsed.project) {
        return { ok: false, error: parsed.error ?? '项目数据解析失败。' };
      }

      const project: Project = {
        ...parsed.project,
        updatedAt: new Date().toISOString(),
      };
      const restoredAssets = extractAssetsFromZip(project, unzipped);

      await saveProject(project);
      if (restoredAssets.length > 0) {
        await saveAssets(restoredAssets);
      }
      return { ok: true, project, restoredImages: restoredAssets.length };
    }

    if (file.size > MAX_JSON_BYTES) {
      return { ok: false, error: '文件超过 20MB。如果导入完整导出包，请保留 .zip 扩展名。' };
    }

    const text = await file.text();
    const parsed = parseImportedProject(text);
    if (!parsed.ok || !parsed.project) {
      return { ok: false, error: parsed.error ?? '项目数据解析失败。' };
    }

    const project: Project = {
      ...parsed.project,
      updatedAt: new Date().toISOString(),
    };
    await saveProject(project);
    return { ok: true, project, restoredImages: 0 };
  } catch {
    return {
      ok: false,
      error: '文件读取或保存到本机失败，请确认选的是本工具导出的 .zip 或 项目数据.json。',
    };
  }
}
