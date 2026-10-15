import { describe, expect, it } from 'vitest';
import { sampleProject } from '../src/data/samples/sampleProject';
import { buildAllPrompts, buildShotPrompt } from '../src/domain/prompt';
import { promptsToMarkdown } from '../src/domain/export';
import { buildFramePrompt } from '../src/domain/image/prompts';
import type { Project } from '../src/types/model';

/**
 * 「手动改动会不会传导到提示词」的回归测试
 *
 * ===========================================================================
 * 为什么用户会问这个，以及为什么值得钉住
 * ===========================================================================
 * 如果手动改了镜头、提示词却还是老的，那这个工具的价值就没了 ——
 * 用户会照着旧提示词去生成，然后对着跟分镜对不上的画面纳闷。
 *
 * 好消息是这里的设计天然不会出这个问题：提示词没有「生成」这个动作，
 * 它是**每次读取时从项目数据现算的纯函数**。
 * 但这属于「靠架构保证，而不是靠测试保证」——
 * 以后只要有人加一层缓存（性能优化最容易踩的一脚），就会静默失效。
 * 所以这里把契约显式钉住。
 */

function fresh(): Project {
  return structuredClone(sampleProject);
}

describe('手动改动会传导到提示词', () => {
  it('**改了镜头动作，提示词里是新内容、且旧内容消失**', () => {
    const p = fresh();
    const shot = p.shots[0]!;
    const oldAction = shot.action;
    const newAction = '他推开门，手停在门把上没松开';

    const before = buildShotPrompt(p, shot, 'jimeng').en;
    expect(before).toContain(oldAction);

    p.shots[0] = { ...shot, action: newAction };
    const after = buildShotPrompt(p, p.shots[0]!, 'jimeng').en;

    expect(after, '新内容没进提示词').toContain(newAction);
    // 关键：旧内容必须消失。只查「含新内容」会漏掉「新旧都在」这种情况
    expect(after, '旧内容还留在提示词里').not.toContain(oldAction);
  });

  it('起点 / 终点 / 动作都会传导到提示词', () => {
    const p = fresh();
    const shot = p.shots[0]!;
    p.shots[0] = {
      ...shot,
      startState: 'MARKER-START',
      action: 'MARKER-ACTION',
      endState: 'MARKER-END',
    };
    const en = buildShotPrompt(p, p.shots[0]!, 'jimeng').en;
    for (const marker of ['MARKER-START', 'MARKER-ACTION', 'MARKER-END']) {
      expect(en, `${marker} 没进提示词`).toContain(marker);
    }
  });

  it('**台词 / 声音 / 情绪不进生成提示词（刻意如此）**', () => {
    // 这三个字段在分镜表里是给**后续阶段**用的：
    // 台词是配音与字幕的输入，声音是音效设计，情绪是剪辑时的节奏参考。
    // 即梦 / 可灵这类图生视频工具不吃这些，写进去只会挤占提示词的有效信息。
    //
    // 这条测试的作用是**把这个决定钉住**：以后有人「顺手」把它们加进提示词时，
    // 会看到这里写着为什么不该加。
    const p = fresh();
    const shot = p.shots[0]!;
    p.shots[0] = {
      ...shot,
      dialogue: 'MARKER-DIALOGUE',
      sound: 'MARKER-SOUND',
      mood: 'MARKER-MOOD',
    };
    const line = buildShotPrompt(p, p.shots[0]!, 'jimeng');
    for (const marker of ['MARKER-DIALOGUE', 'MARKER-SOUND', 'MARKER-MOOD']) {
      expect(line.en, `${marker} 不该出现在英文正文里`).not.toContain(marker);
      expect(line.zh, `${marker} 不该出现在中文对照里`).not.toContain(marker);
    }
  });

  it('景别与运镜改了就换英文词', () => {
    const p = fresh();
    const shot = p.shots[0]!;
    const other = shot.shotSize === 'close-up' ? 'wide' : 'close-up';
    p.shots[0] = { ...shot, shotSize: other };
    const en = buildShotPrompt(p, p.shots[0]!, 'jimeng').en;
    // 不该再出现原来那个景别的英文
    const origEn = buildShotPrompt(p, shot, 'jimeng').en;
    expect(en).not.toBe(origEn);
  });

  it('**改了场景的固定元素，所有用它镜头的提示词都跟着变**', () => {
    const p = fresh();
    if (p.scenes.length === 0) return;
    const scene = p.scenes[0]!;
    const usedBy = p.shots.filter((s) => s.sceneId === scene.id);
    if (usedBy.length === 0) return;

    p.scenes[0] = { ...scene, fixedElements: ['MARKER-FIXED-ELEMENT'] };
    for (const s of p.shots.filter((x) => x.sceneId === scene.id)) {
      const en = buildShotPrompt(p, s, 'jimeng').en;
      expect(en, `第 ${s.number} 镜没带上新的固定元素`).toContain('MARKER-FIXED-ELEMENT');
    }
  });

  it('**改了连续性锁的锁面，提示词里跟着变**', () => {
    const p = fresh();
    const c = p.characters[0];
    const lock = c?.continuityLocks[0];
    if (!c || !lock) return;

    // 找一镜用了这个角色，并让它挂上这把锁
    const target = p.shots[0]!;
    p.shots[0] = {
      ...target,
      characterIds: [c.id],
      activeLockIds: [lock.id],
    };
    p.characters[0] = {
      ...c,
      continuityLocks: [{ ...lock, phrase: 'MARKER-NEW-LOCK-PHRASE' }],
    };

    const en = buildShotPrompt(p, p.shots[0]!, 'jimeng').en;
    expect(en, '锁面没有跟着改').toContain('MARKER-NEW-LOCK-PHRASE');
    expect(en, '旧锁面还在').not.toContain(lock.phrase);
  });

  it('**导出时用的是当时的项目数据**，不是某个旧快照', () => {
    const p = fresh();
    const first = promptsToMarkdown(p).map((m) => m.content).join('\n');

    p.shots[0] = { ...p.shots[0]!, action: 'MARKER-EXPORT-ACTION' };
    const second = promptsToMarkdown(p).map((m) => m.content).join('\n');

    expect(second).toContain('MARKER-EXPORT-ACTION');
    expect(second, '导出内容和改之前一模一样 —— 说明用了缓存').not.toBe(first);
  });

  it('buildAllPrompts 每次都反映当前数据', () => {
    const p = fresh();
    p.shots[0] = { ...p.shots[0]!, action: 'MARKER-ALL-1' };
    const a = JSON.stringify(buildAllPrompts(p));
    p.shots[0] = { ...p.shots[0]!, action: 'MARKER-ALL-2' };
    const b = JSON.stringify(buildAllPrompts(p));

    expect(a).not.toBe(b);
    expect(b).toContain('MARKER-ALL-2');
  });

  it('**改起点 → 首帧提示词跟着改**', () => {
    // 图片一旦生成就固定了，而提示词必须反映「此刻的分镜」，
    // 否则用户改完分镜去重出图，出来的还是按旧描述画的
    const p = fresh();
    const shotId = p.shots[0]!.id;
    const before = buildFramePrompt(p, shotId, 'first-frame');
    expect(before, '找不到这一镜的首帧提示词').not.toBeNull();

    p.shots[0] = { ...p.shots[0]!, startState: 'MARKER-NEW-START' };
    const after = buildFramePrompt(p, shotId, 'first-frame')!;
    expect(after.positive).toContain('MARKER-NEW-START');
  });

  it('**三种帧各取各的字段 —— 首帧故意不含动作**', () => {
    // 这不是遗漏，是刻意的：首帧是「这一镜开始时的那一格」，动作还没发生。
    // 把动作写进首帧会让模型把终点状态画进第一格。
    const p = fresh();
    const shotId = p.shots[0]!.id;
    p.shots[0] = {
      ...p.shots[0]!,
      startState: 'MARKER-START-ONLY',
      action: 'MARKER-THE-ACTION',
      endState: 'MARKER-END-ONLY',
    };

    const first = buildFramePrompt(p, shotId, 'first-frame')!;
    expect(first.positive, '首帧该画起点').toContain('MARKER-START-ONLY');
    expect(first.positive, '首帧不该含动作 —— 动作还没发生').not.toContain('MARKER-THE-ACTION');

    const peak = buildFramePrompt(p, shotId, 'action-peak')!;
    expect(peak.positive, '动作关键帧该从动作推导顶点').toContain('MARKER-THE-ACTION');

    const end = buildFramePrompt(p, shotId, 'end-frame')!;
    expect(end.positive, '尾帧该画终点').toContain('MARKER-END-ONLY');
  });

  it('**机位改动会进关键帧提示词**（它比运镜更决定这一格怎么取景）', () => {
    const p = fresh();
    const shotId = p.shots[0]!.id;
    const before = buildFramePrompt(p, shotId, 'first-frame')!;
    expect(before.positive).toContain(p.shots[0]!.cameraPosition);

    p.shots[0] = { ...p.shots[0]!, cameraPosition: 'MARKER-CAMERA-POS' };
    const after = buildFramePrompt(p, shotId, 'first-frame')!;
    expect(after.positive).toContain('MARKER-CAMERA-POS');
    // 而且逐项说明里要解释为什么机位重要
    expect(after.notes.some((n) => n.label === '机位')).toBe(true);
  });
});
