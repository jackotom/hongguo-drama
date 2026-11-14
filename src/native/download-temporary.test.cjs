const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDownloadTemporary, inspectDownloadTemporary, cleanupDownloadTemporary } = require('./download-temporary');
const withTransientFileIds = require('../../scripts/fixtures/transient-file-ids.cjs');

async function withPersistentNegativeDirectory(root, check) {
  const disk = require('node:fs');
  const promises = require('node:fs/promises');
  const original = { lstat: promises.lstat, lstatSync: disk.lstatSync };
  let initial = true;
  const target = file => path.dirname(path.resolve(file)) === path.resolve(root)
    && /^\.hongguo-download-[A-Za-z0-9]{6}$/.test(path.basename(file));
  const mutate = (file, stat) => {
    if (!stat.isDirectory() || !target(file)) return stat;
    stat.birthtimeNs = stat.birthtimeNs + (initial ? 0n : 123456789n);
    stat.ino = initial ? -101n : -202n;
    return stat;
  };
  promises.lstat = async (file, ...args) => {
    const stat = await original.lstat(file, ...args);
    const result = mutate(file, stat);
    initial = false;
    return result;
  };
  disk.lstatSync = (file, ...args) => mutate(file, original.lstatSync(file, ...args));
  try {
    return await check();
  } finally {
    promises.lstat = original.lstat;
    disk.lstatSync = original.lstatSync;
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.HONGGUO_TEST_VOLUME || os.tmpdir(), 'hg-removable-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const owner = { taskId:'removable', seriesId:'1', vid:'11', vidIndex:1, savePath:path.join(root, 'result.mp4') };
  return { root, owner };
}

test('removable input and decoded output survive truncation with exact persisted identities', async t => {
  const { root, owner } = fixture(t);
  await withTransientFileIds(root, async () => {
    const temporary = await createDownloadTemporary(root, { owner });
    try {
      await temporary.checkInput();
      const initialId = temporary.record.files['input.enc.tmp'].ino;
      fs.writeFileSync(temporary.input, 'downloaded file identity fixture');
      await temporary.checkInput();
      assert.notEqual(temporary.record.files['input.enc.tmp'].ino, initialId, 'the durable receipt must follow reallocation of the original open file');
      await temporary.reserveOutput();
      fs.writeFileSync(temporary.output, 'decoded file identity fixture');
      await temporary.checkOutput();
      const restored = JSON.parse(JSON.stringify(temporary.record));
      const state = inspectDownloadTemporary(restored, owner);
      assert.equal(state.unverifiedItems, 0);
      assert.equal(state.files.length, 2);
      for (const file of state.files) assert(BigInt(file.identity.ino) > 0n);
    } finally { await temporary.cleanup(); }
    assert.equal(fs.existsSync(temporary.record.directory), false);
  });
});

test('removable cancellation before writing cleans only its reserved files', async t => {
  const { root, owner } = fixture(t);
  await withTransientFileIds(root, async () => {
    const temporary = await createDownloadTemporary(root, { owner });
    await temporary.reserveOutput();
    assert.equal((await temporary.cleanup()).missing, true);
  });
});

test('removable files truncated back to empty can be verified and safely removed', async t => {
  const { root, owner } = fixture(t);
  await withTransientFileIds(root, async () => {
    const temporary = await createDownloadTemporary(root, { owner });
    try {
      fs.truncateSync(temporary.input, 0);
      await temporary.checkInput();
      assert(BigInt(temporary.record.files['input.enc.tmp'].ino) > 0n);
      await temporary.reserveOutput();
      fs.truncateSync(temporary.output, 0);
      await temporary.removeOutput();
      assert.equal(fs.existsSync(temporary.output), false);
    } finally { await temporary.cleanup(); }
    assert.equal(fs.existsSync(temporary.record.directory), false);
  });
});

for (const output of [false, true]) test(`removable ${output ? 'output' : 'input'} replacement stays protected`, async t => {
  const { root, owner } = fixture(t);
  await withTransientFileIds(root, async () => {
    const temporary = await createDownloadTemporary(root, { owner });
    if (output) await temporary.reserveOutput();
    const file = output ? temporary.output : temporary.input;
    fs.renameSync(file, file + '.original');
    fs.writeFileSync(file, 'unrelated replacement');
    await assert.rejects(output ? temporary.checkOutput() : temporary.checkInput(), error => error.code === 'EEXIST');
    await temporary.cleanup();
    assert.equal(fs.readFileSync(file, 'utf8'), 'unrelated replacement');
    assert.equal(fs.existsSync(file + '.original'), true);
  });
});

test('persisted negative identities never authorize deletion without a live reservation', async t => {
  const { root, owner } = fixture(t);
  const temporary = await createDownloadTemporary(root, { owner });
  try {
    fs.writeFileSync(temporary.input, 'preserve unknown receipt');
    await temporary.checkInput();
    const restored = JSON.parse(JSON.stringify(temporary.record));
    restored.files['input.enc.tmp'].ino = '-1';
    assert.equal((await cleanupDownloadTemporary(restored, owner)).missing, false);
    assert.equal(fs.readFileSync(temporary.input, 'utf8'), 'preserve unknown receipt');
  } finally { await temporary.cleanup(); }
});

test('a persistently negative exFAT directory identity still cleans its owned files', async t => {
  const { root, owner } = fixture(t);
  await withPersistentNegativeDirectory(root, async () => {
    const temporary = await createDownloadTemporary(root, { owner });
    try {
      fs.writeFileSync(temporary.input, 'downloaded');
      await temporary.reserveOutput();
      fs.writeFileSync(temporary.output, 'decoded');
      const restored = JSON.parse(JSON.stringify(temporary.record));
      assert.equal(BigInt(restored.identity.ino) < 0n, true);
      const result = await cleanupDownloadTemporary(restored, owner);
      assert.equal(result.missing, true);
      assert.equal(result.freed, 17);
      assert.equal(fs.existsSync(restored.directory), false);
    } finally { await temporary.cleanup().catch(() => {}); }
  });
});

test('a replaced stable directory never inherits a copied owner marker', async t => {
  const { root, owner } = fixture(t);
  const temporary = await createDownloadTemporary(root, { owner });
  fs.writeFileSync(temporary.input, 'original');
  const restored = JSON.parse(JSON.stringify(temporary.record));
  const marker = fs.readFileSync(path.join(restored.directory, '.hongguo-owner'));
  fs.renameSync(restored.directory, restored.directory + '.original');
  fs.mkdirSync(restored.directory);
  fs.writeFileSync(path.join(restored.directory, 'input.enc.tmp'), 'replacement');
  fs.writeFileSync(path.join(restored.directory, '.hongguo-owner'), marker);
  assert.equal(inspectDownloadTemporary(restored, owner).directoryVerified, false);
  const result = await cleanupDownloadTemporary(restored, owner);
  assert.equal(result.directoryVerified, false);
  assert.equal(result.count, 0);
  assert.equal(fs.readFileSync(path.join(restored.directory, 'input.enc.tmp'), 'utf8'), 'replacement');
  assert.deepEqual(fs.readFileSync(path.join(restored.directory, '.hongguo-owner')), marker);
});

test('negative directory fallback never adopts replacement files from a copied marker', async t => {
  const { root, owner } = fixture(t);
  await withPersistentNegativeDirectory(root, async () => {
    const temporary = await createDownloadTemporary(root, { owner });
    const directory = temporary.record.directory, marker = fs.readFileSync(path.join(directory, '.hongguo-owner'));
    fs.renameSync(directory, directory + '.original');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, '.hongguo-owner'), marker);
    fs.writeFileSync(temporary.input, 'foreign');
    const result = await temporary.cleanup();
    assert.equal(result.missing, false);
    assert.equal(result.count, 0);
    assert.equal(result.unverifiedItems, 1);
    assert.equal(fs.readFileSync(temporary.input, 'utf8'), 'foreign');
    assert.deepEqual(fs.readFileSync(path.join(directory, '.hongguo-owner')), marker);
  });
});

test('unknown files retain the marker so owned leftovers can be cleaned on retry', async t => {
  const { root, owner } = fixture(t);
  const temporary = await createDownloadTemporary(root, { owner });
  const marker = path.join(temporary.record.directory, '.hongguo-owner');
  const unknown = path.join(temporary.record.directory, 'keep.txt');
  fs.writeFileSync(unknown, 'unknown');
  const first = await temporary.cleanup();
  assert.equal(first.missing, false);
  assert.equal(first.directoryVerified, true);
  assert.equal(first.unverifiedItems, 1);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'unknown');
  fs.unlinkSync(unknown);
  assert.equal((await cleanupDownloadTemporary(temporary.record, owner)).missing, true);
});

test('failed file deletion keeps its marker and receipt usable on retry', async t => {
  const { root, owner } = fixture(t);
  const temporary = await createDownloadTemporary(root, { owner });
  const promises = require('node:fs/promises'), unlink = promises.unlink;
  promises.unlink = async file => {
    if (file === temporary.input) throw Object.assign(new Error('fixture file busy'), { code:'EBUSY' });
    return unlink(file);
  };
  try {
    const first = await temporary.cleanup();
    assert.equal(first.failed, 1);
    assert.equal(first.directoryVerified, true);
    assert.equal(fs.existsSync(path.join(temporary.record.directory, '.hongguo-owner')), true);
  } finally { promises.unlink = unlink; }
  assert.equal((await cleanupDownloadTemporary(temporary.record, owner)).missing, true);
});

test('failed directory deletion restores the marker for a later retry', async t => {
  const { root, owner } = fixture(t);
  const temporary = await createDownloadTemporary(root, { owner });
  const promises = require('node:fs/promises'), rmdir = promises.rmdir;
  promises.rmdir = async directory => {
    if (directory === temporary.record.directory) throw Object.assign(new Error('fixture directory busy'), { code:'EBUSY' });
    return rmdir(directory);
  };
  try {
    const first = await temporary.cleanup();
    assert.equal(first.failed, 1);
    assert.equal(first.directoryVerified, true);
    assert.equal(fs.existsSync(path.join(temporary.record.directory, '.hongguo-owner')), true);
  } finally { promises.rmdir = rmdir; }
  assert.equal((await cleanupDownloadTemporary(temporary.record, owner)).missing, true);
});

test('cancellation after marker removal preserves a recoverable directory', async t => {
  const { root, owner } = fixture(t);
  const temporary = await createDownloadTemporary(root, { owner });
  const marker = path.join(temporary.record.directory, '.hongguo-owner');
  const promises = require('node:fs/promises'), unlink = promises.unlink;
  let allowed = true;
  promises.unlink = async file => {
    const result = await unlink(file);
    if (file === marker) allowed = false;
    return result;
  };
  try {
    const first = await cleanupDownloadTemporary(temporary.record, owner, () => allowed);
    assert.equal(first.missing, false);
    assert.equal(first.directoryVerified, true);
    assert.equal(fs.existsSync(marker), true);
  } finally { promises.unlink = unlink; }
  assert.equal((await cleanupDownloadTemporary(temporary.record, owner)).missing, true);
});

test('new unknown files during rmdir survive and leave the marker recoverable', async t => {
  const { root, owner } = fixture(t);
  const temporary = await createDownloadTemporary(root, { owner });
  const unknown = path.join(temporary.record.directory, 'keep.txt');
  const promises = require('node:fs/promises'), rmdir = promises.rmdir;
  promises.rmdir = async directory => {
    if (directory === temporary.record.directory) fs.writeFileSync(unknown, 'arrived during cleanup');
    return rmdir(directory);
  };
  try {
    const first = await temporary.cleanup();
    assert.equal(first.missing, false);
    assert.equal(first.directoryVerified, true);
    assert.equal(first.unverifiedItems, 1);
    assert.equal(fs.readFileSync(unknown, 'utf8'), 'arrived during cleanup');
  } finally { promises.rmdir = rmdir; }
  fs.unlinkSync(unknown);
  assert.equal((await cleanupDownloadTemporary(temporary.record, owner)).missing, true);
});

test('marker restoration never grants ownership to a directory replaced during rmdir', async t => {
  const { root, owner } = fixture(t);
  const temporary = await createDownloadTemporary(root, { owner });
  const promises = require('node:fs/promises'), rmdir = promises.rmdir;
  promises.rmdir = async directory => {
    if (directory === temporary.record.directory) {
      fs.renameSync(directory, directory + '.original');
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'keep.txt'), 'foreign');
      throw Object.assign(new Error('fixture replaced directory'), { code:'EBUSY' });
    }
    return rmdir(directory);
  };
  try {
    const result = await temporary.cleanup();
    assert.equal(result.directoryVerified, false);
    assert.equal(fs.readFileSync(path.join(temporary.record.directory, 'keep.txt'), 'utf8'), 'foreign');
    assert.equal(fs.existsSync(path.join(temporary.record.directory, '.hongguo-owner')), false);
  } finally { promises.rmdir = rmdir; }
});

test('stable directories can be cleaned when opening a directory is unsupported', async t => {
  const { root, owner } = fixture(t);
  const temporary = await createDownloadTemporary(root, { owner });
  const open = fs.openSync;
  fs.openSync = (file, ...args) => {
    if (file === temporary.record.directory) throw Object.assign(new Error('fixture Windows directory open'), { code:'EISDIR' });
    return open(file, ...args);
  };
  try { assert.equal((await temporary.cleanup()).missing, true); }
  finally { fs.openSync = open; }
});

test('legacy v1 receipts still require exact positive directory identities', async t => {
  const { root, owner } = fixture(t);
  const temporary = await createDownloadTemporary(root, { owner });
  const restored = JSON.parse(JSON.stringify(temporary.record));
  restored.version = 1;
  fs.unlinkSync(path.join(restored.directory, '.hongguo-owner'));
  const unknown = { ...restored, identity:{ ...restored.identity, ino:'-1' } };
  assert.equal(inspectDownloadTemporary(unknown, owner).directoryVerified, false);
  assert.equal((await cleanupDownloadTemporary(unknown, owner)).count, 0);
  assert.equal((await cleanupDownloadTemporary(restored, owner)).missing, true);
});
