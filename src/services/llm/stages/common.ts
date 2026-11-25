import type { Project } from '../../../types/model';
import { PLATFORM_LABEL } from '../../../types/model';

/**
 * 文本生成阶段共用上下文与导演铁律（Phase 0 结构拆分）
 *
 * 从 services/llm/generate.ts 抽离，供 story / assets / shots 三个阶段复用。
 */

export const JSON_RULES = `
输出要求（必须严格遵守）：
- 只输出一个 JSON 对象，不要输出任何解释、前言、Markdown 代码围栏。
- 所有字段都必须出现。没有内容的字段用空字符串或空数组，不要省略字段名。
- 不要编造 schema 之外的字段。
`.trim();

export function platformContext(project: Project): string {
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
