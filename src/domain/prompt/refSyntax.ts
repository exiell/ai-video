import type { VideoModelDialect } from '../../data/models/videoDialects';
import type { CameraMove } from '../../types/model';

/**
 * 多模态参考槽位语法编译、运镜方括号映射与 API 参数剥离（Phase 1）
 *
 * 严格落实 2026 各大视频模型官方协议差异：
 * - Seedance 2.0/2.5：@Image1 / @Video1 / @Audio1 前置职责声明；严禁首尾帧与多参考混传
 * - Wan 2.7/3.0：Image 1 / Video 1 分开计数，省略 first_frame；总媒体上限 5
 * - Wan 2.6 R2V：character1 / character2
 * - Kling 3.0 Omni：@ElementName 绑定，自动检测并消解子串碰撞（如 @Zhang 与 @ZhangSan）
 * - MiniMax Hailuo 2.3/02：15 个官方方括号运镜指令（单括号最多 3 个组合）
 * - 正文参数剥离：移除 1080p / 4K / 16:9 / 8s 等应由 API 参数控制的文本
 */

export interface ReferenceMediaItem {
  kind: 'image' | 'video' | 'audio';
  /** 角色/资产名称（供 Kling @ElementName 或自然语言声明使用） */
  name: string;
  /** 职责：首帧 / 尾帧 / 角色外观 / 环境 / 音色等 */
  role: 'first_frame' | 'last_frame' | 'character' | 'scene' | 'prop' | 'audio_voice' | 'style';
  /** 可选自定义说明，例如「仅锁定人物外观与服装，不锁定构图」 */
  roleHint?: string;
}

export interface CompiledReferenceSyntax {
  ok: boolean;
  prefix: string;
  tokens: string[];
  errors: string[];
  warnings: string[];
  /** 若触发了时长硬锁（如 Veo 3.1 带参考图锁 8s、Hailuo 1080p 锁 6s）则给出锁定值 */
  lockedDurationSec?: number;
}

/** MiniMax Hailuo 15 个官方标准方括号运镜指令 */
export const MINIMAX_OFFICIAL_CAMERA_COMMANDS = [
  'Truck left',
  'Truck right',
  'Pan left',
  'Pan right',
  'Push in',
  'Pull out',
  'Pedestal up',
  'Pedestal down',
  'Tilt up',
  'Tilt down',
  'Zoom in',
  'Zoom out',
  'Shake',
  'Tracking shot',
  'Static shot',
] as const;

export type MiniMaxCameraCommand = (typeof MINIMAX_OFFICIAL_CAMERA_COMMANDS)[number];

const CAMERA_MOVE_TO_MINIMAX: Record<CameraMove, MiniMaxCameraCommand> = {
  static: 'Static shot',
  'push-in': 'Push in',
  'pull-out': 'Pull out',
  'pan-left': 'Pan left',
  'pan-right': 'Pan right',
  'tilt-up': 'Tilt up',
  'tilt-down': 'Tilt down',
  orbit: 'Truck right',
  tracking: 'Tracking shot',
  'crane-up': 'Pedestal up',
  'crane-down': 'Pedestal down',
  handheld: 'Shake',
};

/** 编译 MiniMax 官方方括号运镜语法，单括号最多组合 3 个指令 */
export function formatMiniMaxCameraCommand(moves: readonly CameraMove[]): string {
  const unique: MiniMaxCameraCommand[] = [];
  for (const move of moves) {
    const cmd = CAMERA_MOVE_TO_MINIMAX[move];
    if (cmd && !unique.includes(cmd)) {
      unique.push(cmd);
    }
    if (unique.length >= 3) break;
  }
  if (unique.length === 0) return '[Static shot]';
  return `[${unique.join(',')}]`;
}

/** 清理不该写在提示词正文的 API 级参数（分辨率、画幅、时长） */
const PROSE_PARAM_PATTERNS: readonly RegExp[] = [
  /,?\s*\b(?:16:9|9:16|4:3|3:4|1:1|21:9)\s*(?:aspect\s*ratio)?\b/gi,
  /,?\s*--ar\s+\d+:\d+/gi,
  /,?\s*\b(?:480p|540p|720p|1080p|2k|4k|8k)\b(?:\s*resolution)?/gi,
  /,?\s*\bduration\s*:\s*\d+(?:\.\d+)?s\b/gi,
  /,?\s*\b\d+(?:\.\d+)?\s*(?:sec|secs|seconds)\s*(?:video|clip|duration)\b/gi,
];

export function stripProseParameters(prompt: string): { text: string; stripped: boolean } {
  let out = prompt;
  for (const re of PROSE_PARAM_PATTERNS) {
    out = out.replace(re, '');
  }
  out = out
    .replace(/\s*,\s*,+/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,.;]+|[\s,;]+$/g, '')
    .trim();
  return { text: out, stripped: out !== prompt.trim() };
}

function sanitizeElementIdentifier(name: string, index: number): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, '');
  return cleaned || `Element${index + 1}`;
}

/**
 * 检测并消解 Kling 3.0 Omni `@ElementName` 的子串碰撞问题：
 * 例如同时存在 `@Zhang` 和 `@ZhangSan` 时，Kling 解析器可能把 `@ZhangSan` 误拆成 `@Zhang` + `San`。
 * 自动将短碰撞名加上唯一后缀（如 `@Zhang_1`）并返回告警。
 */
export function resolveKlingElementTokens(names: readonly string[]): {
  tokens: string[];
  collisions: string[];
} {
  const baseNames = names.map((n, i) => sanitizeElementIdentifier(n, i));
  const collisions: string[] = [];
  const finalNames = [...baseNames];

  for (let i = 0; i < finalNames.length; i += 1) {
    const cur = finalNames[i]!;
    const hasSubstringConflict = finalNames.some(
      (other, j) => i !== j && (other.includes(cur) || other === cur),
    );
    if (hasSubstringConflict) {
      const renamed = `${cur}_${i + 1}`;
      collisions.push(`@${cur} 与其他元素名存在子串碰撞，已自动规范为 @${renamed}`);
      finalNames[i] = renamed;
    }
  }

  return {
    tokens: finalNames.map((n) => `@${n}`),
    collisions,
  };
}

/** 校验并编译多模态参考语法与时长硬锁 */
export function compileReferenceBindings(args: {
  dialect: VideoModelDialect;
  references: readonly ReferenceMediaItem[];
  hasFirstLastFrame?: boolean;
  resolution?: '480P' | '540P' | '720P' | '1080P' | '4K';
  durationSec?: number;
}): CompiledReferenceSyntax {
  const { dialect, references } = args;
  const errors: string[] = [];
  const warnings: string[] = [];
  const tokens: string[] = [];

  const nonFrameRefs = references.filter(
    (r) => r.role !== 'first_frame' && r.role !== 'last_frame',
  );

  // 1. Seedance 首尾帧与多参考互斥硬拦截
  if (
    dialect.mutuallyExclusiveFirstLastAndRefs &&
    args.hasFirstLastFrame &&
    nonFrameRefs.length > 0
  ) {
    errors.push(
      `${dialect.label} 禁止同时混传首尾帧（frame_images）与多参考素材（input_references），请二选一。`,
    );
  }

  // 2. 媒体数量上限校验
  const imgCount = references.filter((r) => r.kind === 'image').length;
  const vidCount = references.filter((r) => r.kind === 'video').length;
  const audCount = references.filter((r) => r.kind === 'audio').length;
  if (imgCount > dialect.maxRefs.images) {
    warnings.push(
      `${dialect.label} 最多支持 ${dialect.maxRefs.images} 张参考图，当前传入 ${imgCount} 张，超出部分将被截断。`,
    );
  }
  if (vidCount > dialect.maxRefs.videos) {
    warnings.push(`${dialect.label} 最多支持 ${dialect.maxRefs.videos} 个参考视频。`);
  }
  if (audCount > dialect.maxRefs.audios) {
    warnings.push(`${dialect.label} 最多支持 ${dialect.maxRefs.audios} 条参考音频。`);
  }

  // 3. 时长硬锁校验（Veo 3.1 带参考图/1080p/4K 锁 8s；Hailuo 1080p 锁 6s）
  let lockedDurationSec: number | undefined;
  const locks = dialect.durationLocks;
  if (locks) {
    const allowed: number[] | undefined =
      (args.resolution === '4K' && locks.on4k) ||
      (args.resolution === '1080P' && locks.on1080p) ||
      (nonFrameRefs.length > 0 && locks.onRefs) ||
      undefined;
    if (allowed && allowed.length > 0) {
      lockedDurationSec = allowed[0];
      if (args.durationSec !== undefined && !allowed.includes(args.durationSec)) {
        warnings.push(
          `${dialect.label} 在当前规格下强制锁定单镜时长为 ${allowed.join('/')} 秒（已忽略 ${args.durationSec} 秒设定）。`,
        );
      }
    }
  }

  // 4. 按方言编译槽位绑定前缀
  let prefix = '';

  if (dialect.referenceTokenStyle === 'at_typed_index' && nonFrameRefs.length > 0) {
    let iIdx = 0;
    let vIdx = 0;
    let aIdx = 0;
    const clauses: string[] = [];
    for (const item of nonFrameRefs) {
      const token =
        item.kind === 'image'
          ? `@Image${++iIdx}`
          : item.kind === 'video'
            ? `@Video${++vIdx}`
            : `@Audio${++aIdx}`;
      tokens.push(token);
      const roleDesc =
        item.roleHint ||
        (item.role === 'character'
          ? `locks ${item.name}'s appearance and outfit only, not composition`
          : item.role === 'scene'
            ? `defines the ${item.name} environment`
            : item.role === 'audio_voice'
              ? `provides voice timbre for ${item.name}`
              : `references ${item.name}`);
      clauses.push(`${token} ${roleDesc}`);
    }
    prefix = clauses.join('; ') + '.';
  } else if (dialect.referenceTokenStyle === 'space_typed_index' && nonFrameRefs.length > 0) {
    // Wan 2.7 / 3.0：Image 1 / Video 1 分开计数，省略 first_frame，总参考媒体上限 5
    const totalNonFrame = nonFrameRefs.length;
    if (totalNonFrame > 5) {
      warnings.push(`${dialect.label} 单次总参考媒体上限为 5 项，当前 ${totalNonFrame} 项。`);
    }
    let iIdx = 0;
    let vIdx = 0;
    let aIdx = 0;
    const clauses: string[] = [];
    for (const item of nonFrameRefs.slice(0, 5)) {
      const token =
        item.kind === 'image'
          ? `Image ${++iIdx}`
          : item.kind === 'video'
            ? `Video ${++vIdx}`
            : `Audio ${++aIdx}`;
      tokens.push(token);
      clauses.push(`${token} (${item.name})`);
    }
    prefix = `References: ${clauses.join(', ')}.`;
  } else if (dialect.referenceTokenStyle === 'character_index' && nonFrameRefs.length > 0) {
    // Wan 2.6 R2V：character1, character2
    const clauses: string[] = [];
    nonFrameRefs.forEach((item, idx) => {
      const token = `character${idx + 1}`;
      tokens.push(token);
      clauses.push(`${token} is ${item.name}`);
    });
    prefix = clauses.join(', ') + '.';
  } else if (dialect.referenceTokenStyle === 'at_element_name' && nonFrameRefs.length > 0) {
    // Kling 3.0 Omni：@ElementName + 子串碰撞检测
    const resolved = resolveKlingElementTokens(nonFrameRefs.map((r) => r.name));
    tokens.push(...resolved.tokens);
    warnings.push(...resolved.collisions);
    prefix = `Elements: ${resolved.tokens.join(', ')}.`;
  } else if (dialect.referenceTokenStyle === 'positional_prose' && nonFrameRefs.length > 0) {
    const clauses = nonFrameRefs.map((item, idx) => {
      const token = `Reference ${idx + 1}`;
      tokens.push(token);
      return `${token} depicts ${item.name}`;
    });
    prefix = clauses.join('; ') + '.';
  }

  return {
    ok: errors.length === 0,
    prefix,
    tokens,
    errors,
    warnings,
    ...(lockedDurationSec !== undefined ? { lockedDurationSec } : {}),
  };
}
