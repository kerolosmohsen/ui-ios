import {appendFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import process from 'node:process';

function run(command, args, {allowFailure = false} = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  if (result.error && !allowFailure) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || `${command} exited with ${result.status}`).trim();
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return {status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
}

function version(command, args) {
  return run(command, args).stdout.trim().split(/\r?\n/)[0];
}

if (process.platform !== 'darwin') throw new Error('The iOS preview build must run on a macOS GitHub Actions runner.');

const homebrew = run('brew', ['--version'], {allowFailure: true});
if (homebrew.status !== 0) throw new Error('Homebrew is missing from the GitHub macOS runner; IDB and the secure preview tunnel cannot be installed.');

const xcode = version('xcodebuild', ['-version']).replace(/\n/g, ' · ');
const developerDir = run('xcode-select', ['-p']).stdout.trim();
run('xcrun', ['--find', 'simctl']);
let git = run('git', ['--version'], {allowFailure: true});
if (git.status !== 0) {
  console.log('Git is missing; installing it on this temporary macOS runner with Homebrew.');
  run('brew', ['install', 'git']);
  git = run('git', ['--version']);
}
const gitVersion = git.stdout.trim().split(/\r?\n/)[0];

let pod = run('pod', ['--version'], {allowFailure: true});
if (pod.status !== 0) {
  console.log('CocoaPods is missing; installing it on this temporary macOS runner with Homebrew.');
  run('brew', ['install', 'cocoapods']);
  pod = run('pod', ['--version']);
}
const podVersion = pod.stdout.trim().split(/\r?\n/)[0];

const hasGemfile = existsSync('Gemfile');
let bundler = 'not needed';
if (hasGemfile) {
  let check = run('bundle', ['--version'], {allowFailure: true});
  if (check.status !== 0) {
    console.log('Bundler is missing; installing it for this temporary runner user.');
    run('gem', ['install', '--user-install', 'bundler', '--no-document']);
    const gemBin = run('ruby', ['-e', 'print File.join(Gem.user_dir, "bin")']).stdout.trim();
    process.env.PATH = `${gemBin}:${process.env.PATH}`;
    if (process.env.GITHUB_PATH) await appendFile(process.env.GITHUB_PATH, `${gemBin}\n`);
    check = run('bundle', ['--version']);
  }
  bundler = check.stdout.trim().split(/\r?\n/)[0];
}

const facts = [
  `macOS: ${version('sw_vers', ['-productVersion'])} (${process.arch})`,
  `Node.js: ${version('node', ['--version'])}`,
  `npm: ${version('npm', ['--version'])}`,
  `Xcode: ${xcode} (${developerDir})`,
  'iOS Simulator CLI: xcrun simctl available',
  `Git: ${gitVersion}`,
  `CocoaPods: ${podVersion}`,
  `Bundler: ${bundler}`,
  `Homebrew: ${homebrew.stdout.trim().split(/\r?\n/)[0]}`,
];
for (const fact of facts) console.log(`PASS ${fact}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### macOS build tools\n\n${facts.map((fact) => `- ${fact}`).join('\n')}\n`);
}
