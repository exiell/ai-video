import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../store/app';
import { useSettings } from '../store/settings';
import {
  buildCharacterSheetPrompt,
  buildFramePrompt,
  buildScenePlatePrompt,
  type ImagePromptInput,
} from '../domain/image/prompts';
import type { PanelTarget, GenerateOption } from './ImagePanel';
import { RichText } from './bits';

/**
 * 看图出图的提示词（v0.43）
 *
 * ===========================================================================
 * 为什么必须能看见
 * ===========================================================================
 * 这个工具只接了 8 家厂商。用户完全可能想用别的模型出图——
 * 或者只是想知道「它到底会把我这些话变成什么英文」。
 *
 * 原来提示词在生成时算完就进了请求体，**界面上从来不显示、导出里也没有**。
 * 结果是：不接那 8 家，这个工具的出图部分就完全用不了。
 * 而提示词本身是可以独立交付的东西——它才是这个工具真正的产出之一。
 *
 * 所以这里做两件事：
 *  1. 生成按钮旁边给一个「显示图片提示词」，能看到、能复制
 *  2. 导出包里单独一份「图片提示词.md」（见 domain/export）
 */

/** 一端可以复制的提示词 */
export interface PromptEntry {
  title: string;
  input: ImagePromptInput;
}

const FRAME_TITLE: Record<string, string> = {
  'first-frame': '首帧',
  'action-peak': '动作关键帧',
  'end-frame': '尾帧',
};

/**
 * 按「这一栏要出什么图」收集提示词。
 *
 * 同一个目标可能对应多个按钮但同一份提示词（例如首帧有「纯文生图」与
 * 「锁角色」两个按钮，提示词完全一样，只是传不传参考图的区别）——
 * 这里按 kind 去重，避免同一段话列两遍。
 */
export function collectPromptEntries(
  project: Parameters<typeof buildFramePrompt>[0] | null,
  refId: string,
  target: PanelTarget,
  options: GenerateOption[],
): PromptEntry[] {
  if (!project) return [];
  const seen = new Set<string>();
  const out: PromptEntry[] = [];

  for (const option of options) {
    if (target === 'character') {
      const kind = option.sheetKind ?? 'turnaround';
      if (seen.has(`sheet:${kind}`)) continue;
      seen.add(`sheet:${kind}`);
      const input = buildCharacterSheetPrompt(project, refId, kind);
      if (input) out.push({ title: kind === 'face' ? '头部特写（锁脸）' : '全身多视图', input });
      continue;
    }

    if (target === 'scene') {
      if (seen.has('scene')) continue;
      seen.add('scene');
      const input = buildScenePlatePrompt(project, refId);
      if (input) out.push({ title: '场景参考板', input });
      continue;
    }

    const kind = option.frameKind ?? 'first-frame';
    if (seen.has(`frame:${kind}`)) continue;
    seen.add(`frame:${kind}`);
    const input = buildFramePrompt(project, refId, kind);
    if (input) out.push({ title: FRAME_TITLE[kind] ?? kind, input });
  }

  return out;
}

/** 把一端提示词摊成可以整段复制的纯文本 */
export function promptEntryToText(entry: PromptEntry): string {
  const lines = [`# ${entry.title}`, '', '【正向】', entry.input.positive];
  if (entry.input.negative) lines.push('', '【负向】', entry.input.negative);
  lines.push('', `【画幅】${entry.input.aspectRatio}`);
  if (entry.input.notes.length > 0) {
    lines.push('', '【逐项说明】');
    for (const note of entry.input.notes) {
      lines.push(`- ${note.label}：${note.fragment}`);
    }
  }
  return lines.join('\n');
}

export function ImagePromptView({
  refId,
  target,
  options,
}: {
  refId: string;
  target: PanelTarget;
  options: GenerateOption[];
}) {
  const project = useAppStore((s) => s.project);
  const keys = useSettings((s) => s.keys);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const entries = collectPromptEntries(project, refId, target, options);

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      // 非 https 或权限被拒时退化为选中文本
      window.prompt('复制失败，请手动复制下面的内容：', text);
    }
  }

  if (entries.length === 0) return null;

  const anyKey = Object.values(keys).some((k) => k?.trim());

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen(true)}
        title="出图前先看看它会变成什么英文。也可以复制到本工具不支持的模型里用。"
      >
        显示图片提示词
      </button>

      {/* 同样挂到 body：详见 bits.tsx 里 ConfirmDialog 的说明 */}
      {open
        ? createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label="图片提示词"
          className="confirm-backdrop"
          onClick={() => setOpen(false)}
        >
          <div
            className="confirm-card"
            style={{ width: 'min(760px, 100%)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-title">
              图片提示词（{entries.length} 段）
              <button
                type="button"
                className="btn btn-sm"
                style={{ float: 'right' }}
                onClick={() => setOpen(false)}
              >
                关闭
              </button>
            </div>

            <div className="confirm-body">
              <div className="hint" style={{ marginTop: 0 }}>
                出图时用的就是下面这些英文。<b>复制到任何模型里都能用</b>——
                本工具没接的模型也一样。
                {anyKey
                  ? ''
                  : '（你现在还没填出图 Key，直接复制去别处出图完全可行。）'}
              </div>

              {entries.map((entry) => (
                <section key={entry.title} style={{ marginTop: 18 }}>
                  <div className="field-label" style={{ marginBottom: 6 }}>
                    {entry.title}
                  </div>
                  <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void copy(entry.input.positive, `${entry.title}:pos`)}
                    >
                      {copied === `${entry.title}:pos` ? '已复制' : '复制正向'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void copy(promptEntryToText(entry), `${entry.title}:all`)}
                    >
                      {copied === `${entry.title}:all` ? '已复制' : '复制全部（含说明）'}
                    </button>
                    <span className="hint" style={{ marginTop: 0 }}>
                      画幅 {entry.input.aspectRatio}
                    </span>
                  </div>

                  <pre className="prompt-pre">{entry.input.positive}</pre>

                  {entry.input.negative ? (
                    <>
                      <div className="hint" style={{ marginTop: 8 }}>
                        负向词（单独填在「负向提示词 / 不要出现」里，不要混进正文）
                      </div>
                      <pre className="prompt-pre prompt-pre-dim">{entry.input.negative}</pre>
                    </>
                  ) : null}

                  {entry.input.notes.length > 0 ? (
                    <details className="why">
                      <summary>这段是怎么拼出来的（{entry.input.notes.length} 项）</summary>
                      <div className="why-body">
                        {entry.input.notes.map((note, i) => (
                          <div key={i} style={{ marginBottom: 6 }}>
                            <b>{note.label}</b>：<RichText>{note.reason}</RichText>
                            <div>
                              <code>{note.fragment}</code>
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </section>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )
        : null}
    </>
  );
}
