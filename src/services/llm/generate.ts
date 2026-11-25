import type { ModelProfile, Project } from '../../types/model';
import { PLATFORM_LABEL } from '../../types/model';
import { resolveVideoMode } from '../../domain/pipeline/profiles';
import {
  buildChatPayload,
  extractChatContent,
  request,
  type ChatMessage,
  type RequestOptions,
} from '../gateway';
import {
  parseAssets,
  parseExplainerAssets,
  parseScenicAssets,
  parseShots,
  parseStory,
  parseStyleTags,
  type GeneratedAssets,
  type GeneratedExplainerAssets,
  type GeneratedScenicAssets,
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

/**
 * 把「故事共创对话与共识摘要」压缩成一段稳定、防超长的上下文块，
 * 供「生成故事」「拆角色与场景」「生成分镜」共同读取。
 */
export function buildCreativeContextBlock(project: Project, maxChars = 1800): string {
  const ctx = project.creativeContext;
  if (!ctx) return '';

  const parts: string[] = [];
  const summary = ctx.consensusSummary.trim();
  if (summary) {
    parts.push(`前期与 AI 讨论达成的创作共识：\n${summary}`);
  }

  const recentTurns = ctx.storyChat.slice(-8);
  if (recentTurns.length > 0) {
    const dialogLines = recentTurns.map(
      (turn) => `${turn.role === 'user' ? '作者' : 'AI'}：${turn.content.trim()}`,
    );
    parts.push(`故事共创对话记录（摘录）：\n${dialogLines.join('\n')}`);
  }

  if (parts.length === 0) return '';
  const combined = parts.join('\n\n');
  return combined.length > maxChars ? `${combined.slice(0, maxChars)}\n…（后续略）` : combined;
}

/**
 * 故事页多轮共创对话消息构造（探讨模式，不强行要求输出 JSON）。
 */
export function buildStoryChatMessages(
  project: Project,
  userMessage: string,
  referenceBlock?: string,
): ChatMessage[] {
  const history = (project.creativeContext?.storyChat ?? []).slice(-10);
  const summary = project.creativeContext?.consensusSummary?.trim();
  const storySnippet = project.story.body.trim();

  const mode = resolveVideoMode(project);
  const modeLead =
    mode === 'scenic'
      ? '你是自然纪录片与视觉风光短片的前期策划伙伴。当前项目处于【自然风光无角色模式（scenic）】：禁止设计或强行加入人类角色，也不要把水滴、光线、岩石等自然现象拟人化为角色，聚焦光影、气象演进、宏观地貌与微距物理细节。'
      : mode === 'explainer'
        ? `你是知识科普视频的前期策划伙伴。当前项目处于【科普解说无实景模式（explainer）】：用「3秒提问钩子 → 核心论点 → 概念节拍 + 具象视觉隐喻」来构思，无需虚构教室/实验室/办公室等物理实景；当前虚拟讲解员开关为 ${project.enableVirtualHost ? '开启（最多 1 个轻量吉祥物）' : '关闭（不要设计任何主持人或拟人角色）'}。`
        : '你是动漫短片的前期策划与编剧伙伴。你的任务是通过自然、高效的中文对话，帮创作者打磨故事思路、题材切入点、情节反转、人物亮点与视觉节奏。';

  const systemParts = [
    modeLead,
    '',
    '交流原则：',
    '- 用清晰、口语化的中文回复，给出具体可拍的画面建议，不要空泛说教。',
    '- 如果是科普、知识讲解或特定题材，优先帮用户找到「有画面感的比喻、核心冲突与开头 3 秒钩子」。',
    '- 如果系统附带了「本地资料库参考」或「联网搜索参考资料」，请优先基于这些准确事实来构思，避免编造错误知识。',
    '- 每次回复控制在 150-380 字，重点突出；结尾可以给 1-2 个推进方向供用户选择。',
    '- 当脉络已经清晰时，可提醒用户点击「根据以上对话生成大纲」落盘。',
  ];

  const contextLines = [
    platformContext(project),
    storySnippet ? `当前已有故事正文：\n${storySnippet}` : '',
    summary ? `已记录的创作共识：\n${summary}` : '',
    referenceBlock?.trim() ? referenceBlock.trim() : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: `${systemParts.join('\n')}\n\n当前项目背景：\n${contextLines}` },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: userMessage.trim() },
  ];
  return messages;
}

export interface StoryChatResult {
  ok: boolean;
  reply?: string;
  error?: string;
  detail?: string;
}

/** 故事页多轮探讨对话调用（统一经 ModelGateway） */
export async function discussStory(
  project: Project,
  userMessage: string,
  ctx: GenerateContext,
  referenceBlock?: string,
): Promise<StoryChatResult> {
  try {
    const messages = buildStoryChatMessages(project, userMessage, referenceBlock);
    const body = buildChatPayload({
      model: ctx.profile.model ?? ctx.profile.id,
      messages,
      jsonMode: false,
      temperature: 0.7,
    });
    const raw = await request({
      profile: ctx.profile,
      apiKey: ctx.apiKey,
      body,
      transport: ctx.transport,
      fetchImpl: ctx.fetchImpl,
    });
    const reply = extractChatContent(raw).trim();
    if (!reply) {
      return { ok: false, error: '模型返回了空内容，请换个说法再试一次。' };
    }
    return { ok: true, reply };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, detail: message };
  }
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

export const SCENIC_DIRECTOR_PROMPT = `你是自然纪录片摄影指导。当前项目处于【纯风光无角色模式 (scenic)】，严格遵守以下铁律：

【绝对禁止项】
- 禁止创建、提取或提及任何角色（characters）、人物、剪影或拟人化形象。
- 绝对禁止将水滴、光线、岩石、风、雾气、植物等自然现象包装为「角色卡」，它们仅作为镜头中的自然主体与物理运动要素描述。

【必须产出的视觉锚定】
- 首先锁定全局 visualBible：统一摄影质感、3-5 个核心色板、固定光源方向（同一场景内所有连续镜头保持一致）、焦段建议（大场景与空间过渡优先 50mm 及以上中焦防广角畸变）、大气能见度。
- 逐镜编写 10 槽位摄影单，从六大纪录片镜型中交替编排节奏（微距细节、高空航拍扫掠、慢动作生态节拍、水下平滑推进、地貌延时、静候凝视镜头）。
- 严禁使用「唯美、震撼、电影感」等空洞形容词；必须描述具体的物理受力、光线变化（如丁达尔光束穿过晨雾）、主运动与次级运动（水面涟漪、松针轻颤）、精确摄影机运动以及原生环境音景（溪流、风声、鸟鸣）。
- 对需要无缝衔接的相邻镜头，标记 continuityMode 为 "prev_tail_frame_offset" 或 "first_last_frame"。`;

export function buildExplainerDirectorPrompt(enableVirtualHost: boolean): string {
  return `你是知识科普视频总导演。当前项目处于【科普解说模式 (explainer)】，画面由「连续旁白 + 视觉隐喻 + 统一风格预设」驱动，无需虚构「教室/办公室/实验室」等传统物理场景。

【工作流程】
- 旁白脚本优先：按「3秒提问钩子 → 核心论点 → 多个 20-30 词的清晰概念节拍（每段仅讲清 1 个核心点）→ 总结启示」撰写完整解说词。
- 抽象转具象（隐喻转译）：审查每一句解说词，绝不允许画面停留在抽象概念。将每一句改写为可绘制的具象视觉隐喻（优先运用尺度缩放 Scale、不可见过程推演 Process、直观对比 Comparison）。
- 风格预设与母题资产：锁定全局 stylePreset（优先推荐高辨识度扁平矢量插画或半调报纸拼贴风格，明确声明非写实摄影）；仅把跨 3 个以上镜头反复出现的核心非人物符号（如星球、分子模型、标志性道具）提取至 visual_motif 资产清单。
- 角色红线：当前 enableVirtualHost=${String(enableVirtualHost)}。若为 false，严禁输出任何角色或虚拟主持人，且严禁将微观粒子、天体或数据名词拟人化为角色。
- 混合渲染与标注规范：对于纯数据图表、数学公式推导或精密结构对比镜头，将 renderEngine 标记为 "html_hyperframes" 或 "manim" 并填写 codeRenderSpec；其余视觉隐喻镜头标记为 "ai_ref_to_video" 或 "ai_image_kenburns"，屏幕文字标注严格控制在 3-5 个词以内，画面提示词避免使用易触发安全误拒的敏感年龄词。`;
}

export function buildStoryMessages(project: Project): ChatMessage[] {
  const mode = resolveVideoMode(project);
  const isGenerated = project.story.source === 'generated';
  const creativeCtx = buildCreativeContextBlock(project);
  const userInput = [
    isGenerated && project.story.theme ? `主题：${project.story.theme}` : '',
    project.story.body ? `已有的创作素材：${project.story.body}` : '',
    project.logline ? `一句话简介：${project.logline}` : '',
    creativeCtx,
  ]
    .filter(Boolean)
    .join('\n\n');

  if (mode === 'scenic') {
    return [
      {
        role: 'system',
        content: [
          SCENIC_DIRECTOR_PROMPT,
          '',
          '本阶段任务：将用户想法整理为自然风光短片视觉节拍脚本。',
          '- charactersNote 必须返回空字符串 ""（无角色模式禁止编造人物）。',
          '- scenes 用于记录 2-4 个自然时段/地貌段落（Visual Beats），而非戏剧对话场次。',
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
          userInput || '请创作一段清晨高山峡谷的自然风光视觉节拍大纲。',
        ].join('\n'),
      },
    ];
  }

  if (mode === 'explainer') {
    return [
      {
        role: 'system',
        content: [
          buildExplainerDirectorPrompt(Boolean(project.enableVirtualHost)),
          '',
          '本阶段任务：撰写「旁白先行」的科普解说脚本与概念节拍拆分。',
          '- body 与 narrationScript 填写完整流畅的连续解说词（供单次连续配音使用）。',
          '- scenes 用于记录 3-6 个概念章节/节拍（Concept Beats），不要虚构教室或实验室物理场景。',
          `- ${project.enableVirtualHost ? '已开启虚拟讲解员，charactersNote 可简述唯一轻量吉祥物。' : '未开启虚拟讲解员，charactersNote 必须为空字符串 ""。'}`,
          '',
          JSON_RULES,
          '',
          'JSON 结构（可附加 narrationScript 字段）：',
          STORY_SCHEMA_TEXT,
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          platformContext(project),
          '',
          userInput || '请自拟一个有趣的科学原理科普解说脚本。',
        ].join('\n'),
      },
    ];
  }

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
  "hasSentientCharacters": true,
  "characters": [
    {
      "slug": "英文小写标识，如 lin-chong，全片唯一",
      "name": "中文名，如 林冲",
      "role": "protagonist | antagonist | supporting | cameo",
      "identity": {
        "form": "human | animal | creature | object，默认 human",
        "species": "物种/形态，中文；animal/creature/object 必填，人类可空",
        "face": "面部特征，中文；非人类写头部/主体识别特征",
        "hair": "发型发色，中文；非人类写表面特征（鳞片/羽毛/毛发/材质）",
        "bodyType": "体型，中文；非人类写体型/轮廓",
        "ageRange": "年龄段，中文",
        "summary": "一句话中文概述",
        "summaryEn": "英文身份描述，格式：Name, 年龄体型, 面部特征；非人类必须写清物种与解剖，不要默认人类四肢"
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
  const creativeCtx = buildCreativeContextBlock(project);
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
        '- **非人类角色**：form 填 animal/creature/object，species 必填，summaryEn 写清物种与解剖' +
          '（如 fins, tail, wings, shell, mechanical parts），不要写人类四肢；human 角色 form 填 human。',
        '- 不要给次要角色写变体，变体只留给主角。',
        '',
        '【角色本体边界与空值弃权规则（硬红线）】',
        '- 角色仅限具备自主意识、行动主体性或对白的生物及用户显式指定的拟人化吉祥物。',
        '- 严禁将水滴、露珠、光线、阳光、岩石、山峰、风、云雾、河流、雪、火焰、分子、粒子、公式、抽象概念列为角色！',
        '- 若故事中没有具备自主意识的角色，必须将 hasSentientCharacters 设为 false 并返回 "characters": []，绝不可为填满数组而捏造角色。',
        '- 反例 1（自然风光）：「露珠从松针滑落到青苔岩石，晨光穿透薄雾」→ {"hasSentientCharacters": false, "characters": [], "scenes": [...]}',
        '- 反例 2（知识科普）：「光子发生量子纠缠，信号在星系间传播」→ {"hasSentientCharacters": false, "characters": [], "scenes": []}',
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
        ...(creativeCtx
          ? [
              '',
              '补充要求（请务必落实对话中提到的角色特征、道具、场景细节与视觉偏好）：',
              creativeCtx,
            ]
          : []),
      ].join('\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// ②.1 纯风光模式（scenic）：视觉圣经 + 宏观环境锚点（Schema 物理移除 characters）
// ---------------------------------------------------------------------------

export const SCENIC_ASSETS_SCHEMA_TEXT = `{
  "visualBible": {
    "styleAnchor": "英文摄影质感锚点，如 35mm documentary cinema, natural film grain",
    "colorPalette": ["3-5 个锁定主色调，英文或中文"],
    "lightingDirection": "固定光源方向，如 low golden morning sunlight from upper-left",
    "lensAndFramingRule": "焦段与构图约束，如 50mm+ mid-telephoto to prevent wide-angle distortion",
    "atmosphereOrMotifRules": "大气能见度/天气与自然质感规则",
    "styleExclusionRule": "正向无人物铁律，如 uninhabited untouched natural landscape, documentary cinematography"
  },
  "scenes": [
    {
      "slug": "英文小写标识，如 alpine-valley",
      "name": "宏观地貌/环境名，中文",
      "identity": {
        "placeType": "地貌类型，中文",
        "spatialStructure": "地形与空间纵深结构，中文",
        "summary": "一句话中文概述",
        "summaryEn": "英文宏观环境描述，直接用于画面提示词"
      },
      "fixedElements": ["英文短语，标志性地貌与自然要素，3-5 条"],
      "lightDirection": "固定光源方向（与 visualBible 保持一致）",
      "mainColor": "主色调，中文",
      "timeOfDay": "时段",
      "weather": "天气",
      "continuityLocks": [
        { "label": "锁名", "phrase": "英文短语", "appliesTo": "geography" }
      ]
    }
  ],
  "visualAssets": [
    {
      "category": "environment | style_ref",
      "name": "环境或风格参考名称",
      "tag": "@alpine_valley",
      "visualPrompt": "英文参考画面描述",
      "isImmutableAnchor": true
    }
  ]
}`;

export function buildScenicAssetsMessages(project: Project): ChatMessage[] {
  const creativeCtx = buildCreativeContextBlock(project);
  return [
    {
      role: 'system',
      content: [
        SCENIC_DIRECTOR_PROMPT,
        '',
        '本阶段任务：锁定全片视觉圣经（visualBible）与宏观环境锚点（scenes / visualAssets）。',
        '注意：本模式的输出 Schema 中不包含 characters 字段，严禁输出任何角色或将水滴/光线/岩石注册为角色。',
        '',
        JSON_RULES,
        '',
        'JSON 结构：',
        SCENIC_ASSETS_SCHEMA_TEXT,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        platformContext(project),
        '',
        '视觉节拍脚本：',
        project.story.body || '（未填）',
        ...(creativeCtx ? ['', '前期创作共识：', creativeCtx] : []),
      ].join('\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// ②.2 科普解说模式（explainer）：风格预设 + 非人物视觉母题（无物理 scenes）
// ---------------------------------------------------------------------------

export function buildExplainerAssetsMessages(project: Project): ChatMessage[] {
  const enableHost = Boolean(project.enableVirtualHost);
  const creativeCtx = buildCreativeContextBlock(project);
  const hostFieldText = enableHost
    ? `,
  "virtualHost": {
    "slug": "virtual-host",
    "name": "唯一虚拟讲解员名称",
    "role": "protagonist",
    "identity": {
      "form": "creature",
      "species": "轻量卡通吉祥物形态",
      "face": "简洁面部识别特征",
      "hair": "表面色彩与造型",
      "bodyType": "简约几何比例",
      "ageRange": "",
      "summary": "一句话概述",
      "summaryEn": "concise English description of the single flat-vector mascot host"
    },
    "continuityLocks": [{ "label": "外观锁", "phrase": "flat geometric mascot badge", "appliesTo": "look" }],
    "variants": []
  }`
    : '';

  const schemaText = `{
  "visualBible": {
    "styleAnchor": "风格预设锚点，如 flat geometric vector illustration, no outlines, clean editorial shapes",
    "colorPalette": ["3-5 个高辨识度主色调"],
    "lightingDirection": "画面明暗与图形对比规则",
    "lensAndFramingRule": "信息图构图与留白规范",
    "atmosphereOrMotifRules": "图形语汇与符号统一规范",
    "styleExclusionRule": "MUST remain flat geometric vector illustration, not photorealistic"
  },
  "visualAssets": [
    {
      "category": "visual_motif | style_ref | diagram_card",
      "name": "跨镜头复用的非人物母题名，如 量子纠缠光子对 / 地球尺度球",
      "tag": "@quantum_pair",
      "visualPrompt": "英文母题绘制提示词，不含真实人物",
      "isImmutableAnchor": true
    }
  ]${hostFieldText}
}`;

  return [
    {
      role: 'system',
      content: [
        buildExplainerDirectorPrompt(enableHost),
        '',
        '本阶段任务：锁定全局风格预设（visualBible）与非人物视觉母题清单（visualAssets）。',
        '严禁虚构教室、办公室、实验室等物理场景（本模式 Schema 中不含物理 scenes 字段）。',
        enableHost
          ? '已开启虚拟讲解员开关：仅允许在 virtualHost 中定义唯一 1 个轻量吉祥物；粒子、公式、星球等概念名词必须放入 visualAssets（category="visual_motif"）。'
          : '未开启虚拟讲解员：本模式 Schema 中不含 characters/virtualHost 字段，严禁生成任何人物或拟人化角色。',
        '',
        JSON_RULES,
        '',
        'JSON 结构：',
        schemaText,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        platformContext(project),
        '',
        '科普解说脚本：',
        project.narrationScript || project.story.body || '（未填）',
        ...(creativeCtx ? ['', '前期创作共识：', creativeCtx] : []),
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
  const mode = resolveVideoMode(project);
  // slug 用**数组下标**而不是真实 id：id 是随机串，给模型看没有意义，还容易被抄错。
  // 下标在同一轮生成内稳定，模型只要原样回抄即可。
  const scenes = project.scenes
    .map(
      (s, i) =>
        `- slug: item-${i + 1} | ${s.name} | 固定元素：${s.fixedElements.join(' / ') || '未登记'}`,
    )
    .join('\n');
  const storyScenes = project.story.scenes
    .map((s, i) => `- index ${i} | ${s.label} | ${s.summary}`)
    .join('\n');
  const creativeCtx = buildCreativeContextBlock(project);
  const bibleBlock = project.visualBible
    ? [
        `风格锚点：${project.visualBible.styleAnchor}`,
        `锁定色板：${project.visualBible.colorPalette.join('、')}`,
        `固定光源：${project.visualBible.lightingDirection}`,
        `焦段构图：${project.visualBible.lensAndFramingRule}`,
        `氛围/图形规则：${project.visualBible.atmosphereOrMotifRules}`,
        `风格铁律：${project.visualBible.styleExclusionRule}`,
      ]
        .filter((line) => !line.endsWith('：'))
        .join('\n')
    : '';
  const visualAssetsBlock = (project.visualAssets ?? [])
    .map((a) => `- ${a.tag} (${a.category}) | ${a.name} | ${a.visualPrompt}`)
    .join('\n');

  if (mode === 'scenic') {
    const scenicShotsSchema = `{
  "shots": [
    {
      "duration": 5,
      "shotSize": "extreme-wide | wide | full | medium | close-up | extreme-close-up",
      "cameraPosition": "机位与焦段，如 50mm 中焦，略低角度贴近青苔表面",
      "cameraMove": "static | push-in | pull-out | pan-left | pan-right | tilt-up | tilt-down | orbit | tracking | crane-up | crane-down | handheld",
      "startState": "自然主体与初始物理状态（严禁出现人物）",
      "action": "主物理运动 + 次级环境运动（如水滴滑落、薄雾流动、松针微颤）",
      "endState": "镜头结束时的自然画面状态",
      "dialogue": "",
      "sound": "原生环境音景（溪流、风声、松涛、露珠滴落）",
      "mood": "画面光影与氛围，如 清冽晨光",
      "transition": "转场方式",
      "continuityNote": "与下一镜的光影/运镜衔接方式",
      "transitionType": "continuation | cut",
      "continuityMode": "prev_tail_frame_offset | first_last_frame | style_ref_only | cut",
      "renderEngine": "ai_video | ai_first_last_frame",
      "sceneSlug": "从可用宏观环境列表中选择 slug，没有则留空字符串",
      "characterSlugs": [],
      "activeLockLabels": ["需要生效的环境锁名称"],
      "activeVariantLabels": [],
      "offscreenCharacters": [],
      "referencedAssetTags": ["@alpine_valley"],
      "sourceSceneIndex": 0
    }
  ]
}`;
    return [
      {
        role: 'system',
        content: [
          SCENIC_DIRECTOR_PROMPT,
          '',
          '本阶段任务：生成自然风光 10 槽位分镜表。',
          '- characterSlugs 必须始终为空数组 []，offscreenCharacters 必须始终为空数组 []。',
          '- 交替使用六大纪录片镜型（微距细节、高空航拍扫掠、慢动作自然节拍、水下平滑推进、地貌延时、静候凝视长镜头）。',
          '- 严格避免空洞形容词，写明物理受力、主/次运动与环境音景。',
          '',
          JSON_RULES,
          '',
          'JSON 结构：',
          scenicShotsSchema,
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          platformContext(project),
          ...(bibleBlock ? ['', '已锁定的视觉圣经（VisualBible）：', bibleBlock] : []),
          '',
          '视觉节拍脚本：',
          project.story.body || '（未填）',
          ...(creativeCtx ? ['', '前期创作讨论上下文：', creativeCtx] : []),
          '',
          '段落索引（sourceSceneIndex）：',
          storyScenes || '（未拆段）',
          '',
          '可用宏观环境（sceneSlug）：',
          scenes || '（无固定环境卡，sceneSlug 可留空字符串）',
          ...(visualAssetsBlock ? ['', '可用环境/风格标签（referencedAssetTags）：', visualAssetsBlock] : []),
          '',
          `请拆出大约 ${Math.max(3, Math.round(project.brief.targetDuration / 5))} 个风光镜头，总时长控制在 ${project.brief.targetDuration} 秒左右。`,
        ].join('\n'),
      },
    ];
  }

  if (mode === 'explainer') {
    const enableHost = Boolean(project.enableVirtualHost);
    const hostList = enableHost
      ? project.characters.map((c, i) => `- slug: item-${i + 1} | 虚拟讲解员：${c.name}`).join('\n')
      : '';
    const explainerShotsSchema = `{
  "shots": [
    {
      "duration": 5,
      "shotSize": "extreme-wide | wide | full | medium | close-up | extreme-close-up",
      "cameraPosition": "信息图或视觉隐喻构图机位",
      "cameraMove": "static | push-in | pull-out | pan-left | pan-right | tilt-up | tilt-down | orbit | tracking | crane-up | crane-down | handheld",
      "startState": "画面起点（具象视觉隐喻，非抽象词，不虚构教室）",
      "action": "概念推演或图形动效变化",
      "endState": "本节拍画面定格状态",
      "dialogue": "本镜对应的连续解说旁白（20-30 词清晰概念节拍）",
      "narrationText": "与 dialogue 相同的本镜旁白文本",
      "visualMetaphor": "将抽象概念转译后的具象物理类比/画面隐喻（Scale/Process/Comparison）",
      "onScreenLabels": ["简短屏幕标注，限制 3-5 词"],
      "renderEngine": "ai_ref_to_video | ai_image_kenburns | html_hyperframes | manim",
      "codeRenderSpec": "若 renderEngine 为 html_hyperframes 或 manim 则填写结构化渲染指令，否则为 null",
      "continuityMode": "style_ref_only | cut",
      "sound": "轻柔科普配乐或图形弹出音效",
      "mood": "清晰理性",
      "transition": "图形转场",
      "continuityNote": "与下一概念节拍的视觉过渡",
      "transitionType": "cut",
      "sceneSlug": "",
      "characterSlugs": ${enableHost ? '["仅在虚拟讲解员出镜时填写 slug"]' : '[]'},
      "activeLockLabels": [],
      "activeVariantLabels": [],
      "offscreenCharacters": [],
      "referencedAssetTags": ["@quantum_pair"],
      "sourceSceneIndex": 0
    }
  ]
}`;
    return [
      {
        role: 'system',
        content: [
          buildExplainerDirectorPrompt(enableHost),
          '',
          '本阶段任务：将连续旁白拆分为概念节拍分镜表，并为每镜完成抽象概念到具象视觉隐喻的转译。',
          '- sceneSlug 统一填 ""（科普模式无物理实景）。',
          enableHost
            ? '- 仅允许在 characterSlugs 引用已登记的虚拟讲解员，严禁把粒子/星球/公式当角色。'
            : '- characterSlugs 必须始终为空数组 []，严禁生成任何角色。',
          '- 每一镜必须填写 narrationText 与 visualMetaphor；数据图表/数学公式镜头可将 renderEngine 设为 "html_hyperframes" 或 "manim" 并填 codeRenderSpec。',
          '',
          JSON_RULES,
          '',
          'JSON 结构：',
          explainerShotsSchema,
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          platformContext(project),
          ...(bibleBlock ? ['', '已锁定的风格预设（VisualBible）：', bibleBlock] : []),
          '',
          '完整连续科普旁白脚本：',
          project.narrationScript || project.story.body || '（未填）',
          ...(creativeCtx ? ['', '前期创作讨论上下文：', creativeCtx] : []),
          '',
          '概念章节（sourceSceneIndex）：',
          storyScenes || '（未拆章节）',
          ...(visualAssetsBlock ? ['', '可用非人物母题标签（referencedAssetTags）：', visualAssetsBlock] : []),
          ...(hostList ? ['', '可用虚拟讲解员（characterSlugs）：', hostList] : []),
          '',
          `请按旁白节奏拆出大约 ${Math.max(4, Math.round(project.brief.targetDuration / 5))} 个概念节拍镜头，总时长约 ${project.brief.targetDuration} 秒。`,
        ].join('\n'),
      },
    ];
  }

  // ---- 默认 narrative 叙事剧情模式（100% 保留原有逻辑） ----
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
        ...(creativeCtx
          ? [
              '',
              '前期创作讨论上下文（请将对话中商定的情节节奏、镜头亮点、情绪与细节融入分镜）：',
              creativeCtx,
            ]
          : []),
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
 * 各生成任务的输出上限（token）。
 *
 * 为什么要显式设上限：原来请求里没有 `max_tokens`，回复长度完全由厂商/端点决定。
 * 正常模型有服务端上限，但用户可以把请求指向自己的代理——一个不设限的端点
 * 返回超长 JSON 时，会顺着「读取 → JSON.parse → zod 校验」一路放大内存开销
 * （zod 那条超长数组公告的放大器就是它）。给一个**正常任务足够用**的上限，
 * 超了就让请求在厂商侧被截断/拒绝，而不是在我们这边吃满内存。
 *
 * 取值依据（生成物通常远小于这些数）：
 *  - 故事：正文 + 四格说明 + 场次，约 800–2000 token
 *  - 角色与场景：每个对象十几个字段，常见 2–6 个对象
 *  - 分镜：每镜十几个字段，示例项目 7 镜；200 镜的上限场景给到 8000 才够
 *  - 风格词：最多 16 条短句
 */
const MAX_TOKENS_BY_TASK = {
  story: 3_000,
  assets: 5_000,
  shots: 8_000,
  styleTags: 1_200,
} as const;

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
  maxTokens: number,
): Promise<GenerateOutcome<T>> {
  const maxAttempts = ctx.maxAttempts ?? 2;
  const warnings: string[] = [];
  let lastError = '';
  let lastDetail = '';
  let lastRaw = '';

  const conversation: ChatMessage[] = [...messages];
  // 自定义文字模型可以声明更小的输出上限；内置档案没填时行为完全不变
  const effectiveMaxTokens =
    ctx.profile.maxOutputTokens !== undefined
      ? Math.min(maxTokens, ctx.profile.maxOutputTokens)
      : maxTokens;

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
          maxTokens: effectiveMaxTokens,
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
  return generateWithRetry<GeneratedStory>(
    buildStoryMessages(project),
    parseStory,
    ctx,
    MAX_TOKENS_BY_TASK.story,
  );
}

export function generateAssets(project: Project, ctx: GenerateContext) {
  return generateWithRetry<GeneratedAssets>(
    buildAssetsMessages(project),
    parseAssets,
    ctx,
    MAX_TOKENS_BY_TASK.assets,
  );
}

export function generateScenicAssets(project: Project, ctx: GenerateContext) {
  return generateWithRetry<GeneratedScenicAssets>(
    buildScenicAssetsMessages(project),
    parseScenicAssets,
    ctx,
    MAX_TOKENS_BY_TASK.assets,
  );
}

export function generateExplainerAssets(project: Project, ctx: GenerateContext) {
  const enableHost = Boolean(project.enableVirtualHost);
  return generateWithRetry<GeneratedExplainerAssets>(
    buildExplainerAssetsMessages(project),
    (raw) => parseExplainerAssets(raw, enableHost),
    ctx,
    MAX_TOKENS_BY_TASK.assets,
  );
}

export function generateShots(project: Project, ctx: GenerateContext) {
  return generateWithRetry<GeneratedShots>(
    buildShotsMessages(project),
    parseShots,
    ctx,
    MAX_TOKENS_BY_TASK.shots,
  );
}

/** 从中文风格倾向生成英文风格关键词。不需要项目其它内容，只读 brief。 */
export function generateStyleTags(project: Project, ctx: GenerateContext) {
  return generateWithRetry<GeneratedStyleTags>(
    buildStyleMessages(project),
    parseStyleTags,
    ctx,
    MAX_TOKENS_BY_TASK.styleTags,
  );
}

/** 给界面用：统一的失败文案，必须给出「接下来做什么」 */
export function describeFailure(outcome: GenerateOutcome<unknown>): string {
  if (outcome.ok) return '';
  return [
    outcome.error ?? '生成失败。',
    '',
    '三个选择：',
    '1. 再点一次生成：模型偶尔会抽风，重试通常就好了（本工具已自动重试过一次）。',
    '2. 去「设置」页换一个模型。不同模型对「只输出 JSON」的遵守程度差别很大，' +
      '有些模型即使被要求输出 JSON，也习惯在外面包一层说明文字。',
    '3. 手动填写。示例项目里有一份完整的结构可以照着抄，填完照样能用。',
    '',
    '下面的「模型实际返回了什么」里能看到原文，那是最直接的线索。',
  ].join('\n');
}
