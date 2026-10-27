import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';

function readPackage() {
  try { return JSON.parse(readFileSync('package.json', 'utf8')); }
  catch { throw new Error('Could not read package.json from the uploaded project snapshot.'); }
}

function dependencies(pkg) {
  return Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies);
}

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {stdio: 'inherit', env: process.env, shell: false});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 'unknown'}. See the command output above for the project-specific cause.`);
}

function nativeProject() {
  if (!existsSync('ios')) return null;
  const entries = readdirSync('ios');
  const workspace = entries.find((entry) => entry.endsWith('.xcworkspace'));
  const project = entries.find((entry) => entry.endsWith('.xcodeproj'));
  return workspace || project ? {workspace, project} : null;
}

const pkg = readPackage();
const deps = dependencies(pkg);
if (!deps['react-native']) throw new Error('The project snapshot has no react-native dependency in package.json.');

let native = nativeProject();
if (!native) {
  if (existsSync('ios')) throw new Error('ios/ exists but contains no .xcworkspace or .xcodeproj. Regenerate the native project or restore the Xcode project files.');
  if (!deps.expo) throw new Error('This bare React Native project has no ios/ directory. Add the iOS native project on macOS before starting the preview.');

  console.log('Expo project detected without ios/; checking that its config enables iOS before native generation.');
  const config = spawnSync('npx', ['expo', 'config', '--json'], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (config.status !== 0) {
    throw new Error('Expo could not resolve the app config. Check app.json/app.config.js, installed Expo dependencies, and required environment variables.');
  }
  let expoConfig;
  try { expoConfig = JSON.parse(config.stdout); }
  catch { throw new Error('Expo returned invalid JSON while checking the app config; no native project was generated.'); }
  if (Array.isArray(expoConfig.platforms) && !expoConfig.platforms.includes('ios')) {
    throw new Error(`Expo config platforms is [${expoConfig.platforms.join(', ')}], which disables iOS. Add "ios" to expo.platforms before starting the simulator.`);
  }

  run('npx', ['expo', 'prebuild', '--platform', 'ios', '--no-install']);
  native = nativeProject();
  if (!native) throw new Error('Expo prebuild completed without creating an iOS .xcworkspace or .xcodeproj.');
}

if (!existsSync(path.join('ios', 'Podfile'))) {
  console.warn('No ios/Podfile was found. CocoaPods will be skipped; the Xcode project must already contain all native dependencies.');
}

const summary = [
  `React Native: ${deps['react-native']}`,
  `Expo: ${deps.expo ?? 'not used'}`,
  `iOS project: ios/${native.workspace || native.project}`,
  `Podfile: ${existsSync(path.join('ios', 'Podfile')) ? 'present' : 'not present'}`,
];
for (const item of summary) console.log(`PASS ${item}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const {appendFile} = await import('node:fs/promises');
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### App project preflight\n\n${summary.map((item) => `- ${item}`).join('\n')}\n`);
}
