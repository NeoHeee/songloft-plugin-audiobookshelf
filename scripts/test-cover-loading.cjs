const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/js/app.js'), 'utf8');
const helpers = source.slice(source.indexOf('function getAuthToken()'), source.indexOf('function showWorkspace('));
const context = vm.createContext({ URL, COVER_PLACEHOLDER: 'placeholder', window: {
  location: { origin: 'https://songloft.example', protocol: 'https:' },
  SongloftPlugin: { getAuthToken: () => 'host-token' }
}});
vm.runInContext(helpers, context);
const { coverCandidates, setCoverImage, loadCoverImages } = context;
const remote = 'http://abs.local/api/items/book/cover?token=abs-token';
const candidates = coverCandidates(remote);
const proxy = new URL(candidates[0], context.window.location.origin);
assert.equal(proxy.pathname, '/api/v1/proxy');
assert.equal(proxy.searchParams.get('url'), remote);
assert.equal(proxy.searchParams.get('access_token'), 'host-token');
assert.equal(candidates[1], remote);
assert.equal(coverCandidates('https://abs.example/cover').length, 2);
assert.equal(coverCandidates('/api/v1/proxy?url=test').length, 1);
for (const value of ['', undefined, 'javascript:alert(1)', 'file:///cover', 'data:text/html,test']) {
  assert.equal(coverCandidates(value).length, 0);
}
function image() {
  const classes = new Set();
  return { classes, writes: 0, classList: {
    remove: name => classes.delete(name),
    toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
  }, set src(value) { this.current = value; this.writes++; }, get src() { return this.current; } };
}
const img = image();
setCoverImage(img, remote);
assert.equal(img.src, candidates[0]);
assert.equal(img.referrerPolicy, 'no-referrer');
img.onerror();
assert.equal(img.src, remote);
setCoverImage(img, remote);
assert.equal(img.writes, 2, 'same source must not reset a successful fallback');
img.onerror();
assert.equal(img.src, 'placeholder');
assert.ok(img.classes.has('cover-fallback'));
img.onerror();
assert.equal(img.writes, 3, 'placeholder failure must not cause a retry loop');
const oldError = img.onerror;
setCoverImage(img, 'http://abs.local/new-cover');
assert.ok(!img.classes.has('cover-fallback'));
const newSrc = img.src;
oldError();
assert.equal(img.src, newSrc, 'obsolete handler must not alter a new book');
setCoverImage(img, '');
assert.equal(img.src, 'placeholder');
context.window.SongloftPlugin.getAuthToken = () => { throw new Error('unavailable'); };
assert.ok(!coverCandidates(remote)[0].includes('access_token'));
const lazy = image();
lazy.dataset = { coverUrl: remote };
lazy.removeAttribute = name => { assert.equal(name, 'data-cover-url'); delete lazy.dataset.coverUrl; };
loadCoverImages({ querySelectorAll: selector => { assert.equal(selector, 'img[data-cover-url]'); return [lazy]; } });
assert.equal(lazy.dataset.coverUrl, undefined);
assert.ok(lazy.src.startsWith('/api/v1/proxy?'));
for (const marker of ["loadCoverImages($('books'))", "loadCoverImages($('playbackHistoryList'))", "setCoverImage($('playerCover')", "setCoverImage($('detailCover')"]) {
  assert.ok(source.includes(marker), `missing cover entry point: ${marker}`);
}
assert.ok(!source.includes("$('books').addEventListener('error'"));
assert.ok(!source.includes("$('playbackHistoryList').addEventListener('error'"));
console.log('Cover loading regression checks passed.');
