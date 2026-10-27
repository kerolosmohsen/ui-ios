import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {availableIphones, chooseSimulator, loadDeviceCatalog} from '../templates/runtime/simulator-utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.join(root, 'evidence', 'device-specs');
const catalog = loadDeviceCatalog();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options});
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || result.error?.message || `${command} failed`).trim());
  return result.stdout;
}

function boot(udid) {
  const result = spawnSync('xcrun', ['simctl', 'boot', udid], {cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024});
  if (result.status !== 0 && !/current state: Booted|already booted/i.test(`${result.stderr}\n${result.stdout}`)) {
    throw new Error((result.stderr || result.error?.message || 'Could not boot Simulator.').trim());
  }
  run('xcrun', ['simctl', 'bootstatus', udid, '-b']);
}

await mkdir(evidence, {recursive: true});
const availableJson = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '--json']));
const devices = availableIphones(availableJson, catalog);
const probeScript = path.join(root, 'templates', 'runtime', 'probe-device.mjs');

for (const device of catalog.devices) {
  const simulator = chooseSimulator(device.id, devices, catalog);
  console.log(`Phase 0: checking ${device.label} (${simulator.runtime}, ${simulator.udid}).`);
  boot(simulator.udid);
  const profilePath = path.join(evidence, `${device.id}.json`);
  const screenshotPath = path.join(evidence, `${device.id}.png`);
  try {
    process.stdout.write(run(process.execPath, [probeScript], {
      env: {
        ...process.env,
        DEVICE_PRESET: device.id,
        SIMULATOR_UDID: simulator.udid,
        SIMULATOR_NAME: simulator.name,
        DEVICE_PROFILE_PATH: profilePath,
        DEVICE_SCREENSHOT_PATH: screenshotPath,
        STRICT_DEVICE_SPECS: '1',
      },
    }));
  } finally {
    const shutdown = spawnSync('xcrun', ['simctl', 'shutdown', simulator.udid], {cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024});
    if (shutdown.status !== 0 && !/current state: Shutdown|already shutdown/i.test(`${shutdown.stderr}\n${shutdown.stdout}`)) {
      console.warn(`Could not shut down ${device.label} after its profile check.`);
    }
  }
}

console.log(`All ${catalog.devices.length} simulator screen profiles match the confirmed table. Evidence: ${path.relative(root, evidence)}.`);
