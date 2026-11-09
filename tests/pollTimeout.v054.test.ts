import { describe, expect, it, vi } from 'vitest';
import { generateImages } from '../src/services/image/generate';
import { MODEL_PROFILES } from '../src/data/models/profiles';

/**
 * 异步出图轮询的超时（v0.54 · P2-2）
 *
 * ===========================================================================
 * 为什么单独测这一条
 * ===========================================================================
 * `pollDashScopeTask` 里的 GET 原来既没有 signal 也没有超时。
 * 网络半断时它会永久 pending，而外层的「总时限 3 分钟」判断根本轮不到执行。
 * 现在每次查询都有 30 秒超时，并且响应读取也走网关那套长度上限。
 *
 * 用 fake timers 模拟：任务创建成功 → 第一次状态查询永远不返回 → 应当按超时结束。
 */

const qwen = MODEL_PROFILES.find((profile) => profile.id === 'qwen-image')!;
const asyncProfile = { ...qwen, apiFlavor: 'dashscope-async' as const };

describe('异步任务轮询 · 单次查询悬挂', () => {
  it('**查询 GET 永不返回时，按超时失败并给出人话**', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        call += 1;
        if (call === 1) {
          // 任务创建：立刻返回 task_id
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({ output: { task_id: 'task-1', task_status: 'PENDING' } }),
          } as unknown as Response;
        }
        // 状态查询：头到了，body 永不返回，只有 abort 才结束
        return {
          ok: true,
          status: 200,
          text: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              );
            }),
        } as unknown as Response;
      }) as unknown as typeof fetch;

      const pending = generateImages({
        profile: asyncProfile,
        apiKey: 'sk-test',
        req: { prompt: '一只猫', aspectRatio: '1:1' },
        fetchImpl,
      });

      // 轮询间隔 3s；单次查询超时 30s
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(30_000);

      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain('超时');
      expect(outcome.error).toContain('控制台');
    } finally {
      vi.useRealTimers();
    }
  });
});
