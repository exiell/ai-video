/**
 * AniGuide 数据模型 —— 唯一真源
 *
 * 设计要点（对应 方案.md v0.6 §5.5）：
 * 1. 角色卡与场景卡同级，都用「身份 / 变体 / 连续性锁」三层结构
 * 2. 分镜核心是「起点 → 唯一动作 → 终点」三段式
 * 3. 每个可持久化对象都带 schemaVersion，便于导入旧版本 JSON 时迁移
 */

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

/** 当前数据模型版本。改动模型结构时递增，并在 migrate.ts 补迁移函数。 */
export const SCHEMA_VERSION = 1;

/** 所有可持久化对象的公共字段 */
export interface Versioned {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 一条连续性锁。
 *
 * 锁面（phrase）必须写成「能原样贴进提示词的最小名词短语」，
 * 例：`pine-green lapel service jacket`、`rows of wooden desks facing a blackboard`。
 * 这是整套一致性机制的核心：锁面会被逐字注入每一镜的提示词正文。
 */
export interface ContinuityLock {
  id: string;
  /** 人类可读的锁名，例：「江晨·松枝绿常服」 */
  label: string;
  /** 锁面：能原样贴进提示词的短语。中文或英文皆可。 */
  phrase: string;
  /** 这个锁管什么：造型 / 地理 / 光线 / 道具 / 构图 */
  appliesTo: LockAspect;
}

export type LockAspect = 'look' | 'geography' | 'lighting' | 'prop' | 'composition';

export const LOCK_ASPECT_LABEL: Record<LockAspect, string> = {
  look: '造型',
  geography: '地理',
  lighting: '光线',
  prop: '道具',
  composition: '构图',
};

/**
 * 一个变体：身份不变，但可见状态改变。
 * 「换了件外套」是变体，不是新角色；「教室被打碎了窗户」是变体，不是新场景。
 */
export interface Variant {
  id: string;
  /** 例：「雨夜湿透的外套」「受伤的左手」 */
  label: string;
  /** 这个变体改变了哪些可见特征 */
  changedFeatures: string[];
  /** 该变体在第几镜生效（空数组表示尚未分配） */
  shotIds: string[];
}

// ---------------------------------------------------------------------------
// 角色与场景（同级，同一套三层结构）
// ---------------------------------------------------------------------------

/** 角色身份：跨集不变的部分 */
export interface CharacterIdentity {
  /** 面部特征 */
  face: string;
  /** 发型发色 */
  hair: string;
  /** 体型 */
  bodyType: string;
  /** 年龄段 */
  ageRange: string;
  /** 一句话身份概述 */
  summary: string;
  /** 英文身份描述（用于提示词正文） */
  summaryEn: string;
}

export interface CharacterCard extends Versioned {
  id: string;
  name: string;
  /** 在故事里的重要度 */
  role: 'protagonist' | 'antagonist' | 'supporting' | 'cameo';
  /** 身份层：跨集不变 */
  identity: CharacterIdentity;
  /** 变体层：随剧情变 */
  variants: Variant[];
  /** 锁定层：必须跨镜保持的可见事实 */
  continuityLocks: ContinuityLock[];
  /** 出镜镜头 */
  shotIds: string[];
  /** 负向词：这个角色不该出现的特征 */
  negativePrompt?: string;
  /** 固定种子（平台支持时才有意义） */
  seed?: number;
}

export const CHARACTER_ROLE_LABEL: Record<CharacterCard['role'], string> = {
  protagonist: '主角',
  antagonist: '对手',
  supporting: '配角',
  cameo: '客串',
};

/** 场景身份：这是哪里，跨集不变 */
export interface SceneIdentity {
  /** 地点类型，例：「老式高中教室」 */
  placeType: string;
  /** 空间结构描述，例：「长方形，靠窗一排，讲台在短边」 */
  spatialStructure: string;
  /** 一句话概述 */
  summary: string;
  /** 英文概述（用于提示词正文） */
  summaryEn: string;
}

export interface SceneCard extends Versioned {
  id: string;
  name: string;
  identity: SceneIdentity;
  variants: Variant[];
  continuityLocks: ContinuityLock[];
  /**
   * 固定元素：这地方永远该有的东西。
   * 例：['rows of wooden desks', 'a green blackboard']。
   * 缺了它们，换个镜头观众就认不出是同一间教室。
   */
  fixedElements: string[];
  /** 主光方向，例：「傍晚，暖光从右侧窗户斜射」 */
  lightDirection: string;
  /** 主色调，例：「暖橙 + 灰绿」 */
  mainColor: string;
  /** 默认时段 */
  timeOfDay?: string;
  /** 默认天气 */
  weather?: string;
  shotIds: string[];
}

// ---------------------------------------------------------------------------
// 故事与分镜
// ---------------------------------------------------------------------------

export interface Story extends Versioned {
  id: string;
  /** 故事从哪来 */
  source: 'original' | 'generated';
  /** 用户给的主题（生成模式下） */
  theme?: string;
  /** 故事正文（用户粘贴或生成结果） */
  body: string;
  /** 人物 / 背景 / 冲突 / 结局 */
  charactersNote: string;
  setting: string;
  conflict: string;
  ending: string;
  /** 剧本场次：用于「缺失场次」检查 */
  scenes: StoryScene[];
}

export interface StoryScene {
  id: string;
  /** 例：「教室 · 傍晚」 */
  label: string;
  /** 这一场发生了什么 */
  summary: string;
}

export type ShotSize =
  | 'extreme-wide'
  | 'wide'
  | 'full'
  | 'medium'
  | 'close-up'
  | 'extreme-close-up';

export const SHOT_SIZE_LABEL: Record<ShotSize, string> = {
  'extreme-wide': '大远景',
  wide: '远景',
  full: '全景',
  medium: '中景',
  'close-up': '近景',
  'extreme-close-up': '特写',
};

export type CameraMove =
  | 'static'
  | 'push-in'
  | 'pull-out'
  | 'pan-left'
  | 'pan-right'
  | 'tilt-up'
  | 'tilt-down'
  | 'orbit'
  | 'tracking'
  | 'crane-up'
  | 'crane-down'
  | 'handheld';

export const CAMERA_MOVE_LABEL: Record<CameraMove, string> = {
  static: '固定镜头',
  'push-in': '推近',
  'pull-out': '拉远',
  'pan-left': '左摇',
  'pan-right': '右摇',
  'tilt-up': '上摇',
  'tilt-down': '下摇',
  orbit: '环绕',
  tracking: '跟移',
  'crane-up': '升起',
  'crane-down': '下降',
  handheld: '手持',
};

/** 镜头英文运镜词（用于提示词正文） */
export const CAMERA_MOVE_EN: Record<CameraMove, string> = {
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

export interface Shot {
  id: string;
  /** 镜号，展示用。重排时自动生成，不保证连续。 */
  number: number;
  /** 时长（秒） */
  duration: number;
  shotSize: ShotSize;
  /** 机位描述，例：「略低角度，与桌面齐平」 */
  cameraPosition: string;
  cameraMove: CameraMove;
  /** 起点：镜头开始那一瞬间**能看见**的东西 */
  startState: string;
  /** 唯一动作：本镜只做一件事。多于一件会被穿帮检查拦下。 */
  action: string;
  /** 终点：镜头结束时画面停在哪 */
  endState: string;
  /** 台词 / 旁白 */
  dialogue: string;
  /** 声音设计：环境音、音效、音乐提示 */
  sound: string;
  mood: string;
  transition: string;

  /** 所属场景（引用 SceneCard.id） */
  sceneId: string;
  /** 出镜角色（引用 CharacterCard.id） */
  characterIds: string[];
  /** 本镜生效的变体（引用 Variant.id） */
  variantIds: string[];
  /** 本镜生效的连续性锁（引用 ContinuityLock.id）。留空则视为未指定，由检查引擎提示。 */
  activeLockIds: string[];
  /** 画面里被点名但**不在画面中**的人物，例：['周薄森'] */
  offscreenCharacters: string[];

  /** 来源场次（引用 StoryScene.id） */
  sourceSceneId: string;

  /**
   * 与**下一个镜头**的衔接说明。
   *
   * 【v0.19 新增】为什么需要它：
   * 单个镜头再完美，接起来别扭整片就废了。而衔接问题**在写分镜时是能提前想清楚的**：
   * 这一镜结束时人物停在哪、下一个镜头从哪开始、中间是连续动作还是跳时间。
   *
   * 它同时约束三件事：
   *  1. 尾帧图该画成什么样（画错了下一镜就接不住）
   *  2. 视频提示词里的转场怎么写
   *  3. 剪辑时的落点
   *
   * 类型是可选的：老项目里没有这个字段，不能因此报错。
   */
  continuityNote?: string;

  /**
   * 与**上一个镜头**的转场类型。这是全流程所有下游决策的总开关。
   *
   * 【v0.22 新增】为什么需要显式字段，而不是靠文字推断：
   * 它决定的事情很多而且不一致会出大问题——
   *  - 要不要拿上一镜尾帧当参考图（`continuation` 才用）
   *  - 参考图怎么排序（尾帧与场景板在争「最后一张」，而最后一张决定输出画幅）
   *  - 视频提示词怎么写转场
   *
   * 原来只有 `continuityNote` 这个自由文本，工具靠关键词猜。
   * 猜错的代价是**主动把两个不该相连的镜头焊在一起**。
   * 所以改成显式字段：模型给默认值，**用户一键可改**。
   *
   * 类型可选：老项目与手写镜头没有这个字段，缺失时由衔接说明推断。
   */
  transitionType?: 'continuation' | 'cut';
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

export type TargetPlatform = 'jimeng' | 'kling' | 'seedance' | 'runway' | 'sora' | 'veo';

export const PLATFORM_LABEL: Record<TargetPlatform, string> = {
  jimeng: '即梦',
  kling: '可灵',
  seedance: 'Seedance',
  runway: 'Runway',
  sora: 'Sora',
  veo: 'Veo',
};

export interface ProjectBrief {
  /** 目标总时长（秒） */
  targetDuration: number;
  aspectRatio: string;
  /** 目标视频平台 */
  platforms: TargetPlatform[];
  /** 风格倾向，例：「日式赛璐璐动画，冷色调」 */
  styleTone: string;
  /** 画面风格英文标签（注入提示词） */
  styleTags: string[];
  /** 全局负向词 */
  negativePrompt: string;
}

export interface Project extends Versioned {
  id: string;
  name: string;
  /** 一句话简介 */
  logline: string;
  brief: ProjectBrief;
  story: Story;
  shots: Shot[];
  characters: CharacterCard[];
  scenes: SceneCard[];
}

// ---------------------------------------------------------------------------
// 检查报告
// ---------------------------------------------------------------------------

export type CheckSeverity = 'error' | 'warning' | 'info';

/** 问题定位到具体位置，供界面点击跳转 */
export interface CheckLocation {
  kind: 'shot' | 'character' | 'scene' | 'project' | 'story';
  /** 目标对象 id */
  id: string;
  /** 对象内的字段名，可选 */
  field?: string;
}

export type CheckRuleId =
  | 'character-not-registered'
  | 'character-missing-lock'
  | 'character-unlocked-feature'
  | 'variant-not-owned'
  | 'scene-not-registered'
  | 'scene-missing-elements'
  | 'scene-light-conflict'
  | 'scene-color-drift'
  | 'duration-mismatch'
  | 'duration-total'
  | 'offscreen-not-declared'
  | 'story-scene-uncovered'
  | 'shot-incomplete'
  | 'multi-action'
  | 'prompt-incomplete'
  // 镜头衔接（v0.19 新增）
  | 'continuity-missing-note'
  | 'continuity-location-jump'
  | 'continuity-state-conflict'
  | 'continuity-large-motion'
  | 'continuity-light-mismatch'
  | 'continuity-long-chain'
  | 'continuity-untyped-transition';

export interface CheckIssue {
  /** 稳定 id，便于测试与去重 */
  id: string;
  ruleId: CheckRuleId;
  severity: CheckSeverity;
  /** 一句话说清哪里错了 */
  title: string;
  /** 为什么错（面向新手，说人话） */
  why: string;
  /** 怎么改 */
  suggestion: string;
  location: CheckLocation;
}

export interface CheckReport {
  issues: CheckIssue[];
  checkedAt: string;
  counts: Record<CheckSeverity, number>;
}

// ---------------------------------------------------------------------------
// 模型档案与提示词模板
// ---------------------------------------------------------------------------

/** 接口协议。OpenAI 兼容载荷与 DashScope 原生载荷完全不同，必须显式区分。 */
export type ApiFlavor = 'openai' | 'dashscope-sync' | 'dashscope-async';

/**
 * 模型能力声明。
 *
 * 为什么单独一个对象而不是几个平铺布尔值：P0.5 的「三级降级」策略
 * （描述锁定 → 种子锁定 → 参考图锚定）完全靠读这些能力来决定给用户哪一级，
 * 散落的字段很容易加了新的却忘了在降级逻辑里判断。
 *
 * 取值必须有依据，不得凭推测填写。依据写在 ModelProfile.notes 里。
 */
export interface ModelCapabilities {
  /** 是否支持负向词 */
  negativePrompt: boolean;
  /** 是否支持固定种子 */
  seed: boolean;
  /**
   * 是否支持参考图（图生图 / 图像编辑）。
   * 这是 L3 锚定的前提——不支持就只能停在 L2。
   */
  referenceImage: boolean;
  /** 单次最多可传几张参考图 */
  maxReferenceImages: number;
  /** 单次最多出几张图 */
  maxOutputImages: number;
}

/** 出图请求：一份画面意图 + 可选的参考图 */
export interface ImageRequest {
  /** 正向提示词 */
  prompt: string;
  negativePrompt?: string;
  /** 画幅比例，例：9:16。由适配层换算成各协议需要的尺寸格式。 */
  aspectRatio?: string;
  /** 出图张数 */
  count?: number;
  seed?: number;
  /**
   * 参考图。base64 data URI 或公网 URL。
   * 千问的图生图接口两者都接受，所以本地存的图可以直接用。
   */
  referenceImages?: string[];

  /**
   * 出的是哪一帧，以及参考图里是否含本镜首帧。
   *
   * 用途：参考图说明要**分角色写清楚**——本镜首帧管构图与机位，
   * 角色形象图管外观。只用一句「保持面部特征」的话，
   * 后两帧的机位会各自漂移，三张图放一起就不像同一个镜头。
   */
  frameRole?: {
    kind: 'first-frame' | 'action-peak' | 'end-frame';
    /** 参考图里含本镜首帧（锁本镜构图） */
    hasFirstFrameAnchor: boolean;
    /** 参考图里含上一镜尾帧（锁跨镜连续） */
    hasPreviousEndAnchor?: boolean;
    /** 各张参考图的职责，按传图顺序 */
    roles?: string[];
    /** 这一镜的景别（英文）。承接镜时用来明说「取景可以改、地方不能动」 */
    shotSizeEn?: string;
    /** 这一镜的机位 */
    cameraPositionEn?: string;
  };
}

/** 单张生成结果 */
export interface GeneratedImage {
  /**
   * 直接可用的图片地址。
   *
   * ⚠️ 阿里云返回的是 OSS 临时链接，24 小时后失效。
   * 因此**不要把这个 URL 当成长期引用**，必须立刻下载并转成 dataUrl 留存。
   * 见 ModelProfile.imageUrlTtlHours。
   */
  url: string;
  /** 下载后的 base64 data URI。拿到它就是安全的。 */
  dataUrl?: string;
  width?: number;
  height?: number;
  /** 模型实际使用的提示词（开了智能改写时与输入不同） */
  actualPrompt?: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  /** 平台返回的 request_id，排查问题用 */
  requestId?: string;
}

/**
 * 档案分组，用于在设置页把十几个档案归类，而不是平铺一长串。
 *
 * 分组依据是「用户拿来干什么」，不是厂商：
 *  - `llm-verified`  / `t2i-verified`  已实测确认浏览器可直连
 *  - `llm-experimental` / `t2i-experimental`  未经实测或存疑，如实标注
 *
 * 分这两档是为了**诚实**：一个没实测过的档案不该和实测过的混在一起，
 * 让用户以为它们一样可靠。
 */
export type ModelProfileGroup =
  | 'llm-verified'
  | 'llm-experimental'
  | 't2i-verified'
  | 't2i-experimental';

export const MODEL_PROFILE_GROUP_LABEL: Record<ModelProfileGroup, string> = {
  'llm-verified': '对话模型 · 已确认浏览器可直连',
  'llm-experimental': '对话模型 · 未实测确认（可能是网络原因）',
  't2i-verified': '出图模型 · 已确认浏览器可直连',
  't2i-experimental': '出图模型 · 未实测确认（可能是网络原因）',
};

/**
 * 厂商定义。
 *
 * 存在的理由：**API Key 是厂商级的，不是模型级的**。
 * 同一个厂商下的对话模型与出图模型共用一个 Key——
 * 原来的结构把 Key 挂在模型档案上，导致智谱、MiniMax、硅基流动
 * 各出现两个 Key 输入框，而它们其实是同一个 Key。
 */
export interface VendorDefinition {
  /** 稳定标识符。**不要拿显示名当标识符**（同一个厂商曾被写成两种显示名）。 */
  id: string;
  name: string;
  /** 申请 Key 的控制台地址 */
  consoleUrl: string;
  corsDirect: 'yes' | 'no' | 'unknown';
  /**
   * 直连的**实测证据**。
   *
   * 和 `notes` 分开放的原因：证据是给开发者和自己看的（"POST 401 + ACAO 回显 Origin"
   * 对普通用户毫无意义），而 `notes` 是界面上给用户看的一句话。
   * 混在一起会逼着二选一——要么界面充满测试细节，要么丢掉证据。
   */
  corsEvidence?: string;
  /** 界面上给用户看的一句话说明。**保持一句**，不要塞测试细节。 */
  notes?: string;
}

export interface ModelProfile {
  id: string;
  /**
   * 所属厂商的稳定 id。Key 按它存取。
   * 可选只为兼容旧数据；新档案必须填。
   */
  vendorId?: string;
  name: string;
  provider: string;
  type: 'llm' | 't2i' | 'i2v';
  /** 设置页里的分组。缺省按 type 归入默认档。 */
  group?: ModelProfileGroup;
  /** 提示词语言 */
  lang: 'zh' | 'en';
  endpoint: string;
  authType: 'bearer' | 'header-key';
  /**
   * 出图请求体的**字段名映射**。
   *
   * ===========================================================================
   * 为什么做成数据映射而不是给每家写一个构造函数
   * ===========================================================================
   * 各家文生图接口的字段名互不相同，而且改名很常见：
   *  - OpenAI 兼容：`prompt` / `size` / `n` / `negative_prompt`
   *  - MiniMax：`prompt` / `aspect_ratio` / `n`，**没有 `size`、没有 `text`、没有 `batch_size`**
   *  - 智谱：`prompt` / `size`
   *
   * 与其为每家写一个 `buildXxxPayload`（新增一家就要动一次网关代码），
   * 不如让档案自己声明「我们家的字段叫什么」——
   * 这样加一个提供方只需要改数据，不需要碰逻辑。
   *
   * 缺省即 OpenAI 形状（`prompt` / `size` / `n` / `negative_prompt` / `seed`）。
   */
  imagePayload?: {
    /** 提示词字段名，默认 `prompt` */
    promptField?: string;
    /** 尺寸字段名。给了 aspectRatio 时是宽高比，否则用默认尺寸 */
    sizeField?: string;
    /** 宽高比字段名（与 sizeField 二选一，MiniMax 用这个） */
    aspectRatioField?: string;
    /** 张数字段名，默认 `n` */
    countField?: string;
    /** 负向词字段名，默认 `negative_prompt`。设为 null 表示该家不支持 */
    negativePromptField?: string | null;
    /** 响应里图片数组的字段路径，默认 `data`。MiniMax 是 `data.image_urls` */
    responseImageArray?: string;
    /**
     * 参考图的字段名，默认 `image`（OpenAI 兼容风格）。
     * 设为 null 表示该家不支持参考图——那就该在 capabilities 里写 false，别假装支持。
     */
    referenceField?: string | null;
    /**
     * 参考图的**形状**。
     *  - `array`（默认）：`[dataUrl, ...]`，OpenAI 兼容风格
     *  - `character`：`[{ type: 'character', image_file: dataUrl }]`，MiniMax 风格
     *
     * 形状不同必须显式声明。塞错了字段名或形状，多数厂商**不会报错**，
     * 只是静静地把参考图忽略掉——而界面还在显示「已使用参考图锚定」。
     * 这种静默失效比报错危险得多，因为它骗的是对一致性的信任。
     */
    referenceFormat?: 'array' | 'character';
  };
  /** 接口协议风格。默认视为 openai。 */
  apiFlavor?: ApiFlavor;
  /** 实际模型名。仅凭档案名无法调用，必须落到具体型号。 */
  model?: string;
  /**
   * 生成结果里图片链接的有效期（小时）。
   * 阿里云百炼返回的是 OSS 临时地址，24 小时后失效——
   * 意味着拿到 URL 之后**必须立刻下载留存**，不能只存 URL。
   */
  imageUrlTtlHours?: number;
  /** 浏览器直连是否可行。必须实测确认，不得凭推测填写。 */
  corsDirect: 'yes' | 'no' | 'unknown';
  /** 能力声明。三级降级策略靠它决定给用户哪一级。 */
  capabilities: ModelCapabilities;
  /** 原生时长上限（秒），视频平台用 */
  nativeDuration?: number;
  notes?: string;
}

export interface PromptTemplate extends Versioned {
  id: string;
  /** 目标平台 */
  platform: TargetPlatform;
  /** 模板名 */
  label: string;
  /** 版本号，模板改动时递增 */
  version: number;
  /** 模板正文，用 {{占位符}} 填空 */
  body: string;
  /** 出处标注（合规用） */
  source?: string;
}

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------

/**
 * 素材类型。
 *
 * 【v0.19 修订】把「关键帧」拆成三种，原因是它们在图生视频里的作用完全不同：
 *
 *  - `first-frame`  首帧。镜头开始那一格，**是图生视频的输入图**
 *  - `action-peak`  动作关键帧。动作最有张力的那一瞬间，
 *                   告诉模型这段动作的顶点长什么样，决定动作的力度与节奏
 *  - `end-frame`    尾帧。镜头结束那一格，是收尾锚点——
 *                   **下一镜的首帧要接住它**，镜头之间的衔接就靠这一对
 *
 * 原来只有一种「关键帧」，实际生成的是首帧，命名还把概念带偏了。
 */
export type AssetKind =
  /** 角色全身多视图：锁体型、比例、服装轮廓、发型长度 */
  | 'character-sheet'
  /** 角色头部特写：**锁脸用**。全身图里的脸只有几十像素，锁不住面部特征 */
  | 'character-sheet-face'
  | 'scene-plate'
  | 'first-frame'
  | 'action-peak'
  | 'end-frame';

export const ASSET_KIND_LABEL: Record<AssetKind, string> = {
  'character-sheet': '全身多视图',
  'character-sheet-face': '头部特写（锁脸）',
  'scene-plate': '场景参考板',
  'first-frame': '首帧',
  'action-peak': '动作关键帧',
  'end-frame': '尾帧',
};

/** 三种镜头帧的说明，供界面复用 */
export const FRAME_KIND_HINT: Record<'first-frame' | 'action-peak' | 'end-frame', string> = {
  'first-frame': '镜头开始那一格。**它是图生视频的输入图**，必须先有它。',
  'action-peak': '动作最有张力的那一瞬间。它决定动作的力度与节奏——只给首尾帧，模型可能把动作演得软绵绵。',
  'end-frame': '镜头结束那一格。**下一镜的首帧要接住它**，镜头之间的衔接靠这一对。',
};

export interface Asset extends Versioned {
  id: string;
  projectId: string;
  kind: AssetKind;
  /** 关联的镜头 / 角色 / 场景 id */
  refId: string;
  /** 图片以 base64 存 IndexedDB。这是长期有效的引用，不会过期。 */
  dataUrl?: string;
  /**
   * 平台返回的原始地址。
   * ⚠️ 阿里云的是 OSS 临时链接，24 小时后失效。只作排查用，**不要拿来展示**。
   */
  sourceUrl?: string;
  mimeType: string;
  width?: number;
  height?: number;
  seed?: number;
  /** 生成时用的提示词快照。必须存——否则用户回看时不知道这张图是怎么来的。 */
  promptSnapshot: string;
  /** 生成时用的模型名 */
  model?: string;
  /** 生成时注入的连续性锁锁面，用于事后核对「锁到底生效了没」 */
  lockPhrases?: string[];
  /** 是否用了参考图锚定（L3），以及当时一共传了几张 */
  referenceCount?: number;

  /** base64 的字节数，用于设置页统计用量 */
  byteSize?: number;
  /** 出处（合规用） */
  source?: string;
}

// ---------------------------------------------------------------------------
// 工具类型
// ---------------------------------------------------------------------------

/** 一致性降级级别（方案.md §6.4） */
export type ConsistencyLevel = 'L1' | 'L2' | 'L3';

export const CONSISTENCY_LEVEL_LABEL: Record<ConsistencyLevel, string> = {
  L1: 'L1 描述锁定',
  L2: 'L2 种子锁定',
  L3: 'L3 参考图锚定',
};

/**
 * 按模型能力推导当前能用到哪一级。
 *
 * 这是「如实告知能力边界」的落点：用户必须知道他的图能不能真正锁住角色，
 * 而不是以为填了角色卡就万事大吉。
 */
export function resolveConsistencyLevel(capabilities: ModelCapabilities): ConsistencyLevel {
  if (capabilities.referenceImage) return 'L3';
  if (capabilities.seed) return 'L2';
  return 'L1';
}

export interface ExportBundle {
  project: Project;
  exportedAt: string;
}

export interface PromptLine {
  /** 英文正文，可直接复制粘贴 */
  en: string;
  /** 中文对照，让用户看得懂自己将要粘贴什么 */
  zh: string;
  /** 逐项说明：为什么这么写 */
  notes: PromptNote[];
}

export interface PromptNote {
  /** 提示词里的片段 */
  fragment: string;
  /** 这一项是什么 */
  label: string;
  /** 为什么这么写 */
  reason: string;
}
