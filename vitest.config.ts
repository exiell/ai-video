import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 默认 node 环境：绝大多数测试是纯逻辑（检查引擎、提示词、网关、导出），
    // 不需要 DOM，跑得快得多。
    //
    // 需要 localStorage / sessionStorage 的测试（见 tests/readiness.test.ts）
    // 在文件顶部用 `// @vitest-environment jsdom` 单独声明。
    // 不全局开 jsdom 的原因：它会让整套测试从约 1.5 秒变成 20 秒以上。
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
