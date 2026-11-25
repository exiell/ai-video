import type { RefObject } from 'react';
import type { Project, VideoMode } from '../../types/model';
import { GenerateBar } from '../GenerateBar';
import { BatchGenerateCard } from '../BatchGenerateCard';
import { Icon } from '../Icon';

/**
 * 分镜页顶部的 AI 生成与批量出图抽屉（从 StoryboardPage 拆出）
 */
export function StoryboardToolsDrawer({
  drawerRef,
  project,
  videoMode,
  charEnabled,
}: {
  drawerRef: RefObject<HTMLDetailsElement | null>;
  project: Project;
  videoMode: VideoMode;
  charEnabled: boolean;
}) {
  const visualAssetsCount = project.visualAssets?.length ?? 0;

  return (
    <details className="tools-drawer" ref={drawerRef}>
      <summary>
        <span className="tools-drawer-title">
          <Icon name="sparkles" size={14} className="tools-icon" />
          AI 生成与批量出图
        </span>
        <Icon name="chevron-right" size={15} className="expand-chevron tools-drawer-chevron" />
      </summary>
      <div className="tools-drawer-body">
        <div className="card">
          <h2 className="card-title">分镜生成</h2>
          <GenerateBar
            task="assets"
            label={
              videoMode === 'scenic'
                ? '① 锁定视觉圣经与宏观环境'
                : videoMode === 'explainer'
                  ? '① 锁定风格预设与视觉母题'
                  : '① 从故事里拆角色与场景'
            }
            hint={
              videoMode === 'scenic'
                ? `当前已有 ${project.scenes.length} 个宏观环境、${visualAssetsCount} 项环境锚点（无角色模式已跳过角色）。重新生成会覆盖它们。`
                : videoMode === 'explainer'
                  ? `当前已有 ${visualAssetsCount} 项视觉母题${charEnabled ? `、${project.characters.length} 个虚拟讲解员` : '（已跳过角色与物理场景）'}。重新生成会覆盖它们。`
                  : `当前已有 ${project.characters.length} 个角色、${project.scenes.length} 个场景。重新生成会覆盖它们。`
            }
          />
          <GenerateBar
            task="shots"
            label="② 生成分镜表"
            hint={
              project.story.body.trim()
                ? videoMode === 'scenic'
                  ? '会把脚本拆成自然风光镜头，并绑定视觉圣经与环境锚点。'
                  : videoMode === 'explainer'
                    ? '会把解说脚本拆成概念节拍镜头，并生成视觉隐喻与旁白时间轴。'
                    : '会把故事拆成镜头，并自动挂好场景、角色和连续性锁。'
                : '内容还是空的，先去故事页写正文或让模型起草。'
            }
          />
        </div>
        <BatchGenerateCard
          tasks={['characters', 'scenes', 'all-frames', 'first-frame', 'action-peak', 'end-frame']}
        />
      </div>
    </details>
  );
}
