import type {
  ModelCapabilities,
  PromptNote,
  PromptLine,
  ShotSize,
  TargetPlatform,
} from '../../types/model';
import { PLATFORM_LABEL, SHOT_SIZE_EN, SHOT_SIZE_LABEL } from '../../types/model';
import {
  buildCharacterSheetSpec,
  type CharacterSheetKind,
} from './characterSheet';

/**
 * 人物在这一档景别里应该占画面高度的多少（v0.46 新增）。
 *
 * ===========================================================================
 * 这是什么，以及它**不是**什么
 * ===========================================================================
 * 这是**本项目自定的换算**，不是行业标准。各家摄影教材给的数字有出入，
 * 这里取的是「一眼看过去对不对」的常用值。界面上的说明与导出的提示词文件
 * 都照实标注了这一点，不许它冒充行业规范。
 *
 * ===========================================================================
 * 为什么需要它
 * ===========================================================================
 * 原来说明的是「固定物体相对角色的大小不随镜头改变」。这句话看着没问题，
 * 实际上**没有指代对象**：模型只生成一张图，看不到「别的镜头」。
 * 于是它每次按构图需要自由决定人有多高——同一个房间里的同一张桌子，
 * 在 A 镜里到腰高、在 B 镜里到胸口高。用户看到的就是「人物大小不合理」。
 *
 * 换成一句能算的话：**这一档景别里，人应该占画面高度的几成。**
 * 它至少给了模型一个可以对齐的数，而不是一个它无从查证的承诺。
 */
const SUBJECT_HEIGHT_SHARE: Record<ShotSize, string> = {
  'extreme-wide': 'the character occupies about one eighth of the frame height',
  wide: 'the character occupies about one quarter of the frame height',
  full: 'the character occupies about three quarters of the frame height with the head near the top and the feet near the bottom',
  medium: 'the character occupies most of the frame height with the crop at about the waist',
  'close-up': 'the character occupies most of the frame height from the shoulders up',
  'extreme-close-up': 'the face fills the frame',
};

/** 这一档景别里地面和脚看不看得见。看不见就不谈接触，否则是自相矛盾的指令。 */
const GROUND_VISIBLE: ReadonlySet<ShotSize> = new Set<ShotSize>([
  'extreme-wide',
  'wide',
  'full',
  'medium',
]);

/**
 * 接触与遮挡（v0.46 新增）。
 *
 * 缺了「接触」，画出来的人就像**贴**在背景上的剪影：脚不落地、影子没有平面。
 * 这是「人物像 P 上去的」最直接的技术原因，而不是模型不够好。
 *
 * 缺了「遮挡」，人就永远画在场景**前面**而不是**里面**——
 * 该被桌角挡住的小腿会完整地穿过桌子。
 */
const GROUND_CONTACT = 'the character stands on the same ground plane as the fixed objects with the shadow falling on that plane';

const OCCLUSION = 'objects in front of the character overlap and hide part of the body';

export function subjectHeightShare(shotSize: ShotSize): string {
  return SUBJECT_HEIGHT_SHARE[shotSize];
}

/**
 * 出图提示词引擎（方案.md §3.2 M3/M4）
 *
 * 与 M5 的「视频提示词」是两件事，不要混：
 *  - 出图提示词：描述**一帧静止画面**，用于生成角色定妆图 / 场景参考板 / 关键帧
 *  - 视频提示词：描述**一段动作**，用于图生视频
 *
 * 出图提示词的关键约束：**画面是静止的，所以不能写动作过程，只能写这一瞬间的样子**。
 * 新手最常犯的错就是把「他走过去推开门」这类过程写进出图提示词里，
 * 模型只能随便挑一个瞬间，结果与预期不符。
 */

// ---------------------------------------------------------------------------
// 三种出图目标
// ---------------------------------------------------------------------------

export type ImageTarget =
  | { kind: 'character-sheet'; characterId: string }
  | { kind: 'scene-plate'; sceneId: string }
  | { kind: 'keyframe'; shotId: string };

export interface ImagePromptInput {
  /** 目标对象的中文名，用于说明文案 */
  subjectLabel: string;
  /** 英文正向提示词 */
  positive: string;
  /** 负向词 */
  negative: string;
  /** 画幅 */
  aspectRatio: string;
  /** 注入的连续性锁锁面，用于事后核对 */
  lockPhrases: string[];
  /** 逐项说明 */
  notes: PromptNote[];
  /** 这一镜的景别（英文），供承接镜的说明使用 */
  shotSizeEn?: string;
  /** 这一镜的机位，同上 */
  cameraPositionEn?: string;
}

const SCENE_PLATE_INSTRUCTION =
  'empty environment reference plate, no people, wide establishing view showing the full layout of the space, even lighting, no text, no watermark';

/** 关键帧共用的画质尾缀。只放能被验证的词，不堆无意义的质量词。 */
const QUALITY_TAIL = 'clean line art, consistent proportions, no text, no watermark';

export interface BuildImagePromptOptions {
  project: {
    brief: {
      aspectRatio: string;
      /** 英文风格关键词，会原样进入提示词正文 */
      styleTags: string[];
      /**
       * 作者用中文写的风格倾向。
       *
       * 它不会直接进提示词（出图模型对英文更稳），但它决定 styleTags 该长什么样——
       * 所以界面必须让用户明白：**改风格要改的是 styleTags 那一栏**。
       */
      styleTone?: string;
      negativePrompt: string;
    };
    characters: {
      id: string;
      name: string;
      identity: { summaryEn: string; summary: string };
      continuityLocks: { id: string; phrase: string; appliesTo: string }[];
      negativePrompt?: string;
    }[];
    scenes: {
      id: string;
      name: string;
      identity: { summaryEn: string; summary: string };
      fixedElements: string[];
      lightDirection: string;
      mainColor: string;
      continuityLocks: { id: string; phrase: string; appliesTo: string }[];
    }[];
    shots: {
      id: string;
      number: number;
      shotSize: string;
      cameraPosition: string;
      /** 起点：首帧画它 */
      startState: string;
      /** 唯一动作：动作关键帧从它推导「顶点」 */
      action: string;
      /** 终点：尾帧画它，也是下一镜首帧的接续点 */
      endState: string;
      /** 与下一镜的衔接说明，可选（老项目没有这个字段） */
      continuityNote?: string;
      sceneId: string;
      characterIds: string[];
      activeLockIds: string[];
    }[];
  };
}

/**
 * 角色形象图提示词。
 *
 * 分两种，各自解决一个问题（原因见 characterSheet.ts 顶部的说明）：
 *  - turnaround：全身多视图，锁体型、比例、服装轮廓、发型长度
 *  - face：头部特写，**锁脸**。全身图里的脸只有几十像素，锁不住面部特征。
 */
export function buildCharacterSheetPrompt(
  project: BuildImagePromptOptions['project'],
  characterId: string,
  kind: CharacterSheetKind = 'turnaround',
): ImagePromptInput | null {
  const character = project.characters.find((c) => c.id === characterId);
  if (!character) return null;

  const locks = character.continuityLocks.map((l) => l.phrase);
  const spec = buildCharacterSheetSpec(
    kind,
    character.identity.summaryEn || `${character.name}, an anime character`,
    locks,
    project.brief.styleTags,
  );

  const positive = [spec.positive, QUALITY_TAIL].filter(Boolean).join(', ');
  const negative = [project.brief.negativePrompt, character.negativePrompt]
    .filter(Boolean)
    .join(', ');

  return {
    subjectLabel:
      kind === 'face' ? `角色「${character.name}」头部特写` : `角色「${character.name}」全身多视图`,
    positive,
    negative,
    // 头部特写用竖构图更合适：横构图会把三个头挤在一起，脸变小
    aspectRatio: kind === 'face' ? '16:9' : project.brief.aspectRatio,
    lockPhrases: locks,
    notes: spec.notes,
  };
}

/**
 * 场景参考板提示词。
 *
 * 刻意要求「空无一人」：场景板的作用是固定空间、固定元素与光线，
 * 里面站了人反而会干扰后续把角色放进去。
 */
export function buildScenePlatePrompt(
  project: BuildImagePromptOptions['project'],
  sceneId: string,
): ImagePromptInput | null {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) return null;

  const locks = scene.continuityLocks.map((l) => l.phrase);
  const notes: PromptNote[] = [];

  notes.push({
    fragment: SCENE_PLATE_INSTRUCTION,
    label: '空场景板',
    reason:
      '刻意要求画面里没有人。场景板的作用是固定空间结构与光线，站了人反而会干扰后续把角色放进去。',
  });

  if (scene.fixedElements.length > 0) {
    notes.push({
      fragment: scene.fixedElements.join(', '),
      label: '固定元素',
      reason:
        '观众靠这些认出「还是这间教室」。它们必须出现在参考板里，后续每一镜才有东西可对齐。',
    });
  }

  if (scene.lightDirection) {
    notes.push({
      fragment: scene.lightDirection,
      label: '主光方向',
      reason: '光从哪来，决定了同一处地方在不同镜头里像不像同一个时刻。',
    });
  }

  notes.push({
    fragment: scene.mainColor,
    label: '主色调',
    reason: '色调是观众判断「换了地方」最直接的线索。',
  });

  const positive = [
    scene.identity.summaryEn || scene.name,
    ...scene.fixedElements,
    ...locks,
    scene.mainColor ? `${scene.mainColor} color palette` : '',
    SCENE_PLATE_INSTRUCTION,
    ...project.brief.styleTags,
    QUALITY_TAIL,
  ]
    .filter(Boolean)
    .join(', ');

  return {
    subjectLabel: `场景「${scene.name}」参考板`,
    positive,
    negative: project.brief.negativePrompt,
    aspectRatio: project.brief.aspectRatio,
    lockPhrases: locks,
    notes,
  };
}

/**
 * 镜头三帧。
 *
 * 三种帧在画面内容上是**不同**的，不能只换个名字：
 *
 *  - **首帧 first-frame**：只画起点那一瞬间。终点才出现的动作、姿态、道具状态必须排除，
 *    否则模型会把终点画进第一帧，整段动作就错位了。
 *  - **动作关键帧 action-peak**：画动作**最有张力**的那一瞬间。
 *    它不是起点也不是终点，而是这一段动作的顶点——决定动作的力度和节奏。
 *  - **尾帧 end-frame**：画终点那一格。它是下一镜首帧的接续点，
 *    所以要写清楚人物停在哪、手在哪、画面中心是谁。
 */
export type FrameKind = 'first-frame' | 'action-peak' | 'end-frame';

export function buildFramePrompt(
  project: BuildImagePromptOptions['project'],
  shotId: string,
  kind: FrameKind,
): ImagePromptInput | null {
  const shot = project.shots.find((s) => s.id === shotId);
  if (!shot) return null;

  const scene = project.scenes.find((s) => s.id === shot.sceneId);
  const characters = project.characters.filter((c) => shot.characterIds.includes(c.id));

  // 只取「本镜声明生效」的锁
  const locks: { phrase: string; appliesTo: string }[] = [];
  for (const character of characters) {
    for (const lock of character.continuityLocks) {
      if (shot.activeLockIds.includes(lock.id)) {
        locks.push({ phrase: lock.phrase, appliesTo: lock.appliesTo });
      }
    }
  }
  if (scene) {
    for (const lock of scene.continuityLocks) {
      if (shot.activeLockIds.includes(lock.id)) {
        locks.push({ phrase: lock.phrase, appliesTo: lock.appliesTo });
      }
    }
  }

  const framing = describeFraming(shot, kind);
  const notes: PromptNote[] = [framing.note];

  if (locks.length > 0) {
    notes.push({
      fragment: locks.join(', '),
      label: '连续性锁',
      reason: '这一镜声明生效的锁，原样注入，保证与相邻镜头是同一个角色、同一处地方。',
    });
  }

  if (scene) {
    notes.push({
      fragment: scene.fixedElements.join(', ') || '(场景未登记固定元素)',
      label: '场景固定元素',
      reason: `来自场景卡「${scene.name}」。缺了它们，这一帧看起来就像换了个地方。`,
    });
  }

  /**
   * 尺度锚定（v0.23 起，v0.46 重写）。
   *
   * 【v0.23 的原始问题】镜头之间角色的「大小比例」会变——同一个房间里的
   * 同一张桌子，在 A 镜里到腰高、在 B 镜里到胸口高。
   * 根因是提示词里注入了固定元素，却从没说过这些东西与角色之间的尺寸关系。
   *
   * 【v0.46 修的是这句本身】原来写的是
   * 「fixed objects keep the same size relative to the character as in other shots of this scene」。
   * 「as in other shots」在这一次单图生成里**没有指代对象**——模型看不到别的镜头。
   * 这句话实际上等于没说，所以那个老问题一直没被真正解决。
   *
   * 现在换成两句能落地的：
   *  1. 固定物体与角色的真实尺寸关系不变（去掉「别的镜头」这种空指代）
   *  2. **人物占画面高度的几成**——一个模型可以照着算的数（见 `SUBJECT_HEIGHT_SHARE`）
   */
  if (scene && scene.fixedElements.length > 0) {
    notes.push({
      fragment: 'fixed objects keep their true size relative to the character',
      label: '尺度锚点',
      reason:
        '固定元素（上面已列出）同时充当尺度参照物。这里只声明「它们的相对大小不随镜头改变」，' +
        '不再重复点名具体物件——场景描述里已经说过它们在哪儿了。' +
        '不声明这一点，模型会为了凑构图把桌椅、门窗、草垛随手放大或缩小，' +
        '那正是「镜头之间角色与环境比例变了」的原因。',
    });
  }

  if (characters.length > 0) {
    notes.push({
      fragment: SUBJECT_HEIGHT_SHARE[shot.shotSize as ShotSize] ?? '',
      label: '人物占比',
      reason:
        '这一档景别里人物应该占画面高度的多少。' +
        '**这是本工具自定的换算，不是行业标准**——各家摄影教材给的数字有出入，' +
        '这里取的是「一眼看过去对不对」的常用值，写出来只是为了让模型有个能对齐的数。' +
        '原来这一句写的是「相对大小不随镜头改变（as in other shots）」，' +
        '而模型在这次生成里根本看不到别的镜头，所以那句话一直没起作用。',
    });
  }

  notes.push({
    fragment: SHOT_SIZE_LABEL[shot.shotSize as keyof typeof SHOT_SIZE_LABEL] ?? shot.shotSize,
    label: '景别',
    reason: '景别决定观众离人物多远。近景看情绪，全景看环境。',
  });

  if (shot.cameraPosition) {
    notes.push({
      fragment: shot.cameraPosition,
      label: '机位',
      reason: '机位决定观众站在哪看。它比运镜更重要——运镜是视频阶段的事，机位在这一帧就定死了。',
    });
  }

  if (kind === 'end-frame' && shot.continuityNote) {
    notes.push({
      fragment: shot.continuityNote,
      label: '与下一镜的衔接',
      reason:
        '尾帧的职责是让下一个镜头接得住。如果不清楚下一镜从哪开始，这一帧画得再好也会接得别扭。',
    });
  }

  /**
   * ===========================================================================
   * 角色外观：**永远注入**，不再因为「有参考图」而整体丢弃
   * ===========================================================================
   * 这里修的是一个真实踩过的坑，症状是「上一个镜头只有头巾、下一个镜头戴上了帽子」。
   *
   * 原来的做法：有角色形象图时把 identity.summaryEn 整个丢掉，
   * 理由是「文字重描外观会污染参考图的锚定」。
   *
   * 但 summaryEn 里含有**帽子和发型**——而锁里只有面部、棉袍、花枪，没有头饰。
   * 于是帽子从未进入任何一帧的提示词：
   *   * 分镜的画面描述里写了「毡帽压得低」的镜头 → 模型看到中文里的帽子 → 画了
   *   * 没写的镜头 → 模型完全没有帽子的信息 → 没画
   * 一顶帽子在两个镜头之间凭空消失。
   *
   * 教训：**「不要重描外观」的正确尺度是「不要把同一件事说两遍」，
   * 不是「把外观整个删掉」。** 压缩掉该保留的信息，比重复更有害——
   * 重复只是让模型在两个版本之间摇，而缺失是让模型自己编。
   */
  const characterDescriptions = characters.map(
    (c) => c.identity.summaryEn || `${c.name}, an anime character`,
  );

  /**
   * 去重：同一件事只说一遍。
   *
   * 【v0.23 修】原来会重复三处：
   *  - 场景的描述里已经列了「左侧塌掉的草厅、右侧山道」，
   *    紧接着又把 fixedElements 原样再列一遍
   *  - 角色的 identity 里已有「方脸、浓眉」，
   *    而连续性锁里又有同义的另一句（「方脸」出现两次、「浓眉」中英各一次）
   *
   * 重复不是「强调」，是**给模型两个略有不同的版本**——
   * 它会在两者之间摇，同一角色的脸在相邻镜头里就会有细微漂移。
   */
  /**
   * 提示词正文的去重。
   *
   * ===========================================================================
   * 为什么必须按逗号切到最细粒度
   * ===========================================================================
   * 提示词是一个逗号分隔的短语列表，**逗号就是语义分隔符**。
   * 所以任何以整串形式传进来的内容（角色摘要、锁短语）都要先切开再比较，
   * 否则等于绕过了去重。
   *
   * 踩过的两个坑：
   *  1. 按整串做包含判断 → 角色摘要里含有「square face」子串，
   *     被误判成「已被锁覆盖」而整条删掉
   *  2. 只对整串做相等判断 → 锁短语「square face, thick lowering brows…」
   *     与摘要里的「square face」不相等，于是**同一个特征说了两遍**。
   *     重复不是强调，是给模型两个略有不同的版本，它会在两者之间摇，
   *     同一张脸在相邻镜头里就会有细微漂移。
   */
  const splitPhrases = (text: string | undefined): string[] =>
    (text ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  const dedupePhrases = (parts: (string | undefined)[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of parts.flatMap(splitPhrases)) {
      const phrase = raw.replace(/\s+/g, ' ').trim();
      if (phrase.length === 0) continue;
      const key = phrase.toLowerCase().replace(/[.,;]+$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(phrase);
    }
    return out;
  };

  const sceneSummary = scene ? scene.identity.summaryEn || scene.name : '';
  const extraElements = scene
    ? scene.fixedElements.filter((el) => !sceneSummary.toLowerCase().includes(el.toLowerCase()))
    : [];

  /**
   * 顺序有讲究：**身份锁放最前面**。
   *
   * 调研给出的官方 playbook 原文：「身份锁定这句必须放在提示词最前面，
   * 放在末尾容易被后面的服装、场景描述冲掉。」
   *
   * 所以把「戴着旧毡帽」这类必须每帧一致的身份特征提到最前，
   * 场景与构图描述反而排在后面。这和直觉相反——直觉会觉得先说环境再说人，
   * 但模型对提示词**前段的权重更高**，而一致性靠的正是前段那几句。
   */
  /**
   * 锁的顺序也有讲究。
   *
   * 官方 playbook：「身份锁定这句必须放在提示词最前面，放在末尾容易被后面的
   * 服装、场景描述冲掉。」而调研进一步指出：**大件配饰（帽子、面纱、眼镜、披风）
   * 比五官更容易丢**——EntityBench 明确承认「物体一致性比角色一致性更难，
   * 即使把它作为条件喂进去也常常失败」。脸是模型最擅长的，配饰不是。
   *
   * 所以把「配件类锁」排在「面部类锁」之前：越容易丢的东西越往前放。
   */
  const lockRank = (appliesTo: string): number =>
    appliesTo === 'prop' ? 0 : appliesTo === 'look' ? 10 : 20;
  const orderedLocks = [...locks].sort((a, b) => lockRank(a.appliesTo) - lockRank(b.appliesTo));

  const identityFirst = [
    ...characterDescriptions,
    ...orderedLocks.map((l) => l.phrase),
  ];

  const positive = dedupePhrases([
    ...identityFirst,
    sceneSummary,
    ...extraElements,
    // 尺度锚点：固定物体的真实尺寸与角色的关系不随镜头改变。
    // 它含有固定元素名，但**不能被去重删掉**——它是一句独立的指令，
    // 不是元素的重复列举。（删掉它就会退回「桌椅随手放大缩小」的老问题。）
    scene && scene.fixedElements.length > 0
      ? 'fixed objects keep their true size relative to the character'
      : '',
    // 人物占比 + 接触 + 遮挡（v0.46）。
    // 画面里没有角色时全部跳过——空镜里要求「人物占四分之一画高」
    // 只会让模型硬塞一个人进去。
    //
    // 条件用 `characters.length` 而不是 `characterDescriptions.length`，
    // 为的是和上面「人物占比」那条 note 的条件**字面一致**。
    // 两者按构造恒等（每个角色至少落到一个兜底描述），但两个条件写成不同样子，
    // 以后有人改一边就会让「说明里讲了、正文里没讲」悄悄发生。
    ...(characters.length > 0
      ? [
          SUBJECT_HEIGHT_SHARE[shot.shotSize as ShotSize] ?? '',
          GROUND_VISIBLE.has(shot.shotSize as ShotSize) ? GROUND_CONTACT : '',
          OCCLUSION,
        ]
      : []),
    // 景别用自然英文（``extreme wide establishing shot``），
    // 不再注入枚举值 ``extreme-wide`` —— 后者不是英语，还带连字符
    SHOT_SIZE_EN[shot.shotSize as keyof typeof SHOT_SIZE_EN] ?? shot.shotSize,
    shot.cameraPosition,
    framing.content,
    ...project.brief.styleTags,
    `${project.brief.aspectRatio} aspect ratio`,
    QUALITY_TAIL,
  ]).join(', ');

  return {
    subjectLabel: `第 ${shot.number} 镜${FRAME_LABEL[kind]}`,
    // 这里要给下游（参考图职责说明）用的也是**自然英文**，
    // 因为它会被嵌进 “This shot is framed as …” 这类句子里
    shotSizeEn: SHOT_SIZE_EN[shot.shotSize as keyof typeof SHOT_SIZE_EN] ?? shot.shotSize,
    ...(shot.cameraPosition ? { cameraPositionEn: shot.cameraPosition } : {}),
    positive,
    negative: project.brief.negativePrompt,
    aspectRatio: project.brief.aspectRatio,
    lockPhrases: locks.map((l) => l.phrase),
    notes,
  };
}

const FRAME_LABEL: Record<FrameKind, string> = {
  'first-frame': '首帧',
  'action-peak': '动作关键帧',
  'end-frame': '尾帧',
};

/**
 * 三种帧各画什么。
 *
 * 这是这一节的核心：**同一镜的三个字段被分配到三张图上**，
 * 而不是三张图都画同一句话。
 */
function describeFraming(
  shot: { startState: string; action: string; endState: string },
  kind: FrameKind,
): { content: string; note: PromptNote } {
  if (kind === 'first-frame') {
    return {
      content: shot.startState,
      note: {
        fragment: shot.startState || '(起点未填)',
        label: '首帧 · 只画起点',
        reason:
          '首帧是图生视频的输入图，它决定整段动作从哪里开始。终点才出现的动作、姿态、道具状态' +
          '必须排除在外——写进来模型会把终点画进第一帧，整段动作就错位了。',
      },
    };
  }

  if (kind === 'action-peak') {
    const peak = describePeak(shot.action, shot.startState, shot.endState);
    return {
      content: peak,
      note: {
        fragment: peak,
        label: '动作关键帧 · 画动作顶点',
        reason:
          '这一帧画的是动作**最有张力**的那一瞬间，不是起点也不是终点。' +
          '它决定动作的力度与节奏——只给首尾帧的话，模型可能把动作演得软绵绵，' +
          '或者不知道该在什么时候达到顶点。',
      },
    };
  }

  return {
    content: shot.endState,
    note: {
      fragment: shot.endState || '(终点未填)',
      label: '尾帧 · 只画终点',
      reason:
        '尾帧是镜头结束那一格，也是**下一个镜头的接续点**。要写清人物停在哪、手在哪、画面中心是谁——' +
        '下一镜的首帧要接住这一格。它同时是首尾帧生视频的收尾锚点。',
    },
  };
}

/**
 * 从动作描述推导「顶点长什么样」。
 *
 * 做法：把动作描述本身作为画面内容（它已经在描述人做什么），
 * 再补一句「这是动作进行到一半、最有张力的那一瞬」。
 *
 * 刻意**不编造**具体姿态（比如自己脑补成"身体前倾 45 度"）——
 * 那是我替用户做创作决定。如果用户想要更精确的顶点，应该改「唯一动作」那一栏。
 */
function describePeak(action: string, startState: string, endState: string): string {
  const base = action.trim();
  if (base.length === 0) {
    return startState.trim() || endState.trim();
  }
  return `${base}, captured at the peak of the motion, mid-action, the most dynamic instant`;
}

/** @deprecated 用 buildFramePrompt(project, shotId, 'first-frame') */
export function buildKeyframePrompt(
  project: BuildImagePromptOptions['project'],
  shotId: string,
): ImagePromptInput | null {
  return buildFramePrompt(project, shotId, 'first-frame');
}

// ---------------------------------------------------------------------------
// 一致性级别提示
// ---------------------------------------------------------------------------

export interface ConsistencyAdvice {
  level: 'L1' | 'L2' | 'L3';
  /** 给用户看的一句话结论 */
  summary: string;
  /** 怎么做才能更好 */
  hint: string;
}

/**
 * 按模型能力告诉用户「你的角色能锁到哪一级」。
 *
 * 存在的意义是「不承诺做不到的事」：用户填完角色卡容易以为一致性已经解决了，
 * 实际上如果所选平台不支持参考图，他只能停在 L2。
 */
export function consistencyAdvice(
  capabilities: ModelCapabilities,
  providerName: string,
): ConsistencyAdvice {
  if (capabilities.referenceImage) {
    return {
      level: 'L3',
      summary: `当前模型（${providerName}）支持参考图，一致性可以到 L3。`,
      hint: `先出一张定妆图，再拿它当参考图生成关键帧，是这套工具最稳的做法；最多可传 ${capabilities.maxReferenceImages} 张。`,
    };
  }
  if (capabilities.seed) {
    return {
      level: 'L2',
      summary: `当前模型（${providerName}）支持固定种子，但不支持参考图，一致性到 L2。`,
      hint: '换动作或构图后形象仍会漂；要更稳就换支持参考图的模型。',
    };
  }
  return {
    level: 'L1',
    summary: `当前模型（${providerName}）只能靠文字描述，一致性最弱。`,
    hint: '把连续性锁写得具体（颜色、材质、标志物），能改善多少算多少。',
  };
}

/** 平台标签，供提示词面板复用 */
export function platformLabel(platform: TargetPlatform): string {
  return PLATFORM_LABEL[platform];
}

/** 供界面复用：把 PromptLine 的说明拼成可复制的文本 */
export function promptLineToText(line: PromptLine): string {
  return [line.en, '', '--- 中文对照 ---', line.zh].join('\n');
}
