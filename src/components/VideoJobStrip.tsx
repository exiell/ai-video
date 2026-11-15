import { useVideo } from '../store/video';
import { useAppStore } from '../store/app';
import { ACTIVE_VIDEO_JOB_STATUSES } from '../types/video';

function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function jobElapsed(job: { elapsedSeconds?: number | null; startedAt?: string; createdAt: string }): number {
  if (typeof job.elapsedSeconds === 'number' && Number.isFinite(job.elapsedSeconds)) {
    return Math.max(0, job.elapsedSeconds);
  }
  const startedAt = Date.parse(job.startedAt ?? job.createdAt);
  return Number.isFinite(startedAt) ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
}

function remainingText(elapsed: number): string {
  const remaining = Math.max(0, 12 * 60 - elapsed);
  return remaining <= 0 ? '可能快好了' : `约 ${Math.max(1, Math.ceil(remaining / 60))} 分钟`;
}

/**
 * 全局视频任务条：不浮动、不遮挡，显示当前任务进度和排队数。
 * 点击跳到对应镜头。
 */
export function VideoJobStrip({ onLocate }: { onLocate: (shotId: string) => void }) {
  const jobs = useVideo((state) => state.jobs);
  const project = useAppStore((state) => state.project);
  const active = jobs
    .filter(
      (job) =>
        ACTIVE_VIDEO_JOB_STATUSES.includes(job.status) &&
        (project === null || job.projectId === project.id),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (active.length === 0) return null;
  const current = active[0]!;
  const shot = project?.shots.find((item) => item.id === current.shotId);
  const elapsed = jobElapsed(current);
  const progress =
    typeof current.progress === 'number' && Number.isFinite(current.progress)
      ? Math.max(0, Math.min(100, Math.round(current.progress)))
      : null;

  return (
    <div className="video-job-strip" role="status" aria-live="polite">
      <span className="video-job-strip-title">
        视频任务 {active.length} 条
        {active.length > 1 ? ' · 串行排队' : ''}
      </span>
      <button
        type="button"
        className="video-job-strip-link"
        onClick={() => onLocate(current.shotId)}
        title="跳到这一镜"
      >
        {shot ? `第 ${shot.number} 镜` : '当前任务'}
        {current.status === 'queued' || current.status === 'submitted'
          ? ' · 排队中'
          : current.status === 'submitting'
            ? ' · 提交中'
            : ` · 生成中 ${formatElapsed(elapsed)} · 预计剩余 ${remainingText(elapsed)}`}
        {progress !== null ? ` · ${progress}%` : ''}
      </button>
      {progress !== null ? (
        <span
          className="video-job-strip-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-label="当前视频生成进度"
        >
          <span style={{ width: `${progress}%` }} />
        </span>
      ) : null}
    </div>
  );
}
