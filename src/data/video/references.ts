/**
 * 视频参考图选择（v0.65 纯函数，UI 后续接）
 *
 * 规则：
 *  - 第 1 张固定本镜首帧（kind='first-frame'，refId=shot.id），缺了直接报错；
 *  - 之后按「角色形象图 → 场景板 → 动作关键帧 → 尾帧」补，最多 4 张；
 *  - 只取有 dataUrl 的素材，按 assetId 去重；
 *  - 画幅由首帧宽高比决定：h/w≈1.78 竖屏，≈0.56 横屏。
 */
import type { Asset, Project, Shot } from '../../types/model';
import type { BuildReferencesResult, VideoAspect } from '../../types/video';

function latestByKind(
  assets: Asset[],
  predicate: (asset: Asset) => boolean,
): Asset | undefined {
  return assets
    .filter((asset) => Boolean(asset.dataUrl) && predicate(asset))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function videoAspectFromSize(width: number | undefined, height: number | undefined): VideoAspect {
  if (!width || !height || width <= 0 || height <= 0) return 'vertical';
  const ratio = height / width;
  if (ratio >= 1.4) return 'vertical';
  if (ratio <= 0.8) return 'horizontal';
  return ratio > 1 ? 'vertical' : 'horizontal';
}

/** 默认参考图（与 buildVideoReferences 完全一致；UI 初始化选择器用，避免显示 1 张但实际提交 N 张） */
export function defaultReferenceAssetIds(
  shot: Pick<Shot, 'id' | 'characterIds' | 'sceneId'>,
  project: Pick<Project, 'id'>,
  assets: Asset[],
): string[] {
  return buildVideoReferences(shot, project, assets).assetIds;
}

export function buildVideoReferences(
  shot: Pick<Shot, 'id' | 'characterIds' | 'sceneId'>,
  project: Pick<Project, 'id'>,
  assets: Asset[],
): BuildReferencesResult {
  const projectAssets = assets.filter((asset) => asset.projectId === project.id);
  const firstFrame = latestByKind(
    projectAssets,
    (asset) => asset.kind === 'first-frame' && asset.refId === shot.id,
  );
  if (!firstFrame) {
    return {
      ok: false,
      assetIds: [],
      dataUrls: [],
      error: '先出这一镜的首帧，视频会从首帧开始动。',
    };
  }

  const picked: Asset[] = [firstFrame];
  const seen = new Set<string>([firstFrame.id]);
  const add = (asset: Asset | undefined): void => {
    if (!asset || seen.has(asset.id) || picked.length >= 4) return;
    seen.add(asset.id);
    picked.push(asset);
  };

  // 角色形象图：优先锁脸的头像，没有再退全身多视图；每个角色最多一张
  for (const characterId of shot.characterIds ?? []) {
    const face = latestByKind(
      projectAssets,
      (asset) =>
        asset.kind === 'character-sheet-face' &&
        asset.refId === characterId,
    );
    const full = latestByKind(
      projectAssets,
      (asset) => asset.kind === 'character-sheet' && asset.refId === characterId,
    );
    add(face ?? full);
    if (picked.length >= 4) break;
  }

  // 场景板
  add(
    latestByKind(
      projectAssets,
      (asset) => asset.kind === 'scene-plate' && asset.refId === shot.sceneId,
    ),
  );

  // 本镜动作关键帧 / 尾帧
  add(latestByKind(projectAssets, (asset) => asset.kind === 'action-peak' && asset.refId === shot.id));
  add(latestByKind(projectAssets, (asset) => asset.kind === 'end-frame' && asset.refId === shot.id));

  return {
    ok: true,
    assetIds: picked.map((asset) => asset.id),
    dataUrls: picked.map((asset) => asset.dataUrl as string),
    aspect: videoAspectFromSize(firstFrame.width, firstFrame.height),
  };
}
