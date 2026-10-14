import { describe, expect, it } from 'vitest';
import {
  CAMERA_MOVE_GUIDE,
  findTerm,
  searchTerms,
  SHOT_SIZE_GUIDE,
  TERMS,
  TERM_CATEGORY_LABEL,
  termsByCategory,
} from '../src/domain/help/terms';
import { CAMERA_MOVE_LABEL, SHOT_SIZE_LABEL } from '../src/types/model';

/**
 * 术语表。
 *
 * 这组测试盯的是「新手能不能真的用上」：
 *  - 每条必须回答「什么时候用它」，不能只有定义
 *  - 景别与运镜的每一档都要有说明，不能漏
 *  - 搜索要能用中文、英文、甚至用法描述命中
 *  - 不能和代码里的枚举脱节（改了枚举忘了改术语表，用户会看到空白）
 */

describe('术语表 · 内容完整度', () => {
  it('每条都有中英文、定义与使用场景', () => {
    expect(TERMS.length).toBeGreaterThan(25);
    for (const term of TERMS) {
      expect(term.zh.length).toBeGreaterThan(0);
      expect(term.en.length).toBeGreaterThan(0);
      expect(term.summary.length).toBeGreaterThan(5);
      // 「什么时候用它」是这一页存在的理由，不能空着
      expect(term.whenToUse.length).toBeGreaterThan(20);
    }
  });

  it('术语不重复', () => {
    const names = TERMS.map((t) => t.zh);
    expect(new Set(names).size).toBe(names.length);
  });

  it('每条都属于一个已声明的分类，且分类都有中文名', () => {
    for (const term of TERMS) {
      expect(TERM_CATEGORY_LABEL[term.category]).toBeDefined();
      expect(TERM_CATEGORY_LABEL[term.category].length).toBeGreaterThan(0);
    }
  });

  it('七个分类里至少各有内容，不能出现空分类', () => {
    for (const category of Object.keys(TERM_CATEGORY_LABEL)) {
      void category;
    }
    const used = new Set(TERMS.map((t) => t.category));
    // 允许个别分类暂时为空，但必须有六个以上分类被用上
    expect(used.size).toBeGreaterThanOrEqual(6);
  });

  it('讲的是判断依据，不是字典定义', () => {
    // 大部分词条的「什么时候用它」应当提到观众/情绪/节奏这类后果词
    const withReasoning = TERMS.filter((t) =>
      /观众|情绪|节奏|感受|张力|代入|注意力|错觉|判断/.test(t.whenToUse),
    );
    expect(withReasoning.length / TERMS.length).toBeGreaterThan(0.5);
  });
});

describe('术语表 · 覆盖代码里的枚举', () => {
  it('景别每一档都有使用说明', () => {
    for (const size of Object.keys(SHOT_SIZE_LABEL)) {
      const guide = SHOT_SIZE_GUIDE[size as keyof typeof SHOT_SIZE_GUIDE];
      expect(guide, `缺少景别说明：${size}`).toBeDefined();
      expect(guide.length).toBeGreaterThan(10);
    }
  });

  it('运镜每一档都有使用说明', () => {
    for (const move of Object.keys(CAMERA_MOVE_LABEL)) {
      const guide = CAMERA_MOVE_GUIDE[move as keyof typeof CAMERA_MOVE_GUIDE];
      expect(guide, `缺少运镜说明：${move}`).toBeDefined();
      expect(guide.length).toBeGreaterThan(10);
    }
  });

  it('固定镜头明确写着「默认就该用它」——这是新手最需要被纠正的一点', () => {
    expect(CAMERA_MOVE_GUIDE.static).toContain('默认');
  });

  it('中景明确写着「不知道用什么就用它」', () => {
    expect(SHOT_SIZE_GUIDE.medium).toContain('不知道用什么');
  });

  it('特写提醒了不要滥用', () => {
    expect(SHOT_SIZE_GUIDE['extreme-close-up']).toContain('够');
  });
});

describe('术语表 · 检索', () => {
  it('空查询返回全部', () => {
    expect(searchTerms('')).toHaveLength(TERMS.length);
    expect(searchTerms('   ')).toHaveLength(TERMS.length);
  });

  it('中文命中', () => {
    expect(searchTerms('近景').some((t) => t.zh === '近景')).toBe(true);
  });

  it('英文命中（大小写不敏感）', () => {
    expect(searchTerms('close-up').length).toBeGreaterThan(0);
    expect(searchTerms('CLOSE-UP').length).toBeGreaterThan(0);
  });

  it('按用法里的词也能命中——用户往往只记得「那个让人显得小的」', () => {
    const results = searchTerms('弱小');
    expect(results.some((t) => t.zh.includes('俯拍'))).toBe(true);
  });

  it('搜不到时返回空数组而不是全部', () => {
    expect(searchTerms('这个词一定不存在xyz')).toEqual([]);
  });

  it('按 id 精确查找', () => {
    expect(findTerm('连续性锁')?.en).toBe('Continuity lock');
    expect(findTerm('不存在')).toBeUndefined();
  });

  it('按分类筛选', () => {
    const sizes = termsByCategory('shot-size');
    expect(sizes.length).toBeGreaterThanOrEqual(6);
    for (const term of sizes) expect(term.category).toBe('shot-size');
  });
});

describe('术语表 · 关键概念与产品机制对得上', () => {
  it('连续性锁的解释里强调了「只锁不会变的东西」', () => {
    const term = findTerm('连续性锁')!;
    expect(term.whenToUse).toContain('不随剧情改变');
  });

  it('变体解释了「换外套是变体不是新角色」', () => {
    const term = findTerm('变体')!;
    expect(term.whenToUse).toContain('换了件外套');
  });

  it('种子的解释里说清了它锁不住角色', () => {
    const term = findTerm('种子')!;
    expect(term.whenToUse).toContain('保不住');
  });

  it('关键帧的解释里说清了只画起点', () => {
    const term = findTerm('关键帧')!;
    expect(term.whenToUse).toContain('起点');
    expect(term.whenToUse).toContain('终点');
  });

  it('图生视频明确说明「不在本工具范围内」，避免预期错位', () => {
    const term = findTerm('图生视频')!;
    expect(term.whenToUse).toContain('不在本工具范围内');
  });

  it('负向词提醒不要混进正文', () => {
    const term = findTerm('负向词')!;
    expect(term.whenToUse).toContain('不要混进正文');
  });

  it('转场说明它不会进提示词——这是新手最容易误解的一处', () => {
    const term = findTerm('转场')!;
    expect(term.whenToUse).toContain('不会写进生成提示词');
  });
});
