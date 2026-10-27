'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const { detectReactNativeProject } = require('../src/utils/detector');
const { generateDetoxConfig } = require('../src/templates/detoxrc');
const { DEFAULT_CONFIG, DEVICE_CATALOG, DEVICE_IDS, readConfig, serializeConfig, validateConfig } = require('../dist/session/config');
const { createProjectSnapshot, SnapshotTooLargeError } = require('../dist/session/snapshot');

function createProject({ workspace = true, project = true, podfile = false } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-ios-test-'));
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'sample-app',
    dependencies: { 'react-native': '0.76.0' },
  }));
  fs.mkdirSync(path.join(cwd, 'ios'));
  if (workspace) fs.mkdirSync(path.join(cwd, 'ios', 'Sample App.xcworkspace'));
  if (project) fs.mkdirSync(path.join(cwd, 'ios', 'Sample App.xcodeproj'));
  if (podfile) fs.writeFileSync(path.join(cwd, 'ios', 'Podfile'), "target 'Sample App' do\nend\n");
  return cwd;
}

test('detects a React Native project and native workspace', () => {
  const cwd = createProject();
  try {
    const result = detectReactNativeProject(cwd);
    assert.equal(result.valid, true);
    assert.equal(result.projectName, 'Sample App');
    assert.equal(result.buildProjectType, 'workspace');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('anticipates the CocoaPods workspace before pod install creates it', () => {
  const cwd = createProject({ workspace: false, project: true, podfile: true });
  try {
    const result = detectReactNativeProject(cwd);
    assert.equal(result.valid, true);
    assert.equal(result.hasPodfile, true);
    assert.equal(result.projectFile, 'Sample App.xcodeproj');
    assert.equal(result.buildProjectFile, 'Sample App.xcworkspace');
    assert.equal(result.buildProjectType, 'workspace');
    const detoxConfig = generateDetoxConfig(result);
    assert.match(detoxConfig, /-workspace 'ios\/Sample App\.xcworkspace'/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('generates a Detox config with shell-safe project names and CI simulator override', () => {
  const output = generateDetoxConfig({
    projectName: "Sam's App",
    buildProjectFile: "Sam's App.xcworkspace",
    buildProjectType: 'workspace',
  }, 'iPhone 16');

  assert.match(output, /UI_IOS_SIMULATOR \|\| "iPhone 16"/);
  const module = { exports: {} };
  vm.runInNewContext(output, { module, process: { env: {} } });
  assert.ok(module.exports.apps['ios.sim.debug'].build.includes("Sam'\\''s App"));
  assert.ok(module.exports.apps['ios.sim.debug'].build.includes('-workspace'));
});

test('dry run reports planned files and does not write them', () => {
  const cwd = createProject();
  const cliPath = path.resolve(__dirname, '../bin/ui-ios.js');
  try {
    const result = spawnSync(process.execPath, [cliPath, 'init', '--dry-run', '--skip-install'], {
      cwd,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Would create \.detoxrc\.js/);
    assert.equal(fs.existsSync(path.join(cwd, '.detoxrc.js')), false);
    assert.equal(fs.existsSync(path.join(cwd, 'e2e')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('init writes configuration, adds ignore paths, and preserves them on later runs with --yes', () => {
  const cwd = createProject();
  const cliPath = path.resolve(__dirname, '../bin/ui-ios.js');
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\n');
  try {
    const firstRun = spawnSync(process.execPath, [cliPath, 'init', '--skip-install', '--yes'], {
      cwd,
      encoding: 'utf8',
    });
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const previewConfig = fs.readFileSync(path.join(cwd, 'ui-ios.config.json'), 'utf8');
    assert.equal(JSON.parse(previewConfig).defaultDevice, 'iphone15');
    for (const file of [
      '.detoxrc.js',
      'e2e/jest.config.js',
      'e2e/starter.test.js',
      '.github/workflows/ios-ui-tests.yml',
    ]) {
      assert.equal(fs.existsSync(path.join(cwd, file)), true, `${file} should be created`);
    }
    const generatedConfig = require(path.join(cwd, '.detoxrc.js'));
    assert.equal(generatedConfig.apps['ios.sim.debug'].type, 'ios.app');
    assert.equal(generatedConfig.configurations['ios.sim.debug'].app, 'ios.sim.debug');
    const workflow = fs.readFileSync(path.join(cwd, '.github', 'workflows', 'ios-ui-tests.yml'), 'utf8');
    assert.match(workflow, /node-version: '24'/);
    assert.match(workflow, /Generate native iOS project for Expo/);
    assert.match(workflow, /npx expo prebuild --platform ios --no-install/);
    const sessionWorkflow = fs.readFileSync(path.join(__dirname, '../templates/session/.github/workflows/ui-ios-session.yml'), 'utf8');
    assert.match(sessionWorkflow, /Generate native iOS project for Expo/);
    assert.match(sessionWorkflow, /npx expo prebuild --platform ios --no-install/);
    assert.match(workflow, /bundle exec pod install/);
    assert.match(workflow, /brew install wix\/brew\/applesimutils/);
    assert.match(workflow, /actions\/checkout@v7/);
    assert.match(workflow, /actions\/setup-node@v7/);
    assert.match(workflow, /actions\/upload-artifact@v7/);
    assert.match(workflow, /FORCE_BUNDLING: '1'/);
    assert.match(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8'), /artifacts\//);
    assert.match(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8'), /ios\/build\//);

    const priorConfig = fs.readFileSync(path.join(cwd, '.detoxrc.js'), 'utf8');
    const secondRun = spawnSync(process.execPath, [cliPath, 'init', '--skip-install', '--yes'], {
      cwd,
      encoding: 'utf8',
    });
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
    assert.equal(fs.readFileSync(path.join(cwd, '.detoxrc.js'), 'utf8'), priorConfig);
    assert.equal(fs.readFileSync(path.join(cwd, 'ui-ios.config.json'), 'utf8'), previewConfig);
    assert.equal(fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8').match(/# Detox/g).length, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('validates session settings and refuses unsupported device choices', () => {
  assert.deepEqual(validateConfig(JSON.parse(serializeConfig(DEFAULT_CONFIG))), DEFAULT_CONFIG);
  assert.deepEqual(DEVICE_IDS, ['iphone15', 'iphone17', 'iphone18pro']);
  assert.equal(DEVICE_CATALOG.devices.find((device) => device.id === 'iphone18pro').runnerLabel, 'xcode-27');
  assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG, devices: ['iphone15'] }).devices, ['iphone15']);
  assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG, devices: ['iphone15', 'latest'], defaultDevice: 'latest' }), {
    ...DEFAULT_CONFIG,
    devices: ['iphone15', 'iphone17'],
    defaultDevice: 'iphone17',
  });
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, devices: ['iphone18'] }), /Unknown simulator device/);
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, idleTimeoutMinutes: 331 }), /between 1 and 330/);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-ios-config-'));
  try {
    fs.writeFileSync(path.join(temp, 'ui-ios.config.json'), serializeConfig({ ...DEFAULT_CONFIG, fps: 8 }));
    assert.equal(readConfig(temp).fps, 8);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('copies a filtered snapshot from a Windows-style project path without leaking ignored files', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-ios-path with spaces-'));
  const cwd = path.join(temp, 'react-native project');
  const destination = path.join(temp, 'upload snapshot');
  fs.mkdirSync(path.join(cwd, 'ios', 'MyApp.xcodeproj'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'ios', 'Pods'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'ios', 'build'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'android', 'app'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'node_modules', 'react-native'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.git', 'objects'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.76.0' } }));
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'ignored.tmp\n');
  fs.writeFileSync(path.join(cwd, '.env.local'), 'PRIVATE=not-uploaded');
  fs.writeFileSync(path.join(cwd, 'ios', 'Podfile'), 'platform :ios\n');
  fs.writeFileSync(path.join(cwd, 'ios', 'Pods', 'pod.txt'), 'excluded');
  fs.writeFileSync(path.join(cwd, 'ios', 'build', 'app.bin'), 'excluded');
  fs.writeFileSync(path.join(cwd, 'android', 'app', 'build.gradle'), 'excluded');
  fs.writeFileSync(path.join(cwd, 'node_modules', 'react-native', 'index.js'), 'excluded');
  fs.writeFileSync(path.join(cwd, '.git', 'objects', 'object'), 'excluded');
  fs.writeFileSync(path.join(cwd, 'ignored.tmp'), 'ignored');
  fs.writeFileSync(path.join(cwd, 'App.tsx'), 'export default 1;');
  try {
    const result = await createProjectSnapshot({
      projectRoot: cwd,
      destination,
      excludeGlobs: [],
      includeEnv: false,
    });
    const copied = new Set(result.largestFiles.map((entry) => entry.path));
    assert.ok(copied.has('App.tsx'));
    assert.ok(copied.has('ios/Podfile'));
    assert.ok(!copied.has('.env.local'));
    assert.ok(!copied.has('ignored.tmp'));
    assert.ok([...copied].every((entry) => !entry.includes('\\')));
    for (const excluded of ['android', 'ios/Pods', 'ios/build', 'node_modules', '.git']) {
      assert.equal(fs.existsSync(path.join(destination, excluded)), false, `${excluded} should be omitted`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('applies custom glob exclusions to directories and files', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-ios-globs-'));
  const project = path.join(temp, 'project');
  const destination = path.join(temp, 'snapshot');
  fs.mkdirSync(path.join(project, 'generated', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(project, 'generated', 'deep', 'bundle.js'), 'excluded');
  fs.writeFileSync(path.join(project, 'large.tmp'), 'excluded');
  fs.writeFileSync(path.join(project, 'App.js'), 'included');
  try {
    const result = await createProjectSnapshot({
      projectRoot: project,
      destination,
      excludeGlobs: ['generated/', '*.tmp'],
      includeEnv: false,
    });
    const copied = new Set(result.largestFiles.map((entry) => entry.path));
    assert.ok(copied.has('App.js'));
    assert.ok(!copied.has('generated/deep/bundle.js'));
    assert.ok(!copied.has('large.tmp'));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('does not include environment files unless includeEnv is explicitly enabled', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-ios-env-'));
  const project = path.join(temp, 'project');
  const destination = path.join(temp, 'snapshot');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, '.env'), 'VALUE=secret');
  fs.writeFileSync(path.join(project, 'App.js'), 'export default 1;');
  try {
    await createProjectSnapshot({ projectRoot: project, destination, excludeGlobs: [], includeEnv: false });
    assert.equal(fs.existsSync(path.join(destination, '.env')), false);
    const included = path.join(temp, 'included');
    await createProjectSnapshot({ projectRoot: project, destination: included, excludeGlobs: [], includeEnv: true });
    assert.equal(fs.readFileSync(path.join(included, '.env'), 'utf8'), 'VALUE=secret');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('reports an oversized snapshot with the largest file list', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-ios-large-'));
  const project = path.join(temp, 'project');
  const destination = path.join(temp, 'snapshot');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'large.bin'), Buffer.alloc(64));
  fs.writeFileSync(path.join(project, 'small.bin'), Buffer.alloc(8));
  try {
    await assert.rejects(
      createProjectSnapshot({ projectRoot: project, destination, excludeGlobs: [], includeEnv: false, maxBytes: 32 }),
      (error) => error instanceof SnapshotTooLargeError && error.largestFiles[0].path === 'large.bin',
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('uses exact device names from the config-driven simulator catalog', async () => {
  const { availableIphones, chooseSimulator, createSimulatorIfMissing } = await import('../templates/runtime/simulator-utils.mjs');
  const devices = availableIphones({
    devices: {
      'iOS-27': [
        { name: 'iPhone 15', udid: '15', isAvailable: true },
        { name: 'iPhone 17', udid: '17', isAvailable: true },
        { name: 'iPhone 18 Pro', udid: '18p', isAvailable: true },
        { name: 'iPhone 18', udid: '18', isAvailable: true },
        { name: 'iPhone 18 Pro', udid: '18p-old', isAvailable: false },
      ],
    },
  });
  assert.deepEqual(devices.map((device) => device.name), ['iPhone 15', 'iPhone 17', 'iPhone 18 Pro']);
  assert.equal(chooseSimulator('iphone15', devices).udid, '15');
  assert.equal(chooseSimulator('iphone17', devices).udid, '17');
  assert.equal(chooseSimulator('iphone18pro', devices).udid, '18p');
  assert.throws(() => chooseSimulator('iphone18pro', devices.filter((device) => device.udid !== '18p')), /No available iPhone 18 Pro/);
  assert.throws(() => chooseSimulator('iphone18', devices), /Unknown simulator device/);
  const created = createSimulatorIfMissing('iphone15', devices.filter((device) => device.name !== 'iPhone 15'), undefined, (command, args) => {
    assert.equal(command, 'xcrun');
    assert.deepEqual(args, ['simctl', 'create', 'iPhone 15', 'com.apple.CoreSimulator.SimDeviceType.iPhone-15', 'iOS-27']);
    return 'ABCD1234-ABCD-ABCD-ABCD-ABCD1234ABCD';
  });
  assert.equal(created.createdForTask, true);
  assert.equal(created.name, 'iPhone 15');
  assert.equal(created.udid, 'ABCD1234-ABCD-ABCD-ABCD-ABCD1234ABCD');
});

test('checks the confirmed device pixel sizes and leaves unconfirmed profile values to runtime', async () => {
  const { compareDeviceProfile, normalizedToScreenPoint, pixelSizeMatches, strictDeviceProfileFailures } = await import('../templates/runtime/simulator-utils.mjs');
  const iphone15 = DEVICE_CATALOG.devices.find((device) => device.id === 'iphone15');
  const iphone17 = DEVICE_CATALOG.devices.find((device) => device.id === 'iphone17');
  const iphone18pro = DEVICE_CATALOG.devices.find((device) => device.id === 'iphone18pro');
  assert.deepEqual(iphone15.expected.points, { width: 393, height: 852 });
  assert.deepEqual(iphone15.expected.pixels, { width: 1179, height: 2556 });
  assert.equal(iphone15.expected.scale, 3);
  assert.equal(iphone15.expected.diagonalInches, 6.1);
  assert.equal(iphone15.expected.ppi, 460);
  assert.deepEqual(iphone15.expected.bodyMm, { height: 147.6, width: 71.6, depth: 7.8 });
  assert.deepEqual(iphone15.expected.safeAreaInsetsPoints, { top: 59, bottom: 34 });
  assert.equal(iphone17.expected.diagonalInches, 6.3);
  assert.deepEqual(iphone17.expected.bodyMm, { height: 149.6, width: 71.5, depth: 7.95 });
  assert.equal(iphone17.expected.safeAreaInsetsPoints.top, 62);
  assert.equal(iphone17.expected.safeAreaInsetsPoints.bottom, null);
  assert.equal(iphone18pro.label, 'iPhone 18 Pro');
  assert.deepEqual(iphone18pro.expected.points, null);
  assert.deepEqual(iphone18pro.expected.pixels, { width: 1206, height: 2622 });
  assert.equal(iphone18pro.expected.scale, 3);
  assert.deepEqual(iphone18pro.expected.bodyMm, { height: 150, width: 71.9, depth: 8.75 });
  assert.equal(iphone18pro.expected.statusBarHeightPoints, null);
  assert.deepEqual(iphone18pro.expected.safeAreaInsetsPoints, { top: null, bottom: null });
  const runtime = {
    points: { width: 402, height: 874 },
    pixels: { width: 1206, height: 2622 },
    scale: 3,
    statusBarHeightPoints: 55,
    safeAreaInsetsPoints: { top: 63, bottom: 34 },
  };
  assert.deepEqual(compareDeviceProfile(iphone18pro, runtime), []);
  assert.match(compareDeviceProfile(iphone18pro, { ...runtime, points: { width: 402, height: 873 } })[0], /height \(pt\): table=874/);
  assert.equal(pixelSizeMatches(iphone18pro, runtime.pixels), true);
  assert.equal(pixelSizeMatches(iphone18pro, { width: 1179, height: 2556 }), false);
  assert.deepEqual(strictDeviceProfileFailures(iphone18pro, runtime), []);
  assert.match(strictDeviceProfileFailures(iphone18pro, { ...runtime, points: { width: 402, height: 873 } })[0], /expected runtime points 402x874/);
  assert.match(strictDeviceProfileFailures(iphone18pro, { ...runtime, pixels: { width: 1179, height: 2556 } })[0], /expected screenshot 1206x2622/);
  assert.equal(DEVICE_CATALOG.devices.some((device) => device.id === 'iphone18'), false);
  assert.equal(normalizedToScreenPoint(0, 402), 0);
  assert.equal(normalizedToScreenPoint(0.5, 402), 201);
  assert.equal(normalizedToScreenPoint(1, 402), 401);
  assert.throws(() => normalizedToScreenPoint(1.1, 402), /outside the measured simulator screen/);
});

test('has a valid browser client with runtime device options and an undistorted screen hit area', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../site/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'The static page should contain its browser client.');
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /message\.devices/);
  assert.match(html, /setDeviceOptions\(message\.devices, message\.preset, message\.logicalSize\)/);
  assert.match(html, /object-fit:contain/);
  assert.match(html, /getBoundingClientRect\(\)/);
  assert.match(html, /id="displayDetails"/);
  assert.doesNotMatch(html, /class="island"|class="homebar"|\.island\{|\.homebar\{/);
  assert.equal((html.match(/<option value=/g) || []).length, 1);
});
