import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { After, Status, setDefaultTimeout } from '@cucumber/cucumber';
import { attachOursClient } from '@ours.network/sdk/client';
import { nodes, serverSide } from '../topology.mjs';

setDefaultTimeout(180_000);

export { nodes, serverSide };
export const serverNode = label => nodes[serverSide(label)];
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const secretKey = /token|secret|password|credential|authorization|api.?key|invite|blob/i;
export function redact(value, key = '') {
  if (secretKey.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    try { return redact(JSON.parse(value)); } catch {}
    return value
    .replace(/\/bot[^/\s]+/gi, '/bot[REDACTED]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/[A-Za-z0-9_+\/=-]{100,}/g, '[REDACTED-LONG-VALUE]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([field, item]) => [field, redact(item, field)]));
  return value;
}
export function recordEvidence(world, title, details) {
  (world.evidence ??= []).push({ title, details: redact(details) });
}
export function recordText(world, fileName, content) {
  (world.textEvidence ??= []).push({ fileName, content: redact(content) });
}
async function probe(endpoint) {
  try {
    const response = await fetch(`${endpoint}/selection`, { signal: AbortSignal.timeout(1500) });
    const body = (await response.text()).slice(0, 2048);
    return { endpoint, status: response.status, body: redact(body) };
  } catch (error) {
    return { endpoint, error: String(error) };
  }
}
export async function until(label, fn, ms = 60_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result !== undefined) return result; }
    catch (error) { last = error; }
    await sleep(250);
  }
  throw new Error(`${label}: timed out after ${ms} ms; last error: ${last ?? 'none'}`);
}
export const root = name => ({ name, bio: `E2E ${name}`, exposeLocal: false, localAutoAccept: true, skipIfRootExists: false });
export async function attach(world, node) {
  const client = await attachOursClient({
    endpoint: node.endpoint, expectedInstanceId: node.instanceId,
    credentialPath: node.credentialPath, sessionMode: 'external', leaseToken: randomUUID(), requestSignal: AbortSignal.timeout(150_000),
  });
  (world.clients ??= []).push(client);
  return client;
}
export async function ensureRoot(world, side, name) {
  const node = nodes[side];
  assert.ok(node, `Unknown server: ${side}`);
  assert.ok(name, 'A root identity needs a name');
  const client = await attach(world, node);
  const identities = await client.listIdentities();
  if (!identities.some(item => item.name === name)) {
    assert.equal((await client.createRootIdentity(root(name))).hierarchy, 'root');
  } else {
    await client.chooseIdentity({ name, force: false });
  }
  return client;
}
export async function attachDaemonRoot(world, side, fallbackName) {
  const client = await attach(world, nodes[side]);
  const identities = await client.listIdentities();
  const existing = identities.find(identity => identity.kind === 'root');
  if (existing) {
    await client.chooseIdentity({ name: existing.name, force: false });
  } else {
    assert.equal((await client.createRootIdentity(root(fallbackName))).hierarchy, 'root');
  }
  assert.equal((await client.currentIdentity()).isRoot, true);
  return client;
}

After(async function () {
  const results = await Promise.allSettled((this.clients ?? []).map(async client => {
    try { await client.releaseLease(); } finally { await client.close(); }
  }));
  assert.equal(results.filter(r => r.status === 'rejected').length, 0, 'Client teardown failed');
});

After(async function ({ result, pickle }) {
  if (result?.status !== Status.FAILED) return;
  const context = {
    scenario: pickle.name,
    tags: pickle.tags.map(tag => tag.name),
    time: new Date().toISOString(),
    runtime: { node: process.version, target: process.env.CLIENT_TARGET ?? 'connector' },
    serverProbes: pickle.tags.some(tag => tag.name === '@component')
      ? [] : await Promise.all(Object.values(nodes).map(node => probe(node.endpoint))),
    evidence: this.evidence ?? [],
  };
  this.attach(JSON.stringify(context, null, 2).slice(0, 48_000), {
    mediaType: 'application/json', fileName: 'failure-context.json',
  });
  for (const item of this.textEvidence ?? []) {
    this.attach(item.content.slice(0, 48_000), {
      mediaType: 'text/plain', fileName: item.fileName,
    });
  }
});
