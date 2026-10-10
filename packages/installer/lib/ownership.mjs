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

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const IMAGE_TAG = /^ours-[a-z0-9]+:[a-z-]+$/;

/** A generation's owner record: absent, invalid (damaged or unknown format) or the owner IDs. */
export function readOwners(effects, generation) {
  const text = effects.readText(join(generation, OWNERS_FILE));
  if (text === null) return { state: 'absent' };
  const instances = parseOwners(text);
  return instances ? { state: 'valid', instances } : { state: 'invalid' };
}

function parseOwners(text) {
  try {
    const value = JSON.parse(text);
    if (value?.schema !== 1 || !Array.isArray(value.instances) || value.instances.some(id => !UUID.test(id)) || Object.keys(value).length !== 2) return null;
    return [...new Set(value.instances)];
  } catch { return null; }
}

/**
 * The next owner record for a generation, or null when nothing changes. A
 * damaged record is never replaced: that would forget its earlier owners.
 */
export function addOwner(text, instanceId) {
  if (!UUID.test(instanceId ?? '')) return null;
  const instances = text === null || text === undefined ? [] : parseOwners(text);
  if (instances === null) throw new Error('The owner record of the downloaded Ours programs is damaged; it was left unchanged');
  if (instances.includes(instanceId)) return null;
  return JSON.stringify({ schema: 1, instances: [...instances, instanceId] }, null, 2) + '\n';
}

/** The next owned-images record for a server root; a damaged record is left as it is. */
export function ownedImagesRecord(text, images) {
  let current = {};
  if (text !== null && text !== undefined) {
    let value;
    try { value = JSON.parse(text); } catch { return null; }
    if (value?.schema !== 1 || !value.images || typeof value.images !== 'object' || Array.isArray(value.images)
      || Object.entries(value.images).some(([tag, id]) => !IMAGE_TAG.test(tag) || !IMAGE_ID.test(id))) return null;
    current = value.images;
  }
  const added = Object.fromEntries(Object.entries(images ?? {}).filter(([tag, id]) => IMAGE_TAG.test(tag) && IMAGE_ID.test(id)));
  const next = { ...current, ...added };
  return JSON.stringify(current) === JSON.stringify(next) ? null : JSON.stringify({ schema: 1, images: next }, null, 2) + '\n';
}

/** Tags whose image this run created or replaced: a tag it found unchanged is never adopted. */
export function changedImages(before, after) {
  return Object.fromEntries(Object.entries(after ?? {}).filter(([tag, id]) => (before ?? {})[tag] !== id));
}
