const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDownloadTemporary, inspectDownloadTemporary, cleanupDownloadTemporary } = require('./download-temporary');
const withTransientFileIds = require('../../scripts/fixtures/transient-file-ids.cjs');

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
