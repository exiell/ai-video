import { useState } from 'react';
import type { Asset, Project, Shot } from '../../types/model';
import { buildGenerateContext } from '../../services/llm/readiness';
import {
  CRITIC_VERDICT_LABEL,
  critiqueShotFrame,
  type CanonicalRefInput,
  type VisualCriticResult,
} from '../../services/vlm/critic';
import {
  groundShotMotionWithVlm,
  type MotionGrounderResult,
} from '../../services/vlm/motionGrounder';

/**
 * 分镜按需视觉质检与首帧运动接地折叠区（Phase 3）
 *
 * 严格按需点击触发（绝不自动后台扣费）：
 * 1. 看图找穿帮（VLM Critic）：把当前首帧与角色/场景主参考图发给支持视觉的大模型比对；
 * 2. 首帧运动接地（Motion Grounder）：读懂首帧实际左右构图，生成不打架的 I2V 动作提示词。
 */
export function ShotVisualQaFold({
  project,
  shot,
  shotAssets,
  gallery,
}: {
  project: Project;
  shot: Shot;
  shotAssets: Asset[];
  gallery: Record<string, Asset[]>;
}) {
  const [criticBusy, setCriticBusy] = useState(false);
  const [criticError, setCriticError] = useState<string | null>(null);
  const [criticResult, setCriticResult] = useState<VisualCriticResult | null>(null);

  const [groundBusy, setGroundBusy] = useState(false);
  const [groundNote, setGroundNote] = useState<string | null>(null);
  const [groundResult, setGroundResult] = useState<MotionGrounderResult | null>(null);
  const [copied, setCopied] = useState(false);

  const firstFrame =
    shotAssets.find((a) => a.kind === 'first-frame' && a.dataUrl) ??
    shotAssets.find((a) => a.dataUrl);

  if (!firstFrame?.dataUrl) return null;

  function collectCanonicalRefs(): CanonicalRefInput[] {
    const refs: CanonicalRefInput[] = [];
    for (const charId of shot.characterIds) {
      const char = project.characters.find((c) => c.id === charId);
      const img = (gallery[charId] ?? []).find(
        (a) => (a.kind === 'character-sheet' || a.kind === 'character-sheet-face') && a.dataUrl,
      );
      if (char && img?.dataUrl) {
        refs.push({ label: `角色「${char.name}」规范主图`, dataUrl: img.dataUrl });
      }
    }
    if (shot.sceneId) {
      const scene = project.scenes.find((s) => s.id === shot.sceneId);
      const img = (gallery[shot.sceneId] ?? []).find((a) => a.kind === 'scene-plate' && a.dataUrl);
      if (scene && img?.dataUrl) {
        refs.push({ label: `场景「${scene.name}」参考板`, dataUrl: img.dataUrl });
      }
    }
    return refs;
  }

  async function runCritic() {
    const built = buildGenerateContext();
    if ('error' in built) {
      setCriticError(built.error);
      return;
    }
    setCriticBusy(true);
    setCriticError(null);
    try {
      const res = await critiqueShotFrame({
        profile: built.ctx.profile,
        apiKey: built.ctx.apiKey,
        project,
        shot,
        candidateDataUrl: firstFrame!.dataUrl!,
        canonicalRefs: collectCanonicalRefs(),
        ...(built.ctx.transport ? { transport: built.ctx.transport } : {}),
      });
      if (!res.ok || !res.result) {
        setCriticError(res.error ?? '视觉质检未成功。');
      } else {
        setCriticResult(res.result);
      }
    } finally {
      setCriticBusy(false);
    }
  }

  async function runGrounder() {
    setGroundBusy(true);
    setGroundNote(null);
    try {
      const platform = project.brief.platforms[0] ?? 'kling';
      const built = buildGenerateContext();
      const res = await groundShotMotionWithVlm({
        ...(!('error' in built)
          ? {
              profile: built.ctx.profile,
              apiKey: built.ctx.apiKey,
              ...(built.ctx.transport ? { transport: built.ctx.transport } : {}),
            }
          : {}),
        project,
        shot,
        firstFrameDataUrl: firstFrame!.dataUrl!,
        dialectIdOrPlatform: platform,
      });
      setGroundResult(res.result);
      if (res.warning) setGroundNote(res.warning);
    } finally {
      setGroundBusy(false);
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // 忽略剪贴板受限
    }
  }

  return (
    <details className="card-fold shot-extras-fold" style={{ marginTop: 8 }}>
      <summary>
        <span>按需视觉质检与首帧运动接地（可选）</span>
        <span className="card-fold-count">
          {criticResult ? CRITIC_VERDICT_LABEL[criticResult.verdict] : '点击触发'}
        </span>
      </summary>
      <div className="shot-extras-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={criticBusy}
            onClick={() => void runCritic()}
          >
            {criticBusy ? '看图检查中…' : '看图质检（对照主参考）'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={groundBusy}
            onClick={() => void runGrounder()}
          >
            {groundBusy ? '分析首帧站位中…' : '首帧运动接地（优化 I2V 提示词）'}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            仅在手动点击时调用当前视觉大模型，不会自动后台扣费。
          </span>
        </div>

        {criticError ? (
          <div className="issue warning">
            <div className="issue-line">{criticError}</div>
          </div>
        ) : null}

        {criticResult ? (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              border: '1px solid var(--line)',
              background: 'var(--bg-elev)',
              fontSize: 13,
            }}
          >
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <b>{criticResult.summary}</b>
              <span
                className={
                  criticResult.verdict === 'pass'
                    ? 'tag tag-ok'
                    : criticResult.verdict === 'minor_fix'
                      ? 'tag tag-warning'
                      : 'tag tag-error'
                }
              >
                {CRITIC_VERDICT_LABEL[criticResult.verdict]}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              身份 {criticResult.scores.identity}/10 · 服化道 {criticResult.scores.wardrobeAndProps}/10 · 光影场景{' '}
              {criticResult.scores.lightingAndScene}/10 · 画面干净度 {criticResult.scores.artifacts}/10
            </div>
            {criticResult.issues.length > 0 ? (
              <ul style={{ margin: '4px 0 8px 18px', padding: 0 }}>
                {criticResult.issues.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            ) : null}
            {criticResult.recommendedAction ? (
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <span>建议修图指令：{criticResult.recommendedAction}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void copyText(criticResult.recommendedAction)}
                >
                  {copied ? '已复制' : '复制指令'}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {groundNote ? (
          <div className="issue info">
            <div className="issue-line">{groundNote}</div>
          </div>
        ) : null}

        {groundResult ? (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              border: '1px solid var(--line)',
              background: 'var(--bg-elev)',
              fontSize: 13,
            }}
          >
            <div style={{ marginBottom: 6 }}>
              <b>首帧构图分析：</b>
              {groundResult.spatialLayout}
            </div>
            <pre
              style={{
                margin: '0 0 8px',
                padding: 8,
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                borderRadius: 8,
                border: '1px solid var(--line)',
                background: 'var(--bg)',
              }}
            >
              {groundResult.groundedMotionPrompt}
            </pre>
            <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                {groundResult.avoidPitfalls.length > 0
                  ? `注意：${groundResult.avoidPitfalls.join('；')}`
                  : '已贴合首帧实际构图生成动作指令'}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void copyText(groundResult.groundedMotionPrompt)}
              >
                {copied ? '已复制' : '复制动作提示词'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </details>
  );
}
