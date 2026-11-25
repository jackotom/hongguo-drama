// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, decodeEnvelope, validatePack } = require('../src/native/source-pack');

const root = path.resolve(__dirname, '..');
const payload = JSON.parse(fs.readFileSync(path.join(root, 'source-packs/hongguo-playback.payload.json'), 'utf8'));
const envelope = JSON.parse(fs.readFileSync(path.join(root, 'source-packs/hongguo-playback.pack.json'), 'utf8'));
const signed = decodeEnvelope(envelope).payload;
assert.equal(canonicalize(signed), canonicalize(payload), 'signed pack payload differs from plaintext payload');
validatePack(signed);
console.log('source pack payload and signature are consistent');
