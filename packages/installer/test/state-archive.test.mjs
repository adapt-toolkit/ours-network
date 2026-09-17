import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

test('state archive restores bytes, private modes and nanosecond timestamps and refuses corruption', async () => {
  const { createArchive, extractArchive, validateArchive } = await import('../assets/scripts/maintenance/state-archive.mjs');
  const { setMtimeNs } = await import('../assets/scripts/maintenance/state-native.mjs');
  const root = fs.mkdtempSync(join(tmpdir(), 'ours-archive-js-'));
  const options = { domain: 'server', uid: process.getuid(), gid: process.getgid(), provenance: {
    'package-lock.json': Buffer.from('{"fixture":1}'), 'dependency-tree.json': Buffer.from('{}'),
  } };
  try {
    const source = join(root, 'source'), archive = join(root, 'backup'), output = join(root, 'restored');
    fs.mkdirSync(source, { mode: 0o700 });
    fs.mkdirSync(join(source, 'mcp'), { mode: 0o700 });
    fs.writeFileSync(join(source, 'mcp/preferences.json'), '{"visible":true}', { mode: 0o600 });
    fs.mkdirSync(join(source, 'contact-book'), { mode: 0o755 });
    fs.chmodSync(join(source, 'contact-book'), 0o755);
    fs.writeFileSync(join(source, 'contact-book/book.json'), '{}', { mode: 0o644 });
    fs.chmodSync(join(source, 'contact-book/book.json'), 0o644);
    setMtimeNs(join(source, 'mcp/preferences.json'), 1712345678123456789n);
    const mtime = fs.lstatSync(join(source, 'mcp/preferences.json'), { bigint: true }).mtimeNs;
    const previousMask = process.umask(0o200);
    try { await createArchive(source, archive, options); }
    finally { process.umask(previousMask); }
    await extractArchive(archive, output, options);
    assert.equal(fs.statSync(join(output, 'contact-book')).mode & 0o7777, 0o700);
    assert.equal(fs.statSync(join(output, 'contact-book/book.json')).mode & 0o7777, 0o600);
    assert.equal(fs.statSync(join(source, 'contact-book')).mode & 0o7777, 0o755);
    assert.equal(fs.statSync(join(source, 'contact-book/book.json')).mode & 0o7777, 0o644);
    fs.chmodSync(join(source, 'contact-book/book.json'), 0o666);
    await assert.rejects(createArchive(source, join(root, 'writable-backup'), options), /permission/);
    fs.chmodSync(join(source, 'contact-book/book.json'), 0o644);
    assert.equal(fs.readFileSync(join(output, 'mcp/preferences.json'), 'utf8'), '{"visible":true}');
    assert.equal(fs.statSync(join(output, 'mcp/preferences.json')).mode & 0o7777, 0o600);
    assert.equal(fs.statSync(join(output, 'mcp/preferences.json'), { bigint: true }).mtimeNs, mtime);
    await assert.rejects(createArchive(source, archive, options), { code: 'EEXIST' });
    const metadata = fs.readFileSync(join(archive, 'metadata.json'), 'utf8');
    fs.writeFileSync(join(archive, 'metadata.json'), '{"format":1,' + metadata.slice(1));
    await assert.rejects(validateArchive(archive, options), /duplicate key/);
    fs.writeFileSync(join(archive, 'metadata.json'), metadata);
    const originalTar = fs.readFileSync(join(archive, 'state.tar'));
    const uid = String(options.uid), foreign = uid.slice(0, -1) + ((Number(uid.at(-1)) + 1) % 10);
    const forgedTar = Buffer.from(originalTar.toString('latin1').replace(` uid=${uid}\n`, ` uid=${foreign}\n`), 'latin1');
    assert.notDeepEqual(forgedTar, originalTar);
    fs.writeFileSync(join(archive, 'state.tar'), forgedTar);
    const forgedMetadata = JSON.parse(metadata);
    forgedMetadata.sha256['state.tar'] = createHash('sha256').update(forgedTar).digest('hex');
    fs.writeFileSync(join(archive, 'metadata.json'), JSON.stringify(forgedMetadata));
    await assert.rejects(validateArchive(archive, options), /foreign ownership/);
    fs.writeFileSync(join(archive, 'state.tar'), originalTar);
    fs.writeFileSync(join(archive, 'metadata.json'), metadata);
    fs.symlinkSync('/outside-state', join(source, 'link'));
    await assert.rejects(createArchive(source, join(root, 'linked-backup'), options), /not a directory or regular file/);
    assert.equal(fs.existsSync(join(root, 'linked-backup')), false);
    fs.appendFileSync(join(archive, 'state.tar'), 'corrupt');
    await assert.rejects(validateArchive(archive, options), /digest/);
    await assert.rejects(extractArchive(archive, join(root, 'bad'), options), /digest/);
    assert.equal(fs.existsSync(join(root, 'bad')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
