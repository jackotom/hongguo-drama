// Offline request-binding regression checks for the playback-only 551 signer.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {headers} = require('./player-signature');
const query = 'aid=8662&device_id=123&iid=456&version_name=7.3.9.32&_rticket=1794380000999';
const ticket = 1794380000999;
const random = Buffer.from('01020304ffffffff', 'hex');
const body = Buffer.from('{"mixed_video_id_map":{"1004":["123"]}}');
const signed = headers(query, body, ticket, random);
assert.deepEqual(signed, headers(query, body, ticket, random));
assert.equal(signed['x-khronos'], '1794380000');
assert.equal(signed['x-ss-req-ticket'], String(ticket));
assert.equal(signed['x-ss-stub'], crypto.createHash('md5').update(body).digest('hex'));
assert.deepEqual(Object.keys(signed).sort(), ['x-argus','x-khronos','x-ladon','x-ss-req-ticket','x-ss-stub']);
const argus = Buffer.from(signed['x-argus'], 'base64');
assert.equal(argus.subarray(0, 2).toString('hex'), 'f281');
assert.equal((argus.length - 2) % 16, 0);
const cipher = crypto.createDecipheriv('aes-128-cbc',
  Buffer.from('d31e3718288a1027baab59f146a09a9c','hex'),
  Buffer.from('ea180a0336ed352fcd24e4d50018ae54','hex'));
const frame = Buffer.concat([cipher.update(argus.subarray(2)), cipher.final()]);
assert.equal(frame.subarray(-2).toString(), 'ao');
const reversed = Buffer.from(frame.subarray(0,-2)).reverse();
const magic = Buffer.from('f2f7fcfff2f7fcff','hex');
assert.deepEqual(reversed.subarray(0,8), magic);
for (let i=8;i<reversed.length;i++) reversed[i] ^= magic[i%8];
assert.equal(reversed.subarray(-9).toString('hex'), 'eafb2cfe8568519154');
assert.equal(Buffer.from(signed['x-ladon'],'base64').length,36);
assert.equal(Buffer.from(signed['x-ladon'],'base64').subarray(0,4).toString('hex'),'01020304');
for (const changed of [
  headers(query+'&other=1',body,ticket,random),
  headers(query,Buffer.from('{}'),ticket,random),
  headers(query,null,ticket,random),
  headers(query,body,ticket+1000,random),
  headers(query.replace('device_id=123','device_id=124'),body,ticket,random),
  headers(query,body,ticket,Buffer.alloc(8)),
]) assert.notEqual(changed['x-argus'],signed['x-argus']);
assert.notEqual(headers(query,body,ticket+1000,random)['x-ladon'],signed['x-ladon']);
assert.equal(headers(query,null,ticket,random)['x-ss-stub'],undefined);
assert.notEqual(headers(query,body,ticket)['x-argus'],headers(query,body,ticket)['x-argus']);
console.log('PASS player signature: 551 framing, encrypted Ladon, final query/body/identity/time binding and per-request randomness');
