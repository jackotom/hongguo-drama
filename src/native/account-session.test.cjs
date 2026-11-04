const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  createAccountService, secureSessionStore, parseQr, parseHistory,
} = require('./account-session');
const { preserveLargeJsonIntegers } = require('./app-source');

function webPayload(data) {
  return { status: 200, headers: {}, data: JSON.stringify({ message: 'success', data }) };
}

function fakeEncryption() {
  const key = Buffer.from('hongguo-account-fixture');
  const transform = value => Buffer.from(value).map((byte, index) => byte ^ key[index % key.length]);
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => transform(Buffer.from(value, 'utf8')),
    decryptString: value => transform(value).toString('utf8'),
  };
}

test('account history parser keeps current APP rows with display metadata', () => {
  const rows = parseHistory({
    message: 'SUCCESS',
    data: { data_list: [
      { book_id: '1001', book_id_str: '1001', book_name: '春日来信', thumb_url: 'https://p9-reading-sign.fqnovelpic.com/novel-pic/cover~tplv-shrink:1200:0.heic?x=1', vid: '9001', vid_index: 3, current_play_position: 45000, duration: 90000, episode_cnt: 24, read_timestamp_ms: 1700000000000 },
      { book_id: '1002', book_name: '旧剧', vid: '9002', vid_index: 1, read_timestamp_ms: 1800000000000 },
      { book_id: 'bad', vid: '9003' },
      { book_id: '1003', book_name: '已删除', vid: '9004', is_delete: true },
    ] },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].series_id, '1002');
  assert.equal(rows[1].currentTime, 45);
  assert.equal(rows.find(row => row.series_id === '1001').series_title, '春日来信');
  assert.equal(rows.find(row => row.series_id === '1001').total, 24);
  assert.equal(rows.find(row => row.series_id === '1001').cover, 'https://p3-novel.byteimg.com/novel-pic/cover~tplv-shrink:320:0.webp');
});

test('large account episode IDs stay exact strings', () => {
  const raw = '{"vid":7390123456789012345,"other":7390123456789012345}';
  const preserved = preserveLargeJsonIntegers(raw, ['vid']);
  assert.equal(JSON.parse(preserved).vid, '7390123456789012345');
  assert.equal(typeof JSON.parse(preserved).other, 'number');
});

test('QR payload accepts server image data without exposing cookies', () => {
  const qr = parseQr({ message: 'success', data: { token: 'fixture-token', qrcode: '[image omitted]', expire_time: 180 } });
  assert.equal(qr.token, 'fixture-token');
  assert.match(qr.image, /^data:image\/png;base64,/);
  assert.equal(qr.expiresIn, 180);
});

test('encrypted session store never writes the raw cookie', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-account-store-'));
  const file = path.join(root, 'account-session.bin');
  try {
    const store = secureSessionStore({ filePath: file, safeStorage: fakeEncryption() });
    const session = { cookie: 'sessionid=private-fixture', deviceId: '1', installId: '2', cdid: '00000000-0000-4000-8000-000000000003' };
    store.save(session);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('private-fixture'));
    assert.deepEqual(store.load(), session);
    store.clear();
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('restore returns a cached profile before background session verification finishes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-account-cache-'));
  const file = path.join(root, 'account-session.bin');
  const encryption = fakeEncryption();
  let verificationFinished = false;
  try {
    secureSessionStore({ filePath: file, safeStorage: encryption }).save({
      cookie: 'sessionid=private-fixture',
      deviceId: '7000000000000000001',
      installId: '7000000000000000002',
      cdid: '00000000-0000-4000-8000-000000000003',
      profile: { id: '42', nickname: '缓存账号' },
    });
    const service = createAccountService({
      filePath: file, safeStorage: encryption,
      webRequest: async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        verificationFinished = true;
        throw new Error('temporary network failure');
      },
    });
    const status = await service.status();
    assert.equal(status.signedIn, true);
    assert.equal(status.account.nickname, '缓存账号');
    assert.equal(verificationFinished, false);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(verificationFinished, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('website QR flow verifies account, loads APP history and keeps credentials out of renderer data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-account-flow-'));
  const file = path.join(root, 'account-session.bin');
  const webCalls = [];
    let activeVerificationCalls = 0;
    let maxActiveVerificationCalls = 0;
  try {
    const webRequest = async (url, options) => {
      webCalls.push({ url, cookie: options.headers.Cookie || '' });
      if (url.includes('/passport/web/get_qrcode/')) {
        return { status: 200, headers: { 'set-cookie': ['passport_csrf_token=csrf-fixture; Path=/; Secure'] }, data: JSON.stringify({
          message: 'SUCCESS', data: { token: 'login-token', qrcode: '[image omitted]', expire_time: 180 },
        }) };
      }
      if (url.includes('/passport/web/check_qrconnect/')) {
        return { status: 200, headers: {}, data: JSON.stringify({
          message: 'SUCCESS', data: { status: '3', redirect_url: '/passport/web/redirect' },
        }) };
      }
      if (url.includes('/passport/web/redirect')) {
        return { status: 200, headers: { 'set-cookie': ['sessionid=private-session; Path=/; Secure'] }, data: 'ok' };
      }
      if (url.includes('/passport/account/info/v2/')) {
        activeVerificationCalls++;
        maxActiveVerificationCalls = Math.max(maxActiveVerificationCalls, activeVerificationCalls);
        await new Promise(resolve => setTimeout(resolve, 60));
        activeVerificationCalls--;
        return { status: 200, headers: {}, data: JSON.stringify({
          message: 'SUCCESS', data: { user_id_str: '42', name: '测试账号' },
        }) };
      }
      throw new Error(`Unexpected website request: ${url}`);
    };
    const accountRequest = async (url, options) => {
      assert.deepEqual(options.preserveLargeIntegerFields, ['vid', 'video_id', 'item_id']);
      if (url.includes('/reading/bookapi/read_history/list/v1/')) return { code: 0, data: { data_list: [
        { book_id: '1001', book_name: '测试短剧', thumb_url: 'https://img.example/test.jpg', vid: '9001', vid_index: 2, current_play_position: 30000, duration: 60000, episode_cnt: 8, read_timestamp_ms: 1700000000000 },
      ] } };
      throw new Error(`Unexpected account request: ${url}`);
    };
    const service = createAccountService({
      filePath: file, safeStorage: fakeEncryption(), webRequest, accountRequest,
      identityRequest: async () => {
        activeVerificationCalls++;
        maxActiveVerificationCalls = Math.max(maxActiveVerificationCalls, activeVerificationCalls);
        await new Promise(resolve => setTimeout(resolve, 60));
        activeVerificationCalls--;
        return { device_id: '7000000000000000001', iid: '7000000000000000002', cdid: '00000000-0000-4000-8000-000000000003' };
      },
    });
    const started = await service.startLogin();
    assert.equal(started.success, true);
    assert.match(started.image, /^data:image\/png;base64,/);
    const signedIn = await service.pollLogin(started.loginId);
    assert.equal(signedIn.status, 'signed-in');
    assert.equal(signedIn.account.nickname, '测试账号');
    assert.ok(!JSON.stringify(signedIn).includes('private-session'));
    const history = await service.history({ refresh: true });
    assert.equal(history.results.length, 1);
    assert.equal(service.row('1001').episode_id, '9001');
    assert.ok(fs.existsSync(file));
    assert.ok(webCalls.some(call => call.cookie.includes('passport_csrf_token=csrf-fixture')));
    assert.ok(webCalls.some(call => call.url.includes('/passport/account/info/v2/') && call.cookie.includes('sessionid=private-session')));
    assert.equal(maxActiveVerificationCalls, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verified website login does not require an anonymous playback device', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-web-login-'));
  let registrations = 0;
  try {
    const service = createAccountService({
      filePath: path.join(root, 'session.bin'), safeStorage: fakeEncryption(),
      webRequest: async () => webPayload({ user_id_str: '42', name: '测试账号' }),
      identityRequest: async () => { registrations++; throw new Error('device unavailable'); },
    });
    assert.equal((await service.completeWebLogin('sessionid=fixture')).status, 'signed-in');
    assert.equal((await service.status()).signedIn, true);
    assert.equal(registrations, 0);
    await assert.rejects(service.history({ refresh: true }), /device unavailable/);
    assert.equal((await service.status()).signedIn, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('confirmed QR login does not require an anonymous playback device', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-qr-login-'));
  try {
    const service = createAccountService({
      filePath: path.join(root, 'session.bin'), safeStorage: fakeEncryption(),
      identityRequest: async () => assert.fail('login must not register a device'),
      webRequest: async url => url.includes('get_qrcode') ? webPayload({ token: 'fixture', qrcode: 'fixture', expire_time: 180 })
        : url.includes('check_qrconnect') ? { ...webPayload({ status: '3' }), headers: { 'set-cookie': ['sessionid=fixture; Path=/'] } }
        : webPayload({ user_id_str: '42', name: '测试账号' }),
    });
    const started = await service.startLogin();
    assert.equal((await service.pollLogin(started.loginId)).status, 'signed-in');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('logout during lazy device registration cannot send the old account cookie', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-history-logout-'));
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  try {
    const service = createAccountService({ filePath: path.join(root, 'session.bin'), safeStorage: fakeEncryption(),
      webRequest: async () => webPayload({ user_id_str: '42', name: '测试账号' }),
      identityRequest: async () => { entered(); await gate; return { device_id: '1', iid: '2', cdid: '00000000-0000-4000-8000-000000000003' }; },
      accountRequest: async () => assert.fail('logged-out account must not send cookies'),
    });
    await service.completeWebLogin('sessionid=fixture');
    const pending = service.history({ refresh: true });
    await waiting; await service.logout(); release();
    await assert.rejects(pending, /账号已退出/);
  } finally { release?.(); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const action of ['cancelLogin', 'logout']) test(`${action} prevents a pending confirmation from saving credentials`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hg-login-cancel-'));
  let release, entered;
  const gate = new Promise(resolve=>release=resolve), waiting=new Promise(resolve=>entered=resolve);
  const filePath=path.join(root,'session.bin');
  const service=createAccountService({filePath,safeStorage:fakeEncryption(),identityRequest:async()=>({device_id:'1',iid:'2',cdid:'fixture'}),webRequest:async url=>{
    if(url.includes('get_qrcode'))return webPayload({token:'fixture',qrcode:'fixture',expire_time:180});
    if(url.includes('check_qrconnect'))return {...webPayload({status:'3'}),headers:{'set-cookie':['sessionid=fixture; Path=/']}};
    entered();await gate;return webPayload({user_id_str:'42',name:'Fixture'});
  }});
  try {const qr=await service.startLogin();const pending=service.pollLogin(qr.loginId);await waiting;await service[action](qr.loginId);release();assert.equal((await pending).status,'cancelled');assert.equal((await service.status()).signedIn,false);assert.equal(fs.existsSync(filePath),false);}finally{release();fs.rmSync(root,{recursive:true,force:true});}
});
