// click_at vs click parity proof — zero dependencies, plain node:net NDJSON.
//
// Flow: hello → navigate fixture → snapshot → click(append uid) → eval count
// → eval append-button center → click_at(x, y) → eval count. Parity holds when
// each click adds exactly one line and click_at echoes its coordinates.
//
// Exit 0 on PASS or on honest SKIP (daemon predates click_at: the click
// baseline is still verified). Exit 1 on any real parity failure.
//
// Env: same as smoke.mjs — BROWSERD_SOCKET, FIXTURE_URL.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION = 'click-proof';
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
  const child = spawn(process.execPath, [path.join(here, 'fixture-server.mjs')], {
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

  let nextId = 0;
  return {
    call(method, params, timeoutMs = 45_000) {
      const id = `proof-${++nextId}`;
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
  const hello = await timed('hello', 'hello', { protocol: 1, shimVersion: 'click-proof/0' });
  check('hello ok', hello.ok === true, hello.error ? hello.error.code : 'ok');
  const advertisesClickAt =
    Array.isArray(hello.result?.capabilities) &&
    hello.result.capabilities.includes('click_at');

  const nav = await timed('navigate', 'navigate', { url: FIXTURE_URL }, 60_000);
  check('navigate ok', nav.ok === true, nav.error ? `${nav.error.code}: ${nav.error.message}` : nav.result?.url);
  if (!nav.ok) throw new Error('navigate failed; cannot continue');
  // Visible-browser loop: `Page.bringToFront` runs after navigate resolve.
  // Headless-harmless by construction (result swallowed, never fails the
  // navigation); a headed effect is only observable on a visible browser,
  // so this script records the call path, not a headed assertion.
  console.log('note  bringToFront runs post-resolve, pre-lock (headless no-op; unit-covered)');

  const snap = await timed('snapshot', 'snapshot', {});
  check('snapshot ok', snap.ok === true, snap.error ? snap.error.code : `${snap.result?.nodes?.length ?? 0} nodes`);
  const nodes = snap.result?.nodes ?? [];
  const appendUid = nodes.find((n) => n.name === 'Append text')?.uid;
  check('append uid found', !!appendUid, appendUid ?? 'missing');
  if (!appendUid) throw new Error('append uid missing; cannot continue');

  const countOf = () =>
    timed('eval-count', 'eval', {
      js: "document.querySelectorAll('#appended .line').length",
    }).then((m) => m.result?.value);

  const count0 = await countOf();
  const clicked = await timed('click', 'click', { uid: appendUid });
  check('click ok', clicked.ok === true, clicked.error ? clicked.error.code : 'ok');
  const count1 = await countOf();
  check(
    'click baseline: one uid click adds one line',
    count1 === count0 + 1,
    `count ${count0} → ${count1}`,
  );

  const center = await timed('eval-center', 'eval', {
    js: `(() => { const r = document.getElementById('append').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  });
  const { x, y } = center.result?.value ?? {};
  check(
    'append center measurable in viewport CSS px',
    typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y),
    JSON.stringify(center.result?.value),
  );

  if (!advertisesClickAt) {
    console.log('SKIP  click_at parity — daemon predates click_at (no such capability)');
  } else {
    const at = await timed('click_at', 'click_at', { x, y });
    check('click_at ok', at.ok === true, at.error ? `${at.error.code}: ${at.error.message}` : JSON.stringify(at.result));
    if (at.ok === true) {
      check(
        'click_at echoes its coordinates',
        at.result?.x === x && at.result?.y === y,
        JSON.stringify(at.result),
      );
      const count2 = await countOf();
      check(
        'click_at parity: one coordinate click adds one line',
        count2 === count1 + 1,
        `count ${count1} → ${count2}`,
      );
    }
  }

  console.log('\n--- timings (ms) ---');
  for (const [name, ms] of Object.entries(timings)) console.log(`${name}: ${ms}`);
} catch (err) {
  console.log(`FAIL  harness — ${err.message}`);
  socket.destroy();
  if (fixtureChild) fixtureChild.kill();
  process.exit(1);
}

socket.destroy();
if (fixtureChild) fixtureChild.kill();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
