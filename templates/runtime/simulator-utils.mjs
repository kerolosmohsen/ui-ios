import {readFileSync} from 'node:fs';

const catalogPath = new URL('./device-catalog.json', import.meta.url);

export function loadDeviceCatalog() {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (catalog.version !== 1 || !Array.isArray(catalog.devices)) {
    throw new Error('The simulator device catalog is invalid.');
  }
  return catalog;
}

export function getDevicePreset(preset, catalog = loadDeviceCatalog()) {
  const device = catalog.devices.find((entry) => entry.id === preset);
  if (!device) throw new Error(`Unknown simulator device "${preset}".`);
  return device;
}

export function availableIphones(simulatorJson, catalog = loadDeviceCatalog()) {
  const supportedNames = new Set(catalog.devices.flatMap((device) => device.simulatorNames));
  return Object.entries(simulatorJson?.devices ?? {}).flatMap(([runtime, devices]) => devices
    .filter((device) => device.isAvailable !== false && supportedNames.has(device.name))
    .map((device) => ({...device, runtime})));
}

export function chooseSimulator(preset, devices, catalog = loadDeviceCatalog()) {
  const spec = getDevicePreset(preset, catalog);
  const candidates = devices.filter((device) => spec.simulatorNames.includes(device.name));
  if (!candidates.length) {
    throw new Error(`No available ${spec.label} Simulator was found. Available supported devices: ${devices.map((device) => device.name).join(', ') || 'none'}.`);
  }
  return [...candidates].sort((left, right) => right.runtime.localeCompare(left.runtime))[0];
}

export function createSimulatorIfMissing(preset, devices, catalog, run) {
  try {
    return chooseSimulator(preset, devices, catalog);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('No available ')) throw error;
  }

  const spec = getDevicePreset(preset, catalog);
  if (!spec.deviceTypeIdentifier) {
    throw new Error(`Xcode does not list an available ${spec.label} simulator device type. Install an Xcode runtime that supports this exact model.`);
  }
  const runtimes = [...new Set(devices.map((device) => device.runtime))].sort((left, right) => {
    const version = (value) => value.match(/iOS-(\d+)-(\d+)/)?.slice(1).map(Number) ?? [0, 0];
    const [leftMajor, leftMinor] = version(left);
    const [rightMajor, rightMinor] = version(right);
    return rightMajor - leftMajor || rightMinor - leftMinor;
  });
  if (!runtimes.length) throw new Error('No installed iOS Simulator runtime is available to create the requested device.');

  const errors = [];
  for (const runtime of runtimes) {
    try {
      const output = run('xcrun', ['simctl', 'create', spec.simulatorNames[0], spec.deviceTypeIdentifier, runtime]);
      const udid = output.match(/[A-F0-9-]{36}/i)?.[0];
      if (!udid) throw new Error('simctl create returned no Simulator UDID.');
      return {name: spec.simulatorNames[0], udid, runtime, isAvailable: true, createdForTask: true};
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Could not create ${spec.label} on the installed iOS runtimes: ${errors.join(' | ')}`);
}

export function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Simulator screenshot is not a valid PNG.');
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Simulator screenshot has no PNG IHDR header.');
  return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
}

export function compareDeviceProfile(device, profile) {
  const expected = device.expected;
  const warnings = [];
  const compare = (label, expectedValue, actualValue) => {
    if (expectedValue !== null && expectedValue !== undefined && expectedValue !== actualValue) {
      warnings.push(`${device.label} ${label}: table=${expectedValue}, simulator=${actualValue}`);
    }
  };

  const referencePoints = expected.points ?? (expected.pointsDerivedFromPixels ? {
    width: expected.pixels.width / expected.scale,
    height: expected.pixels.height / expected.scale,
  } : null);
  if (referencePoints) {
    compare('width (pt)', referencePoints.width, profile.points.width);
    compare('height (pt)', referencePoints.height, profile.points.height);
  }
  compare('screenshot width (px)', expected.pixels.width, profile.pixels.width);
  compare('screenshot height (px)', expected.pixels.height, profile.pixels.height);
  compare('scale', expected.scale, profile.scale);
  compare('status bar height (pt)', expected.statusBarHeightPoints, profile.statusBarHeightPoints);
  compare('safe area top (pt)', expected.safeAreaInsetsPoints.top, profile.safeAreaInsetsPoints.top);
  compare('safe area bottom (pt)', expected.safeAreaInsetsPoints.bottom, profile.safeAreaInsetsPoints.bottom);
  return warnings;
}

export function pixelSizeMatches(device, pixels) {
  return pixels.width === device.expected.pixels.width && pixels.height === device.expected.pixels.height;
}

export function strictDeviceProfileFailures(device, profile) {
  const failures = [];
  if (!pixelSizeMatches(device, profile.pixels)) {
    failures.push(`expected screenshot ${device.expected.pixels.width}x${device.expected.pixels.height} px, got ${profile.pixels.width}x${profile.pixels.height} px`);
  }
  if (device.expected.pointsDerivedFromPixels) {
    const expectedWidth = device.expected.pixels.width / device.expected.scale;
    const expectedHeight = device.expected.pixels.height / device.expected.scale;
    if (profile.points.width !== expectedWidth || profile.points.height !== expectedHeight) {
      failures.push(`expected runtime points ${expectedWidth}x${expectedHeight} derived from the pixel table, got ${profile.points.width}x${profile.points.height}`);
    }
  }
  return failures;
}

export function normalizedToScreenPoint(position, pointLength) {
  if (!Number.isFinite(position) || position < 0 || position > 1 || !Number.isFinite(pointLength) || pointLength < 1) {
    throw new Error('A touch coordinate is outside the measured simulator screen.');
  }
  return Math.max(0, Math.min(Math.ceil(pointLength) - 1, Math.round(position * pointLength)));
}
