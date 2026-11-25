import { describe, expect, it } from 'vitest';
import { sampleProject } from '../src/data/samples/sampleProject';
import { normalizeProject, parseImportedProject } from '../src/services/storage';
import {
  canServeAsCanonicalAnchor,
  formatSurgicalEditPrompt,
  planCanonicalReferencePool,
} from '../src/domain/image/referencePlan';
import { compileVideoDialectPrompt } from '../src/domain/prompt';
import { checkAudio, estimateSpokenDurationSec } from '../src/domain/checks/audio';
import { checkStateAndCamera } from '../src/domain/checks/stateDelta';
import { runChecks } from '../src/domain/checks';
import { applyFixes, buildFixPlan } from '../src/domain/checks/autoFix';
import {
  compileShotGroupPrompt,
  suggestShotGroups,
} from '../src/domain/pipeline/shotGrouping';
import { assetsSchema, shotsSchema } from '../src/services/llm/schemas';
import { assetsFromGenerated, shotsFromGenerated } from '../src/services/llm/mapping';
import type { Project } from '../src/types/model';

describe('Phase 2：结构化音画、主参考池防漂移、跨镜状态变化与多镜头编组', () => {
  it('旧版项目 JSON（不含 Phase 2 字段）导入与归一化 100% 兼容', () => {
    const legacy = structuredClone(sampleProject);
    const parsed = parseImportedProject(JSON.stringify(legacy));
    expect(parsed.ok).toBe(true);
    expect(parsed.project?.props).toBeUndefined();
    expect(parsed.project?.shotGroups).toBeUndefined();
    expect(parsed.project?.characters[0]?.voiceProfile).toBeUndefined();
  });

  it('新版项目 JSON 含 voiceProfile / props / audioSpec / stateDeltas / shotGroups 完整归一化保留', () => {
    const p: Project = structuredClone(sampleProject);
    p.characters[0]!.voiceProfile = {
      language: 'zh',
      dialectOrAccent: '北方口音',
      timbreNote: '低沉稳重',
      referenceVoiceUrl: 'https://cdn.example.com/voice-lin.wav',
    };
    p.props = [
      {
        id: 'prop-spear',
        name: '花枪',
        canonicalTraits: 'worn iron-tipped spear with red tassel',
        ownerCharacterId: p.characters[0]!.id,
      },
    ];
    p.shots[0]!.propIds = ['prop-spear'];
    p.shots[0]!.audioSpec = {
      mode: 'native_video_audio',
      dialogues: [
        {
          id: 'dlg-1',
          speakerCharacterId: p.characters[0]!.id,
          speakerLabel: p.characters[0]!.name,
          text: '这风雪越来越紧了。',
          emotionTone: '低沉警觉',
          delivery: 'on_screen_lip_sync',
        },
      ],
      sfx: ['寒风呼啸', '踩雪咯吱声'],
      ambience: '雪夜空旷风声',
      suppressEmbeddedSubtitles: true,
    };
    p.shots[0]!.stateDeltas = [
      {
        entityType: 'character',
        entityId: p.characters[0]!.id,
        changeableAttrs: { cloak: '肩头落满积雪' },
        reason: '走入暴雪中',
      },
    ];

    const normalized = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(normalized.characters[0]?.voiceProfile?.dialectOrAccent).toBe('北方口音');
    expect(normalized.props?.[0]?.name).toBe('花枪');
    expect(normalized.shots[0]?.audioSpec?.dialogues[0]?.text).toBe('这风雪越来越紧了。');
    expect(normalized.shots[0]?.stateDeltas?.[0]?.changeableAttrs.cloak).toBe('肩头落满积雪');
  });

  it('受保护规范主参考池拦截下游分镜帧覆写，并在局部微调与重绘模式下格式化提示词', () => {
    expect(canServeAsCanonicalAnchor('character-sheet')).toBe(true);
    expect(canServeAsCanonicalAnchor('scene-plate')).toBe(true);
    expect(canServeAsCanonicalAnchor('first-frame')).toBe(false);
    expect(canServeAsCanonicalAnchor('end-frame')).toBe(false);

    const pool = planCanonicalReferencePool({
      entityType: 'character',
      entityName: '林冲',
      canonicalCandidates: [
        {
          kind: 'first-frame',
          dataUrl: 'data:image/png;base64,downstream-frame',
          createdAt: '2026-05-02T00:00:00Z',
        },
        {
          kind: 'character-sheet',
          dataUrl: 'data:image/png;base64,canonical-master',
          createdAt: '2026-05-01T00:00:00Z',
        },
      ],
      supplementaryCandidates: [
        {
          kind: 'end-frame',
          dataUrl: 'data:image/png;base64,prev-end',
          createdAt: '2026-05-02T00:00:00Z',
        },
      ],
      isContinuous: true,
    });

    expect(pool.canonicalAnchor?.dataUrl).toBe('data:image/png;base64,canonical-master');
    expect(pool.canonicalAnchor?.immutable).toBe(true);
    expect(pool.supplementaryAnchors).toHaveLength(1);
    expect(pool.warnings.some((w) => w.includes('已拦截'))).toBe(true);

    const surgical = formatSurgicalEditPrompt({
      mode: 'surgical_edit',
      changeInstruction: '把表情改为凝重皱眉',
      preserveNote: '发型与旧棉袍保持不变',
    });
    expect(surgical).toContain('仅修改以下指定项：把表情改为凝重皱眉');
    expect(surgical).toContain('严格保留不变项：发型与旧棉袍保持不变');

    const redraw = formatSurgicalEditPrompt({
      mode: 'canonical_redraw',
      changeInstruction: '把背景光线调整为冷蓝月光',
    });
    expect(redraw).toContain('以规范主参考图为准重新生成');
  });

  it('音频编译在 Kling/Wan 绑定参考音频时自动抑制文字音色描述，并保留 StateDelta 增量说明', () => {
    const p: Project = structuredClone(sampleProject);
    const char = p.characters[0]!;
    char.voiceProfile = {
      language: 'zh',
      timbreNote: '沧桑沙哑大叔音',
      referenceVoiceUrl: 'https://example.com/voice-sample.mp3',
    };
    const shot = p.shots[0]!;
    shot.audioSpec = {
      mode: 'native_video_audio',
      dialogues: [
        {
          id: 'd1',
          speakerCharacterId: char.id,
          speakerLabel: char.name,
          text: '站住，别动！',
          emotionTone: '冷峻喝止',
          delivery: 'on_screen_lip_sync',
        },
      ],
      sfx: ['拔刀出鞘声'],
      ambience: '风雪呼啸',
      suppressEmbeddedSubtitles: true,
    };
    shot.stateDeltas = [
      {
        entityType: 'character',
        entityId: char.id,
        changeableAttrs: { robe: '衣摆沾满融雪泥渍' },
        reason: '雪地疾行',
      },
    ];

    const compiled = compileVideoDialectPrompt({
      project: p,
      shot,
      dialectIdOrPlatform: 'kling_3',
      promptMode: 'i2v_motion_only',
    });

    expect(compiled.prompt).toContain(`[${char.name} (冷峻喝止)]: "站住，别动！"`);
    expect(compiled.prompt).not.toContain('沧桑沙哑大叔音');
    expect(compiled.warnings.some((w) => w.includes('自动抑制文字音色'))).toBe(true);
    expect(compiled.prompt).toContain('robe: 衣摆沾满融雪泥渍');
    expect(compiled.prompt).toContain('No subtitles.');
  });

  it('audio-dialogue-overflow 与 audio-voice-timbre-conflict 确定性检出准确', () => {
    const est = estimateSpokenDurationSec('一二三四五六七八九十一二三四五六七八九十');
    expect(est.cjkCount).toBe(20);
    expect(est.seconds).toBeCloseTo(5, 1);

    const p: Project = structuredClone(sampleProject);
    p.characters[0]!.voiceProfile = {
      language: 'zh',
      timbreNote: '浑厚男低音',
      referenceVoiceUrl: 'https://example.com/ref.wav',
    };
    p.shots[0]!.duration = 3;
    p.shots[0]!.dialogue = '这草料场今夜风雪极大，我总觉得四下里透着一股说不出来的诡异气息，咱们还是赶紧查清楚吧。';

    const issues = checkAudio(p);
    expect(issues.some((i) => i.ruleId === 'audio-dialogue-overflow')).toBe(true);
    expect(issues.some((i) => i.ruleId === 'audio-voice-timbre-conflict')).toBe(true);
  });

  it('camera-multi-move-conflict 检出后可由 AutoFix 机械清理冲突运镜并保留主运镜', () => {
    const p: Project = structuredClone(sampleProject);
    const shot = p.shots[0]!;
    shot.cameraMove = 'push-in';
    shot.cameraPosition = '低机位推近，同时拉远并环绕主角';

    const issues = checkStateAndCamera(p);
    const conflict = issues.find((i) => i.ruleId === 'camera-multi-move-conflict');
    expect(conflict).toBeTruthy();

    const report = runChecks(p);
    const plan = buildFixPlan(p, report);
    const fix = plan.proposals.find((item) => item.kind === 'normalize-camera-move');
    expect(fix).toBeTruthy();

    const applied = applyFixes(p, [fix!]);
    expect(applied.applied).toBe(1);
    const fixedShot = applied.project.shots.find((s) => s.id === shot.id)!;
    expect(fixedShot.cameraMove).toBe('push-in');
    expect(fixedShot.cameraPosition).not.toContain('拉远');
    expect(fixedShot.cameraPosition).not.toContain('环绕');
  });

  it('state-delta-undeclared 检出相邻同场次未声明状态突变，补记 stateDeltas 后自动消除', () => {
    const p: Project = structuredClone(sampleProject);
    const s1 = p.shots[0]!;
    const s2 = p.shots[1]!;
    s2.sceneId = s1.sceneId;
    s1.transitionType = 'continuation';
    s1.startState = '林冲站在干燥的屋檐下。';
    s1.action = '林冲抬头望天。';
    s1.endState = '林冲迈出屋檐。';
    s2.startState = '林冲浑身湿透，衣襟滴水。';
    s2.action = '林冲握紧花枪转身。';
    s2.endState = '林冲停在门前。';
    s2.stateDeltas = undefined;

    const before = checkStateAndCamera(p).filter((i) => i.ruleId === 'state-delta-undeclared');
    expect(before.some((i) => i.location.id === s2.id)).toBe(true);

    s2.stateDeltas = [
      {
        entityType: 'character',
        entityId: p.characters[0]!.id,
        changeableAttrs: { wardrobe: '浑身湿透' },
        reason: '走出屋檐被暴雨浇透',
      },
    ];
    const after = checkStateAndCamera(p).filter(
      (i) => i.ruleId === 'state-delta-undeclared' && i.location.id === s2.id,
    );
    expect(after).toHaveLength(0);
  });

  it('同场次连续对话自动编组并分别编译 Kling 3.0 Multi-Shot / Seedance 2.5 时间戳 / Runway 降级', () => {
    const p: Project = structuredClone(sampleProject);
    const sceneId = p.scenes[0]!.id;
    // 确保前 3 镜同场次连续对话
    for (let i = 0; i < 3; i += 1) {
      const s = p.shots[i]!;
      s.sceneId = sceneId;
      s.duration = 4;
      s.transitionType = 'continuation';
      s.dialogue = `第 ${i + 1} 句对白。`;
    }

    const groups = suggestShotGroups(p);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const firstGroup = groups[0]!;
    expect(firstGroup.shotIds.length).toBeGreaterThanOrEqual(2);
    expect(firstGroup.shotIds.length).toBeLessThanOrEqual(6);

    const kling = compileShotGroupPrompt(p, firstGroup, 'kling_3');
    expect(kling.strategy).toBe('native_multi_shot');
    expect(kling.prompt).toContain('Multi-Shot Sequence');
    expect(kling.prompt).toContain('Shot 1 (0s-4s):');

    const seedance = compileShotGroupPrompt(p, firstGroup, 'seedance_2_5');
    expect(seedance.prompt).toContain('[0.0s-4.0s]');
    expect(seedance.prompt).toContain('No subtitles.');

    const runway = compileShotGroupPrompt(p, firstGroup, 'runway_gen4_5');
    expect(runway.strategy).toBe('chained_last_frame');
    expect(runway.warnings.some((w) => w.includes('尾帧接力'))).toBe(true);
  });

  it('LLM Schema 与映射层正确解析 props / voiceProfile / audioSpec / stateDeltas', () => {
    const parsedAssets = assetsSchema.parse({
      characters: [
        {
          slug: 'hero',
          name: '林冲',
          role: 'protagonist',
          identity: { summaryEn: 'tall swordsman in dark coat' },
          voiceProfile: { language: 'zh', timbreNote: '低沉沙哑' },
        },
      ],
      scenes: [
        {
          slug: 'inn',
          name: '山神庙',
          identity: { summaryEn: 'ruined mountain temple in heavy snow' },
        },
      ],
      props: [
        {
          slug: 'iron-spear',
          name: '花枪',
          canonicalTraits: 'weathered iron spear with faded red tassel',
          ownerCharacterSlug: 'hero',
        },
      ],
    });
    const mappedAssets = assetsFromGenerated(parsedAssets);
    expect(mappedAssets.props).toHaveLength(1);
    expect(mappedAssets.props![0]!.ownerCharacterId).toBe(mappedAssets.characters[0]!.id);
    expect(mappedAssets.characters[0]!.voiceProfile?.timbreNote).toBe('低沉沙哑');

    const parsedShots = shotsSchema.parse({
      shots: [
        {
          duration: 4,
          shotSize: 'medium',
          cameraMove: 'push-in',
          startState: '林冲握枪站在庙门内',
          action: '林冲低声开口并推开木门',
          endState: '风雪灌入庙门',
          sceneSlug: 'inn',
          characterSlugs: ['hero'],
          propSlugs: ['iron-spear'],
          audioSpec: {
            mode: 'native_video_audio',
            dialogues: [
              {
                speakerSlug: 'hero',
                speakerLabel: '林冲',
                text: '外面有人。',
                delivery: 'on_screen_lip_sync',
              },
            ],
            sfx: ['木门吱呀声'],
            suppressEmbeddedSubtitles: true,
          },
          stateDeltas: [
            {
              entityType: 'prop',
              entitySlug: 'iron-spear',
              changeableAttrs: { blade: '枪尖凝霜' },
              reason: '寒气逼人',
            },
          ],
        },
      ],
    });

    const mappedShots = shotsFromGenerated(parsedShots, mappedAssets, [{ id: 'ss-1' }]);
    const s = mappedShots.shots[0]!;
    expect(s.propIds).toEqual([mappedAssets.props![0]!.id]);
    expect(s.audioSpec?.dialogues[0]?.speakerCharacterId).toBe(mappedAssets.characters[0]!.id);
    expect(s.stateDeltas?.[0]?.entityId).toBe(mappedAssets.props![0]!.id);
  });
});
