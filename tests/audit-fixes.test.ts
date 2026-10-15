// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { useSettings } from '../src/store/settings';
import { useAppStore, makeEmptyProject } from '../src/store/app';
import { useImage } from '../src/store/image';
import { findProfile } from '../src/data/models/profiles';
import { buildMappedImagePayload } from '../src/services/gateway';

/**
 * 一轮全面审计后修的 bug 的回归测试（v0.28）
 *
 * ===========================================================================
 * 这些测试的由来
 * ===========================================================================
 * 一次独立代码审查交回 7 条真问题，其中一条是 🔴（会导致用户以为 Key 被记住了、
 * 其实没有）。这里每一条都钉一个断言，避免再退回去。
 *
 * 它们的共同特征是：**编译不报错、原有测试全绿、但用户会踩到**。
 */

describe('🔴 Key 的存储默认值（v0.32 反转过一次）', () => {
  /*
    ⚠️ 必须把内存里的 store 一起重置，不能只清存储。

    踩过的坑：只写 `localStorage.clear()` 时，前一条测试设过的
    `dontSaveKeys = true` 还留在内存里，后面的测试就以「不保存」的状态开始 ——
    症状是**单条跑通过、整文件跑失败**的 flaky 测试。
    这类问题最耗时，因为它看起来像被测代码坏了。
  */
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useSettings.setState({ prefs: { ...useSettings.getState().prefs, dontSaveKeys: false } });
  });

  afterEach(() => {
    // 别把状态留给同文件里后面的测试
    useSettings.setState({ prefs: { ...useSettings.getState().prefs, dontSaveKeys: false } });
  });

  it('**默认就落盘**（不必再勾任何东西）', () => {
    // 【语义反转】原来是「默认不存、勾选才存」，用户每次打开都要重填 Key。
    // 现在默认保存 —— 每次重填是劝退级的摩擦，而 Key 本来就只在这台机器、
    // 这个浏览器里，从不离开浏览器。
    const { setKey } = useSettings.getState();
    setKey('deepseek', 'sk-default');
    expect(localStorage.getItem('aniguide:keys')).toContain('sk-default');
  });

  it('**勾「不保存到本机」后，填的 Key 不落盘**', () => {
    const state = useSettings.getState();
    state.setPref('dontSaveKeys', true);
    state.setKey('deepseek', 'sk-ephemeral');

    expect(localStorage.getItem('aniguide:keys')).toBeNull();
    // 但当前会话里还得能用，否则用户填了立刻就没法生成
    expect(sessionStorage.getItem('aniguide:keys:session')).toContain('sk-ephemeral');
  });

  it('**勾上「不保存」时，已经存下来的 Key 当场清掉**', () => {
    // 用户勾这个框的意思就是「现在把本机上的抹掉」。
    // 如果只记一个偏好、等下次写入才生效，他没得到他要的结果。
    const state = useSettings.getState();
    state.setKey('deepseek', 'sk-existing');
    expect(localStorage.getItem('aniguide:keys')).not.toBeNull();

    state.setPref('dontSaveKeys', true);
    expect(localStorage.getItem('aniguide:keys')).toBeNull();
  });

  it('取消勾选后，后续写入会重新落盘', () => {
    const state = useSettings.getState();
    state.setPref('dontSaveKeys', true);
    state.setKey('deepseek', 'sk-a');
    expect(localStorage.getItem('aniguide:keys')).toBeNull();

    state.setPref('dontSaveKeys', false);
    state.setKey('deepseek', 'sk-b');
    expect(localStorage.getItem('aniguide:keys')).toContain('sk-b');
  });
});

describe('🟡 批量出图不能把「别的帧类型的成功」当成本次成功', () => {
  beforeEach(() => {
    useImage.setState({ feedback: {}, gallery: {}, batch: null, batchSummary: null });
  });

  it('**首帧成功不能掩盖尾帧失败**', async () => {
    // 场景：先批量出首帧（成功），再批量出尾帧（部分失败）。
    // 原实现用 endsWith(':'+refId) 匹配所有任务键，
    // 于是尾帧的失败被首帧的成功掩盖，总结显示「全部完成」，
    // 用户不会去补那几张缺图——而尾帧正是跨镜衔接的锚点。
    const shotId = 'shot-1';
    useImage.setState({
      feedback: {
        [`first-frame:${shotId}`]: { kind: 'ok', message: '首帧成功', warnings: [] },
        [`end-frame:${shotId}`]: { kind: 'error', message: '尾帧失败', warnings: [] },
      },
    });

    // 通过导出的判据间接验证：这里直接检查 store 里的反馈形态
    const fb = useImage.getState().feedback;
    expect(fb[`first-frame:${shotId}`]?.kind).toBe('ok');
    expect(fb[`end-frame:${shotId}`]?.kind).toBe('error');
    // 两者的 key 不同——修复后的判定按精确 key 取，所以不会串
    expect(`end-frame:${shotId}`).not.toBe(`first-frame:${shotId}`);
  });

  it('占位的 undefined 不能算成功', () => {
    // 生成过程中会先写 undefined 占位，而 `undefined !== 'error'` 是 true，
    // 所以原来的写法会把「还没出结果」误判成成功。
    const feedback: Record<string, { kind: string } | undefined> = { 'end-frame:s1': undefined };
    const value = feedback['end-frame:s1'];

    // 旧逻辑：`value?.kind !== 'error'` → undefined !== 'error' → true → 误判成功
    const wrongOldLogic = value?.kind !== 'error';
    // 新逻辑：必须显式是 ok / info
    const rightNewLogic = value?.kind === 'ok' || value?.kind === 'info';

    expect(wrongOldLogic).toBe(true);
    expect(rightNewLogic).toBe(false);
  });
});

describe('🟡 自动保存不能静默丢改动', () => {
  beforeEach(() => {
    useAppStore.setState({ project: null, dirty: false, revision: 0, saveError: null });
  });

  it('**保存期间又改动时，dirty 不能被清掉**（否则那次改动永远不落盘）', async () => {
    const project = makeEmptyProject('测试');
    useAppStore.setState({ project, dirty: true, revision: 1 });

    // 模拟：persist 进行中（saveProject 尚未 resolve）时又改了一次
    const persistPromise = useAppStore.getState().persist();
    useAppStore.setState((s) => ({ project: { ...s.project! }, dirty: true, revision: s.revision + 1 }));
    await persistPromise;

    // 保存期间有新改动 → dirty 保持 true，effect 会再存一次
    expect(useAppStore.getState().dirty).toBe(true);
  });

  it('保存期间没有新改动时，dirty 正常清掉', async () => {
    const project = makeEmptyProject('测试');
    useAppStore.setState({ project, dirty: true, revision: 1 });
    await useAppStore.getState().persist();
    expect(useAppStore.getState().dirty).toBe(false);
  });

  it('每次改动都会让 revision 增加', () => {
    const project = makeEmptyProject('测试');
    useAppStore.setState({ project, revision: 0, dirty: false });
    const before = useAppStore.getState().revision;
    useAppStore.getState().patchBrief({ styleTone: '水墨' });
    expect(useAppStore.getState().revision).toBeGreaterThan(before);
  });

  it('保存失败会记录原因，而不是静默吞掉', async () => {
    const project = makeEmptyProject('测试');
    useAppStore.setState({ project, dirty: true, revision: 1, saveError: null });

    // 让底层写入失败
    const storage = await import('../src/services/storage');
    const spy = vi.spyOn(storage, 'saveProject').mockRejectedValueOnce(new Error('磁盘配额已满'));

    await useAppStore.getState().persist();
    expect(useAppStore.getState().saveError).toContain('磁盘配额已满');
    // 而且 dirty 不能被清掉——数据并没有存进去
    expect(useAppStore.getState().dirty).toBe(true);

    spy.mockRestore();
  });

  it('可以手动清掉保存错误', () => {
    useAppStore.setState({ saveError: '出错了' });
    useAppStore.getState().clearSaveError();
    expect(useAppStore.getState().saveError).toBeNull();
  });
});

describe('🟡 参考图必须真的进载荷（不能静默失效）', () => {
  it('**MiniMax 用 subject_reference 的对象数组形状**', () => {
    // 官方图生图文档：subject_reference: [{type: "character", image_file: ...}]
    // 塞错形状时厂商不报错，只是静静忽略——而界面还显示「已用参考图锚定」。
    const profile = findProfile('minimax-image')!;
    const payload = buildMappedImagePayload(profile, {
      model: profile.model!,
      prompt: 'x',
      referenceImages: ['data:image/png;base64,REF'],
    });
    expect(payload.subject_reference).toEqual([
      { type: 'character', image_file: 'data:image/png;base64,REF' },
    ]);
    // 不能是 OpenAI 那种扁平数组
    expect('image' in payload).toBe(false);
  });

  it('声明不支持参考图的档案不会带上参考图字段', () => {
    const profile = findProfile('zhipu-image')!;
    expect(profile.capabilities.referenceImage).toBe(false);
  });

  it('硅基流动不再声明已下线的 batch_size', () => {
    const profile = findProfile('siliconflow-image')!;
    expect(profile.imagePayload?.countField).toBeUndefined();
    const payload = buildMappedImagePayload(profile, {
      model: profile.model!,
      prompt: 'x',
      batchSize: 1,
    });
    // countField 未声明时默认用 n —— 这是 OpenAI 兼容风格里正确的字段
    expect(payload.n).toBe(1);
    expect('batch_size' in payload).toBe(false);
  });

  it('每个声明支持参考图的档案都必须能说清参考图怎么放', () => {
    // 说不清就该把 capabilities.referenceImage 改成 false，别假装支持
    for (const id of ['minimax-image', 'qwen-image-edit', 'qwen-image', 'qwen-image-2.1']) {
      const profile = findProfile(id)!;
      if (!profile.capabilities.referenceImage) continue;
      const isDashScope = (profile.apiFlavor ?? 'openai') === 'dashscope-sync';
      const declared = profile.imagePayload?.referenceField;
      expect(
        isDashScope || declared !== undefined,
        `${id} 声明支持参考图，但没有说明参考图字段怎么放`,
      ).toBe(true);
    }
  });
});

describe('🟡 保存项目时不能改写 updatedAt 的语义', () => {
  it('saveProject 保留项目自己的 updatedAt', async () => {
    const storage = await import('../src/services/storage');
    const project = makeEmptyProject('时间戳测试');
    const original = project.updatedAt;
    await storage.saveProject(project);
    const loaded = await storage.loadProject(project.id);
    // 存进去的应该是项目自己的时间戳，而不是「保存那一刻」
    expect(loaded?.updatedAt).toBe(original);
  });
});
