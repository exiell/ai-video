import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 静态站点产物：可直接部署到任意静态托管（GitHub Pages / Cloudflare Pages / Vercel）
// 测试配置见 vitest.config.ts（分开以免 vite 的类型定义不认识 test 字段）
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    watch: {
      /**
       * 忽略编辑器的临时文件与 OneDrive 的同步中间产物。
       *
       * ===========================================================================
       * 为什么必须加这几条（真实踩过的坑）
       * ===========================================================================
       * 这个项目放在 OneDrive 同步目录里。写文件时 OneDrive 会在同目录下生成
       * `.SettingsPage.tsx.<pid>.<uuid>.tmpdir/SettingsPage.tsx.tmp` 这类中间产物，
       * 然后自己又去动它。Vite 的 chokidar 监视器抓到这些文件后报：
       *
       *   Error: EBUSY: resource busy or locked, watch '...tmpdir/SettingsPage.tsx.tmp'
       *
       * 结果是**开发服务器直接崩掉**——而且是在正常保存文件时崩的，
       * 看起来像代码出错，实际是文件锁。忽略它们即可，这些文件永远不该被当成源码。
       */
      ignored: ['**/.*.tmpdir/**', '**/*.tmpdir/**', '**/.*.tmp', '**/*.tmp', '**/.~*', '**/*~'],
    },
  },
});
