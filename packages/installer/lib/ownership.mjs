// Ownership records written at installation time, read by complete removal.
//
// A client generation under ~/.ours-client-install can serve more than one
// managed installation, and identical selections are not proof of who uses it.
// Each acquisition therefore records the installation instances it was acquired
// for. Server roots record the image IDs this installer built, so removal never
// relies on an image name alone.
import { join } from 'node:path';

export const OWNERS_FILE = 'owners.json';
export const OWNED_IMAGES_FILE = 'owned-images.json';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Owner instance IDs of a generation; null when it predates owner records or the record is unusable. */
export function readOwners(effects, generation) {
  const text = effects.readText(join(generation, OWNERS_FILE));
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    if (value?.schema !== 1 || !Array.isArray(value.instances) || value.instances.some(id => !UUID.test(id))) return null;
    return [...new Set(value.instances)];
  } catch { return null; }
}

/** The next owner record for a generation, or null when nothing changes. */
export function addOwner(text, instanceId) {
  if (!UUID.test(instanceId ?? '')) return null;
  let instances = [];
  if (text !== null && text !== undefined) {
    try {
      const value = JSON.parse(text);
      if (value?.schema === 1 && Array.isArray(value.instances) && value.instances.every(id => UUID.test(id))) instances = value.instances;
    } catch { /* replaced by a valid record below */ }
  }
  if (instances.includes(instanceId)) return null;
  return JSON.stringify({ schema: 1, instances: [...instances, instanceId] }, null, 2) + '\n';
}

/** The next owned-images record for a server root. */
export function ownedImagesRecord(text, images) {
  let current = {};
  try { const value = JSON.parse(text ?? ''); if (value?.schema === 1 && value.images && typeof value.images === 'object') current = value.images; } catch { /* rewritten */ }
  const next = { ...current, ...images };
  return JSON.stringify(current) === JSON.stringify(next) ? null : JSON.stringify({ schema: 1, images: next }, null, 2) + '\n';
}
