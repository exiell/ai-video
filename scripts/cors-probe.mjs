/**
 * 跨域证据采集脚本（一次性诊断工具）
 *
 * 它做什么：从 Node 直接请求厂商接口，并把**响应头**原样打印出来，
 * 重点看有没有 `access-control-allow-origin`。
 *
 * 它能证明什么：服务端到底有没有开放 CORS。
 *  - 没有 ACAO → 浏览器一定连不上，这个结论是确定的
 *  - 有 ACAO 且回显了我们伪造的 Origin → 浏览器很可能能连上（仍需浏览器确认预检）
 *
 * 它不能证明什么：浏览器自己的预检（OPTIONS）行为、以及浏览器侧的其他策略。
 * 那部分只能在浏览器里做（见 public/cors-check.html）。
 */

const PROBES = [
  {
    name: 'DeepSeek 对话接口',
    url: 'https://api.deepseek.com/chat/completions',
    body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
  },
  {
    name: '硅基流动 对话接口',
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    body: {
      model: 'Qwen/Qwen2.5-7B-Instruct',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    },
  },
  {
    name: '硅基流动 文生图接口',
    url: 'https://api.siliconflow.cn/v1/images/generations',
    body: { model: 'Kwai-Kolors/Kolors', prompt: 'a red circle', batch_size: 1 },
  },
  {
    name: '硅基流动 模型列表（GET，最轻）',
    url: 'https://api.siliconflow.cn/v1/models',
    body: null,
  },
];

const FAKE_ORIGIN = 'https://aniguide.example.com';

function headerLines(headers) {
  const interesting = [
    'access-control-allow-origin',
    'access-control-allow-headers',
    'access-control-allow-methods',
    'access-control-expose-headers',
    'access-control-max-age',
    'vary',
    'content-type',
    'server',
  ];
  const out = [];
  for (const key of interesting) {
    const value = headers.get(key);
    if (value !== null) out.push(`      ${key}: ${value}`);
  }
  return out.length > 0 ? out.join('\n') : '      (没有返回任何 CORS 相关响应头)';
}

async function probe(p) {
  console.log(`\n${'='.repeat(68)}\n${p.name}\n  ${p.url}`);

  // ---- 1. 预检（OPTIONS） ----
  try {
    const preflight = await fetch(p.url, {
      method: 'OPTIONS',
      headers: {
        Origin: FAKE_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    const acao = preflight.headers.get('access-control-allow-origin');
    console.log(`  [预检 OPTIONS] HTTP ${preflight.status}`);
    console.log(headerLines(preflight.headers));
    console.log(
      `  → 预检结论：${acao ? `开放（ACAO = ${acao}）` : '未开放 CORS（无 ACAO）'}`,
    );
  } catch (error) {
    console.log(`  [预检 OPTIONS] 请求失败：${error.message}`);
    console.log('  → 这可能是网络层拦截，不代表服务端行为');
  }

  // ---- 2. 实际请求 ----
  try {
    const init = {
      method: p.body ? 'POST' : 'GET',
      headers: { Origin: FAKE_ORIGIN, ...(p.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(p.body ? { body: JSON.stringify(p.body) } : {}),
    };
    const response = await fetch(p.url, init);
    const acao = response.headers.get('access-control-allow-origin');
    console.log(`  [实际请求 ${init.method}] HTTP ${response.status}`);
    console.log(headerLines(response.headers));
    const text = await response.text();
    console.log(`  响应体前 160 字：${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    console.log(
      `  → 直连结论：${acao ? `响应带 ACAO（${acao}）` : '响应不带 ACAO，浏览器会拦下这次请求'}`,
    );
  } catch (error) {
    console.log(`  [实际请求] 请求失败：${error.name}: ${error.message}`);
    if (error.cause) console.log(`  底层原因：${error.cause.code ?? error.cause.message ?? error.cause}`);
    console.log('  → 这可能是本机网络层拦截，不代表服务端行为');
  }
}

console.log('跨域证据采集（从 Node 发起）');
console.log(`伪造的 Origin：${FAKE_ORIGIN}`);
console.log('注意：Node 不受浏览器 CORS 限制，但服务端是否返回 ACAO 头是客观事实。');

for (const p of PROBES) {
  await probe(p);
}

console.log(`\n${'='.repeat(68)}`);
console.log('结论解读：');
console.log('  · 无 ACAO  → 浏览器确定连不上，必须用代理或换厂商（这个结论是硬的）');
console.log('  · 有 ACAO  → 浏览器很可能能连上，但预检行为仍需在浏览器里确认');
console.log('  · 请求本身失败 → 是本机网络层拦截，无法得出任何关于 CORS 的结论');
