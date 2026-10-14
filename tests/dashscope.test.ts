import { describe, expect, it } from 'vitest';
import {
  buildDashScopeAsyncPayload,
  buildDashScopeHeaders,
  buildDashScopeSyncPayload,
  buildDashScopeTaskUrl,
  DASHSCOPE_DEFAULT_SIZE,
  extractDashScopeSyncImages,
  extractDashScopeTaskId,
  mapDashScopeErrorCode,
  parseDashScopeError,
  parseDashScopeTaskStatus,
  ratioToDashScopeSize,
} from '../src/services/gateway/dashscope';
import {
  buildImagePayloadFor,
  classifyError,
  flavorOf,
  testConnection,
  extractImageUrlsFor,
} from '../src/services/gateway';
import {
  DEFAULT_REFERENCE_PROFILE_ID,
  DEFAULT_T2I_PROFILE_ID,
  MODEL_PROFILES,
  findProfile,
} from '../src/data/models/profiles';

/**
 * 千问图像走的是 DashScope 原生协议，与 OpenAI 兼容协议在
 * 请求体结构、响应结构、错误结构三方面都不同。
 * 这组测试盯的就是这三处——写错任何一处，用户看到的都是一句没头没尾的报错。
 */

const qwen = findProfile('qwen-image')!;

describe('DashScope · 画幅换算', () => {
  it('按官方推荐值换算常见比例', () => {
    expect(ratioToDashScopeSize('16:9')).toBe('2688*1536');
    expect(ratioToDashScopeSize('9:16')).toBe('1536*2688');
    expect(ratioToDashScopeSize('1:1')).toBe('2048*2048');
    expect(ratioToDashScopeSize('4:3')).toBe('2368*1728');
    expect(ratioToDashScopeSize('3:4')).toBe('1728*2368');
  });

  it('全角冒号也能识别（用户从中文输入法打出来很常见）', () => {
    expect(ratioToDashScopeSize('9：16')).toBe('1536*2688');
  });

  it('不认识的比例退回默认值，而不是报错', () => {
    expect(ratioToDashScopeSize('21:9')).toBe(DASHSCOPE_DEFAULT_SIZE);
    expect(ratioToDashScopeSize('')).toBe(DASHSCOPE_DEFAULT_SIZE);
  });

  it('用的是「宽*高」像素串，不是比例字符串', () => {
    // 这是最容易写错的地方：OpenAI 兼容接口收的是 image_size: "1024x1024"，
    // DashScope 收的是 size: "2048*2048"，星号不是 x。
    const size = ratioToDashScopeSize('1:1');
    expect(size).toContain('*');
    expect(size).not.toContain('x');
  });
});

describe('DashScope · 同步请求体', () => {
  it('提示词藏在 input.messages[0].content[0].text 里', () => {
    const payload = buildDashScopeSyncPayload({ model: 'qwen-image-2.0-pro', prompt: '一只猫' });
    const messages = (payload.input as { messages: unknown[] }).messages;
    expect(messages).toHaveLength(1);
    const first = messages[0] as { role: string; content: { text: string }[] };
    expect(first.role).toBe('user');
    expect(first.content[0]?.text).toBe('一只猫');
  });

  it('默认关闭智能改写：用户写的词就该是生成用的词', () => {
    const payload = buildDashScopeSyncPayload({ model: 'm', prompt: 'p' });
    expect((payload.parameters as Record<string, unknown>).prompt_extend).toBe(false);
  });

  it('默认不加平台水印', () => {
    const payload = buildDashScopeSyncPayload({ model: 'm', prompt: 'p' });
    expect((payload.parameters as Record<string, unknown>).watermark).toBe(false);
  });

  it('负向词、张数、种子、尺寸都进 parameters，不混进正文', () => {
    const payload = buildDashScopeSyncPayload({
      model: 'm',
      prompt: '一只猫',
      negativePrompt: 'blurry, text',
      aspectRatio: '9:16',
      n: 2,
      seed: 12345,
    });
    const parameters = payload.parameters as Record<string, unknown>;
    expect(parameters.negative_prompt).toBe('blurry, text');
    expect(parameters.n).toBe(2);
    expect(parameters.seed).toBe(12345);
    expect(parameters.size).toBe('1536*2688');
    // 正文里不能出现负向词
    const text = (payload.input as { messages: { content: { text: string }[] }[] }).messages[0]!
      .content[0]!.text;
    expect(text).toBe('一只猫');
    expect(text).not.toContain('blurry');
  });

  it('未显式传入的 seed 与 n 不出现在参数里', () => {
    const parameters = buildDashScopeSyncPayload({ model: 'm', prompt: 'p' })
      .parameters as Record<string, unknown>;
    expect('seed' in parameters).toBe(false);
    expect('n' in parameters).toBe(false);
  });

  it('**没写否定提示词时传一个空格**，而不是省略（照抄官方示例的防呆写法）', () => {
    // 官方 API 文档：negative_prompt 只有 qwen-image-3.0 系列支持，
    // 而官方示例一律传单个空格 " "（既不是空字符串也不是省略）。
    // 这种写法通常意味着「该参数在旧版上不被消费，传空值反而会触发问题」。
    const empty = buildDashScopeSyncPayload({ model: 'm', prompt: 'p' })
      .parameters as Record<string, unknown>;
    expect(empty.negative_prompt).toBe(' ');

    const blank = buildDashScopeSyncPayload({ model: 'm', prompt: 'p', negativePrompt: '   ' })
      .parameters as Record<string, unknown>;
    expect(blank.negative_prompt).toBe(' ');

    const real = buildDashScopeSyncPayload({
      model: 'm',
      prompt: 'p',
      negativePrompt: 'text, watermark',
    }).parameters as Record<string, unknown>;
    expect(real.negative_prompt).toBe('text, watermark');
  });
});

describe('DashScope · 异步请求体与请求头', () => {
  it('异步用 input.prompt，且默认 n=1', () => {
    const payload = buildDashScopeAsyncPayload({ model: 'wanx', prompt: '一只猫' });
    expect((payload.input as Record<string, unknown>).prompt).toBe('一只猫');
    expect((payload.parameters as Record<string, unknown>).n).toBe(1);
  });

  it('异步必须带 X-DashScope-Async: enable，否则服务端报「不支持同步调用」', () => {
    const headers = buildDashScopeHeaders('dashscope-async', 'sk-x');
    expect(headers['X-DashScope-Async']).toBe('enable');
    expect(headers.Authorization).toBe('Bearer sk-x');
  });

  it('同步接口不带那个头', () => {
    const headers = buildDashScopeHeaders('dashscope-sync', 'sk-x');
    expect('X-DashScope-Async' in headers).toBe(false);
    expect(headers.Authorization).toBe('Bearer sk-x');
  });

  it('任务查询地址对 task_id 做转义', () => {
    expect(buildDashScopeTaskUrl('abc/def')).toBe('https://dashscope.aliyuncs.com/api/v1/tasks/abc%2Fdef');
    expect(buildDashScopeTaskUrl('abc', 'https://x.example.com/')).toBe(
      'https://x.example.com/api/v1/tasks/abc',
    );
  });
});

describe('DashScope · 响应解析', () => {
  it('从同步响应里取出图片地址（嵌套三层的结构）', () => {
    const response = {
      output: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: [{ image: 'https://dashscope-result.oss-cn.aliyuncs.com/a.png?Expires=1' }],
            },
          },
        ],
      },
    };
    expect(extractDashScopeSyncImages(response)).toEqual([
      'https://dashscope-result.oss-cn.aliyuncs.com/a.png?Expires=1',
    ]);
  });

  it('结构不对时返回空数组，不抛异常', () => {
    expect(extractDashScopeSyncImages(null)).toEqual([]);
    expect(extractDashScopeSyncImages({})).toEqual([]);
    expect(extractDashScopeSyncImages({ output: { choices: [] } })).toEqual([]);
    expect(extractDashScopeSyncImages({ output: { choices: [{ message: {} }] } })).toEqual([]);
  });

  it('从创建任务响应里取 task_id', () => {
    expect(extractDashScopeTaskId({ output: { task_id: 'abc-123', task_status: 'PENDING' } })).toBe(
      'abc-123',
    );
    expect(extractDashScopeTaskId({ output: {} })).toBeUndefined();
  });

  it('解析任务状态与结果地址', () => {
    const status = parseDashScopeTaskStatus({
      output: {
        task_id: 't',
        task_status: 'SUCCEEDED',
        results: [{ url: 'https://x/a.png', actual_prompt: '改写后的提示词' }],
      },
    });
    expect(status.status).toBe('SUCCEEDED');
    expect(status.urls).toEqual(['https://x/a.png']);
    expect(status.actualPrompt).toBe('改写后的提示词');
  });

  it('未知状态归为 UNKNOWN，不猜', () => {
    const status = parseDashScopeTaskStatus({ output: { task_status: 'SOMETHING_NEW' } });
    expect(status.status).toBe('UNKNOWN');
  });
});

describe('DashScope · 错误码翻译', () => {
  it('把顶层 code 解析出来', () => {
    const parsed = parseDashScopeError(
      '{"code":"InvalidApiKey","message":"Invalid API-key provided.","request_id":"x"}',
    );
    expect(parsed?.code).toBe('InvalidApiKey');
    expect(parsed?.message).toBe('Invalid API-key provided.');
  });

  it('OpenAI 风格的错误体不会被误判成 DashScope 错误', () => {
    expect(parseDashScopeError('{"error":{"message":"bad key"}}')).toBeUndefined();
  });

  it('非 JSON 不会崩', () => {
    expect(parseDashScopeError('<html>502</html>')).toBeUndefined();
    expect(parseDashScopeError(undefined)).toBeUndefined();
  });

  it('错误码映射到网关的错误类型', () => {
    expect(mapDashScopeErrorCode('InvalidApiKey')).toBe('auth');
    expect(mapDashScopeErrorCode('Arrearage')).toBe('quota');
    expect(mapDashScopeErrorCode('Throttling')).toBe('rate-limit');
    expect(mapDashScopeErrorCode('Throttling.RateQuota')).toBe('rate-limit');
    expect(mapDashScopeErrorCode('DataInspectionFailed')).toBe('content-policy');
    expect(mapDashScopeErrorCode('ModelNotExist')).toBe('not-found');
    expect(mapDashScopeErrorCode('没见过的码')).toBeUndefined();
  });

  it('classifyError 能把百炼的 401 翻成人话', () => {
    const info = classifyError(
      undefined,
      401,
      '{"code":"InvalidApiKey","message":"Invalid API-key provided.","request_id":"x"}',
    );
    expect(info.kind).toBe('auth');
    expect(info.advice).toContain('百炼');
    // 必须提醒地域问题——这是百炼特有的坑
    expect(info.advice).toContain('地域');
  });

  it('内容审核拦截给出的是「改提示词」，不是「重试」', () => {
    const info = classifyError(
      undefined,
      400,
      '{"code":"DataInspectionFailed","message":"Output data may contain inappropriate content."}',
    );
    expect(info.kind).toBe('content-policy');
    expect(info.advice).toContain('不是技术故障');
  });

  it('余额不足给出的是去控制台查余额', () => {
    const info = classifyError(undefined, 400, '{"code":"Arrearage","message":"欠费"}');
    expect(info.kind).toBe('quota');
    expect(info.advice).toContain('余额');
  });
});

describe('协议分发：同一份画面意图，按档案翻译成不同协议', () => {
  it('千问档案走 dashscope-sync，产出 DashScope 结构', () => {
    expect(flavorOf(qwen)).toBe('dashscope-sync');
    const payload = buildImagePayloadFor(qwen, {
      model: qwen.model!,
      prompt: '一只猫',
      aspectRatio: '9:16',
      negativePrompt: 'blurry',
    });
    expect(payload.model).toBe('qwen-image-2.0-pro');
    expect(payload.input).toBeDefined();
    expect((payload.parameters as Record<string, unknown>).size).toBe('1536*2688');
    // 不能出现 OpenAI 风格的字段
    expect('prompt' in payload).toBe(false);
    expect('image_size' in payload).toBe(false);
  });

  it('OpenAI 兼容档案仍产出原结构', () => {
    const openaiProfile = { ...qwen, apiFlavor: 'openai' as const };
    const payload = buildImagePayloadFor(openaiProfile, {
      model: 'Kwai-Kolors/Kolors',
      prompt: '一只猫',
      imageSize: '1024x1024',
      batchSize: 2,
    });
    expect(payload.prompt).toBe('一只猫');
    expect(payload.image_size).toBe('1024x1024');
    expect(payload.batch_size).toBe(2);
    expect('input' in payload).toBe(false);
  });

  it('响应解析也跟着协议走', () => {
    const dashscopeResponse = {
      output: { choices: [{ message: { content: [{ image: 'https://x/d.png' }] } }] },
    };
    const openaiResponse = { data: [{ url: 'https://x/o.png' }] };
    expect(extractImageUrlsFor(qwen, dashscopeResponse)).toEqual(['https://x/d.png']);
    expect(extractImageUrlsFor({ ...qwen, apiFlavor: 'openai' }, openaiResponse)).toEqual([
      'https://x/o.png',
    ]);
  });
});

describe('模型档案 · 千问为默认文生图', () => {
  it('默认文生图档案是千问，不是硅基流动', () => {
    expect(DEFAULT_T2I_PROFILE_ID).toBe('qwen-image');
    expect(findProfile(DEFAULT_T2I_PROFILE_ID)?.provider).toContain('百炼');
  });

  it('千问档案带齐了调用所需的显式信息', () => {
    expect(qwen.apiFlavor).toBe('dashscope-sync');
    expect(qwen.model).toBe('qwen-image-2.0-pro');
    expect(qwen.endpoint).toContain('multimodal-generation/generation');
    // 图片链接有效期必须显式声明，否则 P0.5 会只存 URL 导致 24 小时后集体裂图
    expect(qwen.imageUrlTtlHours).toBe(24);
    expect(qwen.notes).toContain('24 小时');
  });

  it('默认文生图与默认参考图档案都不是硅基流动', () => {
    // 这条原来断言的是「没有任何文生图档案指向硅基流动」——
    // 那是在硅基流动还不支持参考图、且用户明确要求「默认用千问」时立的约束。
    // 现在它作为**可选**档案存在（用户想用可以自己选），约束收窄为
    // 「默认不能是它」——默认必须是支持参考图锚定的那一个。
    const t2i = MODEL_PROFILES.filter((p) => p.type === 't2i');
    expect(t2i.length).toBeGreaterThan(0);

    const byDefault = findProfile(DEFAULT_T2I_PROFILE_ID)!;
    expect(byDefault.provider).not.toContain('SiliconFlow');
    expect(byDefault.endpoint).not.toContain('siliconflow.cn');

    const refDefault = findProfile(DEFAULT_REFERENCE_PROFILE_ID)!;
    expect(refDefault.provider).not.toContain('SiliconFlow');
  });

  it('硅基流动文生图档案即使存在，也不支持参考图（所以不会被选为参考锚定用）', () => {
    const sf = MODEL_PROFILES.find((p) => p.endpoint.includes('siliconflow.cn') && p.type === 't2i');
    if (!sf) return; // 它被移除时这条自然跳过
    expect(sf.capabilities.referenceImage).toBe(false);
    expect(sf.capabilities.maxReferenceImages).toBe(0);
  });

  it('每个标为可直连的档案都写明了证据来源', () => {
    for (const p of MODEL_PROFILES) {
      if (p.corsDirect !== 'yes') continue;
      expect(p.notes ?? '').toMatch(/实测|预检|ACAO/);
    }
  });
});

describe('连接测试 · 千问走原生协议', () => {
  it('出图成功时报告张数并提醒链接有效期', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            output: {
              choices: [{ message: { content: [{ image: 'https://x/a.png' }] } }],
            },
          }),
      }) as unknown as Response) as unknown as typeof fetch;

    const result = await testConnection(qwen, 'sk-test', undefined, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.sample).toContain('1 张图');
    expect(result.sample).toContain('24 小时');
  });

  it('请求体确实是 DashScope 结构（而不是 OpenAI 结构）', async () => {
    let captured = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = String(init.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ output: { choices: [{ message: { content: [{ image: 'https://x/a.png' }] } }] } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await testConnection(qwen, 'sk-test', undefined, fetchImpl);
    const body = JSON.parse(captured) as Record<string, unknown>;
    expect(body.model).toBe('qwen-image-2.0-pro');
    expect(body.input).toBeDefined();
    expect(body.prompt).toBeUndefined();
  });

  it('异步档案在测试连接时报告 task_id，而不是谎称已出图', async () => {
    const asyncProfile = { ...qwen, apiFlavor: 'dashscope-async' as const };
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ output: { task_id: 'task-abcdefgh', task_status: 'PENDING' } }),
      }) as unknown as Response) as unknown as typeof fetch;

    const result = await testConnection(asyncProfile, 'sk-test', undefined, fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.sample).toContain('task-abcdefgh'.slice(0, 8));
  });
});
