export function availableIphones(simulatorJson) {
  return Object.entries(simulatorJson?.devices ?? {}).flatMap(([runtime, devices]) => devices
    .filter((device) => device.isAvailable !== false && /^iPhone\s+\d+/i.test(device.name))
    .map((device) => ({...device, runtime})));
}

export function chooseSimulator(preference, devices) {
  if (!['iphone15', 'latest'].includes(preference)) throw new Error('Unsupported simulator preference.');
  const standard = devices.filter((device) => !/Pro|Plus|Max|mini|Air|SE|Duo/i.test(device.name));
  const candidates = standard.length ? standard : devices;
  if (!candidates.length) throw new Error('No available iPhone Simulator device types were found.');
  const generation = (name) => Number(name.match(/^iPhone\s+(\d+)/i)?.[1] ?? 0);
  if (preference === 'iphone15') {
    return [...candidates].sort((left, right) =>
      Math.abs(generation(left.name) - 15) - Math.abs(generation(right.name) - 15) || left.name.localeCompare(right.name))[0];
  }
  return [...candidates].sort((left, right) =>
    generation(right.name) - generation(left.name) || left.name.localeCompare(right.name))[0];
}
