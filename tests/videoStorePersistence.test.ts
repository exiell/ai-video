// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const persistState = vi.hoisted(() => ({ calls: 0, failOnCall: 0 }));

vi.mock('../src/services/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage')>();
  return {
    ...actual,
    saveVideoJob: async (job: unknown) => {
      persistState.calls += 1;
      if (persistState.failOnCall === persistState.calls) throw new Error('QuotaExceededError');
      return actual.saveVideoJob(job as never);
    },
  };
});

import { sampleProject } from '../src/data/samples/sampleProject';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import { resetVideoPollingForTests, useVideo } from '../src/store/video';
import type { Asset } from '../src/types/model';
import type { CustomModelConfig } from '../src/types/customModel';
import { getDb, saveAssets } from '../src/services/storage';

const videoConfig: CustomModelConfig = {
  id: 'skyreels-persist',
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

const firstFrame: Asset = {
  id: 'asset-first',
  projectId: sampleProject.id,
  kind: 'first-frame',
  refId: 'shot-02',
  dataUrl: 'data:image/png;base64,FIRST',
  mimeType: 'image/png',
  width: 720,
  height: 1280,
  promptSnapshot: 'p',
  createdAt: '2026-01-01T00:00:01.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  schemaVersion: 1,
};

function queuedFetch() {
  return vi.fn(async () =>
    new Response(JSON.stringify({ id: 'remote-1', status: 'queued', progress: null, elapsed_seconds: 0 }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

beforeEach(async () => {
  persistState.calls = 0;
  persistState.failOnCall = 0;
  resetVideoPollingForTests();
  await getDb().videoJobs.clear();
  await getDb().videoClips.clear();
  await getDb().assets.clear();
  useAppStore.setState({ project: structuredClone(sampleProject) });
  useSettings.setState({
    customModels: [videoConfig],
    keys: {},
    prefs: { ...useSettings.getState().prefs, defaultVideoProfileId: undefined },
  });
  useVideo.setState({ jobs: [], clips: {}, submittingShotId: null, lastError: null });
  await saveAssets([firstFrame]);
});

afterEach(() => {
  resetVideoPollingForTests();
  vi.restoreAllMocks();
});

describe('submitVideo 持久化失败路径', () => {
  it('首次 persistJob 失败：返回人话、清理 submittingShotId、不 POST', async () => {
    persistState.failOnCall = 1;
    const fetchImpl = queuedFetch();
    const result = await useVideo.getState().submitVideo('shot-02', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('本地任务保存失败');
    expect(useVideo.getState().submittingShotId).toBeNull();
    expect(useVideo.getState().jobs).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POST 成功后 persist submitted 失败：保留 remoteJobId，进入 submit-uncertain 不重提', async () => {
    persistState.failOnCall = 2;
    const fetchImpl = queuedFetch();
    const result = await useVideo.getState().submitVideo('shot-02', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.job?.status).toBe('submit-uncertain');
    expect(result.job?.remoteJobId).toBe('remote-1');
    expect(result.error).toContain('已经提交到服务端');
    expect(useVideo.getState().submittingShotId).toBeNull();
    expect(useVideo.getState().jobs).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const saved = await getDb().videoJobs.toArray();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe('submit-uncertain');
    expect(saved[0]?.remoteJobId).toBe('remote-1');
  });
});
