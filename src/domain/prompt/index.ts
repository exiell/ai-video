import type {
  CameraMove,
  CharacterCard,
  Project,
  PromptLine,
  PromptNote,
  SceneCard,
  Shot,
  ShotSize,
  TargetPlatform,
} from '../../types/model';
import { PLATFORM_LABEL, SHOT_SIZE_LABEL } from '../../types/model';

/**
 * 提示词适配引擎（方案.md v0.6 §3.2 M5）
 *
 * 三条硬约束：
 * 1. 英文正文 —— 文生图/视频模型对英文提示词理解更稳
 * 2. 中文对照 —— 用户必须看得懂自己将要粘贴什么，不允许只给英文黑箱
 * 3. 逐项说明 —— 每个片段都要解释「为什么这么写」，这是本工具的教学职能
 *
 * 关键机制：被连续性锁点名的条目，锁面**原样**出现在正文里，
 * 不因为「参考图会交代」而省略（方案.md §6.3）。
 */

/** 景别的英文词 */
const SHOT_SIZE_EN: Record<ShotSize, string> = {
  'extreme-wide': 'extreme wide establishing shot',
  wide: 'wide shot',
  full: 'full shot',
  medium: 'medium shot',
  'close-up': 'close-up',
  'extreme-close-up': 'extreme close-up',
};

/** 平台的正文组织方式 */
type PromptStyle = 'prose' | 'labelled';

const PLATFORM_STYLE: Record<TargetPlatform, PromptStyle> = {
  jimeng: 'prose',
  kling: 'prose',
  seedance: 'labelled',
  runway: 'labelled',
  sora: 'prose',
  veo: 'prose',
};

export interface AssembleInput {
  project: Project;
  shot: Shot;
  scene?: SceneCard | undefined;
  characters: CharacterCard[];
}

interface AssembledFacts {
  sceneEn: string;
  characterEn: string[];
  locks: { label: string; phrase: string; owner: string }[];
  shotSizeEn: string;
  cameraMoveEn: string;
  startState: string;
  action: string;
  endState: string;
  styleTags: string[];
  aspectRatio: string;
  negative: string;
  /** 中文对照用的可读片段 */
  sceneZh: string;
  characterZh: string[];
  shotSizeZh: string;
}

/** 把项目数据翻译成一组「视觉事实」 */
export function assembleFacts(input: AssembleInput): AssembledFacts {
  const { project, shot, scene, characters } = input;

  const sceneEn = scene
    ? [scene.identity.summaryEn || scene.name, scene.fixedElements.join(', ')]
        .filter(Boolean)
        .join(', ')
    : '';

  const characterEn = characters
    .map((c) => c.identity.summaryEn || `${c.name}, an anime character`)
    .filter(Boolean);

  const characterZh = characters.map((c) => c.identity.summary || c.name);

  // 只取「本镜声明生效」的锁；未声明则不注入（由穿帮检查负责提示漏声明）
  const locks: AssembledFacts['locks'] = [];
  for (const character of characters) {
    for (const lock of character.continuityLocks) {
      if (shot.activeLockIds.includes(lock.id)) {
        locks.push({ label: lock.label, phrase: lock.phrase, owner: character.name });
      }
    }
  }
  if (scene) {
    for (const lock of scene.continuityLocks) {
      if (shot.activeLockIds.includes(lock.id)) {
        locks.push({ label: lock.label, phrase: lock.phrase, owner: scene.name });
      }
    }
  }

  return {
    sceneEn,
    characterEn,
    locks,
    shotSizeEn: SHOT_SIZE_EN[shot.shotSize],
    cameraMoveEn: cameraMoveEn(shot.cameraMove),
    startState: shot.startState.trim(),
    action: shot.action.trim(),
    endState: shot.endState.trim(),
    styleTags: project.brief.styleTags,
    aspectRatio: project.brief.aspectRatio,
    negative: project.brief.negativePrompt,
    sceneZh: scene ? `${scene.name}（${scene.identity.summary || scene.identity.placeType}）` : '未指定场景',
    characterZh,
    shotSizeZh: SHOT_SIZE_LABEL[shot.shotSize],
  };
}

/** 运镜英文，从 model.ts 的词表取，集中在这里便于替换成平台专有说法 */
function cameraMoveEn(move: CameraMove): string {
  // 避免循环依赖：这里直接内联，与 CAMERA_MOVE_EN 保持一致
  const table: Record<CameraMove, string> = {
    static: 'static camera, minimal movement',
    'push-in': 'camera slowly pushes in towards subject',
    'pull-out': 'camera pulls back revealing wider scene',
    'pan-left': 'camera pans left following subject',
    'pan-right': 'camera pans right following subject',
    'tilt-up': 'camera tilts up',
    'tilt-down': 'camera tilts down',
    orbit: 'camera orbits around subject',
    tracking: 'camera tracks alongside subject',
    'crane-up': 'camera cranes up to reveal',
    'crane-down': 'camera descends from above',
    handheld: 'subtle handheld camera shake',
  };
  return table[move];
}

/**
 * 生成单镜在指定平台上的提示词。
 * 返回英文正文（可直接粘贴）、中文对照、以及逐项说明。
 */
export function buildShotPrompt(
  project: Project,
  shot: Shot,
  platform: TargetPlatform,
): PromptLine {
  const scene = project.scenes.find((s) => s.id === shot.sceneId);
  const characters = project.characters.filter((c) => shot.characterIds.includes(c.id));
  const facts = assembleFacts({ project, shot, scene, characters });

  const bodyParts: string[] = [];

  // 1. 场景地点
  if (facts.sceneEn) bodyParts.push(facts.sceneEn);
  // 2. 人物身份 + 锁面（锁面紧随人物，保证模型先读到身份再读到约束）
  for (const character of facts.characterEn) {
    bodyParts.push(character);
  }
  for (const lock of facts.locks) {
    bodyParts.push(lock.phrase);
  }
  // 3. 镜头（景别 + 运镜）
  bodyParts.push(`${facts.shotSizeEn}, ${facts.cameraMoveEn}`);
  // 4. 画面内容：起点 → 动作 → 终点
  if (facts.startState) bodyParts.push(facts.startState);
  if (facts.action) bodyParts.push(facts.action);
  if (facts.endState) bodyParts.push(facts.endState);
  // 5. 收尾方式（衔接说明）——告诉模型这一镜该怎么结束
  if (shot.continuityNote) bodyParts.push(`ending so that ${shot.continuityNote}`);
  // 6. 风格
  for (const tag of facts.styleTags) bodyParts.push(tag);
  // 7. 画幅
  if (facts.aspectRatio) bodyParts.push(`${facts.aspectRatio} aspect ratio`);

  const style = PLATFORM_STYLE[platform];
  let en: string;
  if (style === 'labelled') {
    en = [
      facts.sceneEn,
      [...facts.characterEn, ...facts.locks.map((l) => l.phrase)].join(', '),
      facts.startState,
      `Motion: ${facts.action || 'subtle movement'}`,
      `Camera: ${facts.shotSizeEn}, ${facts.cameraMoveEn}`,
      `Duration: ${shot.duration}s`,
      // 衔接说明要进视频提示词：它告诉模型这一镜该如何收尾，
      // 才能被下一个镜头接住。不加这一行，衔接就只存在于分镜表里、出视频时用不上。
      shot.continuityNote ? `Transition: ${shot.continuityNote}` : '',
      `Style: ${facts.styleTags.join(', ') || 'anime style'}`,
      `${facts.aspectRatio} aspect ratio`,
    ]
      .filter((line) => line.trim().length > 0)
      .join('\n');
  } else {
    en = bodyParts.filter((p) => p && p.trim().length > 0).join(', ');
  }

  const zh = buildChineseMirror(facts, shot, platform);
  const notes = buildNotes(facts, platform);

  return { en, zh, notes };
}

/** 中文对照：让用户看懂自己将要粘贴什么 */
function buildChineseMirror(
  facts: AssembledFacts,
  shot: Shot,
  platform: TargetPlatform,
): string {
  const lines: string[] = [];
  lines.push(`【场景】${facts.sceneZh}`);
  if (facts.characterZh.length > 0) lines.push(`【人物】${facts.characterZh.join('；')}`);
  if (facts.locks.length > 0) {
    lines.push(
      `【锁定】${facts.locks.map((l) => `${l.owner}·${l.label} → \`${l.phrase}\``).join('；')}`,
    );
  }
  lines.push(`【镜头】${facts.shotSizeZh}，${shot.cameraMove === 'static' ? '固定镜头' : '有运镜'}，${shot.duration} 秒`);
  if (facts.startState) lines.push(`【起点】${facts.startState}`);
  if (facts.action) lines.push(`【动作】${facts.action}`);
  if (facts.endState) lines.push(`【终点】${facts.endState}`);
  if (shot.continuityNote) lines.push(`【与下一镜的衔接】${shot.continuityNote}`);
  if (facts.styleTags.length > 0) lines.push(`【风格】${facts.styleTags.join('、')}`);
  lines.push(`【画幅】${facts.aspectRatio || '未设置'}`);
  if (facts.negative) lines.push(`【负向词】${facts.negative}`);
  lines.push(`【目标平台】${PLATFORM_LABEL[platform]}`);
  return lines.join('\n');
}

/** 逐项说明：为什么这么写 */
function buildNotes(facts: AssembledFacts, platform: TargetPlatform): PromptNote[] {
  const notes: PromptNote[] = [];

  for (const lock of facts.locks) {
    notes.push({
      fragment: lock.phrase,
      label: `连续性锁 · ${lock.owner}·${lock.label}`,
      reason:
        '这是保证跨镜一致的关键。锁面被原样写进提示词，模型每一镜读到的都是同一串词，形象才不会每一镜都变。不要因为在别的平台挂了参考图就删掉它。',
    });
  }

  notes.push({
    fragment: facts.shotSizeEn,
    label: `景别 · ${facts.shotSizeZh}`,
    reason:
      '景别决定观众离人物多远。近景看情绪，全景看环境。写清楚景别，模型才不会自己决定把镜头推近还是拉远。',
  });

  notes.push({
    fragment: facts.cameraMoveEn,
    label: '运镜',
    reason:
      '运镜写的是「镜头怎么动」。固定镜头也要写（static camera），否则模型可能自己加一段莫名其妙的推拉。',
  });

  if (facts.startState) {
    notes.push({
      fragment: facts.startState,
      label: '起点',
      reason:
        '起点是这一镜的第一格画面，也是上一镜的接续点。只写这一瞬间能看见的东西——终点才出现的动作不要写在这里，否则模型会提前做出来。',
    });
  }

  if (facts.action) {
    notes.push({
      fragment: facts.action,
      label: '唯一动作',
      reason:
        '一镜只做一件事。几秒钟的时间里，模型能可靠完成的动作只有一个；塞两个的结果通常是两个都做不好。',
    });
  }

  if (facts.styleTags.length > 0) {
    notes.push({
      fragment: facts.styleTags.join(', '),
      label: '风格词',
      reason:
        '风格词决定画面是动漫风还是写实风。它来自项目设置，会自动注入每一镜，保证全片风格统一。',
    });
  }

  notes.push({
    fragment: `${facts.aspectRatio} aspect ratio`,
    label: '画幅',
    reason:
      '不写画幅，模型可能给你出成横屏或方图。竖屏短视频要写 9:16，横屏写 16:9。',
  });

  if (facts.negative) {
    notes.push({
      fragment: facts.negative,
      label: '负向词',
      reason: `这些是你不想要的东西。${PLATFORM_LABEL[platform]}支持负向词，所以单独放在负向词字段里，不要混进正文。`,
    });
  }

  return notes;
}

/** 整个项目所有镜头 × 所有目标平台的提示词 */
export interface PlatformPrompts {
  platform: TargetPlatform;
  lines: { shot: Shot; prompt: PromptLine }[];
}

export function buildAllPrompts(project: Project): PlatformPrompts[] {
  return project.brief.platforms.map((platform) => ({
    platform,
    lines: project.shots.map((shot) => ({
      shot,
      prompt: buildShotPrompt(project, shot, platform),
    })),
  }));
}
