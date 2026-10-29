import { generateKeyPairSync, randomBytes } from 'node:crypto';

const NOTIFICATIONS_PORT = 49677;

export function notificationConfig() {
  const token = () => randomBytes(32).toString('base64url');
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' }), key = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
  return {
    host: '0.0.0.0', port: NOTIFICATIONS_PORT, stateFile: '/var/lib/ours-notifications/state.json',
    users: [{ userId: 'owner', token: token() }],
    producers: [{ userId: 'owner', source: 'fleet', token: token(), capabilities: ['mission-ownership'] }, { userId: 'owner', source: 'messenger', token: token() }],
    vapid: { subject: 'https://ours.network', publicKey: raw.toString('base64url'), privateKey: key.d },
  };
}

/** Exact retained shape; any other content is operator state the installer will not rewrite. */
export function validNotificationConfig(config) {
  const tokens = [...(config.users ?? []), ...(config.producers ?? [])].map(entry => entry?.token);
  return config.host === '0.0.0.0' && config.port === NOTIFICATIONS_PORT && config.stateFile === '/var/lib/ours-notifications/state.json'
    && Array.isArray(config.users) && config.users.length === 1 && config.users[0].userId === 'owner'
    && Array.isArray(config.producers) && config.producers.length === 2
    && ['fleet', 'messenger'].every(source => config.producers.some(p => p?.source === source && p.userId === 'owner'))
    && tokens.every(t => typeof t === 'string' && t.length >= 32) && new Set(tokens).size === tokens.length
    && typeof config.vapid?.subject === 'string' && /^[A-Za-z0-9_-]{87}$/.test(config.vapid.publicKey ?? '') && /^[A-Za-z0-9_-]{43}$/.test(config.vapid.privateKey ?? '');
}

/** Upgrade only the installer-selected owner/Fleet credential; tokens and other settings are retained.
 * A delivery file, when already present, must agree before permissions change. */
export function upgradeFleetMissionCapability(config, deliveredFleetToken) {
  if (!validNotificationConfig(config)) throw new Error('Existing notification configuration differs; use the supported maintenance workflow');
  const fleet = config.producers.find(p => p.source === 'fleet');
  if (deliveredFleetToken !== undefined && deliveredFleetToken !== fleet.token)
    throw new Error('Existing Fleet notification credential binding differs; use the supported maintenance workflow');
  if (fleet.capabilities !== undefined && (!Array.isArray(fleet.capabilities) || fleet.capabilities.some(c => typeof c !== 'string')))
    throw new Error('Existing Fleet notification capabilities are invalid; use the supported maintenance workflow');
  if (fleet.capabilities?.includes('mission-ownership')) return false;
  fleet.capabilities = [...(fleet.capabilities ?? []), 'mission-ownership'];
  return true;
}
