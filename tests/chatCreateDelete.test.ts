import { describe, expect, it } from 'vitest';
import {
  EDITABLE_FIELDS,
  applyChatEdits,
  buildProjectContext,
  type ChatEditProposal,
  type EditTarget,
} from '../src/domain/chat/edits';
import { normalizeChatReply, chatReplySchema } from '../src/services/llm/chat';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Project } from '../src/types/model';

/**
 * 新增 / 删除 / 全面修改（方案.md §7.6.25）
 *
 * ===========================================================================
 * 这一版扩了三件事，每件都有明确的失败模式
 * ===========================================================================
 * 1. **新建对象** —— id 由代码生成，模型只给内容。
 *    失败模式：模型编 id 撞车或格式不对 → 引用悄悄断掉，界面看不出来。
 * 2. **删除对象** —— 必须级联清理引用。
 *    失败模式：删了角色但镜头里还留着它的 id → 那条引用变悬空，
 *    界面显示成空白，用户不知道是自己删角色造成的。
 * 3. **模型要看得见它有权改的字段**。
 *    失败模式（真实发生过）：白名单和上下文分两处手写，不同步 →
 *    模型「有权改但看不见」→ 用户明确要求改它，AI 完全不动。
 */

function fresh(): Project {
  return structuredClone(sampleProject);
}

function edit(
  partial: Partial<ChatEditProposal> & { target: EditTarget },
): ChatEditProposal {
  return {
    id: 'e1',
    op: 'set',
    title: '测试改动',
    reason: '',
    before: '',
    after: '',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// 核心不变量：白名单与上下文必须同步
// ---------------------------------------------------------------------------

describe('**白名单里每个可改字段，模型都必须看得见**', () => {
  /**
   * 这是本次最重要的测试。
   *
   * 原来的病根就是「白名单」和「上下文」分两处手写：角色的 8 个可改字段里，
   * 模型只能看到 2 个 —— 于是用户说「把角色的脸改成方脸」，AI 完全不动，
   * 因为它根本不知道有 identity.face 这个字段。
   *
   * 现在上下文由 EDITABLE_FIELDS 直接生成，结构上不该再脱节。
   * 这条测试守的就是这个不变量。
   */
  const p = fresh();
  const ctx = buildProjectContext(p);

  it('镜头的全部可改字段都出现在上下文里', () => {
    for (const field of Object.keys(EDITABLE_FIELDS.shot)) {
      // shot 的字段用「字段名」形式出现，例：机位（cameraPosition）
      expect(ctx, `镜头字段 ${field} 没进上下文 —— 模型改不了它`).toContain(field);
    }
  });

  it('角色的全部可改字段都出现在上下文里', () => {
    for (const field of Object.keys(EDITABLE_FIELDS.character)) {
      expect(ctx, `角色字段 ${field} 没进上下文`).toContain(field);
    }
  });

  it('场景的全部可改字段都出现在上下文里', () => {
    for (const field of Object.keys(EDITABLE_FIELDS.scene)) {
      expect(ctx, `场景字段 ${field} 没进上下文`).toContain(field);
    }
  });

  it('故事与规格的可改字段也在上下文里', () => {
    for (const field of Object.keys(EDITABLE_FIELDS.story)) {
      expect(ctx, `故事字段 ${field} 没进上下文`).toContain(field);
    }
    for (const field of Object.keys(EDITABLE_FIELDS.brief)) {
      expect(ctx, `规格字段 ${field} 没进上下文`).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// 新建
// ---------------------------------------------------------------------------

describe('新建对象', () => {
  it('**新建角色：id 由代码生成，内容来自模型**', () => {
    const p = fresh();
    const before = p.characters.length;
    const r = applyChatEdits(p, [
      edit({
        op: 'create',
        target: { kind: 'character' },
        createFields: {
          name: '周薄森',
          'identity.summary': '三十余岁的地方武官',
          'identity.face': '窄脸，薄唇',
        },
      }),
    ]);

    expect(r.applied).toBe(1);
    expect(r.project.characters).toHaveLength(before + 1);
    const made = r.project.characters[r.project.characters.length - 1]!;
    expect(made.name).toBe('周薄森');
    expect(made.identity.face).toBe('窄脸，薄唇');
    // id 是代码生成的，不是模型给的
    expect(made.id).toBeTruthy();
    expect(made.id).toMatch(/^char-/);
  });

  it('**模型就算硬塞 id 也不会被采用**', () => {
    // 让模型给 id 会撞车或格式不对，所以代码一律自己生成。
    // 这条测试确保即使模型不听话，也污染不了数据。
    const p = fresh();
    const r = applyChatEdits(p, [
      edit({
        op: 'create',
        target: { kind: 'character', id: '模型编的id' },
        createFields: { name: '测试', id: '再来一个id' },
      }),
    ]);
    const made = r.project.characters[r.project.characters.length - 1]!;
    expect(made.id).not.toBe('模型编的id');
    expect(made.id).not.toBe('再来一个id');
    expect(made.id).toMatch(/^char-/);
  });

  it('两个新对象的 id 不会相同', () => {
    const p = fresh();
    const r = applyChatEdits(p, [
      edit({ id: 'a', op: 'create', target: { kind: 'character' }, createFields: { name: '甲' } }),
      edit({ id: 'b', op: 'create', target: { kind: 'character' }, createFields: { name: '乙' } }),
    ]);
    const ids = r.project.characters.slice(-2).map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('新建场景：固定元素会当成列表清洗', () => {
    const p = fresh();
    const r = applyChatEdits(p, [
      edit({
        op: 'create',
        target: { kind: 'scene' },
        createFields: {
          name: '破庙',
          fixedElements: ['a broken Buddha statue', '', 'fallen roof beams'],
          lightDirection: '月光从破洞斜射',
        },
      }),
    ]);
    const made = r.project.scenes[r.project.scenes.length - 1]!;
    expect(made.name).toBe('破庙');
    expect(made.fixedElements).toEqual(['a broken Buddha statue', 'fallen roof beams']);
    expect(made.lightDirection).toBe('月光从破洞斜射');
  });

  it('**新建镜头默认挂到最后一个镜头的场景上**（唯一一处代码替用户做的引用决定）', () => {
    const p = fresh();
    const lastScene = p.shots[p.shots.length - 1]?.sceneId;
    const r = applyChatEdits(p, [
      edit({
        op: 'create',
        target: { kind: 'shot' },
        createFields: { action: '他猛地回头', duration: 2 },
      }),
    ]);
    const made = r.project.shots[r.project.shots.length - 1]!;
    expect(made.sceneId).toBe(lastScene);
    expect(made.action).toBe('他猛地回头');
    expect(made.duration).toBe(2);
    // 镜号接在最后
    expect(made.number).toBe(p.shots.length + 1);
  });

  it('新建镜头时非法的景别被换成默认值，而不是写进项目', () => {
    const p = fresh();
    const r = applyChatEdits(p, [
      edit({
        op: 'create',
        target: { kind: 'shot' },
        createFields: { action: 'x', shotSize: '超级特写', cameraMove: '乱写的' },
      }),
    ]);
    const made = r.project.shots[r.project.shots.length - 1]!;
    expect(made.shotSize).toBe('medium');
    expect(made.cameraMove).toBe('static');
  });

  it('新建内容为空时给出人话原因', () => {
    const p = fresh();
    const r = applyChatEdits(p, [
      edit({ op: 'create', target: { kind: 'character' }, createFields: {} }),
    ]);
    // 空内容会创建一个「未命名角色」—— 这是可接受的（用户能改），
    // 但必须在界面上能看出来是一条空卡
    const made = r.project.characters[r.project.characters.length - 1]!;
    expect(made.name).toBe('未命名角色');
  });

  it('故事与规格不能新建', () => {
    const p = fresh();
    const r = applyChatEdits(p, [
      edit({ op: 'create', target: { kind: 'story' }, createFields: { body: 'x' } }),
    ]);
    expect(r.applied).toBe(0);
    expect(r.skippedReasons[0]).toContain('不支持新建');
  });
});

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

describe('删除对象', () => {
  it('删除镜头，并重排镜号（不留 1 2 4 5 这种空洞）', () => {
    const p = fresh();
    if (p.shots.length < 3) return;
    const victim = p.shots[1]!;
    const r = applyChatEdits(p, [
      edit({ op: 'delete', target: { kind: 'shot', id: victim.id } }),
    ]);

    expect(r.applied).toBe(1);
    expect(r.project.shots).toHaveLength(p.shots.length - 1);
    expect(r.project.shots.some((s) => s.id === victim.id)).toBe(false);
    // 镜号连续
    r.project.shots.forEach((s, i) => expect(s.number).toBe(i + 1));
  });

  it('**删角色会级联清理镜头里的引用**（否则留下悬空引用）', () => {
    const p = fresh();
    const victim = p.characters[0]!;
    const usedBy = p.shots.filter((s) => s.characterIds.includes(victim.id));
    if (usedBy.length === 0) return;

    const r = applyChatEdits(p, [
      edit({ op: 'delete', target: { kind: 'character', id: victim.id } }),
    ]);

    expect(r.applied).toBe(1);
    expect(r.project.characters.some((c) => c.id === victim.id)).toBe(false);
    // 关键：所有镜头里都不该再出现这个 id
    for (const shot of r.project.shots) {
      expect(shot.characterIds, `第 ${shot.number} 镜还留着已删角色的 id`).not.toContain(victim.id);
    }
  });

  it('**删场景会把用它的镜头置为「未指定场景」**，而不是留着悬空 id', () => {
    const p = fresh();
    const victim = p.scenes[0]!;
    const usedBy = p.shots.filter((s) => s.sceneId === victim.id);
    if (usedBy.length === 0) return;

    const r = applyChatEdits(p, [
      edit({ op: 'delete', target: { kind: 'scene', id: victim.id } }),
    ]);

    expect(r.project.scenes.some((s) => s.id === victim.id)).toBe(false);
    for (const shot of r.project.shots) {
      expect(shot.sceneId).not.toBe(victim.id);
    }
  });

  it('删镜头时也清理角色与场景上的 shotIds', () => {
    const p = fresh();
    const victim = p.shots[0]!;
    const r = applyChatEdits(p, [
      edit({ op: 'delete', target: { kind: 'shot', id: victim.id } }),
    ]);
    for (const c of r.project.characters) {
      expect(c.shotIds).not.toContain(victim.id);
    }
    for (const s of r.project.scenes) {
      expect(s.shotIds).not.toContain(victim.id);
    }
  });

  it('删镜头会如实报告作废了几张图', () => {
    const p = fresh();
    const r = applyChatEdits(p, [
      edit({ op: 'delete', target: { kind: 'shot', id: p.shots[0]!.id } }),
    ]);
    // 一个镜头有三帧图
    expect(r.orphanedAssets).toBe(3);
  });

  it('删不存在的对象时跳过并说明', () => {
    const p = fresh();
    const r = applyChatEdits(p, [
      edit({ op: 'delete', target: { kind: 'character', id: '不存在' } }),
    ]);
    expect(r.applied).toBe(0);
    expect(r.skippedReasons[0]).toContain('已经不存在');
  });

  it('故事与规格不能删', () => {
    const p = fresh();
    const r = applyChatEdits(p, [
      edit({ op: 'delete', target: { kind: 'story' } }),
      edit({ op: 'delete', target: { kind: 'brief' } }),
    ]);
    expect(r.applied).toBe(0);
    expect(r.skippedReasons).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 一批里混合三种操作
// ---------------------------------------------------------------------------

describe('同一批里可以混合改 / 新增 / 删除', () => {
  it('**三种操作按顺序一起生效**（用户一次确认，不是分三轮）', () => {
    const p = fresh();
    if (p.shots.length < 3) return;

    const r = applyChatEdits(p, [
      edit({
        id: '1',
        op: 'set',
        target: { kind: 'shot', id: p.shots[0]!.id, field: 'action' },
        after: '改过的动作',
      }),
      edit({
        id: '2',
        op: 'create',
        target: { kind: 'character' },
        createFields: { name: '新角色' },
      }),
      edit({ id: '3', op: 'delete', target: { kind: 'shot', id: p.shots[1]!.id } }),
    ]);

    expect(r.applied).toBe(3);
    expect(r.project.shots[0]!.action).toBe('改过的动作');
    expect(r.project.characters.some((c) => c.name === '新角色')).toBe(true);
    expect(r.project.shots.some((s) => s.id === p.shots[1]!.id)).toBe(false);
  });

  it('部分成功时两边都如实统计', () => {
    const p = fresh();
    const r = applyChatEdits(p, [
      edit({ id: '1', op: 'create', target: { kind: 'scene' }, createFields: { name: '好场景' } }),
      edit({ id: '2', op: 'delete', target: { kind: 'shot', id: '不存在' } }),
    ]);
    expect(r.applied).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.skippedReasons).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 模型返回的解析：三种操作
// ---------------------------------------------------------------------------

describe('模型返回里的三种操作都能解析', () => {
  it('缺 op 时按「改」处理（兼容模型漏写）', () => {
    const parsed = chatReplySchema.parse({
      reply: 'x',
      edits: [
        { target: { kind: 'shot', id: 's1', field: 'action' }, title: '改动作', after: '内容' },
      ],
    });
    expect(parsed.edits[0]!.op).toBe('set');
  });

  it('新建时不需要 id 与 field', () => {
    const parsed = chatReplySchema.parse({
      reply: 'x',
      edits: [
        {
          op: 'create',
          target: { kind: 'character' },
          title: '加个反派',
          createFields: { name: '周薄森' },
        },
      ],
    });
    const out = normalizeChatReply(parsed);
    expect(out.reply.edits).toHaveLength(1);
    expect(out.reply.edits[0]!.op).toBe('create');
    expect(out.rejected).toBe(0);
    // 摘要里能看到新建了什么
    expect(out.reply.edits[0]!.after).toContain('周薄森');
  });

  it('新建不能凭空捏造类型', () => {
    const parsed = chatReplySchema.parse({
      reply: 'x',
      edits: [{ op: 'create', target: { kind: 'story' }, title: '新建故事', createFields: { body: 'x' } }],
    });
    const out = normalizeChatReply(parsed);
    expect(out.reply.edits).toHaveLength(0);
    expect(out.rejectedReasons[0]).toContain('只能新建');
  });

  it('新建但没给内容时被挡掉', () => {
    const parsed = chatReplySchema.parse({
      reply: 'x',
      edits: [{ op: 'create', target: { kind: 'character' }, title: '空的' }],
    });
    const out = normalizeChatReply(parsed);
    expect(out.reply.edits).toHaveLength(0);
    expect(out.rejectedReasons[0]).toContain('没说新建的内容');
  });

  it('删除时不需要 field', () => {
    const parsed = chatReplySchema.parse({
      reply: 'x',
      edits: [{ op: 'delete', target: { kind: 'shot', id: 's1' }, title: '删掉多余的一镜' }],
    });
    const out = normalizeChatReply(parsed, fresh());
    expect(out.reply.edits).toHaveLength(1);
    expect(out.reply.edits[0]!.op).toBe('delete');
  });

  it('删除时必须给 id', () => {
    const parsed = chatReplySchema.parse({
      reply: 'x',
      edits: [{ op: 'delete', target: { kind: 'shot' }, title: '删一镜' }],
    });
    const out = normalizeChatReply(parsed);
    expect(out.reply.edits).toHaveLength(0);
    expect(out.rejectedReasons[0]).toContain('没说是哪一个');
  });

  it('删除故事被挡掉（那是固定内容）', () => {
    const parsed = chatReplySchema.parse({
      reply: 'x',
      edits: [{ op: 'delete', target: { kind: 'story' }, title: '删故事' }],
    });
    const out = normalizeChatReply(parsed);
    expect(out.reply.edits).toHaveLength(0);
    expect(out.rejectedReasons[0]).toContain('不能删');
  });

  it('一次能带回很多条（支持大段改情节）', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      op: 'set' as const,
      target: { kind: 'shot' as const, id: `s${i}`, field: 'action' },
      title: `改第 ${i + 1} 镜`,
      after: `新动作 ${i}`,
    }));
    const parsed = chatReplySchema.parse({ reply: 'x', edits: many });
    const out = normalizeChatReply(parsed);
    expect(out.reply.edits).toHaveLength(20);
    expect(out.rejected).toBe(0);
  });
});
