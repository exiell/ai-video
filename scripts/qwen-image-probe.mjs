/**
 * 千问图像 · 模型名与端点确认（无有效 Key）
 *
 * 目的：在不消耗任何额度的前提下，确认「端点 + 模型名」这一对组合是否被服务端认可。
 *
 * 判读方法（这是本脚本的核心技巧）：
 *  - 返回 InvalidApiKey     → 端点与模型名都通过了格式校验，只是缺凭据。
 *                             这是**好结果**：说明我们的请求构造是对的。
 *  - 返回 Model.NotExist 等
 *    模型相关错误            → 端点对，但模型名不对，需要换名字。
 *  - 返回 404               → 端点是错的。
 *
 * 也就是说：用无效 Key 探测，可以把「端点错」「模型名错」「缺凭据」三种情况区分开。
 */

const KEY = 'sk-invalid-probe-key';

const ENDPOINTS = {
  sync: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  async: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
};

const MODELS = [
  'qwen-image-2.0-pro',
  'qwen-image-2.0',
  'qwen-image-3.0-pro',
  'qwen-image',
];

function judge(status, body) {
  if (body.includes('InvalidApiKey') || body.includes('Invalid API-key')) {
    return '✅ 端点与模型名均被接受（只是 Key 无效）';
  }
  if (/Model\.|model.*not.*(exist|found)|InvalidParameter.*model/i.test(body)) {
    return '⚠️ 模型名有问题，需要换名字';
  }
  if (status === 404) return '❌ 端点不存在';
  if (status === 401) return '✅ 端点可用（401 = 缺凭据）';
  return '？需要人工判断';
}

for (const [kind, url] of Object.entries(ENDPOINTS)) {
  console.log(`\n${'='.repeat(72)}\n端点类型：${kind}\n  ${url}`);

  for (const model of MODELS) {
    const isSync = kind === 'sync';
    const body = isSync
      ? {
          model,
          input: { messages: [{ role: 'user', content: [{ text: 'a red circle' }] }] },
          parameters: { size: '1328*1328', watermark: false },
        }
      : {
          model,
          input: { prompt: 'a red circle' },
          parameters: { size: '1328*1328', n: 1 },
        };

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    };
    if (!isSync) headers['X-DashScope-Async'] = 'enable';

    try {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const text = await response.text();
      const short = text.replace(/\s+/g, ' ').slice(0, 150);
      console.log(`  ${model.padEnd(22)} HTTP ${response.status}  ${judge(response.status, text)}`);
      console.log(`    ${short}`);
    } catch (error) {
      console.log(`  ${model.padEnd(22)} 请求失败：${error.message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

console.log(`\n${'='.repeat(72)}`);
console.log('用法：找到第一个判定为「端点与模型名均被接受」的组合，');
console.log('      把它写进 MODEL_PROFILES 的 model 字段。');
console.log('注意：这不能证明「有 Key 时一定能生成成功」——那需要真实 Key。');
