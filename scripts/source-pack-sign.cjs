// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalize } = require('../src/native/source-pack');

const root = path.resolve(__dirname, '..');
const payloadPath = path.resolve(process.argv[2] || path.join(root, 'source-packs/hongguo-playback.payload.json'));
const outputPath = path.resolve(process.argv[3] || path.join(root, 'source-packs/hongguo-playback.pack.json'));
const privatePath = path.resolve(process.argv[4] || path.join(process.env.HOME,
  'Library', 'Application Support', 'Hongguo-SourcePack-Signing', 'private.pem'));

const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
const raw = Buffer.from(canonicalize(payload));
const privateKey = crypto.createPrivateKey(fs.readFileSync(privatePath, 'utf8'));
const envelope = {
  format: 1,
  payload: raw.toString('base64'),
  signature: crypto.sign(null, raw, privateKey).toString('base64'),
};
fs.writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o644 });
console.log(outputPath);
