import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {availableIphones, createSimulatorIfMissing, loadDeviceCatalog} from '../templates/runtime/simulator-utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.join(root, 'evidence', 'device-bezels');
const catalog = loadDeviceCatalog();
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ui-ios-bezel-capture-'));
const appPath = path.join(temporaryRoot, 'UIOSScreenProbe.app');
const bundleId = 'dev.uiios.screenprobe';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 600_000, ...options});
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || result.error?.message || `${command} failed`).trim());
  return result.stdout;
}

function tryRun(command, args) {
  return spawnSync(command, args, {cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30_000});
}

function boot(udid) {
  const result = spawnSync('xcrun', ['simctl', 'boot', udid], {cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120_000});
  if (result.status !== 0 && !/current state: Booted|already booted/i.test(`${result.stderr}\n${result.stdout}`)) {
    throw new Error((result.stderr || result.error?.message || 'Could not boot Simulator.').trim());
  }
  run('xcrun', ['simctl', 'bootstatus', udid, '-b']);
}

try {
  await mkdir(evidence, {recursive: true});
  const developerDir = run('xcode-select', ['-p']).trim();
  const appCandidates = [
    path.join(developerDir, 'Applications', 'Simulator.app'),
    path.resolve(developerDir, '..', 'Applications', 'DeviceHub.app'),
    path.join(developerDir, 'Applications', 'DeviceHub.app'),
  ];
  const simulatorApp = appCandidates.find((candidate) => existsSync(candidate));
  if (!simulatorApp) throw new Error(`No Simulator or Device Hub app was found under ${developerDir}.`);
  console.log(`Opening device window with ${simulatorApp}.`);
  const openHelp = tryRun('open', ['-h']);
  console.log(`open help (exit ${openHelp.status ?? 1}):\n${openHelp.stdout || openHelp.stderr}`);
  const captureHelp = tryRun('screencapture', ['-h']);
  console.log(`screencapture help (exit ${captureHelp.status ?? 1}):\n${captureHelp.stdout || captureHelp.stderr}`);

  const sdkPath = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']).trim();
  const architecture = run('uname', ['-m']).trim();
  const targetArchitecture = architecture === 'arm64' ? 'arm64' : 'x86_64';
  await mkdir(appPath, {recursive: true});
  run('swiftc', [
    '-sdk', sdkPath,
    '-target', `${targetArchitecture}-apple-ios17.0-simulator`,
    '-parse-as-library',
    '-module-name', 'UIOSScreenProbe',
    '-framework', 'UIKit',
    '-o', path.join(appPath, 'UIOSScreenProbe'),
    path.join(root, 'templates', 'runtime', 'probe-screen.swift'),
  ]);
  await writeFile(path.join(appPath, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>UIOSScreenProbe</string><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>UIOSScreenProbe</string><key>CFBundlePackageType</key><string>APPL</string><key>MinimumOSVersion</key><string>17.0</string><key>LSRequiresIPhoneOS</key><true/><key>UIDeviceFamily</key><array><integer>1</integer></array><key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string></array></dict></plist>\n`, 'utf8');
  run('codesign', ['--force', '--sign', '-', appPath]);

  const availableJson = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '--json']));
  const devices = availableIphones(availableJson, catalog);
  const failures = [];
  for (const device of catalog.devices) {
    let simulator = null;
    try {
      simulator = createSimulatorIfMissing(device.id, devices, catalog, run);
      console.log(`Opening ${device.label} (${simulator.runtime}, ${simulator.udid}).`);
      boot(simulator.udid);
      run('xcrun', ['simctl', 'install', simulator.udid, appPath]);
      run('xcrun', ['simctl', 'launch', simulator.udid, bundleId]);

      // Device Hub keeps the first selected simulator when additional devices
      // are booted. Relaunch it for each target so the window attaches to the
      // simulator currently running the probe app.
      const processName = path.basename(simulatorApp, '.app');
      const quit = tryRun('osascript', ['-e', `tell application "${processName}" to quit`]);
      if (quit.status !== 0) console.warn(`Could not quit the previous ${processName} window: ${(quit.stderr || '').trim()}`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const opened = tryRun('open', ['-a', simulatorApp]);
      if (opened.status !== 0) throw new Error((opened.stderr || opened.error?.message || 'Could not open the simulator window.').trim());
      await new Promise((resolve) => setTimeout(resolve, 10_000));

      const screenshotPath = path.join(evidence, `${device.id}-simulator-window.png`);
      run('screencapture', ['-x', screenshotPath]);
      console.log(`Desktop capture saved: ${path.relative(root, screenshotPath)}.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${device.label}: ${detail}`);
      console.error(`Window capture failed for ${device.label}: ${detail}`);
    } finally {
      if (simulator) {
        tryRun('xcrun', ['simctl', 'uninstall', simulator.udid, bundleId]);
        tryRun('xcrun', ['simctl', 'shutdown', simulator.udid]);
      }
    }
  }
  if (failures.length) throw new Error(`Could not capture every Simulator window:\n${failures.join('\n')}`);
} finally {
  await rm(temporaryRoot, {recursive: true, force: true});
}
