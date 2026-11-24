import { build } from 'vite';
import { mkdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'dist-electron');
mkdirSync(outDir, { recursive: true });

const isRelease = process.argv.includes('--release') || process.env.DESKTOP_RELEASE === '1';
const nodeExternals = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

async function buildEntry(entryRel, fileName) {
  await build({
    configFile: false,
    publicDir: false,
    mode: isRelease ? 'production' : 'development',
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: !isRelease,
      minify: isRelease ? 'esbuild' : false,
      target: 'node20',
      ssr: true,
      lib: {
        entry: path.join(root, entryRel),
        formats: ['cjs'],
        fileName: () => fileName,
      },
      rollupOptions: {
        external: nodeExternals,
      },
    },
  });
}

await buildEntry('electron/main.ts', 'main.cjs');
await buildEntry('electron/preload.ts', 'preload.cjs');

console.log(`Electron 主进程与预加载脚本编译完成（${isRelease ? 'release' : 'dev'}）→ dist-electron/`);
