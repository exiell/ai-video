// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import 'fake-indexeddb/auto';
import { MemoryRouter } from 'react-router-dom';
import { sampleProject } from '../src/data/samples/sampleProject';
import { runChecks } from '../src/domain/checks';
import type { Project } from '../src/types/model';
import { useAppStore } from '../src/store/app';
import { ChecksPage } from '../src/pages/ChecksPage';

/**
 * v0.51：严重度修饰类不能和工具类撞名。
 *
 * 事故：卡片原来写成 `className={`issue ${issue.severity}`}`，severity 的取值是
 * `error` / `warning` / `info`。而 `.info` 是全站提示点的工具类——
 *
 *     .info { position: relative; display: inline-flex; margin-left: 4px; }
 *
 * 那是正文里那个 ⓘ 小圆点的样式。两个类一撞，「看一眼」这一档的整张卡片
 * 变成 `display: inline-flex`：标题、为什么、怎么改、按钮全部挤在一行里。
 * 「必须修」和「建议修」两档没事（`.error` / `.warning` 没有同名工具类），
 * 所以只有最低的那一档看起来是坏的——用户的原话是「看一眼条目较为混乱，
 * 格式改成和建议修相同」。
 *
 * 修法：改用 `issue-sev-*` 前缀，不再和任何工具类同名。
 * 这个文件守住两件事：卡片用的是 `issue-sev-*`；页面上不存在同时带
 * `issue` 与 `info` 两个类的元素。
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.innerHTML = '';
});

/** 三档各来一条，确保「看一眼」这一档真的被渲染到。 */
function threeSeverities(): Project {
  const p = structuredClone(sampleProject);
  p.brief.styleTags = [];
  p.brief.aspectRatio = '' as Project['brief']['aspectRatio'];
  delete p.shots[1]!.transitionType;
  p.shots[0]!.duration = 22;
  p.shots[2]!.startState = '';
  return p;
}

function mount(): HTMLDivElement {
  const p = threeSeverities();
  const report = runChecks(p);
  useAppStore.setState({ project: p, report });
  return render(
    <MemoryRouter>
      <ChecksPage />
    </MemoryRouter>,
  );
}

describe('v0.51 · 严重度修饰类不再和工具类撞名', () => {
  it('三档都渲染出来（否则这条测试是空过的）', () => {
    const el = mount();
    const severities = new Set(
      [...el.querySelectorAll('.issue')].map(
        (n) => [...n.classList].find((c) => c.startsWith('issue-sev-')) ?? '',
      ),
    );
    expect(severities.has('issue-sev-error')).toBe(true);
    expect(severities.has('issue-sev-warning')).toBe(true);
    expect(severities.has('issue-sev-info')).toBe(true);
  });

  it('「看一眼」的卡片用的是 issue-sev-info，不是一个裸 info', () => {
    const el = mount();
    const cards = [...el.querySelectorAll('.issue')];
    const infoCards = cards.filter((n) => n.classList.contains('issue-sev-info'));
    expect(infoCards.length).toBeGreaterThan(0);
    // 关键断言：没有一个卡片同时带 .issue 与 .info（那会吃到工具类的 inline-flex）
    for (const card of cards) {
      expect(card.classList.contains('info')).toBe(false);
    }
    expect(document.querySelectorAll('.issue.info').length).toBe(0);
  });

  it('三档的卡片结构完全相同：标题 + 两段解释 + 一个按钮', () => {
    const el = mount();
    const bySeverity = new Map<string, Element>();
    for (const card of el.querySelectorAll('.issue')) {
      const sev = [...card.classList].find((c) => c.startsWith('issue-sev-'));
      if (sev && !bySeverity.has(sev)) bySeverity.set(sev, card);
    }
    for (const sev of ['issue-sev-error', 'issue-sev-warning', 'issue-sev-info']) {
      const card = bySeverity.get(sev);
      expect(card, sev).toBeTruthy();
      expect(card!.querySelector('.issue-title'), sev).toBeTruthy();
      expect(card!.querySelectorAll('.issue-explain .issue-mark').length, sev).toBe(2);
      expect(card!.querySelector('.row .btn'), sev).toBeTruthy();
    }
  });

  it('编号规则：issue-sev- 后面只会是 error / warning / info 三个值', () => {
    const el = mount();
    for (const card of el.querySelectorAll('.issue')) {
      const sev = [...card.classList].filter((c) => c.startsWith('issue-sev-'));
      expect(sev.length).toBeLessThanOrEqual(1);
      if (sev.length === 1) {
        expect(['issue-sev-error', 'issue-sev-warning', 'issue-sev-info']).toContain(sev[0]);
      }
    }
  });

  it('AutoFixPanel 之类只写 issue 的卡片不受影响（仍然只有 issue 一个类）', () => {
    const el = mount();
    const plain = [...el.querySelectorAll('.issue')].filter(
      (n) => ![...n.classList].some((c) => c.startsWith('issue-sev-')),
    );
    for (const card of plain) {
      expect(card.classList.contains('info')).toBe(false);
      expect(card.classList.contains('error')).toBe(false);
      expect(card.classList.contains('warning')).toBe(false);
    }
  });
});
