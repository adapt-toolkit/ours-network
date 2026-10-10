import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';

/**
 * Plugin-only installations run no gateway container. Current client releases
 * still address the daemon as <serverUrl>/daemon, so the daemon container itself
 * serves that one prefix. Requests and responses pass through unchanged, including
 * the client's own credential and instance checks; nothing is added or injected.
 * Any other path, method form or host-absolute target is refused.
 */
export const PREFIX = '/daemon';
export const CAPABILITY = 'ours.daemon-prefix-v1';
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade'];

/** Only origin-form targets under the prefix; the remainder is the daemon path. */
export function daemonPath(target) {
  if (typeof target !== 'string' || !target.startsWith(PREFIX + '/') || /[\s\\]/.test(target)) return null;
  const rest = target.slice(PREFIX.length);
  // A dot segment could step out of the prefix once normalized by the daemon.
  for (const segment of rest.split('?')[0].split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return null; }
    if (decoded === '.' || decoded === '..' || decoded.includes('/')) return null;
  }
  return rest;
}

export function discovery(instanceId) {
  return { schema: 1, instanceId, services: { daemon: PREFIX }, capabilities: [CAPABILITY] };
}

/** Headers as received, minus hop-by-hop ones; repeated headers keep every value. */
function headersFor(raw) {
  const headers = {};
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (HOP.includes(name)) continue;
    if (!Object.hasOwn(headers, name)) headers[name] = raw[i + 1];
    else if (name === 'set-cookie') headers[name] = [].concat(headers[name], raw[i + 1]);
    else headers[name] = `${headers[name]}, ${raw[i + 1]}`;
  }
  return headers;
}

export function createPrefixServer({ upstreamPort = 3050, upstreamHost = '127.0.0.1', instanceId }) {
  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    if (req.url === '/.well-known/ours' && req.method === 'GET') return reply(res, 200, discovery(instanceId));
    if (req.url === PREFIX) { res.writeHead(308, { location: PREFIX + '/' }); res.end(); return; }
    const path = daemonPath(req.url);
    if (path === null) return reply(res, 404, { error: 'not found' });
    const upstream = request({ host: upstreamHost, port: upstreamPort, method: req.method, path, headers: headersFor(req.rawHeaders) }, response => {
      res.writeHead(response.statusCode ?? 502, headersFor(response.rawHeaders));
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.on('error', () => { if (!res.headersSent) reply(res, 502, { error: 'daemon unavailable' }); else res.destroy(); });
    // A client that goes away cancels its long poll or stream at the daemon too.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    const path = daemonPath(req.url);
    if (path === null) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const upstream = connect(upstreamPort, upstreamHost, () => {
      const lines = [`${req.method} ${path} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', close); socket.on('error', close);
    upstream.on('close', () => socket.destroy()); socket.on('close', () => upstream.destroy());
  });
  // Absolute-form ("GET http://host/...") and CONNECT never reach the daemon.
  server.on('connect', (req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  return server;
}

/**
 * Run the daemon's own locked, recovering entrypoint as the single child and
 * serve the prefix beside it. Either one ending stops the other, so the
 * container exits and its restart policy recovers both together.
 */
async function main() {
  const port = Number(process.env.OURS_DAEMON_CLIENT_PREFIX_PORT);
  const instanceId = process.env.OURS_DAEMON_ID ?? '';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(instanceId)) {
    console.error('OURS daemon client prefix requires a port and the daemon UUID'); process.exit(2);
  }
  const runtime = process.env.OURS_RUNTIME_ROOT ?? '/opt/ours';
  const child = spawn('/bin/sh', ['-e', `${runtime}/docker/entrypoint.sh`], { stdio: 'inherit' });
  const server = createPrefixServer({ instanceId });
  let stopping = false;
  const stop = (signal, code) => {
    if (stopping) return;
    stopping = true;
    server.close();
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    else process.exit(code);
  };
  child.on('exit', (code, signal) => { server.close(); process.exit(code ?? (signal ? 1 : 0)); });
  child.on('error', () => { server.close(); process.exit(1); });
  server.on('error', error => { console.error(`OURS daemon client prefix stopped: ${error.code ?? error.message}`); stop('SIGTERM', 1); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(signal, 0));
  server.listen(port, '0.0.0.0', () => console.error(`OURS daemon client prefix ready on ${PREFIX}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
