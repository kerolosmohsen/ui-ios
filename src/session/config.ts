import fs from 'node:fs';
import path from 'node:path';
import { DevicePreset, UiIosConfig } from './types';

export const CONFIG_FILE = 'ui-ios.config.json';

export const DEFAULT_CONFIG: UiIosConfig = {
  version: 1,
  sessionRepository: '',
  devices: ['iphone15', 'latest'],
  defaultDevice: 'iphone15',
  idleTimeoutMinutes: 30,
  includeEnv: false,
  excludeGlobs: [],
  stream: 'jpeg',
  fps: 5,
  warningAcknowledged: false,
};

export function configPath(projectRoot: string): string {
  return path.join(projectRoot, CONFIG_FILE);
}

export function serializeConfig(config: UiIosConfig = DEFAULT_CONFIG): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function readConfig(projectRoot: string): UiIosConfig {
  const filePath = configPath(projectRoot);
  if (!fs.existsSync(filePath)) {
    throw new Error(`No ${CONFIG_FILE} found. Run \`ui-ios init\` first.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    throw new Error(`Could not read ${CONFIG_FILE}: ${detail}`);
  }

  return validateConfig(parsed);
}

export function validateConfig(value: unknown): UiIosConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${CONFIG_FILE} must contain a JSON object.`);
  }
  const input = value as Partial<UiIosConfig>;
  if (input.version !== 1) throw new Error(`Unsupported ${CONFIG_FILE} version.`);
  if (input.sessionRepository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.sessionRepository)) {
    throw new Error('sessionRepository must use the owner/repository format.');
  }
  if (!Array.isArray(input.devices) || input.devices.length !== 2 ||
      !input.devices.includes('iphone15') || !input.devices.includes('latest')) {
    throw new Error('devices must contain exactly "iphone15" and "latest".');
  }
  if (input.defaultDevice !== 'iphone15' && input.defaultDevice !== 'latest') {
    throw new Error('defaultDevice must be "iphone15" or "latest".');
  }
  if (!Number.isInteger(input.idleTimeoutMinutes) ||
      (input.idleTimeoutMinutes ?? 0) < 1 || (input.idleTimeoutMinutes ?? 0) > 330) {
    throw new Error('idleTimeoutMinutes must be an integer between 1 and 330.');
  }
  if (typeof input.includeEnv !== 'boolean') throw new Error('includeEnv must be true or false.');
  if (!Array.isArray(input.excludeGlobs) || input.excludeGlobs.some((glob) => typeof glob !== 'string')) {
    throw new Error('excludeGlobs must be an array of glob strings.');
  }
  if (input.stream !== 'jpeg') throw new Error('This version supports the Phase 0 verified "jpeg" stream.');
  if (!Number.isInteger(input.fps) || (input.fps ?? 0) < 1 || (input.fps ?? 0) > 10) {
    throw new Error('fps must be an integer between 1 and 10.');
  }
  if (input.xcodeVersion !== undefined && typeof input.xcodeVersion !== 'string') {
    throw new Error('xcodeVersion must be a string when set.');
  }

  return {
    version: 1,
    sessionRepository: input.sessionRepository ?? '',
    devices: ['iphone15', 'latest'],
    defaultDevice: input.defaultDevice as DevicePreset,
    idleTimeoutMinutes: input.idleTimeoutMinutes as number,
    includeEnv: input.includeEnv,
    excludeGlobs: input.excludeGlobs,
    ...(input.xcodeVersion ? { xcodeVersion: input.xcodeVersion } : {}),
    stream: 'jpeg',
    fps: input.fps as number,
    warningAcknowledged: input.warningAcknowledged === true,
  };
}
