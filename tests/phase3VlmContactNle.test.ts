import { describe, expect, it } from 'vitest';
import { sampleProject } from '../src/data/samples/sampleProject';
import {
  buildCriticMessages,
  critiqueShotFrame,
  parseCriticResponse,
} from '../src/services/vlm/critic';
import { groundShotMotionWithVlm } from '../src/services/vlm/motionGrounder';
import { computeContactSheetLayout } from '../src/domain/image/contactSheet';
import { exportToOtioJson } from '../src/domain/export/otio';
import { exportToFcpxml } from '../src/domain/export/fcpxml';
import { exportToJianyingDraft } from '../src/domain/export/jianyingDraft';
import { exportToSrt } from '../src/domain/export/srt';
import { buildExportManifest } from '../src/domain/export/bundle';
import { runChecks } from '../src/domain/checks';
import type { Asset, ModelProfile, Project } from '../src/types/model';

const TEST_VLM_PROFILE: ModelProfile = {
  id: 'test-vlm',
  vendorId: 'openai',
  name: 'Test Vision Model',
  provider: 'openai',
  type: 'llm',
  model: 'gpt-4o-mini',
  endpoint: 'https://api.example.com/v1/chat/completions',
  authType: 'bearer',
  lang: 'en',
  corsDirect: 'yes',
  capabilities: {
    negativePrompt: false,
    seed: false,
    referenceImage: false,
    maxReferenceImages: 0,
    maxOutputImages: 0,
  },
};

function makeFakeFetch(content: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;
}

describe('Phase 3：VLM 视觉质检、首帧运动接地、分镜联系表与纯 TS 剪辑时间线导出', () => {
  it('VLM Critic 构造含规范主图与已声明 StateDelta 的多模态请求并经 ModelGateway 返回结构化裁决', async () => {
    const p: Project = structuredClone(sampleProject);
    const shot = p.shots[0]!;
    shot.stateDeltas = [
      {
        entityType: 'character',
        entityId: p.characters[0]!.id,
        changeableAttrs: { coat: '落雪变湿' },
        reason: '走出门进入暴雪',
      },
    ];

    const msgs = buildCriticMessages({
      project: p,
      shot,
      candidateDataUrl: 'data:image/png;base64,CANDIDATE',
      canonicalRefs: [{ label: '林冲主图', dataUrl: 'data:image/png;base64,CANON' }],
    });
    expect(msgs).toHaveLength(2);
    expect(Array.isArray(msgs[1]!.content)).toBe(true);
    const serialized = JSON.stringify(msgs[1]!.content);
    expect(serialized).toContain('落雪变湿');
    expect(serialized).toContain('data:image/png;base64,CANON');
    expect(serialized).toContain('data:image/png;base64,CANDIDATE');

    const mockResp = JSON.stringify({
      verdict: 'minor_fix',
      scores: { identity: 9, wardrobeAndProps: 8, lightingAndScene: 9, artifacts: 7 },
      summary: '人物五官与主图一致，但右手手指轻微粘连。',
      issues: ['右手手指细节略模糊'],
      recommendedAction: '仅修正右手五指轮廓，严格保留面部、棉袍和雪景不变。',
    });

    const outcome = await critiqueShotFrame({
      profile: TEST_VLM_PROFILE,
      apiKey: 'sk-test',
      project: p,
      shot,
      candidateDataUrl: 'data:image/png;base64,CANDIDATE',
      canonicalRefs: [{ label: '林冲主图', dataUrl: 'data:image/png;base64,CANON' }],
      fetchImpl: makeFakeFetch(mockResp),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.result?.verdict).toBe('minor_fix');
    expect(outcome.result?.scores.identity).toBe(9);
    expect(outcome.result?.recommendedAction).toContain('仅修正右手五指轮廓');

    const bad = parseCriticResponse('not json at all');
    expect(bad.ok).toBe(false);
  });

  it('Motion Grounder 支持 VLM 首帧构图接地，且在未配置模型时自动安全回退到本地 I2V 编译', async () => {
    const p: Project = structuredClone(sampleProject);
    const shot = p.shots[0]!;

    // 1. VLM 正常返回
    const vlmRes = await groundShotMotionWithVlm({
      profile: TEST_VLM_PROFILE,
      apiKey: 'sk-test',
      project: p,
      shot,
      firstFrameDataUrl: 'data:image/png;base64,FIRSTFRAME',
      dialectIdOrPlatform: 'kling_3',
      fetchImpl: makeFakeFetch(
        JSON.stringify({
          spatialLayout: '林冲位于画面左侧三分之一处，面朝右侧半掩的木门。',
          groundedMotionPrompt:
            'The figure on the left third steps steadily toward the wooden door on the right, slow dolly-in, keep existing clothing and background steady.',
          avoidPitfalls: ['避免让角色转身背对镜头'],
        }),
      ),
    });
    expect(vlmRes.ok).toBe(true);
    expect(vlmRes.usedVlm).toBe(true);
    expect(vlmRes.result.groundedMotionPrompt).toContain('left third');

    // 2. 未配置视觉模型时无报错降级
    const fallbackRes = await groundShotMotionWithVlm({
      project: p,
      shot,
      firstFrameDataUrl: 'data:image/png;base64,FIRSTFRAME',
      dialectIdOrPlatform: 'kling_3',
    });
    expect(fallbackRes.ok).toBe(true);
    expect(fallbackRes.usedVlm).toBe(false);
    expect(fallbackRes.result.groundedMotionPrompt.length).toBeGreaterThan(10);
  });

  it('Contact Sheet 布局计算器准确输出行列、累计时间码与 9:16 / 16:9 适配尺寸', () => {
    const p: Project = structuredClone(sampleProject);
    p.brief.aspectRatio = '9:16';
    const assets: Asset[] = [
      {
        id: 'a1',
        projectId: p.id,
        refId: p.shots[0]!.id,
        kind: 'first-frame',
        dataUrl: 'data:image/png;base64,AAA',
        mimeType: 'image/png',
        promptSnapshot: 'p',
        schemaVersion: 1,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ];

    const layout = computeContactSheetLayout(p, assets);
    expect(layout.columns).toBe(4); // 竖屏默认 4 列
    expect(layout.totalShots).toBe(p.shots.length);
    expect(layout.coveredShots).toBe(1);
    expect(layout.cells[0]?.timecode).toBe('00:00');
    expect(layout.cells[0]?.dataUrl).toBe('data:image/png;base64,AAA');
    expect(layout.cells[1]?.startSec).toBe(p.shots[0]!.duration);
    expect(layout.width).toBeGreaterThan(1000);
  });

  it('纯 TS 导出器生成合法的 OTIO / FCPXML v1.10 / 剪映草稿 / SRT，并支持本机落盘路径关联', () => {
    const p: Project = structuredClone(sampleProject);
    p.name = '雪夜 & <山神庙> "试拍"';
    p.brief.aspectRatio = '9:16';
    const s0 = p.shots[0]!;
    s0.duration = 4;
    s0.audioSpec = {
      mode: 'native_video_audio',
      dialogues: [
        {
          id: 'd1',
          speakerLabel: '林冲',
          text: '外面风雪大得很。',
          delivery: 'on_screen_lip_sync',
        },
      ],
      sfx: ['风雪声'],
      suppressEmbeddedSubtitles: true,
    };
    s0.stateDeltas = [
      {
        entityType: 'character',
        entityId: p.characters[0]!.id,
        changeableAttrs: { shoulder: '落满积雪' },
        reason: '走入雪夜',
      },
    ];
    const clipPaths = {
      [s0.id]: 'C:\\Users\\demo\\aniguide\\media\\shot_01.mp4',
    };

    // 1. OTIO
    const otioRaw = exportToOtioJson(p, { fps: 30, clipPathsByShotId: clipPaths });
    const otio = JSON.parse(otioRaw);
    expect(otio.OTIO_SCHEMA).toBe('Timeline.1');
    expect(otio.tracks.children).toHaveLength(2);
    const firstClip = otio.tracks.children[0].children[0];
    expect(firstClip.source_range.duration.value).toBe(120); // 4s * 30fps
    expect(firstClip.media_reference.target_url).toBe(
      'file:///C:/Users/demo/aniguide/media/shot_01.mp4',
    );
    expect(firstClip.markers.some((m: { color: string }) => m.color === 'ORANGE')).toBe(true);

    // 2. FCPXML v1.10 (含 XML 实体转义)
    const fcpxml = exportToFcpxml(p, { fps: 30, clipPathsByShotId: clipPaths });
    expect(fcpxml).toContain('<fcpxml version="1.10">');
    expect(fcpxml).toContain('width="1080" height="1920"');
    expect(fcpxml).toContain('duration="120/30s"');
    expect(fcpxml).toContain('&amp; &lt;山神庙&gt; &quot;试拍&quot;');
    expect(fcpxml).toContain('file:///C:/Users/demo/aniguide/media/shot_01.mp4');

    // 3. 剪映草稿（微秒时间轴）
    const jy = exportToJianyingDraft(p, { fps: 30, clipPathsByShotId: clipPaths });
    const draft = JSON.parse(jy.draftContentJson);
    const meta = JSON.parse(jy.draftMetaInfoJson);
    expect(draft.canvas_config).toEqual({ width: 1080, height: 1920, ratio: '9:16' });
    expect(draft.materials.videos[0].path).toBe('C:\\Users\\demo\\aniguide\\media\\shot_01.mp4');
    expect(draft.tracks[0].segments[0].target_timerange).toEqual({
      start: 0,
      duration: 4_000_000,
    });
    expect(jy.textSegmentCount).toBeGreaterThanOrEqual(1);
    expect(meta.draft_name).toBe(p.name);

    // 4. SRT 外挂字幕
    const srt = exportToSrt(p);
    expect(srt).toContain('00:00:00,000 --> 00:00:04,000');
    expect(srt).toContain('外面风雪大得很。');

    // 5. 打包清单保持根目录 5 项分工不变
    const manifest = buildExportManifest(p, runChecks(p), { clipPathsByShotId: clipPaths });
    const paths = manifest.map((e) => e.path);
    expect(paths).toContain('参考文档/剪辑时间线/timeline.otio');
    expect(paths).toContain('参考文档/剪辑时间线/timeline.fcpxml');
    expect(paths).toContain('参考文档/剪辑时间线/剪映草稿/draft_content.json');
    expect(paths).toContain('参考文档/剪辑时间线/subtitles.srt');
  });
});
