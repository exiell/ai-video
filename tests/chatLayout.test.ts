import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 对话栏布局的静态断言（方案.md §7.6.20）
 *
 * ===========================================================================
 * 为什么这类测试值得写：一个「看代码看不出来」的真实 bug
 * ===========================================================================
 * 收起/展开按钮连续坏了两次，两个原因都只能在**布局引擎**里暴露：
 *
 * 坑 1：按钮绝对定位到 `left: -30px`（面板外），面板 `overflow: hidden`
 *       → 展开时按钮被裁掉，用户没有收起入口。
 *
 * 坑 2（更隐蔽）：`--chat-w` 被设在 `.chat-panel` 上，而**用它的
 *       `grid-template-columns` 在 `.app` 上**。CSS 自定义属性只沿 DOM
 *       向下继承 —— `.app` 读到的还是自己的 `0px`，那个 30px 完全没参与布局。
 *       光看代码发现不了，因为变量确实被设成了 30px。
 *
 * jsdom 没有布局引擎，组件测试测不到这些。所以这里直接读 CSS 源码，
 * 断言「变量与使用它的属性在同一个元素上」——**这正是坑 2 的根因**。
 */

const css = readFileSync(resolve(__dirname, '../src/styles/global.css'), 'utf8');

/** 取出某条规则块的内容（简单实现，够用） */
function ruleBody(selector: string): string | null {
  // 转义选择器里的 . 和 : 等，避免被当成正则元字符
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return m?.[1] ?? null;
}

describe('对话框的布局契约', () => {
  it('**`--chat-w` 与 `grid-template-columns` 在同一个元素上**', () => {
    const app = ruleBody('.app');
    expect(app, '找不到 .app 规则').not.toBeNull();
    // 两者必须在同一条规则里 —— 变量设在使用它的元素上，是坑 2 的根治
    expect(app!, '网格列定义不见了').toContain('grid-template-columns');
    expect(app!, '--chat-w 的默认值必须和 grid-template-columns 在一起').toContain('--chat-w');

    // 反例：变量只出现在 .chat-panel 上（那正是坏掉的那版）
    const panel = ruleBody('.chat-panel');
    expect(panel ?? '').not.toContain('--chat-w');
  });

  it('展开时给对话栏 340px', () => {
    const open = ruleBody('.app.chat-open');
    expect(open, '找不到 .app.chat-open').not.toBeNull();
    expect(open!).toMatch(/--chat-w:\s*340px/);
  });

  it('**收起时也要给宽度，不能是 0**', () => {
    // 收成 0 会让整列没有空间 —— flex 里的按钮照样被裁掉，
    // 症状就是「连展开按钮都消失了」。
    const collapsed = ruleBody('.app:not(.chat-open)');
    expect(collapsed, '缺少收起态的宽度设置').not.toBeNull();
    const m = /--chat-w:\s*(\d+)px/.exec(collapsed!);
    expect(m, '收起态的 --chat-w 必须是具体像素').not.toBeNull();
    expect(Number(m![1]), '收起态列宽不能是 0').toBeGreaterThan(0);
  });

  it('**收起态的列宽与切换条宽度一致**', () => {
    // 不一致会导致两种症状：列宽 < 按钮宽 → 裁掉一部分；
    // 列宽 > 按钮宽 → 留一条空白。
    const collapsed = ruleBody('.app:not(.chat-open)')!;
    const colW = Number(/--chat-w:\s*(\d+)px/.exec(collapsed)![1]);
    const toggleW = Number(/width:\s*(\d+)px/.exec(ruleBody('.chat-toggle')!)![1]);
    expect(colW).toBe(toggleW);
  });

  it('**切换条不能用负偏移定位**（那正是它被裁掉的原因）', () => {
    const toggle = ruleBody('.chat-toggle');
    expect(toggle, '找不到 .chat-toggle 规则').not.toBeNull();
    // 负的 left/right 会把按钮挪到容器外，再靠 overflow 露出来 ——
    // 「看起来能用、换个状态就废」的典型写法
    expect(toggle!, '切换条不该用负偏移定位').not.toMatch(/(?:left|right|top|bottom):\s*-/);
    expect(toggle!, '切换条应该在正常文档流里').not.toContain('position: absolute');
  });

  it('对话栏正文宽度要减去切换条占的空间', () => {
    const body = ruleBody('.chat-body');
    expect(body, '找不到 .chat-body 规则').not.toBeNull();
    expect(body!).toContain('var(--chat-w)');
    // 不减掉切换条宽度就会撑出去 30px
    expect(body!).toMatch(/calc\(var\(--chat-w\)\s*-/);
  });

  it('对话栏容器是横向 flex（按钮与正文并排）', () => {
    const panel = ruleBody('.chat-panel')!;
    expect(panel).toContain('display: flex');
    expect(panel).toContain('flex-direction: row');
  });
});

// ---------------------------------------------------------------------------
// 文档数字不能和内容脱节
// ---------------------------------------------------------------------------

/**
 * 起因：写变更日志时发现帮助页开头写着「**四**道防线叠起来」，
 * 而下面实际列了**五**条。翻设计文档才看到，v0.24 有一句
 * 「帮助页一致性一节从四道防线扩到五道」—— 那次只加了内容，忘了改那句总结。
 *
 * 这类问题没人会主动发现：读者看到「四道」会以为自己数错了，
 * 或者干脆不数。所以让测试来数。
 */
describe('帮助页的一致性防线：数字要和列表一致', () => {
  const help = readFileSync(resolve(__dirname, '../src/pages/HelpPage.tsx'), 'utf8');
  const readme = readFileSync(resolve(__dirname, '../README.md'), 'utf8');

  /** 数「第N道：」出现到第几 */
  function highestLayer(text: string): number {
    const nums = [...text.matchAll(/第([一二三四五六七八九十]+)道/g)].map((m) =>
      '一二三四五六七八九十'.indexOf(m[1]!) + 1,
    );
    return nums.length > 0 ? Math.max(...nums) : 0;
  }

  const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

  it('**帮助页开头写的数字，等于实际列出的条数**', () => {
    const listed = highestLayer(help);
    expect(listed, '帮助页一条防线都没找到').toBeGreaterThan(0);

    const m = /是\*\*([一二三四五六七八九十]+)道防线/.exec(help);
    expect(m, '帮助页开头找不到「N 道防线」这句话').not.toBeNull();
    const claimed = CN.indexOf(m![1]!);

    expect(claimed, `开头说「${m![1]}道」，实际列了 ${listed} 条`).toBe(listed);
  });

  it('**README 里的数字与帮助页一致**', () => {
    const listed = highestLayer(help);
    const m = /([一二三四五六七八九十]+)道一致性防线/.exec(readme);
    expect(m, 'README 找不到「N 道一致性防线」').not.toBeNull();
    expect(CN.indexOf(m![1]!), 'README 与帮助页的说法不一致').toBe(listed);
  });

  it('**README 表格里的防线条数对得上**', () => {
    /*
      原来这条靠 `**几个刻意做对的地方` 这个标题当作表格结束的位置。
      那份 bullet 列表在 2026-10 的重写里删掉了（内容搬去 CHANGELOG 与提交信息），
      所以改成用「表头行 + 分隔行之后连续以 | 开头的行」来数，
      不再依赖某个会被删除的标题。
    */
    const section = readme.slice(readme.indexOf('道一致性防线'));
    const lines = section.split(/\r?\n/);
    const header = lines.findIndex((line) => /^\|\s*层\s*\|/.test(line));
    expect(header, 'README 找不到五道防线那张表').toBeGreaterThanOrEqual(0);

    let rows = 0;
    for (let i = header + 2; i < lines.length; i += 1) {
      if (!lines[i]!.startsWith('|')) break;
      rows += 1;
    }
    expect(rows, 'README 表格里的防线条数与正文说法不一致').toBe(highestLayer(help));
  });
});
