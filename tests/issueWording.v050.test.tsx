// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import 'fake-indexeddb/auto';
import { MemoryRouter } from 'react-router-dom';
import { sampleProject } from '../src/data/samples/sampleProject';
import { runChecks } from '../src/domain/checks';
import type { CheckIssue, Project } from '../src/types/model';
import { IssueBody } from '../src/components/IssueViews';
import { useAppStore } from '../src/store/app';
import { ChecksPage } from '../src/pages/ChecksPage';
import { StoryboardPage } from '../src/pages/StoryboardPage';

/**
 * v0.50：穿帮条目的排版与文案。
 *
 * 用户的抱怨是「条目混乱，无法一眼看出问题在哪、怎么修改」。原因有两个，
 * 这里各守一条：
 *
 *  1. 排版上，「为什么」「怎么改」原来只是正文行首的粗体字，长条目读下来是一片灰。
 *  2. 文案上，同一条规则常常给两三个并列方案（「两个选择：…；或者…」），
 *     而且有些字符串里写了 `**` Markdown 强调——检查页是纯文本渲染，
 *     星号会原样显示给用户。
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

function purge() {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.innerHTML = '';
}

afterEach(purge);

/** 触发尽量多规则的坏项目。文案规范要在「真的会被发出来」的字符串上检查。 */
function brokenProject(): Project {
  const p = structuredClone(sampleProject);
  p.brief.styleTags = [];
  p.brief.aspectRatio = '' as Project['brief']['aspectRatio'];
  p.characters[1]!.continuityLocks = [];
  for (const s of p.scenes) {
    s.fixedElements = [];
    s.identity.spatialStructure = '';
    s.lightDirection = '';
    s.mainColor = '';
  }
  p.shots.forEach((s, i) => {
    delete s.transitionType;
    s.continuityNote = '';
    if (i === 0) s.duration = 22;
    if (i === 1) s.startState = '';
    if (i === 2) s.mood = '他很悲伤';
    if (i === 3) s.shotSize = p.shots[2]!.shotSize;
    if (i === 4) s.activeLockIds = [];
    if (i === 5) s.action = '他抬手摘帽，然后推开门走进雪里';
  });
  return p;
}

function allIssues(): CheckIssue[] {
  return runChecks(brokenProject()).issues;
}

describe('v0.50 · 「为什么 / 怎么改」的排版', () => {
  it('两段各带一个图标与文字标签，不再用「为什么：」这种冒号行首', () => {
    const issue: CheckIssue = {
      id: 't1',
      ruleId: 'multi-action',
      severity: 'warning',
      title: '第 3 镜里疑似塞了 2 个动作',
      why: '几秒内做不完两个动作。',
      suggestion: '拆成两个镜头。',
      location: { kind: 'shot', id: 's1', field: 'action' },
    };
    const el = render(<IssueBody issue={issue} />);
    const marks = [...el.querySelectorAll('.issue-mark')];
    expect(marks.map((m) => m.textContent)).toEqual(['为什么', '怎么改']);
    // 图标是 mask 元素，两个标签各有一个
    expect(el.querySelectorAll('.issue-mark .icon').length).toBe(2);
    expect(el.querySelector('.issue-mark-why')).toBeTruthy();
    expect(el.querySelector('.issue-mark-fix')).toBeTruthy();
    expect(el.textContent).not.toContain('为什么：');
    expect(el.textContent).not.toContain('怎么改：');
  });

  it('文字原样输出，不加书名号也不截断', () => {
    const issue: CheckIssue = {
      id: 't2',
      ruleId: 'pronoun-in-visual',
      severity: 'warning',
      title: '第 1 镜的画面描述里用了「他」',
      why: '模型不知道「他」是谁。',
      suggestion: '把「他」换成具体人名（林冲）。',
      location: { kind: 'shot', id: 's1', field: 'action' },
    };
    const el = render(<IssueBody issue={issue} />);
    const texts = [...el.querySelectorAll('.issue-text')].map((n) => n.textContent);
    expect(texts).toEqual(['模型不知道「他」是谁。', '把「他」换成具体人名（林冲）。']);
  });

  it('检查页与分镜页用的是同一套排版（同一份组件，不是两套）', () => {
    const p = brokenProject();
    useAppStore.setState({ project: p, report: runChecks(p) });

    const checks = render(
      <MemoryRouter>
        <ChecksPage />
      </MemoryRouter>,
    );
    const checkMarks = checks.querySelectorAll('.issue-explain .issue-mark').length;
    expect(checkMarks).toBeGreaterThan(0);
    purge();

    useAppStore.setState({ project: p, report: runChecks(p) });
    const storyboard = render(
      <MemoryRouter initialEntries={['/storyboard']}>
        <StoryboardPage />
      </MemoryRouter>,
    );
    // 分镜页默认收起，但 DOM 已经在了
    expect(storyboard.querySelectorAll('.issue-explain .issue-mark').length).toBeGreaterThan(0);
  });
});

describe('v0.50 · 文案规范', () => {
  it('「为什么」和「怎么改」里不出现 Markdown 星号（页面上是纯文本渲染，会原样显示）', () => {
    const bad = allIssues().filter((i) => i.why.includes('**') || i.suggestion.includes('**'));
    expect(bad.map((i) => i.title)).toEqual([]);
  });

  it('不出现换行与制表符（这些字符串进的是行内文案）', () => {
    const bad = allIssues().filter(
      (i) => /[\n\r\t]/.test(i.why) || /[\n\r\t]/.test(i.suggestion),
    );
    expect(bad.map((i) => i.title)).toEqual([]);
  });

  it('不出现「两个选择 / 三种改法 / ①」这类并列编号（要的是首选做法，不是选择题）', () => {
    const patterns = ['两个选择', '三种改法', '两种写法', '①②③', '① '];
    const bad = allIssues().filter((i) =>
      patterns.some((pat) => i.why.includes(pat) || i.suggestion.includes(pat)),
    );
    expect(bad.map((i) => i.title)).toEqual([]);
  });

  it('「为什么」不超过 60 字，「怎么改」不超过 70 字', () => {
    const over = allIssues().filter((i) => i.why.length > 60 || i.suggestion.length > 70);
    expect(over.map((i) => [i.ruleId, i.why.length, i.suggestion.length])).toEqual([]);
  });
});
