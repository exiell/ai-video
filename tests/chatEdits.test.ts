import { describe, expect, it } from 'vitest';
import {
  EDITABLE_FIELDS,
  applyChatEdits,
  buildProjectContext,
  fieldLabel,
  isEditable,
  readField,
  validateFieldValue,
  type ChatEditProposal,
} from '../src/domain/chat/edits';
import { normalizeChatReply, chatReplySchema, parseChatReply } from '../src/services/llm/chat';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Project } from '../src/types/model';

/**
 * 对话式改稿（方案.md §7.6.20）
 *
 * ===========================================================================
 * 这组测试盯的是「模型不能把项目改坏」
 * ===========================================================================
 * 对话改稿和「自动修复」有个本质区别：自动修复的提议是**我们自己算出来的**，
 * 而对话改稿的提议是**模型返回的 JSON**——那是不可信输入。
 *
 * 所以核心不是测「改得对不对」，而是测「改不进去的东西真的改不进去」：
 *  - 编造的字段名不能写进项目
 *  - 引用关系（sceneId / characterIds）不能被改
 *  - 类型不对（把时长写成「三秒」）要被挡住
 *  - 目标对象已被删除时不能凭空造一个
 */

function edit(partial: Partial<ChatEditProposal> & { target: ChatEditProposal['target'] }): ChatEditProposal {
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

function freshProject(): Project {
  return structuredClone(sampleProject);
}

describe('字段白名单', () => {
  it('镜头能改内容字段', () => {
    for (const f of ['startState', 'action', 'endState', 'dialogue', 'mood', 'cameraPosition']) {
      expect(isEditable('shot', f), f).toBe(true);
    }
  });

  it('**id 与结构字段不可改**（改它们会让引用一起断掉）', () => {
    for (const f of ['id', 'activeLockIds', 'variantIds', 'sourceSceneId']) {
      expect(isEditable('shot', f), `shot.${f} 不该可改`).toBe(false);
    }
    for (const f of ['variants', 'continuityLocks', 'shotIds']) {
      expect(isEditable('character', f), `character.${f} 不该可改`).toBe(false);
      expect(isEditable('scene', f), `scene.${f} 不该可改`).toBe(false);
    }
  });

  it('**引用字段可改**（v0.36 反转：给了能力，另加校验防悬空）', () => {
    // 见 tests/chatCreateDelete.test.ts 里的「引用校验」一组 ——
    // 那里验的是「指向不存在的对象会被跳过」，这才是防悬空的正确位置。
    expect(isEditable('shot', 'sceneId')).toBe(true);
    expect(isEditable('shot', 'characterIds')).toBe(true);
  });

  it('编造的字段名不可改', () => {
    expect(isEditable('shot', '表情细节')).toBe(false);
    expect(isEditable('shot', 'nonexistentField')).toBe(false);
    expect(isEditable('character', 'identity')).toBe(false);
  });

  it('每个可改字段都有中文名（否则界面上会露出英文键名）', () => {
    for (const [kind, fields] of Object.entries(EDITABLE_FIELDS)) {
      for (const name of Object.keys(fields)) {
        const label = fieldLabel(kind as keyof typeof EDITABLE_FIELDS, name);
        expect(label, `${kind}.${name} 缺中文名`).toBeTruthy();
        expect(label).not.toBe(name);
      }
    }
  });
});

describe('值校验', () => {
  it('文字字段去空白', () => {
    expect(validateFieldValue('shot', 'action', '  他推开门  ').value).toBe('他推开门');
  });

  it('空字符串被拒（不能把字段改空）', () => {
    expect(validateFieldValue('shot', 'action', '   ').reason).toBeTruthy();
  });

  it('**超长内容被拒**（模型偶尔会把整段分镜复述一遍塞进来）', () => {
    const huge = '啊'.repeat(2001);
    expect(validateFieldValue('shot', 'action', huge).reason).toContain('太长');
  });

  it('时长必须是数字且落在范围内', () => {
    expect(validateFieldValue('shot', 'duration', 5).value).toBe(5);
    expect(validateFieldValue('shot', 'duration', '5').value).toBe(5);
    expect(validateFieldValue('shot', 'duration', '三秒').reason).toBeTruthy();
    expect(validateFieldValue('shot', 'duration', 999).reason).toBeTruthy();
    expect(validateFieldValue('shot', 'duration', 0).reason).toBeTruthy();
  });

  it('景别只接受枚举值', () => {
    expect(validateFieldValue('shot', 'shotSize', 'close-up').value).toBe('close-up');
    expect(validateFieldValue('shot', 'shotSize', '特写').reason).toBeTruthy();
    expect(validateFieldValue('shot', 'shotSize', 'super-close').reason).toBeTruthy();
  });

  it('短语数组接受字符串形式（模型很常返回 "a, b, c"）', () => {
    const r = validateFieldValue('scene', 'fixedElements', 'rows of desks, a blackboard');
    expect(r.value).toEqual(['rows of desks', 'a blackboard']);
  });

  it('短语数组会去空、限量', () => {
    const many = Array.from({ length: 30 }, (_, i) => `item${i}`);
    const r = validateFieldValue('scene', 'fixedElements', many);
    expect((r.value as string[]).length).toBeLessThanOrEqual(12);
    expect(validateFieldValue('scene', 'fixedElements', []).reason).toBeTruthy();
  });
});

describe('应用改动', () => {
  it('改一个镜头的动作', () => {
    const p = freshProject();
    const shot = p.shots[0]!;
    const r = applyChatEdits(p, [
      edit({ target: { kind: 'shot', id: shot.id, field: 'action' }, after: '他推开门' }),
    ]);
    expect(r.applied).toBe(1);
    expect(r.project.shots[0]!.action).toBe('他推开门');
  });

  it('**不修改传入的项目对象**（撤销要靠它）', () => {
    const p = freshProject();
    const before = p.shots[0]!.action;
    applyChatEdits(p, [
      edit({ target: { kind: 'shot', id: p.shots[0]!.id, field: 'action' }, after: '改过了' }),
    ]);
    expect(p.shots[0]!.action).toBe(before);
  });

  it('**嵌套字段能写入**（角色身份在 identity 里）', () => {
    const p = freshProject();
    const c = p.characters[0]!;
    const r = applyChatEdits(p, [
      edit({
        target: { kind: 'character', id: c.id, field: 'identity.summaryEn' },
        after: 'a tall man in a worn coat',
      }),
    ]);
    expect(r.applied).toBe(1);
    expect(r.project.characters[0]!.identity.summaryEn).toBe('a tall man in a worn coat');
  });

  it('目标不存在时跳过，并说明原因（不凭空造对象）', () => {
    const p = freshProject();
    const r = applyChatEdits(p, [
      edit({ target: { kind: 'shot', id: '不存在的镜头', field: 'action' }, after: 'x' }),
    ]);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.skippedReasons[0]).toContain('已经不存在');
  });

  it('值不合法时跳过，并带上原因', () => {
    const p = freshProject();
    const r = applyChatEdits(p, [
      edit({ target: { kind: 'shot', id: p.shots[0]!.id, field: 'duration' }, after: '三秒' }),
    ]);
    expect(r.applied).toBe(0);
    expect(r.skippedReasons[0]).toContain('校验');
  });

  it('一批里部分能应用、部分被跳过时，两边都如实统计', () => {
    const p = freshProject();
    const r = applyChatEdits(p, [
      edit({ target: { kind: 'shot', id: p.shots[0]!.id, field: 'action' }, after: '好改动' }),
      edit({ target: { kind: 'shot', id: '不存在', field: 'action' }, after: '坏改动' }),
      edit({ target: { kind: 'shot', id: p.shots[0]!.id, field: '乱编字段' }, after: 'x' }),
    ]);
    expect(r.applied).toBe(1);
    expect(r.skipped).toBe(2);
  });

  it('故事与规格也能改', () => {
    const p = freshProject();
    const r = applyChatEdits(p, [
      edit({ target: { kind: 'story', field: 'conflict' }, after: '新的冲突' }),
      edit({ target: { kind: 'brief', field: 'styleTone' }, after: '水墨' }),
    ]);
    expect(r.applied).toBe(2);
    expect(r.project.story.conflict).toBe('新的冲突');
    expect(r.project.brief.styleTone).toBe('水墨');
  });

  it('更新了 updatedAt（否则自动保存不会落盘）', () => {
    const p = freshProject();
    const before = p.updatedAt;
    const r = applyChatEdits(p, [
      edit({ target: { kind: 'story', field: 'conflict' }, after: 'x' }),
    ]);
    expect(r.project.updatedAt).not.toBe(before);
  });
});

describe('读取原值（用于显示「改前」）', () => {
  it('能读出镜头字段', () => {
    const p = freshProject();
    const v = readField(p, { kind: 'shot', id: p.shots[0]!.id, field: 'action' });
    expect(v).toBe(p.shots[0]!.action);
  });

  it('数组字段拼成可读文本', () => {
    const p = freshProject();
    if (p.scenes.length > 0 && p.scenes[0]!.fixedElements.length > 0) {
      const v = readField(p, { kind: 'scene', id: p.scenes[0]!.id, field: 'fixedElements' });
      expect(v).toContain('、');
    }
  });

  it('目标不存在时返回空串而不是崩', () => {
    const p = freshProject();
    expect(readField(p, { kind: 'shot', id: '不存在', field: 'action' })).toBe('');
  });
});

describe('模型返回的解析与权限过滤', () => {
  const okReply = {
    reply: '我把第三镜的动作改具体了。',
    scope: 'single' as const,
    edits: [
      {
        target: { kind: 'shot' as const, id: 'shot-1', field: 'action' },
        title: '让第三镜的动作更具体',
        reason: '原来太笼统',
        after: '他推开门，手停在门把上',
      },
    ],
  };

  it('正常返回能解析', () => {
    const r = chatReplySchema.safeParse(okReply);
    expect(r.success).toBe(true);
  });

  it('**缺 scope 时默认 single**（保守优先）', () => {
    const r = chatReplySchema.safeParse({ reply: 'x', edits: [] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.scope).toBe('single');
  });

  it('**编造字段被过滤掉，并告诉用户有几条被挡**', () => {
    const parsed = chatReplySchema.parse({
      reply: 'x',
      edits: [
        { target: { kind: 'shot', id: 's1', field: 'action' }, title: '好的', after: '内容' },
        { target: { kind: 'shot', id: 's1', field: '乱编字段' }, title: '坏的', after: '内容' },
      ],
    });
    const out = normalizeChatReply(parsed);
    expect(out.reply.edits).toHaveLength(1);
    expect(out.rejected).toBe(1);
    expect(out.rejectedReasons[0]).toContain('不在可修改范围内');
  });

  it('**镜头没给 id 的提议被挡掉**', () => {
    const parsed = chatReplySchema.parse({
      reply: 'x',
      edits: [{ target: { kind: 'shot', field: 'action' }, title: '无主', after: '内容' }],
    });
    const out = normalizeChatReply(parsed);
    expect(out.reply.edits).toHaveLength(0);
    expect(out.rejectedReasons[0]).toContain('没说是哪一个');
  });

  it('story / brief 不需要 id', () => {
    const parsed = chatReplySchema.parse({
      reply: 'x',
      edits: [
        { target: { kind: 'story', field: 'conflict' }, title: '改冲突', after: '内容' },
        { target: { kind: 'brief', field: 'styleTone' }, after: '水墨', title: '改风格' },
      ],
    });
    const out = normalizeChatReply(parsed);
    expect(out.reply.edits).toHaveLength(2);
    expect(out.rejected).toBe(0);
  });

  it('纯提问（没有 edits）是合法的，不该报错', () => {
    const parsed = chatReplySchema.parse({ reply: '这个工具帮你把想法变成分镜。', edits: [] });
    const out = normalizeChatReply(parsed);
    expect(out.reply.edits).toHaveLength(0);
    expect(out.reply.reply).toContain('分镜');
  });

  it('数组值被拼成字符串存进提议（应用时会再拆回来）', () => {
    const parsed = chatReplySchema.parse({
      reply: 'x',
      edits: [
        {
          target: { kind: 'scene', id: 'sc1', field: 'fixedElements' },
          title: '补固定元素',
          after: ['desks', 'blackboard'],
        },
      ],
    });
    const out = normalizeChatReply(parsed);
    expect(out.reply.edits[0]!.after).toBe('desks、blackboard');
  });

  it('从夹带解释文字的返回里也能抠出 JSON', () => {
    const raw = '好的，我来分析一下。\n```json\n{"reply":"x","scope":"single","edits":[]}\n```\n希望有帮助！';
    const r = parseChatReply(raw);
    expect(r.data?.reply).toBe('x');
  });

  it('非 JSON 返回给出人话错误', () => {
    const r = parseChatReply('我觉得第三镜可以改得更紧张一些。');
    expect(r.data).toBeUndefined();
    expect(r.error).toBeTruthy();
  });

  it('空返回给出人话错误', () => {
    const r = parseChatReply('');
    expect(r.error).toContain('没有返回任何内容');
  });
});

describe('项目上下文', () => {
  it('包含故事、角色、场景、分镜', () => {
    const ctx = buildProjectContext(sampleProject);
    expect(ctx).toContain('# 故事');
    expect(ctx).toContain('# 分镜');
  });

  it('**给出 id**（模型要能指明改哪一镜）', () => {
    const ctx = buildProjectContext(sampleProject);
    for (const s of sampleProject.shots) {
      expect(ctx, `第 ${s.number} 镜的 id 没进上下文`).toContain(`id=${s.id}`);
    }
  });

  it('镜头很多时截断，并说明省略了多少', () => {
    const p = freshProject();
    const one = p.shots[0]!;
    p.shots = Array.from({ length: 60 }, (_, i) => ({ ...one, id: `s${i}`, number: i + 1 }));
    const ctx = buildProjectContext(p, null, 40);
    expect(ctx).toContain('其余 20 镜省略');
  });

  it('长故事被截断而不是整段塞进去', () => {
    const p = freshProject();
    p.story.body = '啊'.repeat(5000);
    const ctx = buildProjectContext(p);
    expect(ctx).toContain('已截断');
    /**
     * 上限从 6000 提到 20000：v0.35 之后上下文改成**白名单驱动**，
     * 每个可改字段都要输出当前值（原来手写字段列表时漏了一大半）。
     * 上下文变长是这个修复的代价，换来的是「模型能改它看得见的东西」。
     *
     * 这里的断言目的不是卡死长度，而是**防止有人把整个故事原文塞进去**
     * —— 那才是真正会让输入爆掉的做法。
     */
    expect(ctx.length).toBeLessThan(20000);
    expect(ctx).not.toContain('啊'.repeat(3000));
  });

  it('空项目也能构造上下文，不崩', () => {
    const p = freshProject();
    p.shots = [];
    p.characters = [];
    p.scenes = [];
    expect(() => buildProjectContext(p)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 冲突检测：AI 提议之后用户自己手改过
// ---------------------------------------------------------------------------

describe('不能让 AI 覆盖用户的手改（调研指出的真实坑）', () => {
  it('**用户在提议之后手改过 → 跳过并如实告知，不覆盖**', () => {
    const p = freshProject();
    const shot = p.shots[0]!;
    // 提议生成时值是「原来的动作」
    const atProposal = shot.action;

    // 用户在看到提议之后自己动手改了这个字段
    p.shots[0]!.action = '用户自己改的版本';

    const r = applyChatEdits(p, [
      edit({
        target: { kind: 'shot', id: shot.id, field: 'action' },
        after: 'AI 想改成这个',
        beforeAtProposal: atProposal,
      }),
    ]);

    // 不覆盖
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.skippedReasons[0]).toContain('你在这之后自己改过');
    expect(r.project.shots[0]!.action).toBe('用户自己改的版本');
  });

  it('用户没动过 → 正常应用', () => {
    const p = freshProject();
    const shot = p.shots[0]!;
    const r = applyChatEdits(p, [
      edit({
        target: { kind: 'shot', id: shot.id, field: 'action' },
        after: 'AI 改成这个',
        beforeAtProposal: shot.action,
      }),
    ]);
    expect(r.applied).toBe(1);
    expect(r.project.shots[0]!.action).toBe('AI 改成这个');
  });

  it('没记 beforeAtProposal 时不做冲突检测（向后兼容）', () => {
    const p = freshProject();
    const shot = p.shots[0]!;
    p.shots[0]!.action = '随便改过';
    const r = applyChatEdits(p, [
      edit({ target: { kind: 'shot', id: shot.id, field: 'action' }, after: '新内容' }),
    ]);
    expect(r.applied).toBe(1);
  });

  it('数组字段的冲突也能检测到', () => {
    const p = freshProject();
    if (p.scenes.length === 0) return;
    const scene = p.scenes[0]!;
    const atProposal = scene.fixedElements.join('、');
    p.scenes[0]!.fixedElements = [...scene.fixedElements, 'user added this'];

    const r = applyChatEdits(p, [
      edit({
        target: { kind: 'scene', id: scene.id, field: 'fixedElements' },
        after: 'desks、blackboard',
        beforeAtProposal: atProposal,
      }),
    ]);
    expect(r.applied).toBe(0);
    expect(r.skippedReasons[0]).toContain('自己改过');
  });

  it('用户把字段清空也算改过', () => {
    const p = freshProject();
    const shot = p.shots[0]!;
    if (!shot.action) return;
    const atProposal = shot.action;
    p.shots[0]!.action = '';
    const r = applyChatEdits(p, [
      edit({
        target: { kind: 'shot', id: shot.id, field: 'action' },
        after: 'AI 版本',
        beforeAtProposal: atProposal,
      }),
    ]);
    expect(r.applied).toBe(0);
  });
});
