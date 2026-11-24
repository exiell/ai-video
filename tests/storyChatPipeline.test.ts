import { describe, expect, it } from 'vitest';
import {
  buildAssetsMessages,
  buildCreativeContextBlock,
  buildShotsMessages,
  buildStoryChatMessages,
  buildStoryMessages,
} from '../src/services/llm/generate';
import { SCHEMA_VERSION, type Project } from '../src/types/model';

function makeBaseProject(name = '科普：黑洞为什么吞噬光'): Project {
  const now = '2026-11-24T00:00:00.000Z';
  return {
    id: 'proj-test',
    name,
    logline: '用蹦床和弹珠讲清事件视界',
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    brief: {
      targetDuration: 45,
      aspectRatio: '16:9',
      platforms: ['jimeng'],
      styleTone: '日系清新科普动画',
      styleTags: ['anime style', 'clean cel shading'],
      negativePrompt: '',
    },
    story: {
      id: 'story-test',
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      source: 'generated',
      body: '小女孩用弹珠和蹦床演示引力井，最终引出事件视界。',
      charactersNote: '小女孩（戴红色围巾）',
      setting: '星空物理实验室',
      conflict: '弹珠滚太快能否逃出凹陷',
      ending: '光束弯折停在黑色圆环边缘',
      scenes: [{ id: 'ss-1', label: '实验室 · 夜', summary: '用蹦床演示时空弯曲' }],
    },
    shots: [],
    characters: [],
    scenes: [],
  };
}

function projectWithDialog(): Project {
  const base = makeBaseProject();
  return {
    ...base,
    creativeContext: {
      consensusSummary: '主角必须全程戴红色围巾；科普用黑板粉笔动画比喻；结尾留 2 秒悬念。',
      storyChat: [
        {
          id: 'sc-1',
          role: 'user',
          content: '想做一个 45 秒科普动漫，讲清楚黑洞为什么连光都逃不出去',
          createdAt: '2026-11-24T00:00:00.000Z',
        },
        {
          id: 'sc-2',
          role: 'assistant',
          content: '建议用「弹性蹦床 + 发光弹珠」做视觉比喻，前 3 秒直接抛出悬念。',
          createdAt: '2026-11-24T00:00:05.000Z',
        },
      ],
    },
  };
}

describe('第一批：故事多轮共创上下文贯通（Batch 1）', () => {
  it('无 creativeContext 时返回空串，不影响既有提示词形状', () => {
    const empty = makeBaseProject('普通项目');
    expect(buildCreativeContextBlock(empty)).toBe('');
  });

  it('buildCreativeContextBlock 合并创作共识与对话摘录并支持长度截断', () => {
    const project = projectWithDialog();
    const block = buildCreativeContextBlock(project);
    expect(block).toContain('主角必须全程戴红色围巾');
    expect(block).toContain('弹性蹦床 + 发光弹珠');

    const truncated = buildCreativeContextBlock(project, 40);
    expect(truncated.length).toBeLessThanOrEqual(55);
    expect(truncated).toContain('…（后续略）');
  });

  it('故事、角色场景、分镜三阶段提示词均自动注入前期对话上下文', () => {
    const project = projectWithDialog();

    const storyUser = buildStoryMessages(project)[1]!.content;
    expect(storyUser).toContain('弹性蹦床 + 发光弹珠');

    const assetsUser = buildAssetsMessages(project)[1]!.content;
    expect(assetsUser).toContain('主角必须全程戴红色围巾');
    expect(assetsUser).toContain('弹性蹦床 + 发光弹珠');

    const shotsUser = buildShotsMessages(project)[1]!.content;
    expect(shotsUser).toContain('主角必须全程戴红色围巾');
    expect(shotsUser).toContain('结尾留 2 秒悬念');
  });

  it('buildStoryChatMessages 携带项目上下文、历史多轮对话与最新用户提问', () => {
    const project = projectWithDialog();
    const messages = buildStoryChatMessages(project, '结尾能不能再加一个宇宙镜头拉远？');
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('科普');
    expect(messages[1]!.role).toBe('user');
    expect(messages[2]!.role).toBe('assistant');
    expect(messages[messages.length - 1]!.content).toBe('结尾能不能再加一个宇宙镜头拉远？');
  });
});
