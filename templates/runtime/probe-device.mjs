import {spawnSync} from 'node:child_process';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareDeviceProfile, getDevicePreset, loadDeviceCatalog, readPngDimensions, strictDeviceProfileFailures} from './simulator-utils.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const preset = process.env.DEVICE_PRESET ?? '';
const udid = process.env.SIMULATOR_UDID ?? '';
const simulatorName = process.env.SIMULATOR_NAME ?? '';
const profilePath = path.resolve(process.env.DEVICE_PROFILE_PATH ?? path.join(here, 'device-profile.json'));
const screenshotPath = path.resolve(process.env.DEVICE_SCREENSHOT_PATH ?? path.join(here, 'runner-evidence', `${preset}-screen.png`));
const bundleId = 'dev.uiios.screenprobe';
const appName = 'UIOSScreenProbe.app';
const probeRoot = await import('node:fs/promises').then(({mkdtemp}) => mkdtemp(path.join(os.tmpdir(), 'ui-ios-screen-probe-')));
const appPath = path.join(probeRoot, appName);
const expected = getDevicePreset(preset, loadDeviceCatalog());

if (!/^[A-F0-9-]{36}$/i.test(udid)) throw new Error('A valid booted Simulator UDID is required for screen probing.');
if (simulatorName !== expected.simulatorNames[0]) throw new Error(`Expected ${expected.label}; selected simulator is ${simulatorName || 'unknown'}.`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000, ...options});
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || result.error?.message || `${command} failed`).trim());
  }
  return result.stdout;
}

function findIdbDimensions(value) {
  if (!value || typeof value !== 'object') return null;
  const dimensions = value.screen_dimensions;
  if (dimensions) {
    const width = Number(dimensions.width_points ?? dimensions.width);
    const height = Number(dimensions.height_points ?? dimensions.height);
    const scale = Number(dimensions.density ?? dimensions.scale);
    if (width > 0 && height > 0) return {width, height, scale: scale > 0 ? scale : null};
  }
  for (const child of Object.values(value)) {
    const found = findIdbDimensions(child);
    if (found) return found;
  }
  return null;
}

function rounded(value) {
  return Math.round(Number(value) * 100) / 100;
}

let installed = false;
try {
  await mkdir(appPath, {recursive: true});
  await mkdir(path.dirname(profilePath), {recursive: true});
  await mkdir(path.dirname(screenshotPath), {recursive: true});

  const sdkPath = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']).trim();
  const architecture = run('uname', ['-m']).trim();
  const targetArchitecture = architecture === 'arm64' ? 'arm64' : 'x86_64';
  const executable = path.join(appPath, 'UIOSScreenProbe');
  run('swiftc', [
    '-sdk', sdkPath,
    '-target', `${targetArchitecture}-apple-ios17.0-simulator`,
    '-parse-as-library',
    '-module-name', 'UIOSScreenProbe',
    '-framework', 'UIKit',
    '-o', executable,
    path.join(here, 'probe-screen.swift'),
  ]);
  await writeFile(path.join(appPath, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>UIOSScreenProbe</string><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>UIOSScreenProbe</string><key>CFBundlePackageType</key><string>APPL</string><key>MinimumOSVersion</key><string>17.0</string><key>LSRequiresIPhoneOS</key><true/><key>UIDeviceFamily</key><array><integer>1</integer></array><key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string></array></dict></plist>\n`);
  run('codesign', ['--force', '--sign', '-', appPath]);
  run('xcrun', ['simctl', 'install', udid, appPath]);
  installed = true;
  run('xcrun', ['simctl', 'launch', udid, bundleId]);

  const container = run('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'data']).trim();
  const probeFile = path.join(container, 'Documents', 'screen-profile.json');
  let probe = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { probe = JSON.parse(await readFile(probeFile, 'utf8')); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (!probe) throw new Error('The Simulator screen probe did not write a profile within 10 seconds.');

  run('xcrun', ['simctl', 'io', udid, 'screenshot', screenshotPath]);
  const pixels = readPngDimensions(await readFile(screenshotPath));
  const idb = findIdbDimensions(JSON.parse(run('idb', ['describe', '--udid', udid, '--json'])));
  if (!idb) throw new Error('IDB did not return screen dimensions in points.');

  const points = {width: rounded(idb.width), height: rounded(idb.height)};
  const profile = {
    preset,
    simulatorName,
    simulatorUdid: udid,
    points,
    pixels,
    nativePixels: {
      width: rounded(probe.nativePixels.width),
      height: rounded(probe.nativePixels.height),
    },
    scale: rounded(probe.scale),
    safeAreaInsetsPoints: {
      top: rounded(probe.safeAreaInsetsPoints.top),
      bottom: rounded(probe.safeAreaInsetsPoints.bottom),
    },
    statusBarHeightPoints: rounded(probe.statusBarHeightPoints),
    screenshot: path.basename(screenshotPath),
    measuredAt: new Date().toISOString(),
  };

  const warnings = compareDeviceProfile(expected, profile);
  if (Math.abs(points.width - rounded(probe.points.width)) > 0.01 || Math.abs(points.height - rounded(probe.points.height)) > 0.01) {
    warnings.push(`IDB point dimensions ${points.width}x${points.height} differ from UIKit ${rounded(probe.points.width)}x${rounded(probe.points.height)}.`);
  }
  if (Math.abs(points.width * profile.scale - pixels.width) > 1 || Math.abs(points.height * profile.scale - pixels.height) > 1) {
    warnings.push(`Point dimensions multiplied by native scale do not match the simulator screenshot pixels (${pixels.width}x${pixels.height}).`);
  }
  if (profile.nativePixels.width !== pixels.width || profile.nativePixels.height !== pixels.height) {
    warnings.push(`UIKit native screen dimensions ${profile.nativePixels.width}x${profile.nativePixels.height} differ from screenshot dimensions ${pixels.width}x${pixels.height}.`);
  }

  for (const warning of warnings) console.warn(`WARNING: ${warning}; using runtime dimensions and insets.`);
  const strictFailures = strictDeviceProfileFailures(expected, profile);
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  if (process.env.STRICT_DEVICE_SPECS === '1' && strictFailures.length) {
    throw new Error(`Phase 0 device profile check failed for ${expected.label}: ${strictFailures.join('; ')}.`);
  }
  console.log(`${expected.label}: ${points.width}x${points.height} pt; ${pixels.width}x${pixels.height} px; @${profile.scale}x.`);
  console.log(`Runtime status bar ${profile.statusBarHeightPoints} pt; safe area top ${profile.safeAreaInsetsPoints.top} pt, bottom ${profile.safeAreaInsetsPoints.bottom} pt.`);
  console.log(`Device profile saved; screenshot: ${path.basename(screenshotPath)}.`);
} finally {
  if (installed) {
    try { run('xcrun', ['simctl', 'uninstall', udid, bundleId]); }
    catch { /* The Simulator may have shut down after a failed probe. */ }
  }
  await rm(probeRoot, {recursive: true, force: true});
}
