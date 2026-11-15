// Fixture server for `scripts/smoke.mjs`.
//
// Serves `fixture.html` plus `/api/ping`, which exists so the network checks
// can read a real JSON body and assert that credential-bearing headers are
// redacted on both sides. Bound to 127.0.0.1 only.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.FIXTURE_PORT ?? 8787);

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (pathname === '/api/ping') {
    res.writeHead(200, {
      'content-type': 'application/json',
      // `no-store` would let Chrome discard the body before `network_body`
      // reads it; `max-age` keeps it retrievable for the smoke check.
      'cache-control': 'max-age=60',
      // Must never reach the agent: the daemon redacts it at capture time.
      'x-api-key': 'server-secret',
    });
    res.end(JSON.stringify({ ok: true, pong: 'smoke' }));
    return;
  }

  const relative = pathname === '/' ? 'fixture.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const type = file.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(data);
  });
});

server.listen(port, '127.0.0.1');
