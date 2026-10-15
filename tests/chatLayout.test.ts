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
