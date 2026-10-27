"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubClient = void 0;
const node_child_process_1 = require("node:child_process");
const node_path_1 = __importDefault(require("node:path"));
class GitHubClient {
    executable;
    token;
    owner;
    constructor(executable, token, owner) {
        this.executable = executable;
        this.token = token;
        this.owner = owner;
    }
    static async create() {
        const executable = locateGhCli();
        if (!executable)
            throw new Error('GitHub CLI (gh) was not found. Install it and reopen the terminal.');
        let token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
        if (!token) {
            try {
                const result = (0, node_child_process_1.spawnSync)(executable, ['auth', 'token'], {
                    encoding: 'utf8',
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'ignore'],
                });
                if (result.status === 0)
                    token = result.stdout.trim();
            }
            catch {
                token = '';
            }
        }
        if (!token) {
            throw new Error('GitHub CLI is not authenticated. Run `gh auth login` and try again.');
        }
        const client = new GitHubClient(executable, token, '');
        const owner = (await client.runGh(['api', 'user', '--jq', '.login'])).stdout.trim();
        if (!/^[A-Za-z0-9-]+$/.test(owner))
            throw new Error('GitHub returned an invalid account name.');
        return new GitHubClient(executable, token, owner);
    }
    async runGh(args, cwd) {
        return this.invoke(args, undefined, cwd);
    }
    async runGhWithInput(args, input) {
        return this.invoke(args, input);
    }
    async invoke(args, input, cwd) {
        const env = {
            ...process.env,
            GH_TOKEN: this.token,
            GITHUB_TOKEN: this.token,
            GIT_TERMINAL_PROMPT: '0',
        };
        let attempt = 0;
        let stdout = '';
        let stderr = '';
        let exit = { code: 1 };
        while (attempt < 3) {
            stdout = '';
            stderr = '';
            try {
                const child = (0, node_child_process_1.spawn)(this.executable, args, {
                    cwd,
                    env,
                    windowsHide: true,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
                child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
                child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
                exit = await new Promise((resolve) => {
                    child.once('error', (error) => resolve({ code: 1, error }));
                    child.once('close', (code) => resolve({ code: code ?? 1 }));
                    child.stdin.end(input);
                });
            }
            catch (error) {
                exit = { code: 1, error: error instanceof Error ? error : new Error(String(error)) };
            }
            const errorCode = exit.error?.code;
            if (!exit.error || !['UNKNOWN', 'EAGAIN'].includes(errorCode ?? '') || attempt >= 2)
                break;
            attempt += 1;
            await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
        if (exit.code !== 0) {
            const detail = (exit.error?.message ?? stderr.trim()) || `GitHub CLI exited with code ${exit.code}.`;
            throw new Error(redact(detail, this.token));
        }
        return { stdout, stderr };
    }
    async getRepository(fullName) {
        const result = await this.runGh(['api', `repos/${fullName}`]);
        const repository = JSON.parse(result.stdout);
        return {
            fullName: repository.full_name,
            visibility: repository.visibility,
            defaultBranch: repository.default_branch,
            permissions: repository.permissions,
        };
    }
    async repositoryExists(fullName) {
        try {
            await this.getRepository(fullName);
            return true;
        }
        catch (error) {
            if (error instanceof Error && /HTTP 404|Not Found/i.test(error.message))
                return false;
            throw error;
        }
    }
    async createPrivateRepository(name) {
        const result = await this.runGh([
            'repo', 'create', `${this.owner}/${name}`,
            '--private',
            '--description', 'Temporary private snapshots for personal ui-ios simulator sessions',
        ]);
        return result.stdout.trim() || `https://github.com/${this.owner}/${name}`;
    }
    async setDefaultBranch(repository, branch) {
        await this.runGh(['api', `repos/${repository}`, '--method', 'PATCH', '-f', `default_branch=${branch}`]);
    }
    async hasSessionWorkflow(repository, branch) {
        try {
            await this.runGh(['api', `repos/${repository}/contents/.github/workflows/ui-ios-session.yml?ref=${encodeURIComponent(branch)}`]);
            return true;
        }
        catch (error) {
            if (error instanceof Error && /HTTP 404|Not Found/i.test(error.message))
                return false;
            throw error;
        }
    }
    async getActiveRuns(repository) {
        const result = await this.runGh([
            'run', 'list', '--repo', repository,
            '--workflow', 'ui-ios-session.yml',
            '--json', 'databaseId,status,conclusion,url,createdAt,startedAt',
            '--limit', '20',
        ]);
        const runs = JSON.parse(result.stdout);
        return runs.filter((run) => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status));
    }
    async dispatchWorkflow(repository, workflow, ref, inputs) {
        const result = await this.runGhWithInput([
            'workflow', 'run', workflow,
            '--repo', repository,
            '--ref', ref,
            '--json',
        ], JSON.stringify(inputs));
        const runUrl = result.stdout.match(/https:\/\/github\.com\/[^\s]+\/actions\/runs\/(\d+)/)?.[0];
        if (!runUrl)
            throw new Error('GitHub accepted the workflow request but did not return a run URL.');
        return runUrl;
    }
    async findRunId(runUrl) {
        const match = runUrl.match(/\/runs\/(\d+)(?:$|[?#])/);
        if (!match)
            throw new Error('GitHub returned a workflow URL without a run ID.');
        return Number(match[1]);
    }
    async getRun(repository, runId) {
        const result = await this.runGh([
            'run', 'view', String(runId),
            '--repo', repository,
            '--json', 'databaseId,status,conclusion,createdAt,startedAt,url,jobs',
        ]);
        const run = JSON.parse(result.stdout);
        return run;
    }
    async getSessionMetadata(repository, branch) {
        const encodedBranch = encodeURIComponent(branch);
        try {
            const result = await this.runGh([
                'api',
                `repos/${repository}/contents/ui-ios-runtime/session.json?ref=${encodedBranch}`,
                '--jq', '.content',
            ]);
            return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
        }
        catch (error) {
            if (error instanceof Error && /HTTP 404|Not Found/i.test(error.message))
                return null;
            throw error;
        }
    }
    async cancelRun(repository, runId) {
        await this.runGh(['run', 'cancel', String(runId), '--repo', repository]);
    }
    async deleteBranch(repository, branch) {
        const encodedRef = encodeURIComponent(`heads/${branch}`);
        try {
            await this.runGh(['api', '--method', 'DELETE', `repos/${repository}/git/refs/${encodedRef}`]);
        }
        catch (error) {
            if (error instanceof Error && /HTTP 404|Not Found/i.test(error.message))
                return;
            throw error;
        }
    }
    async showRunLogs(repository, runId) {
        const result = await this.runGh(['run', 'view', String(runId), '--repo', repository, '--log']);
        return redact(result.stdout, this.token);
    }
}
exports.GitHubClient = GitHubClient;
function locateGhCli() {
    const candidates = process.platform === 'win32'
        ? [
            'gh',
            node_path_1.default.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
            node_path_1.default.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'GitHub CLI', 'gh.exe'),
        ]
        : ['gh'];
    for (const candidate of candidates) {
        try {
            const result = (0, node_child_process_1.spawnSync)(candidate, ['--version'], { stdio: 'ignore', windowsHide: true });
            if (result.status === 0)
                return candidate;
        }
        catch {
            // Try the next known location.
        }
    }
    return null;
}
function redact(value, token) {
    return token ? value.split(token).join('[REDACTED]') : value;
}
//# sourceMappingURL=github.js.map