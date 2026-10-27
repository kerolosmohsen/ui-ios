export type DevicePreset = 'iphone15' | 'latest';
export type StreamFormat = 'jpeg';

export interface UiIosConfig {
  version: 1;
  sessionRepository: string;
  devices: DevicePreset[];
  defaultDevice: DevicePreset;
  idleTimeoutMinutes: number;
  includeEnv: boolean;
  excludeGlobs: string[];
  xcodeVersion?: string;
  stream: StreamFormat;
  fps: number;
  warningAcknowledged?: boolean;
}

export interface StartOptions {
  device?: DevicePreset;
  verbose?: boolean;
  includeEnv?: boolean;
}

export interface SessionState {
  version: 1;
  sessionId: string;
  repository: string;
  branch: string;
  runId: number;
  runUrl: string;
  device: DevicePreset;
  createdAt: string;
  projectRoot: string;
}

export interface SessionMetadata {
  sessionId: string;
  tunnelHost: string;
  deviceName: string;
  simulatorUdid: string;
  logicalSize: { width: number; height: number; pixelRatio: number };
  fps: number;
  runId: number;
  bootSeconds?: number;
  startedAt: string;
}

export interface GitHubRun {
  databaseId: number;
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
  startedAt: string | null;
  jobs?: Array<{
    name: string;
    status: string;
    steps: Array<{ name: string; status: string; conclusion: string | null }>;
  }>;
}
