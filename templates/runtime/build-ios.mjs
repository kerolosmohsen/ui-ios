import {spawn, spawnSync} from 'node:child_process';
import {appendFile, mkdir, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

const iosRoot = path.resolve('ios');
const derivedData = process.env.DERIVED_DATA || path.join(process.env.RUNNER_TEMP || '/tmp', 'ui-ios-derived');
const evidence = path.resolve('ui-ios-runtime/runner-evidence');
await mkdir(evidence, {recursive: true});
const iosEntries = await readdir(iosRoot, {withFileTypes: true});
const workspace = iosEntries.find((entry) => entry.isDirectory() && entry.name.endsWith('.xcworkspace'))?.name;
const project = iosEntries.find((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'))?.name;
const native = workspace ? ['-workspace', path.join(iosRoot, workspace)] : project ? ['-project', path.join(iosRoot, project)] : null;
if (!native) throw new Error('No .xcworkspace or .xcodeproj was found at ios/.');

const listing = spawnSync('xcodebuild', [...native, '-list', '-json'], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
if (listing.status !== 0) throw new Error(`xcodebuild -list failed:\n${(listing.stderr || listing.stdout).split(/\r?\n/).slice(-100).join('\n')}`);
let schemes = [];
try {
  const parsed = JSON.parse(listing.stdout);
  schemes = parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
} catch {
  throw new Error('Could not parse xcodebuild -list -json output.');
}
if (!schemes.length) throw new Error('Xcode did not report any build schemes for this project.');
let packageName = 'MyApp';
try { packageName = JSON.parse(await readFile('package.json', 'utf8')).name?.split('/').pop() || packageName; }
catch { /* Fall back to the native project name. */ }
const nativeName = path.basename(workspace || project).replace(/\.(xcworkspace|xcodeproj)$/, '');
const scheme = schemes.find((value) => value === nativeName) || schemes.find((value) => value.toLowerCase() === packageName.toLowerCase()) || schemes[0];
console.error(`Building Xcode scheme "${scheme}" using ${workspace ? 'workspace' : 'project'} ${nativeName}.`);

const args = [
  ...native,
  '-scheme', scheme,
  '-configuration', 'Debug',
  '-sdk', 'iphonesimulator',
  '-destination', `id=${process.env.SIMULATOR_UDID}`,
  '-derivedDataPath', derivedData,
  'COMPILER_INDEX_STORE_ENABLE=NO',
  'CODE_SIGNING_ALLOWED=NO',
  'build',
];
const logPath = path.join(evidence, 'xcodebuild.log');
await appendFile(logPath, `\n--- ${new Date().toISOString()} xcodebuild ${args.join(' ')} ---\n`);
const tail = [];
let pending = '';
const child = spawn('xcodebuild', args, {env: {...process.env, FORCE_BUNDLING: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    tail.push(...lines);
    if (tail.length > 100) tail.splice(0, tail.length - 100);
    void appendFile(logPath, chunk);
  });
}
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code) => resolve(code ?? 1));
});
if (pending) tail.push(pending);
if (exitCode !== 0) throw new Error(`xcodebuild failed (exit ${exitCode}). Last 100 lines:\n${tail.slice(-100).join('\n')}`);
console.error('xcodebuild completed successfully.');

const products = path.join(derivedData, 'Build', 'Products', 'Debug-iphonesimulator');
async function findApps(directory) {
  const found = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name.endsWith('.app')) found.push(item);
    else if (entry.isDirectory()) found.push(...await findApps(item));
  }
  return found;
}
const apps = (await findApps(products)).filter((app) => !app.includes('.appex/') && !app.endsWith('.xctest'));
if (!apps.length) throw new Error(`Build succeeded but no .app bundle was found in ${products}.`);
const appPath = apps.find((app) => path.basename(app, '.app').toLowerCase() === scheme.toLowerCase()) || apps[0];
const plist = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', path.join(appPath, 'Info.plist')], {encoding: 'utf8'});
if (plist.status !== 0 || !plist.stdout.trim()) throw new Error(`Could not read CFBundleIdentifier from ${appPath}.`);
console.error(`Built ${path.basename(appPath)} (${plist.stdout.trim()}).`);
console.log(`app_path=${appPath}`);
console.log(`bundle_id=${plist.stdout.trim()}`);
