// Tests for keeping playback speed and quality across the lag fix's reload:
// the logic in src/playback-core.js, and the page script src/playback.js with
// the content script src/refresh.js, run in vm contexts with a fake player,
// DOM and sessionStorage.
//   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const flush = () => new Promise((r) => setTimeout(r, 0));
const loadCore = () => {
  const ctx = { URL, JSON };
  vm.createContext(ctx);
  vm.runInContext(read('playback-core.js'), ctx);
  return ctx.YtPlaybackCore;
};
const core = loadCore();
const plain = (o) => (o === null ? null : JSON.parse(JSON.stringify(o)));

// A fake YouTube player. quality: the preferred quality ('auto' or a
// choice); levels: the qualities the video has; ad: an ad is showing.
const fakePlayer = ({ video = 'abc', rate = 1, quality = 'auto', levels = ['hd1080', 'hd720', 'large', 'medium', 'auto'], ad = false } = {}) => {
  const p = {
    video, rate, quality, levels, ad, calls: [],
    classList: { contains: (c) => c === 'ad-showing' && p.ad },
    getVideoData: () => ({ video_id: p.video }),
    getPlaybackRate: () => p.rate,
    setPlaybackRate: (r) => { p.calls.push(['setPlaybackRate', r]); p.rate = r; },
    getPreferredQuality: () => p.quality,
    getAvailableQualityLevels: () => p.levels,
    setPlaybackQualityRange: (a, b) => { p.calls.push(['setPlaybackQualityRange', a, b]); p.quality = a; },
  };
  return p;
};

test('playerSelector: the Shorts player on /shorts/ pages, else the watch player', () => {
  assert.equal(core.playerSelector('https://www.youtube.com/shorts/abc'), '#shorts-player');
  assert.equal(core.playerSelector('https://m.youtube.com/shorts/abc?feature=share'), '#shorts-player');
  assert.equal(core.playerSelector('https://www.youtube.com/watch?v=abc&t=5s'), '#movie_player');
  assert.equal(core.playerSelector('not a url'), '#movie_player');
});

test('capture keeps the speed and a chosen quality, with the video and time', () => {
  assert.deepEqual(plain(core.capture(fakePlayer({ rate: 1.5, quality: 'hd1080' }), 1000)),
    { at: 1000, video: 'abc', rate: 1.5, quality: 'hd1080' });
});

test('capture leaves quality out when it is on Auto', () => {
  assert.deepEqual(plain(core.capture(fakePlayer({ rate: 2 }), 5)), { at: 5, video: 'abc', rate: 2 });
});

test('capture saves for the video the reload goes to, when given', () => {
  // The user moved on to xyz while the player still has abc loaded.
  assert.deepEqual(plain(core.capture(fakePlayer({ rate: 1.5 }), 7, 'xyz')), { at: 7, video: 'xyz', rate: 1.5 });
  assert.deepEqual(plain(core.capture(fakePlayer({ rate: 1.5 }), 7, '')), { at: 7, video: 'abc', rate: 1.5 });
  assert.equal(core.capture(null, 7, 'xyz'), null);
});

test('capture: nothing without a player, a video, or usable values', () => {
  assert.equal(core.capture(null, 1), null);
  assert.equal(core.capture({}, 1), null);
  assert.equal(core.capture(fakePlayer({ video: '' }), 1), null);
  const broken = fakePlayer({ rate: NaN, quality: 'weird' });
  assert.equal(core.capture(broken, 1), null);
  const throws = fakePlayer({ quality: 'large' });
  throws.getPlaybackRate = () => { throw new Error('player not ready'); };
  assert.deepEqual(plain(core.capture(throws, 1)), { at: 1, video: 'abc', quality: 'large' });
});

test('parse reads a fresh entry and rejects old, malformed or empty ones', () => {
  const entry = (o) => JSON.stringify({ at: 1000, video: 'abc', ...o });
  assert.deepEqual(plain(core.parse(entry({ rate: 1.25, quality: 'hd720' }), 1500)), { video: 'abc', rate: 1.25, quality: 'hd720' });
  assert.deepEqual(plain(core.parse(entry({ rate: 0.5 }), 1000 + core.MAX_AGE_MS)), { video: 'abc', rate: 0.5 });
  assert.equal(core.parse(entry({ rate: 1.5 }), 1001 + core.MAX_AGE_MS), null, 'too old');
  assert.equal(core.parse(entry({ rate: 1.5 }), 999), null, 'from the future');
  assert.equal(core.parse(null, 1000), null);
  assert.equal(core.parse('{not json', 1000), null);
  assert.equal(core.parse(JSON.stringify({ at: 1000, rate: 1.5 }), 1000), null, 'no video');
  assert.equal(core.parse(entry({ rate: 'fast', quality: 'auto' }), 1000), null, 'nothing usable');
  assert.deepEqual(plain(core.parse(entry({ rate: 99, quality: 'hd1440' }), 1000)), { video: 'abc', quality: 'hd1440' });
});

test('ready: same video loaded, no ad, qualities known', () => {
  const saved = { video: 'abc', rate: 2 };
  assert.equal(core.ready(fakePlayer(), saved), true);
  assert.equal(core.ready(fakePlayer({ video: 'other' }), saved), false);
  assert.equal(core.ready(fakePlayer({ ad: true }), saved), false);
  assert.equal(core.ready(fakePlayer({ levels: [] }), saved), false);
  assert.equal(core.ready(null, saved), false);
});

test('apply sets speed and quality, and skips what is already set', () => {
  const p = fakePlayer();
  assert.deepEqual(plain(core.apply(p, { video: 'abc', rate: 1.75, quality: 'large' })), { rate: 1.75, quality: 'large' });
  assert.deepEqual(plain(p.calls), [['setPlaybackRate', 1.75], ['setPlaybackQualityRange', 'large', 'large']]);
  const q = fakePlayer({ rate: 1.5, quality: 'hd720' });
  assert.deepEqual(plain(core.apply(q, { video: 'abc', rate: 1.5, quality: 'hd720' })), {});
  assert.deepEqual(q.calls, []);
});

test('apply keeps a chosen quality the video does not have, as YouTube does', () => {
  const p = fakePlayer({ levels: ['small', 'tiny', 'auto'] });
  assert.deepEqual(plain(core.apply(p, { video: 'abc', quality: 'hd1080' })), { quality: 'hd1080' });
  assert.deepEqual(plain(p.calls), [['setPlaybackQualityRange', 'hd1080', 'hd1080']]);
});

// A tab: one sessionStorage that lasts across page loads, and a page load
// that runs refresh.js (isolated world) and playback.js (page world) against
// one shared document, as the browser does.
const makeTab = () => {
  const store = new Map();
  const clock = { now: 0 }; // Date.now() in both worlds: tests move it on
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const load = (href, players) => {
    const docListeners = {};
    const intervals = [];
    const timeouts = [];
    const location = { href, replaced: [], replace(url) { this.replaced.push({ url, saved: sessionStorage.getItem('ytShortsFixPlayback') }); } };
    const document = {
      hidden: false, fullscreenElement: null, activeElement: null,
      addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
      dispatchEvent: (ev) => { for (const fn of docListeners[ev.type] || []) fn(ev); return true; },
      querySelector: (sel) => {
        if (sel === 'ytd-watch-flexy') return { getAttribute: () => new URL(location.href).searchParams.get('v') };
        if (sel === '#movie_player.ad-showing') return null;
        if (sel in players) return players[sel];
        if (sel.includes('video')) return { currentTime: 0 };
        return null;
      },
    };
    class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
    const world = (extra = {}) => {
      const ctx = {
        URL, JSON, Promise, Date: { now: () => clock.now }, CustomEvent, console: { info: () => {}, log: () => {} },
        location, document, sessionStorage, window: { addEventListener: () => {} },
        setInterval: (fn) => { intervals.push(fn); return intervals.length; },
        clearInterval: (id) => { intervals[id - 1] = null; },
        setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; }, clearTimeout: () => {},
        ...extra,
      };
      ctx.globalThis = ctx;
      vm.createContext(ctx);
      return ctx;
    };
    let onMessage;
    const isolated = world({
      browser: {
        storage: { local: { get: async () => ({}) }, onChanged: { addListener: () => {} } },
        runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } } },
      },
    });
    for (const f of ['refresh-core.js', 'playback-core.js', 'refresh.js']) vm.runInContext(read(f), isolated);
    const page = world();
    for (const f of ['playback-core.js', 'playback.js']) vm.runInContext(read(f), page);
    const tick = () => { for (const fn of [...intervals]) fn?.(); };
    const refreshNow = () => onMessage({ type: isolated.YtRefreshCore.MESSAGES.refreshNow }, {}, () => {});
    // An in-page navigation, as YouTube's yt-navigate-finish reports it.
    const navigate = (to) => { location.href = to; document.dispatchEvent({ type: 'yt-navigate-finish' }); };
    const runTimeouts = () => { for (const fn of timeouts.splice(0)) fn(); };
    return { location, tick, refreshNow, navigate, runTimeouts };
  };
  return { load, store, clock };
};

test('reload keeps speed and quality: saved just before the reload, set once on the new page, then cleared', async () => {
  const tab = makeTab();
  const W = 'https://www.youtube.com/watch?v=abc';
  const before = fakePlayer({ rate: 1.5, quality: 'hd720' });
  const page1 = tab.load(W, { '#movie_player': before });
  await flush();
  page1.refreshNow();
  assert.equal(page1.location.replaced.length, 1);
  const { saved } = page1.location.replaced[0];
  assert.deepEqual({ ...JSON.parse(saved), at: 0 }, { at: 0, video: 'abc', rate: 1.5, quality: 'hd720' }, 'saved before location.replace');

  // The new page: the player first shows an ad, then the video at defaults.
  const after = fakePlayer({ ad: true });
  const page2 = tab.load(page1.location.replaced[0].url, { '#movie_player': after });
  assert.equal(tab.store.size, 0, 'entry removed as soon as it is read');
  page2.tick();
  assert.deepEqual(after.calls, [], 'nothing set during the ad');
  after.ad = false;
  page2.tick();
  page2.tick();
  assert.deepEqual(plain(after.calls), [['setPlaybackRate', 1.5], ['setPlaybackQualityRange', 'hd720', 'hd720']], 'set once');

  // A later plain reload finds no entry and changes nothing.
  const again = fakePlayer();
  const page3 = tab.load(W, { '#movie_player': again });
  page3.tick();
  assert.deepEqual(again.calls, []);
});

test('reload on a Short: uses the Shorts player, and leaves Auto quality alone', async () => {
  const tab = makeTab();
  const S = 'https://www.youtube.com/shorts/sh0rt';
  const before = fakePlayer({ video: 'sh0rt', rate: 2 });
  const page1 = tab.load(S, { '#shorts-player': before, '#movie_player': fakePlayer({ video: 'old', rate: 1 }) });
  await flush();
  page1.refreshNow();
  const after = fakePlayer({ video: 'sh0rt' });
  const page2 = tab.load(page1.location.replaced[0].url, { '#shorts-player': after });
  page2.tick();
  assert.deepEqual(plain(after.calls), [['setPlaybackRate', 2]]);
});

test('the automatic reload after N videos keeps them too', async () => {
  const tab = makeTab();
  const W = (id) => `https://www.youtube.com/watch?v=${id}`;
  const players = { '#movie_player': fakePlayer({ video: 'v0', rate: 1.25, quality: 'hd1080' }) };
  const page1 = tab.load(W('v0'), players);
  await flush();
  for (let i = 1; i <= 40; i++) page1.navigate(W(`v${i}`)); // the 41st distinct video: the default threshold is 40
  players['#movie_player'].video = 'v40';
  assert.deepEqual(page1.location.replaced, [], 'waits 1 s for the video to settle');
  tab.clock.now += 1000;
  page1.runTimeouts();
  assert.equal(page1.location.replaced.length, 1);
  assert.deepEqual({ ...JSON.parse(page1.location.replaced[0].saved), at: 0 }, { at: 0, video: 'v40', rate: 1.25, quality: 'hd1080' });
  const after = fakePlayer({ video: 'v40' });
  const page2 = tab.load(page1.location.replaced[0].url, { '#movie_player': after });
  page2.tick();
  assert.deepEqual(plain(after.calls), [['setPlaybackRate', 1.25], ['setPlaybackQualityRange', 'hd1080', 'hd1080']]);
});

test('plain page load with no saved entry does nothing', () => {
  const tab = makeTab();
  const p = fakePlayer();
  const page = tab.load('https://www.youtube.com/watch?v=abc', { '#movie_player': p });
  page.tick();
  assert.deepEqual(p.calls, []);
});
