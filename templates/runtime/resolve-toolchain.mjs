import {existsSync, readFileSync} from 'node:fs';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

const pkg = readJson('package.json');
let nodeVersion = '';
if (existsSync('.nvmrc')) {
  nodeVersion = readFileSync('.nvmrc', 'utf8').split(/\r?\n/)[0].trim().replace(/^v(?=\d)/, '');
}
if (!nodeVersion) {
  const engine = String(pkg.engines?.node ?? '').trim();
  const match = engine.match(/(?:^|[\s<>=~^|])v?(\d+)(?:\.\d+)?/);
  if (match) {
    const openRange = /^(?:>=|>|\*)/.test(engine) && !/[<|]/.test(engine);
    nodeVersion = openRange ? '24' : match[1];
  } else {
    nodeVersion = '24';
  }
}
if (!/^(?:\d+(?:\.\d+(?:\.\d+)?)?|lts\/[a-z*]+)$/.test(nodeVersion)) nodeVersion = '24';

const packageManagerSpec = String(pkg.packageManager ?? '');
let packageManager = packageManagerSpec.split('@')[0];
if (!['npm', 'yarn', 'pnpm'].includes(packageManager)) {
  if (existsSync('pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (existsSync('yarn.lock')) packageManager = 'yarn';
  else packageManager = 'npm';
}
if (packageManager === 'npm') packageManager = existsSync('package-lock.json') ? 'npm-ci' : 'npm-install';
if (packageManager === 'yarn') {
  const version = packageManagerSpec.match(/^yarn@(\d+)/)?.[1];
  const lockHeader = existsSync('yarn.lock') ? readFileSync('yarn.lock', 'utf8').slice(0, 200) : '';
  packageManager = version === '1' || lockHeader.includes('yarn lockfile v1') ? 'yarn-classic' : 'yarn';
}
console.error(`Project Node: ${nodeVersion}; package manager: ${packageManager}.`);
console.log(`node_version=${nodeVersion}`);
console.log(`package_manager=${packageManager}`);
