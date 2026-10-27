import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer, WebSocket} from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const token = process.env.SESSION_TOKEN ?? '';
const origin = process.env.ALLOWED_ORIGIN ?? '';
const maxSessionMs = 330 * 60 * 1000;
const maxHeartbeatSilenceMs = 5 * 60 * 1000;
const port = Number(process.env.PORT ?? 8787);
const evidenceDir = path.resolve(here, 'runner-evidence');
const config = await readConfig();
const idleTimeoutMs = Number(process.env.IDLE_TIMEOUT_MS ?? Number(config.idleTimeoutMinutes ?? 30) * 60_000);
const fps = Math.max(1, Math.min(10, Number(config.fps) || 5));
let udid = process.env.SIMULATOR_UDID ?? '';
let deviceName = process.env.SIMULATOR_NAME ?? 'iPhone Simulator';
const appPath = process.env.APP_PATH ?? '';
const bundleId = process.env.APP_BUNDLE_ID ?? '';
const startedAt = Date.now();
let logicalSize = await getLogicalSize(udid);
let provider = 'idb-video-stream-mjpeg';
let streamProcess = null;
let appLogProcess = null;
let activeViewer = null;
let actionBusy = false;
let lastHeartbeatAt = startedAt;
let lastInteractionAt = startedAt;
let latestFrame = null;
let frameCount = 0;
let frameWindowCount = 0;
let frameWindowStart = Date.now();
let currentFps = 0;
let lastFrameAt = 0;
let stopping = false;
let orientation = 'PORTRAIT';
const clients = new Set();
const recentLogs = [];
const nextFrameWaiters = [];
const fallbackPath = path.join(os.tmpdir(), `ui-ios-${process.pid}.jpg`);
const fallbackPng = path.join(os.tmpdir(), `ui-ios-${process.pid}.png`);

if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Session authentication input is missing or malformed.');
if (!/^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin)) throw new Error('The Pages Origin is missing or malformed.');
if (!/^[A-F0-9-]{36}$/i.test(udid) || !appPath || !bundleId) throw new Error('Simulator or built app metadata is missing.');
if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 60_000 || idleTimeoutMs > 330 * 60_000) throw new Error('The idle timeout is outside the supported range.');
await mkdir(evidenceDir, {recursive: true});
const appLog = await import('node:fs').then(({createWriteStream}) => createWriteStream(path.join(evidenceDir, 'app.log'), {flags: 'a'}));

function log(message) {
  const line = `[ui-ios] ${new Date().toISOString()} ${message}`;
  process.stdout.write(`${line}\n`);
  recentLogs.push(line);
  if (recentLogs.length > 250) recentLogs.shift();
  if (activeViewer?.readyState === WebSocket.OPEN) sendJson(activeViewer, {type: 'log', line});
}

function sendJson(ws, value) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

function exec(command, args, timeout = 20_000) {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024});
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || `${command} failed`).trim();
    throw new Error(detail.slice(-1200));
  }
  return result.stdout;
}

async function readConfig() {
  try { return JSON.parse(await readFile(path.resolve('ui-ios.config.json'), 'utf8')); }
  catch { return {fps: 5, idleTimeoutMinutes: 30}; }
}

function findDimensions(value) {
  if (!value || typeof value !== 'object') return null;
  const dims = value.screen_dimensions;
  if (dims) {
    const width = Number(dims.width_points ?? dims.width);
    const height = Number(dims.height_points ?? dims.height);
    const pixelRatio = Number(dims.density ?? dims.scale ?? 1);
    if (width > 0 && height > 0) return {width, height, pixelRatio: pixelRatio > 0 ? pixelRatio : 1};
  }
  for (const child of Object.values(value)) {
    const found = findDimensions(child);
    if (found) return found;
  }
  return null;
}

async function getLogicalSize(targetUdid) {
  const output = exec('idb', ['describe', '--udid', targetUdid, '--json']);
  const dimensions = findDimensions(JSON.parse(output));
  if (!dimensions) throw new Error('IDB did not return simulator screen dimensions.');
  return dimensions;
}

function parseJpegs(stream) {
  let pending = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length > 4) {
      const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { pending = pending.subarray(Math.max(0, pending.length - 1)); return; }
      const end = pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) { pending = pending.subarray(start); return; }
      emitFrame(pending.subarray(start, end + 2));
      pending = pending.subarray(end + 2);
    }
  });
}

function emitFrame(frame) {
  if (stopping || frame.length < 4) return;
  latestFrame = Buffer.from(frame);
  frameCount += 1;
  frameWindowCount += 1;
  lastFrameAt = Date.now();
  if (frameCount === 1) void writeFile(path.join(evidenceDir, 'first-frame.jpg'), frame);
  for (const waiter of [...nextFrameWaiters]) {
    if (frameCount > waiter.afterCount) {
      clearTimeout(waiter.timer);
      nextFrameWaiters.splice(nextFrameWaiters.indexOf(waiter), 1);
      waiter.resolve(Buffer.from(frame));
    }
  }
  if (activeViewer?.readyState === WebSocket.OPEN) activeViewer.send(frame, {binary: true});
}

function nextFrameAfter(afterCount, timeoutMs = 3000) {
  if (frameCount > afterCount && latestFrame) return Promise.resolve(Buffer.from(latestFrame));
  return new Promise((resolve) => {
    const waiter = {afterCount, resolve, timer: null};
    waiter.timer = setTimeout(() => {
      const index = nextFrameWaiters.indexOf(waiter);
      if (index >= 0) nextFrameWaiters.splice(index, 1);
      resolve(null);
    }, timeoutMs);
    nextFrameWaiters.push(waiter);
  });
}

function runIdb(args, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('idb', [...args, '--udid', udid], {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({stdout, stderr});
      else reject(new Error(`idb ${args[0]} failed (${code ?? signal ?? 'unknown'}): ${(stderr || stdout).trim().slice(-1000)}`));
    });
  });
}

function startStream() {
  if (stopping || streamProcess) return;
  const args = ['video-stream', '--format', 'mjpeg', '--fps', String(fps), '--compression-quality', '0.7', '--udid', udid];
  const currentProcess = spawn('idb', args, {stdio: ['ignore', 'pipe', 'pipe']});
  streamProcess = currentProcess;
  parseJpegs(currentProcess.stdout);
  currentProcess.stderr.setEncoding('utf8').on('data', (chunk) => {
    const message = chunk.trim();
    if (message) log(`idb: ${message.slice(0, 300)}`);
  });
  currentProcess.once('error', (error) => {
    log(`idb video stream could not start: ${error.message}; switching to simctl screenshots.`);
    void fallbackFrames();
  });
  currentProcess.once('exit', (code) => {
    if (streamProcess === currentProcess) streamProcess = null;
    else return;
    if (!stopping) {
      log(`idb video stream exited (${code ?? 'signal'}); switching to simctl screenshots.`);
      void fallbackFrames();
    }
  });
  setTimeout(() => {
    if (!stopping && frameCount === 0 && streamProcess === currentProcess) {
      log('No IDB video frame arrived within 8 seconds; switching to simctl screenshots.');
      currentProcess.kill('SIGTERM');
      void fallbackFrames();
    }
  }, 8000).unref();
}

async function fallbackFrames() {
  if (provider === 'simctl-screenshot-jpeg' || stopping) return;
  provider = 'simctl-screenshot-jpeg';
  broadcastStatus();
  log('Using xcrun simctl screenshot converted to JPEG.');
  while (!stopping && provider === 'simctl-screenshot-jpeg') {
    const began = Date.now();
    try {
      await rm(fallbackPng, {force: true});
      exec('xcrun', ['simctl', 'io', udid, 'screenshot', fallbackPng], 15_000);
      exec('sips', ['-s', 'format', 'jpeg', fallbackPng, '--out', fallbackPath], 15_000);
      emitFrame(await readFile(fallbackPath));
    } catch (error) {
      log(`Screenshot fallback failed: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(1000 / fps) - (Date.now() - began))));
  }
}

function startAppLogStream() {
  appLogProcess = spawn('xcrun', [
    'simctl', 'spawn', udid, 'log', 'stream', '--style', 'compact', '--level', 'info',
    '--predicate', `process == "${bundleId}"`,
  ], {stdio: ['ignore', 'pipe', 'pipe']});
  for (const stream of [appLogProcess.stdout, appLogProcess.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      appLog.write(chunk);
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        recentLogs.push(line);
        if (recentLogs.length > 250) recentLogs.shift();
        if (activeViewer?.readyState === WebSocket.OPEN) sendJson(activeViewer, {type: 'app-log', line});
      }
    });
  }
  appLogProcess.once('error', (error) => log(`Could not start app log stream: ${error.message}`));
}

function tokenMatches(candidate) {
  const left = Buffer.from(candidate);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function screenshot() {
  const file = path.join(evidenceDir, `screenshot-${new Date().toISOString().replaceAll(':', '-')}.png`);
  exec('xcrun', ['simctl', 'io', udid, 'screenshot', file], 15_000);
  return file;
}

async function switchDevice(preset) {
  if (!['iphone15', 'latest'].includes(preset)) throw new Error('Unsupported device preset.');
  const previousUdid = udid;
  streamProcess?.kill('SIGTERM');
  streamProcess = null;
  appLogProcess?.kill('SIGTERM');
  const selected = spawnSync(process.execPath, [path.join(here, 'select-simulator.mjs')], {
    encoding: 'utf8',
    env: {...process.env, DEVICE_PRESET: preset},
    maxBuffer: 4 * 1024 * 1024,
  });
  if (selected.status !== 0) throw new Error((selected.stderr || selected.error?.message || 'Could not select another simulator.').trim());
  const output = Object.fromEntries(selected.stdout.trim().split(/\r?\n/).map((row) => row.split('=')));
  if (!output.udid || !output.name) throw new Error('Simulator selection returned incomplete data.');
  udid = output.udid;
  deviceName = output.name;
  await exec('xcrun', ['simctl', 'install', udid, appPath]);
  await exec('xcrun', ['simctl', 'launch', udid, bundleId]);
  await exec('idb', ['connect', udid]);
  await runIdb(['launch', '--foreground-if-running', bundleId]);
  logicalSize = await getLogicalSize(udid);
  provider = 'idb-video-stream-mjpeg';
  latestFrame = null;
  frameCount = 0;
  await startAppLogStream();
  startStream();
  if (previousUdid !== udid) await exec('xcrun', ['simctl', 'shutdown', previousUdid]).catch(() => '');
  log(`Changed simulator to ${deviceName} (${logicalSize.width}×${logicalSize.height}).`);
  return {deviceName, logicalSize};
}

const httpServer = createServer((_request, response) => {
  response.writeHead(404, {'Content-Type': 'text/plain', 'Cache-Control': 'no-store'});
  response.end('Not found');
});
const websocketServer = new WebSocketServer({noServer: true, maxPayload: 16 * 1024});
httpServer.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws' || request.headers.origin !== origin) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (ws) => websocketServer.emit('connection', ws, request));
});

websocketServer.on('connection', (ws) => {
  clients.add(ws);
  let authenticated = false;
  const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
  ws.on('message', async (raw, isBinary) => {
    if (isBinary || stopping) return;
    let message;
    try { message = JSON.parse(raw.toString()); }
    catch { ws.close(1007, 'Invalid message'); return; }
    if (!authenticated) {
      if (message.type !== 'auth' || typeof message.token !== 'string' || !tokenMatches(message.token)) {
        ws.close(1008, 'Invalid or expired session link');
        return;
      }
      if (activeViewer?.readyState === WebSocket.OPEN) {
        ws.close(1008, 'Another viewer is already connected');
        return;
      }
      clearTimeout(authTimer);
      authenticated = true;
      activeViewer = ws;
      lastHeartbeatAt = Date.now();
      lastInteractionAt = Date.now();
      sendJson(ws, {type: 'ready', deviceName, logicalSize, provider, fps});
      sendJson(ws, {type: 'logs', lines: recentLogs.slice(-150)});
      if (latestFrame) ws.send(latestFrame, {binary: true});
      log(`Viewer connected; device=${deviceName}.`);
      return;
    }

    if (message.type === 'heartbeat') { lastHeartbeatAt = Date.now(); return; }
    lastHeartbeatAt = Date.now();
    if (message.type === 'tap') {
      const x = Number(message.x);
      const y = Number(message.y);
      if (!insideUnit(x) || !insideUnit(y)) { sendJson(ws, {type: 'error', message: 'Tap is outside the simulator screen.'}); return; }
      await runAction(ws, 'tap', async () => {
        const began = Date.now();
        await runIdb(['ui', 'tap', String(Math.round(x * logicalSize.width)), String(Math.round(y * logicalSize.height))]);
        const commandMs = Date.now() - began;
        const afterCommandCount = frameCount;
        const newFrame = await nextFrameAfter(afterCommandCount);
        if (newFrame) await writeFile(path.join(evidenceDir, 'simulator-after-tap.jpg'), newFrame);
        sendJson(ws, {type: 'action-result', action: 'tap', ok: true, latencyMs: Date.now() - began, commandMs, frameCaptured: Boolean(newFrame)});
        lastInteractionAt = Date.now();
      });
    } else if (message.type === 'swipe') {
      const values = [message.x1, message.y1, message.x2, message.y2].map(Number);
      if (values.some((value) => !insideUnit(value))) { sendJson(ws, {type: 'error', message: 'Swipe point is outside the simulator screen.'}); return; }
      await runAction(ws, 'swipe', async () => {
        await runIdb(['ui', 'swipe', String(Math.round(values[0] * logicalSize.width)), String(Math.round(values[1] * logicalSize.height)), String(Math.round(values[2] * logicalSize.width)), String(Math.round(values[3] * logicalSize.height))]);
        sendJson(ws, {type: 'action-result', action: 'swipe', ok: true});
        lastInteractionAt = Date.now();
      });
    } else if (message.type === 'button') {
      const buttons = {home: 'HOME', lock: 'LOCK'};
      if (!(message.name in buttons)) { sendJson(ws, {type: 'error', message: 'Unknown simulator button.'}); return; }
      await runAction(ws, message.name, async () => {
        await runIdb(['ui', 'button', buttons[message.name]]);
        lastInteractionAt = Date.now();
        sendJson(ws, {type: 'action-result', action: message.name, ok: true});
      });
    } else if (message.type === 'rotate') {
      await runAction(ws, 'rotate', async () => {
        orientation = orientation === 'PORTRAIT' ? 'LANDSCAPE_LEFT' : 'PORTRAIT';
      await runIdb(['rotation', orientation]);
      logicalSize = await getLogicalSize(udid);
      sendJson(ws, {type: 'ready', deviceName, logicalSize, provider, fps});
        lastInteractionAt = Date.now();
        sendJson(ws, {type: 'action-result', action: 'rotate', ok: true, orientation});
      });
    } else if (message.type === 'shake') {
      await runAction(ws, 'shake', async () => {
        await runIdb(['ui', 'shake']);
        lastInteractionAt = Date.now();
        sendJson(ws, {type: 'action-result', action: 'shake', ok: true});
      });
    } else if (message.type === 'appearance') {
      if (!['dark', 'light'].includes(message.value)) { sendJson(ws, {type: 'error', message: 'Unknown appearance.'}); return; }
      await runAction(ws, 'appearance', async () => {
        await exec('xcrun', ['simctl', 'ui', udid, 'appearance', message.value]);
        lastInteractionAt = Date.now();
        sendJson(ws, {type: 'action-result', action: 'appearance', ok: true});
      });
    } else if (message.type === 'keyboard') {
      if (typeof message.text !== 'string' || message.text.length > 500) { sendJson(ws, {type: 'error', message: 'Keyboard input is too long.'}); return; }
      await runAction(ws, 'keyboard', async () => {
        await runIdb(['ui', 'text', message.text]);
        lastInteractionAt = Date.now();
        sendJson(ws, {type: 'action-result', action: 'keyboard', ok: true});
      });
    } else if (message.type === 'screenshot') {
      await runAction(ws, 'screenshot', async () => {
        const file = screenshot();
        const bytes = await readFile(file);
        sendJson(ws, {type: 'screenshot', filename: path.basename(file), data: bytes.toString('base64')});
        lastInteractionAt = Date.now();
      });
    } else if (message.type === 'reload') {
      await runAction(ws, 'reload', async () => {
        const stoppedApp = spawnSync('xcrun', ['simctl', 'terminate', udid, bundleId], {encoding: 'utf8'});
        if (stoppedApp.status !== 0 && !/not running/i.test(`${stoppedApp.stderr}\n${stoppedApp.stdout}`)) throw new Error('Could not stop the app before reloading.');
        await exec('xcrun', ['simctl', 'launch', udid, bundleId]);
        lastInteractionAt = Date.now();
        sendJson(ws, {type: 'action-result', action: 'reload', ok: true});
      });
    } else if (message.type === 'device') {
      if (!['iphone15', 'latest'].includes(message.preset)) { sendJson(ws, {type: 'error', message: 'Unknown simulator preset.'}); return; }
      await runAction(ws, 'device', async () => {
        sendJson(ws, {type: 'device-loading', preset: message.preset});
        const device = await switchDevice(message.preset);
        lastInteractionAt = Date.now();
        sendJson(ws, {type: 'ready', ...device, provider, fps});
      });
    } else {
      sendJson(ws, {type: 'error', message: 'Unsupported simulator command.'});
    }
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    clients.delete(ws);
    if (activeViewer === ws) activeViewer = null;
  });
  ws.on('error', () => {});
});

async function runAction(ws, action, operation) {
  if (actionBusy) { sendJson(ws, {type: 'action-result', action, ok: false, error: 'Another simulator action is still running.'}); return; }
  actionBusy = true;
  try { await operation(); }
  catch (error) {
    log(`${action} failed: ${error.message.slice(0, 400)}`);
    sendJson(ws, {type: 'action-result', action, ok: false, error: error.message.slice(0, 500)});
  } finally { actionBusy = false; }
}

function insideUnit(value) { return Number.isFinite(value) && value >= 0 && value <= 1; }

function broadcastStatus() {
  const now = Date.now();
  const elapsed = (now - frameWindowStart) / 1000;
  if (elapsed >= 5) {
    currentFps = frameWindowCount / elapsed;
    frameWindowCount = 0;
    frameWindowStart = now;
  }
  const status = {
    type: 'status',
    connected: Boolean(activeViewer?.readyState === WebSocket.OPEN),
    fps: Number(currentFps.toFixed(1)),
    lastFrameAt,
    deviceName,
    logicalSize,
    provider,
    remainingMs: Math.max(0, maxSessionMs - (now - startedAt)),
  };
  if (activeViewer?.readyState === WebSocket.OPEN) sendJson(activeViewer, status);
}

let resolveStop;
const stopPromise = new Promise((resolve) => { resolveStop = resolve; });
async function stop(reason) {
  if (stopping) return;
  stopping = true;
  log(`Stopping: ${reason}.`);
  streamProcess?.kill('SIGTERM');
  appLogProcess?.kill('SIGTERM');
  for (const ws of clients) ws.close(1001, 'Session stopped');
  httpServer.close(() => resolveStop());
  setTimeout(() => resolveStop(), 1500).unref();
}

const timer = setInterval(() => {
  const elapsed = Date.now() - startedAt;
  if (elapsed >= maxSessionMs) { void stop('5h30 session cap reached'); return; }
  if (!activeViewer && Date.now() - lastHeartbeatAt >= maxHeartbeatSilenceMs) { void stop('no viewer heartbeat for 5 minutes'); return; }
  if (activeViewer && Date.now() - lastInteractionAt >= idleTimeoutMs) { void stop('configured inactivity timeout reached'); return; }
  broadcastStatus();
}, 1000);
timer.unref();

await new Promise((resolve, reject) => {
  httpServer.once('error', reject);
  httpServer.listen(port, '0.0.0.0', resolve);
});
startAppLogStream();
startStream();
log(`UI_IOS_SERVER_READY device=${deviceName} logical=${logicalSize.width}x${logicalSize.height} provider=${provider} fpsTarget=${fps}.`);
await stopPromise;
clearInterval(timer);
appLog.end();
await rm(fallbackPath, {force: true});
await rm(fallbackPng, {force: true});
await rm(path.join(evidenceDir, 'final-screen.png'), {force: true});
try { exec('xcrun', ['simctl', 'io', udid, 'screenshot', path.join(evidenceDir, 'final-screen.png')], 15_000); }
catch { /* The simulator may already have shut down after a failed job. */ }
log('Session server stopped cleanly.');
