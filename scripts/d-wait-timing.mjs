// D-lane timing proof: fast-appear vs timeout-slow paths for the two new
// bounded waits. Plain node:net NDJSON client (same framing as scripts/smoke.mjs).
// Exits 0 only when: both fast calls succeed quickly AND both timeout calls
// fail typed (NAV_TIMEOUT) after ~the requested budget.
// Env: BROWSERD_SOCKET, FIXTURE_URL (same defaults as smoke.mjs).
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION = 'd-wait-timing';
const FIXTURE_URL = process.env.FIXTURE_URL ?? 'http://127.0.0.1:8787/fixture.html';
const SOCKET = process.env.BROWSERD_SOCKET ??
  path.join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
    'opencode-browser', 'v1', 'daemon.sock');

async function fixtureReachable() {
  try {
    const r = await fetch(FIXTURE_URL, { method: 'HEAD' });
    return r.ok || r.status === 404;
  } catch { return false; }
}

const here = path.dirname(fileURLToPath(import.meta.url));
let fixtureChild = null;
if (!(await fixtureReachable())) {
  fixtureChild = spawn(process.execPath,
    [path.join(here, 'fixture-server.mjs')], { stdio: 'ignore', detached: true });
  fixtureChild.unref();
  for (let i = 0; i < 50 && !(await fixtureReachable()); i++)
    await new Promise((r) => setTimeout(r, 200));
}
if (!(await fixtureReachable())) { console.log('FAIL fixture server'); process.exit(1); }

const socket = await new Promise((res, rej) => {
  const s = net.createConnection(SOCKET);
  s.once('connect', () => res(s));
  s.once('error', rej);
});
let buffer = '';
const pending = new Map();
socket.setEncoding('utf8');
socket.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const w = pending.get(JSON.stringify(msg.id));
    if (w) { pending.delete(JSON.stringify(msg.id)); w(msg); }
  }
});
let nextId = 0;
function call(method, params, timeoutMs = 45000) {
  const id = `dw-${++nextId}`;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(JSON.stringify(id));
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(JSON.stringify(id), (msg) => {
      clearTimeout(timer);
      resolve({ msg, elapsedMs: Date.now() - started });
    });
    socket.write(JSON.stringify({ id, method, params, session: SESSION }) + '\n');
  });
}

const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const hello = await call('hello', { protocol: 1 });
  check('hello ok', hello.msg.ok === true);
  check('capabilities include waits',
    hello.msg.result?.capabilities?.includes('wait_for_uid') === true &&
    hello.msg.result?.capabilities?.includes('expect_text') === true,
    (hello.msg.result?.capabilities ?? []).join(','));

  const nav = await call('navigate', { url: FIXTURE_URL }, 60000);
  check('navigate ok', nav.msg.ok === true, nav.msg.error?.code ?? nav.msg.result?.url);
  if (!nav.msg.ok) throw new Error('no fixture page; aborting');

  const snap = await call('snapshot', {});
  const nodes = snap.msg.result?.nodes ?? [];
  const uid = nodes.find((n) => n.role === 'textbox')?.uid ?? nodes[0]?.uid;
  check('snapshot uid for fast path', !!uid, uid ?? 'missing');
  if (!uid) throw new Error('no uid; aborting');

  // FAST paths: condition already true -> ~one poll interval.
  const fastUid = await call('wait_for_uid', { uid, timeout_ms: 5000 });
  check('wait_for_uid fast ok', fastUid.msg.ok === true && fastUid.msg.result?.found === true,
    `${fastUid.elapsedMs}ms found=${fastUid.msg.result?.found}`);
  check('wait_for_uid fast is quick (<2s)', fastUid.elapsedMs < 2000, `${fastUid.elapsedMs}ms`);

  const fastText = await call('expect_text', { text: 'Sign in', timeout_ms: 5000 });
  check('expect_text fast ok', fastText.msg.ok === true && fastText.msg.result?.matched === true,
    `${fastText.elapsedMs}ms matched=${fastText.msg.result?.matched}`);
  check('expect_text fast is quick (<2s)', fastText.elapsedMs < 2000, `${fastText.elapsedMs}ms`);

  // SLOW paths: condition never true -> typed NAV_TIMEOUT after ~budget.
  const slowUid = await call('wait_for_uid', { uid: 'g1-999999', timeout_ms: 1200 }, 15000);
  check('wait_for_uid timeout is NAV_TIMEOUT',
    slowUid.msg.ok === false && slowUid.msg.error?.code === 'NAV_TIMEOUT',
    slowUid.msg.ok ? 'unexpectedly ok' : `${slowUid.msg.error?.code} after ${slowUid.elapsedMs}ms`);
  check('wait_for_uid timeout waits the budget (1s..3s)', slowUid.elapsedMs >= 1000 && slowUid.elapsedMs < 3000,
    `${slowUid.elapsedMs}ms`);

  const slowText = await call('expect_text', { text: 'zz-no-such-text-zz', timeout_ms: 1200 }, 15000);
  check('expect_text timeout is NAV_TIMEOUT',
    slowText.msg.ok === false && slowText.msg.error?.code === 'NAV_TIMEOUT',
    slowText.msg.ok ? 'unexpectedly ok' : `${slowText.msg.error?.code} after ${slowText.elapsedMs}ms`);
  check('expect_text timeout waits the budget (1s..3s)', slowText.elapsedMs >= 1000 && slowText.elapsedMs < 3000,
    `${slowText.elapsedMs}ms`);
} catch (err) {
  console.log(`FAIL harness — ${err.message}`);
} finally {
  socket.destroy();
  if (fixtureChild) fixtureChild.kill();
}
const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} timing checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
