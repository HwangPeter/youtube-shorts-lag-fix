// Refresh-after-N-videos content script. Runs in the extension's isolated
// world (it needs extension storage for the popup's setting), after
// refresh-core.js. See refresh-core.js for what it does and why.
//
// It reads only the page URL, the focused element, fullscreen and visibility
// state, ytd-watch-flexy's video-id attribute and the <video>'s current time.
// The only thing it changes is the page address, when it reloads; just
// before that it tells playback.js to save the playback speed and quality
// for the new page (see playback-core.js). It listens for YouTube's
// yt-navigate-start and yt-navigate-finish, so it never reloads during a
// navigation, and, while its reload is under way, for clicks, scrolls and
// keys: when the user moves on to another video then, it stops that reload
// (window.stop(), dropping the saved entry) and reloads once the new video
// has loaded, so the fresh page plays the video the user chose. It also
// answers the popup's messages: a ping (so the popup knows this tab is
// YouTube) and "Start fresh session now", which reloads at once.
(() => {
  'use strict';
  const core = globalThis.YtRefreshCore;
  if (!core || globalThis.__ytRefreshLoaded) return;
  globalThis.__ytRefreshLoaded = true;

  const SETTLE_MS = 1000; // let the new video load before reading its time and reloading

  const api = globalThis.browser || globalThis.chrome;
  const store = core.createSettingsStore(api);

  // The focused element, looking inside shadow roots.
  const focused = () => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
  const typing = () => {
    const el = focused();
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && TEXT_INPUTS.has((el.type || 'text').toLowerCase());
  };
  const isUnsafe = () => {
    if (typing()) return 'typing';
    if (document.hidden) return 'hidden';
    if (document.fullscreenElement) return 'fullscreen';
    return null;
  };

  // The main player's time, only once the watch page shows this video (so the
  // previous video's time is never carried over) and no ad is playing, else 0.
  const currentTimeFor = (id) => {
    if (!id || document.querySelector('ytd-watch-flexy')?.getAttribute('video-id') !== id) return 0;
    if (document.querySelector('#movie_player.ad-showing')) return 0;
    const v = document.querySelector('#movie_player video') || document.querySelector('video.html5-main-video');
    return v && Number.isFinite(v.currentTime) ? v.currentTime : 0;
  };

  // YouTube's own navigation: yt-navigate-start fires as soon as a video is
  // clicked or scrolled to, before the URL changes; yt-navigate-finish once
  // the new page is shown. A navigation that never finishes stops counting
  // after NAV_STUCK_MS.
  const NAV_STUCK_MS = 5000;
  const FOLLOW_POLL_MS = 50;
  let navStartedAt = 0;
  const navigating = () => navStartedAt > 0 && Date.now() - navStartedAt < NAV_STUCK_MS;
  let changedAt = Date.now(); // when the URL last changed

  // The URL a reload is going to, from the call of location.replace until the
  // old page goes. The old page keeps working until the new one arrives, and
  // YouTube handles a click there (or a scroll to the next Short) as an
  // in-page navigation, which the pending replace would then undo, loading
  // the video the user just left. So:
  // - a click on a link, or a scroll or key that moves to another Short or
  //   video, made in that time stops the reload (window.stop()), lets
  //   YouTube's navigation happen, and reloads once the new video has
  //   settled: see userMoves();
  // - if the URL moves on anyway, the reload goes to the new URL instead (a
  //   new navigation replaces the pending one): see follow().
  let reloadingTo = null;
  // A reload was stopped because the user moved on: it is still owed, at the
  // next video if they went to a page that is not one.
  let owed = false;

  // First asks the page script (playback.js) to save the player's speed and
  // quality for the URL's video, which it sets again on the new page.
  // dispatchEvent runs its listener before returning, so the save is done
  // before the page goes.
  const reload = (url) => {
    const playback = globalThis.YtPlaybackCore;
    if (playback) document.dispatchEvent(new CustomEvent(playback.SAVE_EVENT, { detail: core.videoIdFromUrl(url) || '' }));
    reloadingTo = url;
    owed = false;
    location.replace(url);
  };

  // The URL moved on while a reload was under way: reload the new URL
  // instead, with t= only from that video (currentTimeFor checks it).
  const follow = () => {
    if (!reloadingTo || location.href === reloadingTo) return;
    const id = core.videoIdFromUrl(location.href);
    const url = id ? core.buildRefreshUrl(location.href, currentTimeFor(id)) : location.href;
    if (url === reloadingTo) return;
    console.info('[shorts-fix] you moved on during the reload; reloading where you went instead:', url);
    reload(url);
  };

  let pending = 0;
  // The automatic reload, once the URL's video has stayed for SETTLE_MS and
  // no YouTube navigation is under way, so a click or scroll to yet another
  // video in that time is never lost to a reload of the one before it.
  const reloadWhenSettled = () => {
    const id = core.videoIdFromUrl(location.href);
    if (!id) { pending = 0; return; } // left the video page: skip; the count has started again
    const wait = navigating() ? FOLLOW_POLL_MS * 4 : SETTLE_MS - (Date.now() - changedAt);
    if (wait > 0) { pending = setTimeout(reloadWhenSettled, wait); return; }
    const url = core.buildRefreshUrl(location.href, currentTimeFor(id));
    console.info('[shorts-fix] reloading YouTube in a fresh page to free memory:', url);
    reload(url);
  };

  // Input during a reload that moves to another video: a press on a link,
  // or on a Shorts page a scroll, a swipe or the Up/Down keys, or Shift+N /
  // Shift+P (next / previous video) anywhere.
  const SHORTS_KEYS = new Set(['ArrowDown', 'ArrowUp']);
  const movesOn = (e) => {
    if (e.type === 'mousedown') return (e.composedPath?.() || []).some((el) => el?.tagName === 'A' && el.href);
    if (e.type === 'keydown' && e.shiftKey && (e.key === 'N' || e.key === 'P')) return true;
    if (!new URL(location.href).pathname.startsWith('/shorts/')) return false;
    return e.type === 'keydown' ? SHORTS_KEYS.has(e.key) : true;
  };
  const userMoves = (e) => {
    if (!reloadingTo || !movesOn(e)) return;
    window.stop();
    console.info('[shorts-fix] you moved on just as the reload started; reloading once the new video has loaded');
    reloadingTo = null;
    owed = true;
    try { sessionStorage.removeItem(globalThis.YtPlaybackCore?.STORAGE_KEY); } catch (err) { /* saved again at the reload */ }
    changedAt = Date.now();
    clearTimeout(pending);
    pending = setTimeout(reloadWhenSettled, SETTLE_MS);
  };
  for (const type of ['mousedown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, userMoves, { capture: true, passive: true });
  }

  const refresher = core.createRefresher({
    getSettings: store.get,
    isUnsafe,
    getCurrentTime: () => currentTimeFor(core.videoIdFromUrl(location.href)),
    refresh: (url, { now } = {}) => {
      if (now) {
        clearTimeout(pending);
        pending = 0;
        console.info('[shorts-fix] reloading YouTube in a fresh page, as asked from the popup:', url);
        reload(url);
        return;
      }
      if (pending || reloadingTo) return;
      // Recomputed at the last moment: the time has moved on, and the user
      // may have moved to yet another video.
      pending = setTimeout(reloadWhenSettled, SETTLE_MS);
    },
  });

  api?.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
    if (msg?.type === core.MESSAGES.ping) sendResponse({ ok: true });
    else if (msg?.type === core.MESSAGES.refreshNow) {
      sendResponse({ ok: true });
      refresher.refreshNow(location.href);
    }
  });

  let lastHref = '';
  const onNav = () => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    changedAt = Date.now();
    if (reloadingTo) { follow(); return; }
    refresher.onUrl(location.href);
    if (owed && !pending && !reloadingTo && core.videoIdFromUrl(location.href)) pending = setTimeout(reloadWhenSettled, SETTLE_MS);
  };
  // During a reload, watch the URL closely from the moment a navigation
  // starts, so the new URL is followed before the old page goes.
  let followTimer = 0;
  document.addEventListener('yt-navigate-start', () => {
    navStartedAt = Date.now();
    if (!reloadingTo || followTimer) return;
    const until = Date.now() + NAV_STUCK_MS;
    const poll = () => {
      onNav();
      followTimer = Date.now() < until ? setTimeout(poll, FOLLOW_POLL_MS) : 0;
    };
    poll();
  });
  document.addEventListener('yt-navigate-finish', () => { navStartedAt = 0; onNav(); });
  window.addEventListener('popstate', onNav);
  setInterval(onNav, 1000); // in case YouTube changes the URL without the event
  store.ready.then(onNav);
})();
