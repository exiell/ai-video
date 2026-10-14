import type { ModelProfile, VendorDefinition } from '../../types/model';
import { MODEL_PROFILES } from './profiles';

/**
 * 厂商定义（方案.md §7.6.17，【v0.27 新增】）
 *
 * ===========================================================================
 * 为什么要分「厂商」与「模型」两层
 * ===========================================================================
 * 原来的结构里，一个档案 = 一个厂商的一个模型，而 **API Key 挂在档案上**。
 * 于是智谱有两个 Key 输入框、MiniMax 有两个、硅基流动有两个——
 * 但它们其实是**同一个 Key**。用户要填两遍、测两遍，还容易以为自己填错了。
 *
 * 正确的分层是：
 *  - **厂商**是计费与认证的单位 → 一个厂商一个 Key
 *  - **模型**是能力单位 → 同一个 Key 下可以选不同的模型
 *
 * 所以现在：Key 按厂商存，模型按用途选。
 *
 * 注意：`provider` 字段是自由文本（给人看的），`vendorId` 才是稳定的标识符。
 * 之前 `provider` 里同一个硅基流动被写成了「SiliconFlow」与「硅基流动 SiliconFlow」
 * 两种写法——这正是不能拿显示名当标识符的原因。
 */

/** 厂商定义表。key 是稳定的 vendorId。 */
export const VENDORS: VendorDefinition[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    // 直连证据：POST 401 + ACAO 回显 Origin（scripts/provider-probe.mjs）
    corsDirect: 'yes',
    notes: '国内可直连，按 token 计费。用于生成故事与分镜。',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼（通义千问）',
    consoleUrl: 'https://bailian.console.aliyun.com/',
    corsDirect: 'yes',
    notes:
      '出图主力。走 DashScope 原生接口（千问图像不支持 OpenAI 兼容模式）。' +
      '浏览器直连已实测确认（预检 200 + ACAO 回显 Origin，allow-headers 含 x-dashscope-async）。' +
      '⚠️ 返回的图片链接 24 小时后失效，工具会立刻下载留存。',
  },
  {
    id: 'zhipu',
    name: '智谱 AI（GLM）',
    consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    corsDirect: 'yes',
    notes:
      '对话与出图共用同一个 Key。' +
      '浏览器直连已实测确认（对话 POST 401 + ACAO 回显 Origin；出图同为 401 + ACAO）。',
  },
  {
    id: 'moonshot',
    name: '月之暗面（Kimi）',
    consoleUrl: 'https://platform.kimi.com/console/account',
    corsDirect: 'yes',
    notes:
      '长上下文强项，适合把整段故事与角色设定一起给它。没有文生图。' +
      '浏览器直连已实测确认（POST 401 + ACAO 回显 Origin）。',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    consoleUrl: 'https://platform.minimax.cn/',
    corsDirect: 'yes',
    notes:
      '对话与出图共用同一个 Key。' +
      '浏览器直连已实测确认（对话与出图均为 POST 200 + ACAO 回显 Origin）。' +
      '⚠️ base URL 是 `api.minimax.cn`——旧教程里的 `api.minimax.chat` 已不是当前用法。',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰（StepFun）',
    consoleUrl: 'https://platform.stepfun.com/interface-key',
    corsDirect: 'yes',
    notes:
      '⚠️ 这家的文生图已全线关停（2026-10-10），所以只有对话模型。' +
      '浏览器直连已实测确认（POST 401 + ACAO `*`）。',
  },
  {
    id: 'siliconflow',
    name: '硅基流动（SiliconFlow）',
    consoleUrl: 'https://cloud.siliconflow.cn/account/ak',
    corsDirect: 'yes',
    notes:
      '聚合平台，一个 Key 可用多家模型。对话与出图共用。' +
      '浏览器直连已实测确认（对话与出图均为 POST 401 + ACAO `*`）。',
  },
  {
    id: 'qianfan',
    name: '百度智能云千帆',
    consoleUrl: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
    corsDirect: 'yes',
    notes:
      '浏览器直连已实测确认（POST 401 + ACAO `*`）。' +
      '⚠️ 官方文档是动态渲染的，抓不到当前可用的模型名，所以模型那一栏默认是空的，' +
      '需要自己去控制台查一个填上。路由已实测存活（无效 Key 返回 401 invalid_iam_token）。',
  },
];

/** 该厂商下的所有模型档案 */
export function modelsOfVendor(vendorId: string): ModelProfile[] {
  return MODEL_PROFILES.filter((p) => p.vendorId === vendorId);
}

/** 该厂商是否提供某类模型 */
export function vendorHasType(vendorId: string, type: 'llm' | 't2i'): boolean {
  return modelsOfVendor(vendorId).some((p) => p.type === type);
}

/** 按 id 找厂商 */
export function findVendor(vendorId: string | undefined): VendorDefinition | undefined {
  if (!vendorId) return undefined;
  return VENDORS.find((v) => v.id === vendorId);
}

/**
 * 厂商的直连结论。
 *
 * 取该厂商下所有档案的结论：只要有一个说「测不出」而其余说「可直连」，
 * 就按**已确认**算（因为路由是厂商级的，同一个域名）。
 * 全部都是 unknown 才算 unknown。
 */
export function vendorCors(vendorId: string): 'yes' | 'no' | 'unknown' {
  const models = modelsOfVendor(vendorId);
  if (models.length === 0) return 'unknown';
  if (models.some((m) => m.corsDirect === 'yes')) return 'yes';
  if (models.every((m) => m.corsDirect === 'unknown')) return 'unknown';
  return 'no';
}

/** 厂商下所有模型的直连证据（用于在界面上说明「为什么说它能直连」） */
export function vendorEvidence(vendorId: string): string | undefined {
  return modelsOfVendor(vendorId)[0]?.notes;
}
