import http from 'node:http';
import net from 'node:net';

// A suite-owned stand-in for the installer's gateway: one server URL per side,
// with the daemon under /daemon and Cowork under /cowork. Clients, Fleet and the
// MCP proxy select a server through this URL; the services behind it are real.
const routes = [
  ['/daemon', process.env.GATEWAY_DAEMON_URL],
  ['/cowork', process.env.GATEWAY_COWORK_URL],
].filter(([, target]) => target).map(([prefix, target]) => [prefix, new URL(target)]);
if (routes.length === 0) throw new Error('GATEWAY_DAEMON_URL or GATEWAY_COWORK_URL is required');

function upstream(url = '') {
  for (const [prefix, target] of routes) {
    if (url !== prefix && !url.startsWith(`${prefix}/`) && !url.startsWith(`${prefix}?`)) continue;
    const path = url.slice(prefix.length);
    // Cowork's unauthenticated loopback route must stay unreachable through a gateway.
    if (prefix === '/cowork' && /^\/rpc(?:[/?]|$)/.test(path)) return undefined;
    return { target, path: path.startsWith('/') ? path : `/${path}` };
  }
  return undefined;
}

const refuse = (response, status, error) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error }));
};

const server = http.createServer((request, response) => {
  const selected = upstream(request.url);
  if (!selected) {
    request.resume();
    return refuse(response, 404, 'not found');
  }
  const { target, path } = selected;
  const forward = http.request({
    hostname: target.hostname, port: target.port || 80, method: request.method, path,
    headers: { ...request.headers, host: target.host },
  }, answer => {
    response.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
    answer.pipe(response);
  });
  forward.on('error', () => {
    if (response.headersSent) response.destroy();
    else refuse(response, 502, 'upstream unavailable');
  });
  response.on('close', () => forward.destroy());
  request.pipe(forward);
});

server.on('upgrade', (request, socket, head) => {
  const selected = upstream(request.url);
  if (!selected) return socket.destroy();
  const { target, path } = selected;
  const peer = net.connect(Number(target.port || 80), target.hostname, () => {
    const headers = { ...request.headers, host: target.host };
    peer.write(`${request.method} ${path} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
    if (head.length) peer.write(head);
    socket.pipe(peer);
    peer.pipe(socket);
  });
  peer.on('error', () => socket.destroy());
  socket.on('error', () => peer.destroy());
});

server.listen(8080, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
