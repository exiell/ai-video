import { describe, expect, it } from 'vitest';
import { safeFileName } from '../src/domain/export';
import {
  dataUrlExtension,
  dataUrlToBytes,
  summarizeBundle,
  type ZipEntry,
} from '../src/domain/export/bundle';
import { makeIssue } from '../src/domain/checks/shared';
import {
  describeNames,
  framePrereqMessage,
  isFramePrereqMet,
  missingBeforeFrames,
} from '../src/domain/image/order';
import { runChecks } from '../src/domain/checks';
import { makeEmptyProject } from '../src/store/app';
import type { Asset, Project, Shot } from '../src/types/model';

/**
 * domain 侧高价值边界补测（v0.55 · 测试缺口 E2）
 *
 * ===========================================================================
 * 选了什么、为什么
 * ===========================================================================
 * P2-16 只按「文件是否被测试 import」统计，很多函数虽然被间接带到，
 * 边界分支却没人走过。挑了 6 组「出错时用户能看到/数据会坏」的地方补边界：
 *
 *  1. `safeFileName` —— 用户输入会变成压缩包里的文件名；非法字符、超长、
 *     全空白三档决定「能不能解压、会不会覆盖」。原来只测了一个正例。
 *  2. `dataUrlExtension` / `dataUrlToBytes` —— dataUrl 是素材的唯一长期载体；
 *     解析失败必须返回 null（调用方据此跳过），不能抛异常或产出坏字节。
 *  3. `summarizeBundle` —— 导出页顶部的「N 个文本 / N 张图 / 共 X MB」全靠它，
 *     数错会让用户以为图片没进包。
 *  4. `makeIssue` —— issue.id 是界面的 React key，也是自动修复的定位依据；
 *     同一规则同一位置的多次检查 id 必须唯一，否则状态会串。
 *  5. `runChecks` —— 对外契约是「按严重度排序 + counts 与 issues 一致」，
 *     界面顺序与顶部统计都依赖它。
 *  6. `missingBeforeFrames` / `framePrereqMessage` —— 出帧前的「缺图提示」，
 *     名字多时的折叠（等 N 个）与「只有一类缺」的文案都要对。
 */

function makeShot(overrides: Partial<Shot> & Pick<Shot, 'id' | 'number'>): Shot {
  return {
    duration: 3,
    shotSize: 'medium',
    cameraPosition: '',
    cameraMove: 'static',
    startState: '',
    action: '',
    endState: '',
    dialogue: '',
    sound: '',
    mood: '',
    transition: '硬切',
    sceneId: '',
    characterIds: [],
    variantIds: [],
    activeLockIds: [],
    offscreenCharacters: [],
    sourceSceneId: '',
    ...overrides,
  };
}

describe('safeFileName · 文件名安全化的三个边界', () => {
  it('替换掉各平台的非法字符（路径分隔符、通配符、引号、换行）', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j\nk\rl\tm')).toBe('a_b_c_d_e_f_g_h_i_j_k_l_m');
  });

  it('**超长名字截到 80 字符**（过长文件名在部分文件系统上会解压失败）', () => {
    const result = safeFileName('啊'.repeat(200));
    expect(result).toHaveLength(80);
  });

  it('全空白/空串退回 fallback，且 fallback 可自定义', () => {
    expect(safeFileName('   ')).toBe('aniguide');
    expect(safeFileName('')).toBe('aniguide');
    expect(safeFileName('  ', '未命名')).toBe('未命名');
  });

  it('正常中文名保持原样（不能把可读性一起清掉）', () => {
    expect(safeFileName('我的项目 第一集')).toBe('我的项目 第一集');
  });
});

describe('dataUrl 解析 · 坏输入必须安全返回', () => {
  function bytesOf(dataUrl: string): number[] | null {
    const bytes = dataUrlToBytes(dataUrl);
    return bytes ? [...bytes] : null;
  }

  it('合法 base64 往返一致', () => {
    const base64 = btoa('ABC');
    expect(bytesOf(`data:image/png;base64,${base64}`)).toEqual([65, 66, 67]);
  });

  it('没有逗号、没有 base64 标记、base64 损坏时都返回 null（调用方会跳过）', () => {
    expect(dataUrlToBytes('data:image/png;base64')).toBeNull();
    expect(dataUrlToBytes('data:image/png,raw-bytes')).toBeNull();
    expect(dataUrlToBytes('data:image/png;base64,!!!not-base64!!!')).toBeNull();
  });

  it('扩展名只认图片类型，未知类型统一回退 png', () => {
    expect(dataUrlExtension('data:image/jpeg;base64,x')).toBe('jpg');
    expect(dataUrlExtension('data:image/jpg;base64,x')).toBe('jpg');
    expect(dataUrlExtension('data:image/webp;base64,x')).toBe('webp');
    expect(dataUrlExtension('data:image/png;base64,x')).toBe('png');
    expect(dataUrlExtension('data:image/svg+xml;base64,x')).toBe('png');
    expect(dataUrlExtension('不是 dataUrl')).toBe('png');
    expect(dataUrlExtension('不是 dataUrl', 'jpg')).toBe('jpg');
  });
});

describe('summarizeBundle · 导出页顶部的统计', () => {
  it('分别统计文本条数、图片张数与图片总字节', () => {
    const entries: ZipEntry[] = [
      { path: '先看这里.txt', content: '说明' },
      { path: '参考文档/分镜表.md', content: '# 表' },
      { path: '图包★/a.png', content: '', bytes: new Uint8Array(10) },
      { path: '图包★/b.png', content: '', bytes: new Uint8Array(5) },
    ];
    expect(summarizeBundle(entries)).toEqual({ textCount: 2, imageCount: 2, imageBytes: 15 });
  });

  it('空包全是 0', () => {
    expect(summarizeBundle([])).toEqual({ textCount: 0, imageCount: 0, imageBytes: 0 });
  });
});

describe('makeIssue · issue id 的稳定性', () => {
  it('id 带上 ruleId / 定位对象 / 字段，两次相同输入也不同（界面 key 不能撞）', () => {
    const base = {
      ruleId: 'shot-incomplete' as const,
      severity: 'error' as const,
      title: 't',
      why: 'w',
      suggestion: 's',
      location: { kind: 'shot' as const, id: 'shot-1', field: 'action' },
    };
    const first = makeIssue(base);
    const second = makeIssue(base);
    expect(first.id).toContain('shot-incomplete');
    expect(first.id).toContain('shot-1');
    expect(first.id).toContain('action');
    expect(second.id).not.toBe(first.id);
  });

  it('没有 field 时用 - 占位，而不是 undefined', () => {
    const issue = makeIssue({
      ruleId: 'character-not-registered' as const,
      severity: 'info',
      title: 't',
      why: 'w',
      suggestion: 's',
      location: { kind: 'character', id: 'char-1' },
    });
    expect(issue.id).toContain('-:');
    expect(issue.id).not.toContain('undefined');
  });
});

describe('runChecks · 排序与统计的对外契约', () => {
  it('**按严重度排序（error → warning → info），counts 与 issues 一致**', () => {
    const project = makeEmptyProject('排序契约');
    project.characters.push({
      id: 'c1',
      name: '林冲',
      role: 'protagonist',
      identity: { face: '', hair: '', bodyType: '', ageRange: '', summary: '', summaryEn: '' },
      variants: [],
      continuityLocks: [],
      shotIds: [],
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    project.shots.push(
      makeShot({
        id: 's1',
        number: 1,
        characterIds: ['c1'],
        startState: '',
        action: '他缓缓站起身',
        endState: '',
        mood: '难过',
        sceneId: '',
      }),
    );

    const report = runChecks(project);
    const order = { error: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < report.issues.length; i += 1) {
      expect(order[report.issues[i - 1]!.severity]).toBeLessThanOrEqual(
        order[report.issues[i]!.severity],
      );
    }
    expect(report.counts.error).toBe(
      report.issues.filter((issue) => issue.severity === 'error').length,
    );
    expect(report.counts.error + report.counts.warning + report.counts.info).toBe(
      report.issues.length,
    );
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
    // 这个 fixture 必须真的同时产出三档，否则排序断言是空转
    expect(report.counts.error).toBeGreaterThan(0);
    expect(report.counts.warning).toBeGreaterThan(0);
    expect(report.counts.info).toBeGreaterThan(0);
  });
});

describe('出帧前的缺图提示', () => {
  function assetsOf(entries: { refId: string; kind: Asset['kind'] }[]): Pick<
    Asset,
    'refId' | 'kind' | 'dataUrl'
  >[] {
    return entries.map((entry) => ({ ...entry, dataUrl: 'data:image/png;base64,AA' }));
  }

  it('**名字超过 3 个时折叠成「等 N 个」**，不把整屏占满', () => {
    expect(describeNames(['甲', '乙', '丙', '丁', '戊'])).toContain('等 5 个');
    expect(describeNames(['甲', '乙'])).toBe('「甲」「乙」');
  });

  it('两类都缺时一句话说完；生成前只给提示不拦截（message 非空即可由调用方确认）', () => {
    const project: Project = makeEmptyProject('缺图');
    project.characters.push({
      id: 'c1',
      name: '林冲',
      role: 'protagonist',
      identity: { face: '', hair: '', bodyType: '', ageRange: '', summary: '', summaryEn: '' },
      variants: [],
      continuityLocks: [],
      shotIds: [],
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const scene = {
      id: 'sc1',
      name: '山神庙',
      identity: { placeType: '', spatialStructure: '', summary: '', summaryEn: '' },
      variants: [],
      continuityLocks: [],
      fixedElements: [],
      lightDirection: '',
      mainColor: '',
      shotIds: [],
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    project.scenes.push(scene);

    const gap = missingBeforeFrames(project, []);
    expect(gap.characters).toEqual(['林冲']);
    expect(gap.scenes).toEqual(['山神庙']);
    const message = framePrereqMessage(gap);
    expect(message).toContain('林冲');
    expect(message).toContain('山神庙');
    expect(message).toContain('仍然生成');

    // 补齐四张图（全身 + 头像 + 场景板）后不再提示
    const complete = assetsOf([
      { refId: 'c1', kind: 'character-sheet' },
      { refId: 'c1', kind: 'character-sheet-face' },
      { refId: 'sc1', kind: 'scene-plate' },
    ]);
    expect(isFramePrereqMet(missingBeforeFrames(project, complete))).toBe(true);
    expect(framePrereqMessage(missingBeforeFrames(project, complete))).toBeNull();
  });
});
