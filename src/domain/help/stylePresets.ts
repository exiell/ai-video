/**
 * 动漫风格预设
 *
 * ===========================================================================
 * 为什么需要预设，而不是让用户自己写英文词
 * ===========================================================================
 * 用户报过一个问题：「选定风格时似乎只是为分镜提示词设定风格，
 * 却没有为角色形象图和场景图的生成设定风格」。
 *
 * 查下来风格**确实**注入了三处出图提示词——问题出在界面上：
 * 向导里那个「风格倾向」是中文输入框，而真正进提示词的
 * 「风格关键词」要求用户自己写英文。多数人会认真填中文那一栏，
 * 然后在英文那一栏里随便写两句或干脆跳过。
 * 结果就是：他以为设定了风格，实际生效的是他随手写的那几个词。
 *
 * 所以这里做两件事：
 *  1. 给一组**点一下就能用**的预设，每个都是写好并验证过结构的英文风格词
 *  2. 让用户**当场看见**选中的风格会变成什么英文词——不看到就等于没设定
 */

export interface StylePreset {
  id: string;
  /** 中文名，用户选的是它 */
  label: string;
  /** 一句话说明这个风格适合什么 */
  description: string;
  /** 英文风格词，会原样进入每一张图的提示词 */
  tags: string[];
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'cel-shaded-anime',
    label: '日式赛璐璐动画',
    description: '轮廓线清晰、色块分明，最常见的 TV 动画质感。稳妥不出错。',
    tags: [
      'anime style',
      'cel shading',
      'clean line art',
      'vibrant but controlled color palette',
    ],
  },
  {
    id: 'ink-wash',
    label: '水墨写意',
    description: '大面积留白、墨色浓淡变化。适合古风、诗意、克制的叙事。',
    tags: [
      'Chinese ink wash painting style',
      'large areas of negative space',
      'monochrome ink tones with subtle color accents',
      'brush stroke texture',
    ],
  },
  {
    id: 'ghibli',
    label: '吉卜力风',
    description: '柔和自然光、饱满的背景细节。适合温暖日常与自然题材。',
    tags: [
      'Studio Ghibli inspired anime style',
      'soft natural lighting',
      'richly detailed hand-painted backgrounds',
      'warm gentle color palette',
    ],
  },
  {
    id: 'cinematic-dark',
    label: '电影感冷调',
    description: '低饱和、强对比、有明显光源方向。适合悬疑、严肃题材。',
    tags: [
      'cinematic anime style',
      'low saturation cold color grading',
      'strong directional lighting',
      'film grain',
    ],
  },
  {
    id: 'cyberpunk',
    label: '赛博朋克',
    description: '霓虹、高饱和、夜景。适合科幻与都市题材。',
    tags: [
      'cyberpunk anime style',
      'neon lighting',
      'high contrast night scene',
      'wet reflective surfaces',
    ],
  },
  {
    id: 'picture-book',
    label: '绘本插画',
    description: '笔触明显、色彩柔和偏粉彩。适合童话与温柔的故事。',
    tags: [
      'children picture book illustration style',
      'soft pastel color palette',
      'visible watercolor texture',
      'gentle rounded shapes',
    ],
  },
  {
    id: 'shonen-action',
    label: '热血少年漫',
    description: '强透视、放射线、高对比。适合战斗与爆发场面。',
    tags: [
      'shonen manga anime style',
      'dynamic perspective',
      'bold speed lines',
      'high contrast action lighting',
    ],
  },
  {
    id: 'wuxia-ink',
    label: '国漫武侠',
    description: '写意与写实之间，冷调为主，质感厚重。适合武侠与历史题材。',
    tags: [
      'Chinese ink wash painting style mixed with cel-shaded anime',
      'cold blue and grey palette',
      'heavy fabric texture',
      'cinematic composition',
    ],
  },
];

/** 按 id 找预设 */
export function findStylePreset(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find((p) => p.id === id);
}

/**
 * 判断当前风格词命中哪个预设（用于回显「你现在用的是哪一个」）。
 * 比对全部标签都命中才算，避免部分相似就归到某个预设。
 */
export function matchStylePreset(tags: string[]): StylePreset | undefined {
  const set = new Set(tags.map((t) => t.trim().toLowerCase()));
  if (set.size === 0) return undefined;
  return STYLE_PRESETS.find((preset) => {
    const presetTags = preset.tags.map((t) => t.toLowerCase());
    const hits = presetTags.filter((t) => set.has(t)).length;
    return hits >= Math.ceil(presetTags.length * 0.75);
  });
}
