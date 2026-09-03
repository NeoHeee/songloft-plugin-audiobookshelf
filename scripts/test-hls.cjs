const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function compile(file) {
  return ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
}
const exported = {};
vm.runInNewContext(compile('hls.ts'), { exports: exported, Uint8Array });
const { HlsPlayback, streamLocation, firstSegments, cutPlaylist, speakerPlaylistBase } = exported;
const manifest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6,\noutput-0.ts\n#EXTINF:6,\noutput-1.ts\n#EXT-X-ENDLIST';
const bytes = new Uint8Array(188); bytes[0] = 0x47;
const response = (status, body, type = 'application/json') => ({
  status, ok: status >= 200 && status < 300, headers: { get: name => name === 'content-type' ? type : null },
  text: async () => typeof body === 'string' ? body : JSON.stringify(body), json: async () => body,
  arrayBuffer: async () => body.buffer
});
let assertions = 0;
async function test(name, run) { await run(); assertions++; console.log('PASS', name); }
function fixture(options = {}) {
  let stored = options.stored || null, time = 0;
  const requests = [], reads = [];
  const deps = {
    read: async () => stored,
    write: async value => { stored = value; },
    request: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/close')) { if (options.closeFail) throw Error('offline'); return ''; }
      return { id: 'test-session', playMethod: 2, duration: 12,
        audioTracks: [{ contentUrl: '/hls/test-session/output.m3u8' }], ...options.session };
    },
    fetch: async (url, init) => {
      reads.push({ url, init });
      if (options.throwFetch) throw Error('failed at http://abs/hls/SECRET/output.m3u8');
      if (url.endsWith('.m3u8')) return response(200, options.manifest || manifest, 'application/vnd.apple.mpegurl');
      return response(options.segmentStatus || 206, bytes, options.segmentType || 'video/mp2t');
    },
    now: () => time,
    createKey: () => 'a'.repeat(48),
    delay: async ms => { time += ms; }
  };
  return { hls: new HlsPlayback(deps), deps, requests, reads, stored: () => stored };
}
const prepare = f => f.hls.prepare('http://abs', 'account', 'device', 'book', 'Book');

async function main() {
  await test('chapter playlist starts at containing segment and retains the end', () => {
    const url = { href: 'http://abs/hls/s/output.m3u8' };
    for (const position of [6, 7.5, 11.99]) {
      const cut = cutPlaylist(manifest, url, position);
      assert.equal(cut.actualStart, 6);
      assert.ok(!cut.playlist.includes('output-0.ts'));
      assert.ok(cut.playlist.includes('http://abs/hls/s/output-1.ts'));
      assert.ok(cut.playlist.endsWith('#EXT-X-ENDLIST\n'));
      assert.equal(cut.segments.length, 1);
    }
    assert.equal(cutPlaylist(manifest, url, 5).actualStart, 0);
    for (const position of [-1, NaN, Infinity, 12, 13]) assert.throws(() => cutPlaylist(manifest, url, position));
    for (const bad of [manifest.replace('EXTINF:6', 'EXTINF:0'), manifest.replace('EXTINF:6', 'EXTINF:NaN'), manifest.replace('#EXT-X-ENDLIST', '')]) assert.throws(() => cutPlaylist(bad, url));
  });
  await test('public capability is scoped, expires and is revoked by cleanup', async () => {
    const f = fixture();
    await f.hls.prepare('http://abs', 'account', 'device', 'book', 'Book', 7, 'Chapter 2');
    assert.equal(f.stored().actualStart, 6);
    assert.ok(f.reads.some(r => r.url.endsWith('output-1.ts')));
    assert.ok(!f.reads.some(r => r.url.endsWith('output-0.ts')));
    assert.equal(await f.hls.publicPlaylist('bad'), null);
    assert.equal(await f.hls.publicPlaylist('b'.repeat(48)), null);
    assert.ok(await f.hls.publicPlaylist('a'.repeat(48)));
    await f.deps.delay(36 * 3600 * 1000);
    assert.equal(await f.hls.publicPlaylist('a'.repeat(48)), null);
    await f.hls.close('http://abs');
    assert.equal(await f.hls.publicPlaylist('a'.repeat(48)), null);
  });
  await test('Songloft public base rejects loopback and credential-bearing addresses', () => {
    assert.equal(speakerPlaylistBase('http://192.168.1.2:8000/base/'), 'http://192.168.1.2:8000/base');
    for (const url of ['http://127.0.0.1:8000', 'http://localhost', 'http://[::1]:80', 'http://a?token=s', 'http://user:pass@a', 'http://a/../x']) assert.throws(() => speakerPlaylistBase(url));
  });
  await test('strict stream URL including reverse-proxy subpath', () => {
    assert.equal(streamLocation('https://abs/base', 's', '/hls/s/output.m3u8').href, 'https://abs/base/hls/s/output.m3u8');
    for (const url of ['https://evil/hls/s/output.m3u8', '/hls/s/output.m3u8?token=secret', '/api/me', 'https://user:pass@abs/hls/s/output.m3u8']) {
      assert.throws(() => streamLocation('https://abs', 's', url));
    }
    assert.throws(() => streamLocation('https://abs', '../x', '/hls/x/output.m3u8'));
  });
  await test('only expected sequential MPEG-TS segments accepted', () => {
    const url = new URL('http://abs/hls/s/output.m3u8');
    assert.equal(firstSegments(manifest, url).length, 2);
    for (const bad of ['<html>login</html>', '#EXTM3U\nhttps://evil/file.ts', '#EXTM3U\noutput-9.ts', '#EXTM3U\n#EXT-X-KEY:URI="secret"\noutput-0.ts']) {
      assert.throws(() => firstSegments(bad, url));
    }
  });
  await test('prepare, send and close without progress writes or media tokens', async () => {
    const f = fixture(); const result = await prepare(f);
    assert.equal(result.url, 'http://abs/hls/test-session/output.m3u8');
    assert.equal(f.stored().phase, 'ready');
    assert.equal(JSON.parse(f.requests[0].init.body).forceTranscode, true);
    assert.equal(f.reads.length, 3);
    assert.ok(f.reads.every(r => !r.init.headers.Authorization && r.init.redirect === 'error'));
    await f.hls.markSent(result.session);
    assert.equal(f.stored().phase, 'sent');
    await f.hls.close('http://abs');
    assert.equal(f.stored(), null);
    assert.equal(f.requests.at(-1).init.body, '{}');
    assert.ok(f.requests.every(r => !r.url.includes('/sync')));
  });
  await test('initial 404 is retried before push', async () => {
    const f = fixture(); const original = f.deps.fetch; let first = true;
    f.deps.fetch = async (url, init) => {
      if (url.endsWith('output-0.ts') && first) { first = false; return response(404, ''); }
      return original(url, init);
    };
    await prepare(f); assert.equal(first, false); assert.equal(f.stored().phase, 'ready');
  });
  await test('timeout closes session and never falls back to direct file', async () => {
    const f = fixture({ segmentStatus: 404 });
    await assert.rejects(prepare(f), /超时/);
    assert.equal(f.stored(), null); assert.equal(f.requests.length, 2);
  });
  await test('HTML auth responses and unsupported manifests fail closed', async () => {
    for (const options of [{ segmentStatus: 200, segmentType: 'text/html' }, { manifest: '<html>login</html>' }, { session: { playMethod: 0 } }]) {
      const f = fixture(options); await assert.rejects(prepare(f)); assert.equal(f.stored(), null);
    }
  });
  await test('network errors redact sensitive session URLs', async () => {
    const f = fixture({ throwFetch: true });
    await assert.rejects(prepare(f), e => !e.message.includes('SECRET') && !e.message.includes('http'));
  });
  await test('failed cleanup retains session for explicit retry', async () => {
    const f = fixture({ segmentStatus: 403, closeFail: true });
    await assert.rejects(prepare(f), /未能清理/);
    assert.equal(f.stored().phase, 'preparing');
  });
  await test('different device or server cannot take over stored session', async () => {
    const f = fixture(); await prepare(f);
    await assert.rejects(f.hls.prepare('http://abs', 'account', 'other', 'book', 'Book'), /上一台/);
    await assert.rejects(f.hls.close('http://other'), /原 Audiobookshelf/);
    assert.equal(f.requests.length, 1);
    await prepare(f); assert.equal(f.requests[1].url, '/api/session/test-session/close');
  });
  await test('concurrent operations are rejected and lock recovers', async () => {
    const f = fixture(); let release;
    const pending = f.hls.exclusive(() => new Promise(resolve => { release = resolve; }));
    await assert.rejects(f.hls.exclusive(async () => {}), /正在进行/);
    release(); await pending; await f.hls.exclusive(async () => {});
  });

  // Exercise actual main.ts routes without network, Songloft imports or device writes.
  const handlers = new Map(), storage = new Map(), calls = [];
  let failMiot = false, testItem = null;
  const config = { serverUrl: 'http://abs', apiKey: 'test-key', authMode: 'api-key', speakerHlsEnabled: false };
  storage.set('abs_config', config);
  const sandbox = { exports: {}, URL, Uint8Array, Date, setTimeout, clearTimeout,
    crypto: require('node:crypto'),
    require: name => name === './hls' ? exported : {
      createRouter: () => ({ get: (p, h) => handlers.set('GET ' + p, h), post: (p, h) => handlers.set('POST ' + p, h), handle: () => {} }),
      createMusicUrlHandler: () => () => {}, jsonResponse: (data, status = 200) => ({ data, status }),
      parseQuery: query => Object.fromEntries(new URLSearchParams(query))
    },
    songloft: {
      persistentStorage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
      plugin: { getHostUrl: async () => 'http://songloft', getToken: async () => 'host-secret' },
      log: { warn() {}, info() {} },
      songs: new Proxy({}, { get: () => { throw Error('must not import songs'); } }),
      playlists: new Proxy({}, { get: () => { throw Error('must not import playlists'); } })
    },
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.startsWith('http://songloft')) return response(200, failMiot ? { success: false, error: 'SECRET' } : { success: true, data: {} });
      if (url.endsWith('.m3u8')) return response(200, manifest, 'application/vnd.apple.mpegurl');
      if (url.endsWith('.ts')) return response(206, bytes, 'video/mp2t');
      if (url.endsWith('/play')) return response(200, { id: 'route-session', playMethod: 2, duration: 12, audioTracks: [{ contentUrl: '/hls/route-session/output.m3u8' }] });
      if (url.endsWith('/close')) return response(200, '');
      return response(200, testItem || { media: { metadata: { title: 'Book' }, audioFiles: [{ metadata: { filename: 'one.mp3' }, duration: 6 }, { metadata: { filename: 'two.mp3' }, duration: 6 }] } });
    }
  };
  vm.runInNewContext(compile('main.ts'), sandbox);
  const route = (p, body = {}) => handlers.get('POST ' + p)({ body: JSON.stringify(body) });
  const push = () => route('/api/miot/play', { accountId: 'a', deviceId: 'd', itemId: 'b', fileIndex: 1 });
  await test('HLS defaults off; single-file push preserved', async () => {
    const result = await push(); assert.equal(result.data.mode, 'single');
    assert.ok(!calls.some(c => c.url.endsWith('/play')));
  });
  await test('toggle persists and HLS route does not import', async () => {
    assert.equal((await route('/api/config', { speakerHlsEnabled: true })).status, 200);
    const pushed = (await push()).data;
    assert.equal(pushed.mode, 'hls');
    assert.equal(pushed.startPosition, 6);
    assert.equal(pushed.history.trackIndex, 1);
    const sent = JSON.parse(calls.filter(c => c.url.endsWith('/mina/play-url')).at(-1).init.body);
    assert.match(sent.url, /^http:\/\/songloft\/api\/v1\/jsplugin\/audiobookshelf\/speaker-stream\/[a-f0-9]{48}\/index.m3u8$/);
    assert.equal(storage.get('abs_speaker_hls_session_v1').phase, 'sent');
    const state = (await handlers.get('GET /api/miot/hls')({})).data.session;
    assert.ok(!state.id && !state.serverUrl && !state.playlistKey && !state.playlist);
    const key = storage.get('abs_speaker_hls_session_v1').playlistKey;
    const serve = handlers.get('GET /speaker-stream/:key/index.m3u8');
    assert.equal((await serve({}, { key: 'bad' })).statusCode, 404);
    const served = await serve({}, { key });
    assert.equal(served.statusCode, 200);
    assert.ok(served.body.includes('output-1.ts') && !served.body.includes('output-0.ts'));
  });
  await test('active session blocks server change; stop closes it', async () => {
    assert.equal((await route('/api/config', { serverUrl: 'http://other', apiKey: 'new' })).status, 400);
    assert.equal(storage.get('abs_config').serverUrl, 'http://abs');
    assert.equal((await route('/api/miot/control', { accountId: 'a', deviceId: 'd', action: 'stop' })).status, 200);
    assert.equal(storage.get('abs_speaker_hls_session_v1'), null);
  });
  await test('MIoT failure closes HLS session and redacts response', async () => {
    failMiot = true;
    const result = await push(); assert.equal(result.status, 400);
    assert.ok(!result.data.error.includes('SECRET'));
    assert.equal(storage.get('abs_speaker_hls_session_v1'), null);
    failMiot = false;
  });
  await test('invalid directory is rejected before opening a session', async () => {
    const before = calls.filter(c => c.url.endsWith('/play')).length;
    for (const selection of [{ fileIndex: -1 }, { fileIndex: 0.5 }, { fileIndex: 99 }, { fileIndex: 0, chapterIndex: 99 }]) {
      assert.equal((await route('/api/miot/play', { accountId: 'a', deviceId: 'd', itemId: 'b', ...selection })).status, 400);
    }
    assert.equal(calls.filter(c => c.url.endsWith('/play')).length, before);
  });
  await test('M4B selected chapter uses global time and records actual aligned position', async () => {
    testItem = { media: { metadata: { title: 'M4B' }, audioFiles: [{ filename: 'book.m4b', duration: 12 }], chapters: [{ title: 'First', start: 0, end: 8 }, { title: 'Second', start: 8, end: 12 }] } };
    const result = (await route('/api/miot/play', { accountId: 'a', deviceId: 'd', itemId: 'b', fileIndex: 0, chapterIndex: 1 })).data;
    assert.equal(result.requestedStart, 8);
    assert.equal(result.startPosition, 6);
    assert.equal(result.earlySeconds, 2);
    assert.equal(result.startLabel, 'Second');
    assert.equal(result.history.positionSeconds, 6);
    testItem = null;
  });
  await test('whole-book option preserves original ABS URL and revokes old chapter link', async () => {
    const oldKey = storage.get('abs_speaker_hls_session_v1').playlistKey;
    await route('/api/config', { speakerHlsStartMode: 'book' });
    const result = (await push()).data;
    assert.equal(result.startPosition, 0);
    const sent = JSON.parse(calls.filter(c => c.url.endsWith('/mina/play-url')).at(-1).init.body);
    assert.equal(sent.url, 'http://abs/hls/route-session/output.m3u8');
    assert.equal((await handlers.get('GET /speaker-stream/:key/index.m3u8')({}, { key: oldKey })).statusCode, 404);
    await route('/api/config', { speakerHlsStartMode: 'selected' });
  });
  await test('turning off only affects next push; explicit cleanup remains', async () => {
    await push(); await route('/api/config', { speakerHlsEnabled: false });
    assert.ok(storage.get('abs_speaker_hls_session_v1'));
    assert.equal((await push()).data.mode, 'single');
    assert.equal(storage.get('abs_speaker_hls_session_v1'), null);
    assert.equal((await route('/api/miot/hls/close')).status, 200);
  });
  console.log(`${assertions} HLS regression scenarios passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
