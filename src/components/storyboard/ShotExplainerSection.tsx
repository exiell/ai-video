import type { Shot } from '../../types/model';
import { Icon } from '../Icon';

/**
 * 科普解说模式的单镜节拍与视觉隐喻编辑区（从 StoryboardPage 拆出）
 */
export function ShotExplainerSection({
  shot,
  onPatch,
}: {
  shot: Shot;
  onPatch: (changes: Partial<Shot>) => void;
}) {
  return (
    <div className="shot-continuity-box" style={{ marginBottom: 12 }}>
      <div className="shot-block-label">
        <Icon name="sparkles" size={14} />
        <span>
          科普节拍与视觉隐喻
          {shot.narrationTimeRangeSec
            ? `（${shot.narrationTimeRangeSec[0]}s – ${shot.narrationTimeRangeSec[1]}s）`
            : ''}
        </span>
      </div>
      <div className="grid-2">
        <div>
          <div className="field-label">本镜旁白</div>
          <textarea
            rows={2}
            aria-label={`第 ${shot.number} 镜的科普旁白`}
            value={shot.narrationText ?? shot.dialogue}
            onChange={(e) =>
              onPatch({
                narrationText: e.target.value,
                dialogue: e.target.value,
              })
            }
            placeholder="这一节拍对应的连续解说词（20-30 词讲清 1 个核心概念）"
          />
        </div>
        <div>
          <div className="field-label">视觉隐喻转译</div>
          <textarea
            rows={2}
            aria-label={`第 ${shot.number} 镜的视觉隐喻`}
            value={shot.visualMetaphor ?? ''}
            onChange={(e) => onPatch({ visualMetaphor: e.target.value })}
            placeholder="把抽象概念变成可画出来的物理类比（如尺度缩放、对比、过程推演）"
          />
        </div>
      </div>
      <div className="grid-2" style={{ marginTop: 8 }}>
        <div>
          <div className="field-label">屏幕简短标注（用、分隔，限 3-5 词）</div>
          <input
            type="text"
            aria-label={`第 ${shot.number} 镜的屏幕标注`}
            value={(shot.onScreenLabels ?? []).join('、')}
            onChange={(e) =>
              onPatch({
                onScreenLabels: e.target.value
                  .split(/[、,，]+/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="例：量子纠缠、无法超光速传信"
          />
        </div>
        {shot.renderEngine === 'html_hyperframes' || shot.renderEngine === 'manim' ? (
          <div>
            <div className="field-label">代码渲染指令（预留）</div>
            <input
              type="text"
              aria-label={`第 ${shot.number} 镜的代码渲染指令`}
              value={shot.codeRenderSpec ?? ''}
              onChange={(e) => onPatch({ codeRenderSpec: e.target.value })}
              placeholder="供 HTML 动效或 Manim 公式动画使用的渲染说明"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
