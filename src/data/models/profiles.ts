import type { ModelProfile } from '../../types/model';

/**
 * 模型档案配置（方案.md §5.4）
 *
 * 换模型只改配置不改代码。这是适配层存在的全部意义。
 *
 * ===========================================================================
 * 一、corsDirect 的依据（不得凭推测填写）
 * ===========================================================================
 * 用 `node scripts/cors-probe.mjs` 与 `node scripts/dashscope-cors-probe.mjs`
 * 伪造 Origin 直读服务端响应头（2026-10-12 实测）：
 *
 *   DeepSeek   api.deepseek.com/chat/completions
 *     预检 200 · ACAO 回显 Origin · allow-headers: authorization,content-type
 *     实际 POST → 401（Authentication Fails），响应同样带 ACAO
 *
 *   硅基流动   api.siliconflow.cn/v1/chat/completions
 *     预检 204 · ACAO: * · allow-headers: *
 *     实际 POST → 401（Token is invalid），响应同样带 ACAO
 *
 *   阿里云百炼 dashscope.aliyuncs.com
 *     原生模式（multimodal-generation / text2image / tasks）
 *       预检 200 · ACAO 回显 Origin · allow-headers 含 x-dashscope-async
 *       实际请求 → 401（InvalidApiKey），响应带 ACAO
 *     ⚠️ 兼容模式 /compatible-mode/v1/images/generations 返回 404 —— 这条路径不存在。
 *        千问图像必须走原生接口，官方文档也明确说明「不支持 OpenAI 兼容模式」。
 *
 * 结论：**三家都开放浏览器直连**，AniGuide 不需要转发代理。
 * 401 反而是好证据：请求真的到达了服务器（拿到了业务错误码），不是被网络层拦掉。
 *
 * ===========================================================================
 * 二、千问图像的三条硬约束（决定了 P0.5 的实现方式）
 * ===========================================================================
 * 1. **必须走原生接口**，不能用 OpenAI 兼容载荷 →
 *    所以 ModelProfile 增加了 apiFlavor 字段区分三种协议。
 * 2. **模型名必须显式指定**，且只在文档里有权威列表（探测无法区分，
 *    因为 DashScope 在鉴权失败时不会校验模型名）→
 *    所以 ModelProfile 增加了 model 字段，取值依据是官方文档的「推荐」项。
 * 3. **返回的图片链接 24 小时后失效**（阿里云 OSS 临时地址）→
 *    所以 ModelProfile 增加了 imageUrlTtlHours，且 P0.5 必须「拿到就下载留存」，
 *    不能只存 URL。这条如果忽略，用户的图库会在一天后集体变成裂图。
 */

export const MODEL_PROFILES: ModelProfile[] = [
  {
    id: 'deepseek-chat',
    vendorId: 'deepseek',
    name: 'DeepSeek · 标准版',
    provider: 'DeepSeek',
    type: 'llm',
    lang: 'zh',
    endpoint: 'https://api.deepseek.com/chat/completions',
    authType: 'bearer',
    apiFlavor: 'openai',
    group: 'llm-verified',
    // 模型名的依据：厂商错误信息里明确列出的可用名字
    // （「The supported API model names are deepseek-flash, deepseek-v4-pro」）。
    // 厂商会下架旧模型——设置页提供了模型名输入框，用户可自行改，
    // 不需要等工具更新。
    model: 'deepseek-v4-pro',
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: false,
      seed: false,
      referenceImage: false,
      maxReferenceImages: 0,
      maxOutputImages: 0,
    },
    notes:
      '国内可直连访问，按 token 计费。用来生成故事和分镜。浏览器直连已实测确认（预检 200 + 回显 Origin）。' +
      '模型名可在设置页修改——厂商下架旧模型时，改这一栏即可。',
  },
  {
    id: 'deepseek-flash',
    vendorId: 'deepseek',
    name: 'DeepSeek · 快速版（flash）',
    provider: 'DeepSeek',
    type: 'llm',
    lang: 'zh',
    endpoint: 'https://api.deepseek.com/chat/completions',
    authType: 'bearer',
    apiFlavor: 'openai',
    group: 'llm-verified',
    model: 'deepseek-flash',
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: false,
      seed: false,
      referenceImage: false,
      maxReferenceImages: 0,
      maxOutputImages: 0,
    },
    notes:
      '更快也更便宜的一档，适合反复重生成分镜时用。' +
      '模型名同样可在设置页修改。' +
      '浏览器直连已实测确认（与标准版同一端点：预检 200 + 回显 Origin）。',
  },
  {
    id: 'siliconflow-chat',
    vendorId: 'siliconflow',
    name: '硅基流动 · 对话模型',
    provider: '硅基流动 SiliconFlow',
    type: 'llm',
    lang: 'zh',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    authType: 'bearer',
    apiFlavor: 'openai',
    group: 'llm-verified',
    // 官方 API 文档示例用的就是这个名字。旧的 Qwen2.5 系列没有官方出处，
    // 而模型广场需要登录、抓不到「当前推荐清单」——所以只填有出处的这一个。
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: false,
      seed: false,
      referenceImage: false,
      maxReferenceImages: 0,
      maxOutputImages: 0,
    },
    notes:
      '聚合平台，一个 Key 可用多家模型。OpenAI 兼容接口。浏览器直连已实测确认（ACAO: *）。' +
      '⚠️ 模型名以斜杠前缀区分厂商，且下线很快——' +
      '（如 `Pro/moonshotai/Kimi-K2.5`、`Pro/zai-org/GLM-5` 已于 2026-06-11 下线）。' +
      '**以模型广场当前列表为准**，报「模型名无效」时改设置页的模型名那一栏。',
  },
  // ==========================================================================
  // 对话模型 · 已实测确认浏览器可直连
  // ==========================================================================
  // 下面这些的 CORS 结论来自 scripts/provider-probe.mjs 的实测
  // （预检或实际响应带 access-control-allow-origin），证据写在各自 notes 里。
  //
  // ⚠️ 模型名会变。核实时（2026-10-14）已发现 Moonshot 的 moonshot-v1 全系列
  // 与 StepFun 的 step-1-* 系列下线、零一万物 API 返回 model_service_closed。
  // 所以每个档案都能在设置页改模型名——报「模型名不被接受」时改那一栏即可。
  {
    id: 'kimi-k3',
    vendorId: 'moonshot',
    name: '月之暗面 · Kimi（kimi-k3）',
    provider: '月之暗面 Moonshot',
    type: 'llm',
    lang: 'zh',
    group: 'llm-verified',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    authType: 'bearer',
    apiFlavor: 'openai',
    // 文档站已迁到 platform.kimi.com，但 API 域名仍是 api.moonshot.cn
    model: 'kimi-k3',
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: false,
      seed: false,
      referenceImage: false,
      maxReferenceImages: 0,
      maxOutputImages: 0,
    },
    notes:
      '长上下文强项，适合把整段故事与角色设定一起给它。浏览器直连已实测确认（POST 401 + ACAO 回显 Origin）。' +
      '⚠️ 文档站已迁到 platform.kimi.com，但 API 域名仍是 api.moonshot.cn。' +
      '⚠️ **moonshot-v1 全系列已于 2026-08-31 下线**，kimi-k2 系列 2026-05-25 下线——' +
      '旧教程里的模型名现在填了会报错。' +
      '没有文生图接口。',
  },
  {
    id: 'zhipu-glm',
    vendorId: 'zhipu',
    name: '智谱 AI · GLM（glm-5.3）',
    provider: '智谱 AI BigModel',
    type: 'llm',
    lang: 'zh',
    group: 'llm-verified',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    authType: 'bearer',
    apiFlavor: 'openai',
    model: 'glm-5.3',
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: false,
      seed: false,
      referenceImage: false,
      maxReferenceImages: 0,
      maxOutputImages: 0,
    },
    notes:
      '国产主力之一，1M 上下文。浏览器直连已实测确认（POST 401 + ACAO 回显 Origin）。' +
      'OpenAI 兼容（`{model, messages:[{role,content}]}`）。' +
      '便宜档可用 glm-4.7-flash。同一家的出图能力见下面的「GLM-Image」档案。',
  },
  {
    id: 'minimax-chat',
    vendorId: 'minimax',
    name: 'MiniMax · 对话（MiniMax-M3）',
    provider: 'MiniMax',
    type: 'llm',
    lang: 'zh',
    group: 'llm-verified',
    // ⚠️ 旧教程里的 api.minimax.chat 已不是当前 base URL（根路径现为 301）
    endpoint: 'https://api.minimax.cn/v1/chat/completions',
    authType: 'bearer',
    apiFlavor: 'openai',
    model: 'MiniMax-M3',
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: false,
      seed: false,
      referenceImage: false,
      maxReferenceImages: 0,
      maxOutputImages: 0,
    },
    notes:
      '1M 上下文。浏览器直连已实测确认（POST 200 + ACAO 回显 Origin）。' +
      '⚠️ **旧教程里的 `api.minimax.chat` 与 `/v1/text/chatcompletion_v2` 都已不是当前用法**，' +
      '现在是 `api.minimax.cn` + `/v1/chat/completions`（国际站换成 `api.minimax.io`）。' +
      '⚠️ `MiniMax-M3.1-Flash-Preview` 虽然列在文档模型表里，但标注「暂时仅通过 M Plan 与 MiniMax Code 提供」，' +
      '普通按量付费的 Key 用不了。',
  },
  {
    id: 'stepfun-chat',
    vendorId: 'stepfun',
    name: '阶跃星辰 · StepFun（step-3.7-flash）',
    provider: '阶跃星辰 StepFun',
    type: 'llm',
    lang: 'zh',
    group: 'llm-verified',
    endpoint: 'https://api.stepfun.com/v1/chat/completions',
    authType: 'bearer',
    apiFlavor: 'openai',
    model: 'step-3.7-flash',
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: false,
      seed: false,
      referenceImage: false,
      maxReferenceImages: 0,
      maxOutputImages: 0,
    },
    notes:
      '256K 上下文的多模态推理模型，便宜快。浏览器直连已实测确认（POST 401 + ACAO `*`）。' +
      '⚠️ 老的 `step-1-8k` / `step-3` 系列已于 2026-07-08 下线。' +
      '⚠️ **这家现在完全没有文生图能力**——三类图像接口已于 2026-10-10 全线停止，' +
      '所以这里只有对话档案，不要指望它出图。',
  },
  {
    id: 'qianfan-chat',
    vendorId: 'qianfan',
    name: '百度文心 · 千帆 v2（模型名待确认）',
    provider: '百度智能云千帆',
    type: 'llm',
    lang: 'zh',
    // 路由已实测存活，但模型名未能从官方文档核实 → 归入未实测档，如实标注
    group: 'llm-experimental',
    endpoint: 'https://qianfan.baidubce.com/v2/chat/completions',
    authType: 'bearer',
    apiFlavor: 'openai',
    model: '',
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: false,
      seed: false,
      referenceImage: false,
      maxReferenceImages: 0,
      maxOutputImages: 0,
    },
    notes:
      '⚠️ **模型名未能核实，用之前请先去千帆控制台查当前可用的 ernie 模型名**，填到下面的「模型名」栏。' +
      '路由已实测存活（带无效 Key 返回 401 `invalid_iam_token`），' +
      '用的是 IAM token 体系、`Authorization: Bearer`，与旧版 v1 的 access_token 不同。' +
      '千帆的 API 文档是动态渲染的，抓不到模型取值表，所以这里不给任何猜测的默认名。',
  },

  // ==========================================================================
  // 出图模型 · 已实测确认浏览器可直连
  // ==========================================================================
  {
    id: 'zhipu-image',
    vendorId: 'zhipu',
    name: '智谱 AI · 文生图（glm-image）',
    provider: '智谱 AI BigModel',
    type: 't2i',
    lang: 'en',
    group: 't2i-verified',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/images/generations',
    authType: 'bearer',
    apiFlavor: 'openai',
    model: 'glm-image',
    imagePayload: {
      promptField: 'prompt',
      sizeField: 'size',
    },
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: false,
      seed: true,
      referenceImage: false,
      maxReferenceImages: 0,
      maxOutputImages: 1,
    },
    imageUrlTtlHours: 24,
    notes:
      '当前旗舰文生图模型（CogView 未下线但旗舰已换成 GLM-Image）。' +
      '浏览器直连已实测确认（POST 401 + ACAO 回显 Origin）。' +
      '请求体 `{model, prompt, size}`；size 默认 1280x1280，另有 1568x1056 等档位，自定义需 512–2048 且为 32 的倍数。' +
      '⚠️ 官方文档未写明图片链接的有效期，这里的 24 小时是按同类接口的保守假设——' +
      '好在工具拿到图就立刻下载留存，不依赖链接长期有效。' +
      '**不支持参考图**，所以这个档案拿不到 L3 一致性锚定，只适合纯文生图。',
  },
  {
    id: 'minimax-image',
    vendorId: 'minimax',
    name: 'MiniMax · 文生图（image-01）',
    provider: 'MiniMax',
    type: 't2i',
    lang: 'en',
    group: 't2i-verified',
    endpoint: 'https://api.minimax.cn/v1/image_generation',
    authType: 'bearer',
    apiFlavor: 'openai',
    model: 'image-01',
    // ⚠️ 这家不是 OpenAI 形状：没有 size / text / batch_size，
    //    宽高比字段叫 aspect_ratio，响应在 data.image_urls
    imagePayload: {
      promptField: 'prompt',
      aspectRatioField: 'aspect_ratio',
      countField: 'n',
      negativePromptField: null,
      responseImageArray: 'data.image_urls',
      // 官方图生图文档：subject_reference 是对象数组，每项 {type, image_file}
      referenceField: 'subject_reference',
      referenceFormat: 'character',
    },
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: false,
      seed: true,
      referenceImage: true,
      maxReferenceImages: 1,
      maxOutputImages: 9,
    },
    imageUrlTtlHours: 24,
    notes:
      '浏览器直连已实测确认（POST 200 + ACAO 回显 Origin）。' +
      '⚠️ **接口不是 OpenAI 形状**，字段名与别家不同：没有 `size`、没有 `text`、没有 `batch_size`；' +
      '宽高比字段是 `aspect_ratio`（1:1 / 16:9 / 9:16 等），响应取 `data.image_urls[]`。' +
      '这些都写在档案的 imagePayload 映射里，不需要改代码。' +
      '支持人物主体参考图（1 张），所以能做有限的 L3 锚定——' +
      '字段是 `subject_reference`，形状是 `[{type:"character", image_file}]`（官方图生图文档）。' +
      '⚠️ **参考图参数只存在于图生图接口**：文生图接口没有它。' +
      '本档案用的是同一个 `/v1/image_generation` 端点，带参考图时按图生图语义处理。' +
      '⚠️ 官方写明返回的图片链接**有效期 24 小时**，必须立刻下载留存。' +
      '另有 image-01-live 支持画风设置，需要时改模型名那一栏。',
  },

  {
    id: 'siliconflow-image',
    vendorId: 'siliconflow',
    name: '硅基流动 · 文生图（Qwen/Qwen-Image）',
    provider: '硅基流动 SiliconFlow',
    type: 't2i',
    lang: 'en',
    group: 't2i-verified',
    endpoint: 'https://api.siliconflow.cn/v1/images/generations',
    authType: 'bearer',
    apiFlavor: 'openai',
    model: 'Qwen/Qwen-Image',
    imagePayload: {
      promptField: 'prompt',
      // 这家的尺寸字段叫 image_size，不是 size
      sizeField: 'image_size',
      // ⚠️ 不要声明 countField: 'batch_size' —— 该字段已于 2026-09-30 下线，
      // 而 store 每次出图都固定 count: 1，声明它等于每次都发一个已废弃的字段。
      negativePromptField: 'negative_prompt',
    },
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: true,
      seed: true,
      referenceImage: false,
      maxReferenceImages: 0,
      maxOutputImages: 1,
    },
    imageUrlTtlHours: 24,
    notes:
      '聚合平台，一个 Key 可用多家出图模型。浏览器直连已实测确认（POST 401 + ACAO `*`）。' +
      '⚠️ 尺寸字段叫 `image_size` 而不是 `size`（已写进档案映射）。' +
      '⚠️ **`batch_size` 已于 2026-09-30 下线**，多张请多次调用——工具默认一张一张出，不受影响。' +
      '⚠️ 官方文档对生图模型名的表述**互相矛盾**：API 页示例写 FLUX.2-pro，' +
      '能力页列表写 Qwen/Qwen-Image 与一批 FLUX.1——而 **FLUX.1 系列已在 2025-03-06 的下线公告里**，' +
      '说明那个列表页陈旧。所以默认填的是唯一同时被两处支持的 `Qwen/Qwen-Image`。' +
      '遇到「模型名无效」就去模型广场查当前名，填到设置页的模型名那一栏。',
  },
  {
    id: 'qwen-image',
    vendorId: 'dashscope',
    name: '通义千问 · 文生图（qwen-image-2.0-pro）',
    provider: '阿里云百炼 DashScope',
    type: 't2i',
    lang: 'en',
    endpoint:
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    authType: 'bearer',
    apiFlavor: 'dashscope-sync',
    group: 't2i-verified',
    model: 'qwen-image-2.0-pro',
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: true,
      seed: true,
      // 官方文档：同一端点的 content 数组里可放 {"image": ...}，
      // 且明确支持 base64 data URI。这是 L3 参考图锚定的前提。
      referenceImage: true,
      maxReferenceImages: 3,
      maxOutputImages: 6,
    },
    imageUrlTtlHours: 24,
    notes:
      '**默认文生图模型。** 走 DashScope 原生同步接口（官方文档：千问图像不支持 OpenAI 兼容模式）。' +
      '模型名取自官方文档的「推荐」项。支持 negative_prompt、size、seed、n 张输出。' +
      '⚠️ 返回的图片链接 24 小时后失效，必须立刻下载留存。' +
      '浏览器直连已实测确认（预检 200，allow-headers 含 authorization 与 x-dashscope-async）。',
  },
  {
    id: 'qwen-image-fast',
    vendorId: 'dashscope',
    name: '通义千问 · 文生图 · 加速版（qwen-image-2.0）',
    provider: '阿里云百炼 DashScope',
    type: 't2i',
    lang: 'en',
    endpoint:
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    authType: 'bearer',
    apiFlavor: 'dashscope-sync',
    group: 't2i-verified',
    model: 'qwen-image-2.0',
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: true,
      seed: true,
      referenceImage: true,
      maxReferenceImages: 3,
      maxOutputImages: 6,
    },
    imageUrlTtlHours: 24,
    notes:
      '兼顾效果与响应速度的加速版，比 pro 更快也更便宜，批量出关键帧时更划算。' +
      '同样走原生同步接口，浏览器直连已实测确认（预检 200 + 回显 Origin）。返回链接同样 24 小时失效。',
  },


  {
    id: 'qwen-image-2.1',
    vendorId: 'dashscope',
    name: '通义千问 · 多图参考版（qwen-image-2.1-pro，最多 10 张参考图）',
    provider: '阿里云百炼 DashScope',
    type: 't2i',
    lang: 'en',
    endpoint:
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    authType: 'bearer',
    apiFlavor: 'dashscope-sync',
    group: 't2i-verified',
    model: 'qwen-image-2.1-pro',
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: true,
      seed: true,
      referenceImage: true,
      // 官方文档：2.1 系列支持 1–10 张输入图；2.0/3.0 系列是 1–3 张。
      maxReferenceImages: 10,
      maxOutputImages: 6,
    },
    imageUrlTtlHours: 24,
    notes:
      '**参考图槽位只有 3 个时不够用的话，换这个。** 官方 API 文档写明 2.1 系列支持 **1–10 张**输入图，' +
      '而 2.0/3.0 系列是 1–3 张。' +
      '⚠️ 但**不建议无脑铺满**：有基准实测「5 张以上参考图时各项一致性判据一律下降」，' +
      '官方也写「为获得最佳效果建议使用一至三张输入图像」。' +
      '所以这个档案的价值在于「4–6 张时仍有富余」，而不是「能传 10 张就传 10 张」。' +
      '模型名取自官方文档；**换模型会改变既有的画幅归属行为，建议先小样本对比**。' +
      '浏览器直连已实测确认（与其它千问档案同一端点）。',
  },
  {
    id: 'qwen-image-edit',
    vendorId: 'dashscope',
    name: '通义千问 · 图生图 / 图像编辑（qwen-image-3.0-pro）',
    provider: '阿里云百炼 DashScope',
    type: 't2i',
    lang: 'en',
    endpoint:
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    authType: 'bearer',
    apiFlavor: 'dashscope-sync',
    group: 't2i-verified',
    model: 'qwen-image-3.0-pro',
    corsDirect: 'yes',
    capabilities: {
      negativePrompt: true,
      seed: true,
      referenceImage: true,
      maxReferenceImages: 3,
      maxOutputImages: 6,
    },
    imageUrlTtlHours: 24,
    notes:
      '**「锁角色」的主力档案。** 与文生图共用同一个端点，区别只在 content 数组里多一项 {"image": ...}。' +
      '官方文档明确：参考图既可用公网 URL，**也可用 base64 data URI** —— ' +
      '这意味着本地存的图可以直接当参考图，不需要图床或上传服务，' +
      '对「纯前端、数据不外传」的定位是决定性的。' +
      '官方示例的用法就是「保留输入图片中人物的面部特征，换装/换场景」，与本站 L3 参考图锚定的目标一致。' +
      '⚠️ 返回链接同样 24 小时后失效。' +
      '浏览器直连已实测确认（与文生图同一端点：预检 200 + 回显 Origin）。',
  },
];

/** 当前默认的文生图档案 id */
export const DEFAULT_T2I_PROFILE_ID = 'qwen-image';

/** 当前默认的「带参考图」档案 id —— L3 锚定用它 */
export const DEFAULT_REFERENCE_PROFILE_ID = 'qwen-image-edit';

export function findProfile(id: string): ModelProfile | undefined {
  return MODEL_PROFILES.find((p) => p.id === id);
}

