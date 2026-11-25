// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { makeEmptyProject, useAppStore } from '../src/store/app';
import { StoryboardPage } from '../src/pages/StoryboardPage';
import { HomePage } from '../src/pages/HomePage';
import { GuidePage } from '../src/pages/GuidePage';
import { sampleProject } from '../src/data/samples/sampleProject';
import type { Shot } from '../src/types/model';

function renderWithRoute(
  node: React.ReactElement,
  initialEntry = '/storyboard?shot=shot-ui-1',
): { html: string; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter initialEntries={[initialEntry]}>{node}</MemoryRouter>);
  });
  const html = container.innerHTML;
  return {
    html,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function makeTestShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-ui-1',
    number: 1,
    duration: 5,
    shotSize: 'wide',
    cameraPosition: '平视居中',
    cameraMove: 'static',
    startState: '开场画面',
    action: '主体变化',
    endState: '定格收尾',
    dialogue: '一段解说旁白',
    sound: '轻柔配乐',
    mood: '清晰',
    transition: '硬切',
    sceneId: '',
    characterIds: [],
    variantIds: [],
    activeLockIds: [],
    offscreenCharacters: [],
    sourceSceneId: '',
    ...overrides,
  };
}

describe('多模式界面自适应渲染', () => {
  beforeEach(() => {
    useAppStore.getState().setProject(null);
  });

  it('科普无实景模式（默认无主持人）：分镜、主页、故事页均不显示角色与物理场景信息', () => {
    const project = makeEmptyProject('量子科普', {
      videoMode: 'explainer',
      enableVirtualHost: false,
    });
    project.story.body = '为什么量子纠缠不能超光速通信？';
    project.visualAssets = [
      {
        id: 'va-1',
        category: 'visual_motif',
        name: '纠缠光子对',
        tag: '@quantum_pair',
        visualPrompt: 'two glowing flat-vector spheres',
        referenceImageUrls: [],
        isImmutableAnchor: true,
      },
    ];
    project.shots = [
      makeTestShot({
        renderEngine: 'ai_ref_to_video',
        narrationText: '想象地球和火星上各有一只装满手套的盒子',
        narrationTimeRangeSec: [0, 5],
        visualMetaphor: '两只跨星球的发光手套盒对比',
        onScreenLabels: ['无超光速信号'],
        referencedAssetTags: ['@quantum_pair'],
      }),
    ];
    useAppStore.getState().setProject(project);

    const sb = renderWithRoute(<StoryboardPage />, '/storyboard?shot=shot-ui-1');
    expect(sb.html).not.toContain('出镜角色');
    expect(sb.html).not.toContain('画外人物');
    expect(sb.html).not.toContain('锁角色');
    expect(sb.html).not.toContain('全部角色形象图');
    expect(sb.html).not.toContain('全部场景参考板');
    expect(sb.html).not.toContain('未指定场景');
    expect(sb.html).toContain('科普节拍与视觉隐喻');
    expect(sb.html).toContain('引用视觉母题');
    expect(sb.html).toContain('纠缠光子对');
    expect(sb.html).toContain('全局风格预设铁律');
    sb.unmount();

    const home = renderWithRoute(<HomePage />, '/');
    expect(home.html).not.toContain('角色形象图');
    expect(home.html).not.toContain('场景参考板');
    expect(home.html).not.toContain('未指定场景');
    expect(home.html).toContain('风格/视觉母题');
    expect(home.html).toContain('科普解说');
    home.unmount();

    const guide = renderWithRoute(<GuidePage />, '/guide');
    expect(guide.html).not.toContain('主要人物');
    expect(guide.html).toContain('科普解说脚本（连续旁白）');
    guide.unmount();
  });

  it('自然风光无角色模式：分镜与主页隐藏角色项，展示视觉圣经与宏观环境', () => {
    const project = makeEmptyProject('阿尔卑斯晨雾', { videoMode: 'scenic' });
    project.story.body = '清晨阿尔卑斯山谷，露珠水滴从松针滑落。';
    project.shots = [makeTestShot()];
    useAppStore.getState().setProject(project);

    const sb = renderWithRoute(<StoryboardPage />, '/storyboard?shot=shot-ui-1');
    expect(sb.html).not.toContain('出镜角色');
    expect(sb.html).not.toContain('画外人物');
    expect(sb.html).not.toContain('锁角色');
    expect(sb.html).not.toContain('全部角色形象图');
    expect(sb.html).toContain('全部宏观环境板');
    expect(sb.html).toContain('环境与风格标签');
    expect(sb.html).toContain('全局视觉圣经约束');
    expect(sb.html).toContain('① 首帧（锚定环境）');
    sb.unmount();

    const home = renderWithRoute(<HomePage />, '/');
    expect(home.html).not.toContain('角色形象图');
    expect(home.html).toContain('视觉圣经/锚点');
    expect(home.html).toContain('宏观环境板');
    home.unmount();
  });

  it('科普开启虚拟讲解员时：分镜显示虚拟讲解员入口，仍隐藏物理场景选择器', () => {
    const project = makeEmptyProject('带主持人的科普', {
      videoMode: 'explainer',
      enableVirtualHost: true,
    });
    project.shots = [makeTestShot()];
    useAppStore.getState().setProject(project);

    const sb = renderWithRoute(<StoryboardPage />, '/storyboard?shot=shot-ui-1');
    expect(sb.html).toContain('虚拟讲解员');
    expect(sb.html).not.toContain('未指定场景');
    expect(sb.html).not.toContain('全部场景参考板');
    sb.unmount();
  });

  it('剧情短剧模式：完整保留原有角色与场景界面（向后兼容）', () => {
    useAppStore.getState().setProject(structuredClone(sampleProject));
    const firstId = sampleProject.shots[0]!.id;

    const sb = renderWithRoute(<StoryboardPage />, `/storyboard?shot=${firstId}`);
    expect(sb.html).toContain('出镜角色');
    expect(sb.html).toContain('画外人物');
    expect(sb.html).toContain('全部角色形象图');
    expect(sb.html).toContain('全部场景参考板');
    sb.unmount();
  });
});
