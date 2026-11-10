import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * id 生成从 Math.random 换成 crypto.randomUUID（v0.55 · P3-15）
 *
 * 本地 id 不是安全边界，但 Math.random 可预测、碰撞概率也更差；
 * 浏览器原生 `crypto.randomUUID()` 没有理由不用。测试桩/极老环境没有它时
 * 必须仍能退回 Math.random，不能因为缺 API 就崩。
 *
 * 批次 5 做这轮改造时，实际的 id 生成点有 3 处（各自是文件内私有函数）：
 *  1. `src/services/storage/index.ts` 的 `newId`（唯一导出的通用入口，被 pages/mapping 大量使用）；
 *  2. `src/store/chat.ts` 的 `newId`（对话气泡 u-/a-）；
 *  3. `src/domain/chat/edits.ts` 的 `newId`（聊天改稿新建的对象 char-/scene-/shot-）。
 * 复验时提到 `store/image.ts`：它没有本地 id 生成器，出图相关记录直接复用
 * 调用方传入的 id / storage 的 newId，所以这一轮没有需要单独测的改造点
 * ——下面有一条静态守卫把「改造点清单」钉住，避免以后新增一处却没人覆盖。
 *
 * 三处私有函数都无法直接 import，所以测试走**对外入口**：
 * storage 直接调 newId；chat 走 store 的 `ask`（未配置 Key 的分支会同步造两条气泡）；
 * edits 走 `applyChatEdits` 的 create 操作。
 */

const mocks = vi.hoisted(() => ({ buildGenerateContext: vi.fn() }));

vi.mock('../src/services/llm/readiness', () => ({
  buildGenerateContext: mocks.buildGenerateContext,
}));

import { newId } from '../src/services/storage';
import { applyChatEdits, type ChatEditProposal } from '../src/domain/chat/edits';
import { useChat } from '../src/store/chat';
import { makeEmptyProject, useAppStore } from '../src/store/app';

const REPO_ROOT = path.resolve(__dirname, '..');

function walkFiles(dir: string, extensions: string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walkFiles(full, extensions);
    return extensions.some((ext) => full.endsWith(ext)) ? [full] : [];
  });
}

function createCharacterEdit(): ChatEditProposal {
  return {
    id: 'edit-create-character',
    op: 'create',
    title: '新建角色「林冲」',
    reason: '故事里出现了新角色。',
    target: { kind: 'character' },
    before: '（新建）',
    after: '',
    createFields: { name: '林冲', 'identity.summaryEn': 'a lean swordsman in a dark cloak' },
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  mocks.buildGenerateContext.mockReset();
  // 未配置模型：chat store 的 ask 会在本地同步造出「用户 + 助手」两条气泡，不真的发请求
  mocks.buildGenerateContext.mockReturnValue({ error: '还没有配置模型。' });
  useAppStore.setState({
    project: makeEmptyProject('id 测试'),
    report: null,
    dirty: false,
    revision: 0,
    saveError: null,
  });
  useChat.setState({ bubbles: [], pending: false, draft: '', notice: null });
});

describe('storage.newId · 通用入口', () => {
  it('格式稳定：prefix + 时间戳 + 随机后缀', () => {
    const id = newId('char');
    expect(id).toMatch(/^char-[a-z0-9]+$/);
    expect(id.length).toBeGreaterThan('char-'.length + 6);
  });

  it('连续生成不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId('shot')));
    expect(ids.size).toBe(200);
  });

  it('**没有 crypto.randomUUID 时退回 Math.random，仍然可用**', () => {
    vi.stubGlobal('crypto', {});
    try {
      const id = newId('scene');
      expect(id).toMatch(/^scene-[a-z0-9]+$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('store/chat.ts · 对话气泡的本地 newId', () => {
  it('**气泡 id 走 crypto.randomUUID 改造后的生成器**，且互不重复', async () => {
    await useChat.getState().ask('帮我把第三镜改紧张一点');
    const first = useChat.getState().bubbles.map((bubble) => bubble.id);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatch(/^u-[a-z0-9]+$/);
    expect(first[1]).toMatch(/^a-[a-z0-9]+$/);

    await useChat.getState().ask('再短一点');
    const all = useChat.getState().bubbles.map((bubble) => bubble.id);
    expect(all).toHaveLength(4);
    expect(new Set(all).size).toBe(all.length);
  });

  it('**无 crypto 的 fallback 分支**：气泡 id 仍然可用且格式稳定', async () => {
    vi.stubGlobal('crypto', {});
    try {
      await useChat.getState().ask('随便问一句');
      const ids = useChat.getState().bubbles.map((bubble) => bubble.id);
      expect(ids[0]).toMatch(/^u-[a-z0-9]+$/);
      expect(ids[1]).toMatch(/^a-[a-z0-9]+$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('domain/chat/edits.ts · 聊天改稿新建对象的本地 newId', () => {
  it('**新建角色 id 走改造后的生成器**（char- 前缀）', () => {
    const result = applyChatEdits(makeEmptyProject('id 测试'), [createCharacterEdit()]);
    expect(result.applied).toBe(1);
    expect(result.project.characters).toHaveLength(1);
    expect(result.project.characters[0]!.id).toMatch(/^char-[a-z0-9]+$/);
  });

  it('**无 crypto 的 fallback 分支**：新建对象 id 仍然可用', () => {
    vi.stubGlobal('crypto', {});
    try {
      const result = applyChatEdits(makeEmptyProject('id 测试'), [createCharacterEdit()]);
      expect(result.project.characters[0]!.id).toMatch(/^char-[a-z0-9]+$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('改造点清单守卫', () => {
  it('**全 src 只有这 3 处 crypto.randomUUID**（新增一处就要在这里补覆盖）', () => {
    const sites = walkFiles(path.join(REPO_ROOT, 'src'), ['.ts', '.tsx'])
      .filter((file) => readFileSync(file, 'utf8').includes('crypto.randomUUID'))
      .map((file) => path.relative(REPO_ROOT, file).replace(/\\/g, '/'))
      .sort();
    expect(sites).toEqual([
      'src/domain/chat/edits.ts',
      'src/services/storage/index.ts',
      'src/store/chat.ts',
    ]);
  });

  it('store/image.ts 里没有本地随机 id（所以无需单独覆盖）', () => {
    const text = readFileSync(path.join(REPO_ROOT, 'src/store/image.ts'), 'utf8');
    expect(text).not.toContain('crypto.randomUUID');
    expect(text).not.toContain('Math.random');
  });
});
