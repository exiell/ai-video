import { describe, expect, it } from 'vitest';
import {
  PRESET_VIDEO_DIALECT_IDS,
  VIDEO_MODEL_DIALECTS,
  resolveVideoDialect,
} from '../src/data/models/videoDialects';
import { compileVideoDialectPrompt } from '../src/domain/prompt/compilers';
import { processNegativePrompt } from '../src/domain/prompt/negativeRewriter';
import {
  compileReferenceBindings,
  formatMiniMaxCameraCommand,
  resolveKlingElementTokens,
  stripProseParameters,
} from '../src/domain/prompt/refSyntax';
import { ShotRendererRouter } from '../src/domain/pipeline/shotRendererRouter';
import {
  estimateRemoteUrlExpiry,
  formatExpiryHint,
  remoteUrlTtlHours,
} from '../src/services/storage/mediaCache';
import { sampleProject } from '../src/data/samples/sampleProject';
import { makeEmptyProject } from '../src/store/app';
import type { Shot } from '../src/types/model';

function makeSampleShot(overrides: Partial<Shot> = {}): Shot {
  return {
    ...structuredClone(sampleProject.shots[0]!),
    action: 'Lin Chong pulls open the wooden door and steps into the snow',
    cameraMove: 'push-in',
    dialogue: 'Who is outside?',
    sound: 'heavy wind howling, wooden door creaking',
    duration: 5,
    ...overrides,
  };
}

describe('Phase 1：9 大视频模型方言编译器与边界拦截', () => {
  it('预置 9 套主流视频模型方言 + custom 兜底全部注册完整', () => {
    expect(PRESET_VIDEO_DIALECT_IDS).toHaveLength(9);
    for (const id of PRESET_VIDEO_DIALECT_IDS) {
      const dialect = VIDEO_MODEL_DIALECTS[id];
      expect(dialect, id).toBeDefined();
      expect(dialect?.supportedModes.length).toBeGreaterThan(0);
    }
    expect(resolveVideoDialect('unknown-id').dialectId).toBe('custom');
  });

  it('I2V 静态外观剥离：i2v_motion_only 不重复拼接角色静态五官/服装与背景，仅留动作、运镜与声音', () => {
    const project = structuredClone(sampleProject);
    const shot = makeSampleShot();
    const charSummary = project.characters[0]?.identity.summaryEn ?? '';

    const i2v = compileVideoDialectPrompt({
      project,
      shot,
      dialectIdOrPlatform: 'kling_3',
      promptMode: 'i2v_motion_only',
    });
    const t2v = compileVideoDialectPrompt({
      project,
      shot,
      dialectIdOrPlatform: 'kling_3',
      promptMode: 't2v',
    });

    expect(i2v.strippedStaticAppearance).toBe(true);
    expect(i2v.prompt).toContain(shot.action);
    expect(i2v.prompt).toContain('keep existing subject identity');
    if (charSummary.length > 10) {
      expect(i2v.prompt).not.toContain(charSummary);
    }
    // Kling 3.0 原生音频对白格式
    expect(i2v.prompt).toContain(']: "Who is outside?"');
    expect(i2v.prompt).toContain('SFX:');
    expect(t2v.strippedStaticAppearance).toBe(false);
  });

  it('负向词分流：Runway Gen-4.5 与 Veo 3.1 自动正向改写并清空负向栏；Wan 2.7 按 500 字符上限截断', () => {
    const project = structuredClone(sampleProject);
    project.brief.negativePrompt = 'no camera movement, no extra people, watermark, blurry';
    const shot = makeSampleShot();

    const runway = compileVideoDialectPrompt({
      project,
      shot,
      dialectIdOrPlatform: 'runway_gen4_5',
      promptMode: 'i2v_motion_only',
    });
    const veo = compileVideoDialectPrompt({
      project,
      shot,
      dialectIdOrPlatform: 'veo_3_1',
      promptMode: 'i2v_motion_only',
    });

    expect(runway.negativePrompt).toBe('');
    expect(runway.prompt).toContain('locked-off static camera');
    expect(runway.prompt.toLowerCase()).not.toContain('no camera movement');

    expect(veo.negativePrompt).toBe('');
    expect(veo.rewrittenToPositive.length).toBeGreaterThan(0);

    // Wan 2.6/2.7 超过 500 字符安全截断
    const longNeg = Array.from({ length: 60 }, (_, i) => `forbidden_artifact_${i}`).join(', ');
    const wanNeg = processNegativePrompt({
      dialect: resolveVideoDialect('wan_2_7_r2v'),
      positivePrompt: 'slow push in',
      rawNegativePrompt: longNeg,
    });
    expect(wanNeg.truncated).toBe(true);
    expect(wanNeg.negativePrompt.length).toBeLessThanOrEqual(500);
  });

  it('Seedance 2.5：生成 @Image1/@Video1/@Audio1 职责前缀，并拦截首尾帧与多参考混传', () => {
    const dialect = resolveVideoDialect('seedance_2_5');

    const okRes = compileReferenceBindings({
      dialect,
      hasFirstLastFrame: false,
      references: [
        { kind: 'image', name: 'LinChong', role: 'character' },
        { kind: 'audio', name: 'LinChongVoice', role: 'audio_voice' },
      ],
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.tokens).toEqual(['@Image1', '@Audio1']);
    expect(okRes.prefix).toContain('@Image1');
    expect(okRes.prefix).toContain('@Audio1');

    const conflict = compileReferenceBindings({
      dialect,
      hasFirstLastFrame: true,
      references: [{ kind: 'image', name: 'LinChong', role: 'character' }],
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.errors[0]).toContain('禁止同时混传首尾帧');
  });

  it('Wan 2.7 / Wan 2.6：Wan 2.7 省略 first_frame 并独立编号 Image/Video；Wan 2.6 输出 character1', () => {
    const wan27 = compileReferenceBindings({
      dialect: resolveVideoDialect('wan_2_7_r2v'),
      references: [
        { kind: 'image', name: 'Shot1First', role: 'first_frame' },
        { kind: 'image', name: 'Hero', role: 'character' },
        { kind: 'video', name: 'MotionRef', role: 'scene' },
      ],
    });
    expect(wan27.ok).toBe(true);
    expect(wan27.tokens).toEqual(['Image 1', 'Video 1']);
    expect(wan27.prefix).not.toContain('Shot1First');

    const wan26 = compileReferenceBindings({
      dialect: resolveVideoDialect('wan_2_6_r2v'),
      references: [
        { kind: 'video', name: '林冲', role: 'character' },
        { kind: 'video', name: '陆谦', role: 'character' },
      ],
    });
    expect(wan26.tokens).toEqual(['character1', 'character2']);
  });

  it('Kling 3.0 Omni：检测并自动消解 @Zhang 与 @ZhangSan 子串碰撞', () => {
    const resolved = resolveKlingElementTokens(['Zhang', 'ZhangSan']);
    expect(resolved.collisions.length).toBeGreaterThan(0);
    expect(resolved.tokens[0]).toBe('@Zhang_1');
    expect(resolved.tokens[1]).toBe('@ZhangSan');
  });

  it('MiniMax 海螺 2.3：输出官方 [Push in] 方括号运镜、最多组合 3 个、默认关闭 promptOptimizer 且 1080P 锁 6s', () => {
    expect(formatMiniMaxCameraCommand(['pan-left', 'crane-up'])).toBe('[Pan left,Pedestal up]');
    expect(
      formatMiniMaxCameraCommand(['pan-left', 'crane-up', 'push-in', 'handheld']).split(','),
    ).toHaveLength(3);

    const project = structuredClone(sampleProject);
    const shot = makeSampleShot({ cameraMove: 'push-in', duration: 10 });
    const compiled = compileVideoDialectPrompt({
      project,
      shot,
      dialectIdOrPlatform: 'minimax_hailuo_2_3',
      promptMode: 'i2v_motion_only',
      resolution: '1080P',
    });

    expect(compiled.prompt).toContain('[Push in]');
    expect(compiled.apiHints.promptOptimizer).toBe(false);
    expect(compiled.lockedDurationSec).toBe(6);
  });

  it('Veo 3.1 与参数剥离：带参考图或 4K 时锁定 8 秒，正文自动剥离 1080p/4K/16:9 参数文本', () => {
    const cleaned = stripProseParameters(
      'Snow falls gently, 16:9 aspect ratio, 4K resolution, duration: 5s',
    );
    expect(cleaned.stripped).toBe(true);
    expect(cleaned.text).not.toMatch(/16:9|4K|duration:/i);

    const veoLock = compileReferenceBindings({
      dialect: resolveVideoDialect('veo_3_1'),
      references: [{ kind: 'image', name: 'AlpinePeak', role: 'scene' }],
      durationSec: 5,
    });
    expect(veoLock.lockedDurationSec).toBe(8);
    expect(veoLock.warnings[0]).toContain('8 秒');
  });

  it('成本分档与镜头意图路由：draft 与 final 给出差异化方言与成本参考', () => {
    const project = makeEmptyProject('短剧测试', { videoMode: 'narrative' });
    const subtleShot = makeSampleShot({ dialogue: '', characterIds: ['c1'] });
    const draftRoute = ShotRendererRouter.recommendRoute(subtleShot, project, 'draft');
    const finalRoute = ShotRendererRouter.recommendRoute(subtleShot, project, 'final');

    expect(draftRoute.tier).toBe('draft');
    expect(finalRoute.tier).toBe('final');
    expect(draftRoute.estimatedUsdPerSec).toBeLessThan(finalRoute.estimatedUsdPerSec);

    const formulaShot = makeSampleShot({
      renderEngine: 'manim',
      codeRenderSpec: 'Animate Fourier series convergence',
    });
    const formulaRoute = ShotRendererRouter.recommendRoute(formulaShot, project, 'final');
    expect(formulaRoute.intent).toBe('data_formula');
    expect(formulaRoute.engine).toBe('manim');
  });

  it('Phase 0 本地媒体缓存过期估算：准确识别阿里云 24h 与海螺 72h 链接有效期', () => {
    expect(remoteUrlTtlHours('dashscope.aliyuncs.com')).toBe(24);
    expect(remoteUrlTtlHours('minimax hailuo')).toBe(72);

    const start = '2026-11-25T10:00:00.000Z';
    const exp = estimateRemoteUrlExpiry('dashscope', start);
    expect(exp).toBe('2026-11-26T10:00:00.000Z');
    const hint = formatExpiryHint(exp, Date.parse('2026-11-25T22:00:00.000Z'));
    expect(hint).toContain('12 小时');
  });
});
