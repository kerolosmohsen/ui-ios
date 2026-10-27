"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const commander_1 = require("commander");
const inquirer_1 = __importDefault(require("inquirer"));
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("./session/config");
const github_1 = require("./session/github");
const snapshot_1 = require("./session/snapshot");
const { detectReactNativeProject } = require('./utils/detector.js');
const { runInit } = require('./commands/init.js');
const program = new commander_1.Command();
const PACKAGE_ROOT = node_path_1.default.resolve(__dirname, '..');
const TEMPLATE_ROOT = node_path_1.default.join(PACKAGE_ROOT, 'templates');
const PAGES_ORIGIN_SUFFIX = '.github.io';
const TOOL_REPOSITORY = 'ui-ios';
let activeSession = null;
let cancelOnSigint = null;
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
    .action(async (options) => {
    await runInit(options);
    if (options.dryRun || process.exitCode)
        return;
    const cwd = process.cwd();
    const project = detectReactNativeProject(cwd);
    if (!project.valid)
        return;
    const filePath = (0, config_1.configPath)(cwd);
    if (node_fs_1.default.existsSync(filePath) && !options.force) {
        console.log(`${config_1.CONFIG_FILE} already exists; it was left unchanged.`);
        return;
    }
    await promises_1.default.writeFile(filePath, (0, config_1.serializeConfig)(config_1.DEFAULT_CONFIG), 'utf8');
    console.log(`Created ${chalk_1.default.cyan(config_1.CONFIG_FILE)}. Review its device, idle timeout, and exclusion settings before running a session.`);
    if (project.isExpo && !project.hasIosDir) {
        console.log(chalk_1.default.blue('This Expo project has no ios/ directory. The macOS session runner will generate the iOS project from the Expo config.'));
    }
});
program
    .command('start')
    .description('Upload a filtered project snapshot and open the live simulator in GitHub Pages.')
    .option('--device <model>', `Choose a configured simulator (${config_1.DEVICE_CATALOG.devices.map((device) => device.id).join(', ')})`)
    .option('--verbose', 'Show detailed workflow progress')
    .option('--include-env', 'Include .env files after an explicit warning')
    .action(async (options) => {
    await startSession(options);
});
program.command('stop').description('Cancel the active simulator run and remove its temporary branch.').action(stopSession);
program.command('status').description('Show the current local session state.').action(showStatus);
program.command('logs').description('Show the GitHub Actions log for the current session.').action(showLogs);
program.command('doctor').description('Check local tools, GitHub access, project type, and configuration.').action(runDoctor);
program.parseAsync(process.argv).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk_1.default.red(`ui-ios: ${message}`));
    process.exitCode = 1;
});
process.once('SIGINT', () => {
    if (!activeSession && !cancelOnSigint) {
        process.exit(130);
    }
    console.log('\nStopping the remote simulator and removing the temporary session branch...');
    if (activeSession)
        activeSession.stopped = true;
    const cleanup = activeSession
        ? () => cleanupSession(activeSession.github, activeSession.state)
        : cancelOnSigint;
    cancelOnSigint = null;
    void cleanup()
        .catch((error) => console.error(chalk_1.default.red(`Cleanup needs attention: ${errorMessage(error)}`)))
        .finally(() => process.exit(130));
});
async function startSession(options) {
    const cwd = process.cwd();
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (nodeMajor < 18)
        throw new Error(`Node.js ${process.versions.node} is too old. ui-ios requires Node.js 18 or newer.`);
    const gitCheck = (0, node_child_process_1.spawnSync)('git', ['--version'], { encoding: 'utf8', windowsHide: true });
    if (gitCheck.status !== 0)
        throw new Error('Git was not found on PATH. Install Git and reopen the project terminal before starting the preview.');
    const project = detectReactNativeProject(cwd);
    if (!project.valid)
        throw new Error(project.reason ?? 'This is not a React Native project.');
    if (project.hasIosDir && !project.workspaceName && !project.projectFile) {
        throw new Error('The ios/ directory contains no .xcworkspace or .xcodeproj. Restore the native Xcode project or use an Expo project so ui-ios can generate it on macOS.');
    }
    if (!project.hasIosDir) {
        if (!project.isExpo) {
            throw new Error('No ios/ directory was found. This React Native project needs an iOS native project before a simulator build.');
        }
        console.log(chalk_1.default.blue('Expo iOS native files will be generated on the macOS runner; no local prebuild is needed.'));
    }
    const configFile = (0, config_1.configPath)(cwd);
    if (!node_fs_1.default.existsSync(configFile))
        throw new Error(`No ${config_1.CONFIG_FILE} found. Run 'ui-ios init' once in this project.`);
    let config = (0, config_1.readConfig)(cwd);
    const device = normalizeDevice(options.device ?? config.defaultDevice, config.devices);
    const deviceSpec = config_1.DEVICE_CATALOG.devices.find((entry) => entry.id === device);
    if (!deviceSpec)
        throw new Error(`Unknown simulator device "${device}".`);
    const packageManager = project.packageManager ?? 'npm';
    const iosPreparation = project.hasIosDir
        ? 'validate the existing iOS project'
        : 'generate the Expo iOS project on macOS';
    console.log(`macOS setup for ${deviceSpec.label}: install ${packageManager} dependencies, ${iosPreparation}, check/install CocoaPods, build the app, then launch the simulator with IDB and a private tunnel.`);
    console.log('The snapshot excludes .env files by default. If the app needs them, `--include-env` uploads them to your private sessions repository after another warning and confirmation.');
    if (!config.warningAcknowledged) {
        console.log(chalk_1.default.yellow('GitHub Actions is a CI service, not a persistent remote desktop. This personal preview runs a macOS job for up to 5h30; private-repository macOS minutes are billed at 10× the standard rate and may exceed your included quota.'));
        console.log(chalk_1.default.yellow('Use it only for personal development and testing. GitHub terms caution against using Actions as a serverless application or creating disproportionate load.'));
        await requireConfirmation('I understand the GitHub Actions cost and usage limits. Continue?', false);
        config = { ...config, warningAcknowledged: true };
        await promises_1.default.writeFile(configFile, (0, config_1.serializeConfig)(config), 'utf8');
    }
    const includeEnv = Boolean(options.includeEnv || config.includeEnv);
    if (includeEnv) {
        console.log(chalk_1.default.red('Warning: --include-env uploads .env files to your private session repository. Anyone with access to that repository can read them.'));
        await requireConfirmation('Include .env files in this upload?', false);
    }
    const github = await github_1.GitHubClient.create();
    const repository = config.sessionRepository || `${github.owner}/ui-ios-sessions`;
    const [repositoryOwner, repositoryName] = repository.split('/');
    if (repositoryOwner.toLowerCase() !== github.owner.toLowerCase()) {
        throw new Error(`The sessions repository must belong to your authenticated account (${github.owner}).`);
    }
    if (!config.sessionRepository) {
        config = { ...config, sessionRepository: repository };
        await promises_1.default.writeFile(configFile, (0, config_1.serializeConfig)(config), 'utf8');
    }
    let isNewRepository = false;
    if (!(await github.repositoryExists(repository))) {
        console.log(`The private ${repository} repository will store temporary app snapshots and the runner workflow.`);
        await requireConfirmation(`Create the private GitHub repository ${repository}?`, false);
        await github.createPrivateRepository(repositoryName);
        isNewRepository = true;
        try {
            await seedSessionsRepository(github, repository);
        }
        catch (error) {
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
    const sessionId = (0, node_crypto_1.randomUUID)();
    const branch = `session/${sessionId}`;
    const token = (0, node_crypto_1.randomBytes)(32).toString('hex');
    const temporaryRoot = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), 'ui-ios-session-'));
    const snapshotRoot = node_path_1.default.join(temporaryRoot, 'snapshot');
    let branchPushed = false;
    let dispatchState = null;
    try {
        const snapshot = await (0, snapshot_1.createProjectSnapshot)({
            projectRoot: cwd,
            destination: snapshotRoot,
            excludeGlobs: config.excludeGlobs,
            includeEnv,
            runtimeSource: node_path_1.default.join(TEMPLATE_ROOT, 'runtime'),
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
        const state = {
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
            if (run.startedAt)
                queueStarted = new Date(run.createdAt).getTime();
            const metadataText = await github.getSessionMetadata(repository, branch);
            if (metadataText) {
                const metadata = JSON.parse(metadataText);
                if (metadata.sessionId === sessionId && metadata.tunnelHost && metadata.tunnelHost !== activeTunnelHost && /^[a-z0-9-]+\.trycloudflare\.com$/i.test(metadata.tunnelHost)) {
                    const pagesUrl = `https://${github.owner}${PAGES_ORIGIN_SUFFIX}/${TOOL_REPOSITORY}/`;
                    const sessionUrl = `${pagesUrl}#t=${token}&s=${metadata.tunnelHost}&id=${encodeURIComponent(sessionId)}`;
                    const shortSessionId = sessionId.slice(0, 8);
                    if (!ready)
                        console.log(chalk_1.default.green(`Simulator ready: ${metadata.deviceName ?? device}${metadata.logicalSize ? ` (${metadata.logicalSize.width}×${metadata.logicalSize.height})` : ''}${metadata.bootSeconds ? `; boot ${metadata.bootSeconds}s` : ''}.`));
                    else
                        console.log(chalk_1.default.yellow('The temporary tunnel changed; opening a replacement session tab.'));
                    console.log(`Session ID: ${shortSessionId}. Use the preview tab whose status shows this same ID.`);
                    console.log('Opening the private session link in your browser. The token is in the URL fragment and will not be sent to GitHub Pages.');
                    openBrowser(sessionUrl);
                    ready = true;
                    activeTunnelHost = metadata.tunnelHost;
                }
            }
            if (run.status === 'completed') {
                if (ready) {
                    const logs = await github.showRunLogs(repository, runId).catch(() => '');
                    if (/Stopping: no viewer heartbeat for 5 minutes/i.test(logs)) {
                        console.log(chalk_1.default.yellow(`The iOS build succeeded, but no browser connected to session ${sessionId.slice(0, 8)} before its five-minute timeout. Use the newest preview tab and check that its status shows the same session ID; older tabs belong to earlier runs.`));
                    }
                    else {
                        console.log(`Session ended (${run.conclusion ?? 'completed'}). Removing its temporary branch.`);
                    }
                    await cleanupSession(github, state);
                    activeSession = null;
                    cancelOnSigint = null;
                    sessionEnded = true;
                    continue;
                }
                const logs = await github.showRunLogs(repository, runId).catch((error) => `Could not read run logs: ${errorMessage(error)}`);
                throw new Error(`The iOS simulator job ended with ${run.conclusion ?? 'an unknown result'}. Last 100 log lines:\n${lastLines(logs, 100)}\nCheck the Xcode project, CocoaPods setup, and the Actions run log.`);
            }
            await delay(5000);
        }
        if (!ready)
            throw new Error('The simulator did not publish its session metadata.');
    }
    catch (error) {
        if (dispatchState) {
            await cleanupSession(github, dispatchState).catch(() => undefined);
            activeSession = null;
        }
        else if (branchPushed) {
            await github.deleteBranch(repository, branch).catch(() => undefined);
        }
        cancelOnSigint = null;
        await clearState(cwd);
        if (error instanceof snapshot_1.SnapshotTooLargeError) {
            const listing = error.largestFiles.map((file) => `  ${formatBytes(file.bytes)}  ${file.path}`).join('\n');
            throw new Error(`${error.message}\nLargest files:\n${listing}\nAdd large paths to excludeGlobs in ${config_1.CONFIG_FILE} (for example build output, media, or local assets not needed by the simulator).`);
        }
        throw error;
    }
    finally {
        await promises_1.default.rm(temporaryRoot, { recursive: true, force: true });
    }
}
async function stopSession() {
    const state = await readState(process.cwd());
    if (!state) {
        console.log('No active ui-ios session was found for this project on this computer.');
        return;
    }
    const github = await github_1.GitHubClient.create();
    await cleanupSession(github, state);
    activeSession = null;
    console.log('Simulator run cancelled and temporary branch removed.');
}
async function showStatus() {
    const state = await readState(process.cwd());
    if (!state) {
        console.log('No local ui-ios session is recorded for this project.');
        return;
    }
    const github = await github_1.GitHubClient.create();
    const run = await github.getRun(state.repository, state.runId);
    console.log(`Session: ${state.sessionId}`);
    console.log(`Device request: ${state.device}`);
    console.log(`Actions: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ''}`);
    console.log(`Run: ${state.runUrl}`);
    if (run.startedAt)
        console.log(`Runner started: ${run.startedAt}`);
    if (run.status === 'completed')
        console.log('The session has ended. Run `ui-ios stop` to remove any remaining local state.');
}
async function showLogs() {
    const state = await readState(process.cwd());
    if (!state)
        throw new Error('No local session was found. Run `ui-ios start` in the project first.');
    const github = await github_1.GitHubClient.create();
    console.log(await github.showRunLogs(state.repository, state.runId));
}
async function runDoctor() {
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    console.log(`${nodeMajor >= 18 ? chalk_1.default.green('PASS') : chalk_1.default.red('FAIL')} Node.js ${process.versions.node} (requires 18+)`);
    const git = (0, node_child_process_1.spawnSync)('git', ['--version'], { encoding: 'utf8', windowsHide: true });
    console.log(`${git.status === 0 ? chalk_1.default.green('PASS') : chalk_1.default.red('FAIL')} Git ${git.status === 0 ? git.stdout.trim() : 'not found on PATH'}`);
    const project = detectReactNativeProject(process.cwd());
    console.log(`${project.valid && project.hasIosDir ? chalk_1.default.green('PASS') : chalk_1.default.yellow('CHECK')} ${project.valid ? `React Native ${project.rnVersion}; ios/: ${project.hasIosDir ? 'present' : 'missing'}` : project.reason}`);
    try {
        const config = (0, config_1.readConfig)(process.cwd());
        console.log(`${chalk_1.default.green('PASS')} ${config_1.CONFIG_FILE} is valid; sessions repository: ${config.sessionRepository || '(uses your account/ui-ios-sessions)'}`);
    }
    catch (error) {
        console.log(`${chalk_1.default.yellow('CHECK')} ${errorMessage(error)}`);
    }
    try {
        const github = await github_1.GitHubClient.create();
        console.log(`${chalk_1.default.green('PASS')} GitHub CLI authenticated as ${github.owner}.`);
        try {
            const repository = (0, config_1.readConfig)(process.cwd()).sessionRepository || `${github.owner}/ui-ios-sessions`;
            const repo = await github.getRepository(repository);
            console.log(`${repo.visibility === 'private' && repo.permissions?.push ? chalk_1.default.green('PASS') : chalk_1.default.yellow('CHECK')} ${repository}: ${repo.visibility}, push=${Boolean(repo.permissions?.push)}`);
        }
        catch {
            console.log(`${chalk_1.default.yellow('CHECK')} Sessions repository does not exist yet or is not accessible.`);
        }
    }
    catch (error) {
        console.log(`${chalk_1.default.red('FAIL')} GitHub CLI access: ${errorMessage(error)}`);
        process.exitCode = 1;
    }
}
async function requireConfirmation(message, defaultValue) {
    if (!process.stdin.isTTY)
        throw new Error(`${message} Start this command in an interactive terminal to confirm.`);
    const answer = await inquirer_1.default.prompt([{
            type: 'confirm',
            name: 'confirmed',
            default: defaultValue,
            message,
        }]);
    if (!answer.confirmed)
        throw new Error('Cancelled. No session was started.');
}
async function seedSessionsRepository(github, repository) {
    const temp = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), 'ui-ios-session-repo-'));
    try {
        await copyTree(node_path_1.default.join(TEMPLATE_ROOT, 'session'), temp);
        await git(['init', '-b', 'main'], temp);
        await git(['config', 'user.name', 'ui-ios setup'], temp);
        await git(['config', 'user.email', 'ui-ios@users.noreply.github.com'], temp);
        await git(['add', '--all'], temp);
        await git(['commit', '-m', 'Initialize ui-ios session runner'], temp);
        await gitWithGitHubToken(github, ['push', 'https://github.com/' + repository + '.git', 'HEAD:refs/heads/main'], temp);
        await github.setDefaultBranch(repository, 'main');
    }
    finally {
        await promises_1.default.rm(temp, { recursive: true, force: true });
    }
}
async function pushOrphanSnapshot(github, repository, branch, snapshotRoot) {
    await git(['init', '-b', 'main'], snapshotRoot);
    await git(['config', 'user.name', 'ui-ios session'], snapshotRoot);
    await git(['config', 'user.email', 'ui-ios@users.noreply.github.com'], snapshotRoot);
    await git(['add', '--all'], snapshotRoot);
    await git(['commit', '-m', `ui-ios session ${branch.slice('session/'.length)}`], snapshotRoot);
    await gitWithGitHubToken(github, ['push', 'https://github.com/' + repository + '.git', `HEAD:refs/heads/${branch}`], snapshotRoot);
}
async function git(args, cwd) {
    return runProcess('git', args, cwd);
}
async function gitWithGitHubToken(github, args, cwd) {
    const authorization = Buffer.from(`x-access-token:${github.token}`).toString('base64');
    return runProcess('git', args, cwd, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
        GIT_TERMINAL_PROMPT: '0',
    }, github.token);
}
function runProcess(command, args, cwd, extraEnv = {}, secret = '') {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args, {
            cwd,
            env: { ...process.env, ...extraEnv },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
        child.once('error', (error) => reject(new Error(redact(error.message, secret))));
        child.once('close', (code) => {
            if (code !== 0)
                reject(new Error(redact(stderr.trim() || `${command} exited with code ${code}.`, secret)));
            else
                resolve({ stdout, stderr });
        });
    });
}
async function cleanupSession(github, state) {
    try {
        const run = await github.getRun(state.repository, state.runId);
        if (run.status !== 'completed')
            await github.cancelRun(state.repository, state.runId);
    }
    catch (error) {
        console.error(`Could not cancel run ${state.runId}: ${errorMessage(error)}`);
    }
    try {
        await github.deleteBranch(state.repository, state.branch);
    }
    finally {
        await clearState(state.projectRoot);
    }
}
async function saveState(state) {
    const filePath = await statePath(state.projectRoot);
    await promises_1.default.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
    await promises_1.default.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
async function readState(projectRoot) {
    try {
        const contents = await promises_1.default.readFile(await statePath(projectRoot), 'utf8');
        const state = JSON.parse(contents);
        if (state.version !== 1 || state.projectRoot !== projectRoot)
            return null;
        return state;
    }
    catch {
        return null;
    }
}
async function clearState(projectRoot) {
    await promises_1.default.rm(await statePath(projectRoot), { force: true });
}
async function statePath(projectRoot) {
    const normalized = node_path_1.default.resolve(projectRoot).toLowerCase();
    const key = (0, node_crypto_1.createHash)('sha256').update(normalized).digest('hex').slice(0, 24);
    return node_path_1.default.join(node_os_1.default.tmpdir(), 'ui-ios-sessions', `${key}.json`);
}
async function copyTree(source, destination) {
    await promises_1.default.mkdir(destination, { recursive: true });
    for (const entry of await promises_1.default.readdir(source, { withFileTypes: true })) {
        const from = node_path_1.default.join(source, entry.name);
        const to = node_path_1.default.join(destination, entry.name);
        if (entry.isDirectory())
            await copyTree(from, to);
        else if (entry.isFile())
            await promises_1.default.copyFile(from, to);
    }
}
function openBrowser(url) {
    if (process.platform === 'win32') {
        launchWindowsUrl(url, false);
        return;
    }
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = [url];
    const child = (0, node_child_process_1.spawn)(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => {
        console.error('Could not open the private preview automatically. Open a browser while the session is running; the private link is not printed.');
    });
    child.once('close', (code) => {
        if (code !== 0)
            console.error('The browser launcher returned an error. Open your default browser while the session is running; the private link is not printed.');
    });
    child.unref();
}
function launchWindowsUrl(url, useCmdFallback) {
    const command = useCmdFallback ? 'cmd.exe' : 'explorer.exe';
    const args = useCmdFallback ? ['/d', '/s', '/c', `start "" "${url}"`] : [url];
    let fallbackStarted = false;
    const reportFailure = () => {
        if (fallbackStarted)
            return;
        fallbackStarted = true;
        if (!useCmdFallback) {
            launchWindowsUrl(url, true);
            return;
        }
        console.error('Windows could not open the private preview link. Check your default browser and start ui-ios again; the link is not printed because it contains a session token.');
    };
    const child = (0, node_child_process_1.spawn)(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reportFailure);
    child.once('close', (code) => { if (code !== 0)
        reportFailure(); });
    child.unref();
}
function summarizeProgress(run, queuedAt) {
    if (run.status === 'queued' || run.status === 'requested' || run.status === 'waiting' || run.status === 'pending') {
        const seconds = Math.max(0, Math.round((Date.now() - queuedAt) / 1000));
        return { label: `queued:${Math.floor(seconds / 30)}`, message: `Runner queue: waiting ${formatDuration(seconds)}.` };
    }
    const steps = run.jobs?.flatMap((job) => job.steps.map((step) => ({ job: job.name, ...step }))) ?? [];
    const current = steps.find((step) => step.status === 'in_progress');
    if (current)
        return { label: `${current.job}:${current.name}`, message: `Runner: ${current.job} · ${current.name}` };
    const finished = steps.filter((step) => step.conclusion === 'success').length;
    return { label: `${run.status}:${finished}`, message: `Runner: ${run.status}; ${finished} steps completed.` };
}
function normalizeDevice(value, allowed) {
    const normalized = value === 'latest' ? 'iphone17' : value;
    if (!allowed.includes(normalized)) {
        throw new Error(`Device "${value}" is not enabled in ${config_1.CONFIG_FILE}. Enabled devices: ${allowed.join(', ')}.`);
    }
    return normalized;
}
function formatBytes(bytes) {
    if (bytes >= 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} bytes`;
}
function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
function lastLines(value, count) {
    return value.split(/\r?\n/).filter(Boolean).slice(-count).join('\n');
}
function redact(value, secret) {
    return secret ? value.split(secret).join('[REDACTED]') : value;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=cli.js.map