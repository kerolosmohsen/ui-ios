import {spawn, spawnSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {appendFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(here);
const evidenceDir = path.join(runtimeRoot, 'runner-evidence');
const sessionFile = path.join(runtimeRoot, 'session.json');
const sessionId = process.env.SESSION_ID ?? '';
const branch = process.env.SESSION_BRANCH ?? '';
const token = process.env.SESSION_TOKEN ?? '';
const githubToken = process.env.GITHUB_TOKEN ?? '';
delete process.env.GITHUB_TOKEN;
const allowedOrigin = process.env.ALLOWED_ORIGIN ?? '';
const sessionPort = Number(process.env.PORT ?? 8787);
const targetUdid = process.env.SIMULATOR_UDID ?? '';
const targetName = process.env.SIMULATOR_NAME ?? '';
const runId = process.env.RUN_ID ?? '';
let server = null;
let tunnel = null;
let stopping = false;
const projectConfig = await readConfig();

if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error('Session identifier is malformed.');
if (!/^session\/[a-f0-9-]{36}$/i.test(branch)) throw new Error('Session branch name is malformed.');
if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Session token is missing or malformed.');
if (!githubToken) throw new Error('The workflow token is unavailable for temporary metadata publishing.');
if (!/^https:\/\/[a-z0-9-]+\.github\.io$/i.test(allowedOrigin)) throw new Error('Allowed Pages origin is malformed.');
if (!targetUdid || !targetName) throw new Error('Simulator selection is missing.');
await mkdir(evidenceDir, {recursive: true});

function log(message) {
  console.log(`[ui-ios runner] ${message}`);
}

function startServer() {
  const child = spawn(process.execPath, [path.join(runtimeRoot, 'server.mjs')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(sessionPort),
      ALLOWED_ORIGIN: allowedOrigin,
      IDLE_TIMEOUT_MS: String(Number(projectConfig.idleTimeoutMinutes ?? 30) * 60_000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = createWriteStream(path.join(evidenceDir, 'server.log'));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The local WebSocket server did not become ready in 30 seconds.')), 30_000);
    const lines = createInterface({input: child.stdout});
    lines.on('line', (line) => {
      output.write(`${line}\n`);
      log(line);
      if (line.includes('UI_IOS_SERVER_READY')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { output.write(chunk); process.stderr.write(chunk); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); reject(new Error(`The local WebSocket server exited before it was ready (${code ?? 'signal'}).`)); });
  });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({code: code ?? 1, signal})));
  return {child, output, ready, closed};
}

async function startTunnel() {
  let lastError = 'Cloudflare Quick Tunnel did not provide a URL.';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${sessionPort}`], {stdio: ['ignore', 'pipe', 'pipe']});
    const logFile = path.join(evidenceDir, 'cloudflared.log');
    const lines = [];
    let pending = '';
    const tunnelReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No Quick Tunnel URL within 45 seconds.')), 45_000);
      const consume = (chunk) => {
        const text = chunk.toString();
        pending += text;
        const rows = pending.split(/\r?\n/);
        pending = rows.pop() ?? '';
        for (const row of rows) {
          lines.push(row);
          void appendFile(logFile, `${row}\n`);
          const match = row.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
          if (match) { clearTimeout(timer); resolve(match[0]); }
        }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited before providing a URL (code ${code ?? 'unknown'}).`));
      });
    });
    const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({code: code ?? 1, signal})));
    try {
      const url = await tunnelReady;
      const host = new URL(url).hostname;
      if (!/^[a-z0-9-]+\.trycloudflare\.com$/i.test(host)) throw new Error('Cloudflare returned an unsupported tunnel host.');
      log(`Quick Tunnel connected on attempt ${attempt}.`);
      return {child, host, closed};
    } catch (error) {
      lastError = error.message;
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    }
  }
  throw new Error(`Could not start the Cloudflare Quick Tunnel after three attempts: ${lastError}`);
}

function describeScreen() {
  const result = spawnSync('idb', ['describe', '--udid', targetUdid, '--json'], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || 'idb describe failed').trim());
  const root = JSON.parse(result.stdout);
  function find(value) {
    if (!value || typeof value !== 'object') return null;
    const dims = value.screen_dimensions;
    if (dims) {
      const width = Number(dims.width_points ?? dims.width);
      const height = Number(dims.height_points ?? dims.height);
      const pixelRatio = Number(dims.density ?? dims.scale ?? 1);
      if (width > 0 && height > 0) return {width, height, pixelRatio: pixelRatio > 0 ? pixelRatio : 1};
    }
    for (const child of Object.values(value)) { const found = find(child); if (found) return found; }
    return null;
  }
  const size = find(root);
  if (!size) throw new Error('idb describe did not return screen dimensions.');
  return size;
}

function git(args) {
  const env = {...process.env};
  if (args[0] === 'push') {
    const header = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${header}`;
    env.GIT_TERMINAL_PROMPT = '0';
  }
  const result = spawnSync('git', args, {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env});
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || `git ${args[0]} failed`).trim());
  return result.stdout;
}

async function publishMetadata(host) {
  const metadata = {
    sessionId,
    tunnelHost: host,
    deviceName: targetName,
    simulatorUdid: targetUdid,
    logicalSize: describeScreen(),
    fps: Number((await readConfig()).fps) || 5,
    runId: Number(runId),
    bootSeconds: Number(process.env.BOOT_SECONDS ?? 0),
    startedAt: new Date().toISOString(),
  };
  await writeFile(sessionFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  git(['config', 'user.name', 'github-actions[bot]']);
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  git(['add', 'ui-ios-runtime/session.json']);
  git(['commit', '-m', 'ui-ios: publish temporary session metadata']);
  git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  log(`Session metadata published for ${metadata.deviceName} (${metadata.logicalSize.width}×${metadata.logicalSize.height}).`);
  process.stdout.write(`::notice title=ui-ios simulator ready::${metadata.deviceName} is ready via the GitHub Pages preview.\n`);
}

async function readConfig() {
  try { return JSON.parse(await readFile(path.resolve('ui-ios.config.json'), 'utf8')); }
  catch { return {fps: 5}; }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (tunnel?.child && !tunnel.child.killed) tunnel.child.kill('SIGTERM');
  if (server?.child && !server.child.killed) server.child.kill('SIGTERM');
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

try {
  server = startServer();
  await server.ready;
  tunnel = await startTunnel();
  await publishMetadata(tunnel.host);
  let result;
  while (!stopping) {
    result = await Promise.race([
      server.closed.then((value) => ({kind: 'server', ...value})),
      tunnel.closed.then((value) => ({kind: 'tunnel', ...value})),
    ]);
    if (result.kind === 'server') break;
    log('The Quick Tunnel disconnected; retrying with a new temporary URL.');
    tunnel = await startTunnel();
    await publishMetadata(tunnel.host);
  }
  if (result?.kind === 'server' && result.code !== 0 && !stopping) {
    throw new Error(`Simulator stream server exited with ${result.code}${result.signal ? ` (${result.signal})` : ''}.`);
  }
  await shutdown();
  await Promise.allSettled([server.closed, tunnel?.closed].filter(Boolean));
  await new Promise((resolve) => server.output.end(resolve));
  log('Runner session ended. Simulator evidence will be uploaded as an Actions artifact.');
} catch (error) {
  await shutdown();
  await Promise.allSettled([server?.closed, tunnel?.closed].filter(Boolean));
  if (server?.output) await new Promise((resolve) => server.output.end(resolve));
  throw error;
}
