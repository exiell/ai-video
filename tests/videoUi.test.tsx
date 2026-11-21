// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { Asset } from '../src/types/model';
import type { VideoClipRecord, VideoJobRecord } from '../src/types/video';
import { sampleProject } from '../src/data/samples/sampleProject';
import { useAppStore } from '../src/store/app';
import { useImage } from '../src/store/image';
import { useVideo, videoClipKey } from '../src/store/video';
import { VideoPanel } from '../src/components/VideoPanel';
import { VideoPlayer } from '../src/components/VideoPlayer';
import { VideoJobStrip } from '../src/components/VideoJobStrip';
import { StoryboardPage } from '../src/pages/StoryboardPage';

const storageMocks = vi.hoisted(() => ({ listAssets: vi.fn() }));

vi.mock('../src/services/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/storage')>();
  return { ...actual, listAssets: storageMocks.listAssets };
});

const project = structuredClone(sampleProject);
const shot = project.shots[0]!;

function makeAsset(
  id: string,
  kind: Asset['kind'],
  refId: string,
  createdAt: string,
  width = 720,
  height = 1280,
): Asset {
  return {
    id,
    projectId: project.id,
    kind,
    refId,
    dataUrl: `data:image/png;base64,${id}`,
    mimeType: 'image/png',
    width,
    height,
    promptSnapshot: 'p',
    createdAt,
    updatedAt: createdAt,
    schemaVersion: 1,
  };
}

function makeJob(overrides: Partial<VideoJobRecord>): VideoJobRecord {
  return {
    id: 'job-1',
    projectId: project.id,
    shotId: shot.id,
    profileId: 'custom:video:1',
    referenceAssetIds: ['first'],
    prompt: 'p',
    seconds: 5,
    resolution: '480P',
    status: 'running',
    idempotencyKey: 'idem',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeClip(): VideoClipRecord {
  return {
    id: 'clip-1',
    projectId: project.id,
    shotId: shot.id,
    remoteJobId: 'remote-1',
    blob: new Blob(['mp4'], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    width: 480,
    height: 848,
    duration: 5,
    fps: 24,
    promptSnapshot: 'p',
    model: 'skyreels-v3-r2v',
    createdAt: '2026-01-01T00:00:00.000Z',
    byteSize: 3,
  };
}

const initialVideoActions = {
  submitVideo: useVideo.getState().submitVideo,
  stopWaiting: useVideo.getState().stopWaiting,
  deleteClip: useVideo.getState().deleteClip,
  getClip: useVideo.getState().getClip,
  recoverJobs: useVideo.getState().recoverJobs,
};

let container: HTMLDivElement | null = null;

function render(node: React.ReactElement): HTMLDivElement {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  const el = container;
  container = null;
  return el;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(target: Element | null | undefined): void {
  if (!target) return;
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function findButton(el: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    (node.textContent ?? '').trim().includes(text),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  document.body.innerHTML = '';
  storageMocks.listAssets.mockReset();
  storageMocks.listAssets.mockResolvedValue([]);
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
  useImage.setState({ assetCount: 0 });
  useVideo.setState({
    ...initialVideoActions,
    jobs: [],
    clips: {},
    submittingShotId: null,
    lastError: null,
  });
});

describe('VideoPanel：入口与参考图', () => {
  it('没有首帧时按钮禁用，并给提示和跳到三帧的入口', async () => {
    const onJump = vi.fn();
    const el = render(<VideoPanel shot={shot} project={project} onJumpToFrames={onJump} />);
    await flush();

    expect(el.textContent ?? '').toContain('先出这一镜的首帧，视频会从首帧开始动');
    const submit = findButton(el, '生成视频');
    expect(submit?.disabled).toBe(true);
    click(findButton(el, '去下面'));
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('有首帧时显示参考图 1/4、首帧锁定和竖屏画幅，点击提交调用 submitVideo', async () => {
    const submitVideo = vi.fn(async () => ({ ok: true }));
    useVideo.setState({ submitVideo });
    storageMocks.listAssets.mockResolvedValue([
      makeAsset('first', 'first-frame', shot.id, '2026-01-01T00:00:01.000Z'),
    ]);
    const el = render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    await flush();

    const text = el.textContent ?? '';
    expect(text).toContain('参考图 1/4');
    expect(text).toContain('竖屏 480×848');
    expect(el.querySelector('.video-ref .tag')?.textContent).toContain('锁定');
    expect(el.querySelector('.video-ref button[aria-label="移除这张参考图"]')).toBeNull();

    click(findButton(el, '生成视频'));
    await flush();
    // 始终显式传当前选择（默认只有首帧时就是 1 张）
    expect(submitVideo).toHaveBeenCalledWith(shot.id, { referenceAssetIds: ['first'] });
  });

  it('默认显示与核心默认一致；删除/加回/排序后最多 4 张', async () => {
    storageMocks.listAssets.mockResolvedValue([
      makeAsset('first', 'first-frame', shot.id, '2026-01-01T00:00:01.000Z'),
      makeAsset('char', 'character-sheet', 'ch-linchong', '2026-01-01T00:00:02.000Z'),
      makeAsset('scene', 'scene-plate', 'sc-field', '2026-01-01T00:00:03.000Z'),
      makeAsset('peak', 'action-peak', shot.id, '2026-01-01T00:00:04.000Z'),
      makeAsset('end', 'end-frame', shot.id, '2026-01-01T00:00:05.000Z'),
    ]);
    const submitVideo = vi.fn(async () => ({ ok: true }));
    useVideo.setState({ submitVideo });
    const el = render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    await flush();

    // 未动选择器：默认结果和提交一致（首帧 + 角色 + 场景 + 关键帧）
    expect(el.textContent ?? '').toContain('参考图 4/4');
    expect(el.textContent ?? '').toContain('（默认）');

    // 删一个，选择器出现，再加回尾帧（默认只取 4 张，尾帧不在默认里）
    const removes = [...el.querySelectorAll<HTMLButtonElement>('button[aria-label="移除这张参考图"]')];
    click(removes[0]);
    await flush();
    expect(el.textContent ?? '').toContain('参考图 3/4');
    click(findButton(el, '+ 加参考图'));
    click(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
        (node.getAttribute('aria-label') ?? '').includes('尾帧'),
      ),
    );
    await flush();
    expect(el.textContent ?? '').toContain('参考图 4/4');
    expect(el.textContent ?? '').toContain('（已自定义）');
    expect(findButton(el, '+ 加参考图')).toBeUndefined();

    // 第 2–4 张有上移/下移；把最后一个（尾帧）上移一位
    const upButtons = [...el.querySelectorAll<HTMLButtonElement>('button[aria-label="上移这张参考图"]')];
    expect(upButtons.length).toBe(3);
    click(upButtons[2]);
    click(findButton(el, '生成视频'));
    await flush();
    expect(submitVideo).toHaveBeenCalledWith(shot.id, {
      referenceAssetIds: ['first', 'scene', 'end', 'peak'],
    });
  });

  it('同一镜正在生成时按钮禁用并显示已用时间与预计剩余', async () => {
    storageMocks.listAssets.mockResolvedValue([
      makeAsset('first', 'first-frame', shot.id, '2026-01-01T00:00:01.000Z'),
    ]);
    useVideo.setState({
      submitVideo: vi.fn(async () => ({ ok: true })),
      jobs: [makeJob({ status: 'running', elapsedSeconds: 221, progress: 40 })],
    });
    const el = render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    await flush();

    const text = el.textContent ?? '';
    expect(text).toContain('生成中 03:41');
    expect(text).toMatch(/预计还需约 \d+ 分钟/);
    expect(el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40');
    expect(findButton(el, '这一镜正在生成')?.disabled).toBe(true);
    expect(findButton(el, '停止等待')).toBeTruthy();
  });

  it('队列满 4 条时禁用提交并提示', async () => {
    storageMocks.listAssets.mockResolvedValue([
      makeAsset('first', 'first-frame', shot.id, '2026-01-01T00:00:01.000Z'),
    ]);
    useVideo.setState({
      jobs: [1, 2, 3, 4].map((index) =>
        makeJob({
          id: `job-${index}`,
          shotId: project.shots[index]!.id,
          status: 'running',
          createdAt: `2026-01-01T00:00:0${index}.000Z`,
        }),
      ),
    });
    const el = render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    await flush();

    expect(el.textContent ?? '').toContain('排队已满');
    expect(findButton(el, '生成视频')?.disabled).toBe(true);
  });

  it('失败时显示人话与重试按钮；submit-uncertain 不显示重试', async () => {
    storageMocks.listAssets.mockResolvedValue([
      makeAsset('first', 'first-frame', shot.id, '2026-01-01T00:00:01.000Z'),
    ]);
    const submitVideo = vi.fn(async () => ({ ok: true }));
    useVideo.setState({
      submitVideo,
      jobs: [makeJob({ status: 'failed', error: '显卡显存不够，这一条没生成出来。' })],
    });
    const el = render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    await flush();
    expect(el.textContent ?? '').toContain('显卡显存不够');
    click(findButton(el, '重试'));
    await flush();
    expect(submitVideo).toHaveBeenCalledWith(shot.id, { referenceAssetIds: ['first'] });

    useVideo.setState({
      jobs: [makeJob({ status: 'submit-uncertain', error: '提交结果不确定' })],
    });
    const el2 = render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    await flush();
    expect(el2.textContent ?? '').toContain('先刷新确认服务端有没有这条任务');
    expect(findButton(el2, '重试')).toBeUndefined();
  });
});

describe('VideoPlayer：播放、下载、重生成、删除', () => {
  const thirdShot = project.shots[2]!;

  it('渲染 video 与首尾帧对照；下载生成正确文件名并 revoke', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const downloads: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });

    const el = render(
      <VideoPlayer
        clip={{ ...makeClip(), shotId: thirdShot.id }}
        shot={thirdShot}
        firstFrame={makeAsset('first', 'first-frame', thirdShot.id, '2026-01-01T00:00:01.000Z')}
        endFrame={makeAsset('end', 'end-frame', thirdShot.id, '2026-01-01T00:00:02.000Z')}
        onRegenerate={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(el.querySelector('video')).toBeTruthy();
    expect(el.textContent ?? '').toContain('起点 · 首帧');
    expect(el.textContent ?? '').toContain('终点 · 尾帧');

    vi.useFakeTimers();
    click(findButton(el, '下载 MP4'));
    expect(createObjectURL).toHaveBeenCalled();
    expect(downloads[0]).toMatch(/^第03镜_视频_\d{8}\.mp4$/);
    // 立刻 revoke 可能中断下载：必须等 60s 后再回收
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revokeObjectURL).toHaveBeenCalled();

    clickSpy.mockRestore();
  });

  it('重新生成与删除都要二次确认', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:mock'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const onRegenerate = vi.fn();
    const onDelete = vi.fn();
    const el = render(
      <VideoPlayer
        clip={makeClip()}
        shot={shot}
        onRegenerate={onRegenerate}
        onDelete={onDelete}
      />,
    );

    click(findButton(el, '重新生成'));
    expect(document.querySelector('[role="dialog"]')?.textContent ?? '').toContain(
      '重新生成这一镜的视频？',
    );
    click(document.querySelector('.confirm-actions .btn-blue'));
    expect(onRegenerate).toHaveBeenCalledTimes(1);

    click(findButton(el, '删除'));
    expect(document.querySelector('[role="dialog"]')?.textContent ?? '').toContain(
      '删除这一镜的视频？',
    );
    click(document.querySelector('.confirm-actions .btn-blue'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('VideoJobStrip 与分镜页入口', () => {
  it('全局任务条显示任务数、当前进度，点击定位到镜头', () => {
    useVideo.setState({
      jobs: [
        makeJob({ id: 'job-a', shotId: project.shots[0]!.id, status: 'running', elapsedSeconds: 60, progress: 12 }),
        makeJob({ id: 'job-b', shotId: project.shots[1]!.id, status: 'queued', createdAt: '2026-01-01T00:01:00.000Z' }),
      ],
    });
    const onLocate = vi.fn();
    const el = render(<VideoJobStrip onLocate={onLocate} />);
    expect(el.textContent ?? '').toContain('视频任务 2 条');
    expect(el.textContent ?? '').toContain('第 1 镜');
    expect(el.textContent ?? '').toContain('12%');
    click(el.querySelector('.video-job-strip-link'));
    expect(onLocate).toHaveBeenCalledWith(project.shots[0]!.id);
  });

  it('分镜页挂载时恢复任务、拉取成片，并在镜头头部显示视频徽标', async () => {
    const recoverJobs = vi.fn(async () => {});
    const getClip = vi.fn(async () => undefined);
    useVideo.setState({
      recoverJobs,
      getClip,
      clips: { [videoClipKey(project.id, project.shots[0]!.id)]: makeClip() },
    });
    const el = render(
      <MemoryRouter>
        <StoryboardPage />
      </MemoryRouter>,
    );
    await flush();
    expect(recoverJobs).toHaveBeenCalledTimes(1);
    expect(getClip).toHaveBeenCalledWith(project.id, project.shots[0]!.id);
    expect(el.querySelector('.video-badge')).toBeTruthy();
  });
});


describe('参考图 WYSIWYG 与跨项目（task-89）', () => {
  function referenceAssets() {
    return [
      makeAsset('first', 'first-frame', shot.id, '2026-01-01T00:00:01.000Z'),
      makeAsset('char', 'character-sheet', 'ch-linchong', '2026-01-01T00:00:02.000Z'),
      makeAsset('scene', 'scene-plate', 'sc-field', '2026-01-01T00:00:03.000Z'),
      makeAsset('peak', 'action-peak', shot.id, '2026-01-01T00:00:04.000Z'),
    ];
  }

  it('未动选择器时显示张数/顺序与 submitVideo 收到的 assetIds 一致', async () => {
    storageMocks.listAssets.mockResolvedValue(referenceAssets());
    const submitVideo = vi.fn(async () => ({ ok: true }));
    useVideo.setState({ submitVideo });
    const el = render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    await flush();

    expect(el.textContent ?? '').toContain('参考图 4/4');
    click(findButton(el, '生成视频'));
    await flush();
    expect(submitVideo).toHaveBeenCalledWith(shot.id, {
      referenceAssetIds: ['first', 'char', 'scene', 'peak'],
    });
  });

  it('用户删到只剩首帧时，显式只发 1 张（不偷偷补全）', async () => {
    storageMocks.listAssets.mockResolvedValue(referenceAssets());
    const submitVideo = vi.fn(async () => ({ ok: true }));
    useVideo.setState({ submitVideo });
    const el = render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    await flush();

    let removes = [...el.querySelectorAll<HTMLButtonElement>('button[aria-label="移除这张参考图"]')];
    while (removes.length > 0) {
      click(removes[0]);
      await flush();
      removes = [...el.querySelectorAll<HTMLButtonElement>('button[aria-label="移除这张参考图"]')];
    }
    expect(el.textContent ?? '').toContain('参考图 1/4');

    click(findButton(el, '生成视频'));
    await flush();
    expect(submitVideo).toHaveBeenCalledWith(shot.id, { referenceAssetIds: ['first'] });
  });

  it('改变第 2–4 张顺序后，显式提交的 assetIds 顺序也随之变化', async () => {
    storageMocks.listAssets.mockResolvedValue(referenceAssets());
    const submitVideo = vi.fn(async () => ({ ok: true }));
    useVideo.setState({ submitVideo });
    const el = render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    await flush();

    const upButtons = [...el.querySelectorAll<HTMLButtonElement>('button[aria-label="上移这张参考图"]')];
    click(upButtons[1]!); // 场景参考板从第 3 张升到第 2 张
    click(findButton(el, '生成视频'));
    await flush();
    expect(submitVideo).toHaveBeenCalledWith(shot.id, {
      referenceAssetIds: ['first', 'scene', 'char', 'peak'],
    });
  });

  it('核心拒绝参考图时把「首帧必须第 1」的人话显示出来', async () => {
    storageMocks.listAssets.mockResolvedValue([
      makeAsset('first', 'first-frame', shot.id, '2026-01-01T00:00:01.000Z'),
    ]);
    const submitVideo = vi.fn(async () => ({
      ok: false,
      error: '第 1 张必须是本镜首帧，且不能调换顺序。',
    }));
    useVideo.setState({ submitVideo });
    const el = render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    await flush();

    click(findButton(el, '生成视频'));
    await flush();
    expect(el.textContent ?? '').toContain('第 1 张必须是本镜首帧，且不能调换顺序');
  });

  it('两个项目同 shotId 时，不显示另一个项目的视频与任务', async () => {
    const otherProject = {
      ...structuredClone(project),
      id: 'project-other',
      title: '另一个项目',
    };
    storageMocks.listAssets.mockResolvedValue([
      makeAsset('first', 'first-frame', shot.id, '2026-01-01T00:00:01.000Z'),
    ]);
    useVideo.setState({
      clips: { [videoClipKey(project.id, shot.id)]: makeClip() },
      jobs: [
        makeJob({
          id: 'other-job',
          projectId: project.id,
          shotId: shot.id,
          status: 'running',
          elapsedSeconds: 60,
        }),
      ],
    });

    const otherEl = render(
      <VideoPanel shot={shot} project={otherProject} onJumpToFrames={() => {}} />,
    );
    await flush();
    expect(otherEl.querySelector('video')).toBeNull();
    expect(otherEl.textContent ?? '').not.toContain('生成中 01:00');
    expect(findButton(otherEl, '生成视频')).toBeTruthy();

    const ownEl = render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    await flush();
    expect(ownEl.querySelector('video')).toBeTruthy();
    expect(ownEl.textContent ?? '').toContain('生成中 01:00');
  });
});


describe('项目切换隔离（task-89）', () => {
  it('同一组件切换项目后，不沿用上一项目的视频与任务', async () => {
    const otherProject = {
      ...structuredClone(project),
      id: 'project-other',
      title: '另一个项目',
    };
    storageMocks.listAssets.mockResolvedValue([
      makeAsset('first', 'first-frame', shot.id, '2026-01-01T00:00:01.000Z'),
    ]);
    useVideo.setState({
      clips: { [videoClipKey(project.id, shot.id)]: makeClip() },
      jobs: [makeJob({ projectId: project.id, shotId: shot.id, status: 'running', elapsedSeconds: 60 })],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    });
    await flush();
    expect(host.textContent ?? '').toContain('生成中 01:00');
    expect(host.querySelector('video')).toBeTruthy();

    act(() => {
      root.render(<VideoPanel shot={shot} project={otherProject} onJumpToFrames={() => {}} />);
    });
    await flush();
    expect(host.querySelector('video')).toBeNull();
    expect(host.textContent ?? '').not.toContain('生成中 01:00');
    expect(findButton(host, '生成视频')).toBeTruthy();
  });

  it('分镜页只给当前项目的成片显示徽标（两个项目同 shotId）', async () => {
    const otherProject = {
      ...structuredClone(project),
      id: 'project-other',
      title: '另一个项目',
    };
    useVideo.setState({
      recoverJobs: vi.fn(async () => {}),
      getClip: vi.fn(async () => undefined),
      clips: { [videoClipKey(project.id, shot.id)]: makeClip() },
    });

    useAppStore.setState({ project: otherProject, report: null });
    const otherEl = render(
      <MemoryRouter>
        <StoryboardPage />
      </MemoryRouter>,
    );
    await flush();
    expect(otherEl.querySelector('.video-badge')).toBeNull();

    useAppStore.setState({ project: structuredClone(project), report: null });
    const ownEl = render(
      <MemoryRouter>
        <StoryboardPage />
      </MemoryRouter>,
    );
    await flush();
    expect(ownEl.querySelector('.video-badge')).toBeTruthy();
  });

  it('全局任务条只显示当前项目的任务', () => {
    const otherProject = {
      ...structuredClone(project),
      id: 'project-other',
      title: '另一个项目',
    };
    useAppStore.setState({ project: otherProject, report: null });
    useVideo.setState({
      jobs: [makeJob({ projectId: project.id, shotId: shot.id, status: 'running' })],
    });
    const empty = render(<VideoJobStrip onLocate={() => {}} />);
    expect(empty.textContent ?? '').not.toContain('视频任务');

    useAppStore.setState({ project: structuredClone(project), report: null });
    const el = render(<VideoJobStrip onLocate={() => {}} />);
    expect(el.textContent ?? '').toContain('视频任务 1 条');
  });
});


describe('默认参考图追加与下载清理（task-92）', () => {
  it('默认 3 张时加第 4 张，保留默认 3 张并在末尾追加', async () => {
    storageMocks.listAssets.mockResolvedValue([
      makeAsset('first', 'first-frame', shot.id, '2026-01-01T00:00:01.000Z'),
      makeAsset('face', 'character-sheet-face', 'ch-linchong', '2026-01-01T00:00:02.000Z'),
      makeAsset('full', 'character-sheet', 'ch-linchong', '2026-01-01T00:00:03.000Z'),
      makeAsset('scene', 'scene-plate', 'sc-field', '2026-01-01T00:00:04.000Z'),
    ]);
    const submitVideo = vi.fn(async () => ({ ok: true }));
    useVideo.setState({ submitVideo });
    const el = render(<VideoPanel shot={shot} project={project} onJumpToFrames={() => {}} />);
    await flush();
    expect(el.textContent ?? '').toContain('参考图 3/4');

    click(findButton(el, '+ 加参考图'));
    click(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
        (node.getAttribute('aria-label') ?? '').includes('全身多视图'),
      ),
    );
    await flush();
    expect(el.textContent ?? '').toContain('参考图 4/4');

    click(findButton(el, '生成视频'));
    await flush();
    expect(submitVideo).toHaveBeenCalledWith(shot.id, {
      referenceAssetIds: ['first', 'face', 'scene', 'full'],
    });
  }, 15_000);

  it('别的项目还在提交时，当前项目同一 shotId 不应被 submittingShotId 误禁用', async () => {
    const otherProject = { ...structuredClone(project), id: 'project-other', title: '另一个项目' };
    storageMocks.listAssets.mockResolvedValue([
      makeAsset('first', 'first-frame', shot.id, '2026-01-01T00:00:01.000Z'),
    ]);
    useVideo.setState({ submittingShotId: shot.id, jobs: [] });
    const el = render(
      <VideoPanel shot={shot} project={otherProject} onJumpToFrames={() => {}} />,
    );
    await flush();
    const submit = findButton(el, '生成视频');
    expect(submit?.disabled).toBe(false);
    expect(el.textContent ?? '').not.toContain('这一镜正在生成');
  });

  it('下载链接在卸载时统一 revoke，不泄漏 object URL', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.useFakeTimers();

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<VideoPlayer clip={makeClip()} shot={shot} onRegenerate={() => {}} onDelete={() => {}} />);
    });
    click(findButton(host, '下载 MP4'));
    expect(revokeObjectURL).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(revokeObjectURL).toHaveBeenCalled();

    clickSpy.mockRestore();
  });
});
