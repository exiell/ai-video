import { describe, expect, it } from 'vitest';
import {
  applyChatEdits,
  buildProjectContext,
  validateFieldValue,
  type ChatEditProposal,
} from '../src/domain/chat/edits';
import { sampleProject } from '../src/data/samples/sampleProject';
import { runChecks } from '../src/domain/checks';
import type { Project } from '../src/types/model';

/**
 * 引用字段与检查报告（方案.md §7.6.26）
 *
 * ===========================================================================
 * 这一版修的是两个「AI 明明该做到却做不到」的问题
 * ===========================================================================
 * 1. **AI 看不到穿帮检查的结果**。用户问「有哪些地方会穿帮」，
 *    它只能自己读分镜猜 —— 而检查结果是本地引擎算出来的确定性结论，
 *    比模型读一遍准得多。原因：`buildProjectContext` 只接收 project。
 *
 * 2. **AI 新建了场景，但镜头没有挂上去**。原因是提示词明确禁止它改
 *    `sceneId` / `characterIds`，理由是「改错了会挂到不存在的场景上」。
 *    那个理由经不起推敲：**能力和校验是两件事**，
 *    我当时用「不给能力」绕过了「写校验」该做的事。
 */

function fresh(): Project {
  return structuredClone(sampleProject);
}

function edit(p: Partial<ChatEditProposal> & { target: ChatEditProposal['target'] }): ChatEditProposal {
  return { id: 'e1', op: 'set', title: '测试', reason: '', before: '', after: '', ...p };
}

// ---------------------------------------------------------------------------
// 检查报告进上下文
// ---------------------------------------------------------------------------

describe('AI 能看到穿帮检查的结果', () => {
  it('**传了报告时，问题会进上下文**', () => {
    const p = fresh();
    const report = runChecks(p);
    const ctx = buildProjectContext(p, report);

    expect(ctx).toContain('# 穿帮检查结果');
    if (report.issues.length > 0) {
      // 至少能看到条数与分档统计
      expect(ctx).toContain(`共 ${report.issues.length} 条`);
      expect(ctx).toContain('必须修');
    }
  });

  it('问题里带定位与建议（AI 要能照着改）', () => {
    const p = fresh();
    const report = runChecks(p);
    const first = report.issues[0];
    if (!first) return;
    const ctx = buildProjectContext(p, report);
    expect(ctx).toContain(first.title);
    expect(ctx).toContain(first.suggestion);
  });

  it('没传报告时不出现这一段（不硬编造）', () => {
    const ctx = buildProjectContext(fresh(), null);
    expect(ctx).not.toContain('# 穿帮检查结果');
  });

  it('报告为空（没有问题）时也不出现空标题', () => {
    const p = fresh();
    const ctx = buildProjectContext(p, { issues: [], checkedAt: '', counts: { error: 0, warning: 0, info: 0 } });
    expect(ctx).not.toContain('# 穿帮检查结果');
  });

  it('问题很多时截断，不让上下文爆掉', () => {
    const p = fresh();
    const report = runChecks(p);
    const many = {
      ...report,
      issues: Array.from({ length: 60 }, (_, i) => ({
        ...report.issues[0]!,
        id: `x${i}`,
        title: `问题 ${i}`,
      })),
    };
    const ctx = buildProjectContext(p, many);
    expect(ctx).toContain('其余');
    expect(ctx).not.toContain('问题 59');
  });
});

// ---------------------------------------------------------------------------
// 引用字段
// ---------------------------------------------------------------------------

describe('引用字段的校验（给了能力，就得有校验）', () => {
  it('**指向存在的场景 → 通过**', () => {
    const p = fresh();
    const sceneId = p.scenes[0]!.id;
    const r = validateFieldValue('shot', 'sceneId', sceneId, p);
    expect(r.value).toBe(sceneId);
  });

  it('**指向不存在的场景 → 挡住并说明**', () => {
    const p = fresh();
    const r = validateFieldValue('shot', 'sceneId', '模型编的场景id', p);
    expect(r.value).toBeUndefined();
    expect(r.reason).toContain('不存在');
  });

  it('清空引用是合法的（表示「未指定」）', () => {
    const p = fresh();
    const r = validateFieldValue('shot', 'sceneId', '', p);
    expect(r.value).toBe('');
  });

  it('**出镜角色：有一个不存在就整条挡住**', () => {
    const p = fresh();
    const ok = p.characters[0]!.id;
    const r = validateFieldValue('shot', 'characterIds', [ok, '编的id'], p);
    expect(r.value).toBeUndefined();
    expect(r.reason).toContain('不存在');
  });

  it('出镜角色列表会去重、去掉空项', () => {
    const p = fresh();
    const ids = p.characters.slice(0, 2).map((c) => c.id);
    if (ids.length < 2) return;
    const r = validateFieldValue('shot', 'characterIds', [ids[0], ids[0], '', ids[1]], p);
    expect(r.value).toEqual(ids);
  });

  it('出镜角色接受逗号分隔的字符串（模型常这么写）', () => {
    const p = fresh();
    const ids = p.characters.slice(0, 2).map((c) => c.id);
    if (ids.length < 2) return;
    const r = validateFieldValue('shot', 'characterIds', `${ids[0]},${ids[1]}`, p);
    expect(r.value).toEqual(ids);
  });

  it('不传 project 时只做类型校验，不查存在性', () => {
    // 这样其它不关心引用的调用点和旧测试不用改
    const r = validateFieldValue('shot', 'sceneId', '任意id');
    expect(r.value).toBe('任意id');
  });
});

describe('把镜头挂到场景上', () => {
  it('**改 sceneId 能真正写进项目**', () => {
    const p = fresh();
    if (p.scenes.length < 2) return;
    const target = p.scenes[1]!.id;
    const r = applyChatEdits(p, [
      edit({ target: { kind: 'shot', id: p.shots[0]!.id, field: 'sceneId' }, after: target }),
    ]);
    expect(r.applied).toBe(1);
    expect(r.project.shots[0]!.sceneId).toBe(target);
  });

  it('**指向不存在的场景时跳过那一条，并说明原因**', () => {
    const p = fresh();
    const r = applyChatEdits(p, [
      edit({ target: { kind: 'shot', id: p.shots[0]!.id, field: 'sceneId' }, after: '编的id' }),
    ]);
    expect(r.applied).toBe(0);
    expect(r.skippedReasons[0]).toContain('不存在');
    // 原值不被破坏
    expect(r.project.shots[0]!.sceneId).toBe(p.shots[0]!.sceneId);
  });

  it('让角色出镜也能写进去', () => {
    const p = fresh();
    const cid = p.characters[0]!.id;
    const r = applyChatEdits(p, [
      edit({ target: { kind: 'shot', id: p.shots[0]!.id, field: 'characterIds' }, after: cid }),
    ]);
    expect(r.applied).toBe(1);
    expect(r.project.shots[0]!.characterIds).toContain(cid);
  });
});

describe('新建场景会自动挂到还没挂场景的镜头上', () => {
  it('**没挂场景的镜头会被挂到新场景上**', () => {
    // 这是「场景建了但没生效」的修复：模型无法引用同一批里刚建的对象
    // （id 由程序生成），所以这一步只能由代码做。
    const p = fresh();
    p.shots.forEach((s) => {
      s.sceneId = '';
    });

    const r = applyChatEdits(p, [
      edit({ op: 'create', target: { kind: 'scene' }, createFields: { name: '破庙' } }),
    ]);

    const made = r.project.scenes[r.project.scenes.length - 1]!;
    expect(made.name).toBe('破庙');
    for (const shot of r.project.shots) {
      expect(shot.sceneId, `第 ${shot.number} 镜没被挂上`).toBe(made.id);
    }
  });

  it('**已经有场景的镜头不会被覆盖**（那是创作判断，不该替用户做）', () => {
    const p = fresh();
    const original = p.shots.map((s) => s.sceneId);
    const r = applyChatEdits(p, [
      edit({ op: 'create', target: { kind: 'scene' }, createFields: { name: '新场景' } }),
    ]);
    expect(r.project.shots.map((s) => s.sceneId)).toEqual(original);
  });

  it('新建角色**不会**自动让他出镜（只有用户知道该出现在哪）', () => {
    const p = fresh();
    const before = p.shots.map((s) => s.characterIds.length);
    const r = applyChatEdits(p, [
      edit({ op: 'create', target: { kind: 'character' }, createFields: { name: '新角色' } }),
    ]);
    expect(r.project.shots.map((s) => s.characterIds.length)).toEqual(before);
  });
});
