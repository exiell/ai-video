/**
 * 改风格的影响评估（v0.42）
 *
 * ===========================================================================
 * 为什么要单独一个模块
 * ===========================================================================
 * 风格词会进**每一张图**的提示词（角色形象图、场景参考板、每一镜的三帧），
 * 所以在已经做出内容之后改风格，代价不是「改一个字段」，而是：
 *
 *  1. **文字描述是上一套风格下写的** —— `identity.summaryEn`、连续性锁短语、
 *     场景固定元素，这些不会跟着风格变。旧描述里可能写着 `glossy 3d render`，
 *     换成水墨之后它还在提示词里，和新风格词打架。
 *
 *  2. **已生成的图是旧风格的** —— 它们会**不再被当作参考图**
 *     （见 `domain/image/referencePlan.ts` 里的 `sameStyle` 过滤），
 *     因为拿旧风格的图当锚点会让新图介于两种风格之间，看起来像「崩了」。
 *     但跳过参考图的代价是：新图没有外观锚点，角色的脸在相邻镜头之间会变。
 *
 *  3. **部分重出会打破镜头内的连续** —— 只重出动作关键帧、不重出首帧，
 *     这一镜的动作关键帧就没有构图锚点，三帧对不上。
 *
 * 这三条都是**用户看不见的**：界面不会报错，图也出得来，只是不对。
 * 所以改风格之前必须把代价说清楚，并给出一条能走通的路径。
 *
 * 放在 domain 而不是页面里，是因为**三条路径都要用**：
 * 手动改关键词、点预设、以及「问 AI」改稿。三处各写一份文案必然分叉。
 */

export interface StyleChangeScope {
  characters: number;
  scenes: number;
  shots: number;
  /** 已经生成并存在本机的图片数量 */
  imageCount: number;
}

export interface StyleChangeImpact {
  /** 需不需要提示。项目里还没有内容时不需要 */
  needed: boolean;
  /** 有内容但还没出图 —— 只需要提醒「描述要重写」 */
  hasImages: boolean;
  /** 风险，按严重程度排 */
  risks: string[];
  /** 还是要改的话，按顺序做什么 */
  steps: string[];
}

/**
 * 评估「现在改风格会影响到什么」。
 *
 * 判据刻意简单：只要有角色 / 场景 / 分镜中的任何一个，就说明已经投入过，
 * 改风格就会让已有产出和新风格不一致。没有内容时什么都不用提醒。
 */
export function assessStyleChange(scope: StyleChangeScope): StyleChangeImpact {
  const { characters, scenes, shots, imageCount } = scope;
  const hasContent = characters + scenes + shots > 0;

  if (!hasContent) {
    return { needed: false, hasImages: imageCount > 0, risks: [], steps: [] };
  }

  const hasImages = imageCount > 0;

  const risks: string[] = [
    '角色与场景的**英文描述、连续性锁**是上一套风格下写的，它们不会跟着变。' +
      '旧描述里如果写着「3D 渲染」「照片质感」这类词，会和新的风格词打架。',
  ];

  if (hasImages) {
    risks.push(
      `已经生成的 ${imageCount} 张图是**旧风格的**。改完之后它们不会再被当作参考图——` +
        '拿旧风格的图当锚点，会让新图介于两种风格之间，看起来像崩了。',
      '但这些图**不会自动删除**，仍然留在图库里。所以你会看到新旧两种风格的图混在一起。',
    );
  }

  const steps: string[] = [
    '先把风格改到位（选预设，或用「用这段中文生成英文关键词」），并确认下面的英文列表已经变了。',
    '去「角色」点「**全部角色形象图**」，去「场景」点「**全部场景参考板**」——原地重出，id 不变。',
    '**不要点「从故事里拆角色与场景」**：那会用新 id 重建全部角色和场景，旧图会变成关联不上的孤儿。',
    shots > 0
      ? '回「分镜」逐镜重出三帧。**同一镜的三帧要一起重出**——只重出后两帧，它们就没有首帧当构图锚点了。'
      : '出分镜之后，每镜的三帧要一起出。',
    '重出完跑一遍穿帮检查。',
  ];

  return { needed: true, hasImages, risks, steps };
}

/**
 * 一行式摘要，放在折叠区的标题上。
 *
 * 完整文案很长，默认展开会把「风格」这一节撑得没法定睛；
 * 但只给一句「改风格有风险」又等于没说。所以标题给结论、展开给依据。
 */
export function styleChangeSummary(impact: StyleChangeImpact): string {
  if (!impact.needed) return '';
  return impact.hasImages
    ? '改风格会让已生成的图失效，并且需要按顺序重出'
    : '改风格会让已有的角色与场景描述和它对不上';
}
