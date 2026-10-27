import {spawnSync} from 'node:child_process';
import {availableIphones, createSimulatorIfMissing, loadDeviceCatalog} from './simulator-utils.mjs';

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || `${command} failed`).trim());
  return result.stdout;
}

const preference = process.env.DEVICE_PRESET;
const catalog = loadDeviceCatalog();
if (!catalog.devices.some((device) => device.id === preference)) throw new Error('Unsupported simulator preference.');
const xcode = run('xcodebuild', ['-version']).replace(/\r/g, '').trim().replace(/\n/g, ' · ');
run('xcrun', ['simctl', 'list', 'devicetypes']);
const runtimeList = run('xcrun', ['simctl', 'list', 'runtimes']);
const available = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '--json']));
const devices = availableIphones(available, catalog);
const selected = createSimulatorIfMissing(preference, devices, catalog, run);
if (!selected?.udid) throw new Error('Could not find a simulator UDID.');
const bootStarted = Date.now();
const boot = spawnSync('xcrun', ['simctl', 'boot', selected.udid], {encoding: 'utf8', maxBuffer: 1024 * 1024});
if (boot.status !== 0 && !/current state: Booted|already booted/i.test(`${boot.stderr}\n${boot.stdout}`)) {
  throw new Error((boot.stderr || boot.error?.message || 'simctl boot failed').trim());
}
run('xcrun', ['simctl', 'bootstatus', selected.udid, '-b']);
const bootSeconds = Math.round((Date.now() - bootStarted) / 1000);
console.error(`Xcode: ${xcode}; selected ${selected.name} (${selected.runtime}, ${selected.udid}); booted in ${bootSeconds}s.`);
console.error(`Available iOS runtime summary: ${runtimeList.split(/\r?\n/).filter((line) => /iOS/i.test(line)).join(' | ')}`);
console.log(`name=${selected.name}`);
console.log(`udid=${selected.udid}`);
console.log(`boot_seconds=${bootSeconds}`);
console.log(`preset=${preference}`);
