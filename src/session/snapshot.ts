import fs from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import picomatch from 'picomatch';

const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const HARD_EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules']);
const HARD_EXCLUDED_PATHS = new Set([
  'android',
  '.ui-ios',
  'ui-ios-runtime',
  'ios/Pods',
  'ios/build',
]);

export interface SnapshotOptions {
  projectRoot: string;
  destination: string;
  excludeGlobs: string[];
  includeEnv: boolean;
  maxBytes?: number;
  runtimeSource?: string;
}

export interface SnapshotFile {
  path: string;
  bytes: number;
}

export interface SnapshotResult {
  files: number;
  bytes: number;
  largestFiles: SnapshotFile[];
  destination: string;
}

interface IgnoreLayer {
  directory: string;
  matcher: ReturnType<typeof ignore>;
}

interface CustomExclude {
  pattern: string;
  matcher: (value: string) => boolean;
  basename: boolean;
  directory: boolean;
}

export class SnapshotTooLargeError extends Error {
  readonly largestFiles: SnapshotFile[];
  readonly totalBytes: number;

  constructor(totalBytes: number, largestFiles: SnapshotFile[]) {
    super(`Project snapshot is ${formatBytes(totalBytes)}, above the 100 MB upload limit.`);
    this.name = 'SnapshotTooLargeError';
    this.totalBytes = totalBytes;
    this.largestFiles = largestFiles;
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isEnvironmentFile(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => segment.startsWith('.env'));
}

function isHardExcluded(relativePath: string): boolean {
  const segments = relativePath.split('/');
  if (segments.some((segment) => HARD_EXCLUDED_SEGMENTS.has(segment))) return true;
  if (HARD_EXCLUDED_PATHS.has(relativePath)) return true;
  return relativePath.startsWith('ios/Pods/') || relativePath.startsWith('ios/build/');
}

function matchesCustomExclude(relativePath: string, globs: CustomExclude[]): boolean {
  return globs.some(({ pattern, matcher, basename, directory }) => {
    if (matcher(relativePath)) return true;
    if (basename && relativePath.split('/').some((segment) => matcher(segment))) return true;
    const directoryPath = pattern.slice(0, -1);
    return directory && (relativePath === directoryPath || relativePath.startsWith(pattern));
  });
}

function isIgnoredByLayers(relativePath: string, layers: IgnoreLayer[]): boolean {
  let ignored = false;
  for (const layer of layers) {
    if (layer.directory && relativePath !== layer.directory &&
        !relativePath.startsWith(`${layer.directory}/`)) continue;
    const relativeToLayer = layer.directory
      ? path.posix.relative(layer.directory, relativePath)
      : relativePath;
    const result = layer.matcher.test(relativeToLayer);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

async function readIgnoreLayer(directory: string, relativeDirectory: string): Promise<IgnoreLayer | null> {
  const ignorePath = path.join(directory, '.gitignore');
  try {
    const contents = await fs.readFile(ignorePath, 'utf8');
    return {
      directory: relativeDirectory,
      matcher: ignore().add(contents.replace(/^\uFEFF/, '')),
    };
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

async function copyDirectory(
  sourceDirectory: string,
  relativeDirectory: string,
  destination: string,
  layers: IgnoreLayer[],
    customExcludes: CustomExclude[],
  includeEnv: boolean,
  files: SnapshotFile[],
): Promise<void> {
  const ownIgnoreLayer = await readIgnoreLayer(sourceDirectory, relativeDirectory);
  const activeLayers = ownIgnoreLayer ? [...layers, ownIgnoreLayer] : layers;
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = toPosix(path.posix.join(relativeDirectory, entry.name));
    if (isHardExcluded(relativePath)) continue;
    if (!includeEnv && isEnvironmentFile(relativePath)) continue;
    if (matchesCustomExclude(relativePath, customExcludes)) continue;

    const ignored = !(includeEnv && isEnvironmentFile(relativePath)) && isIgnoredByLayers(relativePath, activeLayers);
    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destination, ...relativePath.split('/'));

    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (ignored) continue;
      await copyDirectory(
        sourcePath,
        relativePath,
        destination,
        activeLayers,
        customExcludes,
        includeEnv,
        files,
      );
      continue;
    }
    if (!entry.isFile() || ignored) continue;

    const stat = await fs.stat(sourcePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    files.push({ path: relativePath, bytes: stat.size });
  }
}

export async function createProjectSnapshot(options: SnapshotOptions): Promise<SnapshotResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const destination = path.resolve(options.destination);
  const maxBytes = options.maxBytes ?? MAX_SNAPSHOT_BYTES;
  const customExcludes = options.excludeGlobs.map((pattern) => {
    const normalized = pattern.replace(/\\/g, '/');
    return {
      pattern: normalized,
      matcher: picomatch(normalized, { dot: true }),
      basename: !normalized.includes('/'),
      directory: normalized.endsWith('/'),
    };
  });
  const files: SnapshotFile[] = [];

  await fs.mkdir(destination, { recursive: true });
  await copyDirectory(projectRoot, '', destination, [], customExcludes, options.includeEnv, files);

  if (options.runtimeSource) {
    const runtimeSource = path.resolve(options.runtimeSource);
    const runtimeDestination = path.join(destination, 'ui-ios-runtime');
    await fs.cp(runtimeSource, runtimeDestination, {
      recursive: true,
      filter: (sourcePath) => {
        const relativePath = path.relative(runtimeSource, sourcePath);
        return relativePath === '' || !relativePath.split(path.sep).some((segment) => HARD_EXCLUDED_SEGMENTS.has(segment));
      },
    });
    const walkRuntime = async (directory: string, relative = 'ui-ios-runtime'): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const itemPath = path.join(directory, entry.name);
        const itemRelative = toPosix(path.posix.join(relative, entry.name));
        if (entry.isDirectory()) await walkRuntime(itemPath, itemRelative);
        else if (entry.isFile()) files.push({ path: itemRelative, bytes: (await fs.stat(itemPath)).size });
      }
    };
    await walkRuntime(runtimeDestination);
  }

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const largestFiles = [...files].sort((left, right) => right.bytes - left.bytes).slice(0, 20);
  if (totalBytes > maxBytes) throw new SnapshotTooLargeError(totalBytes, largestFiles);

  return { files: files.length, bytes: totalBytes, largestFiles, destination };
}

export { formatBytes };
