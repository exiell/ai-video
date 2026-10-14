import { describe, expect, it } from 'vitest';
import {
  buildCharacterSheetSpec,
  CHARACTER_SHEET_KIND_LABEL,
  FACE_VIEWS,
  pickReferenceImages,
  TURNAROUND_VIEWS,
  withReferences,
} from '../src/domain/image/characterSheet';
import { buildCharacterSheetPrompt } from '../src/domain/image/prompts';
import { findProfile } from '../src/data/models/profiles';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { ImageRequest, ModelCapabilities } from '../src/types/model';

const capsWithRefs: ModelCapabilities = {
  negativePrompt: true,
  seed: true,
  referenceImage: true,
  maxReferenceImages: 3,
  maxOutputImages: 6,
};

const capsNoRefs: ModelCapabilities = {
  negativePrompt: true,
  seed: true,
  referenceImage: false,
  maxReferenceImages: 0,
  maxOutputImages: 1,
};

/**
 * 形象图规格。
 *
 * 参照样例（用户提供的《林薇形象》）包含：全身多视图（正面/侧面/背面/四分之三）、
 * 俯视与仰视、头部特写（正/侧/后脑）、材质细节、色卡。
 *
 * 这里只实现前两类，并且**拆成两张图**——原因见 characterSheet.ts 顶部说明。
 */

describe('全身多视图 · 视角覆盖', () => {
  it('覆盖六个视角，比常规三视图多出四分之三、俯视、仰视', () => {
    const views = TURNAROUND_VIEWS.map((v) => v.en).join(' ');
    expect(views).toContain('front view');
    expect(views).toContain('side profile');
    expect(views).toContain('back view');
    expect(views).toContain('three-quarter');
    // 俯视与仰视：决定「从楼上往下看」这类镜头里角色长什么样
    expect(views).toContain('high angle');
    expect(views).toContain('low angle');
  });

  it('每个视角都有中文标注，界面上能对上号', () => {
    for (const view of TURNAROUND_VIEWS) {
      expect(view.zh.length).toBeGreaterThan(0);
      expect(view.en.length).toBeGreaterThan(0);
    }
    expect(TURNAROUND_VIEWS.map((v) => v.zh).join(' ')).toContain('FRONT');
  });
});

describe('头部特写 · 视角覆盖', () => {
  it('覆盖正、侧、背面三个角度', () => {
    const views = FACE_VIEWS.map((v) => v.en).join(' ');
    expect(views).toContain('front');
    expect(views).toContain('side profile');
    // 背面是扎辫子/盘发/戴帽子的角色唯一能说清发型的地方
    expect(views).toContain('back view of the head');
  });

  it('只有三个角度：头部特写要的是清晰，不是多', () => {
    expect(FACE_VIEWS).toHaveLength(3);
  });
});

describe('形象图规格 · 两种类型', () => {
  const locks = ['a worn padded cotton robe in faded indigo'];
  const styles = ['anime style', 'cel shading'];

  it('全身图要求全身入画、姿态标准', () => {
    const spec = buildCharacterSheetSpec('turnaround', 'Lin Chong, a warrior', locks, styles);
    expect(spec.kind).toBe('turnaround');
    expect(spec.positive).toContain('full body from head to feet');
    expect(spec.positive).toContain('arms relaxed at the sides');
    // 六个视角的标签
    expect(spec.positive).toContain('TOP');
    expect(spec.positive).toContain('BOTTOM');
  });

  it('头部特写刻意裁到锁骨，让脸占满画面', () => {
    const spec = buildCharacterSheetSpec('face', 'Lin Chong, a warrior', locks, styles);
    expect(spec.kind).toBe('face');
    expect(spec.positive).toContain('head and shoulders only');
    expect(spec.positive).toContain('large and clearly readable');
    expect(spec.positive).toContain('FRONT');
    expect(spec.positive).toContain('BACK');
  });

  it('两种图都带上锁面与风格词，图和文字说同一件事', () => {
    for (const kind of ['turnaround', 'face'] as const) {
      const spec = buildCharacterSheetSpec(kind, 'X', locks, styles);
      expect(spec.positive).toContain(locks[0]!);
      expect(spec.positive).toContain('cel shading');
    }
  });

  it('两种图都要求纯灰背景与均匀打光', () => {
    for (const kind of ['turnaround', 'face'] as const) {
      const spec = buildCharacterSheetSpec(kind, 'X', [], []);
      expect(spec.positive).toContain('neutral grey background');
      expect(spec.positive).toContain('even soft studio lighting');
    }
  });

  it('头部特写的说明里讲清了「为什么锁脸不能靠全身图」', () => {
    const spec = buildCharacterSheetSpec('face', 'X', [], []);
    const framingNote = spec.notes.find((n) => n.label === '取景范围')!;
    expect(framingNote.reason).toContain('几十像素');
  });

  it('全身图的说明里讲清了俯视仰视的用处', () => {
    const spec = buildCharacterSheetSpec('turnaround', 'X', [], []);
    const viewNote = spec.notes.find((n) => n.label.includes('视角'))!;
    expect(viewNote.reason).toContain('俯视');
  });

  it('每条说明都有实质理由，不能只有标签', () => {
    for (const kind of ['turnaround', 'face'] as const) {
      for (const note of buildCharacterSheetSpec(kind, 'X', [], []).notes) {
        expect(note.reason.length).toBeGreaterThan(15);
      }
    }
  });

  it('两种类型都有中文显示名', () => {
    expect(CHARACTER_SHEET_KIND_LABEL.turnaround).toContain('全身');
    expect(CHARACTER_SHEET_KIND_LABEL.face).toContain('锁脸');
  });
});

describe('提示词构造 · 接入规格后', () => {
  it('全身图与头部特写产出不同的提示词', () => {
    const full = buildCharacterSheetPrompt(sampleProject, 'ch-linchong', 'turnaround')!;
    const face = buildCharacterSheetPrompt(sampleProject, 'ch-linchong', 'face')!;
    expect(full.positive).not.toBe(face.positive);
    expect(full.subjectLabel).toContain('全身');
    expect(face.subjectLabel).toContain('头部');
  });

  it('头部特写用横构图，三个头并排才不会被挤小', () => {
    const face = buildCharacterSheetPrompt(sampleProject, 'ch-linchong', 'face')!;
    expect(face.aspectRatio).toBe('16:9');
  });

  it('带着色器的角色负向词会被合并进去', () => {
    const prompt = buildCharacterSheetPrompt(sampleProject, 'ch-linchong', 'turnaround')!;
    const character = sampleProject.characters.find((c) => c.id === 'ch-linchong')!;
    expect(prompt.negative).toContain(character.negativePrompt);
  });

  it('默认仍是全身图，不传 kind 不会出错', () => {
    const prompt = buildCharacterSheetPrompt(sampleProject, 'ch-linchong')!;
    expect(prompt.subjectLabel).toContain('全身');
  });
});

describe('参考图挑选 · 头部特写优先', () => {
  function asset(kind: string, createdAt: string, dataUrl: string) {
    return { kind, createdAt, dataUrl };
  }

  it('头部特写排在全身图前面（锁脸主要靠它）', () => {
    const picks = pickReferenceImages(
      [
        asset('character-sheet', '2026-01-01T00:00:00Z', 'full-1'),
        asset('character-sheet-face', '2026-01-02T00:00:00Z', 'face-1'),
      ],
      capsWithRefs,
    );
    expect(picks[0]!.dataUrl).toBe('face-1');
    expect(picks[0]!.label).toContain('锁脸');
    expect(picks[1]!.dataUrl).toBe('full-1');
  });

  it('同一类型里新的优先（重生成说明对旧的不满意）', () => {
    const picks = pickReferenceImages(
      [
        asset('character-sheet-face', '2026-01-01T00:00:00Z', 'old'),
        asset('character-sheet-face', '2026-01-05T00:00:00Z', 'new'),
      ],
      capsWithRefs,
    );
    expect(picks[0]!.dataUrl).toBe('new');
  });

  it('不把关键帧或场景板当成角色参考图', () => {
    const picks = pickReferenceImages(
      [
        asset('keyframe', '2026-02-01T00:00:00Z', 'shot'),
        asset('scene-plate', '2026-02-01T00:00:00Z', 'scene'),
      ],
      capsWithRefs,
    );
    expect(picks).toHaveLength(0);
  });

  it('数量不超过模型能力上限', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      asset(i % 2 === 0 ? 'character-sheet-face' : 'character-sheet', `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, `d${i}`),
    );
    expect(pickReferenceImages(many, capsWithRefs)).toHaveLength(3);
    expect(pickReferenceImages(many, { ...capsWithRefs, maxReferenceImages: 1 })).toHaveLength(1);
  });

  it('不支持参考图的模型返回空数组，不会硬塞', () => {
    const picks = pickReferenceImages(
      [asset('character-sheet-face', '2026-01-01T00:00:00Z', 'face')],
      capsNoRefs,
    );
    expect(picks).toEqual([]);
  });

  it('没有 dataUrl 的素材被跳过（不拿一个会过期的链接当参考图）', () => {
    const picks = pickReferenceImages(
      [
        { kind: 'character-sheet-face', createdAt: '2026-01-01T00:00:00Z' },
        asset('character-sheet', '2026-01-01T00:00:00Z', 'full'),
      ],
      capsWithRefs,
    );
    expect(picks).toHaveLength(1);
    expect(picks[0]!.dataUrl).toBe('full');
  });

  it('余量够时会再放一张不同批次的头部特写', () => {
    const picks = pickReferenceImages(
      [
        asset('character-sheet-face', '2026-01-03T00:00:00Z', 'face-new'),
        asset('character-sheet-face', '2026-01-02T00:00:00Z', 'face-old'),
        asset('character-sheet', '2026-01-01T00:00:00Z', 'full'),
      ],
      capsWithRefs,
    );
    expect(picks.map((p) => p.dataUrl)).toEqual(['face-new', 'full', 'face-old']);
  });
});

describe('参考图打包进请求', () => {
  it('把挑选结果写进 referenceImages', () => {
    const request: ImageRequest = { prompt: 'x' };
    const result = withReferences(request, [{ dataUrl: 'a', label: 'l' }]);
    expect(result.referenceImages).toEqual(['a']);
  });

  it('没有挑到图时不改动请求', () => {
    const request: ImageRequest = { prompt: 'x' };
    expect(withReferences(request, [])).toBe(request);
  });
});

describe('档案能力与新类型的一致性', () => {
  it('默认参考图档案声明了足够的上限（够放头部特写 + 全身图）', () => {
    const profile = findProfile('qwen-image-edit')!;
    expect(profile.capabilities.maxReferenceImages).toBeGreaterThanOrEqual(2);
  });
});
