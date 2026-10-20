import { Info } from './bits';
import { Link } from 'react-router-dom';
import { useImage } from '../store/image';
import { useAppStore } from '../store/app';
import { findProfile, DEFAULT_REFERENCE_PROFILE_ID, DEFAULT_T2I_PROFILE_ID } from '../data/models/profiles';
import { useSettings } from '../store/settings';
import { RichText, stripRichMarks } from './bits';

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
  | 'first-frame'
  | 'action-peak'
  | 'end-frame';

const TASK_LABEL: Record<BatchTask, string> = {
  characters: '全部角色形象图',
  scenes: '全部场景参考板',
  'first-frame': '全部镜头首帧',
  'action-peak': '全部动作关键帧',
  'end-frame': '全部尾帧',
};

const TASK_HINT: Record<BatchTask, string> = {
  characters:
    '每个角色两张：先全身多视图，再头部特写（后者会拿前者当参考，保证两张图是同一个人）。',
  scenes: '每个场景一张空场景板，用来固定空间、固定元素与光线。',
  'first-frame':
    '每个镜头一张。**首帧是图生视频的输入图，必须先有它**——没有首帧就没法开始做视频。',
  'action-peak':
    '每个镜头一张，画动作最有张力的那一瞬。它决定动作的力度与节奏；只给首尾帧，模型可能把动作演得软绵绵。',
  'end-frame':
    '每个镜头一张。尾帧是下一镜首帧的接续点，也是首尾帧生视频的收尾锚点。做首尾帧视频时必须有它。',
};

export function BatchGenerateCard({ tasks }: { tasks: BatchTask[] }) {
  const batch = useImage((s) => s.batch);
  const summary = useImage((s) => s.batchSummary);
  const clearBatchSummary = useImage((s) => s.clearBatchSummary);
  const runCharacters = useImage((s) => s.generateAllCharacterSheets);
  const runScenes = useImage((s) => s.generateAllScenePlates);
  const runFrames = useImage((s) => s.generateAllFrames);

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
    'first-frame': project?.shots.length ?? 0,
    'action-peak': project?.shots.length ?? 0,
    'end-frame': project?.shots.length ?? 0,
  };

  function run(task: BatchTask) {
    if (task === 'characters') void runCharacters();
    else if (task === 'scenes') void runScenes();
    else void runFrames(task);
  }

  return (
    <div className="card">
      <h3 className="card-title">批量生成</h3>
      <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
        一次跑完，<b>按首帧 → 尾帧 → 动作关键帧的顺序</b>
        <Info label="为什么要按顺序、能不能并发">
          三帧有先后：后面的帧会自动拿前面的当构图锚点。顺序反了锚点就没了，
          三帧的机位可能对不上。
          <br />
          <br />
          另外接口有限流，并发只会换来报错，所以这里一张一张来。
          中途某一项失败不会中断整批。
        </Info>
      </p>

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
            // 原生 title 属性只收字符串，不能放 JSX —— 所以这里只去掉标记
            title={stripRichMarks(TASK_HINT[task])}
          >
            {TASK_LABEL[task]}（{counts[task]}）
          </button>
        ))}
      </div>

      <div className="hint" style={{ marginTop: 6 }}>
        每个按钮做什么
        <Info label="五个按钮分别生成什么">
          {tasks.map((task) => (
            <div key={task} style={{ marginBottom: 4 }}>
              <b>{TASK_LABEL[task]}</b>：<RichText>{TASK_HINT[task]}</RichText>
            </div>
          ))}
        </Info>
      </div>

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
