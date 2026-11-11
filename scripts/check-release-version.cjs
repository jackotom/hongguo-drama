const assert = require('node:assert/strict');
const { availableRelease } = require('../src/native/app-update');

const ordered = ['1.7', '1.8', '1.9', '1.71', '1.74', '1.75', '1.75.1', '1.76', '1.99', '1.100', '2.0', '2.9', '3.0', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8', '3.9', '4.0', '4.1', '4.2', '4.3', '4.4', '4.5', '4.6', '4.7', '4.8', '4.9', '5.0', '5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7', '5.8', '5.9', '6.0', '6.1', '6.2', '6.3', '6.4', '6.5', '6.6', '6.7', '6.8', '6.9'];
let checks = 0;
for (let current = 0; current < ordered.length; current++) {
  for (let next = 0; next < ordered.length; next++) {
    const release = availableRelease({ tag_name: `v${ordered[next]}` }, ordered[current]);
    assert.equal(release?.version || null, next > current ? ordered[next] : null,
      `${ordered[current]} to ${ordered[next]}`);
    checks++;
  }
}
for (const tag of ['v1.75', '1.75', 'v1.75.0', '1.75.0']) {
  assert.equal(availableRelease({ tag_name: tag }, '1.75.0'), null);
}
for (const tag of ['v1.76-beta.1', 'v1.76.0-beta.1', 'garbage', '1.76.0.1', '1.9007199254740992']) {
  assert.equal(availableRelease({ tag_name: tag }, '1.75.0'), null);
}
for (const flags of [{ prerelease: true }, { draft: true }]) {
  assert.equal(availableRelease({ tag_name: 'v2.0', ...flags }, '1.75.0'), null);
}
const pkg = require('../package.json');
const lock = require('../package-lock.json');
assert.equal(pkg.version, '6.9.0', 'Current source release target must be 6.9.0');
assert.equal(lock.version, pkg.version, 'Lockfile version must match the release');
assert.equal(lock.packages[''].version, pkg.version, 'Lockfile root package must match the release');
assert.match(pkg.version, /^\d+\.\d+\.0$/, 'Release versions use two public components and an internal zero patch');
const publicVersion = pkg.version.replace(/\.0$/, '');
assert.equal(availableRelease({ tag_name: 'v2.0' }, '1.80.0').version, '2.0');
assert.equal(availableRelease({ tag_name: 'v2.0' }, '2.0.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.1' }, '3.0.0').version, '3.1');
assert.equal(availableRelease({ tag_name: 'v3.1' }, '3.1.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.2' }, '3.1.0').version, '3.2');
assert.equal(availableRelease({ tag_name: 'v3.2' }, '3.2.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.3' }, '3.2.0').version, '3.3');
assert.equal(availableRelease({ tag_name: 'v3.3' }, '3.3.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.4' }, '3.3.0').version, '3.4');
assert.equal(availableRelease({ tag_name: 'v3.4' }, '3.4.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.5' }, '3.4.0').version, '3.5');
assert.equal(availableRelease({ tag_name: 'v3.5' }, '3.5.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.6' }, '3.5.0').version, '3.6');
assert.equal(availableRelease({ tag_name: 'v3.6' }, '3.6.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.7' }, '3.6.0').version, '3.7');
assert.equal(availableRelease({ tag_name: 'v3.7' }, '3.7.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.8' }, '3.7.0').version, '3.8');
assert.equal(availableRelease({ tag_name: 'v3.8' }, '3.8.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.9' }, '3.8.0').version, '3.9');
assert.equal(availableRelease({ tag_name: 'v3.9' }, '3.9.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.0' }, '3.9.0').version, '4.0');
assert.equal(availableRelease({ tag_name: 'v4.1' }, '4.0.0').version, '4.1');
assert.equal(availableRelease({ tag_name: 'v4.2' }, '4.1.0').version, '4.2');
assert.equal(availableRelease({ tag_name: 'v4.3' }, '4.2.0').version, '4.3');
assert.equal(availableRelease({ tag_name: 'v4.4' }, '4.3.0').version, '4.4');
assert.equal(availableRelease({ tag_name: 'v4.5' }, '4.4.0').version, '4.5');
assert.equal(availableRelease({ tag_name: 'v4.6' }, '4.5.0').version, '4.6');
assert.equal(availableRelease({ tag_name: 'v4.7' }, '4.6.0').version, '4.7');
assert.equal(availableRelease({ tag_name: 'v4.8' }, '4.7.0').version, '4.8');
assert.equal(availableRelease({ tag_name: 'v4.9' }, '4.8.0').version, '4.9');
assert.equal(availableRelease({ tag_name: 'v5.0' }, '4.9.0').version, '5.0');
assert.equal(availableRelease({ tag_name: 'v5.1' }, '5.0.0').version, '5.1');
assert.equal(availableRelease({ tag_name: 'v5.2' }, '5.1.0').version, '5.2');
assert.equal(availableRelease({ tag_name: 'v5.3' }, '5.2.0').version, '5.3');
for (const current of ['5.3', '5.3.0']) {
  for (const tag of ['v5.3', '5.3', 'v5.3.0', '5.3.0']) {
    assert.equal(availableRelease({ tag_name: tag }, current), null, `${current} equals ${tag}`);
  }
}
for (const current of ['5.2', '5.2.0']) {
  for (const tag of ['v5.2', '5.2', 'v5.2.0', '5.2.0']) {
    assert.equal(availableRelease({ tag_name: tag }, current), null, `${current} equals ${tag}`);
  }
}
for (const current of ['5.1', '5.1.0']) {
  for (const tag of ['v5.1', '5.1', 'v5.1.0', '5.1.0']) {
    assert.equal(availableRelease({ tag_name: tag }, current), null, `${current} equals ${tag}`);
  }
}
for (const current of ['5.0', '5.0.0']) {
  for (const tag of ['v5.0', '5.0', 'v5.0.0', '5.0.0']) {
    assert.equal(availableRelease({ tag_name: tag }, current), null, `${current} equals ${tag}`);
  }
}
for (const artifact of [pkg.build.artifactName, pkg.build.portable.artifactName, pkg.build.nsis.artifactName, pkg.build.linux.artifactName]) {
  assert(artifact.includes(`-${publicVersion}-`), 'Download filenames must contain the two-part release version');
  assert(!artifact.includes('${version}'), 'Raw internal versions must not leak into download filenames');
}

assert.equal(availableRelease({ tag_name: 'v5.4' }, '5.3.0').version, '5.4');
assert.equal(availableRelease({ tag_name: 'v5.4' }, '5.4.0'), null);
assert.equal(availableRelease({ tag_name: 'v5.5' }, '5.4.0').version, '5.5');
assert.equal(availableRelease({ tag_name: 'v5.5' }, '5.5.0'), null);

assert.equal(availableRelease({ tag_name: 'v5.6' }, '5.5.0').version, '5.6');
assert.equal(availableRelease({ tag_name: 'v5.6' }, '5.6.0'), null);

assert.equal(availableRelease({ tag_name: 'v5.7' }, '5.6.0').version, '5.7');
assert.equal(availableRelease({ tag_name: 'v5.7' }, '5.7.0'), null);

assert.equal(availableRelease({ tag_name: 'v5.8' }, '5.7.0').version, '5.8');
assert.equal(availableRelease({ tag_name: 'v5.8' }, '5.8.0'), null);

assert.equal(availableRelease({ tag_name: 'v5.9' }, '5.8.0').version, '5.9');
for (const current of ['5.9', '5.9.0']) {
  for (const tag of ['v5.9', '5.9', 'v5.9.0', '5.9.0']) {
    assert.equal(availableRelease({ tag_name: tag }, current), null, `${current} equals ${tag}`);
  }
}
assert.equal(availableRelease({ tag_name: 'v6.0' }, '5.9.0').version, '6.0');
assert.equal(availableRelease({ tag_name: 'v6.3' }, '6.2.0').version, '6.3');
assert.equal(availableRelease({ tag_name: 'v6.3' }, '6.3.0'), null);

for (const current of ['6.0', '6.0.0']) for (const tag of ['v6.0', '6.0', 'v6.0.0', '6.0.0']) assert.equal(availableRelease({ tag_name: tag }, current), null);

assert.equal(availableRelease({ tag_name: 'v6.1' }, '6.0.0').version, '6.1');
for (const current of ['6.1', '6.1.0']) for (const tag of ['v6.1', '6.1', 'v6.1.0', '6.1.0']) assert.equal(availableRelease({ tag_name: tag }, current), null);

assert.equal(availableRelease({ tag_name: 'v6.2' }, '6.1.0').version, '6.2');
for (const current of ['6.2', '6.2.0']) for (const tag of ['v6.2', '6.2', 'v6.2.0', '6.2.0']) assert.equal(availableRelease({ tag_name: tag }, current), null);

assert.equal(availableRelease({ tag_name: 'v6.4' }, '6.3.0').version, '6.4');
assert.equal(availableRelease({ tag_name: 'v6.4' }, '6.4.0'), null);

assert.equal(availableRelease({ tag_name: 'v6.5' }, '6.4.0').version, '6.5');
assert.equal(availableRelease({ tag_name: 'v6.5' }, '6.5.0'), null);

assert.equal(availableRelease({ tag_name: 'v6.6' }, '6.5.0').version, '6.6');
assert.equal(availableRelease({ tag_name: 'v6.6' }, '6.6.0'), null);

assert.equal(availableRelease({ tag_name: 'v6.7' }, '6.6.0').version, '6.7');
assert.equal(availableRelease({ tag_name: 'v6.7' }, '6.7.0'), null);

assert.equal(availableRelease({ tag_name: 'v6.8' }, '6.7.0').version, '6.8');
for (const current of ['6.8', '6.8.0']) {
  for (const tag of ['v6.8', '6.8', 'v6.8.0', '6.8.0']) {
    assert.equal(availableRelease({ tag_name: tag }, current), null);
  }
}

assert.equal(availableRelease({ tag_name: 'v6.9' }, '6.8.0').version, '6.9');
for (const current of ['6.9', '6.9.0']) for (const tag of ['v6.9', '6.9', 'v6.9.0', '6.9.0']) assert.equal(availableRelease({ tag_name: tag }, current), null);

console.log(`PASS ${checks} version pairs, equivalent versions, invalid versions and unpublished releases`);
