import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { GitHubRun } from './types';

export interface GitHubResult {
  stdout: string;
  stderr: string;
}

export class GitHubClient {
  readonly executable: string;
  readonly token: string;
  readonly owner: string;

  private constructor(executable: string, token: string, owner: string) {
    this.executable = executable;
    this.token = token;
    this.owner = owner;
  }

  static async create(): Promise<GitHubClient> {
    const executable = locateGhCli();
    if (!executable) throw new Error('GitHub CLI (gh) was not found. Install it and reopen the terminal.');

    let token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
    if (!token) {
      try {
        const result = spawnSync(executable, ['auth', 'token'], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (result.status === 0) token = result.stdout.trim();
      } catch {
        token = '';
      }
    }
    if (!token) {
      throw new Error('GitHub CLI is not authenticated. Run `gh auth login` and try again.');
    }

    const client = new GitHubClient(executable, token, '');
    const owner = (await client.runGh(['api', 'user', '--jq', '.login'])).stdout.trim();
    if (!/^[A-Za-z0-9-]+$/.test(owner)) throw new Error('GitHub returned an invalid account name.');
    return new GitHubClient(executable, token, owner);
  }

  async runGh(args: string[], cwd?: string): Promise<GitHubResult> {
    return this.invoke(args, undefined, cwd);
  }

  async runGhWithInput(args: string[], input: string): Promise<GitHubResult> {
    return this.invoke(args, input);
  }

  private async invoke(args: string[], input?: string, cwd?: string): Promise<GitHubResult> {
    const env = {
      ...process.env,
      GH_TOKEN: this.token,
      GITHUB_TOKEN: this.token,
      GIT_TERMINAL_PROMPT: '0',
    };
    const child = spawn(this.executable, args, {
      cwd,
      env: {
        ...env,
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const exit = await new Promise<{ code: number; error?: Error }>((resolve) => {
      child.once('error', (error) => resolve({ code: 1, error }));
      child.once('close', (code) => resolve({ code: code ?? 1 }));
      child.stdin.end(input);
    });
    if (exit.code !== 0) {
      const detail = (exit.error?.message ?? stderr.trim()) || `GitHub CLI exited with code ${exit.code}.`;
      throw new Error(redact(detail, this.token));
    }
    return { stdout, stderr };
  }

  async getRepository(fullName: string): Promise<{ fullName: string; visibility: string; defaultBranch: string; permissions?: { push?: boolean } }> {
    const result = await this.runGh(['api', `repos/${fullName}`]);
    const repository = JSON.parse(result.stdout) as {
      full_name: string;
      visibility: string;
      default_branch: string;
      permissions?: { push?: boolean };
    };
    return {
      fullName: repository.full_name,
      visibility: repository.visibility,
      defaultBranch: repository.default_branch,
      permissions: repository.permissions,
    };
  }

  async repositoryExists(fullName: string): Promise<boolean> {
    try {
      await this.getRepository(fullName);
      return true;
    } catch (error) {
      if (error instanceof Error && /HTTP 404|Not Found/i.test(error.message)) return false;
      throw error;
    }
  }

  async createPrivateRepository(name: string): Promise<string> {
    const result = await this.runGh([
      'repo', 'create', `${this.owner}/${name}`,
      '--private',
      '--description', 'Temporary private snapshots for personal ui-ios simulator sessions',
    ]);
    return result.stdout.trim() || `https://github.com/${this.owner}/${name}`;
  }

  async setDefaultBranch(repository: string, branch: string): Promise<void> {
    await this.runGh(['api', `repos/${repository}`, '--method', 'PATCH', '-f', `default_branch=${branch}`]);
  }

  async hasSessionWorkflow(repository: string, branch: string): Promise<boolean> {
    try {
      await this.runGh(['api', `repos/${repository}/contents/.github/workflows/ui-ios-session.yml?ref=${encodeURIComponent(branch)}`]);
      return true;
    } catch (error) {
      if (error instanceof Error && /HTTP 404|Not Found/i.test(error.message)) return false;
      throw error;
    }
  }

  async getActiveRuns(repository: string): Promise<GitHubRun[]> {
    const result = await this.runGh([
      'run', 'list', '--repo', repository,
      '--workflow', 'ui-ios-session.yml',
      '--json', 'databaseId,status,conclusion,url,createdAt,startedAt',
      '--limit', '20',
    ]);
    const runs = JSON.parse(result.stdout) as GitHubRun[];
    return runs.filter((run) => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status));
  }

  async dispatchWorkflow(repository: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<string> {
    const result = await this.runGhWithInput([
      'workflow', 'run', workflow,
      '--repo', repository,
      '--ref', ref,
      '--json',
    ], JSON.stringify(inputs));
    const runUrl = result.stdout.match(/https:\/\/github\.com\/[^\s]+\/actions\/runs\/(\d+)/)?.[0];
    if (!runUrl) throw new Error('GitHub accepted the workflow request but did not return a run URL.');
    return runUrl;
  }

  async findRunId(runUrl: string): Promise<number> {
    const match = runUrl.match(/\/runs\/(\d+)(?:$|[?#])/);
    if (!match) throw new Error('GitHub returned a workflow URL without a run ID.');
    return Number(match[1]);
  }

  async getRun(repository: string, runId: number): Promise<GitHubRun> {
    const result = await this.runGh([
      'run', 'view', String(runId),
      '--repo', repository,
      '--json', 'databaseId,status,conclusion,createdAt,startedAt,url,jobs',
    ]);
    const run = JSON.parse(result.stdout) as GitHubRun;
    return run;
  }

  async getSessionMetadata(repository: string, branch: string): Promise<string | null> {
    const encodedBranch = encodeURIComponent(branch);
    try {
      const result = await this.runGh([
        'api',
        `repos/${repository}/contents/ui-ios-runtime/session.json?ref=${encodedBranch}`,
        '--jq', '.content',
      ]);
      return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
    } catch (error) {
      if (error instanceof Error && /HTTP 404|Not Found/i.test(error.message)) return null;
      throw error;
    }
  }

  async cancelRun(repository: string, runId: number): Promise<void> {
    await this.runGh(['run', 'cancel', String(runId), '--repo', repository]);
  }

  async deleteBranch(repository: string, branch: string): Promise<void> {
    const encodedRef = encodeURIComponent(`heads/${branch}`);
    try {
      await this.runGh(['api', '--method', 'DELETE', `repos/${repository}/git/refs/${encodedRef}`]);
    } catch (error) {
      if (error instanceof Error && /HTTP 404|Not Found/i.test(error.message)) return;
      throw error;
    }
  }

  async showRunLogs(repository: string, runId: number): Promise<string> {
    const result = await this.runGh(['run', 'view', String(runId), '--repo', repository, '--log']);
    return redact(result.stdout, this.token);
  }
}

function locateGhCli(): string | null {
  const candidates = process.platform === 'win32'
    ? [
      'gh',
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'GitHub CLI', 'gh.exe'),
    ]
    : ['gh'];

  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['--version'], { stdio: 'ignore', windowsHide: true });
      if (result.status === 0) return candidate;
    } catch {
      // Try the next known location.
    }
  }
  return null;
}

function redact(value: string, token: string): string {
  return token ? value.split(token).join('[REDACTED]') : value;
}
