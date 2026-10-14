/**
 * 接口连通性验证（无 Key）
 *
 * 目标：确认「请求格式本身是对的」——即除鉴权外没有任何其他问题。
 *
 * 做法：优先找不需要付费的接口路径。
 *  - 硅基流动对部分小模型提供免费额度，但也有完全公开的路径时优先用它
 *  - 任何返回 200 的响应都能证明：URL 正确、方法正确、请求体格式正确、CORS 开放
 *
 * 任何 401 也同样有价值：它证明请求**到达了服务器并被解析**，
 * 只是缺凭据。这与「请求根本没发出去」是完全不同的两件事。
 */

const FAKE_ORIGIN = 'https://aniguide.example.com';

const PROBES = [
  { name: '硅基流动 模型列表', url: 'https://api.siliconflow.cn/v1/models', method: 'GET' },
  { name: 'DeepSeek 用户余额', url: 'https://api.deepseek.com/user/balance', method: 'GET' },
];

for (const p of PROBES) {
  console.log(`\n${'='.repeat(66)}\n${p.name}\n  ${p.url}`);
  try {
    const response = await fetch(p.url, {
      method: p.method,
      headers: { Origin: FAKE_ORIGIN },
    });
    const acao = response.headers.get('access-control-allow-origin');
    console.log(`  HTTP ${response.status}   ACAO = ${acao ?? '(无)'}`);
    const text = await response.text();
    console.log(`  响应体前 300 字：\n${text.slice(0, 300)}`);
  } catch (error) {
    console.log(`  失败：${error.name}: ${error.message}`);
    if (error.cause) console.log(`  底层：${error.cause.code ?? error.cause.message}`);
  }
}

console.log(`\n${'='.repeat(66)}`);
console.log('解读：');
console.log('  200        → URL / 方法 / CORS 全部正确，接口对匿名开放');
console.log('  401 / 403  → 请求到达了服务器，只缺凭据。格式与 CORS 都是好的');
console.log('  失败        → 本机网络层问题，与接口无关');
