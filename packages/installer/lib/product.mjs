/**
 * What a managed installation is for. Recorded once in installation.json and
 * retained by every later repair, update and removal: neither choice is ever
 * widened or narrowed implicitly.
 *
 *   workspace    the complete Ours workspace: daemon, Telegram, Cowork,
 *                Messenger (with Notifications) and the one-URL gateway, plus
 *                Fleet on the host. Records without a product are workspaces.
 *   plugin-only  collaboration tools for existing agent apps: only the daemon
 *                container, reached by Claude Code / Codex through the daemon's
 *                own client prefix. No gateway, Cowork, Messenger, Telegram,
 *                Notifications or Fleet.
 */
export const PRODUCTS = ['workspace', 'plugin-only'];
export const PLUGIN_ONLY = 'plugin-only';
export const PLUGIN_ONLY_INTEGRATIONS = ['claude-code', 'codex'];
/** Container port of the daemon's client prefix; the raw daemon port stays internal. */
export const CLIENT_PREFIX_PORT = 3049;

export const productOf = record => record?.product ?? 'workspace';
export const isPluginOnly = value => (typeof value === 'string' ? value : productOf(value)) === PLUGIN_ONLY;
/** Package selection role: plugin-only selects only the SDK, CLI and daemon. */
export const serverRole = value => isPluginOnly(value) ? 'daemon' : 'server';
/** Applications whose state, credentials and services the installation owns. */
export const applicationsOf = record => record.services.filter(service => service !== 'gateway');

export const PRODUCT_LABELS = {
  'plugin-only': 'Collaboration tools for my existing agent apps',
  workspace: 'The complete Ours workspace',
};

/**
 * Compose overlay for a plugin-only installation. The daemon container serves
 * the client prefix itself and publishes only that port, on loopback; the raw
 * daemon API is not published. Administrative jobs see only daemon state, so no
 * application state, configuration or credential is created for services this
 * installation does not run.
 */
export function pluginOnlyCompose() {
  const volume = (target, subpath) => `      - {type: volume, source: server-storage, target: ${target}, volume: {nocopy: true${subpath ? `, subpath: ${subpath}` : ''}}}`;
  const locks = '      - {type: volume, source: owner-locks, target: "/tmp/ours-${OURS_UID:-1000}", volume: {nocopy: true}}';
  return `services:
  prepare:
    environment:
      OURS_SERVER_APPLICATIONS: daemon
  daemon:
    entrypoint: [node, /opt/ours/docker/daemon-client-prefix.mjs]
    environment:
      OURS_SERVER_APPLICATIONS: daemon
      OURS_DAEMON_CLIENT_PREFIX_PORT: "${CLIENT_PREFIX_PORT}"
    ports: !override
      - {target: ${CLIENT_PREFIX_PORT}, published: "\${OURS_HOST_PORT:-3050}", host_ip: 127.0.0.1}
  access:
    environment:
      OURS_SERVER_APPLICATIONS: daemon
    volumes: !override
${volume('/var/lib/ours', 'state/daemon')}
${volume('/var/lib/ours-mcp', 'state/mcp')}
${locks}
  state-operation:
    environment:
      OURS_SERVER_APPLICATIONS: daemon
    volumes: !override
${volume('/storage')}
${volume('/var/lib/ours', 'state/daemon')}
${volume('/var/lib/ours-mcp', 'state/mcp')}
`;
}
export const PLUGIN_ONLY_COMPOSE = 'compose.plugin-only.yaml';
