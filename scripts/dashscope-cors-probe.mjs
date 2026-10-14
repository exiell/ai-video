/**
 * 阿里云百炼（DashScope）· 千问图像接口的跨域实测
 *
 * 为什么必须单独测：之前实测确认可直连的是 DeepSeek 与硅基流动。
 * 阿里云是另一家基础设施，它的 CORS 策略与前两家没有任何关系，
 * 不能套用结论。而这一条直接决定「千问能不能作为默认文生图模型」。
 *
 * 测法：伪造 Origin，读取响应头里的 access-control-allow-origin。
 *  - 有 ACAO  → 浏览器可以直连
 *  - 无 ACAO  → 浏览器一定连不上，必须用代理或换平台
 *
 * 同时探测「原生模式」与「OpenAI 兼容模式」两条路径，
 * 因为它们的网关策略可能不同。
 */

const FAKE_ORIGIN = 'https://aniguide.example.com';

const PROBES = [
  {
    label: '原生模式 · 模型列表（确认有哪些模型可用）',
    url: 'https://dashscope.aliyuncs.com/api/v1/models',
    method: 'GET',
  },
  {
    label: '原生模式 · 多模态生成（qwen-image 系列）',
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    method: 'POST',
  },
  {
    label: '原生模式 · 文生图提交（wanx 系列）',
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
    method: 'POST',
  },
  {
    label: '原生模式 · 任务查询',
    url: 'https://dashscope.aliyuncs.com/api/v1/tasks',
    method: 'GET',
  },
  {
    label: 'OpenAI 兼容模式 · 文生图',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations',
    method: 'POST',
  },
  {
    label: 'OpenAI 兼容模式 · 对话（对照）',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    method: 'POST',
  },
  {
    label: '国际站 · OpenAI 兼容模式 · 文生图',
    url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/images/generations',
    method: 'POST',
  },
];

function showHeaders(headers) {
  const keys = [
    'access-control-allow-origin',
    'access-control-allow-headers',
    'access-control-allow-methods',
    'access-control-max-age',
    'vary',
    'content-type',
    'server',
  ];
  const lines = [];
  for (const k of keys) {
    const v = headers.get(k);
    if (v !== null) lines.push(`      ${k}: ${v}`);
  }
  return lines.length > 0 ? lines.join('\n') : '      （无 CORS 相关响应头）';
}

for (const p of PROBES) {
  console.log(`\n${'='.repeat(70)}\n${p.label}\n  ${p.method} ${p.url}`);

  // 预检
  try {
    const pre = await fetch(p.url, {
      method: 'OPTIONS',
      headers: {
        Origin: FAKE_ORIGIN,
        'Access-Control-Request-Method': p.method,
        'Access-Control-Request-Headers': 'authorization,content-type,x-dashscope-async',
      },
    });
    const acao = pre.headers.get('access-control-allow-origin');
    console.log(`  [预检] HTTP ${pre.status}   ACAO = ${acao ?? '(无)'}`);
    console.log(showHeaders(pre.headers));
  } catch (error) {
    console.log(`  [预检] 失败：${error.name}: ${error.message}`);
    if (error.cause) console.log(`    底层：${error.cause.code ?? error.cause.message}`);
  }

  // 实际请求（不带 Key，看它怎么回）
  try {
    const response = await fetch(p.url, {
      method: p.method,
      headers: {
        Origin: FAKE_ORIGIN,
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-invalid-probe',
        'X-DashScope-Async': 'enable',
      },
      ...(p.method === 'POST'
        ? {
            body: JSON.stringify({
              model: 'qwen-image',
              input: {},
              parameters: {},
            }),
          }
        : {}),
    });
    const acao = response.headers.get('access-control-allow-origin');
    console.log(`  [实际] HTTP ${response.status}   ACAO = ${acao ?? '(无)'}`);
    const text = await response.text();
    console.log(`  响应体前 200 字：${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  } catch (error) {
    console.log(`  [实际] 失败：${error.name}: ${error.message}`);
    if (error.cause) console.log(`    底层：${error.cause.code ?? error.cause.message}`);
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log('解读：');
console.log('  · 有 ACAO + 预检放行 → 浏览器可直连，千问可以做默认文生图');
console.log('  · 无 ACAO            → 浏览器连不上。两条路：换平台，或做代理');
console.log('  · 请求失败           → 本机网络层问题，得不出 CORS 结论');
