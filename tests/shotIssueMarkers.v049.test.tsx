// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { StoryboardPage } from '../src/pages/StoryboardPage';
import { ChecksPage } from '../src/pages/ChecksPage';
import { useAppStore } from '../src/store/app';
import { useImage } from '../src/store/image';
import { sampleProject } from '../src/data/samples/sampleProject';
import { SEVERITY_LABEL, runChecks, worstSeverity } from '../src/domain/checks';
import type { CheckIssue, CheckReport, CheckSeverity, Project } from '../src/types/model';

/**
 * 分镜页就地显示穿帮标记（v0.49）
 *
 * ===========================================================================
 * 问题
 * ===========================================================================
 * 检查结果原来只存在于「穿帮检查」页。改一镜要来回跳两趟：
 * 分镜页改 → 检查页看 → 分镜页再改。
 *
 * 而检查是纯本地计算、零成本的，结果本来就在 store 里（每次改项目都会重算），
 * 只是没有人把它带回到出错的那个字段旁边。
 *
 * 这一组测试守三件事：
 * 1. 每一处问题都标在它自己的字段下面，不是糊成一坨
 * 2. 摊开的文案与检查页**逐字相同**——同一件事在两页说成两样，用户会以为是两件事
 * 3. 贴不到字段上的问题不能丢（比如 `variantIds` 要去角色页改）
 */

let container: HTMLDivElement | null = null;

function render(node: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  const el = container;
  container = null;
  return el;
}

function cleanup(el: HTMLDivElement): void {
  act(() => {
    el.remove();
  });
}

function oneShot(): Project {
  const project = structuredClone(sampleProject);
  project.shots = project.shots.slice(0, 1);
  return project;
}

function makeIssue(
  shotId: string,
  field: string | undefined,
  severity: CheckSeverity,
  title: string,
): CheckIssue {
  return {
    id: `${shotId}:${field ?? 'none'}:${title}`,
    ruleId: 'shot-incomplete',
    severity,
    title,
    why: `${title}的原因在这里`,
    suggestion: `${title}的改法在这里`,
    location: field ? { kind: 'shot', id: shotId, field } : { kind: 'shot', id: shotId },
  };
}

function reportOf(issues: CheckIssue[]): CheckReport {
  const counts: Record<CheckSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return { issues, checkedAt: '2026-10-22T00:00:00.000Z', counts };
}

beforeEach(() => {
  useImage.setState({ pending: null, feedback: {}, gallery: {}, assetCount: 0, assetCounts: {} });
});

// ---------------------------------------------------------------------------
// 最严重的那一档：徽标颜色靠它
// ---------------------------------------------------------------------------

describe('worstSeverity', () => {
  const shotId = 'shot-x';

  it('没有问题时返回 null，而不是兜底成 info', () => {
    // 兜底成 info 会让「没问题」也显示一个徽标出来
    expect(worstSeverity([])).toBeNull();
  });

  it('error 压过 warning 与 info', () => {
    const issues = [
      makeIssue(shotId, 'action', 'info', 'a'),
      makeIssue(shotId, 'action', 'error', 'b'),
      makeIssue(shotId, 'action', 'warning', 'c'),
    ];
    expect(worstSeverity(issues)).toBe('error');
  });

  it('只有 info 时返回 info', () => {
    expect(worstSeverity([makeIssue(shotId, 'duration', 'info', 'a')])).toBe('info');
  });

  it('顺序不影响结果', () => {
    const issues = [
      makeIssue(shotId, 'action', 'info', 'a'),
      makeIssue(shotId, 'action', 'error', 'b'),
    ];
    expect(worstSeverity([...issues].reverse())).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// 表头徽标
// ---------------------------------------------------------------------------

describe('分镜页 · 镜头表头上的问题数', () => {
  it('**有问题的镜头要显示「N 处要改」**', () => {
    const project = oneShot();
    const shot = project.shots[0]!;
    useAppStore.setState({
      project,
      report: reportOf([makeIssue(shot.id, 'action', 'error', '动作有问题')]),
    });
    const el = render(<StoryboardPage />);
    expect(el.textContent).toContain('1 处要改');
    cleanup(el);
  });

  it('徽标的配色跟着最严重的那一档走', () => {
    const project = oneShot();
    const shot = project.shots[0]!;
    useAppStore.setState({
      project,
      report: reportOf([
        makeIssue(shot.id, 'action', 'warning', 'w'),
        makeIssue(shot.id, 'mood', 'error', 'e'),
      ]),
    });
    const el = render(<StoryboardPage />);
    const badge = el.querySelector('.issue-badge');
    expect(badge).not.toBeNull();
    // 两条里有一条是 error，整枚徽标就该是红的
    expect(badge!.className).toContain('tag-error');
    expect(badge!.textContent).toContain('2 处要改');
    cleanup(el);
  });

  it('没有问题时不显示徽标', () => {
    const project = oneShot();
    useAppStore.setState({ project, report: reportOf([]) });
    const el = render(<StoryboardPage />);
    expect(el.querySelector('.issue-badge')).toBeNull();
    cleanup(el);
  });

  it('还没跑过检查（report 为 null）时不显示徽标，也不报错', () => {
    useAppStore.setState({ project: oneShot(), report: null });
    const el = render(<StoryboardPage />);
    expect(el.querySelector('.issue-badge')).toBeNull();
    expect(el.textContent).toContain('分镜表');
    cleanup(el);
  });

  it('只统计这一镜自己的问题，不把别的镜头算进来', () => {
    const project = structuredClone(sampleProject);
    project.shots = project.shots.slice(0, 2);
    const [first, second] = project.shots;
    useAppStore.setState({
      project,
      report: reportOf([
        makeIssue(first!.id, 'action', 'error', '第一镜的问题'),
        makeIssue(second!.id, 'action', 'error', '第二镜的问题'),
        makeIssue(second!.id, 'mood', 'warning', '第二镜的另一个问题'),
      ]),
    });
    const el = render(<StoryboardPage />);
    const badges = [...el.querySelectorAll('.issue-badge')].map((n) => n.textContent);
    expect(badges).toEqual(['1 处要改', '2 处要改']);
    cleanup(el);
  });
});

// ---------------------------------------------------------------------------
// 字段旁边就地展开
// ---------------------------------------------------------------------------

describe('分镜页 · 字段旁边就地展开', () => {
  it('**动作的问题标在动作字段下面**', () => {
    const project = oneShot();
    const shot = project.shots[0]!;
    useAppStore.setState({
      project,
      report: reportOf([makeIssue(shot.id, 'action', 'warning', '动作有问题')]),
    });
    const el = render(<StoryboardPage />);
    const flags = [...el.querySelectorAll('.field-issues')].map((n) => n.textContent ?? '');
    expect(flags.some((t) => t.includes('「动作」这里有 1 个问题'))).toBe(true);
    cleanup(el);
  });

  it('表头三个控件（时长 / 景别 / 场景）的问题各自一条，不并成一条', () => {
    const project = oneShot();
    const shot = project.shots[0]!;
    useAppStore.setState({
      project,
      report: reportOf([
        makeIssue(shot.id, 'duration', 'info', '时长问题'),
        makeIssue(shot.id, 'shotSize', 'warning', '景别问题'),
        makeIssue(shot.id, 'sceneId', 'error', '场景问题'),
      ]),
    });
    const el = render(<StoryboardPage />);
    const text = el.textContent ?? '';
    expect(text).toContain('「时长」这里有 1 个问题');
    expect(text).toContain('「景别」这里有 1 个问题');
    expect(text).toContain('「场景」这里有 1 个问题');
    cleanup(el);
  });

  it('默认是收起的（不主动摊开一堆文字），但内容已经在 DOM 里', () => {
    const project = oneShot();
    const shot = project.shots[0]!;
    useAppStore.setState({
      project,
      report: reportOf([makeIssue(shot.id, 'action', 'warning', '动作有问题')]),
    });
    const el = render(<StoryboardPage />);
    const details = [...el.querySelectorAll('.field-issues')];
    expect(details.length).toBeGreaterThan(0);
    expect(details.every((d) => !d.hasAttribute('open'))).toBe(true);
    cleanup(el);
  });

  it('**摊开的文案与检查页逐字相同**（标题、为什么、怎么改三段都在）', () => {
    const project = oneShot();
    const shot = project.shots[0]!;
    const issue: CheckIssue = {
      id: 'x',
      ruleId: 'multi-action',
      severity: 'warning',
      title: '第 1 镜里疑似塞了 2 个动作',
      why: '一镜多动作是最常见的坑。',
      suggestion: '把这一镜折成 2 个镜头，每个镜头只做一件事。',
      location: { kind: 'shot', id: shot.id, field: 'action' },
    };
    useAppStore.setState({ project, report: reportOf([issue]) });
    const el = render(<StoryboardPage />);
    const text = el.textContent ?? '';
    expect(text).toContain(issue.title);
    expect(text).toContain(issue.why);
    expect(text).toContain(issue.suggestion);
    cleanup(el);
  });
});

// ---------------------------------------------------------------------------
// 贴不到字段上的问题
// ---------------------------------------------------------------------------

describe('分镜页 · 贴不到字段上的问题不能丢', () => {
  it('**variantIds 的问题落到「还有 N 处不在这几个字段上」**', () => {
    // variantIds 要在角色页改，分镜页没有这个控件。
    // 丢掉它就等于回到「必须去检查页才看得见」。
    const project = oneShot();
    const shot = project.shots[0]!;
    useAppStore.setState({
      project,
      report: reportOf([makeIssue(shot.id, 'variantIds', 'error', '变体归属不对')]),
    });
    const el = render(<StoryboardPage />);
    const text = el.textContent ?? '';
    expect(text).toContain('这一镜还有 1 处不在这几个字段上');
    expect(text).toContain('变体归属不对');
    cleanup(el);
  });

  it('完全没写 field 的问题也落到那里', () => {
    const project = oneShot();
    const shot = project.shots[0]!;
    useAppStore.setState({
      project,
      report: reportOf([makeIssue(shot.id, undefined, 'warning', '说不清在哪的问题')]),
    });
    const el = render(<StoryboardPage />);
    expect(el.textContent).toContain('说不清在哪的问题');
    cleanup(el);
  });

  it('贴得上的问题同时说明了「另外 N 处已经标在字段下面」', () => {
    const project = oneShot();
    const shot = project.shots[0]!;
    useAppStore.setState({
      project,
      report: reportOf([
        makeIssue(shot.id, 'action', 'warning', '动作问题'),
        makeIssue(shot.id, 'variantIds', 'error', '变体问题'),
      ]),
    });
    const el = render(<StoryboardPage />);
    expect(el.textContent).toContain('另外 1 处已经标在对应的字段下面了');
    cleanup(el);
  });
});

// ---------------------------------------------------------------------------
// 与真实检查引擎对接（上面都是手搓 report，这里跑真的）
// ---------------------------------------------------------------------------

describe('分镜页 · 接真实检查引擎', () => {
  function brokenProject(): Project {
    const project = structuredClone(sampleProject);
    project.shots = project.shots.slice(0, 2);
    // 起点清空 → shot-incomplete（必须修，field: startState）
    project.shots[0]!.startState = '';
    return project;
  }

  it('清空起点后，起点字段下面出现检查给的那条问题', () => {
    const project = brokenProject();
    const report = runChecks(project);
    useAppStore.setState({ project, report });

    const target = report.issues.find(
      (i) =>
        i.location.kind === 'shot' &&
        i.location.id === project.shots[0]!.id &&
        i.location.field === 'startState',
    );
    expect(target).toBeDefined();

    const el = render(<StoryboardPage />);
    // 镜头的细分区默认收起，先点开这一镜
    const toggle = [...el.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('展开'),
    );
    expect(toggle).toBeDefined();
    act(() => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const text = el.textContent ?? '';
    expect(text).toContain('「起点」这里有');
    expect(text).toContain(target!.title);
    expect(text).toContain(SEVERITY_LABEL[target!.severity]);
    cleanup(el);
  });

  it('检查页本身仍然正常渲染（严重度文案已挪到领域层，别挪坏）', () => {
    const project = brokenProject();
    useAppStore.setState({ project, report: runChecks(project) });
    const el = render(<ChecksPage />);
    const text = el.textContent ?? '';
    expect(text).toContain('必须修');
    expect(text).toContain('建议修');
    expect(text).toContain('看一眼');
    cleanup(el);
  });
});
