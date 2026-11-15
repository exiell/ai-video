// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleProject } from '../src/data/samples/sampleProject';
import { useAppStore } from '../src/store/app';
import { useSettings } from '../src/store/settings';
import {
  MAX_QUEUE,
  POLL_HIDDEN_MS,
  POLL_VISIBLE_MS,
  resetVideoPollingForTests,
  useVideo,
  videoClipKey,
} from '../src/store/video';
import type { Asset } from '../src/types/model';
import type { CustomModelConfig } from '../src/types/customModel';
import { writeCustomModelConfigs } from '../src/data/customModels';
import { defaultReferenceAssetIds } from '../src/data/video/references';
import type { VideoClipRecord, VideoJobRecord, VideoProfile } from '../src/types/video';
import {
  getDb,
  getVideoJob,
  listVideoClipsForShot,
  pruneVideoJobs,
  saveAssets,
  saveVideoClip,
  saveVideoClipReplacingShot,
  saveVideoJob,
} from '../src/services/storage';

const videoConfig: CustomModelConfig = {
  id: 'skyreels-test',
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

function fakeFetch() {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'}:${url}`);
    if (url.endsWith('/videos') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'remote-1', status: 'queued', progress: null, elapsed_seconds: 0 }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/content')) {
      return new Response('mp4!', {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    }
    return new Response(
      JSON.stringify({
        id: 'remote-1',
        status: 'completed',
        progress: 100,
        elapsed_seconds: 720,
        output: { width: 480, height: 848, duration_s: 5, fps: 24, bytes: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { fetchImpl, calls };
}

beforeEach(async () => {
  resetVideoPollingForTests();
  const db = getDb();
  await db.videoJobs.clear();
  await db.videoClips.clear();
  await db.assets.clear();
  useAppStore.setState({ project: structuredClone(sampleProject) });
  useSettings.setState({
    customModels: [videoConfig],
    keys: {},
    prefs: {
      ...useSettings.getState().prefs,
      defaultVideoProfileId: undefined,
      defaultT2iProfileId: 'qwen-image',
      defaultReferenceProfileId: 'qwen-image-edit',
    },
  });
  useVideo.setState({ jobs: [], clips: {}, submittingShotId: null, lastError: null });
  await saveAssets([firstFrame]);
});

afterEach(() => {
  resetVideoPollingForTests();
  vi.restoreAllMocks();
});

describe('视频任务 store', () => {
  it('提交→轮询→保存 clip；任务和 clip 落库', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const submitted = await useVideo.getState().submitVideo('shot-02', { fetchImpl });
    expect(submitted.ok).toBe(true);
    expect(submitted.job?.status).toBe('submitted');
    expect(submitted.job?.remoteJobId).toBe('remote-1');
    expect(submitted.job?.referenceAssetIds).toEqual(['asset-first']);
    expect(calls[0]).toContain('POST:http://127.0.0.1:8110/v1/videos');

    await useVideo.getState().pollActiveJobs({ fetchImpl });
    const job = useVideo.getState().jobs.find((item) => item.remoteJobId === 'remote-1');
    expect(job?.status).toBe('saved');
    expect(job?.outputClipId).toBeTruthy();
    const clip = useVideo.getState().clips['shot-02'];
    expect(clip?.blob.size).toBe(4);
    expect(clip?.width).toBe(480);
    expect(clip?.height).toBe(848);
    expect(await listVideoClipsForShot(sampleProject.id, 'shot-02')).toHaveLength(1);
    expect((await getVideoJob(job!.id))?.status).toBe('saved');
  });

  it('同一镜头活动任务防重复，队列≤4', async () => {
    const { fetchImpl } = fakeFetch();
    expect((await useVideo.getState().submitVideo('shot-02', { fetchImpl })).ok).toBe(true);
    const duplicate = await useVideo.getState().submitVideo('shot-02', { fetchImpl });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toContain('正在生成');

    const fakeJobs: VideoJobRecord[] = Array.from({ length: MAX_QUEUE }, (_, index) => ({
      id: `job-${index}`,
      projectId: sampleProject.id,
      shotId: `other-${index}`,
      profileId: videoConfig.id,
      referenceAssetIds: [],
      prompt: 'p',
      seconds: 5,
      resolution: '480P',
      status: 'submitted',
      remoteJobId: `r-${index}`,
      idempotencyKey: `k-${index}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    useVideo.setState({ jobs: fakeJobs });
    const queued = await useVideo.getState().submitVideo('shot-02', { fetchImpl });
    expect(queued.ok).toBe(false);
    expect(queued.error).toContain('排队已满');
  });

  it('recoverJobs：只恢复查询，不重提；submit-uncertain 不自动重试', async () => {
    const submitted: VideoJobRecord = {
      id: 'job-submitted',
      projectId: sampleProject.id,
      shotId: 'shot-02',
      profileId: videoConfig.id,
      referenceAssetIds: ['asset-first'],
      prompt: 'p',
      seconds: 5,
      resolution: '480P',
      status: 'submitted',
      remoteJobId: 'remote-1',
      idempotencyKey: 'k1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const uncertain: VideoJobRecord = {
      ...submitted,
      id: 'job-uncertain',
      shotId: 'shot-03',
      status: 'submit-uncertain',
      remoteJobId: undefined,
      idempotencyKey: 'k2',
    };
    const submitting: VideoJobRecord = {
      ...uncertain,
      id: 'job-submitting',
      status: 'submitting',
      remoteJobId: undefined,
      idempotencyKey: 'k3',
    };
    await saveVideoJob(submitted);
    await saveVideoJob(uncertain);
    await saveVideoJob(submitting);
    useVideo.setState({ jobs: [] });
    await useVideo.getState().recoverJobs();
    const jobs = useVideo.getState().jobs;
    expect(jobs.find((j) => j.id === 'job-submitted')?.status).toBe('submitted');
    expect(jobs.find((j) => j.id === 'job-uncertain')?.status).toBe('submit-uncertain');
    expect(jobs.find((j) => j.id === 'job-submitting')?.status).toBe('submit-uncertain');
  });

  it('提交网络错误进入 submit-uncertain，不自动重试', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const result = await useVideo.getState().submitVideo('shot-02', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('连不上本地视频服务');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(useVideo.getState().jobs[0]?.status).toBe('submit-uncertain');
  });

  it('轮询 429 保留任务并写入退避时间', async () => {
    const snapshot: VideoProfile = {
      id: 'custom:video:skyreels-test',
      name: 'SkyReels 本地',
      provider: '自定义',
      baseUrl: 'http://127.0.0.1:8110/v1',
      model: 'skyreels-v3-r2v',
      protocol: 'openai-videos',
      requiresKey: false,
      timeoutMs: 1_200_000,
      capabilities: {
        maxReferenceImages: 4,
        durationSeconds: 5,
        resolution: '480P',
        aspectFollowsFirstReference: true,
        supportsReferenceImages: true,
        requiresKey: false,
        maxTimeoutMs: 1_200_000,
      },
    };
    const submitted: VideoJobRecord = {
      id: 'job-429',
      projectId: sampleProject.id,
      shotId: 'shot-02',
      profileId: 'custom:video:skyreels-test',
      profileSnapshot: snapshot,
      referenceAssetIds: ['asset-first'],
      prompt: 'p',
      seconds: 5,
      resolution: '480P',
      status: 'submitted',
      remoteJobId: 'remote-429',
      idempotencyKey: 'k',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    useVideo.setState({ jobs: [submitted] });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: '队列已满' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await useVideo.getState().pollActiveJobs({ fetchImpl });
    const job = useVideo.getState().jobs[0]!;
    expect(job.status).toBe('submitted');
    expect(job.pollFailures).toBe(1);
    expect(job.nextPollAt).toBeTruthy();
    expect(job.error).toContain('队列已满');
  });

  it('stopWaiting 本地停止；getClip/deleteClip 生效', async () => {
    const { fetchImpl } = fakeFetch();
    await useVideo.getState().submitVideo('shot-02', { fetchImpl });
    await useVideo.getState().pollActiveJobs({ fetchImpl });
    const job = useVideo.getState().jobs[0]!;
    await useVideo.getState().stopWaiting(job.id);
    expect(useVideo.getState().jobs[0]?.status).toBe('canceled');
    const clip = await useVideo.getState().getClip('shot-02');
    expect(clip).toBeTruthy();
    await useVideo.getState().deleteClip('shot-02');
    expect(await useVideo.getState().getClip('shot-02')).toBeUndefined();
  });

  it('submitVideo 接收 UI 参考图顺序；非法首帧/重复/超限拒绝', async () => {
    const second: Asset = {
      ...firstFrame,
      id: 'asset-second',
      kind: 'character-sheet-face',
      refId: 'ch-linchong',
      dataUrl: 'data:image/png;base64,SECOND',
    };
    const third: Asset = {
      ...firstFrame,
      id: 'asset-third',
      kind: 'scene-plate',
      refId: 'sc-field',
      dataUrl: 'data:image/png;base64,THIRD',
    };
    const fourth: Asset = { ...firstFrame, id: 'asset-fourth', kind: 'end-frame', refId: 'shot-02' };
    const fifth: Asset = { ...firstFrame, id: 'asset-fifth', kind: 'action-peak', refId: 'shot-02' };
    await saveAssets([second, third, fourth, fifth]);
    let body: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'remote-order', status: 'queued' }), { status: 202 });
    });
    const result = await useVideo.getState().submitVideo('shot-02', {
      fetchImpl,
      referenceAssetIds: ['asset-first', 'asset-third', 'asset-second'],
    });
    expect(result.ok).toBe(true);
    expect(result.job?.referenceAssetIds).toEqual(['asset-first', 'asset-third', 'asset-second']);
    const capturedBody = body as Record<string, unknown> | null;
    expect((capturedBody?.image_reference as { image_url: string }[]).map((item) => item.image_url)).toEqual([
      'data:image/png;base64,FIRST',
      'data:image/png;base64,THIRD',
      'data:image/png;base64,SECOND',
    ]);
    // 清掉活动任务，单独验证后面的非法顺序（否则会被同镜锁挡住）
    useVideo.setState({ jobs: [] });
    const badFirst = await useVideo.getState().submitVideo('shot-02', {
      fetchImpl,
      referenceAssetIds: ['asset-third', 'asset-first'],
    });
    expect(badFirst.ok).toBe(false);
    expect(badFirst.error).toContain('首帧');
    const duplicate = await useVideo.getState().submitVideo('shot-02', {
      fetchImpl,
      referenceAssetIds: ['asset-first', 'asset-first'],
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toContain('重复');
    const tooMany = await useVideo.getState().submitVideo('shot-02', {
      fetchImpl,
      referenceAssetIds: ['asset-first', 'asset-second', 'asset-third', 'asset-fourth', 'asset-fifth'],
    });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.error).toContain('1–4');
  });

  it('两个并发 submitVideo 同镜只创建 1 个 job、只 POST 一次', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const [first, second] = await Promise.all([
      useVideo.getState().submitVideo('shot-02', { fetchImpl }),
      useVideo.getState().submitVideo('shot-02', { fetchImpl }),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(useVideo.getState().jobs).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('POST:'))).toHaveLength(1);
  });

  it('旧 job 没有 profileSnapshot 时仍按原 profileId 精确解析并完成', async () => {
    writeCustomModelConfigs([videoConfig]);
    const oldJob: VideoJobRecord = {
      id: 'legacy-job',
      projectId: sampleProject.id,
      shotId: 'shot-02',
      profileId: 'custom:video:skyreels-test',
      referenceAssetIds: ['asset-first'],
      prompt: 'p',
      seconds: 5,
      resolution: '480P',
      status: 'submitted',
      remoteJobId: 'remote-legacy',
      idempotencyKey: 'legacy',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    useVideo.setState({ jobs: [oldJob] });
    const { fetchImpl } = fakeFetch();
    await useVideo.getState().pollActiveJobs({ fetchImpl });
    expect(useVideo.getState().jobs[0]?.status).toBe('saved');
    expect(useVideo.getState().jobs[0]?.remoteJobId).toBe('remote-legacy');
  });

  it('两个并发 pollActiveJobs 同一 completed 任务只下载一次 content', async () => {
    const { fetchImpl, calls } = fakeFetch();
    await useVideo.getState().submitVideo('shot-02', { fetchImpl });
    await Promise.all([
      useVideo.getState().pollActiveJobs({ fetchImpl }),
      useVideo.getState().pollActiveJobs({ fetchImpl }),
    ]);
    expect(calls.filter((call) => call.includes('/content'))).toHaveLength(1);
    expect(useVideo.getState().jobs[0]?.status).toBe('saved');
  });

  it('档案被删除后 poll 用 job 快照，不回退其它视频档案', async () => {
    const { fetchImpl } = fakeFetch();
    await useVideo.getState().submitVideo('shot-02', { fetchImpl });
    expect(useVideo.getState().jobs[0]?.profileSnapshot?.baseUrl).toBe('http://127.0.0.1:8110/v1');
    useSettings.setState({ customModels: [], keys: {} });
    await useVideo.getState().pollActiveJobs({ fetchImpl });
    expect(useVideo.getState().jobs[0]?.status).toBe('saved');
  });

  it('requiresKey 视频档案没 Key 时提交前拒绝', async () => {
    const guarded = { ...videoConfig, requiresKey: true, id: 'video-guarded', capabilities: { ...videoConfig.capabilities } };
    useSettings.setState({ customModels: [guarded], keys: {} });
    const fetchImpl = vi.fn();
    const result = await useVideo.getState().submitVideo('shot-02', { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('pruneVideoJobs 同步删除 job 的 output clip', async () => {
    const oldClip: VideoClipRecord = {
      id: 'old-clip',
      projectId: sampleProject.id,
      shotId: 'shot-02',
      remoteJobId: 'r-old',
      blob: new Blob(['old']),
      mimeType: 'video/mp4',
      width: 480,
      height: 848,
      duration: 5,
      fps: 24,
      promptSnapshot: 'p',
      model: 'skyreels-v3-r2v',
      createdAt: new Date().toISOString(),
      byteSize: 3,
    };
    const oldJob: VideoJobRecord = {
      id: 'old-job',
      projectId: sampleProject.id,
      shotId: 'shot-02',
      profileId: videoConfig.id,
      referenceAssetIds: [],
      prompt: 'p',
      seconds: 5,
      resolution: '480P',
      status: 'saved',
      remoteJobId: 'r-old',
      outputClipId: 'old-clip',
      idempotencyKey: 'k-old',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveVideoClip(oldClip);
    await saveVideoJob(oldJob);
    await pruneVideoJobs(0);
    expect(await getDb().videoJobs.get('old-job')).toBeUndefined();
    expect(await getDb().videoClips.get('old-clip')).toBeUndefined();
  });

  it('替换 clip 的事务失败时旧 clip 保留', async () => {
    const oldClip: VideoClipRecord = {
      id: 'atomic-old',
      projectId: sampleProject.id,
      shotId: 'shot-02',
      remoteJobId: 'r-old',
      blob: new Blob(['old']),
      mimeType: 'video/mp4',
      width: 480,
      height: 848,
      duration: 5,
      fps: 24,
      promptSnapshot: 'p',
      model: 'skyreels-v3-r2v',
      createdAt: new Date().toISOString(),
      byteSize: 3,
    };
    await saveVideoClip(oldClip);
    const newClip: VideoClipRecord = { ...oldClip, id: 'atomic-new', remoteJobId: 'r-new', blob: new Blob(['new!']) };
    await expect(
      saveVideoClipReplacingShot(null as unknown as VideoJobRecord, newClip),
    ).rejects.toBeTruthy();
    expect(await getDb().videoClips.get('atomic-old')).toBeDefined();
  });

  it('两个项目同 shotId：clips 按 projectId 独立，项目切换不串', async () => {
    const projectB = { ...structuredClone(sampleProject), id: 'project-b' };
    const snapshot: VideoProfile = {
      id: 'custom:video:skyreels-test',
      name: 'SkyReels 本地',
      provider: '自定义',
      baseUrl: 'http://127.0.0.1:8110/v1',
      model: 'skyreels-v3-r2v',
      protocol: 'openai-videos',
      requiresKey: false,
      timeoutMs: 1_200_000,
      capabilities: {
        maxReferenceImages: 4,
        durationSeconds: 5,
        resolution: '480P',
        aspectFollowsFirstReference: true,
        supportsReferenceImages: true,
        requiresKey: false,
        maxTimeoutMs: 1_200_000,
      },
    };
    const baseJob: VideoJobRecord = {
      id: 'job-a',
      projectId: sampleProject.id,
      shotId: 'shot-02',
      profileId: snapshot.id,
      profileSnapshot: snapshot,
      referenceAssetIds: ['asset-first'],
      prompt: 'p',
      seconds: 5,
      resolution: '480P',
      status: 'submitted',
      remoteJobId: 'remote-a',
      idempotencyKey: 'a',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const jobB: VideoJobRecord = { ...baseJob, id: 'job-b', projectId: projectB.id, remoteJobId: 'remote-b', idempotencyKey: 'b' };
    useAppStore.setState({ project: structuredClone(sampleProject) });
    useVideo.setState({ jobs: [baseJob, jobB], clips: {} });
    const { fetchImpl } = fakeFetch();
    await useVideo.getState().pollActiveJobs({ fetchImpl });
    const keyA = videoClipKey(sampleProject.id, 'shot-02');
    const keyB = videoClipKey(projectB.id, 'shot-02');
    expect(useVideo.getState().clips[keyA]?.projectId).toBe(sampleProject.id);
    expect(useVideo.getState().clips[keyB]?.projectId).toBe(projectB.id);
    expect(useVideo.getState().clips[keyA]?.id).not.toBe(useVideo.getState().clips[keyB]?.id);
    const clipA = await useVideo.getState().getClip(sampleProject.id, 'shot-02');
    const clipB = await useVideo.getState().getClip(projectB.id, 'shot-02');
    expect(clipA?.projectId).toBe(sampleProject.id);
    expect(clipB?.projectId).toBe(projectB.id);

    useAppStore.setState({ project: structuredClone(projectB) });
    const switched = await useVideo.getState().getClip('shot-02');
    expect(switched?.projectId).toBe(projectB.id);
  });

  it('旧缓存 shotId key 只在当前项目回退，换项目不串', async () => {
    const projectB = { ...structuredClone(sampleProject), id: 'project-b' };
    const legacyClip: VideoClipRecord = {
      id: 'legacy-clip',
      projectId: sampleProject.id,
      shotId: 'shot-02',
      remoteJobId: 'legacy-remote',
      blob: new Blob(['old']),
      mimeType: 'video/mp4',
      width: 480,
      height: 848,
      duration: 5,
      fps: 24,
      promptSnapshot: 'p',
      model: 'skyreels-v3-r2v',
      createdAt: new Date().toISOString(),
      byteSize: 3,
    };
    useAppStore.setState({ project: structuredClone(sampleProject) });
    useVideo.setState({ jobs: [], clips: { 'shot-02': legacyClip } });
    expect((await useVideo.getState().getClip(sampleProject.id, 'shot-02'))?.id).toBe('legacy-clip');
    useAppStore.setState({ project: structuredClone(projectB) });
    expect(await useVideo.getState().getClip(projectB.id, 'shot-02')).toBeUndefined();
  });

  it('参考图语义：显式 1 张严格发 1 张；3 张按序发 3 张；不传默认与 helper 一致', async () => {
    const second: Asset = {
      ...firstFrame,
      id: 'asset-second',
      kind: 'character-sheet-face',
      refId: 'ch-linchong',
      dataUrl: 'data:image/png;base64,SECOND',
    };
    const third: Asset = {
      ...firstFrame,
      id: 'asset-third',
      kind: 'scene-plate',
      refId: 'sc-field',
      dataUrl: 'data:image/png;base64,THIRD',
    };
    const fourth: Asset = { ...firstFrame, id: 'asset-end', kind: 'end-frame', dataUrl: 'data:image/png;base64,END' };
    await saveAssets([second, third, fourth]);
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: `remote-${bodies.length}`, status: 'queued' }), { status: 202 });
    });

    const one = await useVideo.getState().submitVideo('shot-02', {
      fetchImpl,
      referenceAssetIds: ['asset-first'],
    });
    expect(one.ok).toBe(true);
    expect((bodies[0]?.image_reference as unknown[]).length).toBe(1);
    expect(one.job?.referenceAssetIds).toEqual(['asset-first']);
    useVideo.setState({ jobs: [] });

    const three = await useVideo.getState().submitVideo('shot-02', {
      fetchImpl,
      referenceAssetIds: ['asset-first', 'asset-third', 'asset-second'],
    });
    expect(three.ok).toBe(true);
    expect((bodies[1]?.image_reference as unknown[]).length).toBe(3);
    expect(three.job?.referenceAssetIds).toEqual(['asset-first', 'asset-third', 'asset-second']);
    useVideo.setState({ jobs: [] });

    const assets = await getDb().assets.where('projectId').equals(sampleProject.id).toArray();
    const expectedDefault = defaultReferenceAssetIds(sampleProject.shots.find((s) => s.id === 'shot-02')!, sampleProject, assets);
    const fallback = await useVideo.getState().submitVideo('shot-02', { fetchImpl });
    expect(fallback.ok).toBe(true);
    expect(fallback.job?.referenceAssetIds).toEqual(expectedDefault);
    expect((bodies[2]?.image_reference as unknown[]).length).toBe(expectedDefault.length);
  });

  it('轮询间隔常量符合 10s/30s 约定', () => {
    expect(POLL_VISIBLE_MS).toBe(10_000);
    expect(POLL_HIDDEN_MS).toBe(30_000);
  });
});
