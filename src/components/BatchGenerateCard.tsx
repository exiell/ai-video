import { Link } from 'react-router-dom';
import { useImage } from '../store/image';
import { useAppStore } from '../store/app';
import { findProfile, DEFAULT_REFERENCE_PROFILE_ID, DEFAULT_T2I_PROFILE_ID } from '../data/models/profiles';
import { useSettings } from '../store/settings';
import { RichText } from './bits';

/**
 * 批量出图按钮 + 进度
 *
 * 为什么必须有批量：逐镜点按钮在 9 个镜头时还能忍，20 个镜头就受不了了。
 * 而「跑一半不知道到哪了」比慢更让人难受，所以进度条和失败计数是必需的。
 *
 * 顺序执行的取舍写在 store/image.ts 的 runBatch 里：
 * 出图接口有限流，并发只会换来 429。
 */

export type BatchTask =
  | 'characters'
  | 'scenes'
  | 'all-frames'
  | 'first-frame'
  | 'action-peak'
  | 'end-frame';

const TASK_LABEL: Record<BatchTask, string> = {
  characters: '全部角色形象图',
  scenes: '全部场景参考板',
  /*
    【v0.44】为什么把「全部三帧」放在最前面

    参考图的依赖是：
      本镜首帧   ← 上一镜尾帧（承接时）
      本镜关键帧 ← 本镜首帧
      本镜尾帧   ← 本镜首帧

    按「帧类型」分批（先全部首帧、再全部关键帧、再全部尾帧）时，
    跑第一轮的时候**所有尾帧都还不存在**，于是每一镜的首帧都悄悄丢了
    「接住上一镜」这个最强的锚点。而首帧又是另外两帧的锚点，
    误差会一路传到三帧——全部三个批次都受影响，而且不会报错。
  */
  'all-frames': '全部三帧（按镜头顺序）',
  'first-frame': '只补首帧',
  'action-peak': '只补关键帧',
  'end-frame': '只补尾帧',
};

export function BatchGenerateCard({ tasks }: { tasks: BatchTask[] }) {
  const batch = useImage((s) => s.batch);
  const summary = useImage((s) => s.batchSummary);
  const clearBatchSummary = useImage((s) => s.clearBatchSummary);
  const runCharacters = useImage((s) => s.generateAllCharacterSheets);
  const runScenes = useImage((s) => s.generateAllScenePlates);
  const runFrames = useImage((s) => s.generateAllFrames);
  const runFramesInOrder = useImage((s) => s.generateAllFramesInOrder);
  const assetCounts = useImage((s) => s.assetCounts);

  const project = useAppStore((s) => s.project);
  const prefs = useSettings((s) => s.prefs);
  const keys = useSettings((s) => s.keys);

  const imageProfile =
    findProfile(prefs.defaultReferenceProfileId || DEFAULT_REFERENCE_PROFILE_ID) ??
    findProfile(prefs.defaultT2iProfileId || DEFAULT_T2I_PROFILE_ID);
  const hasImageKey = Boolean(imageProfile && keys[imageProfile.vendorId ?? '']?.trim());

  const counts: Record<BatchTask, number> = {
    characters: project?.characters.length ?? 0,
    scenes: project?.scenes.length ?? 0,
    'all-frames': (project?.shots.length ?? 0) * 3,
    'first-frame': project?.shots.length ?? 0,
    'action-peak': project?.shots.length ?? 0,
    'end-frame': project?.shots.length ?? 0,
  };

  function run(task: BatchTask) {
    if (task === 'characters') {
      void runCharacters();
      return;
    }
    if (task === 'scenes') {
      void runScenes();
      return;
    }
    if (task === 'all-frames') {
      void runFramesInOrder();
      return;
    }

    /*
      单独补首帧时提醒一句：首帧能接住的只是**已经存在的**上一镜尾帧。
      尾帧一张都没有的话，这一轮出来的首帧之间是接不住的——
      这正是「全部三帧（按镜头顺序）」存在的理由。
    */
    if (task === 'first-frame') {
      const hasEndFrame = (assetCounts['end-frame'] ?? 0) > 0;
      const multiShot = (project?.shots.length ?? 0) > 1;
      if (multiShot && !hasEndFrame) {
        const go = window.confirm(
          '现在一张尾帧都还没有。\n\n' +
            '首帧能接住的只是「已经存在的」上一镜尾帧。直接补首帧的话，' +
            '每一镜的首帧都拿不到这个跨镜锚点，出来的画面之间会接不住——\n' +
            '而且首帧又是关键帧和尾帧的锚点，误差会一路传下去。\n\n' +
            '建议改用「全部三帧（按镜头顺序）」：它按 第1镜首帧→关键帧→尾帧、' +
            '第2镜首帧…… 的顺序跑，每一镜的尾帧都在下一镜首帧之前就绪。\n\n' +
            '仍然只补首帧吗？',
        );
        if (!go) return;
      }
    }

    void runFrames(task);
  }

  return (
    <div className="card">
      <h3 className="card-title">批量生成</h3>

      {!hasImageKey ? (
        <div className="issue warning" style={{ marginBottom: 12 }}>
          <div className="issue-title">还不能出图</div>
          <div className="issue-line">
            需要先填出图模型的 API Key。去
            <Link to="/settings"> 设置 </Link>
            页填上「通义千问」那一栏，点「测试连接」确认能通。
          </div>
        </div>
      ) : null}

      <div className="row">
        {tasks.map((task) => (
          <button
            key={task}
            type="button"
            className="btn"
            disabled={batch !== null || !hasImageKey || counts[task] === 0}
            onClick={() => run(task)}
          >
            {TASK_LABEL[task]}（{counts[task]}）
          </button>
        ))}
      </div>

      {tasks.includes('all-frames') ? (
        <div className="hint" style={{ marginTop: 8 }}>
          <RichText>
            {'三帧**按镜头顺序**出：第 1 镜首帧 → 关键帧 → 尾帧，然后第 2 镜…… 这样每一镜的尾帧都在下一镜首帧之前就绪，跨镜才接得住。后面三个「只补」按钮是返工用的：某一类帧失败时单独重跑，不用整批重来。'}
          </RichText>
        </div>
      ) : null}

      {batch ? (
        <div style={{ marginTop: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b style={{ fontSize: 13 }}>
              正在生成：{batch.done}/{batch.total}
            </b>
            <span className="hint" style={{ marginTop: 0 }}>
              正在跑，请不要关页面
            </span>
          </div>
          <div className="hint" style={{ marginTop: 2 }}>
            整批：{batch.label}
            {batch.current ? (
              <>
                <br />
                当前：<b>{batch.current}</b>
              </>
            ) : null}
          </div>
          <div
            className="batch-progress"
            style={{
              height: 6,
              background: 'var(--bg)',
              borderRadius: 3,
              overflow: 'hidden',
              border: '1px solid var(--border)',
              marginTop: 6,
            }}
          >
            <div
              className="batch-progress-fill"
              style={{
                width: `${Math.round((batch.done / Math.max(batch.total, 1)) * 100)}%`,
                height: '100%',
                background: 'var(--accent)',
                transition: 'width 0.3s',
              }}
            />
          </div>
          <div className="hint">
            批量生成可能要好几分钟。每张图生成完会立刻存到本机，中途关掉页面已生成的不会丢。
          </div>
        </div>
      ) : null}

      {summary ? (
        <div
          className={`issue ${summary.includes('失败') ? 'warning' : ''}`}
          style={{
            marginTop: 12,
            marginBottom: 0,
            borderLeftColor: summary.includes('失败') ? undefined : 'var(--ok)',
          }}
        >
          <div className="issue-line">{summary}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-sm" onClick={clearBatchSummary}>
              知道了
            </button>
            <Link className="btn btn-sm" to="/export">
              导出备份
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
