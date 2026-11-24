import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const env = { ...process.env, DESKTOP_RELEASE: '1' };

function runNode(scriptRelPath, args = []) {
  execFileSync(process.execPath, [path.join(root, scriptRelPath), ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
}

runNode('node_modules/typescript/bin/tsc', ['--noEmit']);
runNode('node_modules/vite/bin/vite.js', ['build']);
runNode('scripts/build-electron.mjs', ['--release']);
