"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotTooLargeError = void 0;
exports.createProjectSnapshot = createProjectSnapshot;
exports.formatBytes = formatBytes;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const ignore_1 = __importDefault(require("ignore"));
const picomatch_1 = __importDefault(require("picomatch"));
const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const HARD_EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules']);
const HARD_EXCLUDED_PATHS = new Set([
    'android',
    '.ui-ios',
    'ui-ios-runtime',
    'ios/Pods',
    'ios/build',
]);
class SnapshotTooLargeError extends Error {
    largestFiles;
    totalBytes;
    constructor(totalBytes, largestFiles) {
        super(`Project snapshot is ${formatBytes(totalBytes)}, above the 100 MB upload limit.`);
        this.name = 'SnapshotTooLargeError';
        this.totalBytes = totalBytes;
        this.largestFiles = largestFiles;
    }
}
exports.SnapshotTooLargeError = SnapshotTooLargeError;
function toPosix(value) {
    return value.split(node_path_1.default.sep).join('/');
}
function isEnvironmentFile(relativePath) {
    return relativePath.split('/').some((segment) => segment.startsWith('.env'));
}
function isHardExcluded(relativePath) {
    const segments = relativePath.split('/');
    if (segments.some((segment) => HARD_EXCLUDED_SEGMENTS.has(segment)))
        return true;
    if (HARD_EXCLUDED_PATHS.has(relativePath))
        return true;
    return relativePath.startsWith('ios/Pods/') || relativePath.startsWith('ios/build/');
}
function matchesCustomExclude(relativePath, globs) {
    return globs.some(({ pattern, matcher, basename, directory }) => {
        if (matcher(relativePath))
            return true;
        if (basename && relativePath.split('/').some((segment) => matcher(segment)))
            return true;
        const directoryPath = pattern.slice(0, -1);
        return directory && (relativePath === directoryPath || relativePath.startsWith(pattern));
    });
}
function isIgnoredByLayers(relativePath, layers) {
    let ignored = false;
    for (const layer of layers) {
        if (layer.directory && relativePath !== layer.directory &&
            !relativePath.startsWith(`${layer.directory}/`))
            continue;
        const relativeToLayer = layer.directory
            ? node_path_1.default.posix.relative(layer.directory, relativePath)
            : relativePath;
        const result = layer.matcher.test(relativeToLayer);
        if (result.ignored)
            ignored = true;
        if (result.unignored)
            ignored = false;
    }
    return ignored;
}
async function readIgnoreLayer(directory, relativeDirectory) {
    const ignorePath = node_path_1.default.join(directory, '.gitignore');
    try {
        const contents = await promises_1.default.readFile(ignorePath, 'utf8');
        return {
            directory: relativeDirectory,
            matcher: (0, ignore_1.default)().add(contents.replace(/^\uFEFF/, '')),
        };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function formatBytes(bytes) {
    if (bytes >= 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} bytes`;
}
async function copyDirectory(sourceDirectory, relativeDirectory, destination, layers, customExcludes, includeEnv, files) {
    const ownIgnoreLayer = await readIgnoreLayer(sourceDirectory, relativeDirectory);
    const activeLayers = ownIgnoreLayer ? [...layers, ownIgnoreLayer] : layers;
    const entries = await promises_1.default.readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
        const relativePath = toPosix(node_path_1.default.posix.join(relativeDirectory, entry.name));
        if (isHardExcluded(relativePath))
            continue;
        if (!includeEnv && isEnvironmentFile(relativePath))
            continue;
        if (matchesCustomExclude(relativePath, customExcludes))
            continue;
        const ignored = !(includeEnv && isEnvironmentFile(relativePath)) && isIgnoredByLayers(relativePath, activeLayers);
        const sourcePath = node_path_1.default.join(sourceDirectory, entry.name);
        const destinationPath = node_path_1.default.join(destination, ...relativePath.split('/'));
        if (entry.isSymbolicLink())
            continue;
        if (entry.isDirectory()) {
            if (ignored)
                continue;
            await copyDirectory(sourcePath, relativePath, destination, activeLayers, customExcludes, includeEnv, files);
            continue;
        }
        if (!entry.isFile() || ignored)
            continue;
        const stat = await promises_1.default.stat(sourcePath);
        await promises_1.default.mkdir(node_path_1.default.dirname(destinationPath), { recursive: true });
        await promises_1.default.copyFile(sourcePath, destinationPath);
        files.push({ path: relativePath, bytes: stat.size });
    }
}
async function createProjectSnapshot(options) {
    const projectRoot = node_path_1.default.resolve(options.projectRoot);
    const destination = node_path_1.default.resolve(options.destination);
    const maxBytes = options.maxBytes ?? MAX_SNAPSHOT_BYTES;
    const customExcludes = options.excludeGlobs.map((pattern) => {
        const normalized = pattern.replace(/\\/g, '/');
        return {
            pattern: normalized,
            matcher: (0, picomatch_1.default)(normalized, { dot: true }),
            basename: !normalized.includes('/'),
            directory: normalized.endsWith('/'),
        };
    });
    const files = [];
    await promises_1.default.mkdir(destination, { recursive: true });
    await copyDirectory(projectRoot, '', destination, [], customExcludes, options.includeEnv, files);
    if (options.runtimeSource) {
        const runtimeSource = node_path_1.default.resolve(options.runtimeSource);
        const runtimeDestination = node_path_1.default.join(destination, 'ui-ios-runtime');
        await promises_1.default.cp(runtimeSource, runtimeDestination, {
            recursive: true,
            filter: (sourcePath) => {
                const relativePath = node_path_1.default.relative(runtimeSource, sourcePath);
                return relativePath === '' || !relativePath.split(node_path_1.default.sep).some((segment) => HARD_EXCLUDED_SEGMENTS.has(segment));
            },
        });
        const walkRuntime = async (directory, relative = 'ui-ios-runtime') => {
            for (const entry of await promises_1.default.readdir(directory, { withFileTypes: true })) {
                const itemPath = node_path_1.default.join(directory, entry.name);
                const itemRelative = toPosix(node_path_1.default.posix.join(relative, entry.name));
                if (entry.isDirectory())
                    await walkRuntime(itemPath, itemRelative);
                else if (entry.isFile())
                    files.push({ path: itemRelative, bytes: (await promises_1.default.stat(itemPath)).size });
            }
        };
        await walkRuntime(runtimeDestination);
    }
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const largestFiles = [...files].sort((left, right) => right.bytes - left.bytes).slice(0, 20);
    if (totalBytes > maxBytes)
        throw new SnapshotTooLargeError(totalBytes, largestFiles);
    return { files: files.length, bytes: totalBytes, largestFiles, destination };
}
//# sourceMappingURL=snapshot.js.map