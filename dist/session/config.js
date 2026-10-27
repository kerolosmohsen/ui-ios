"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = exports.DEVICE_IDS = exports.DEVICE_CATALOG = exports.CONFIG_FILE = void 0;
exports.configPath = configPath;
exports.serializeConfig = serializeConfig;
exports.readConfig = readConfig;
exports.validateConfig = validateConfig;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
exports.CONFIG_FILE = 'ui-ios.config.json';
const catalogPath = node_path_1.default.resolve(__dirname, '../../templates/runtime/device-catalog.json');
exports.DEVICE_CATALOG = JSON.parse(node_fs_1.default.readFileSync(catalogPath, 'utf8'));
if (exports.DEVICE_CATALOG.version !== 1 || !Array.isArray(exports.DEVICE_CATALOG.devices)) {
    throw new Error('The simulator device catalog is invalid.');
}
exports.DEVICE_IDS = exports.DEVICE_CATALOG.devices.map((device) => device.id);
exports.DEFAULT_CONFIG = {
    version: 1,
    sessionRepository: '',
    devices: [...exports.DEVICE_IDS],
    defaultDevice: 'iphone15',
    idleTimeoutMinutes: 30,
    includeEnv: false,
    excludeGlobs: [],
    stream: 'jpeg',
    fps: 5,
    warningAcknowledged: false,
};
function configPath(projectRoot) {
    return node_path_1.default.join(projectRoot, exports.CONFIG_FILE);
}
function serializeConfig(config = exports.DEFAULT_CONFIG) {
    return `${JSON.stringify(config, null, 2)}\n`;
}
function readConfig(projectRoot) {
    const filePath = configPath(projectRoot);
    if (!node_fs_1.default.existsSync(filePath)) {
        throw new Error(`No ${exports.CONFIG_FILE} found. Run \`ui-ios init\` first.`);
    }
    let parsed;
    try {
        parsed = JSON.parse(node_fs_1.default.readFileSync(filePath, 'utf8'));
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : 'invalid JSON';
        throw new Error(`Could not read ${exports.CONFIG_FILE}: ${detail}`);
    }
    return validateConfig(parsed);
}
function validateConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${exports.CONFIG_FILE} must contain a JSON object.`);
    }
    const input = value;
    if (input.version !== 1)
        throw new Error(`Unsupported ${exports.CONFIG_FILE} version.`);
    if (input.sessionRepository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.sessionRepository)) {
        throw new Error('sessionRepository must use the owner/repository format.');
    }
    if (!Array.isArray(input.devices) || input.devices.length < 1 || input.devices.some((device) => typeof device !== 'string')) {
        throw new Error('devices must be a non-empty array of simulator catalog IDs.');
    }
    const devices = [...new Set(input.devices.map((device) => device === 'latest' ? 'iphone17' : device))];
    if (devices.length !== input.devices.length)
        throw new Error('devices cannot contain duplicate simulator IDs.');
    for (const device of devices) {
        if (!exports.DEVICE_IDS.includes(device))
            throw new Error(`Unknown simulator device "${device}".`);
    }
    const defaultDevice = input.defaultDevice === 'latest' ? 'iphone17' : input.defaultDevice;
    if (typeof defaultDevice !== 'string' || !devices.includes(defaultDevice)) {
        throw new Error('defaultDevice must be included in devices.');
    }
    if (!Number.isInteger(input.idleTimeoutMinutes) ||
        (input.idleTimeoutMinutes ?? 0) < 1 || (input.idleTimeoutMinutes ?? 0) > 330) {
        throw new Error('idleTimeoutMinutes must be an integer between 1 and 330.');
    }
    if (typeof input.includeEnv !== 'boolean')
        throw new Error('includeEnv must be true or false.');
    if (!Array.isArray(input.excludeGlobs) || input.excludeGlobs.some((glob) => typeof glob !== 'string')) {
        throw new Error('excludeGlobs must be an array of glob strings.');
    }
    if (input.stream !== 'jpeg')
        throw new Error('This version supports the Phase 0 verified "jpeg" stream.');
    if (!Number.isInteger(input.fps) || (input.fps ?? 0) < 1 || (input.fps ?? 0) > 10) {
        throw new Error('fps must be an integer between 1 and 10.');
    }
    if (input.xcodeVersion !== undefined && typeof input.xcodeVersion !== 'string') {
        throw new Error('xcodeVersion must be a string when set.');
    }
    return {
        version: 1,
        sessionRepository: input.sessionRepository ?? '',
        devices,
        defaultDevice: defaultDevice,
        idleTimeoutMinutes: input.idleTimeoutMinutes,
        includeEnv: input.includeEnv,
        excludeGlobs: input.excludeGlobs,
        ...(input.xcodeVersion ? { xcodeVersion: input.xcodeVersion } : {}),
        stream: 'jpeg',
        fps: input.fps,
        warningAcknowledged: input.warningAcknowledged === true,
    };
}
//# sourceMappingURL=config.js.map