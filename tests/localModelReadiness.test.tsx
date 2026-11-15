// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ImagePanel } from '../src/components/ImagePanel';
import { BatchGenerateCard } from '../src/components/BatchGenerateCard';
import {
  imageReadiness,
  missingProfileNames,
  profileUsable,
} from '../src/components/imageReadiness';
import { useSettings } from '../src/store/settings';
import { useAppStore } from '../src/store/app';
import { sampleProject } from '../src/data/samples/sampleProject';
import {
  findProfile,
  DEFAULT_REFERENCE_PROFILE_ID,
  DEFAULT_T2I_PROFILE_ID,
} from '../src/data/models/profiles';
import { LOCAL_FLUX3_PROFILE_ID } from '../src/services/gateway/localModel';

/**
 * 本地模型就绪判定（v0.61 修复）
 *
 * 旧逻辑只看厂商 Key，本地档案（authType:'none'）被误判成「没填 Key」，
 * 出图按钮全灰，还提示去填「通义千问」。这里锁：
 *  - 纯函数：none / 有 Key / referenceImage=false 三种情形；
 *  - ImagePanel / BatchGenerateCard：本地就绪时不显示警告、按钮可用；
 *    云端无 Key 时警告文案来自实际档案名，不写死厂商。
 */

const initialPrefs = structuredClone(useSettings.getState().prefs);
const initialKeys = { ...useSettings.getState().keys };

let container: HTMLDivElement | null = null;

function render(node: React.ReactElement): HTMLDivElement {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  const el = container;
  container = null;
  return el;
}

function useLocalModel(): void {
  useSettings.setState({
    keys: {},
    prefs: {
      ...useSettings.getState().prefs,
      defaultReferenceProfileId: LOCAL_FLUX3_PROFILE_ID,
      defaultT2iProfileId: LOCAL_FLUX3_PROFILE_ID,
    },
  });
}

function useCloudProfiles(referenceId: string, t2iId: string, keys: Record<string, string>): void {
  useSettings.setState({
    keys,
    prefs: {
      ...useSettings.getState().prefs,
      defaultReferenceProfileId: referenceId,
      defaultT2iProfileId: t2iId,
    },
  });
}

function imageButton(el: HTMLElement): HTMLButtonElement {
  const button = [...el.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    (node.textContent ?? '').includes('生成角色形象图'),
  );
  expect(button).toBeTruthy();
  return button!;
}

beforeEach(() => {
  useAppStore.setState({ project: structuredClone(sampleProject), report: null });
  useSettings.setState({
    prefs: structuredClone(initialPrefs),
    keys: { ...initialKeys },
  });
});

describe('imageReadiness 纯函数', () => {
  it('本地档案 authType=none：没有 Key 也算可用', () => {
    const readiness = imageReadiness(
      {
        defaultReferenceProfileId: LOCAL_FLUX3_PROFILE_ID,
        defaultT2iProfileId: LOCAL_FLUX3_PROFILE_ID,
      },
      {},
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.missingProfiles).toEqual([]);
    expect(readiness.usesReference).toBe(true);
    expect(readiness.referenceProfile?.id).toBe(LOCAL_FLUX3_PROFILE_ID);
  });

  it('云端档案：对应厂商 Key 非空才可用', () => {
    const referenceId = DEFAULT_REFERENCE_PROFILE_ID;
    const t2iId = DEFAULT_T2I_PROFILE_ID;
    const reference = findProfile(referenceId)!;
    const t2i = findProfile(t2iId)!;

    expect(profileUsable(reference, {})).toBe(false);
    expect(
      imageReadiness(
        { defaultReferenceProfileId: referenceId, defaultT2iProfileId: t2iId },
        { [reference.vendorId!]: 'sk-test' },
      ).ready,
    ).toBe(true);
    // 两个档案同厂商（默认都是通义千问），去重后只查一个
    expect(
      imageReadiness(
        { defaultReferenceProfileId: referenceId, defaultT2iProfileId: t2iId },
        { [t2i.vendorId!]: 'sk-test' },
      ).ready,
    ).toBe(true);
  });

  it('缺 Key 时列出真实档案名，而不是写死某个厂商', () => {
    const readiness = imageReadiness(
      { defaultReferenceProfileId: 'zhipu-image', defaultT2iProfileId: 'minimax-image' },
      {},
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.missingProfiles.map((profile) => profile.id)).toEqual(['minimax-image']);
    expect(missingProfileNames(readiness)).toContain('MiniMax');
    expect(missingProfileNames(readiness)).not.toContain('通义千问');
  });

  it('参考图模型 referenceImage=false 时只算文生图模型', () => {
    const readiness = imageReadiness(
      { defaultReferenceProfileId: 'zhipu-image', defaultT2iProfileId: 'minimax-image' },
      { minimax: 'sk-test' },
    );
    expect(readiness.usesReference).toBe(false);
    expect(readiness.ready).toBe(true);

    const missingT2i = imageReadiness(
      { defaultReferenceProfileId: 'zhipu-image', defaultT2iProfileId: 'minimax-image' },
      { zhipu: 'sk-test' },
    );
    expect(missingT2i.ready).toBe(false);
    expect(missingT2i.missingProfiles.map((profile) => profile.id)).toEqual(['minimax-image']);
  });

  it('两个档案 id 都解析不到时不当作可用', () => {
    const readiness = imageReadiness(
      { defaultReferenceProfileId: 'nope-1', defaultT2iProfileId: 'nope-2' },
      {},
    );
    expect(readiness.ready).toBe(false);
  });
});

describe('ImagePanel：本地模型就绪', () => {
  const options = [{ label: '生成角色形象图', useReference: false }];

  it('选本地档案且没有任何 Key：不显示警告，按钮不 disabled', () => {
    useLocalModel();
    const el = render(
      <ImagePanel refId="char-1" target="character" label="角色形象图" options={options} />,
    );
    expect(el.textContent ?? '').not.toContain('还不能出图');
    expect(imageButton(el).disabled).toBe(false);
  });

  it('默认云端无 Key：显示警告，文案来自实际档案名', () => {
    // 换成「智谱 + MiniMax」，证明文案不是写死的「通义千问」
    useCloudProfiles('zhipu-image', 'minimax-image', {});
    const el = render(
      <ImagePanel refId="char-1" target="character" label="角色形象图" options={options} />,
    );
    const text = el.textContent ?? '';
    expect(text).toContain('还不能出图');
    expect(text).toContain('API Key');
    expect(text).toContain(findProfile('minimax-image')!.name);
    expect(text).not.toContain('通义千问');
    expect(imageButton(el).disabled).toBe(true);
  });
});

describe('BatchGenerateCard：本地模型就绪', () => {
  it('选本地档案且没有任何 Key：不显示警告，批量按钮可用', () => {
    useLocalModel();
    const el = render(<BatchGenerateCard tasks={['characters']} />);
    expect(el.textContent ?? '').not.toContain('还不能出图');
    const button = [...el.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      (node.textContent ?? '').includes('全部角色形象图'),
    );
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(false);
  });

  it('默认云端无 Key：显示警告且按钮禁用，文案含实际档案名', () => {
    // 用非千问的档案，锁「文案是动态拼的」
    useCloudProfiles('zhipu-image', 'minimax-image', {});
    const el = render(<BatchGenerateCard tasks={['characters']} />);
    const text = el.textContent ?? '';
    expect(text).toContain('还不能出图');
    expect(text).toContain(findProfile('minimax-image')!.name);
    expect(text).not.toContain('通义千问');
    const button = [...el.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      (node.textContent ?? '').includes('全部角色形象图'),
    );
    expect(button!.disabled).toBe(true);
  });
});
