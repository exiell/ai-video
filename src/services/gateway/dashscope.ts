/**
 * 阿里云百炼（DashScope）原生协议
 *
 * 为什么单独一个模块：千问图像的接口风格与 OpenAI 兼容接口完全不同，
 * 硬塞进同一套载荷构造器只会让两边都变形。
 *
 * 参考官方文档（千问-文生图 API 参考）：
 * https://help.aliyun.com/zh/model-studio/qwen-image-api
 *
 * 三种形态的对应关系：
 *   dashscope-sync   千问图像 2.0 / 3.0 系列，一次请求直接返回结果（推荐）
 *   dashscope-async  wanx 等系列，先创建任务拿 task_id，再轮询
 *   openai           DeepSeek / 硅基流动，以及百炼的对话模型
 */

/** 官方文档给出的推荐分辨率 */
export const DASHSCOPE_SIZE_BY_RATIO: Record<string, string> = {
  '16:9': '2688*1536',
  '9:16': '1536*2688',
  '1:1': '2048*2048',
  '4:3': '2368*1728',
  '3:4': '1728*2368',
};

/** 找不到匹配比例时的兜底：正方形 */
export const DASHSCOPE_DEFAULT_SIZE = '2048*2048';

/**
 * 把项目的画幅比例翻译成 DashScope 的 size 参数。
 *
 * 注意：这与 OpenAI 兼容接口的 `image_size` 不是一回事——
 * DashScope 用的是「宽*高」像素串，不是比例字符串。写错格式会被服务端拒绝。
 */
export function ratioToDashScopeSize(aspectRatio: string): string {
  const normalized = aspectRatio.trim().replace('：', ':');
  return DASHSCOPE_SIZE_BY_RATIO[normalized] ?? DASHSCOPE_DEFAULT_SIZE;
}

// ---------------------------------------------------------------------------
// 请求体构造
// ---------------------------------------------------------------------------

export interface DashScopeImageInput {
  model: string;
  prompt: string;
  negativePrompt?: string;
  /** 画幅比例，例：9:16。内部会换算成像素串。 */
  aspectRatio?: string;
  /** 直接指定像素串，优先级高于 aspectRatio。格式：宽*高 */
  size?: string;
  /** 生成张数。官方：qwen-image-2.0 系列支持 1-6 张。 */
  n?: number;
  seed?: number;
  /** 是否让模型智能改写提示词。默认关闭，保证「用户写的词就是生成用的词」。 */
  promptExtend?: boolean;
  /** 是否加 "Qwen-Image" 水印。默认不加。 */
  watermark?: boolean;
  /**
   * 参考图（图生图）。base64 data URI 或公网 URL 都可以。
   * 传了它，这次调用就从「文生图」变成了「图生图 / 图像编辑」。
   */
  referenceImages?: string[];
}

/**
 * 同步接口请求体（multimodal-generation/generation）。
 *
 * 结构特点：提示词藏在 input.messages[0].content[0].text 里，
 * 而且官方明确「当前仅支持单轮对话，数组内有且只有一个元素」。
 */
export function buildDashScopeSyncPayload(input: DashScopeImageInput): Record<string, unknown> {
  const size = input.size ?? ratioToDashScopeSize(input.aspectRatio ?? '1:1');
  const parameters: Record<string, unknown> = {
    size,
    // 默认关闭智能改写：新手需要的是「我写的词就是生成用的词」，
    // 悄悄改写会让他无法判断到底是自己写错了还是模型改坏了。
    prompt_extend: input.promptExtend ?? false,
    // 默认不加平台水印
    watermark: input.watermark ?? false,
  };
  /**
   * negative_prompt 的处理。
   *
   * 【v0.25 修订】官方 API 文档明确：这个参数**只有 qwen-image-3.0 系列支持**；
   * 而官方示例一律传**单个空格** `" "`（既不是空字符串也不是省略）。
   * 这种写法通常意味着「该参数在旧版上不被消费，传空值反而可能触发问题」。
   *
   * 所以：有内容就传内容；**没有内容时传一个空格**，而不是省略——
   * 照抄官方示例的防呆写法。
   *
   * 另外一条来自调研的机制证据：CFG=1 的模型上，否定分支可能根本不参与计算，
   * 那段文本反而可能落进正向条件被当成画面内容画出来。
   * 所以「不要画没有帽子的角色」这种写法会适得其反——正确做法是用肯定句
   * 写明「戴着旧毡帽」。这条已写进角色卡的提示里。
   */
  parameters.negative_prompt = input.negativePrompt?.trim() ? input.negativePrompt : ' ';
  if (input.n !== undefined) parameters.n = input.n;
  if (input.seed !== undefined) parameters.seed = input.seed;

  return {
    model: input.model,
    input: {
      messages: [
        {
          role: 'user',
          content: buildDashScopeContent(input.prompt, input.referenceImages),
        },
      ],
    },
    parameters,
  };
}

/**
 * 构造 content 数组。
 *
 * 这是「图生图」与「文生图」唯一的差别：content 里多了一项 `{"image": ...}`。
 * 官方文档明确两点：
 *  1. 图片可以放在文字**之前**
 *  2. 图片既可以是公网 URL，**也可以是 base64 data URI**
 *
 * 第 2 点对本站是决定性的：图片存在用户自己的 IndexedDB 里，
 * 可以直接当参考图用，不需要图床、不需要上传服务，数据一步都不出浏览器。
 */
export function buildDashScopeContent(
  prompt: string,
  referenceImages?: string[],
): Record<string, string>[] {
  const content: Record<string, string>[] = [];
  for (const image of referenceImages ?? []) {
    if (image.trim().length > 0) content.push({ image });
  }
  content.push({ text: prompt });
  return content;
}

/**
 * 给参考图提示词补一句「保留原图特征」的指令。
 *
 * 为什么必须补：千问的图像编辑接口默认把参考图当成「待修改的素材」，
 * 它不会自动理解成「照这个人的长相再画一张」。不明确要求保留面部特征，
 * 模型可能真的只是把原图改一改，而不是生成新画面。
 * 官方示例里的写法正是「画面中人物完美保留输入图片中这位年轻女性的面部特征」。
 */
/**
 * 参考图说明。
 *
 * ===========================================================================
 * 为什么不能只有一句「保持面部特征一致」
 * ===========================================================================
 * 参考图可能管的是完全不同的事：角色形象图管「这个人长什么样」，
 * 而**本镜首帧管的是「这一镜的空间长什么样」**——构图、机位、景别、
 * 光线方向、人物在画面里的位置。
 *
 * 只用一句锁脸的话，模型会把首帧当成「一张差不多的参考图」，
 * 于是动作关键帧和尾帧各自的机位都可能漂移。三张图各自都好看，
 * 放一起却不像同一个镜头——这正是用户会察觉、但很难说清哪里不对的问题。
 *
 * 所以说明要**分角色写清楚**：哪张管外观、哪张管构图。
 */
export interface ReferenceInstructionInput {
  /** 参考图总数 */
  referenceCount: number;
  /** 其中是否包含本镜首帧（本镜构图锚点） */
  hasFirstFrameAnchor: boolean;
  /**
   * 其中是否含**上一镜尾帧**（跨镜连续锚点）。
   *
   * 它和本镜首帧是两件事：一个管「接着上一镜演」，一个管「本镜内部三帧一致」。
   * 混成一句「保持参考图一致」的话，模型分不清该保持什么。
   */
  hasPreviousEndAnchor?: boolean;
  /**
   * 各张参考图分别负责什么，**按传图的顺序**。
   *
   * 有了它就能逐张写说明（「第 1 张是上一镜的尾帧，管跨镜连续；
   * 第 2 张是角色形象图，管外观」）。模型不会自己猜哪张图管什么——
   * 一句笼统的「保持参考图一致」等于什么也没说。
   */
  roles?: string[];
  /**
   * 角色参考图分别是哪一种：全身多视图还是头部特写（v0.46）。
   *
   * 【为什么必须知道】原来这里无条件追加一句「保持面部、发型和**体型比例**」。
   * 可是默认配置下的角色参考图是一张**头部特写**——里面根本没有身体。
   * 那句话等于要求模型保持它看不见的东西，模型只能猜，
   * 猜出来的身高体型还要和场景里的桌椅门窗对齐，于是「人物大小不合理」。
   *
   * 传了这个，说明才会跟着图走：
   *  - 全身图在 → 要求保持体型比例（它看得见）
   *  - 只有头像 → 改成「身高体型按场景里写明的固定物体来定」
   *
   * 不传时退回旧行为（兼容只给了张数的调用点）。
   */
  sheetDetails?: ('full-body' | 'face')[];
  /**
   * 几个角色同框（v0.46）。两个以上时要额外提醒「这是不同的人」。
   *
   * 两张角色参考图在提示词里曾经是**同一句话**，模型分不清谁是谁。
   * 现在每张都写了名字，这句话是第二道保险。
   */
  characterCount?: number;
  /** 出的是哪一帧 */
  frameKind?: 'first-frame' | 'action-peak' | 'end-frame';
  /** 这一镜的景别（英文），用于承接镜时明说取景可以改 */
  shotSizeEn?: string;
  /** 这一镜的机位（英文或中文），同上 */
  cameraPositionEn?: string;
}

export function withReferenceInstruction(
  prompt: string,
  referenceCountOrInput: number | ReferenceInstructionInput,
): string {
  const input: ReferenceInstructionInput =
    typeof referenceCountOrInput === 'number'
      ? { referenceCount: referenceCountOrInput, hasFirstFrameAnchor: false }
      : referenceCountOrInput;
  if (input.referenceCount <= 0) return prompt;

  const parts: string[] = [];

  // 逐张说明职责，顺序必须与传图顺序一致
  if (input.roles && input.roles.length > 0) {
    parts.push(
      input.roles
        .slice(0, input.referenceCount)
        .map((role, index) => `Image ${index + 1} is ${role}.`)
        .join(' '),
    );
  }

  /**
   * 多个角色同框时明说「这是不同的人」。
   *
   * 不是多余的强调：两张形象图在提示词里长得几乎一样，
   * 而「把两个人的特征混在一张脸上」是这类模型的常见失败方式。
   */
  if ((input.characterCount ?? 0) > 1) {
    parts.push(
      'Those character references are different people. ' +
        'Keep each of them as a separate individual with their own face and build, and never blend them into one person.',
    );
  }

  // 跨镜连续：这一镜接着上一镜演
  if (input.hasPreviousEndAnchor) {
    /**
     * 这里必须把「保什么」与「可以改什么」分开说。
     *
     * 【v0.23 修】原来只写了「保持同一空间、同一光线方向」，
     * 没说明**取景可以改**。结果是：需要一个中景接在广角之后时，
     * 模型要么死死沿用上一镜的广角取景（镜头没变化，剪辑上很闷），
     * 要么自己乱改，把空间一起改了（桌椅位置、门窗大小都变）。
     *
     * 社区实测（ComfyUI-Continuity）把这件事讲得最清楚：
     * 「参考图对构图的拉力来自画面本身，在提示词里声明『不要沿用构图』是无效的」
     * ——所以必须反过来，**用肯定句明说这一镜的取景是什么**。
     * 同理不能写「不要复制构图」这种否定句：CFG=1.0 的模型会把否定词渲染出来。
     */
    parts.push(
      'The previous shot ended exactly as shown in that last-frame reference. ' +
        'Keep the same location: the same objects in the same places at the same relative sizes, ' +
        'and the same direction and colour temperature of light. ' +
        'Continue the action from that exact point. ' +
        // 用「标签 + 值」而不是 “a XX framing”：
        // shotSizeEn 现在是 “extreme wide establishing shot” 这样的名词短语，
        // 塞进 “a … framing” 会变成 “a extreme wide establishing shot framing”，
        // 既是冠词错误，也重复了 shot。
        `Framing: ${input.shotSizeEn || 'different from the previous shot'}${
          input.cameraPositionEn ? `; ${input.cameraPositionEn}` : ''
        }. Change the camera distance and angle accordingly, without moving the location.`,
    );
  }

  if (input.hasFirstFrameAnchor) {
    parts.push(
      'The first reference image is the first frame of this very shot. ' +
        'Keep the exact same camera angle, framing, composition, background layout and lighting direction as that image. ' +
        'Only change what the action requires.',
    );
    if (input.frameKind === 'action-peak') {
      parts.push('This image depicts the peak moment of the action within that same continuous shot.');
    } else if (input.frameKind === 'end-frame') {
      parts.push('This image depicts the end of that same continuous shot.');
    }
  }
  /**
   * 锁脸 / 锁体型的那句话，跟着参考图**实际是什么**走。
   *
   * 【v0.46 修】原来这里无条件追加一句「保持面部、发型和体型比例」。
   * 默认配置下的角色参考图是一张头部特写，里面没有身体——
   * 那句话在要求模型保持它看不见的东西，模型只能猜。
   *
   * `sheetDetails` 是空的（一个角色都没有）时**什么都不说**：
   * 画面里没有人，却要求「保持人物面部特征」，只会让模型硬塞一个人进去。
   */
  const details = input.sheetDetails;
  if (!details) {
    // 旧调用点只给了张数，不知道参考图是什么，沿用原来那句
    parts.push(
      'Keep the facial features, hairstyle and body proportions of the person in the character reference image exactly.',
    );
  } else {
    const hasFull = details.includes('full-body');
    const hasFace = details.includes('face');
    if (hasFull) {
      parts.push(
        'Keep the facial features, hairstyle, build and body proportions of that character exactly as drawn in the turnaround reference.',
      );
    }
    if (hasFace) {
      parts.push(
        hasFull
          ? 'Where a head reference is also given, match its facial features and hairstyle exactly.'
          : 'Match the facial features and hairstyle in that head reference exactly. ' +
            'Take height, build and the volume of the clothing from the fixed objects described in this scene, not from that image, because that image shows the head only.',
      );
    }
  }
  return `${parts.join(' ')} ${prompt}`;
}

/**
 * 异步接口请求体（text2image/image-synthesis）。
 * 这一路需要额外的请求头 `X-DashScope-Async: enable`，见 buildDashScopeHeaders。
 */
export function buildDashScopeAsyncPayload(input: DashScopeImageInput): Record<string, unknown> {
  const size = input.size ?? ratioToDashScopeSize(input.aspectRatio ?? '1:1');
  const inputObj: Record<string, unknown> = { prompt: input.prompt };
  if (input.negativePrompt) inputObj.negative_prompt = input.negativePrompt;

  const parameters: Record<string, unknown> = { size, n: input.n ?? 1 };
  if (input.promptExtend !== undefined) parameters.prompt_extend = input.promptExtend;
  if (input.watermark !== undefined) parameters.watermark = input.watermark;
  if (input.seed !== undefined) parameters.seed = input.seed;

  return { model: input.model, input: inputObj, parameters };
}

/** 异步接口必须带的额外请求头 */
export function buildDashScopeHeaders(flavor: 'dashscope-sync' | 'dashscope-async', apiKey: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (flavor === 'dashscope-async') headers['X-DashScope-Async'] = 'enable';
  return headers;
}

/** 任务查询地址 */
export function buildDashScopeTaskUrl(taskId: string, baseEndpoint = 'https://dashscope.aliyuncs.com'): string {
  const base = baseEndpoint.replace(/\/+$/, '');
  return `${base}/api/v1/tasks/${encodeURIComponent(taskId)}`;
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

/**
 * 从同步响应里取出图片地址。
 *
 * 响应结构：output.choices[0].message.content[0].image
 * 注意这是嵌套三层的数组结构，与 OpenAI 的 data[0].url 毫无相似之处。
 */
export function extractDashScopeSyncImages(response: unknown): string[] {
  if (typeof response !== 'object' || response === null) return [];
  const output = (response as Record<string, unknown>).output;
  if (typeof output !== 'object' || output === null) return [];
  const choices = (output as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return [];

  const urls: string[] = [];
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue;
    const message = (choice as Record<string, unknown>).message;
    if (typeof message !== 'object' || message === null) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const image = (part as Record<string, unknown>).image;
      if (typeof image === 'string') urls.push(image);
    }
  }
  return urls;
}

/** 从异步「创建任务」响应里取 task_id */
export function extractDashScopeTaskId(response: unknown): string | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const output = (response as Record<string, unknown>).output;
  if (typeof output !== 'object' || output === null) return undefined;
  const taskId = (output as Record<string, unknown>).task_id;
  return typeof taskId === 'string' ? taskId : undefined;
}

export interface DashScopeTaskStatus {
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'UNKNOWN';
  urls: string[];
  /** 官方返回的「实际使用的提示词」，便于排查智能改写带来的差异 */
  actualPrompt?: string;
  message?: string;
}

/** 从异步「查询任务」响应里读状态 */
export function parseDashScopeTaskStatus(response: unknown): DashScopeTaskStatus {
  if (typeof response !== 'object' || response === null) {
    return { status: 'UNKNOWN', urls: [] };
  }
  const obj = response as Record<string, unknown>;
  const output = obj.output;
  if (typeof output !== 'object' || output === null) {
    return {
      status: 'UNKNOWN',
      urls: [],
      ...(typeof obj.message === 'string' ? { message: obj.message } : {}),
    };
  }
  const outputObj = output as Record<string, unknown>;
  const rawStatus = outputObj.task_status;
  const status: DashScopeTaskStatus['status'] =
    rawStatus === 'PENDING' || rawStatus === 'RUNNING' || rawStatus === 'SUCCEEDED' ||
    rawStatus === 'FAILED' || rawStatus === 'CANCELED'
      ? rawStatus
      : 'UNKNOWN';

  const urls: string[] = [];
  let actualPrompt: string | undefined;
  const results = outputObj.results;
  if (Array.isArray(results)) {
    for (const item of results) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.url === 'string') urls.push(record.url);
      if (typeof record.actual_prompt === 'string' && actualPrompt === undefined) {
        actualPrompt = record.actual_prompt;
      }
    }
  }

  return {
    status,
    urls,
    ...(actualPrompt !== undefined ? { actualPrompt } : {}),
    ...(typeof obj.message === 'string' ? { message: obj.message } : {}),
  };
}

// ---------------------------------------------------------------------------
// 错误码
// ---------------------------------------------------------------------------

/**
 * DashScope 的错误码 → 网关错误类型。
 *
 * 为什么需要这层映射：百炼的错误长这样
 *   {"code":"InvalidApiKey","message":"Invalid API-key provided.","request_id":"..."}
 * 它走的是顶层 code 字段，而 OpenAI 风格是 {"error":{"message":"..."}}。
 * 不映射的话，用户会看到一句没头没尾的英文，不知道该怎么办。
 */
export const DASHSCOPE_ERROR_MAP: Record<string, string> = {
  InvalidApiKey: 'auth',
  InvalidParameter: 'bad-request',
  ModelNotExist: 'not-found',
  ModelNotFound: 'not-found',
  Throttling: 'rate-limit',
  'Throttling.RateQuota': 'rate-limit',
  'Throttling.AllocationQuota': 'rate-limit',
  Arrearage: 'quota',
  AccessDenied: 'quota',
  DataInspectionFailed: 'content-policy',
  IpInfringementSuspect: 'content-policy',
  UnsupportedOperation: 'bad-request',
  InternalError: 'server',
  ServiceUnavailable: 'server',
};

/** 从 DashScope 响应体里抠出 code 与 message */
export function parseDashScopeError(
  body: string | undefined,
): { code: string; message: string } | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const obj = parsed as Record<string, unknown>;
    const code = obj.code;
    if (typeof code !== 'string' || code.length === 0) return undefined;
    return { code, message: typeof obj.message === 'string' ? obj.message : '' };
  } catch {
    return undefined;
  }
}

/** 把 DashScope 错误码翻译成网关错误类型 */
export function mapDashScopeErrorCode(code: string): string | undefined {
  if (DASHSCOPE_ERROR_MAP[code]) return DASHSCOPE_ERROR_MAP[code];
  // 前缀匹配，覆盖 Throttling.xxx 之类
  const prefix = Object.keys(DASHSCOPE_ERROR_MAP).find((k) => code.startsWith(k));
  return prefix ? DASHSCOPE_ERROR_MAP[prefix] : undefined;
}
