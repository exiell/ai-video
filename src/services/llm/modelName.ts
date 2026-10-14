import type { ModelProfile } from '../../types/model';
import { useSettings } from '../../store/settings';

/**
 * 模型名解析 —— **全站唯一的一处**
 *
 * ===========================================================================
 * 为什么必须只有一处
 * ===========================================================================
 * 这里曾经出过一个真实的线上 bug：
 * 设置页的「测试连接」走的是 `profile.model`（真实模型名，如 deepseek-flash），
 * 而生成时走的是 `profile.name`（界面显示名，如 "DeepSeek Chat"）。
 * 结果是一条诡异的症状——**测试连接通过，一生成就报错**。
 *
 * 根本原因不是打错字，而是**同一个东西在两个地方各算了一遍**。
 * 只要还有两处，就还会有下一次不一致。所以合并到这里。
 *
 * 另外：厂商会下架旧模型、上架新模型。用户可以在设置页覆盖模型名，
 * 留空则用档案里的默认值。
 */

/** 该档案这次调用实际要用的模型名 */
export function resolveModelName(profile: ModelProfile): string {
  const override = useSettings.getState().modelOverrides[profile.id];
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return profile.model ?? profile.name;
}

/** 是不是用户手动覆盖过的（界面上要提示这一点） */
export function isModelOverridden(profileId: string): boolean {
  const override = useSettings.getState().modelOverrides[profileId];
  return typeof override === 'string' && override.trim().length > 0;
}
