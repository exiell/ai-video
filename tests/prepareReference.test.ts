import { describe, expect, it, vi } from 'vitest';
import {
  prepareReference,
  type DecodedImage,
  type EncodeRequest,
  type EncodedImage,
  type PrepareDeps,
} from '../src/services/image/prepare';

/**
 * 参考图确定性预处理（P2-c）
 *
 * ===========================================================================
 * 为什么用假的 decode/encode
 * ===========================================================================
 * Node 测试环境没有 canvas，真实解码/编码不可用；而这一层要验证的是
 * **确定性算法**（裁切坐标、宽高比、轮次、类型选择、失败回退），不是浏览器的
 * 图片编解码质量。所以注入假 deps：
 *  - decode 按 dataUrl 查一个尺寸/alpha 表（可模拟 EXIF 纠正后的尺寸）；
 *  - encode 记录它收到的裁切/目标尺寸，并按预设序列返回字节数（模拟超限）。
 */

interface FakeSource {
  width: number;
  height: number;
  hasAlpha: boolean;
}

const registry = new Map<string, FakeSource>();
let sequence = 0;

/** 造一个可注册的假 dataUrl（字节长度够大时可模拟「原图本身超字节上限」） */
function fakeDataUrl(meta: FakeSource, padding = 0): string {
  const payload = 'A'.repeat(Math.max(4, padding));
  const url = `data:image/png;base64,${payload}${sequence += 1}`;
  registry.set(url, meta);
  return url;
}

function makeDeps(options: { sizes?: number[]; encodeError?: boolean } = {}) {
  const encodes: EncodeRequest[] = [];
  const decode = vi.fn(async (dataUrl: string): Promise<DecodedImage> => {
    const found = registry.get(dataUrl);
    if (!found) throw new Error('decode failed');
    return { ...found, source: found };
  });
  const encode = vi.fn(async (request: EncodeRequest): Promise<EncodedImage> => {
    encodes.push(request);
    if (options.encodeError) throw new Error('encode failed');
    const index = encodes.length - 1;
    const byteSize = options.sizes?.[index] ?? 100_000;
    return {
      dataUrl: `data:image/${request.type === 'image/png' ? 'png' : 'jpeg'};base64,ENC${index}`,
      byteSize,
    };
  });
  const deps: PrepareDeps = { decode, encode };
  return { deps, decode, encode, encodes };
}

describe('aspect：中心裁切 + 长边上限', () => {
  it('**4000×3000 按 9:16 中心裁切**，长边 ≤ 2048，宽高比正确', async () => {
    const source = fakeDataUrl({ width: 4000, height: 3000, hasAlpha: false });
    const { deps, encodes } = makeDeps({ sizes: [500_000] });

    const result = await prepareReference(
      { dataUrl: source },
      'aspect',
      { targetAspect: '9:16', maxLongEdge: 2048, deps },
    );

    expect(result.transformed).toBe(true);
    expect(encodes).toHaveLength(1);
    const call = encodes[0]!;
    // 9:16 比原图窄 → 左右中心各裁掉一部分；高度不动
    expect(call.cropHeight).toBe(3000);
    expect(call.cropWidth).toBe(1688); // round(3000 * 9/16)
    expect(call.cropX).toBe(1156); // round((4000-1688)/2)
    expect(call.cropY).toBe(0);
    // 长边缩到 2048，宽高比保持 9:16
    expect(Math.max(call.targetWidth, call.targetHeight)).toBe(2048);
    expect(call.targetWidth / call.targetHeight).toBeCloseTo(9 / 16, 2);
    expect(call.targetWidth).toBe(result.width);
    expect(call.targetHeight).toBe(result.height);
    expect(result.byteSize).toBe(500_000);
  });

  it('本来就是这个画幅、尺寸也合规：**字节级不变**，不重新编码', async () => {
    const source = fakeDataUrl({ width: 1080, height: 1920, hasAlpha: false });
    const { deps, encode } = makeDeps();

    const result = await prepareReference(
      { dataUrl: source },
      'aspect',
      { targetAspect: '9:16', deps },
    );

    expect(result.transformed).toBe(false);
    expect(result.dataUrl).toBe(source);
    expect(encode).not.toHaveBeenCalled();
  });

  it('画幅比例差在 0.5% 以内不裁（避免为噪声重新编码）', async () => {
    const source = fakeDataUrl({ width: 1081, height: 1920, hasAlpha: false });
    const { deps, encode } = makeDeps();
    const result = await prepareReference({ dataUrl: source }, 'aspect', {
      targetAspect: '9:16',
      deps,
    });
    expect(result.transformed).toBe(false);
    expect(encode).not.toHaveBeenCalled();
  });
});

describe('fit-bytes：3 轮内压到上限；仍超则回退原图', () => {
  it('**超限图在第 3 轮压到上限以下**（质量 0.85→0.7→0.6 + 边长 0.9 递缩）', async () => {
    // padding 让原图字节数（≈3000）超过 maxBytes=1000，确保进入压缩流程
    const source = fakeDataUrl({ width: 2000, height: 2000, hasAlpha: false }, 4000);
    const { deps, encodes } = makeDeps({ sizes: [5000, 3000, 900] });

    const result = await prepareReference(
      { dataUrl: source },
      'fit-bytes',
      { maxBytesPerImage: 1000, deps },
    );

    expect(result.transformed).toBe(true);
    expect(result.byteSize).toBe(900);
    expect(encodes).toHaveLength(3);
    // 质量逐轮下降，长边按 0.9 递缩
    expect(encodes.map((call) => call.quality)).toEqual([0.85, 0.7, 0.6]);
    expect(encodes[0]!.targetWidth).toBe(2000);
    expect(encodes[1]!.targetWidth).toBe(1843); // round(2048*0.9) 封顶
    expect(encodes[2]!.targetWidth).toBe(1659); // round(2000 * (2048*0.81/2000))
  });

  it('**3 轮后仍超限**：transformed=false + 原图 + 如实 reason', async () => {
    const source = fakeDataUrl({ width: 2000, height: 2000, hasAlpha: false }, 4000);
    const { deps, encodes } = makeDeps({ sizes: [5000, 4000, 3000] });

    const result = await prepareReference(
      { dataUrl: source },
      'fit-bytes',
      { maxBytesPerImage: 1000, deps },
    );

    expect(result.transformed).toBe(false);
    expect(result.dataUrl).toBe(source);
    expect(result.reason).toContain('3 轮');
    expect(result.reason).toContain('上限');
    expect(encodes).toHaveLength(3);
  });

  it('**未声明字节上限**：不按大小压缩（不猜）', async () => {
    const source = fakeDataUrl({ width: 4000, height: 3000, hasAlpha: false }, 4000);
    const { deps, decode, encode } = makeDeps();
    const result = await prepareReference({ dataUrl: source }, 'fit-bytes', { deps });
    expect(result.transformed).toBe(false);
    expect(result.dataUrl).toBe(source);
    expect(decode).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });

  it('本来就在字节上限内：字节级不变', async () => {
    const source = fakeDataUrl({ width: 2000, height: 2000, hasAlpha: false }, 100);
    const { deps, encode } = makeDeps();
    const result = await prepareReference({ dataUrl: source }, 'fit-bytes', {
      maxBytesPerImage: 1024 * 1024,
      deps,
    });
    expect(result.transformed).toBe(false);
    expect(result.dataUrl).toBe(source);
    expect(encode).not.toHaveBeenCalled();
  });
});

describe('编码类型：PNG 保 alpha，JPEG 不透明', () => {
  it('含 alpha → PNG（避免黑底）', async () => {
    const source = fakeDataUrl({ width: 2000, height: 2000, hasAlpha: true }, 4000);
    const { deps, encodes } = makeDeps({ sizes: [100] });
    const result = await prepareReference({ dataUrl: source }, 'fit-bytes', {
      maxBytesPerImage: 100_000,
      maxLongEdge: 512,
      deps,
    });
    expect(result.transformed).toBe(true);
    expect(encodes[0]!.type).toBe('image/png');
    expect(result.dataUrl.startsWith('data:image/png')).toBe(true);
  });

  it('不透明 → JPEG q0.85', async () => {
    const source = fakeDataUrl({ width: 2000, height: 2000, hasAlpha: false }, 4000);
    const { deps, encodes } = makeDeps({ sizes: [100] });
    const result = await prepareReference({ dataUrl: source }, 'fit-bytes', {
      maxBytesPerImage: 100_000,
      maxLongEdge: 512,
      deps,
    });
    expect(encodes[0]!.type).toBe('image/jpeg');
    expect(encodes[0]!.quality).toBe(0.85);
    expect(result.dataUrl.startsWith('data:image/jpeg')).toBe(true);
  });
});

describe('EXIF：按解码后（from-image 已纠正）的尺寸计算裁切', () => {
  it('旋转图按纠正后的 3000×4000 计算中心裁切', async () => {
    // 假 decode 模拟 createImageBitmap({imageOrientation:'from-image'}) 的结果：
    // 原始文件 4000×3000 + EXIF 旋转 90°，解码后是 3000×4000。
    const source = fakeDataUrl({ width: 3000, height: 4000, hasAlpha: false });
    const { deps, encodes } = makeDeps({ sizes: [1000] });

    const result = await prepareReference({ dataUrl: source }, 'aspect', {
      targetAspect: '9:16',
      maxLongEdge: 4096,
      deps,
    });

    // 3000×4000 比例 0.75 > 0.5625 → 左右裁，且高度按纠正后的 4000 计算
    expect(result.transformed).toBe(true);
    const call = encodes[0]!;
    expect(call.cropHeight).toBe(4000);
    expect(call.cropWidth).toBe(2250); // round(4000 * 9/16)
    expect(call.cropX).toBe(375); // round((3000-2250)/2)
  });
});

describe('passthrough 与失败回退', () => {
  it('passthrough：即使给了字节上限也**字节级不变**、不解码', async () => {
    const source = fakeDataUrl({ width: 4000, height: 3000, hasAlpha: false }, 4000);
    const { deps, decode, encode } = makeDeps();
    const result = await prepareReference({ dataUrl: source }, 'passthrough', {
      maxBytesPerImage: 100,
      deps,
    });
    expect(result.transformed).toBe(false);
    expect(result.dataUrl).toBe(source);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
    expect(decode).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });

  it('**解码失败**：transformed=false、返回原图、reason 说明已回退', async () => {
    const source = 'data:image/png;base64,NOT_REGISTERED';
    const { deps } = makeDeps();
    const result = await prepareReference({ dataUrl: source }, 'fit-bytes', {
      maxBytesPerImage: 100,
      deps,
    });
    expect(result.transformed).toBe(false);
    expect(result.dataUrl).toBe(source);
    expect(result.reason).toContain('解码失败');
    expect(result.reason).toContain('回退原图');
  });

  it('编码失败：transformed=false、返回原图、reason 说明已回退', async () => {
    const source = fakeDataUrl({ width: 2000, height: 2000, hasAlpha: false }, 4000);
    const { deps } = makeDeps({ encodeError: true });
    const result = await prepareReference({ dataUrl: source }, 'fit-bytes', {
      maxBytesPerImage: 100,
      deps,
    });
    expect(result.transformed).toBe(false);
    expect(result.dataUrl).toBe(source);
    expect(result.reason).toContain('编码失败');
  });
});
