import type { ModelProfile } from '../../types/model';
import { MODEL_PROFILES, findProfile } from '../../data/models/profiles';
import { currentTransport, useSettings } from '../../store/settings';
import type { GenerateContext } from './generate';
import { resolveModelName } from './modelName';

/**
 * 把「用户配置」翻译成「一次生成所需的上下文」。
 *
 * 单独抽出来的原因：判断「有没有配好」的逻辑要在三处用到（向导、分镜、设定），
 * 如果每处各写一遍，迟早会出现「这里提示要配 Key、那里直接报错」的不一致。
 */

export interface GenerationReadiness {
  ready: boolean;
  profile?: ModelProfile;
  /** 没配好时给用户看的原因（人话） */
  reason?: string;
}

/** 检查 LLM 是否已经配置好 */
export function checkLlmReadiness(): GenerationReadiness {
  const { defaultLlmProfileId, proxyBaseUrl } = useSettings.getState().prefs;
  const keys = useSettings.getState().keys;

  const profile = findProfile(defaultLlmProfileId) ?? MODEL_PROFILES.find((p) => p.type === 'llm');
  if (!profile) {
    return { ready: false, reason: '没有可用的模型档案。' };
  }

  const apiKey = keys[profile.vendorId ?? '']?.trim() ?? '';
  if (!apiKey) {
    return {
      ready: false,
      profile,
      reason: `还没有填 ${profile.provider} 的 API Key。去「设置」页填上，再点一次「测试连接」确认能通。`,
    };
  }

  if (profile.corsDirect === 'unknown' && !proxyBaseUrl.trim()) {
    return {
      ready: true,
      profile,
      reason:
        '提示：你还没有在这个浏览器里实测过跨域。如果生成时报「浏览器没能发出这个请求」，' +
        '去设置页做一次跨域实测，或填上代理地址。',
    };
  }

  return { ready: true, profile };
}

/** 组装生成上下文；没有可用配置时返回可读原因 */
export function buildGenerateContext(): { ctx: GenerateContext } | { error: string } {
  const readiness = checkLlmReadiness();
  if (!readiness.ready || !readiness.profile) {
    return { error: readiness.reason ?? '模型还没配置好。' };
  }
  const profile = readiness.profile;
  const apiKey = useSettings.getState().keys[profile.vendorId ?? '']?.trim() ?? '';
  const transport = currentTransport();

  return {
    ctx: {
      profile,
      apiKey,
      model: resolveModelName(profile),
      ...(transport ? { transport } : {}),
    },
  };
}

/** 当前默认 LLM 的显示名，用于按钮文案 */
export function currentLlmName(): string {
  const { defaultLlmProfileId } = useSettings.getState().prefs;
  return findProfile(defaultLlmProfileId)?.name ?? '模型';
}
