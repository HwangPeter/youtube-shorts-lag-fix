// The lag fix's reload must land on the video the user went to last.
//
// The cause these tests guard against: the reload is a location.replace,
// and the old page keeps working until the new one arrives. YouTube handles
// a click there (or a scroll to the next Short) as an in-page navigation,
// and the pending replace then loaded the video the user had just left. The
// reload also fired 1 s after the threshold video whatever the user was
// doing then, so a click in that second was lost the same way.
//
// Runs src/refresh.js (after refresh-core.js and playback-core.js) in a vm
// context with a fake YouTube page, a fake clock and fake timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const flush = () => new Promise((r) => setTimeout(r, 0));
const W = (id) => `https://www.youtube.com/watch?v=${id}`;
const S = (id) => `https://www.youtube.com/shorts/${id}`;

const loadPage = (href, threshold = 10) => {
  let now = 0;
  let timers = [];
  let nextId = 1;
  const intervals = [];
  const docListeners = {};
  const saves = [];
  const winListeners = {};
  const store = new Map();
  const sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  let stops = 0;
  // The watch page's video-id and the player's time: they move to a new
  // video only some time after its URL, as on YouTube.
  const page = { flexy: null, time: 0 };
  const location = { href, replaced: [], replace(url) { this.replaced.push(url); } };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  const document = {
    hidden: false, fullscreenElement: null, activeElement: null,
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
    dispatchEvent: (ev) => { for (const fn of docListeners[ev.type] || []) fn(ev); return true; },
    querySelector: (sel) => {
      if (sel === 'ytd-watch-flexy') return { getAttribute: () => page.flexy };
      if (sel === '#movie_player.ad-showing') return null;
      if (sel.includes('video')) return { currentTime: page.time };
      return null;
    },
  };
  document.addEventListener('yt-shorts-fix-save-playback', (e) => saves.push(e.detail));
  const ctx = {
    URL, Promise, CustomEvent, console: { info: () => {}, log: () => {} },
    Date: { now: () => now },
    location, document, sessionStorage,
    window: { addEventListener: (type, fn) => { (winListeners[type] ||= []).push(fn); }, stop: () => { stops++; } },
    setTimeout: (fn, ms = 0) => { const id = nextId++; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
    setInterval: (fn) => { intervals.push(fn); return 0; },
    browser: {
      storage: { local: { get: async () => ({ refreshThreshold: threshold }) }, onChanged: { addListener: () => {} } },
      runtime: { onMessage: { addListener: (fn) => { ctx.onMessage = fn; } } },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['refresh-core.js', 'playback-core.js', 'refresh.js']) vm.runInContext(read(f), ctx);

  const fire = (type) => { for (const fn of docListeners[type] || []) fn({ type }); };
  // Moves the clock on, running each timer when its time comes.
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.fn();
    }
    now = end;
  };
  // YouTube's in-page navigation: yt-navigate-start, the URL a little later,
  // yt-navigate-finish once the new page is shown.
  const startNav = () => fire('yt-navigate-start');
  const setUrl = (to) => { location.href = to; };
  const finishNav = () => fire('yt-navigate-finish');
  const navigate = (to) => { startNav(); setUrl(to); finishNav(); };
  const tick = () => { for (const fn of intervals) fn(); };
  // User input, as the window's capture listeners see it.
  const input = (type, props = {}) => { for (const fn of winListeners[type] || []) fn({ type, composedPath: () => [], ...props }); };
  const linkPress = () => input('mousedown', { composedPath: () => [{ tagName: 'IMG' }, { tagName: 'A', href: W('x') }, document] });
  const refreshNow = () => ctx.onMessage({ type: ctx.YtRefreshCore.MESSAGES.refreshNow }, {}, () => {});
  return { location, page, saves, store, advance, startNav, setUrl, finishNav, navigate, tick, refreshNow, input, linkPress, stops: () => stops };
};

// Opens Shorts s1..s10 (the threshold) and then s11, which makes the reload due.
const reachShortsThreshold = async (p) => {
  await flush();
  for (let i = 1; i <= 10; i++) { p.navigate(S(`s${i}`)); p.advance(3000); }
  p.navigate(S('s11'));
};

// Opens videos v1..v10 (the threshold) and then v11, which makes the reload due.
const reachThreshold = async (p) => {
  await flush();
  for (let i = 1; i <= 10; i++) { p.navigate(W(`v${i}`)); p.advance(3000); }
  assert.deepEqual(p.location.replaced, [], 'no reload up to the threshold');
  p.navigate(W('v11'));
};

test('a click while the reload is under way: the fresh page loads the clicked video, not the one before', async () => {
  const p = loadPage('https://www.youtube.com/');
  await reachThreshold(p);
  p.page.flexy = 'v11';
  p.page.time = 1.2;
  p.advance(1000);
  assert.deepEqual(p.location.replaced, [W('v11') + '&t=1s'], 'reloads v11 after 1 s');
  // The old page is still there: the user clicks v12 in its sidebar. The
  // watch page and the player still show v11, at v11's time.
  p.page.time = 300;
  p.startNav();
  p.advance(120);
  p.setUrl(W('v12'));
  p.advance(50);
  assert.equal(p.location.replaced.at(-1), W('v12'), 'reloads v12 instead, with no t= from v11');
  assert.equal(p.saves.at(-1), 'v12', 'speed and quality saved for v12');
  // YouTube's navigation then finishes: nothing more.
  p.finishNav();
  p.advance(5000);
  p.tick();
  assert.equal(p.location.replaced.length, 2);
});

test('a click in the second before the reload: it waits for that navigation and reloads the clicked video', async () => {
  const p = loadPage('https://www.youtube.com/');
  await reachThreshold(p);
  p.advance(900);
  p.startNav(); // the user clicks v12; its URL is not there yet
  p.advance(300);
  assert.deepEqual(p.location.replaced, [], 'no reload while YouTube is navigating');
  p.setUrl(W('v12'));
  p.finishNav();
  p.page.flexy = 'v11'; // the page still shows v11, at v11's time
  p.page.time = 300;
  p.advance(900);
  assert.deepEqual(p.location.replaced, [], 'waits for v12 to settle');
  p.page.flexy = 'v12';
  p.page.time = 0.5;
  p.advance(200);
  assert.deepEqual(p.location.replaced, [W('v12')], 'reloads v12, with no t= from v11');
  assert.deepEqual(p.saves, ['v12']);
});

test('Shorts scrolled on in the second before the reload: reloads the Short the user is on', async () => {
  const p = loadPage('https://www.youtube.com/');
  await flush();
  await reachShortsThreshold(p);
  p.advance(600);
  // The next Short's URL, seen only by the 1 s URL check (no YouTube event).
  p.setUrl(S('s12'));
  p.tick();
  p.advance(500);
  assert.deepEqual(p.location.replaced, [], 'the 1 s settle starts again for s12');
  p.advance(600);
  assert.deepEqual(p.location.replaced, [S('s12')]);
});

test('Start fresh session now: a click before the page goes is followed too', async () => {
  const p = loadPage(W('a'));
  await flush();
  p.page.flexy = 'a';
  p.page.time = 42;
  p.refreshNow();
  assert.deepEqual(p.location.replaced, [W('a') + '&t=42s']);
  p.startNav();
  p.setUrl(W('b'));
  p.advance(50);
  assert.deepEqual(p.location.replaced, [W('a') + '&t=42s', W('b')]);
  assert.deepEqual(p.saves, ['a', 'b']);
});

test('a scroll to the next Short just as the reload starts: the reload stops, and goes to the new Short once it has loaded', async () => {
  const p = loadPage('https://www.youtube.com/');
  await reachShortsThreshold(p);
  p.advance(1000);
  assert.deepEqual(p.location.replaced, [S('s11')]);
  p.store.set('ytShortsFixPlayback', '{}'); // as playback.js saves it
  p.input('wheel'); // before YouTube even starts its navigation
  assert.equal(p.stops(), 1, 'the pending reload is stopped');
  assert.equal(p.store.has('ytShortsFixPlayback'), false, 'its saved speed and quality are dropped');
  p.advance(140);
  p.startNav();
  p.advance(40);
  p.setUrl(S('s12'));
  p.finishNav();
  assert.deepEqual(p.location.replaced, [S('s11')], 'no reload during the navigation');
  p.advance(1000);
  assert.deepEqual(p.location.replaced, [S('s11'), S('s12')], 'then the new Short, once settled');
  assert.deepEqual(p.saves, ['s11', 's12']);
});

test('a press on a link just as the reload starts stops it the same way; other input does not', async () => {
  const p = loadPage('https://www.youtube.com/');
  await reachThreshold(p);
  p.advance(1000);
  assert.deepEqual(p.location.replaced, [W('v11')]);
  p.input('mousedown'); // not on a link (the player, say)
  p.input('wheel'); // scrolling a watch page
  p.input('keydown', { key: 'ArrowDown' });
  assert.equal(p.stops(), 0);
  p.linkPress();
  assert.equal(p.stops(), 1);
  p.startNav();
  p.setUrl(W('v12'));
  p.finishNav();
  p.page.flexy = 'v12';
  p.advance(1000);
  assert.deepEqual(p.location.replaced, [W('v11'), W('v12')]);
  p.linkPress();
  assert.equal(p.stops(), 2, 'stops each reload under way');
  p.advance(1000); // nothing moved on: the reload goes again
  assert.deepEqual(p.location.replaced, [W('v11'), W('v12'), W('v12')]);
  p.input('keydown', { key: 'N', shiftKey: true }); // Shift+N: next video
  assert.equal(p.stops(), 3);
});

test('no reload under way: input changes nothing', async () => {
  const p = loadPage(W('a'));
  await flush();
  p.linkPress();
  p.input('keydown', { key: 'N', shiftKey: true });
  assert.equal(p.stops(), 0);
  assert.deepEqual(p.location.replaced, []);
});

test('a reload stopped by a click to a page that is not a video: it happens at the next video', async () => {
  const p = loadPage('https://www.youtube.com/');
  await reachThreshold(p);
  p.advance(1000);
  assert.deepEqual(p.location.replaced, [W('v11')]);
  p.linkPress(); // to a channel page
  p.navigate('https://www.youtube.com/@someone');
  p.advance(3000);
  assert.deepEqual(p.location.replaced, [W('v11')], 'no reload on the channel page');
  p.navigate(W('v12'));
  p.page.flexy = 'v12';
  p.advance(1000);
  assert.deepEqual(p.location.replaced, [W('v11'), W('v12')]);
});
