import {spawnSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 2 * 1024 * 1024});
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || `${command} failed`).trim());
  return result.stdout;
}

let version = '';
try { version = String(JSON.parse(await readFile('ui-ios.config.json', 'utf8')).xcodeVersion ?? '').trim(); }
catch { /* Use the runner-selected Xcode when the app has no config. */ }
const active = run('xcodebuild', ['-version']).replace(/\r/g, '').trim();
if (!version) {
  console.error(`Using runner default ${active.replace(/\n/g, ' · ')}.`);
  run(process.execPath, ['ui-ios-runtime/prepare-macos.mjs']);
  process.exit(0);
}
if (!/^\d+(?:\.\d+)*$/.test(version)) throw new Error('ui-ios.config.json xcodeVersion must contain only a version, such as "26.2".');
if (new RegExp(`^Xcode ${version.replaceAll('.', '\\.')}($|\\s)`, 'm').test(active)) {
  console.error(`Using configured Xcode ${version}.`);
  run(process.execPath, ['ui-ios-runtime/prepare-macos.mjs']);
  process.exit(0);
}
const apps = await readdir('/Applications');
const candidate = apps.find((name) => name === `Xcode_${version}.app` || name === `Xcode-${version}.app`);
if (!candidate) {
  const installed = apps.filter((name) => /^Xcode.*\.app$/.test(name)).join(', ') || 'none';
  throw new Error(`Xcode ${version} is not installed on this macOS runner (found: ${installed}). Remove xcodeVersion from ui-ios.config.json or choose an installed version.`);
}
run('sudo', ['xcode-select', '-s', path.join('/Applications', candidate, 'Contents', 'Developer')]);
run(process.execPath, ['ui-ios-runtime/prepare-macos.mjs']);
console.error(`Selected ${run('xcodebuild', ['-version']).replace(/\r/g, '').trim().replace(/\n/g, ' · ')}.`);
