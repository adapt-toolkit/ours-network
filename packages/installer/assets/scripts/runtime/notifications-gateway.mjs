import { createServer, request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFileSync, statSync } from 'node:fs';

/** Browser context has no authority at the notification service. */
const BROWSER = ['cookie', 'origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user'];
const SERVER_CREDENTIAL = 'x-ours-api-token', PRODUCER = 'x-ours-notifications-producer';

/** Ask the daemon, exactly like the gateway's auth_request, whether a server API credential is valid. */
export function daemonCredentialCheck(daemonUrl) {
  return token => new Promise(resolve => {
    const req = request(new URL('/identities', daemonUrl), { method: 'GET', headers: { [SERVER_CREDENTIAL]: token }, timeout: 5000 }, res => {
      res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Front the notification service with the server's own authentication.
 * A request carrying a server API credential is checked with the daemon; only then
 * does it act as this installation's owner (or, for producer lifecycle routes, as the named
 * producer). A request without one keeps its own Authorization, which the service
 * checks against its scoped tokens. Nothing is injected for an unauthenticated caller.
 */
export function createNotificationsAdapter({ service, userToken, verifyServerCredential }) {
  const authorize = async (req) => {
    for (const name of BROWSER) delete req.headers[name];
    const credential = req.headers[SERVER_CREDENTIAL], producer = req.headers[PRODUCER];
    delete req.headers[SERVER_CREDENTIAL]; delete req.headers[PRODUCER];
    if (credential === undefined) return producer === undefined;
    if (typeof credential !== 'string' || !credential || !await verifyServerCredential(credential)) return false;
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (producer !== undefined && !(req.method === 'POST' && ['/api/v1/send', '/api/v1/delete-target'].includes(path))) return false;
    req.headers.authorization = `Bearer ${producer ?? userToken}`;
    return true;
  };
  const server = createServer(async (req, res) => {
    if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    if (!await authorize(req)) { res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"error":"authentication required"}'); return; }
    service.server.emit('request', req, res);
  });
  // Upgraded connections leave the HTTP server's connection tracking, so shutdown ends them itself.
  const upgraded = new Set();
  server.on('upgrade', async (req, socket, head) => {
    upgraded.add(socket); socket.once('close', () => upgraded.delete(socket));
    if (!await authorize(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    service.server.emit('upgrade', req, socket, head);
  });
  return { server, async close() {
    // Stop accepting first; the service then ends its presence sockets and saves state.
    const listening = new Promise(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await service.close();
    for (const socket of upgraded) socket.destroy();
    await listening;
  } };
}

/** The installer-generated private configuration also names the owner token this adapter injects. */
export function readPrivateConfig(path) {
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error('Notification configuration must be a private owner file');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(config.users) || config.users.length !== 1 || typeof config.users[0]?.token !== 'string') throw new Error('Notification configuration must select one owner');
  return config;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = readPrivateConfig(process.env.OURS_NOTIFICATIONS_CONFIG ?? '/var/lib/ours-notifications/config.json');
  const { createNotificationService } = await import('/opt/ours/node_modules/@ours.network/notifications/dist/server.js');
  const adapter = createNotificationsAdapter({
    service: createNotificationService(config),
    userToken: config.users[0].token,
    verifyServerCredential: daemonCredentialCheck(process.env.OURS_DAEMON_URL ?? 'http://daemon:3050'),
  });
  await new Promise((resolve, reject) => { adapter.server.once('error', reject); adapter.server.listen(config.port, config.host, resolve); });
  console.log('Notification service ready');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await adapter.close(); process.exit(0); });
}
