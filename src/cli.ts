import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  DEVICE_CATALOG,
  configPath,
  readConfig,
  serializeConfig,
} from './session/config';
import { GitHubClient, GitHubResult } from './session/github';
import { createProjectSnapshot, SnapshotTooLargeError } from './session/snapshot';
import { DevicePreset, GitHubRun, SessionState } from './session/types';

const { detectReactNativeProject } = require('./utils/detector.js') as {
  detectReactNativeProject: (cwd: string) => {
    valid: boolean;
    reason?: string;
    hasIosDir?: boolean;
    isExpo?: boolean;
    appName?: string;
    rnVersion?: string;
    packageManager?: string;
    projectName?: string;
  };
};
const { runInit } = require('./commands/init.js') as {
  runInit: (options: Record<string, unknown>) => Promise<void>;
};

const program = new Command();
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_ROOT = path.join(PACKAGE_ROOT, 'templates');
const PAGES_ORIGIN_SUFFIX = '.github.io';
const TOOL_REPOSITORY = 'ui-ios';
let activeSession: { github: GitHubClient; state: SessionState; stopped: boolean } | null = null;
let cancelOnSigint: (() => Promise<void>) | null = null;

program
  .name('ui-ios')
  .description('Open a personal, remote iOS Simulator preview for a React Native project.')
  .version('1.0.0');

program
  .command('init')
  .description('Initialize the existing Detox setup and create ui-ios.config.json.')
  .option('--dry-run', 'Show the planned setup without writing files or installing packages')
  .option('--skip-install', 'Do not install Detox and Jest')
  .option('--simulator <name>', 'Set the legacy Detox simulator name')
  .option('--yes', 'Leave existing generated files unchanged')
  .option('--force', 'Replace existing generated files and ui-ios.config.json')
  .action(async (options: Record<string, unknown>) => {
    await runInit(options);
    if (options.dryRun || process.exitCode) return;

    const cwd = process.cwd();
    const project = detectReactNativeProject(cwd);
    if (!project.valid) return;
    const filePath = configPath(cwd);
    if (fs.existsSync(filePath) && !options.force) {
      console.log(`${CONFIG_FILE} already exists; it was left unchanged.`);
      return;
    }
    await fsp.writeFile(filePath, serializeConfig(DEFAULT_CONFIG), 'utf8');
    console.log(`Created ${chalk.cyan(CONFIG_FILE)}. Review its device, idle timeout, and exclusion settings before running a session.`);
    if (project.isExpo && !project.hasIosDir) {
      console.log(chalk.blue('This Expo project has no ios/ directory. The macOS session runner will generate the iOS project from the Expo config.'));
    }
  });

program
  .command('start')
  .description('Upload a filtered project snapshot and open the live simulator in GitHub Pages.')
  .option('--device <model>', `Choose a configured simulator (${DEVICE_CATALOG.devices.map((device: { id: string }) => device.id).join(', ')})`)
  .option('--verbose', 'Show detailed workflow progress')
  .option('--include-env', 'Include .env files after an explicit warning')
  .action(async (options: { device?: string; verbose?: boolean; includeEnv?: boolean }) => {
    await startSession(options);
  });

program.command('stop').description('Cancel the active simulator run and remove its temporary branch.').action(stopSession);
program.command('status').description('Show the current local session state.').action(showStatus);
program.command('logs').description('Show the GitHub Actions log for the current session.').action(showLogs);
program.command('doctor').description('Check local tools, GitHub access, project type, and configuration.').action(runDoctor);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`ui-ios: ${message}`));
  process.exitCode = 1;
});

process.once('SIGINT', () => {
  if (!activeSession && !cancelOnSigint) {
    process.exit(130);
  }
  console.log('\nStopping the remote simulator and removing the temporary session branch...');
  if (activeSession) activeSession.stopped = true;
  const cleanup = activeSession
    ? () => cleanupSession(activeSession!.github, activeSession!.state)
    : cancelOnSigint!;
  cancelOnSigint = null;
  void cleanup()
    .catch((error: unknown) => console.error(chalk.red(`Cleanup needs attention: ${errorMessage(error)}`)))
    .finally(() => process.exit(130));
});

async function startSession(options: { device?: string; verbose?: boolean; includeEnv?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const project = detectReactNativeProject(cwd);
  if (!project.valid) throw new Error(project.reason ?? 'This is not a React Native project.');

  if (!project.hasIosDir) {
    if (!project.isExpo) {
      throw new Error('No ios/ directory was found. This React Native project needs an iOS native project before a simulator build.');
    }
    console.log(chalk.blue('Expo iOS native files will be generated on the macOS runner; no local prebuild is needed.'));
  }

  const configFile = configPath(cwd);
  if (!fs.existsSync(configFile)) throw new Error(`No ${CONFIG_FILE} found. Run 'ui-ios init' once in this project.`);
  let config = readConfig(cwd);
  const device = normalizeDevice(options.device ?? config.defaultDevice, config.devices);
  const deviceSpec = DEVICE_CATALOG.devices.find((entry) => entry.id === device);
  if (!deviceSpec) throw new Error(`Unknown simulator device "${device}".`);

  if (!config.warningAcknowledged) {
    console.log(chalk.yellow('GitHub Actions is a CI service, not a persistent remote desktop. This personal preview runs a macOS job for up to 5h30; private-repository macOS minutes are billed at 10× the standard rate and may exceed your included quota.'));
    console.log(chalk.yellow('Use it only for personal development and testing. GitHub terms caution against using Actions as a serverless application or creating disproportionate load.'));
    await requireConfirmation('I understand the GitHub Actions cost and usage limits. Continue?', false);
    config = { ...config, warningAcknowledged: true };
    await fsp.writeFile(configFile, serializeConfig(config), 'utf8');
  }

  const includeEnv = Boolean(options.includeEnv || config.includeEnv);
  if (includeEnv) {
    console.log(chalk.red('Warning: --include-env uploads .env files to your private session repository. Anyone with access to that repository can read them.'));
    await requireConfirmation('Include .env files in this upload?', false);
  }

  const github = await GitHubClient.create();
  const repository = config.sessionRepository || `${github.owner}/ui-ios-sessions`;
  const [repositoryOwner, repositoryName] = repository.split('/');
  if (repositoryOwner.toLowerCase() !== github.owner.toLowerCase()) {
    throw new Error(`The sessions repository must belong to your authenticated account (${github.owner}).`);
  }
  if (!config.sessionRepository) {
    config = { ...config, sessionRepository: repository };
    await fsp.writeFile(configFile, serializeConfig(config), 'utf8');
  }

  let isNewRepository = false;
  if (!(await github.repositoryExists(repository))) {
    console.log(`The private ${repository} repository will store temporary app snapshots and the runner workflow.`);
    await requireConfirmation(`Create the private GitHub repository ${repository}?`, false);
    await github.createPrivateRepository(repositoryName);
    isNewRepository = true;
    try {
      await seedSessionsRepository(github, repository);
    } catch (error) {
      throw new Error(`The private repository was created but could not be initialized: ${errorMessage(error)}. It was left in place; retry after resolving the issue.`);
    }
  }

  const repositoryInfo = await github.getRepository(repository);
  if (repositoryInfo.visibility !== 'private') {
    throw new Error(`${repository} is ${repositoryInfo.visibility}, but session snapshots must remain private. No files were uploaded.`);
  }
  if (!repositoryInfo.permissions?.push && !isNewRepository) {
    throw new Error(`The current GitHub account does not have push permission for ${repository}.`);
  }
  if (!(await github.hasSessionWorkflow(repository, repositoryInfo.defaultBranch))) {
    throw new Error(`${repository} does not contain .github/workflows/ui-ios-session.yml on its default branch. It was left unchanged; initialize it from this tool's session template before retrying.`);
  }

  const activeRuns = await github.getActiveRuns(repository);
  if (activeRuns.length > 0) {
    const run = activeRuns[0];
    throw new Error(`A simulator session is already active (${run.url}). Run 'ui-ios stop' in that project before starting another.`);
  }

  const sessionId = randomUUID();
  const branch = `session/${sessionId}`;
  const token = randomBytes(32).toString('hex');
  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ui-ios-session-'));
  const snapshotRoot = path.join(temporaryRoot, 'snapshot');
  let branchPushed = false;
  let dispatchState: SessionState | null = null;
  try {
    const snapshot = await createProjectSnapshot({
      projectRoot: cwd,
      destination: snapshotRoot,
      excludeGlobs: config.excludeGlobs,
      includeEnv,
      runtimeSource: path.join(TEMPLATE_ROOT, 'runtime'),
    });
    console.log(`Snapshot prepared: ${snapshot.files} files, ${formatBytes(snapshot.bytes)}.`);
    await pushOrphanSnapshot(github, repository, branch, snapshotRoot);
    branchPushed = true;
    cancelOnSigint = () => github.deleteBranch(repository, branch);
    console.log('Snapshot uploaded to a temporary orphan branch. The app project Git repository was not used or modified.');

    const runUrl = await github.dispatchWorkflow(repository, 'ui-ios-session.yml', repositoryInfo.defaultBranch, {
      session_id: sessionId,
      session_branch: branch,
      device,
      runner_label: deviceSpec.runnerLabel,
      session_token: token,
    });
    const runId = await github.findRunId(runUrl);
    const state: SessionState = {
      version: 1,
      sessionId,
      repository,
      branch,
      runId,
      runUrl,
      device,
      createdAt: new Date().toISOString(),
      projectRoot: cwd,
    };
    dispatchState = state;
    await saveState(state);
    activeSession = { github, state, stopped: false };
    cancelOnSigint = () => cleanupSession(github, state);
    console.log(`GitHub Actions run queued: ${runUrl}`);
    console.log('Waiting for a macOS runner. The first startup can take several minutes while dependencies and CocoaPods are installed.');

    let lastProgress = '';
    let queueStarted = Date.now();
    let ready = false;
    let activeTunnelHost = '';
    let sessionEnded = false;
    while (!sessionEnded) {
      const run = await github.getRun(repository, runId);
      const progress = summarizeProgress(run, queueStarted);
      if (options.verbose || progress.label !== lastProgress) {
        console.log(progress.message);
        lastProgress = progress.label;
      }
      if (run.startedAt) queueStarted = new Date(run.createdAt).getTime();

      const metadataText = await github.getSessionMetadata(repository, branch);
      if (metadataText) {
        const metadata = JSON.parse(metadataText) as {
          sessionId?: string;
          tunnelHost?: string;
          deviceName?: string;
          bootSeconds?: number;
          logicalSize?: { width: number; height: number };
        };
        if (metadata.sessionId === sessionId && metadata.tunnelHost && metadata.tunnelHost !== activeTunnelHost && /^[a-z0-9-]+\.trycloudflare\.com$/i.test(metadata.tunnelHost)) {
          const pagesUrl = `https://${github.owner}${PAGES_ORIGIN_SUFFIX}/${TOOL_REPOSITORY}/`;
          const sessionUrl = `${pagesUrl}#t=${token}&s=${metadata.tunnelHost}&id=${encodeURIComponent(sessionId)}`;
          if (!ready) console.log(chalk.green(`Simulator ready: ${metadata.deviceName ?? device}${metadata.logicalSize ? ` (${metadata.logicalSize.width}×${metadata.logicalSize.height})` : ''}${metadata.bootSeconds ? `; boot ${metadata.bootSeconds}s` : ''}.`));
          else console.log(chalk.yellow('The temporary tunnel changed; opening a replacement session tab.'));
          console.log('Opening the private session link in your browser. The token is in the URL fragment and will not be sent to GitHub Pages.');
          openBrowser(sessionUrl);
          ready = true;
          activeTunnelHost = metadata.tunnelHost;
        }
      }

      if (run.status === 'completed') {
        if (ready) {
          console.log(`Session ended (${run.conclusion ?? 'completed'}). Removing its temporary branch.`);
          await cleanupSession(github, state);
          activeSession = null;
          cancelOnSigint = null;
          sessionEnded = true;
          continue;
        }
        const logs = await github.showRunLogs(repository, runId).catch((error: unknown) => `Could not read run logs: ${errorMessage(error)}`);
        throw new Error(`The iOS simulator job ended with ${run.conclusion ?? 'an unknown result'}. Last 100 log lines:\n${lastLines(logs, 100)}\nCheck the Xcode project, CocoaPods setup, and the Actions run log.`);
      }
      await delay(5000);
    }

    if (!ready) throw new Error('The simulator did not publish its session metadata.');
  } catch (error) {
    if (dispatchState) {
      await cleanupSession(github, dispatchState).catch(() => undefined);
      activeSession = null;
    } else if (branchPushed) {
      await github.deleteBranch(repository, branch).catch(() => undefined);
    }
    cancelOnSigint = null;
    await clearState(cwd);
    if (error instanceof SnapshotTooLargeError) {
      const listing = error.largestFiles.map((file) => `  ${formatBytes(file.bytes)}  ${file.path}`).join('\n');
      throw new Error(`${error.message}\nLargest files:\n${listing}\nAdd large paths to excludeGlobs in ${CONFIG_FILE} (for example build output, media, or local assets not needed by the simulator).`);
    }
    throw error;
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function stopSession(): Promise<void> {
  const state = await readState(process.cwd());
  if (!state) {
    console.log('No active ui-ios session was found for this project on this computer.');
    return;
  }
  const github = await GitHubClient.create();
  await cleanupSession(github, state);
  activeSession = null;
  console.log('Simulator run cancelled and temporary branch removed.');
}

async function showStatus(): Promise<void> {
  const state = await readState(process.cwd());
  if (!state) {
    console.log('No local ui-ios session is recorded for this project.');
    return;
  }
  const github = await GitHubClient.create();
  const run = await github.getRun(state.repository, state.runId);
  console.log(`Session: ${state.sessionId}`);
  console.log(`Device request: ${state.device}`);
  console.log(`Actions: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ''}`);
  console.log(`Run: ${state.runUrl}`);
  if (run.startedAt) console.log(`Runner started: ${run.startedAt}`);
  if (run.status === 'completed') console.log('The session has ended. Run `ui-ios stop` to remove any remaining local state.');
}

async function showLogs(): Promise<void> {
  const state = await readState(process.cwd());
  if (!state) throw new Error('No local session was found. Run `ui-ios start` in the project first.');
  const github = await GitHubClient.create();
  console.log(await github.showRunLogs(state.repository, state.runId));
}

async function runDoctor(): Promise<void> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.log(`${nodeMajor >= 18 ? chalk.green('PASS') : chalk.red('FAIL')} Node.js ${process.versions.node} (requires 18+)`);
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  console.log(`${git.status === 0 ? chalk.green('PASS') : chalk.red('FAIL')} Git ${git.status === 0 ? git.stdout.trim() : 'not found on PATH'}`);
  const project = detectReactNativeProject(process.cwd());
  console.log(`${project.valid && project.hasIosDir ? chalk.green('PASS') : chalk.yellow('CHECK')} ${project.valid ? `React Native ${project.rnVersion}; ios/: ${project.hasIosDir ? 'present' : 'missing'}` : project.reason}`);
  try {
    const config = readConfig(process.cwd());
    console.log(`${chalk.green('PASS')} ${CONFIG_FILE} is valid; sessions repository: ${config.sessionRepository || '(uses your account/ui-ios-sessions)'}`);
  } catch (error) {
    console.log(`${chalk.yellow('CHECK')} ${errorMessage(error)}`);
  }
  try {
    const github = await GitHubClient.create();
    console.log(`${chalk.green('PASS')} GitHub CLI authenticated as ${github.owner}.`);
    try {
      const repository = readConfig(process.cwd()).sessionRepository || `${github.owner}/ui-ios-sessions`;
      const repo = await github.getRepository(repository);
      console.log(`${repo.visibility === 'private' && repo.permissions?.push ? chalk.green('PASS') : chalk.yellow('CHECK')} ${repository}: ${repo.visibility}, push=${Boolean(repo.permissions?.push)}`);
    } catch {
      console.log(`${chalk.yellow('CHECK')} Sessions repository does not exist yet or is not accessible.`);
    }
  } catch (error) {
    console.log(`${chalk.red('FAIL')} GitHub CLI access: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function requireConfirmation(message: string, defaultValue: boolean): Promise<void> {
  if (!process.stdin.isTTY) throw new Error(`${message} Start this command in an interactive terminal to confirm.`);
  const answer = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirmed',
    default: defaultValue,
    message,
  }]);
  if (!answer.confirmed) throw new Error('Cancelled. No session was started.');
}

async function seedSessionsRepository(github: GitHubClient, repository: string): Promise<void> {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ui-ios-session-repo-'));
  try {
    await copyTree(path.join(TEMPLATE_ROOT, 'session'), temp);
    await git(['init', '-b', 'main'], temp);
    await git(['config', 'user.name', 'ui-ios setup'], temp);
    await git(['config', 'user.email', 'ui-ios@users.noreply.github.com'], temp);
    await git(['add', '--all'], temp);
    await git(['commit', '-m', 'Initialize ui-ios session runner'], temp);
    await gitWithGitHubToken(github, ['push', 'https://github.com/' + repository + '.git', 'HEAD:refs/heads/main'], temp);
    await github.setDefaultBranch(repository, 'main');
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

async function pushOrphanSnapshot(github: GitHubClient, repository: string, branch: string, snapshotRoot: string): Promise<void> {
  await git(['init', '-b', 'main'], snapshotRoot);
  await git(['config', 'user.name', 'ui-ios session'], snapshotRoot);
  await git(['config', 'user.email', 'ui-ios@users.noreply.github.com'], snapshotRoot);
  await git(['add', '--all'], snapshotRoot);
  await git(['commit', '-m', `ui-ios session ${branch.slice('session/'.length)}`], snapshotRoot);
  await gitWithGitHubToken(github, ['push', 'https://github.com/' + repository + '.git', `HEAD:refs/heads/${branch}`], snapshotRoot);
}

async function git(args: string[], cwd: string): Promise<GitHubResult> {
  return runProcess('git', args, cwd);
}

async function gitWithGitHubToken(github: GitHubClient, args: string[], cwd: string): Promise<GitHubResult> {
  const authorization = Buffer.from(`x-access-token:${github.token}`).toString('base64');
  return runProcess('git', args, cwd, {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
    GIT_TERMINAL_PROMPT: '0',
  }, github.token);
}

function runProcess(command: string, args: string[], cwd: string, extraEnv: Record<string, string | undefined> = {}, secret = ''): Promise<GitHubResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => reject(new Error(redact(error.message, secret))));
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(redact(stderr.trim() || `${command} exited with code ${code}.`, secret)));
      else resolve({ stdout, stderr });
    });
  });
}

async function cleanupSession(github: GitHubClient, state: SessionState): Promise<void> {
  try {
    const run = await github.getRun(state.repository, state.runId);
    if (run.status !== 'completed') await github.cancelRun(state.repository, state.runId);
  } catch (error) {
    console.error(`Could not cancel run ${state.runId}: ${errorMessage(error)}`);
  }
  try {
    await github.deleteBranch(state.repository, state.branch);
  } finally {
    await clearState(state.projectRoot);
  }
}

async function saveState(state: SessionState): Promise<void> {
  const filePath = await statePath(state.projectRoot);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function readState(projectRoot: string): Promise<SessionState | null> {
  try {
    const contents = await fsp.readFile(await statePath(projectRoot), 'utf8');
    const state = JSON.parse(contents) as SessionState;
    if (state.version !== 1 || state.projectRoot !== projectRoot) return null;
    return state;
  } catch {
    return null;
  }
}

async function clearState(projectRoot: string): Promise<void> {
  await fsp.rm(await statePath(projectRoot), { force: true });
}

async function statePath(projectRoot: string): Promise<string> {
  const normalized = path.resolve(projectRoot).toLowerCase();
  const key = createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), 'ui-ios-sessions', `${key}.json`);
}

async function copyTree(source: string, destination: string): Promise<void> {
  await fsp.mkdir(destination, { recursive: true });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}

function openBrowser(url: string): void {
  let command = '';
  let args: string[] = [];
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', `start "" "${url}"`];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', () => {
    console.error('Could not open the browser automatically. Check `ui-ios status`, then stop or restart the session from the project terminal.');
  });
  child.unref();
}

function summarizeProgress(run: GitHubRun, queuedAt: number): { label: string; message: string } {
  if (run.status === 'queued' || run.status === 'requested' || run.status === 'waiting' || run.status === 'pending') {
    const seconds = Math.max(0, Math.round((Date.now() - queuedAt) / 1000));
    return { label: `queued:${Math.floor(seconds / 30)}`, message: `Runner queue: waiting ${formatDuration(seconds)}.` };
  }
  const steps = run.jobs?.flatMap((job) => job.steps.map((step) => ({ job: job.name, ...step }))) ?? [];
  const current = steps.find((step) => step.status === 'in_progress');
  if (current) return { label: `${current.job}:${current.name}`, message: `Runner: ${current.job} · ${current.name}` };
  const finished = steps.filter((step) => step.conclusion === 'success').length;
  return { label: `${run.status}:${finished}`, message: `Runner: ${run.status}; ${finished} steps completed.` };
}

function normalizeDevice(value: string, allowed: DevicePreset[]): DevicePreset {
  const normalized = value === 'latest' ? 'iphone17' : value;
  if (!allowed.includes(normalized)) {
    throw new Error(`Device "${value}" is not enabled in ${CONFIG_FILE}. Enabled devices: ${allowed.join(', ')}.`);
  }
  return normalized;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function lastLines(value: string, count: number): string {
  return value.split(/\r?\n/).filter(Boolean).slice(-count).join('\n');
}

function redact(value: string, secret: string): string {
  return secret ? value.split(secret).join('[REDACTED]') : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
