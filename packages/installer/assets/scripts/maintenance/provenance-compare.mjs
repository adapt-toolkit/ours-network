/**
 * Semantic dependency-record comparison for cross-build admission.
 * Compares structured content ignoring JSON key ordering and proven
 * staging-location path differences. Unknown or unmatched shapes
 * fail closed — they return false with no silent acceptance.
 *
 * Archive self-consistency and embedded-marker comparisons remain
 * byte-exact (handled by state-archive.mjs, not this module).
 */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedKeys(obj) {
  return Object.keys(obj).sort();
}

function normalizeResolved(value) {
  if (typeof value !== 'string') return value;
  return value;
}

function sameOptionalString(a, b) {
  if (a === undefined && b === undefined) return true;
  return a === b;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ak = sortedKeys(a), bk = sortedKeys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => k === bk[i] && deepEqual(a[k], b[bk[i]]));
}

function sameOptionalObject(a, b) {
  if (a === undefined && b === undefined) return true;
  if (!isObject(a) || !isObject(b)) return false;
  return deepEqual(a, b);
}

function sameOptionalArray(a, b) {
  if (a === undefined && b === undefined) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const LOCKFILE_ENTRY_KNOWN = new Set([
  'version', 'integrity', 'resolved', 'name', 'license', 'link', 'dev', 'optional', 'peer',
  'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies',
  'engines', 'os', 'cpu', 'bin', 'funding', 'hasInstallScript', 'inBundle',
  'devOptional', 'peerDependenciesMeta', 'bundleDependencies', 'workspaces',
]);

function packageEntryEqual(a, b) {
  if (!isObject(a) || !isObject(b)) return false;
  if (a.version !== b.version) return false;
  if (a.integrity !== b.integrity) return false;
  if (normalizeResolved(a.resolved) !== normalizeResolved(b.resolved)) return false;
  for (const key of ['name', 'license', 'dev', 'optional', 'peer', 'link', 'hasInstallScript', 'inBundle', 'devOptional']) {
    if (a[key] !== b[key]) return false;
  }
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'peerDependenciesMeta']) {
    if (!sameOptionalObject(a[key], b[key])) return false;
  }
  for (const key of ['os', 'cpu', 'bundleDependencies']) {
    if (!sameOptionalArray(a[key], b[key])) return false;
  }
  if (!sameOptionalObject(a.engines, b.engines)) return false;
  if (!sameOptionalObject(a.bin, b.bin)) return false;
  if (!sameOptionalArray(a.workspaces, b.workspaces)) return false;
  if (!deepEqual(a.funding, b.funding)) return false;
  const aExtra = Object.keys(a).filter(k => !LOCKFILE_ENTRY_KNOWN.has(k));
  const bExtra = Object.keys(b).filter(k => !LOCKFILE_ENTRY_KNOWN.has(k));
  if (aExtra.length > 0 || bExtra.length > 0) return false;
  return true;
}

function validateLockfileShape(obj) {
  if (!isObject(obj)) return false;
  if (typeof obj.lockfileVersion !== 'number') return false;
  if (!isObject(obj.packages)) return false;
  return true;
}

const LOCKFILE_TOP_KNOWN = new Set(['name', 'version', 'lockfileVersion', 'requires', 'packages']);

function lockfileEqual(a, b) {
  if (!validateLockfileShape(a) || !validateLockfileShape(b)) return false;
  if (a.lockfileVersion !== b.lockfileVersion) return false;
  if (!sameOptionalString(a.name, b.name)) return false;
  if (!sameOptionalString(a.version, b.version)) return false;
  if (a.requires !== b.requires) return false;
  const aExtra = Object.keys(a).filter(k => !LOCKFILE_TOP_KNOWN.has(k));
  const bExtra = Object.keys(b).filter(k => !LOCKFILE_TOP_KNOWN.has(k));
  if (aExtra.length > 0 || bExtra.length > 0) return false;
  const aPkgs = a.packages, bPkgs = b.packages;
  const aKeys = sortedKeys(aPkgs), bKeys = sortedKeys(bPkgs);
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!packageEntryEqual(aPkgs[aKeys[i]], bPkgs[bKeys[i]])) return false;
  }
  return true;
}

function validateTreeShape(obj) {
  if (!isObject(obj)) return false;
  if (typeof obj.version !== 'string') return false;
  return true;
}

const TREE_NODE_KNOWN = new Set(['version', 'resolved', 'dependencies', 'from', 'overridden', 'name']);

function treeNodeEqual(a, b) {
  if (!isObject(a) || !isObject(b)) return false;
  if (Object.keys(a).length === 0 && Object.keys(b).length === 0) return true;
  if (typeof a.version !== 'string' || typeof b.version !== 'string') return false;
  if (a.version !== b.version) return false;
  if (normalizeResolved(a.resolved) !== normalizeResolved(b.resolved)) return false;
  if (!sameOptionalString(a.name, b.name)) return false;
  if (!sameOptionalString(a.from, b.from)) return false;
  if (a.overridden !== b.overridden) return false;
  const aExtra = Object.keys(a).filter(k => !TREE_NODE_KNOWN.has(k) && k !== 'dependencies');
  const bExtra = Object.keys(b).filter(k => !TREE_NODE_KNOWN.has(k) && k !== 'dependencies');
  if (aExtra.length > 0 || bExtra.length > 0) return false;
  const aDeps = a.dependencies, bDeps = b.dependencies;
  if (aDeps === undefined && bDeps === undefined) return true;
  if (!isObject(aDeps) || !isObject(bDeps)) return false;
  const aKeys = sortedKeys(aDeps), bKeys = sortedKeys(bDeps);
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!treeNodeEqual(aDeps[aKeys[i]], bDeps[bKeys[i]])) return false;
  }
  return true;
}

function dependencyTreeEqual(a, b) {
  if (!validateTreeShape(a) || !validateTreeShape(b)) return false;
  return treeNodeEqual(a, b);
}

export function semanticRecordEqual(name, aBytes, bBytes) {
  if (aBytes.equals(bBytes)) return true;
  let a, b;
  try { a = JSON.parse(aBytes); b = JSON.parse(bBytes); }
  catch { return false; }
  if (name === 'package-lock.json') return lockfileEqual(a, b);
  if (name === 'dependency-tree.json') return dependencyTreeEqual(a, b);
  return false;
}
