import {
  findProfile,
  DEFAULT_REFERENCE_PROFILE_ID,
  DEFAULT_T2I_PROFILE_ID,
} from '../data/models/profiles';
import type { ModelProfile } from '../types/model';
import type { Prefs } from '../store/settings';

/**
 * 出图面板的「能不能点生成」判定。
 *
 * 【为什么抽出来】ImagePanel 和 BatchGenerateCard 原来各写了一遍 `hasKey`：
 * 只看厂商 Key，于是本地档案（authType: 'none'，不需要 Key）被误判成没配置，
 * 切到本地模型后按钮全灰、还提示去填「通义千问」。
 *
 * 规则：
 *  - 档案可用 = `authType === 'none'`，或该厂商 Key 非空（trim）；
 *  - 参与判断的是出图会用到的两个档案：参考图模型（支持参考图时）
 *    与文生图模型；同一个档案只算一次；
 *  - 参考图模型没有参考图能力（referenceImage=false）时只算文生图模型，
 *    和实际出图链路一致。
 *
 * 纯函数：不读 store，方便单测。
 */

export interface ImageReadiness {
  ready: boolean;
  /** 缺 Key 的档案（可直接拿 name 拼提示文案） */
  missingProfiles: ModelProfile[];
  referenceProfile: ModelProfile | null;
  t2iProfile: ModelProfile | null;
  /** 参考图模型是否参与判断（该档案支持参考图） */
  usesReference: boolean;
}

/** 这个档案是否需要 API Key（本地档案 authType 为 none，不需要） */
export function profileNeedsKey(profile: ModelProfile): boolean {
  return profile.authType !== 'none';
}

/** 这个档案当前是否可用：本地档案直接可用，云端档案看厂商 Key */
export function profileUsable(
  profile: ModelProfile,
  keys: Record<string, string | undefined>,
): boolean {
  if (!profileNeedsKey(profile)) return true;
  const vendorId = profile.vendorId ?? '';
  return vendorId.length > 0 && Boolean(keys[vendorId]?.trim());
}

export function imageReadiness(
  prefs: Pick<Prefs, 'defaultReferenceProfileId' | 'defaultT2iProfileId'>,
  keys: Record<string, string | undefined>,
): ImageReadiness {
  const referenceProfile =
    findProfile(prefs.defaultReferenceProfileId || DEFAULT_REFERENCE_PROFILE_ID) ?? null;
  const t2iProfile =
    findProfile(prefs.defaultT2iProfileId || DEFAULT_T2I_PROFILE_ID) ?? null;
  const usesReference = Boolean(referenceProfile?.capabilities.referenceImage);

  const required: ModelProfile[] = [];
  if (usesReference && referenceProfile) required.push(referenceProfile);
  if (t2iProfile && !required.some((profile) => profile.id === t2iProfile.id)) {
    required.push(t2iProfile);
  }

  const missingProfiles = required.filter((profile) => !profileUsable(profile, keys));
  return {
    // required 为空说明两个档案 id 都解析不到，不能当成可用
    ready: required.length > 0 && missingProfiles.length === 0,
    missingProfiles,
    referenceProfile,
    t2iProfile,
    usesReference,
  };
}

/** 把缺失档案拼成用户能看懂的一句（不写死任何厂商名） */
export function missingProfileNames(readiness: ImageReadiness): string {
  return readiness.missingProfiles.map((profile) => profile.name).join('、');
}
