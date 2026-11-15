// browserd smoke test — zero dependencies, plain node:net NDJSON client.
//
// Flow: hello → navigate fixture → snapshot → click submit → fill email →
// screenshot → eval → status (+ occlusion, console and network bonus checks).
// Exits 0 only when every assertion passes.
//
// Env:
//   BROWSERD_SOCKET  socket path (default
//                    $XDG_RUNTIME_DIR/opencode-browser/v1/daemon.sock)
//   FIXTURE_URL      page under test (default http://127.0.0.1:8787/fixture.html)

import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION = 'smoke';
const FIXTURE_URL = process.env.FIXTURE_URL ?? 'http://127.0.0.1:8787/fixture.html';
const SOCKET =
  process.env.BROWSERD_SOCKET ??
  path.join(
    process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
    'opencode-browser',
    'v1',
    'daemon.sock',
  );

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function fixtureReachable() {
  try {
    const response = await fetch(FIXTURE_URL, { method: 'HEAD' });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

async function ensureFixtureServer() {
  if (await fixtureReachable()) return null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn('python3', ['-m', 'http.server', '8787', '-d', here], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await fixtureReachable()) return child;
  }
  throw new Error('fixture server did not become reachable');
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function createClient(socket) {
  let buffer = '';
  const pending = new Map();
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(JSON.stringify(message.id));
      if (waiter) {
        pending.delete(JSON.stringify(message.id));
        waiter(message);
      }
    }
  });
  socket.on('close', () => {
    for (const waiter of pending.values()) waiter({ ok: false, error: { code: 'DAEMON_UNAVAILABLE' } });
    pending.clear();
  });

  let nextId = 0;
  return {
    call(method, params, timeoutMs = 45_000) {
      const id = `smoke-${++nextId}`;
      const line = JSON.stringify({ id, method, params, session: SESSION }) + '\n';
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(JSON.stringify(id));
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(JSON.stringify(id), (message) => {
          clearTimeout(timer);
          resolve({ message, elapsedMs: Date.now() - started });
        });
        socket.write(line);
      });
    },
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
let fixtureChild = null;
try {
  fixtureChild = await ensureFixtureServer();
} catch (err) {
  console.log(`FAIL  fixture server — ${err.message}`);
  process.exit(1);
}

let socket;
try {
  socket = await connect(SOCKET);
} catch (err) {
  console.log(`FAIL  connect ${SOCKET} — ${err.message}`);
  console.log('Start the daemon first, e.g. ../daemon/target/debug/browserd');
  process.exit(1);
}
const client = createClient(socket);
const timings = {};
async function timed(name, method, params, timeoutMs) {
  const { message, elapsedMs } = await client.call(method, params, timeoutMs);
  timings[name] = elapsedMs;
  return message;
}

try {
  // hello — requires protocol:1, returns daemon_version + chrome + capabilities.
  const hello = await timed('hello', 'hello', { protocol: 1, shimVersion: 'smoke/0' });
  check('hello ok', hello.ok === true, `ok=${hello.ok}`);
  check('hello protocol', hello.result?.protocol === 1, JSON.stringify(hello.result?.protocol));
  check('hello version', typeof hello.result?.daemon_version === 'string', hello.result?.daemon_version);
  // Chrome launches lazily on the first tab-needing call, so hello on a
  // fresh daemon honestly reports alive:false; liveness is asserted at status.
  check(
    'hello chrome shape',
    hello.result?.chrome && 'alive' in hello.result.chrome && 'version' in hello.result.chrome,
    JSON.stringify(hello.result?.chrome),
  );
  check(
    'hello capabilities',
    Array.isArray(hello.result?.capabilities) && hello.result.capabilities.includes('snapshot'),
    (hello.result?.capabilities ?? []).join(','),
  );

  // navigate the fixture.
  const nav = await timed('navigate', 'navigate', { url: FIXTURE_URL }, 60_000);
  check('navigate ok', nav.ok === true, nav.error ? `${nav.error.code}: ${nav.error.message}` : nav.result?.url);
  check('navigate url', typeof nav.result?.url === 'string' && nav.result.url.includes('fixture.html'), nav.result?.url);
  check('navigate tab_id', typeof nav.result?.tab_id === 'string', nav.result?.tab_id);
  check('navigate title', nav.result?.title === 'browserd smoke fixture', JSON.stringify(nav.result?.title));
  const tabId = nav.result?.tab_id;
  if (!nav.ok) throw new Error('navigate failed; cannot continue');

  // snapshot — find the uids we need from the structured nodes.
  const snap = await timed('snapshot', 'snapshot', { tab_id: tabId });
  check('snapshot ok', snap.ok === true, snap.error ? `${snap.error.code}` : `${snap.result?.total} nodes`);
  const nodes = snap.result?.nodes ?? [];
  const byName = (name) => nodes.find((n) => n.name === name)?.uid;
  const emailUid = byName('you@example.com') ?? nodes.find((n) => n.role === 'textbox')?.uid;
  const submitUid = nodes.find((n) => n.role === 'button' && /sign in/i.test(n.name))?.uid;
  const appendUid = byName('Append text');
  const occludedUid = byName('Occluded button');
  check('snapshot text shape', typeof snap.result?.text === 'string' && snap.result.text.includes('url:'), `${nodes.length} nodes`);
  check('snapshot email uid', !!emailUid, emailUid ?? 'missing');
  check('snapshot submit uid', !!submitUid, submitUid ?? 'missing');
  check('snapshot append uid', !!appendUid, appendUid ?? 'missing');
  check('snapshot occluded uid', !!occludedUid, occludedUid ?? 'missing');
  if (!emailUid || !submitUid) throw new Error('missing uids; cannot continue');

  // click the submit button (form submit is preventDefaulted: no navigation).
  const click = await timed('click', 'click', { uid: submitUid });
  check('click ok', click.ok === true, click.error ? `${click.error.code}: ${click.error.message}` : JSON.stringify(click.result));
  const submitted = await timed('eval-submitted', 'eval', { js: "document.getElementById('status').textContent" });
  check('click had an effect', submitted.result?.value === 'submitted', JSON.stringify(submitted.result?.value));

  // fill the email field and verify the DOM value.
  const fill = await timed('fill', 'fill', { uid: emailUid, value: 'test@example.com' });
  check('fill ok', fill.ok === true, fill.error ? `${fill.error.code}` : JSON.stringify(fill.result));
  const value = await timed('eval-value', 'eval', { js: "document.getElementById('email').value" });
  check('fill landed in the DOM', value.result?.value === 'test@example.com', JSON.stringify(value.result?.value));

  // click the append button, verify new text; occlusion probe on the covered button.
  if (appendUid) {
    const append = await timed('click-append', 'click', { uid: appendUid });
    check('append click ok', append.ok === true, append.error?.code ?? 'ok');
    const lines = await timed('eval-append', 'eval', {
      js: "document.querySelectorAll('#appended .line').length",
    });
    check('append had an effect', lines.result?.value === 1, JSON.stringify(lines.result?.value));
  }
  if (occludedUid) {
    const blocked = await timed('click-occluded', 'click', { uid: occludedUid });
    check(
      'occluded click reports ELEMENT_OCCLUDED',
      blocked.ok === false && blocked.error?.code === 'ELEMENT_OCCLUDED',
      blocked.ok ? 'unexpectedly ok' : `${blocked.error?.code}: ${blocked.error?.message}`,
    );
  }

  // screenshot — must be a real PNG on disk with dimensions.
  const shot = await timed('screenshot', 'screenshot', { tab_id: tabId });
  check('screenshot ok', shot.ok === true, shot.error ? shot.error.code : shot.result?.path);
  check(
    'screenshot dimensions',
    Number.isInteger(shot.result?.width) && shot.result?.width > 0 && Number.isInteger(shot.result?.height) && shot.result?.height > 0,
    `${shot.result?.width}x${shot.result?.height}`,
  );
  const shotPath = shot.result?.path ?? '';

  // eval + status.
  const evaled = await timed('eval', 'eval', { js: 'document.title' });
  check('eval ok', evaled.ok === true && evaled.result?.value === 'browserd smoke fixture', JSON.stringify(evaled.result?.value));
  const evalErr = await timed('eval-error', 'eval', { js: '(() => { throw new Error("boom"); })()' });
  check(
    'eval error is typed',
    evalErr.ok === false && evalErr.error?.code === 'EVAL_ERROR',
    evalErr.ok ? 'unexpectedly ok' : evalErr.error?.code,
  );
  const status = await timed('status', 'status', {});
  check('status ok', status.ok === true, status.error?.code ?? `${status.result?.tabs} tabs`);
  check('status tabs', (status.result?.tabs ?? 0) >= 1, `${status.result?.tabs} tabs`);
  check('status chrome alive', status.result?.chrome_alive === true, JSON.stringify(status.result?.chrome_alive));
  const rss = status.result?.rss_mb;

  // console + network capture (wired via page listeners).
  const messages = await timed('console', 'console', { tab_id: tabId, limit: 50 });
  check(
    'console captured the fixture log',
    messages.ok === true && (messages.result?.messages ?? []).some((m) => m.text?.includes('smoke fixture loaded')),
    messages.ok ? `${messages.result?.messages?.length ?? 0} messages` : messages.error?.code,
  );
  const requests = await timed('network', 'network', { tab_id: tabId, limit: 50 });
  check(
    'network captured the fixture fetch',
    requests.ok === true && (requests.result?.requests ?? []).some((r) => r.url?.includes('/api/ping')),
    requests.ok ? `${requests.result?.requests?.length ?? 0} requests` : requests.error?.code,
  );

  console.log('\n--- timings (ms) ---');
  for (const [name, ms] of Object.entries(timings)) console.log(`${name}: ${ms}`);
  console.log(`daemon RSS: ${typeof rss === 'number' ? rss.toFixed(1) + ' MiB' : rss}`);
  console.log(`screenshot: ${shotPath}`);
} catch (err) {
  console.log(`FAIL  harness — ${err.message}`);
} finally {
  socket.destroy();
  if (fixtureChild) fixtureChild.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
