// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Asset, Project, Shot } from '../src/types/model';
import { buildVideoReferences, videoAspectFromSize } from '../src/data/video/references';
import {
  SKYREELS_VIDEO_PRESET,
  listCustomVideoProfiles,
  resolveDefaultVideoProfile,
  resolveVideoProfileById,
  toVideoProfile,
} from '../src/data/models/videoProfiles';
import { customModelToProfile, validateCustomModel, writeCustomModelConfigs } from '../src/data/customModels';
import { findProfile, resolveAllProfiles } from '../src/data/models/profiles';
import type { CustomModelConfig } from '../src/types/customModel';

const project = { id: 'p1' } as Project;
const shot: Pick<Shot, 'id' | 'characterIds' | 'sceneId'> = {
  id: 'shot-01',
  characterIds: ['ch-1'],
  sceneId: 'sc-1',
};

function asset(overrides: Partial<Asset> & Pick<Asset, 'id' | 'kind' | 'refId' | 'dataUrl'>): Asset {
  return {
    projectId: 'p1',
    promptSnapshot: 'p',
    mimeType: 'image/png',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('buildVideoReferences', () => {
  it('首帧缺失返回明确错误', () => {
    const result = buildVideoReferences(shot, project, []);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('首帧');
  });

  it('第 1 张锁定首帧，角色图→场景板→关键帧→尾帧，最多 4 张且去重', () => {
    const assets = [
      asset({ id: 'first', kind: 'first-frame', refId: 'shot-01', dataUrl: 'data:first', width: 720, height: 1280 }),
      asset({ id: 'char-face', kind: 'character-sheet-face', refId: 'ch-1', dataUrl: 'data:face' }),
      asset({ id: 'scene', kind: 'scene-plate', refId: 'sc-1', dataUrl: 'data:scene' }),
      asset({ id: 'peak', kind: 'action-peak', refId: 'shot-01', dataUrl: 'data:peak' }),
      asset({ id: 'end', kind: 'end-frame', refId: 'shot-01', dataUrl: 'data:end' }),
      asset({ id: 'dupe', kind: 'first-frame', refId: 'shot-01', dataUrl: 'data:first' }),
    ];
    const result = buildVideoReferences(shot, project, assets);
    expect(result.ok).toBe(true);
    expect(result.assetIds).toEqual(['first', 'char-face', 'scene', 'peak']);
    expect(result.dataUrls).toEqual(['data:first', 'data:face', 'data:scene', 'data:peak']);
    expect(result.aspect).toBe('vertical');
  });

  it('画幅判断：h/w≈1.78 竖屏、≈0.56 横屏、不同首帧不静默改', () => {
    expect(videoAspectFromSize(720, 1280)).toBe('vertical');
    expect(videoAspectFromSize(1280, 720)).toBe('horizontal');
    expect(videoAspectFromSize(480, 848)).toBe('vertical');
    expect(videoAspectFromSize(848, 480)).toBe('horizontal');
    const horizontal = buildVideoReferences(
      shot,
      project,
      [asset({ id: 'hf', kind: 'first-frame', refId: 'shot-01', dataUrl: 'data:h', width: 1280, height: 720 })],
    );
    expect(horizontal.aspect).toBe('horizontal');
  });
});

describe('视频档案/preset', () => {
  const config: CustomModelConfig = {
    id: 'vid-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    name: 'SkyReels 本地',
    modality: 'video',
    protocol: 'openai-videos',
    baseUrl: 'http://127.0.0.1:8110/v1',
    model: 'skyreels-v3-r2v',
    requiresKey: false,
    timeoutMs: 1_200_000,
    capabilities: { maxReferenceImages: 4 },
  };

  it('自定义 video 配置映射成 i2v/openai-videos/videoCapabilities', () => {
    const profile = customModelToProfile(config);
    expect(profile.type).toBe('i2v');
    expect(profile.videoProtocol).toBe('openai-videos');
    expect(profile.videoCapabilities).toMatchObject({
      maxReferenceImages: 4,
      durationSeconds: 5,
      resolution: '480P',
      requiresKey: false,
      maxTimeoutMs: 1_200_000,
    });
    expect(toVideoProfile(profile)).toMatchObject({ id: 'custom:video:vid-1', model: 'skyreels-v3-r2v' });
  });

  it('preset 字段正确；唯一自定义视频时回退；多条时要求显式默认', () => {
    expect(validateCustomModel(SKYREELS_VIDEO_PRESET).ok).toBe(true);
    expect(SKYREELS_VIDEO_PRESET).toMatchObject({
      modality: 'video',
      protocol: 'openai-videos',
      baseUrl: 'http://127.0.0.1:8110/v1',
      model: 'skyreels-v3-r2v',
      requiresKey: false,
      timeoutMs: 1_200_000,
      capabilities: { maxReferenceImages: 4 },
    });
    expect(resolveDefaultVideoProfile(undefined, [config])?.id).toBe('custom:video:vid-1');
    const second = { ...config, id: 'vid-2', name: '另一个' };
    expect(resolveDefaultVideoProfile(undefined, [config, second])).toBeNull();
    expect(resolveDefaultVideoProfile(undefined, [])).toBeNull();
  });

  it('写入 localStorage 后 resolveVideoProfileById/listCustomVideoProfiles 可见', () => {
    writeCustomModelConfigs([config]);
    expect(listCustomVideoProfiles().map((p) => p.id)).toEqual(['custom:video:vid-1']);
    expect(resolveVideoProfileById('custom:video:vid-1')?.model).toBe('skyreels-v3-r2v');
    expect(resolveVideoProfileById('custom:image:nope')).toBeNull();
    expect(findProfile('custom:video:vid-1')?.type).toBe('i2v');
    expect(resolveAllProfiles().some((profile) => profile.id === 'custom:video:vid-1')).toBe(true);
  });
});
