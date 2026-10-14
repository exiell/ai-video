/**
 * 提供方直连核验（一次性诊断工具）
 *
 * ===========================================================================
 * 为什么必须先核验再添加
 * ===========================================================================
 * 本站是**纯前端直连**：用户的浏览器直接请求厂商接口，中间没有我们的服务器。
 * 所以「这个厂商能不能用」不取决于它的模型好不好，而取决于
 * **它的服务端有没有开放 CORS**——没开放就是一点办法都没有（除非用户自建代理）。
 *
 * 所以扩充提供方的正确顺序是：
 *   1. 用这个脚本测出客观事实（有没有 ACAO）
 *   2. 只把**测出能直连**的写进档案，并在 notes 里注明证据
 *   3. 测不出来的如实标注「未经实测」，不假装可用
 *
 * 用法：node scripts/provider-probe.mjs
 *
 * 它不能证明什么：浏览器自身的预检行为。那部分只能在浏览器里确认
 * （见 public/cors-check.html）。
 */

const FAKE_ORIGIN = 'https://aniguide.example.com';

/**
 * 候选提供方。
 *
 * 覆盖两类：对话（llm）与出图（t2i）。
 * 出图这一类的 CORS 情况普遍更差——多数厂商的出图接口是给服务端调的。
 */
const CANDIDATES = [
  // ---------------- 对话 ----------------
  {
    group: '对话模型',
    name: 'DeepSeek（现用）',
    type: 'llm',
    url: 'https://api.deepseek.com/chat/completions',
    body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
  },
  {
    group: '对话模型',
    name: '月之暗面 Moonshot / Kimi',
    type: 'llm',
    url: 'https://api.moonshot.cn/v1/chat/completions',
    // moonshot-v1 系列已于 2026-08-31 下线，当前是 kimi-k3
    body: { model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
  },
  {
    group: '对话模型',
    name: '智谱 GLM',
    type: 'llm',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    body: { model: 'glm-4-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
  },
  {
    group: '对话模型',
    name: 'MiniMax',
    type: 'llm',
    url: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
    body: { model: 'abab6.5s-chat', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
  },
  {
    group: '对话模型',
    name: '阶跃星辰 StepFun',
    type: 'llm',
    url: 'https://api.stepfun.com/v1/chat/completions',
    body: { model: 'step-1-8k', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
  },
  {
    group: '对话模型',
    name: '零一万物 01.AI',
    type: 'llm',
    url: 'https://api.lingyiwanwu.com/v1/chat/completions',
    body: { model: 'yi-lightning', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
  },
  {
    group: '对话模型',
    name: '百度文心（千帆 v2）',
    type: 'llm',
    url: 'https://qianfan.baidubce.com/v2/chat/completions',
    body: { model: 'ernie-4.0-8k', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
  },
  {
    group: '对话模型',
    name: '火山方舟 · 豆包',
    type: 'llm',
    url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    body: { model: 'doubao-pro-32k', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
  },
  {
    group: '对话模型',
    name: 'OpenAI',
    type: 'llm',
    url: 'https://api.openai.com/v1/chat/completions',
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
  },
  {
    group: '对话模型',
    name: '硅基流动（现用）',
    type: 'llm',
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    body: { model: 'Qwen/Qwen2.5-7B-Instruct', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
  },

  // ---------------- 出图 ----------------
  {
    group: '出图模型',
    name: '通义千问 DashScope 原生（现用）',
    type: 't2i',
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    body: { model: 'qwen-image-2.0', input: { messages: [{ role: 'user', content: [{ text: 'a red circle' }] }] } },
  },
  {
    group: '出图模型',
    name: '火山方舟 · 豆包 Seedream 文生图',
    type: 't2i',
    url: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    body: { model: 'doubao-seedream-3-0-t2i-250415', prompt: 'a red circle', size: '1024x1024' },
  },
  {
    group: '出图模型',
    name: '智谱 CogView',
    type: 't2i',
    url: 'https://open.bigmodel.cn/api/paas/v4/images/generations',
    body: { model: 'cogview-3-flash', prompt: 'a red circle' },
  },
  {
    group: '出图模型',
    name: '硅基流动 文生图（Kolors）',
    type: 't2i',
    url: 'https://api.siliconflow.cn/v1/images/generations',
    body: { model: 'Kwai-Kolors/Kolors', prompt: 'a red circle', batch_size: 1 },
  },
  {
    group: '出图模型',
    name: 'MiniMax 文生图',
    type: 't2i',
    url: 'https://api.minimax.chat/v1/image_generation',
    body: { model: 'image-01', prompt: 'a red circle' },
  },
  {
    group: '出图模型',
    name: 'OpenAI 图像',
    type: 't2i',
    url: 'https://api.openai.com/v1/images/generations',
    body: { model: 'gpt-image-1', prompt: 'a red circle', n: 1 },
  },
  {
    group: '出图模型',
    name: 'Stability AI',
    type: 't2i',
    url: 'https://api.stability.ai/v2beta/stable-image/generate/core',
    body: null, // multipart，只测预检
  },
];

const INTERESTING = [
  'access-control-allow-origin',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-expose-headers',
  'access-control-max-age',
  'vary',
  'content-type',
  'server',
];

function headerLines(headers) {
  const out = [];
  for (const key of INTERESTING) {
    const value = headers.get(key);
    if (value !== null) out.push(`        ${key}: ${value}`);
  }
  return out.length > 0 ? out.join('\n') : '        (无 CORS 相关响应头)';
}

/** @type {{name:string,group:string,type:string,verdict:string,evidence:string}[]} */
const results = [];

async function probe(item) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`[${item.group}] ${item.name}`);
  console.log(`  ${item.url}`);

  let verdict = '未知';
  let evidence = '';

  // ---- 预检 ----
  try {
    const preflight = await fetch(item.url, {
      method: 'OPTIONS',
      headers: {
        Origin: FAKE_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
      signal: AbortSignal.timeout(15000),
    });
    const acao = preflight.headers.get('access-control-allow-origin');
    console.log(`  [预检] HTTP ${preflight.status}`);
    console.log(headerLines(preflight.headers));
    if (acao) {
      verdict = '可直连';
      evidence = `预检 ${preflight.status} + ACAO ${acao}`;
    } else {
      verdict = '不可直连';
      evidence = `预检 ${preflight.status} 无 ACAO`;
    }
  } catch (error) {
    console.log(`  [预检] 失败：${error.name}: ${error.message}`);
    verdict = '测不出';
    evidence = `预检请求失败（${error.name}）`;
  }

  // ---- 实际请求 ----
  if (item.body) {
    try {
      const response = await fetch(item.url, {
        method: 'POST',
        headers: { Origin: FAKE_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify(item.body),
        signal: AbortSignal.timeout(20000),
      });
      const acao = response.headers.get('access-control-allow-origin');
      console.log(`  [实际 POST] HTTP ${response.status}`);
      console.log(headerLines(response.headers));
      const text = await response.text();
      console.log(`  响应前 140 字：${text.slice(0, 140).replace(/\s+/g, ' ')}`);
      if (acao) {
        // 请求真的到达了服务端（401/400 都算到达）
        verdict = '可直连';
        evidence = `POST ${response.status} + ACAO ${acao}`;
      } else if (verdict === '可直连') {
        // 预检过了但实际响应没带 ACAO，这仍然会让浏览器拦下
        evidence += `；但实际响应无 ACAO（POST ${response.status}）`;
        verdict = '存疑';
      }
    } catch (error) {
      console.log(`  [实际 POST] 失败：${error.name}: ${error.message}`);
      if (error.cause) console.log(`  底层：${error.cause.code ?? error.cause.message ?? error.cause}`);
    }
  } else {
    console.log('  [实际 POST] 跳过（该接口需要 multipart，只测预检）');
  }

  console.log(`  → 结论：${verdict}　（${evidence}）`);
  results.push({ name: item.name, group: item.group, type: item.type, verdict, evidence });
}

console.log('提供方直连核验');
console.log(`伪造 Origin：${FAKE_ORIGIN}`);
console.log('说明：Node 不受浏览器 CORS 限制，但服务端是否返回 ACAO 是客观事实。');
console.log('      401 / 400 也算「请求到达了服务端」，是有用的证据。');

for (const item of CANDIDATES) {
  await probe(item);
}

console.log(`\n${'='.repeat(70)}`);
console.log('汇总');
console.log('='.repeat(70));
const byVerdict = { 可直连: [], 存疑: [], 不可直连: [], 测不出: [] };
for (const r of results) byVerdict[r.verdict]?.push(r);

for (const [verdict, list] of Object.entries(byVerdict)) {
  if (list.length === 0) continue;
  console.log(`\n【${verdict}】${list.length} 个`);
  for (const r of list) {
    console.log(`  · [${r.type}] ${r.name}`);
    console.log(`      ${r.evidence}`);
  }
}

console.log(`
结论解读：
  · 可直连   → 可以写进档案（仍建议在浏览器里点一次「测试连接」确认）
  · 不可直连 → 浏览器一定连不上，只能靠用户自建代理
  · 测不出   → 本机网络层拦截，得不出任何关于 CORS 的结论，不要写进档案
`);
