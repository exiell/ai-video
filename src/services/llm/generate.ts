import type { Project } from '../../types/model';
import { PLATFORM_LABEL } from '../../types/model';
import {
  buildChatPayload,
  extractChatContent,
  request,
  type ChatMessage,
  type RequestOptions,
} from '../gateway';
import type { ModelProfile } from '../../types/model';
import {
  parseAssets,
  parseShots,
  parseStory,
  parseStyleTags,
  type GeneratedAssets,
  type GeneratedShots,
  type GeneratedStory,
  type GeneratedStyleTags,
  type ParseOutcome,
} from './schemas';

/**
 * 生成编排（方案.md v0.6 §3.2 M1/M2 + §7.3 任务 5/6）
 *
 * 三条硬性要求：
 *  1. **结构化输出**：要求模型返回 JSON，并用 Zod 校验
 *  2. **兜底重试**：解析失败自动重试一次（把失败原因回灌给模型）
 *  3. **不允许空表**：两次都失败就如实告知并给出「手动填写」的出路，不是静默留白
 */

// ---------------------------------------------------------------------------
// 提示词构造（对模型说的，用中文；产出内容跟随项目设置）
// ---------------------------------------------------------------------------

const JSON_RULES = `
输出要求（必须严格遵守）：
- 只输出一个 JSON 对象，不要输出任何解释、前言、Markdown 代码围栏。
- 所有字段都必须出现。没有内容的字段用空字符串或空数组，不要省略字段名。
- 不要编造 schema 之外的字段。
`.trim();

function platformContext(project: Project): string {
  const platforms = project.brief.platforms.map((p) => PLATFORM_LABEL[p]).join('、') || '即梦';
  return [
    `目标平台：${platforms}`,
    `画幅：${project.brief.aspectRatio}`,
    `目标总时长：${project.brief.targetDuration} 秒`,
    project.brief.styleTone ? `风格倾向（作者原话）：${project.brief.styleTone}` : '',
    project.brief.styleTags.length > 0
      ? `已确定的风格关键词（这些会原样进入每一张图的提示词）：${project.brief.styleTags.join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// ① 生成故事
// ---------------------------------------------------------------------------

export const STORY_SCHEMA_TEXT = `{
  "body": "故事正文，中文，200-500字，有明确的开头、发展、转折、结尾",
  "charactersNote": "主要人物及其关系，中文",
  "setting": "地点与时代背景，中文",
  "conflict": "主角想要什么、什么挡着他，中文",
  "ending": "结局停在哪个画面上，中文",
  "scenes": [
    { "label": "场次名，例：教室 · 傍晚", "summary": "这一场发生了什么，中文" }
  ]
}`;

export function buildStoryMessages(project: Project): ChatMessage[] {
  const isGenerated = project.story.source === 'generated';
  const userInput = [
    isGenerated && project.story.theme ? `主题：${project.story.theme}` : '',
    project.story.body ? `已有的故事素材：${project.story.body}` : '',
    project.logline ? `一句话简介：${project.logline}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    {
      role: 'system',
      content: [
        '你是动漫短片的编剧。你的任务是把一个模糊的想法，写成一个能在几十秒内讲完的动漫短片故事。',
        '',
        '写作要求：',
        '- 故事要短小、有画面感、有明确的情绪转折。',
        `- 场次拆分要克制：30 秒的片子通常 2-3 场就够了，不要拆出十几场。`,
        '- 每一场都要有存在的理由（推进剧情或揭示信息），不要写可有可无的过场。',
        '- 人物不要太多，短片里出现三个以上有台词的角色就会失控。',
        '',
        JSON_RULES,
        '',
        'JSON 结构：',
        STORY_SCHEMA_TEXT,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        platformContext(project),
        '',
        userInput || '请自拟一个适合动漫短片的故事。',
      ].join('\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// ② 生成角色与场景设定
// ---------------------------------------------------------------------------

export const ASSETS_SCHEMA_TEXT = `{
  "characters": [
    {
      "slug": "英文小写标识，如 lin-chong，全片唯一",
      "name": "中文名，如 林冲",
      "role": "protagonist | antagonist | supporting | cameo",
      "identity": {
        "face": "面部特征，中文",
        "hair": "发型发色，中文",
        "bodyType": "体型，中文",
        "ageRange": "年龄段，中文",
        "summary": "一句话中文概述",
        "summaryEn": "英文身份描述，格式：Name, 年龄体型, 面部特征。这一段会被直接写进画面提示词"
      },
      "continuityLocks": [
        { "label": "锁的中文名，如 旧棉袍", "phrase": "英文短语，能被直接贴进提示词，如 a worn padded cotton robe in faded indigo", "appliesTo": "look" }
      ],
      "variants": [
        { "label": "变体中文名，如 风雪中·满身落雪", "changedFeatures": ["改变了什么，中文"] }
      ],
      "negativePrompt": "这个角色不该出现的特征，英文"
    }
  ],
  "scenes": [
    {
      "slug": "英文小写标识，如 classroom",
      "name": "中文场景名",
      "identity": {
        "placeType": "地点类型，中文",
        "spatialStructure": "空间结构：形状、门在哪、有什么大件家具，中文",
        "summary": "一句话中文概述",
        "summaryEn": "英文场景描述，会被直接写进画面提示词"
      },
      "fixedElements": ["英文短语，观众用来认出这是同一个地方的标志物，3-5 条"],
      "lightDirection": "主光方向，中文，例：傍晚，暖光从右侧窗户斜射",
      "mainColor": "主色调，中文，例：暖橙 + 灰绿",
      "timeOfDay": "时段，中文",
      "weather": "天气，中文",
      "continuityLocks": [
        { "label": "锁的中文名", "phrase": "英文短语", "appliesTo": "geography" }
      ]
    }
  ]
}`;

export function buildAssetsMessages(project: Project): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是动漫短片的美术指导。你的任务是从故事里拆出**角色**和**场景**，并为它们建立一致性设定。',
        '',
        '核心概念（必须理解，这决定输出质量）：',
        '- **身份 vs 变体**：区分「这个人是谁」（不变）与「这一镜他穿什么、什么状态」（会变）。',
        '  「换了件外套」是变体，不是新角色。',
        '- **连续性锁**：只锁「不随剧情改变、而且观众看得出不一致」的可见事实。',
        '  锁面必须写成**能原样贴进提示词的最小名词短语**，英文。',
        '  例：a worn padded cotton robe in faded indigo / rows of wooden desks facing a green blackboard',
        '- **固定元素**：场景里一直都在的东西。观众靠它们认出「还是这间教室」。3-5 条，英文短语。',
        '',
        '风格一致性（重要）：',
        '- 作者给的「风格倾向」是中文原话，它是全片的视觉基准。',
        '  你写的 summaryEn 与锁面必须与之一致——',
        '  例：风格是「水墨写意」，那就不要写出 glossy 3d render 这类词。',
        '- 这套风格会同时用于角色形象图、场景板和每一镜关键帧，三者的描述都要能拼在同一部片子里。',
        '',
        '质量要求：',
        '- 不要为每个角色都堆十几条锁。只锁最显眼的 2-4 个特征（面部、标志性服装、关键道具）。',
        '- **每个角色至少要有一件「识别锚点」**：一件大件配饰或显著特征（帽子、面纱、眼镜、披风、围巾、疤）。',
        '  这是模型跨镜认出同一个人的主要依据——只写「短发白衬衫」的角色，每一镜都会变一个人。',
        '  配饰必须同时出现在 summaryEn 和某一条锁里，否则它只在写了它的镜头里出现、其他镜头就没了。',
        '- **场景的 lightDirection 要写成可复现的方向**（从哪一侧打进来、什么色温），不要写「光线柔和」这类形容。',
        '  观众判断「还是不是同一个地方」，主要靠光的方向和整体色调，不是墙上的裂缝。',
        '- **场景的 mainColor 用具体颜色名**（如「暖橙 + 灰绿」），不要写「色调统一」「氛围感强」。',
        '  它会被拿去和每一镜的画面描述比对，写虚了这条检查就没有意义。',
        '- 场景不要太多，短片通常 2-4 个场景。',
        '- summaryEn 与 phrase 必须是英文，其余字段用中文。',
        '- 不要给次要角色写变体，变体只留给主角。',
        '',
        JSON_RULES,
        '',
        'JSON 结构：',
        ASSETS_SCHEMA_TEXT,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        platformContext(project),
        '',
        '故事：',
        project.story.body || '（故事还没写）',
        '',
        '主要人物：',
        project.story.charactersNote || '（未填）',
        '',
        '场景背景：',
        project.story.setting || '（未填）',
      ].join('\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// ②.5 从中文风格倾向生成英文风格关键词（v0.41）
// ---------------------------------------------------------------------------

export const STYLE_SCHEMA_TEXT = `{
  "tags": [
    "英文风格短语，如 anime style / cel shading / cold blue palette / heavy fabric texture"
  ]
}`;

export function buildStyleMessages(project: Project): ChatMessage[] {
  const tone = project.brief.styleTone.trim();
  const existing = project.brief.styleTags;

  return [
    {
      role: 'system',
      content: [
        '你把作者用中文写的「风格倾向」，翻译成一组**能直接贴进出图提示词的英文短语**。',
        '',
        '输出要求：',
        '- 5-8 条，每条是一个**名词短语**，不是句子。',
        '- 全部小写，不要引号、不要句号、不要编号。',
        '- 覆盖这几类（缺哪类就少给哪类，不要硬凑）：',
        '  画面风格（anime style / ink wash painting）、渲染方式（cel shading / 3d render）、',
        '  色调与光线（cold blue palette / warm rim light）、材质与质感（heavy fabric texture / wet stone）、',
        '  镜头与构图倾向（wide cinematic composition / shallow depth of field）。',
        '- 这些词会被**原样**写进每一张图的提示词，所以必须彼此不冲突：',
        '  不要同时给「写实照片」和「动画」，不要同时给「高饱和」和「低饱和」。',
        '- 不要写具体内容（不要出现人物名、场景名、剧情）。风格词只管「怎么画」，不管「画什么」。',
        '',
        JSON_RULES,
        '',
        'JSON 结构：',
        STYLE_SCHEMA_TEXT,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `作者写的风格倾向（中文原话）：${tone}`,
        '',
        existing.length > 0
          ? `当前已有的风格关键词（可参考，也可以整套重写）：${existing.join(', ')}`
          : '当前还没有风格关键词。',
        '',
        `画幅：${project.brief.aspectRatio}，目标平台：${
          project.brief.platforms.map((p) => PLATFORM_LABEL[p]).join('、') || '未选'
        }`,
      ].join('\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// ③ 生成分镜
// ---------------------------------------------------------------------------

export const SHOTS_SCHEMA_TEXT = `{
  "shots": [
    {
      "duration": 3,
      "shotSize": "extreme-wide | wide | full | medium | close-up | extreme-close-up",
      "cameraPosition": "机位，中文，例：略低角度，与桌面齐平",
      "cameraMove": "static | push-in | pull-out | pan-left | pan-right | tilt-up | tilt-down | orbit | tracking | crane-up | crane-down | handheld",
      "startState": "起点：镜头开始那一瞬间**能看见**的东西，中文",
      "action": "唯一动作：这一镜只做一件事，一句话，中文",
      "endState": "终点：镜头结束时画面停在哪，中文",
      "dialogue": "台词或旁白，没有就空字符串",
      "sound": "环境音与音效，中文",
      "mood": "情绪，中文",
      "transition": "转场，中文",
      "continuityNote": "与**下一个镜头**怎么接：下一个镜头从哪开始、人物停在哪、中间是连续动作还是跳时间。最后一个镜头可以写「全片结束」。中文，一到两句",
      "transitionType": "这个镜头与**上一个**镜头的关系。写 continuation（承接：同一处地方、时间向前、动作接着演）或 cut（跳切：换了地方、跳了时间、反打换机位、有意断开）。第一个镜头一律 cut",
      "sceneSlug": "必须是上面提供过的场景 slug",
      "characterSlugs": ["必须是上面提供过的角色 slug"],
      "activeLockLabels": ["这一镜需要生效的连续性锁的**名称**（上面列表里「名称=」后面那一栏），逐字照抄；不要填「内容」"],
      "activeVariantLabels": ["这一镜生效的变体 label，原样照抄；没有就空数组"],
      "offscreenCharacters": ["只在声音里出现、不在画面里的人名"],
      "sourceSceneIndex": 0
    }
  ]
}`;

export function buildShotsMessages(project: Project): ChatMessage[] {
  // slug 用**数组下标**而不是真实 id：id 是随机串，给模型看没有意义，还容易被抄错。
  // 下标在同一轮生成内稳定，模型只要原样回抄即可。
  const scenes = project.scenes
    .map(
      (s, i) =>
        `- slug: item-${i + 1} | ${s.name} | 固定元素：${s.fixedElements.join(' / ') || '未登记'}`,
    )
    .join('\n');
  // 锁用「编号 + 名称 + 说明」三栏呈现，而不是 label("phrase") 挤成一行。
  // 原因：实测模型会去抄那个英文短语，因为夹在引号里看起来更像「该照抄的值」。
  // 给每条锁一个稳定的编号，并明确要求回传编号，比争「抄标签还是抄短语」可靠得多。
  const characters = project.characters
    .map((c, i) => {
      const locks =
        c.continuityLocks.length > 0
          ? c.continuityLocks
              .map((l, li) => `      L${li + 1}. 名称=${l.label} ｜ 内容=${l.phrase}`)
              .join('\n')
          : '      （无）';
      const variants = c.variants.map((v) => v.label).join('、') || '（无）';
      return [
        `- slug: item-${i + 1} | 角色名：${c.name} | 变体：${variants}`,
        `    连续性锁（activeLockLabels 里请填**名称**这一栏，不要填内容）：`,
        locks,
      ].join('\n');
    })
    .join('\n\n');

  const sceneLocks = project.scenes
    .map((sc, i) => {
      if (sc.continuityLocks.length === 0) return `- 场景 item-${i + 1}（${sc.name}）：（无锁）`;
      return [
        `- 场景 item-${i + 1}（${sc.name}）的锁：`,
        ...sc.continuityLocks.map((l, li) => `      L${li + 1}. 名称=${l.label} ｜ 内容=${l.phrase}`),
      ].join('\n');
    })
    .join('\n');
  const storyScenes = project.story.scenes
    .map((s, i) => `- index ${i} | ${s.label} | ${s.summary}`)
    .join('\n');

  return [
    {
      role: 'system',
      content: [
        '你是动漫短片的分镜师。你的任务是把故事拆成可以直接拿去生成的镜头表。',
        '',
        '注意：画面风格由项目设置统一注入到每一镜的提示词里，你不需要在镜头里重复写风格词。',
        '但你的画面描述（起点 / 动作 / 终点）要与那个风格一致，不要写出与之冲突的内容。',
        '',
        '铁律（违反任何一条，生成出来的画面就会崩）：',
        '1. **一镜一动作**。每个镜头从头到尾只发生一件事。几秒钟的时间里，模型能可靠完成的动作只有一个。',
        '2. **起点只写起点**。startState 只写镜头开始那一瞬间能看见的东西；终点才出现的动作、姿态、道具状态**必须删掉**。',
        '3. **终点接得上下一镜**。endState 是下一镜的接续点，要写清楚人物停在哪、手在哪、画面中心是谁。',
        '4. **时长要合理**。单镜建议 2-5 秒，不要出现 8 秒以上的镜头。',
        '5. **必须声明连续性锁**。这一镜出现了某个角色，就要把他的锁写进 activeLockLabels。',
        '   填的是锁的**名称**那一栏（中文短名），不是「内容」那一栏（英文长句）。',
        '   内容那一栏是给生成模型看的，你不需要回传它。抄错了这一镜的锁就不会生效，角色换镜会变脸。',
        '   场景的锁同理：镜头发生在某个场景里，如果该场景有锁，也要写进去。',
        '6. **状态变化要声明变体**。如果这一镜里某个角色处于某个已登记的变体状态（比如「满身落雪」），就在 activeVariantLabels 里原样照抄该变体的 label。',
        '   不要自己发明变体名——只能用提供的清单里的。没有状态变化就留空数组。',
        '7. **场次要覆盖**。故事里的每一场都要有镜头承载，不要漏拍整场戏。',
        '8. **给每个镜头标好它与上一个镜头的关系**（transitionType）。',
        '   同一处地方、时间向前、动作接着演 → continuation；换了地方、跳了时间、反打换机位 → cut。',
        '   这个标注会决定出图时要不要拿上一镜的尾帧当参考图——标错了两个不相关的镜头会被画在一起。',
        '   真实影视素材里 cut 约占一半，不要全标成 continuation。',
        '',
        '9. **想清楚镜头之间怎么接**。在 continuityNote 里写明白：下一个镜头从哪开始、人物停在哪、',
        '   中间是连续动作还是跳时间。单个镜头再完美，接起来别扭整片就废了——',
        '   而这件事在写分镜时是能提前想清楚的，等到剪辑时才发现就已经晚了。',
        '',
        // 以下三条与穿帮检查里的同名规则一一对应。
        // 生成器和检查器必须说同一套话，否则会出现「模型按这个写法生成、
        // 检查器又报它不对」的荒唐情况。
        '10. **景别必须交替**。相邻两个镜头不要用同一个景别——连续两个中景，观众会觉得「没剪」。',
        '    开场用远景交代空间，然后中景推进动作，情绪最重的地方用特写。',
        '',
        '11. **画面描述里不要用「他 / 她 / 它」指代角色**，一律写名字。',
        '    提示词是给模型看的文字，它不知道「他」是谁。两人同框时用代词，动作一定错位。',
        '',
        '12. **mood 里不要写抽象情绪词**（难过、愤怒、崩溃、孤独这类）。',
        '    它们没法指导画面——模型只能从它见过的无数种「难过」里随便挑一种。',
        '    把情绪落成能拍的东西写进 startState / action / endState：',
        '    瞳孔缩了还是散了、呼吸是急还是停、手指在抓什么、视线落在哪、肩膀塌了还是绷着。',
        '    mood 本身写「压迫」「警觉」这类能指导构图和光线的词是可以的。',
        '',
        '分镜技巧：',
        '- 开场用一个远景交代空间，再进中景和近景。',
        '- 情绪最重的地方用特写。',
        '- 运镜要有理由：缓推是为了逼近情绪，拉远是为了揭示环境，固定镜头是为了让观众看清楚。没有理由就用 static。',
        '',
        JSON_RULES,
        '',
        'JSON 结构：',
        SHOTS_SCHEMA_TEXT,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        platformContext(project),
        '',
        '故事：',
        project.story.body || '（故事还没写）',
        '',
        '故事场次（sourceSceneIndex 请引用这里的 index）：',
        storyScenes || '（未拆场次）',
        '',
        '可用场景（sceneSlug 只能从这里选）：',
        scenes || '（还没有场景）',
        '',
        '场景的连续性锁：',
        sceneLocks || '（还没有场景）',
        '',
        '可用角色、他们的锁与变体（characterSlugs / activeLockLabels / activeVariantLabels 只能从这里选）：',
        characters || '（还没有角色）',
        '',
        `请拆出大约 ${Math.max(3, Math.round(project.brief.targetDuration / 4))} 个镜头，总时长控制在 ${project.brief.targetDuration} 秒左右。`,
        '注意：如果某个角色只在画外说话而画面里看不到他，不要把他放进 characterSlugs，放进 offscreenCharacters。',
      ].join('\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// 执行编排：结构化 → 校验 → 重试 → 兜底
// ---------------------------------------------------------------------------

export interface GenerateOutcome<T> {
  ok: boolean;
  data?: T;
  /** 用了第几次尝试（1 = 一次成功） */
  attempts: number;
  /** 模型引用了不存在的对象等非致命问题 */
  warnings: string[];
  /** 失败的最终原因（人话） */
  error?: string;
  /** 开发者细节 */
  detail?: string;
  /** 模型最后一次返回的原始内容。排查「格式不对」时这是唯一有用的东西。 */
  raw?: string;
}

export interface GenerateContext {
  profile: ModelProfile;
  apiKey: string;
  model: string;
  transport?: RequestOptions['transport'];
  fetchImpl?: typeof fetch;
  /** 最多尝试几次，默认 2（首次 + 重试一次） */
  maxAttempts?: number;
}

/**
 * 通用生成流程。
 *
 * 第二次尝试时会把上一次的失败原因**回灌给模型**——
 * 这比单纯重试一次有效得多，它让模型知道该怎么改。
 */
async function generateWithRetry<T>(
  messages: ChatMessage[],
  parse: (raw: string) => ParseOutcome<T>,
  ctx: GenerateContext,
): Promise<GenerateOutcome<T>> {
  const maxAttempts = ctx.maxAttempts ?? 2;
  const warnings: string[] = [];
  let lastError = '';
  let lastDetail = '';
  let lastRaw = '';

  const conversation: ChatMessage[] = [...messages];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let raw = '';
    try {
      const response = await request({
        profile: ctx.profile,
        apiKey: ctx.apiKey,
        body: buildChatPayload({
          model: ctx.model,
          messages: conversation,
          jsonMode: true,
          temperature: 0.7,
        }),
        ...(ctx.transport ? { transport: ctx.transport } : {}),
        ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
      });
      raw = extractChatContent(response);
    } catch (error) {
      // 网络 / 鉴权 / 跨域类错误重试没有意义，直接返回
      const message = error instanceof Error ? error.message : String(error);
      const gatewayInfo =
        typeof error === 'object' && error !== null && 'info' in error
          ? ((error as { info?: { kind?: string; advice?: string; raw?: string } }).info ?? {})
          : {};
      return {
        ok: false,
        attempts: attempt,
        warnings,
        error: message,
        detail: [
          gatewayInfo.kind ? `错误类型：${gatewayInfo.kind}` : '',
          gatewayInfo.advice ?? '',
          '请求本身失败了，重试也无法解决。请看设置页的「测试连接」结果。',
        ]
          .filter(Boolean)
          .join('\n'),
        ...(gatewayInfo.raw ? { raw: gatewayInfo.raw } : {}),
      };
    }

    const parsed = parse(raw);
    if (parsed.ok && parsed.data !== undefined) {
      return { ok: true, data: parsed.data, attempts: attempt, warnings };
    }

    lastError = parsed.error ?? '解析失败';
    lastDetail = parsed.detail ?? '';
    lastRaw = parsed.raw ?? raw;

    if (attempt < maxAttempts) {
      // 把失败原因回灌，让模型知道该改什么
      conversation.push({ role: 'assistant', content: raw.slice(0, 2000) });
      conversation.push({
        role: 'user',
        content: [
          `你上一次的输出有问题：${lastError}`,
          '',
          '请重新输出，这次务必：',
          '1. 只输出一个 JSON 对象，不要任何解释文字或 Markdown 围栏。',
          '2. 补齐所有字段，不要省略。',
          '3. 枚举字段只能使用规定的取值。',
        ].join('\n'),
      });
      warnings.push(`第 ${attempt} 次生成的结果结构不对，已自动重试。`);
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    warnings,
    error: lastError,
    detail: lastDetail,
    raw: lastRaw,
  };
}

export function generateStory(project: Project, ctx: GenerateContext) {
  return generateWithRetry<GeneratedStory>(buildStoryMessages(project), parseStory, ctx);
}

export function generateAssets(project: Project, ctx: GenerateContext) {
  return generateWithRetry<GeneratedAssets>(buildAssetsMessages(project), parseAssets, ctx);
}

export function generateShots(project: Project, ctx: GenerateContext) {
  return generateWithRetry<GeneratedShots>(buildShotsMessages(project), parseShots, ctx);
}

/** 从中文风格倾向生成英文风格关键词。不需要项目其它内容，只读 brief。 */
export function generateStyleTags(project: Project, ctx: GenerateContext) {
  return generateWithRetry<GeneratedStyleTags>(buildStyleMessages(project), parseStyleTags, ctx);
}

/** 给界面用：统一的失败文案，必须给出「接下来做什么」 */
export function describeFailure(outcome: GenerateOutcome<unknown>): string {
  if (outcome.ok) return '';
  return [
    outcome.error ?? '生成失败。',
    '',
    '三个选择：',
    '1. 再点一次生成——模型偶尔会抽风，重试通常就好了（本工具已自动重试过一次）。',
    '2. 去「设置」页换一个模型。不同模型对「只输出 JSON」的遵守程度差别很大，' +
      '有些模型即使被要求输出 JSON，也习惯在外面包一层说明文字。',
    '3. 手动填写。示例项目里有一份完整的结构可以照着抄，填完照样能用。',
    '',
    '下面的「模型实际返回了什么」里能看到原文，那是最直接的线索。',
  ].join('\n');
}
